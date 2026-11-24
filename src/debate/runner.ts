import {
  applyLimitSignalToDebates,
  DEFAULT_SYSTEM_PROMPT,
  failoverTaskToBackupProvider,
  getDebateSessionById,
  getPendingMemoryCompaction,
  listDebateSummaries,
  mergeTurnWebSources,
  PLATFORM_NAMES,
  recordTaskFailure,
  RECENT_FULL_TURNS,
  saveSessionSharedMemory,
  skipStragglerTaskAndAdvanceStage,
  submitDebateTaskResponse,
  type PendingMemoryCompaction
} from "./debate-engine.js";

import {
  emitProvidersUpdated,
  endTaskStream,
  getActiveStreams,
  pushTaskStreamDelta,
  resetTaskStream,
  startTaskStream
} from "./stream-hub.js";

import {
  getProvider,
  getProviderIssue,
  getProvidersStatus,
  initProviders
} from "../providers/registry.js";

import { classifyError, type ProviderMediaPart } from "../providers/types.js";
import {
  isAutoPlatform,
  type AutoPlatform,
  type DebateSession,
  type DebateTask
} from "../shared/debate-types.js";
import {
  AUTO_VERDICT_MIN_QUOTA_RATIO,
  generateTurnVerdict,
  shouldTriggerAutoVerdict
} from "./verdict.js";
import {
  extractAndSaveUserMemoryFromTurn,
  mightContainPersonalMemory
} from "./user-memory-extractor.js";
import {
  abortBuilderRun,
  runAutoBuilderAfterTurnCompleted
} from "../projects/builder-orchestrator.js";

const TICK_MS = 2_500;
// Em erro não-transitório pausa de imediato; em 503 transitório (pico momentâneo)
// faz 1 retentativa automática rápida (4s) EM PARALELO sem travar nem pausar a conversa.
const MAX_TASK_ATTEMPTS = 1;
const MAX_TRANSIENT_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 8_000;
const TRANSIENT_RETRY_DELAY_MS = 4_000;
const MEMORY_RETRY_COOLDOWN_MS = 120_000;
const MAX_CHAINED_PASSES = 12;
// Quórum de rodada: assim que 2+ IAs já responderam em uma rodada de 3 IAs,
// dá no máximo 22s para a 3ª IA lenta concluir antes de liberar o Gemini Relator.
const ROUND_STRAGGLER_GRACE_MS = 22_000;
const PAIR_STRAGGLER_GRACE_MS = 45_000;
const PAIR_GEMINI_GRACE_MS = 60_000;

const inFlight = new Set<string>();
const stragglerAborted = new Set<string>();
const activeControllers = new Map<
  string,
  {
    debateId: string;
    turnId?: string;
    round: number;
    stage: string;
    platform: AutoPlatform;
    controller: AbortController;
    partialText: string;
    lastDeltaAt: number;
  }
>();
const retryNotBefore = new Map<string, number>();

interface StageQuorumTracker {
  key: string;
  debateId: string;
  turnId?: string;
  round: number;
  stage: string;
  totalTasks: number;
  succeededTaskIds: Set<string>;
  graceTimer?: NodeJS.Timeout;
}
const stageTrackers = new Map<string, StageQuorumTracker>();

function buildStageTrackerKey(
  debateId: string,
  turnId: string | undefined,
  round: number,
  stage: string
): string {
  return `${debateId}:${turnId ?? "legacy"}:${round}:${stage}`;
}

function clearStageTrackersForDebate(debateId: string): void {
  for (const [key, tracker] of stageTrackers.entries()) {
    if (tracker.debateId !== debateId) continue;
    if (tracker.graceTimer) {
      clearTimeout(tracker.graceTimer);
      tracker.graceTimer = undefined;
    }
    stageTrackers.delete(key);
  }
}

function clearAllStageTrackers(): void {
  for (const tracker of stageTrackers.values()) {
    if (tracker.graceTimer) {
      clearTimeout(tracker.graceTimer);
      tracker.graceTimer = undefined;
    }
  }
  stageTrackers.clear();
}

