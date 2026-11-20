import {
  applyLimitSignalToDebates,
  DEFAULT_SYSTEM_PROMPT,
  getDebateSessionById,
  getPendingMemoryCompaction,
  listDebateSummaries,
  PLATFORM_NAMES,
  recordTaskFailure,
  RECENT_FULL_TURNS,
  saveSessionSharedMemory,
  submitDebateTaskResponse,
  type PendingMemoryCompaction
} from "./debate-engine.js";

import {
  emitProvidersUpdated,
  endTaskStream,
  pushTaskStreamDelta,
  resetTaskStream,
  startTaskStream
} from "./stream-hub.js";

import {
  getProvider,
  getProviderIssue,
  initProviders
} from "../providers/registry.js";

import { classifyError } from "../providers/types.js";
import { isAutoPlatform, type DebateTask } from "../shared/debate-types.js";

const TICK_MS = 2_500;
// Cada tarefa já faz até 2-3 tentativas HTTP dentro do provedor (e cada uma conta
// no limite diário). Por isso uma falha pausa o debate de imediato.
const MAX_TASK_ATTEMPTS = 1;
const RETRY_BASE_DELAY_MS = 8_000;
const MEMORY_RETRY_COOLDOWN_MS = 120_000;
const MAX_CHAINED_PASSES = 12;

const inFlight = new Set<string>();
const retryNotBefore = new Map<string, number>();
const memoryInFlight = new Set<string>();
const memoryRetryNotBefore = new Map<string, number>();

let timer: NodeJS.Timeout | undefined;
let ticking = false;
let rerunRequested = false;

// ---------------------------------------------------------------
// Execução de uma tarefa automática
// ---------------------------------------------------------------

async function runTask(debateId: string, task: DebateTask): Promise<boolean> {
  inFlight.add(task.id);

  try {
    if (!isAutoPlatform(task.platform)) {
      return false;
    }

    const platform = task.platform;
    const label = PLATFORM_NAMES[platform];
    const provider = getProvider(platform);

    if (!provider) {
      const reason = getProviderIssue(platform) ?? "provedor não configurado.";
      await recordTaskFailure(
        debateId,
        task.id,
        `${label} indisponível: ${reason}`,
        { fatal: true }
      );
      return false;
    }

    let result;
    let streamStarted = false;

    try {
      startTaskStream({
        debateId,
        taskId: task.id,
        ...(task.turnId ? { turnId: task.turnId } : {}),
        round: task.round,
        stage: task.stage,
        platform,
        startedAt: new Date().toISOString()
      });
      streamStarted = true;

      result = await provider.generate({
        system: task.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        user: task.userPrompt ?? task.prompt,
        maxTokens: task.maxTokens ?? 1100,
        onDelta: (delta) => pushTaskStreamDelta(debateId, task.id, delta),
        onReset: () => resetTaskStream(debateId, task.id)
      });
    } catch (error) {
      if (streamStarted) {
        endTaskStream(debateId, task.id);
      }
      emitProvidersUpdated();
      const failure = classifyError(error);

      if (failure.kind === "rate_limit" || failure.kind === "quota_exhausted") {
        const { pausedDebateIds } = await applyLimitSignalToDebates(
          platform,
          "blocked",
          failure.message.slice(0, 200),
          new Date().toISOString()
        );

        console.warn(
          `[AI Council] ${label}: limite atingido. Debates pausados:`,
          pausedDebateIds.join(", ") || "nenhum"
        );

        return false;
      }

      const fatal = failure.kind === "auth" || failure.kind === "model";

      const updated = await recordTaskFailure(debateId, task.id, failure.message, {
        maxAttempts: MAX_TASK_ATTEMPTS,
        fatal
      });

      const attempts =
        updated?.tasks.find((t) => t.id === task.id)?.attempts ?? 1;

      retryNotBefore.set(task.id, Date.now() + RETRY_BASE_DELAY_MS * attempts);

      console.warn(
        `[AI Council] ${label} falhou (${failure.kind}): ${failure.message.slice(0, 160)}`
      );

      return false;
    }

    try {
      await submitDebateTaskResponse(
        debateId,
        { taskId: task.id, content: result.text },
        {
          allowWhilePaused: true,
          model: result.model,
          tokens: result.totalTokens
        }
      );
    } catch (error) {
      console.error(
        "[AI Council] Resposta recebida mas não registrada:",
        error instanceof Error ? error.message : error
      );
      return false;
    } finally {
      if (streamStarted) {
        endTaskStream(debateId, task.id);
      }
      emitProvidersUpdated();
    }

    console.log(
      `[AI Council] ${label} respondeu (${result.model}, ${result.totalTokens ?? "?"} tokens) — rodada ${task.round}/${task.stage}`
    );

    return true;
  } finally {
    inFlight.delete(task.id);
  }
}

// ---------------------------------------------------------------
// Memória Compartilhada (compactação em segundo plano via Gemini)
// ---------------------------------------------------------------

