import type { UsageGate } from "./usage-gate.js";
import {
  ProviderError,
  classifyError,
  type GenerateRequest,
  type GenerateResult
} from "./types.js";

const MAX_RETRY_AFTER_MS = 30_000;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(
      new ProviderError("aborted", "Geração interrompida pelo usuário.")
    );
  }
  return new Promise((resolveSleep, rejectSleep) => {
    const onAbort = () => {
      clearTimeout(timerId);
      rejectSleep(
        new ProviderError("aborted", "Geração interrompida pelo usuário.")
      );
    };
    const timerId = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Estimativa conservadora (≈3 caracteres por token) do consumo de uma chamada. */
export function estimateTokens(
  request: GenerateRequest,
  headroom = 0
): number {
  const inputChars = request.system.length + request.user.length;
  return Math.ceil(inputChars / 3) + request.maxTokens + headroom;
}

export interface ModelCallResult {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  groundingSources?: Array<{ title: string; url: string }>;
}

export interface HedgePlan {
  primary: string;
  fastBackup: string;
  delayMs: number;
  primaryProvenFast: boolean;
}

export interface CallRuntimeHooks {
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
}

function createLinkedController(parent?: AbortSignal): {
  controller: AbortController;
  cleanup: () => void;
} {
  const controller = new AbortController();
  if (!parent) {
    return { controller, cleanup: () => {} };
  }
  if (parent.aborted) {
    controller.abort(parent.reason);
    return { controller, cleanup: () => {} };
  }
  const onParentAbort = () => controller.abort(parent.reason);
  parent.addEventListener("abort", onParentAbort, { once: true });
  return {
    controller,
    cleanup: () => parent.removeEventListener("abort", onParentAbort)
  };
}

async function runHedgedAttempt(args: {
  plan: HedgePlan;
  estimate: number;
  gate: UsageGate;
  request: GenerateRequest;
  onModelSuccess?: (model: string, ttfbMs?: number) => void;
  onModelError?: (model: string, error: ProviderError) => void;
  call: (model: string, hooks: CallRuntimeHooks) => Promise<ModelCallResult>;
}): Promise<GenerateResult> {
  const { plan, estimate, gate, request, call } = args;
  const primaryTicket = await gate.acquire(estimate, request.signal);
  const primaryLinked = createLinkedController(request.signal);
  const backupLinked = createLinkedController(request.signal);

  const startedPrimaryAt = Date.now();
  let winner: "primary" | "backup" | null = null;
  let primarySettled = false;
  let backupStarted = false;
  let backupTicketSettled = false;
  let hedgeTimer: ReturnType<typeof setTimeout> | null = null;

  const primaryBuffer: string[] = [];
  const backupBuffer: string[] = [];

  const claimWinner = (side: "primary" | "backup", ttfbMs: number) => {
    if (winner !== null) return false;
    winner = side;
    if (hedgeTimer) {
      clearTimeout(hedgeTimer);
      hedgeTimer = null;
    }
    if (side === "primary") {
      backupLinked.controller.abort();
      for (const piece of primaryBuffer) request.onDelta?.(piece);
      primaryBuffer.length = 0;
    } else {
      primaryLinked.controller.abort();
      for (const piece of backupBuffer) request.onDelta?.(piece);
      backupBuffer.length = 0;
      // Primary ficou mudo > delayMs ou falhou: registra lentidão para cooldown exponencial
      if (!primarySettled) {
        args.onModelError?.(
          plan.primary,
          new ProviderError(
            "transient",
            `Modelo ${plan.primary} lento (> ${Math.round(plan.delayMs / 1000)}s sem resposta inicial).`
          )
        );
      }
    }
    void ttfbMs;
    return true;
  };

  let primaryFirstTokenMs: number | undefined;
  let backupFirstTokenMs: number | undefined;
  let startedBackupAt = 0;

  let resolveBackupStart!: () => void;
  const backupStartSignal = new Promise<void>((res) => {
    resolveBackupStart = res;
  });

  const triggerBackupNow = () => {
    if (backupStarted || winner !== null || request.signal?.aborted) return;
    backupStarted = true;
    resolveBackupStart();
  };

  hedgeTimer = setTimeout(() => {
    triggerBackupNow();
  }, plan.delayMs);

  const primaryPromise = (async (): Promise<GenerateResult> => {
    try {
      const res = await call(plan.primary, {
        signal: primaryLinked.controller.signal,
        onDelta: request.onDelta
          ? (piece) => {
              if (!piece) return;
              if (primaryFirstTokenMs === undefined) {
                primaryFirstTokenMs = Date.now() - startedPrimaryAt;
              }
              if (winner === "primary") {
                request.onDelta?.(piece);
              } else if (winner === null) {
                primaryBuffer.push(piece);
                claimWinner("primary", primaryFirstTokenMs);
              }
            }
          : undefined
      });
      const text = res.text.trim();
      if (!text) {
        throw new ProviderError("empty", `Resposta vazia do modelo ${plan.primary}.`);
      }
      const ttfb = primaryFirstTokenMs ?? Date.now() - startedPrimaryAt;
      if (winner === null) {
        claimWinner("primary", ttfb);
      }
      if (winner !== "primary") {
        primarySettled = true;
        primaryTicket.settle(0);
        throw new ProviderError("aborted", "Descartado após vitória do fallback rápido.");
      }
      primarySettled = true;
      primaryTicket.settle(res.totalTokens ?? estimate);
      args.onModelSuccess?.(plan.primary, ttfb);
      return {
        text,
        model: plan.primary,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        totalTokens: res.totalTokens,
        ...(res.groundingSources && res.groundingSources.length > 0
          ? { groundingSources: res.groundingSources }
          : {})
      };
    } catch (err) {
      if (!primarySettled) {
        primarySettled = true;
        primaryTicket.settle(0);
      }
      if (winner === "backup") {
        throw err;
      }
      const classified = classifyError(err);
      if (
        classified.kind !== "aborted" &&
        classified.kind !== "auth" &&
        classified.kind !== "quota_exhausted"
      ) {
        args.onModelError?.(plan.primary, classified);
        triggerBackupNow();
      } else {
        if (hedgeTimer) {
          clearTimeout(hedgeTimer);
          hedgeTimer = null;
        }
        backupLinked.controller.abort();
      }
      throw classified;
    }
  })();

  const backupPromise = (async (): Promise<GenerateResult> => {
    await backupStartSignal;
    if (winner === "primary" || request.signal?.aborted) {
      throw new ProviderError("aborted", "Backup não necessário.");
    }
    const backupTicket = await gate.acquire(estimate, backupLinked.controller.signal);
    startedBackupAt = Date.now();
    try {
      const res = await call(plan.fastBackup, {
        signal: backupLinked.controller.signal,
        onDelta: request.onDelta
          ? (piece) => {
              if (!piece) return;
              if (backupFirstTokenMs === undefined) {
                backupFirstTokenMs = Date.now() - startedBackupAt;
              }
              if (winner === "backup") {
                request.onDelta?.(piece);
              } else if (winner === null) {
                backupBuffer.push(piece);
                claimWinner("backup", backupFirstTokenMs);
              }
            }
          : undefined
      });
      const text = res.text.trim();
      if (!text) {
        throw new ProviderError("empty", `Resposta vazia do modelo ${plan.fastBackup}.`);
      }
      const ttfb = backupFirstTokenMs ?? Date.now() - startedBackupAt;
      if (winner === null) {
        claimWinner("backup", ttfb);
      }
      if (winner !== "backup") {
        backupTicketSettled = true;
        backupTicket.settle(0);
        throw new ProviderError("aborted", "Descartado após vitória do modelo principal.");
      }
      backupTicketSettled = true;
      backupTicket.settle(res.totalTokens ?? estimate);
      args.onModelSuccess?.(plan.fastBackup, ttfb);
      return {
        text,
        model: plan.fastBackup,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        totalTokens: res.totalTokens,
        ...(res.groundingSources && res.groundingSources.length > 0
          ? { groundingSources: res.groundingSources }
          : {})
      };
    } catch (err) {
      if (!backupTicketSettled) {
        backupTicketSettled = true;
        backupTicket.settle(0);
      }
      const classified = classifyError(err);
      if (winner !== "primary" && classified.kind !== "aborted") {
        args.onModelError?.(plan.fastBackup, classified);
      }
      throw classified;
    }
  })();

  // Evita unhandledRejection se o perdedor rejeitar depois
  primaryPromise.catch(() => {});
  backupPromise.catch(() => {});

  try {
    return await Promise.any([primaryPromise, backupPromise]);
  } catch (agg) {
    if (request.signal?.aborted) {
      throw new ProviderError("aborted", "Geração interrompida pelo usuário.");
    }
    const errors =
      agg instanceof AggregateError ? agg.errors : [agg];
    const meaningful = errors.find(
      (e) => e instanceof ProviderError && e.kind !== "aborted"
    );
    throw meaningful instanceof ProviderError
      ? meaningful
      : classifyError(errors[0]);
  } finally {
    if (hedgeTimer) {
      clearTimeout(hedgeTimer);
      hedgeTimer = null;
    }
    primaryLinked.cleanup();
    backupLinked.cleanup();
  }
}

/**
 * Executa uma chamada com limite RÍGIDO de tentativas HTTP.
 *
 * - Cada tentativa passa pelo UsageGate (conta no limite diário local).
 * - Suporta corrida cirúrgica (Hedged Request) quando configurada e com folga de RPM/cota.
 * - A tentativa seguinte usa o próximo modelo da lista (cicla se houver um só).
 * - Erros de chave (401/403) e de cota (402, limite diário) interrompem na hora.
 * - Nunca há retentativas escondidas: o SDK é criado com maxRetries = 0.
 */
export async function runWithFallback(args: {
  models: readonly string[];
  resolveModels?: () => Promise<readonly string[]> | readonly string[];
  resolveHedgePlan?: (models: readonly string[]) => HedgePlan | null;
  maxHttpAttempts: number;
  gate: UsageGate;
  request: GenerateRequest;
  headroom?: number;
  onModelSuccess?: (model: string, ttfbMs?: number) => void;
  onModelError?: (model: string, error: ProviderError) => void;
  call: (model: string, hooks?: CallRuntimeHooks) => Promise<ModelCallResult>;
}): Promise<GenerateResult> {
  const { maxHttpAttempts, gate, request, call } = args;
  const resolved = args.resolveModels ? await args.resolveModels() : args.models;
  let models = resolved.length > 0 ? [...resolved] : [...args.models];

  if (models.length === 0) {
    throw new ProviderError("model", "Nenhum modelo configurado para este provedor.");
  }

  const estimate = estimateTokens(request, args.headroom ?? 0);

  // Corrida cirúrgica (Hedge) para modelo flagship novo no Gemini, respeitando folga de RPM/cota
  const hedgePlan = args.resolveHedgePlan ? args.resolveHedgePlan(models) : null;
  if (hedgePlan) {
    const canHedge = await gate.canHedgeSafely();
    if (canHedge) {
      return runHedgedAttempt({
        plan: hedgePlan,
        estimate,
        gate,
        request,
        onModelSuccess: args.onModelSuccess,
        onModelError: args.onModelError,
        call: (m, hooks) => call(m, hooks)
      });
    }
    // Sem folga de RPM (ex.: Debate intenso) e modelo novo ainda não comprovado rápido ->
    // usa direto a pista rápida comprovada sem travar o limite de 5 RPM!
    if (!hedgePlan.primaryProvenFast) {
      models = [
        hedgePlan.fastBackup,
        ...models.filter((m) => m !== hedgePlan.fastBackup)
      ];
    }
  }

  let lastError: ProviderError | null = null;

  for (let attempt = 0; attempt < maxHttpAttempts; attempt++) {
    if (request.signal?.aborted) {
      throw new ProviderError("aborted", "Geração interrompida pelo usuário.");
    }
    if (attempt > 0) {
      request.onReset?.();
    }
    const model = models[attempt % models.length] as string;
    const ticket = await gate.acquire(estimate, request.signal);
    const startedAt = Date.now();
    let firstTokenMs: number | undefined;

    try {
      const result = await call(model, {
        signal: request.signal,
        onDelta: request.onDelta
          ? (piece) => {
              if (piece && firstTokenMs === undefined) {
                firstTokenMs = Date.now() - startedAt;
              }
              request.onDelta?.(piece);
            }
          : undefined
      });
      if (request.signal?.aborted) {
        ticket.settle(result.totalTokens ?? 0);
        throw new ProviderError("aborted", "Geração interrompida pelo usuário.");
      }
      const text = result.text.trim();

      ticket.settle(result.totalTokens ?? estimate);

      if (!text) {
        const emptyErr = new ProviderError("empty", `Resposta vazia do modelo ${model}.`);
        lastError = emptyErr;
        args.onModelError?.(model, emptyErr);
      } else {
        args.onModelSuccess?.(model, firstTokenMs ?? Date.now() - startedAt);
        return {
          text,
          model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          totalTokens: result.totalTokens,
          ...(result.groundingSources && result.groundingSources.length > 0
            ? { groundingSources: result.groundingSources }
            : {})
        };
      }
    } catch (error) {
      ticket.settle(0);
      if (request.signal?.aborted) {
        throw new ProviderError("aborted", "Geração interrompida pelo usuário.");
      }
      const classified = classifyError(error);
      lastError = classified;
      args.onModelError?.(model, classified);

      if (
        classified.kind === "aborted" ||
        classified.kind === "auth" ||
        classified.kind === "quota_exhausted"
      ) {
        throw classified;
      }

      const nextModel = models[(attempt + 1) % models.length] as string;
      const canSwitchModel = attempt + 1 < maxHttpAttempts && nextModel !== model;

      if (
        classified.kind === "rate_limit" &&
        classified.retryAfterMs !== undefined &&
        classified.retryAfterMs > MAX_RETRY_AFTER_MS &&
        !canSwitchModel
      ) {
        throw classified;
      }

      if (attempt + 1 < maxHttpAttempts) {
        const delay = canSwitchModel && (classified.kind === "rate_limit" || classified.kind === "model")
          ? 250
          : classified.kind === "rate_limit"
            ? Math.min(classified.retryAfterMs ?? 3_000, MAX_RETRY_AFTER_MS)
            : classified.kind === "transient"
              ? 1_500 * (attempt + 1)
              : 300;

        await sleep(delay, request.signal);
      }
    }
  }

  throw (
    lastError ??
    new ProviderError("unknown", "Falha desconhecida ao chamar o provedor.")
  );
}
