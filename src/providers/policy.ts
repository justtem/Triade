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

/**
 * Executa uma chamada com limite RÍGIDO de tentativas HTTP.
 *
 * - Cada tentativa passa pelo UsageGate (conta no limite diário local).
 * - A tentativa seguinte usa o próximo modelo da lista (cicla se houver um só).
 * - Erros de chave (401/403) e de cota (402, limite diário) interrompem na hora.
 * - Nunca há retentativas escondidas: o SDK é criado com maxRetries = 0.
 */
export async function runWithFallback(args: {
  models: readonly string[];
  maxHttpAttempts: number;
  gate: UsageGate;
  request: GenerateRequest;
  headroom?: number;
  call: (model: string) => Promise<ModelCallResult>;
}): Promise<GenerateResult> {
  const { models, maxHttpAttempts, gate, request, call } = args;

  if (models.length === 0) {
    throw new ProviderError("model", "Nenhum modelo configurado para este provedor.");
  }

  const estimate = estimateTokens(request, args.headroom ?? 0);
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

    try {
      const result = await call(model);
      if (request.signal?.aborted) {
        ticket.settle(result.totalTokens ?? 0);
        throw new ProviderError("aborted", "Geração interrompida pelo usuário.");
      }
      const text = result.text.trim();

      ticket.settle(result.totalTokens ?? estimate);

      if (!text) {
        lastError = new ProviderError("empty", `Resposta vazia do modelo ${model}.`);
      } else {
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

      if (
        classified.kind === "aborted" ||
        classified.kind === "auth" ||
        classified.kind === "quota_exhausted"
      ) {
        throw classified;
      }

      if (
        classified.kind === "rate_limit" &&
        classified.retryAfterMs !== undefined &&
        classified.retryAfterMs > MAX_RETRY_AFTER_MS
      ) {
        throw classified;
      }

      if (attempt + 1 < maxHttpAttempts) {
        const delay =
          classified.kind === "rate_limit"
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