function getOrCreateStageTracker(
  session: DebateSession,
  activeTurnId: string | undefined
): StageQuorumTracker | null {
  // Só aplica prazo de quórum em modo Debate (onde a Síntese aguarda a rodada);
  // no modo Direto/Conselho cada IA termina livremente sem nunca interromper streaming!
  if (session.interactionMode === "direct" || session.currentStage === "synthesis") {
    return null;
  }

  const stageTasks = session.tasks.filter(
    (t) =>
      (!activeTurnId || !t.turnId || t.turnId === activeTurnId) &&
      t.round === session.currentRound &&
      t.stage === session.currentStage &&
      isAutoPlatform(t.platform)
  );
  if (stageTasks.length < 2) return null;

  const key = buildStageTrackerKey(
    session.id,
    activeTurnId,
    session.currentRound,
    session.currentStage
  );

  let tracker = stageTrackers.get(key);
  if (!tracker) {
    tracker = {
      key,
      debateId: session.id,
      ...(activeTurnId ? { turnId: activeTurnId } : {}),
      round: session.currentRound,
      stage: session.currentStage,
      totalTasks: stageTasks.length,
      succeededTaskIds: new Set<string>()
    };
    stageTrackers.set(key, tracker);
  } else {
    tracker.totalTasks = Math.max(tracker.totalTasks, stageTasks.length);
  }

  // Sincroniza tarefas que já responderam nesta etapa (útil após Retomar ou failover)
  for (const r of session.responses) {
    if (
      (!activeTurnId || !r.turnId || r.turnId === activeTurnId) &&
      r.round === session.currentRound &&
      r.stage === session.currentStage &&
      r.taskId
    ) {
      tracker.succeededTaskIds.add(r.taskId);
    }
  }

  return tracker;
}

function listInFlightControllersForTracker(tracker: StageQuorumTracker): Array<{
  taskId: string;
  platform: AutoPlatform;
  controller: AbortController;
  partialText: string;
  lastDeltaAt: number;
}> {
  const result: Array<{
    taskId: string;
    platform: AutoPlatform;
    controller: AbortController;
    partialText: string;
    lastDeltaAt: number;
  }> = [];
  for (const [taskId, entry] of activeControllers.entries()) {
    if (
      entry.debateId === tracker.debateId &&
      entry.round === tracker.round &&
      entry.stage === tracker.stage &&
      (!tracker.turnId || !entry.turnId || entry.turnId === tracker.turnId)
    ) {
      result.push({
        taskId,
        platform: entry.platform,
        controller: entry.controller,
        partialText: entry.partialText,
        lastDeltaAt: entry.lastDeltaAt
      });
    }
  }
  return result;
}

const ACTIVE_STREAM_PROTECT_MS = 15_000;

function makeStageBatchContext(tracker: StageQuorumTracker): StageBatchContext {
  const quorumSize = tracker.totalTasks >= 3 ? 2 : 1;

  const scheduleStragglerCheck = (delayMs: number) => {
    if (tracker.graceTimer) return;
    tracker.graceTimer = setTimeout(() => {
      tracker.graceTimer = undefined;
      const now = Date.now();
      const stillSlow = listInFlightControllersForTracker(tracker);
      let anyActivelyStreaming = false;

      for (const slow of stillSlow) {
        // NUNCA interrompe uma IA que está escrevendo ativamente na tela!
        if (slow.partialText.length > 0 && now - slow.lastDeltaAt < ACTIVE_STREAM_PROTECT_MS) {
          anyActivelyStreaming = true;
          continue;
        }
        stragglerAborted.add(slow.taskId);
        try {
          slow.controller.abort();
        } catch {
          // Ignora erro de aborto duplicado
        }
      }

      // Se alguma IA ainda estava escrevendo tokens, reavalia depois sem matar o código dela
      if (anyActivelyStreaming) {
        scheduleStragglerCheck(ACTIVE_STREAM_PROTECT_MS);
      }
    }, delayMs);
  };

  return {
    hasQuorum: () => tracker.succeededTaskIds.size >= quorumSize,
    onTaskFinished: (finishedTaskId, succeeded) => {
      if (succeeded) {
        tracker.succeededTaskIds.add(finishedTaskId);
      }

      const remaining = listInFlightControllersForTracker(tracker);
      if (remaining.length === 0) {
        if (tracker.graceTimer) {
          clearTimeout(tracker.graceTimer);
          tracker.graceTimer = undefined;
        }
        if (tracker.succeededTaskIds.size >= tracker.totalTasks) {
          stageTrackers.delete(tracker.key);
        }
        return;
      }

      if (tracker.succeededTaskIds.size >= quorumSize && !tracker.graceTimer) {
        const graceMs =
          tracker.totalTasks >= 3
            ? ROUND_STRAGGLER_GRACE_MS
            : remaining.some((r) => r.platform === "gemini")
              ? PAIR_GEMINI_GRACE_MS
              : PAIR_STRAGGLER_GRACE_MS;

        scheduleStragglerCheck(graceMs);
      }
    }
  };
}
const memoryInFlight = new Set<string>();
const memoryRetryNotBefore = new Map<string, number>();
const autoVerdictInFlight = new Set<string>();
const autoVerdictAttempted = new Set<string>();
const MAX_AUTO_VERDICT_HISTORY = 200;
const userMemoryInFlight = new Set<string>();
const userMemoryAttempted = new Set<string>();
const MAX_USER_MEMORY_HISTORY = 300;