async function runMemoryCompaction(job: PendingMemoryCompaction): Promise<void> {
  if (memoryInFlight.has(job.debateId)) return;
  memoryInFlight.add(job.debateId);

  try {
    // Usa Gemini (maior janela gratuita: 200k TPM) ou OpenRouter se Gemini não estiver ativo.
    // Nunca consome o TPM restrito do Groq para compactação em segundo plano.
    const provider = getProvider("gemini") ?? getProvider("openrouter");
    if (!provider) return;

    const result = await provider.generate({
      system: job.systemPrompt,
      user: job.userPrompt,
      maxTokens: job.maxTokens
    });

    const summary = result.text.trim();
    if (!summary) return;

    await saveSessionSharedMemory(job.debateId, {
      summary,
      coveredTurnCount: job.targetCoveredCount,
      updatedAt: new Date().toISOString(),
      model: result.model
    });

    console.log(
      `[AI Council] Memória compartilhada atualizada (${result.model}) — turnos 1–${job.targetCoveredCount}`
    );
  } catch (error) {
    memoryRetryNotBefore.set(job.debateId, Date.now() + MEMORY_RETRY_COOLDOWN_MS);
    console.warn(
      "[AI Council] Compactação de memória adiada:",
      error instanceof Error ? error.message.slice(0, 140) : error
    );
  } finally {
    memoryInFlight.delete(job.debateId);
  }
}

// ---------------------------------------------------------------
// Varredura
// ---------------------------------------------------------------

async function processOnce(): Promise<boolean> {
  const summaries = await listDebateSummaries();
  const now = Date.now();
  let didWork = false;

  // Lê apenas o arquivo JSON das sessões realmente ativas (0 leituras em repouso).
  const activeSummaries = summaries.filter(
    (s) => s.status === "running" && (s.engineVersion ?? 0) >= 2
  );

  for (const summary of activeSummaries) {
    const session = await getDebateSessionById(summary.id);
    if (!session || session.status !== "running") continue;

    const activeTurnId = session.turns?.at(-1)?.id;
    const pending = session.tasks.filter(
      (task) =>
        task.status === "pending" &&
        (task.singleTaskOnly === true ||
          !activeTurnId ||
          !task.turnId ||
          task.turnId === activeTurnId) &&
        task.round === session.currentRound &&
        task.stage === session.currentStage &&
        isAutoPlatform(task.platform) &&
        !inFlight.has(task.id) &&
        (retryNotBefore.get(task.id) ?? 0) <= now
    );

    if (pending.length === 0) continue;

    // Provedores diferentes em paralelo; cada um respeita o próprio UsageGate.
    const outcomes = await Promise.all(
      pending.map((task) => runTask(session.id, task))
    );

    if (outcomes.some(Boolean)) {
      didWork = true;
    }
  }

  // Em segundo plano, compacta turnos antigos (> 3) em Memória Compartilhada
  // enquanto o usuário lê, para não atrasar a próxima mensagem.
  for (const summary of summaries.slice(0, 5)) {
    if (summary.status !== "completed" || (summary.engineVersion ?? 0) < 2) {
      continue;
    }
    if (
      summary.turnCount <= RECENT_FULL_TURNS ||
      (summary.sharedMemoryTurns ?? 0) >= summary.turnCount - RECENT_FULL_TURNS
    ) {
      continue;
    }
    if (
      memoryInFlight.has(summary.id) ||
      (memoryRetryNotBefore.get(summary.id) ?? 0) > now
    ) {
      continue;
    }
    const session = await getDebateSessionById(summary.id);
    if (!session) continue;
    const job = getPendingMemoryCompaction(session);
    if (job) {
      void runMemoryCompaction(job);
      break;
    }
  }

  return didWork;
}

async function tick(): Promise<void> {
  if (ticking) {
    rerunRequested = true;
    return;
  }

  ticking = true;

  try {
    let passes = 0;

    do {
      rerunRequested = false;
      const didWork = await processOnce();
      passes += 1;

      // Se algo foi concluído, a etapa pode ter avançado: varre de novo já.
      if (didWork) rerunRequested = true;
    } while (rerunRequested && passes < MAX_CHAINED_PASSES);
  } catch (error) {
    console.error(
      "[AI Council] Erro no runner:",
      error instanceof Error ? error.message : error
    );
  } finally {
    ticking = false;
  }
}

// ---------------------------------------------------------------
// API pública
// ---------------------------------------------------------------

export function startRunner(): void {
  if (timer) return;

  initProviders();

  timer = setInterval(() => {
    void tick();
  }, TICK_MS);

  void tick();
  console.log("[AI Council] Runner automático ativo (Gemini, Groq e OpenRouter).");
}

export function stopRunner(): void {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

/** Pede uma varredura imediata (ex.: depois de criar ou retomar um debate). */
export function kickRunner(): void {
  void tick();
}