async function pickHealthyFailoverProvider(
  session: DebateSession | null,
  task: DebateTask,
  failedPlatform: AutoPlatform
): Promise<AutoPlatform | null> {
  const statuses = await getProvidersStatus();

  const busyInSameStage = new Set<string>([failedPlatform]);
  if (session && task.stage !== "synthesis") {
    for (const t of session.tasks) {
      if (
        t.id !== task.id &&
        t.turnId === task.turnId &&
        t.round === task.round &&
        t.stage === task.stage
      ) {
        busyInSameStage.add(t.platform);
      }
    }
    for (const r of session.responses) {
      if (
        r.turnId === task.turnId &&
        r.round === task.round &&
        r.stage === task.stage
      ) {
        busyInSameStage.add(r.platform);
      }
    }
  }

  const promptSize =
    (task.systemPrompt?.length ?? 0) + (task.userPrompt?.length ?? task.prompt.length);
  const allowGroq = task.stage !== "synthesis" && promptSize <= 14_000;
  // Na síntese, Gemini é sempre o titular; se o Google cair (failover de emergência),
  // OpenRouter entra antes de NVIDIA NIM por ser mais rápido em resposta direta.
  const order: AutoPlatform[] =
    task.stage === "synthesis"
      ? ["gemini", "openrouter", "nvidia"]
      : allowGroq
        ? ["gemini", "openrouter", "nvidia", "groq"]
        : ["gemini", "openrouter", "nvidia"];

  for (const candidate of order) {
    if (busyInSameStage.has(candidate)) continue;
    const st = statuses.find((s) => s.id === candidate);
    if (!st || !st.ready || !getProvider(candidate)) continue;

    const ap = st.autopilot;
    if (
      ap &&
      ap.activeModels.length > 0 &&
      ap.cooledDown.length >= ap.activeModels.length
    ) {
      continue;
    }

    const usage = st.usage;
    if (usage) {
      const reqRatio =
        usage.requestsDailyCap > 0
          ? (usage.requestsDailyCap - usage.requestsToday) / usage.requestsDailyCap
          : 1;
      const tokRatio =
        usage.tokensDailyCap && usage.tokensDailyCap > 0
          ? (usage.tokensDailyCap - usage.tokensToday) / usage.tokensDailyCap
          : 1;
      if (Math.min(reqRatio, tokRatio) < 0.05) continue;
    }

    return candidate;
  }

  return null;
}

/**
 * Cancela instantaneamente todas as requisições HTTP/stream em andamento de uma
 * conversa via AbortController e devolve o texto parcial já gerado por cada task.
 */
export function abortDebateTasks(debateId: string): Map<string, string> {
  abortBuilderRun(debateId);
  clearStageTrackersForDebate(debateId);
  const partials = new Map<string, string>();

  for (const stream of getActiveStreams(debateId)) {
    if (stream.content && stream.content.trim().length > 0) {
      partials.set(stream.taskId, stream.content);
    }
    endTaskStream(debateId, stream.taskId);
  }

  for (const [taskId, entry] of activeControllers.entries()) {
    if (entry.debateId !== debateId) continue;
    const prev = partials.get(taskId) ?? "";
    if (entry.partialText.length > prev.length) {
      partials.set(taskId, entry.partialText);
    }
    try {
      entry.controller.abort();
    } catch {
      // Ignora erro de aborto duplicado
    }
    endTaskStream(debateId, taskId);
    activeControllers.delete(taskId);
  }

  return partials;
}

let timer: NodeJS.Timeout | undefined;
let ticking = false;
let rerunRequested = false;

// ---------------------------------------------------------------
// Execução de uma tarefa automática
// ---------------------------------------------------------------

function extractTaskMedia(session: DebateSession | null, task: DebateTask): ProviderMediaPart[] {
  if (!session || task.stage !== "initial_response") return [];
  const turn =
    (task.turnId ? session.turns?.find((t) => t.id === task.turnId) : undefined) ??
    session.turns?.at(-1);
  if (!turn?.attachments?.length) return [];

  return turn.attachments
    .filter(
      (att): att is typeof att & { kind: "image" | "pdf"; mimeType: string; dataBase64: string } =>
        (att.kind === "image" || att.kind === "pdf") &&
        typeof att.mimeType === "string" &&
        typeof att.dataBase64 === "string" &&
        att.dataBase64.length > 0
    )
    .map((att) => ({
      name: att.name,
      kind: att.kind,
      mimeType: att.mimeType,
      dataBase64: att.dataBase64
    }));
}

interface StageBatchContext {
  hasQuorum: () => boolean;
  onTaskFinished: (taskId: string, succeeded: boolean) => void;
}

async function runTask(
  debateId: string,
  task: DebateTask,
  session: DebateSession | null = null,
  batchContext?: StageBatchContext
): Promise<boolean> {
  inFlight.add(task.id);
  let taskSucceeded = false;

  try {
    if (!isAutoPlatform(task.platform)) {
      return false;
    }

    const platform = task.platform;
    const label = PLATFORM_NAMES[platform];
    const provider = getProvider(platform);

    if (!provider) {
      const reason = getProviderIssue(platform) ?? "provedor não configurado.";
      // Na síntese (onde Gemini é sempre titular), tenta failover de emergência antes de pausar.
      if (task.stage === "synthesis") {
        const backup = await pickHealthyFailoverProvider(session, task, platform);
        if (backup) {
          const reassigned = await failoverTaskToBackupProvider(
            debateId,
            task.id,
            backup,
            reason
          );
          if (reassigned) {
            console.warn(
              `[AI Council] Failover de emergência na síntese: ${label} indisponível → ${PLATFORM_NAMES[backup]}.`
            );
            return true;
          }
        }
      }
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
    const controller = new AbortController();
    const controllerEntry = {
      debateId,
      ...(task.turnId ? { turnId: task.turnId } : {}),
      round: task.round,
      stage: task.stage,
      platform,
      controller,
      partialText: "",
      lastDeltaAt: 0
    };
    activeControllers.set(task.id, controllerEntry);

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

      const media = extractTaskMedia(session, task);
      const activeTurn =
        (task.turnId ? session?.turns?.find((t) => t.id === task.turnId) : undefined) ??
        session?.turns?.at(-1);
      // Só aciona o Google Search Grounding nativo do Gemini se explicitamente habilitado no .env
      // (no Free Tier do AI Studio o tool googleSearch tem cota muito menor que a busca gratuita local)
      const allowGeminiGrounding = process.env.GEMINI_WEB_GROUNDING === "true";
      const enableWebGrounding =
        allowGeminiGrounding &&
        platform === "gemini" &&
        task.stage === "initial_response" &&
        activeTurn?.webSearchMode !== "off" &&
        (activeTurn?.webSources?.length ?? 0) === 0 &&
        media.length === 0;

      result = await provider.generate({
        system: task.systemPrompt ?? DEFAULT_SYSTEM_PROMPT,
        user: task.userPrompt ?? task.prompt,
        maxTokens: task.maxTokens ?? 1100,
        signal: controller.signal,
        ...(enableWebGrounding ? { enableWebGrounding: true } : {}),
        ...(media.length > 0 ? { media } : {}),
        onDelta: (delta) => {
          if (controller.signal.aborted) return;
          controllerEntry.partialText += delta;
          controllerEntry.lastDeltaAt = Date.now();
          pushTaskStreamDelta(debateId, task.id, delta);
        },
        onReset: () => {
          if (controller.signal.aborted) return;
          controllerEntry.partialText = "";
          resetTaskStream(debateId, task.id);
        }
      });
    } catch (error) {
      if (streamStarted) {
        endTaskStream(debateId, task.id);
      }
      emitProvidersUpdated();
      const failure = classifyError(error);

      if (stragglerAborted.has(task.id)) {
        stragglerAborted.delete(task.id);
        const skipped = await skipStragglerTaskAndAdvanceStage(
          debateId,
          task.id,
          `${label} excedeu o prazo da rodada após quórum — dispensada para acelerar a síntese.`,
          controllerEntry.partialText
        );
        console.log(
          `[AI Council] ${label} dispensada por prazo da rodada (quórum já concluído — avançando etapa).`
        );
        return Boolean(skipped);
      }

      if (controller.signal.aborted || failure.kind === "aborted") {
        console.log(
          `[AI Council] ${label} interrompido manualmente pelo usuário (${controllerEntry.partialText.length} chars parciais).`
        );
        return false;
      }

      // Se a rodada já atingiu quórum (>= 2 respostas prontas em debate de 3 IAs),
      // não dispara failover cascateado para um 4º modelo lento — avança direto para a síntese do Gemini!
      if (batchContext?.hasQuorum() && task.stage !== "synthesis") {
        const skipped = await skipStragglerTaskAndAdvanceStage(
          debateId,
          task.id,
          `${label} falhou após quórum (${failure.kind}) — avançando para a síntese.`
        );
        if (skipped) {
          console.warn(
            `[AI Council] ${label} falhou (${failure.kind}) após quórum da rodada — dispensando sem failover lento.`
          );
          return true;
        }
      }

      if (failure.kind === "rate_limit" || failure.kind === "quota_exhausted") {
        // Antes de pausar o debate, tenta transferir a tarefa para uma IA reserva saudável (ex.: NVIDIA NIM)
        const backup = await pickHealthyFailoverProvider(session, task, platform);
        if (backup) {
          const reassigned = await failoverTaskToBackupProvider(
            debateId,
            task.id,
            backup,
            failure.message
          );
          if (reassigned) {
            console.warn(
              `[AI Council] Failover automático (${failure.kind}): ${label} → ${PLATFORM_NAMES[backup]} assumiu a tarefa ${task.stage} (rodada ${task.round}).`
            );
            return true;
          }
        }

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

      // Em erro transitório (ex.: 503 high demand), resposta vazia ou modelo 404,
      // transfere automaticamente para uma IA saudável reserva em vez de travar o debate.
      if (
        failure.kind === "transient" ||
        failure.kind === "empty" ||
        failure.kind === "model"
      ) {
        const backup = await pickHealthyFailoverProvider(session, task, platform);
        if (backup) {
          const reassigned = await failoverTaskToBackupProvider(
            debateId,
            task.id,
            backup,
            failure.message
          );
          if (reassigned) {
            console.warn(
              `[AI Council] Failover automático (${failure.kind}): ${label} → ${PLATFORM_NAMES[backup]} assumiu a tarefa ${task.stage} (rodada ${task.round}).`
            );
            return true;
          }
        }
      }

      const fatal = failure.kind === "auth" || failure.kind === "model";
      const isTransientRetryable = failure.kind === "transient";
      const maxAttemptsForError = isTransientRetryable
        ? MAX_TRANSIENT_ATTEMPTS
        : MAX_TASK_ATTEMPTS;

      const updated = await recordTaskFailure(debateId, task.id, failure.message, {
        maxAttempts: maxAttemptsForError,
        fatal
      });

      const attempts =
        updated?.tasks.find((t) => t.id === task.id)?.attempts ?? 1;
      const delayMs = isTransientRetryable
        ? TRANSIENT_RETRY_DELAY_MS
        : RETRY_BASE_DELAY_MS * attempts;

      retryNotBefore.set(task.id, Date.now() + delayMs);

      if (isTransientRetryable && attempts < maxAttemptsForError) {
        console.warn(
          `[AI Council] ${label} sofreu erro transitório (503/rede) — nova tentativa automática em ${Math.round(delayMs / 1000)}s em paralelo (sem pausar).`
        );
        setTimeout(() => {
          kickRunner();
        }, delayMs + 100);
      } else {
        console.warn(
          `[AI Council] ${label} falhou (${failure.kind}): ${failure.message.slice(0, 160)}`
        );
      }

      return false;
    }

    if (controller.signal.aborted) {
      if (streamStarted) {
        endTaskStream(debateId, task.id);
      }
      if (stragglerAborted.has(task.id)) {
        stragglerAborted.delete(task.id);
        const skipped = await skipStragglerTaskAndAdvanceStage(
          debateId,
          task.id,
          `${label} excedeu o prazo da rodada após quórum — dispensada para acelerar a síntese.`,
          controllerEntry.partialText
        );
        return Boolean(skipped);
      }
      return false;
    }

    try {
      await submitDebateTaskResponse(
        debateId,
        { taskId: task.id, content: result.text },
        {
          allowWhilePaused: true,
          model: result.model,
          tokens: result.totalTokens,
          ...(result.truncated ? { truncated: true } : {})
        }
      );
      if (result.groundingSources && result.groundingSources.length > 0) {
        await mergeTurnWebSources(debateId, task.turnId, result.groundingSources);
      }
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

    taskSucceeded = true;
    return true;
  } finally {
    stragglerAborted.delete(task.id);
    activeControllers.delete(task.id);
    inFlight.delete(task.id);
    batchContext?.onTaskFinished(task.id, taskSucceeded);
  }
}

// ---------------------------------------------------------------
// Memória Compartilhada (compactação em segundo plano via Gemini)
// ---------------------------------------------------------------

async function runMemoryCompaction(job: PendingMemoryCompaction): Promise<void> {
  if (memoryInFlight.has(job.debateId)) return;
  memoryInFlight.add(job.debateId);

  try {
    // Prioriza NVIDIA NIM / OpenRouter para compactação em segundo plano, preservando a cota do Gemini.
    // Nunca consome o TPM restrito do Groq para resumos longos de histórico.
    const provider =
      getProvider("nvidia") ?? getProvider("openrouter") ?? getProvider("gemini");
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

async function runAutoVerdict(debateId: string, turnId: string): Promise<void> {
  const key = `${debateId}:${turnId}`;
  if (autoVerdictInFlight.has(key) || autoVerdictAttempted.has(key)) return;
  autoVerdictInFlight.add(key);
  if (autoVerdictAttempted.size >= MAX_AUTO_VERDICT_HISTORY) {
    const oldest = autoVerdictAttempted.values().next().value;
    if (oldest) autoVerdictAttempted.delete(oldest);
  }
  autoVerdictAttempted.add(key);

  try {
    const { verdict } = await generateTurnVerdict(debateId, {
      turnId,
      minRemainingQuotaRatio: AUTO_VERDICT_MIN_QUOTA_RATIO
    });
    console.log(
      `[AI Council] Veredito Automático concluído (Juiz: ${verdict.judgePlatform}, recomendada: ${verdict.winner})`
    );
  } catch (error) {
    // Best-effort silencioso: nunca pausa o chat nem exibe erro intrusivo
    console.log(
      "[AI Council] Veredito Automático ignorado:",
      error instanceof Error ? error.message.slice(0, 140) : error
    );
  } finally {
    autoVerdictInFlight.delete(key);
  }
}

async function runUserMemoryExtraction(
  session: DebateSession,
  turnId: string
): Promise<void> {
  const key = `${session.id}:${turnId}`;
  if (userMemoryInFlight.has(key) || userMemoryAttempted.has(key)) return;
  userMemoryInFlight.add(key);
  if (userMemoryAttempted.size >= MAX_USER_MEMORY_HISTORY) {
    const oldest = userMemoryAttempted.values().next().value;
    if (oldest) userMemoryAttempted.delete(oldest);
  }
  userMemoryAttempted.add(key);

  try {
    const turn = session.turns?.find((t) => t.id === turnId);
    if (!turn) return;
    const outcome = await extractAndSaveUserMemoryFromTurn(session, turn);
    if (outcome && (outcome.addedCount > 0 || outcome.removedCount > 0)) {
      console.log(
        `[AI Council] Memória pessoal automática atualizada (+${outcome.addedCount} / -${outcome.removedCount} fatos).`
      );
    }
  } catch (error) {
    console.log(
      "[AI Council] Extração de memória pessoal ignorada:",
      error instanceof Error ? error.message.slice(0, 120) : error
    );
  } finally {
    userMemoryInFlight.delete(key);
  }
}

// ---------------------------------------------------------------
// Varredura
// ---------------------------------------------------------------

async function processOnce(): Promise<void> {
  const summaries = await listDebateSummaries();
  const now = Date.now();

  // Lê apenas o arquivo JSON das sessões realmente ativas (0 leituras em repouso).
  const activeSummaries = summaries.filter(
    (s) => s.status === "running" && (s.engineVersion ?? 0) >= 2
  );

  for (const summary of activeSummaries) {
    const session = await getDebateSessionById(summary.id);
    if (!session || session.status !== "running") continue;

    const activeTurnId = session.turns?.at(-1)?.id;
    const pending = session.tasks.filter((task) => {
      if (
        task.status !== "pending" ||
        !(
          task.singleTaskOnly === true ||
          !activeTurnId ||
          !task.turnId ||
          task.turnId === activeTurnId
        ) ||
        task.round !== session.currentRound ||
        task.stage !== session.currentStage ||
        !isAutoPlatform(task.platform) ||
        inFlight.has(task.id)
      ) {
        return false;
      }
      // Se o usuário clicou em Retomar (attempts foi limpo), libera cooldown imediatamente!
      if (task.attempts === undefined && retryNotBefore.has(task.id)) {
        retryNotBefore.delete(task.id);
      }
      return (retryNotBefore.get(task.id) ?? 0) <= now;
    });

    if (pending.length === 0) continue;

    // Despacho 100% NÃO-BLOQUEANTE por tarefa:
    // NUNCA espera uma IA lenta (ex.: NVIDIA 120s) dentro de Promise.all para liberar o runner!
    // Assim, se Gemini der 503 e retentar (ou o usuário clicar Retomar / failover),
    // ela inicia IMEDIATAMENTE em paralelo enquanto as outras IAs ainda estão escrevendo.
    const tracker = getOrCreateStageTracker(session, activeTurnId);
    const batchContext = tracker ? makeStageBatchContext(tracker) : undefined;

    for (const task of pending) {
      inFlight.add(task.id);
      void runTask(session.id, task, session, batchContext)
        .catch((err) => {
          console.error(
            "[AI Council] Erro inesperado em tarefa paralela:",
            err instanceof Error ? err.message : err
          );
        })
        .finally(() => {
          // Assim que qualquer tarefa termina (resposta, failover ou dispensa), acorda
          // o runner em 0ms para iniciar próxima etapa / síntese ou retry sem esperar lentas.
          kickRunner();
        });
    }
  }

  // Em segundo plano, dispara Veredito Automático (opt-in, best-effort com trava >= 15% cota)
  // e compacta turnos antigos (> 3) em Memória Compartilhada.
  for (const summary of summaries.slice(0, 5)) {
    if (summary.status !== "completed" || (summary.engineVersion ?? 0) < 2) {
      continue;
    }

    const needsMemoryCheck =
      summary.turnCount > RECENT_FULL_TURNS &&
      (summary.sharedMemoryTurns ?? 0) < summary.turnCount - RECENT_FULL_TURNS &&
      !memoryInFlight.has(summary.id) &&
      (memoryRetryNotBefore.get(summary.id) ?? 0) <= now;

    const session = await getDebateSessionById(summary.id);
    if (!session) continue;

    const latestTurn = session.turns?.at(-1);
    if (latestTurn && shouldTriggerAutoVerdict(session, latestTurn)) {
      const verdictKey = `${session.id}:${latestTurn.id}`;
      if (!autoVerdictInFlight.has(verdictKey) && !autoVerdictAttempted.has(verdictKey)) {
        void runAutoVerdict(session.id, latestTurn.id);
      }
    }

    if (
      latestTurn &&
      latestTurn.status === "completed" &&
      latestTurn.builderMode &&
      !latestTurn.builderState &&
      session.projectId
    ) {
      void runAutoBuilderAfterTurnCompleted(session.id, latestTurn.id);
    }

    if (
      latestTurn &&
      latestTurn.status === "completed" &&
      mightContainPersonalMemory(latestTurn.prompt)
    ) {
      const memKey = `${session.id}:${latestTurn.id}`;
      if (!userMemoryInFlight.has(memKey) && !userMemoryAttempted.has(memKey)) {
        void runUserMemoryExtraction(session, latestTurn.id);
      }
    }

    if (needsMemoryCheck) {
      const job = getPendingMemoryCompaction(session);
      if (job) {
        void runMemoryCompaction(job);
        break;
      }
    }
  }
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
      await processOnce();
      passes += 1;
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
  clearAllStageTrackers();
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

/** Pede uma varredura imediata (ex.: depois de criar ou retomar um debate). */
export function kickRunner(): void {
  void tick();
}
