import { randomUUID } from "node:crypto";

import {
  ALL_PLATFORMS,
  isAutoPlatform,
  type AIPlatform,
  type CreateDebateInput,
  type DebateFocus,
  type DebateResponse,
  type DebateSession,
  type DebateStage,
  type DebateTask,
  type ParticipantState,
  type SubmitResponseInput,
  type SubmitResponseMeta
} from "../shared/debate-types.js";

import {
  readDebateSessions,
  withDebateLock,
  writeDebateSessionsAtomically
} from "../persistence/debate-store.js";

// ============================================
// CONSTANTES
// ============================================

export const ENGINE_VERSION = 2;

export const PLATFORM_NAMES: Record<AIPlatform, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  groq: "Groq",
  openrouter: "OpenRouter"
};

const DEFAULT_RULES =
  "Seja curto, direto e 100% concreto. Sem enrolação, sem introdução longa e sem teoria desnecessária. Foque na solução prática e acionável.";

const MAX_TOKENS = {
  initial_response: 1100,
  critique: 1100,
  synthesis: 1600
} as const;

// Limites de contexto reenviado entre rodadas (economia de tokens).
const COMPACT_CRITIQUE_CHARS = 3000;
const COMPACT_SYNTHESIS_CHARS = 4500;

export const DEFAULT_SYSTEM_PROMPT = [
  "Você integra o AI Council, um conselho técnico de IAs que debate para chegar à melhor resposta.",
  "Responda sempre em Markdown, em português do Brasil, de forma curta, direta e concreta.",
  "Sem introdução, sem elogios e sem repetir o enunciado.",
  "Use código somente quando necessário, em blocos com a linguagem indicada.",
  "Se faltar informação, assuma o mais razoável e escreva a suposição em uma linha."
].join(" ");

const FRONTEND_RULES = [
  "Evite o visual genérico de IA: sem gradientes roxo/azul, sem emojis em títulos,",
  "sem grade de cards idênticos com sombra, sem excesso de ícones decorativos,",
  "sem textos de marketing vagos. Defina tipografia, escala de espaçamento,",
  "paleta com uma única cor de destaque e hierarquia visual coerentes.",
  "Prefira detalhes específicos do produto e alinhamentos intencionais."
].join(" ");

// ============================================
// PAPÉIS (cada IA recebe uma função diferente)
// ============================================

interface Role {
  title: string;
  round1: string;
  critique: string;
}

function roleFor(platform: AIPlatform, focus: DebateFocus): Role {
  switch (platform) {
    case "gemini":
      return {
        title: "Arquiteto e relator",
        round1:
          "Proponha a arquitetura principal e o código essencial completo.",
        critique:
          "Preserve sua estrutura base e faça merge linha a linha com as travas de segurança e otimizações válidas dos colegas."
      };

    case "groq":
      return {
        title: "Revisor técnico (bugs, segurança e borda)",
        round1:
          "Proponha sua solução focando em segurança, erros e casos de borda.",
        critique:
          "Aponte apenas bugs/riscos reais nas propostas e faça merge das suas travas na melhor estrutura do conselho."
      };

    case "openrouter":
      if (focus === "frontend") {
        return {
          title: "Revisor de UX e estética",
          round1: `Proponha a interface focando em UX. ${FRONTEND_RULES}`,
          critique: `Melhore a UX/estética fazendo merge no código do conselho. ${FRONTEND_RULES}`
        };
      }

      if (focus === "backend") {
        return {
          title: "Revisor de simplicidade",
          round1:
            "Proponha a solução mais simples, completa e desacoplada.",
          critique:
            "Corte complexidade desnecessária preservando todas as validações e regras das demais propostas."
        };
      }

      return {
        title: "Voz alternativa e otimização",
        round1:
          "Proponha uma abordagem otimizada no mesmo escopo, com código completo e trade-off em 1 linha.",
        critique:
          "Otimize gargalos fazendo merge direto na estrutura do conselho, sem remover validações existentes."
      };

    case "chatgpt":
      return {
        title: "Autor alternativo",
        round1: "Proponha uma abordagem alternativa explicando o trade-off.",
        critique: "Integre o que faltou nas propostas em uma versão unificada."
      };

    case "claude":
      return {
        title: "Revisor de qualidade",
        round1: "Proponha a solução focando em clareza e manutenção.",
        critique: "Refine a legibilidade mantendo a lógica consolidada do conselho."
      };
  }
}

// ============================================
// UTILITÁRIOS DE PROMPT
// ============================================

/** Reduz uma resposta longa mantendo início e fim (evita reenviar tudo a cada rodada). */
export function compactForPrompt(text: string, maxChars: number): string {
  const clean = text.trim();

  if (clean.length <= maxChars) {
    return clean;
  }

  const head = clean.slice(0, Math.floor(maxChars * 0.7));
  const tail = clean.slice(-Math.floor(maxChars * 0.25));

  let output = `${head}\n\n[... trecho omitido para economizar tokens ...]\n\n${tail}`;

  const fenceCount = (output.match(/^```/gm) ?? []).length;
  if (fenceCount % 2 === 1) {
    output += "\n```";
  }

  return output;
}

function combinePrompt(system: string, user: string): string {
  return `${system}\n\n---\n\n${user}`;
}

function labelFor(platform: AIPlatform, focus: DebateFocus): string {
  return `${PLATFORM_NAMES[platform]} — ${roleFor(platform, focus).title}`;
}

function focusOf(session: DebateSession): DebateFocus {
  return session.focus ?? "geral";
}

function buildInitialUserPrompt(
  session: DebateSession,
  platform: AIPlatform
): string {
  const role = roleFor(platform, focusOf(session));

  return [
    `Tema: ${session.title}`,
    ``,
    `Problema:`,
    session.topic,
    ``,
    `Diretriz: ${session.rules}`,
    ``,
    `Seu papel: ${role.title}.`,
    role.round1,
    `Seja enxuto: no máximo ~350 palavras fora blocos de código.`
  ].join("\n");
}

function buildPreviousBlock(
  session: DebateSession,
  round: number,
  maxChars: number
): string {
  const focus = focusOf(session);

  return session.responses
    .filter((resp) => resp.round === round)
    .map((resp) =>
      [
        `### ${labelFor(resp.platform, focus)}`,
        compactForPrompt(resp.content, maxChars)
      ].join("\n")
    )
    .join("\n\n");
}

function buildCritiqueUserPrompt(
  session: DebateSession,
  round: number,
  platform: AIPlatform
): string {
  const role = roleFor(platform, focusOf(session));
  const previousRound = round - 1;

  return [
    `Problema: ${session.topic}`,
    `Diretriz: ${session.rules}`,
    ``,
    `Propostas da rodada ${previousRound} (resumidas):`,
    ``,
    buildPreviousBlock(session, previousRound, COMPACT_CRITIQUE_CHARS),
    ``,
    `Seu papel: ${role.title}.`,
    role.critique,
    `Formato: (1) até 3 falhas reais (não invente se já estiver correto); (2) código único mesclando o melhor das 3 propostas (proibido TODOs ou cortes). Seja curto.`
  ].join("\n");
}

function buildSynthesisUserPrompt(session: DebateSession): string {
  return [
    `Pedido original: ${session.topic}`,
    `Diretriz: ${session.rules}`,
    ``,
    `Posições finais da rodada ${session.totalRounds}:`,
    ``,
    buildPreviousBlock(session, session.totalRounds, COMPACT_SYNTHESIS_CHARS),
    ``,
    `Você é o relator. Faça um MERGE linha a linha mantendo sua estrutura base (Gemini) somada às validações do Groq e otimizações do OpenRouter (ignore códigos cortados/TODOs e restaure qualquer trava de estado omitida):`,
    `1. "# Solução final" — a solução consolidada completa.`,
    `2. "## Conclusão do conselho" — 1 parágrafo curto sobre o que foi fundido.`
  ].join("\n");
}

// ============================================
// CRIAÇÃO DE TAREFAS
// ============================================

function createInitialParticipantStates(
  participants: AIPlatform[]
): Record<AIPlatform, ParticipantState> {
  const states = {} as Record<AIPlatform, ParticipantState>;

  for (const platform of ALL_PLATFORMS) {
    if (participants.includes(platform)) {
      states[platform] = {
        platform,
        availability: "unknown"
      };
    }
  }

  return states;
}

function pickRelator(session: DebateSession): AIPlatform {
  if (session.participants.includes("gemini")) return "gemini";

  const firstAuto = session.participants.find((p) => isAutoPlatform(p));
  return firstAuto ?? session.participants[0] ?? "gemini";
}

function buildTask(
  session: DebateSession,
  round: number,
  stage: Exclude<DebateStage, "completed">,
  platform: AIPlatform
): DebateTask {
  const focus = focusOf(session);
  const role = roleFor(platform, focus);

  const userPrompt =
    stage === "initial_response"
      ? buildInitialUserPrompt(session, platform)
      : stage === "critique"
        ? buildCritiqueUserPrompt(session, round, platform)
        : buildSynthesisUserPrompt(session);

  return {
    id: randomUUID(),
    round,
    stage,
    platform,
    status: "pending",
    createdAt: new Date().toISOString(),
    seat: isAutoPlatform(platform) ? "auto" : "manual",
    role: stage === "synthesis" ? "Relator" : role.title,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    userPrompt,
    maxTokens: MAX_TOKENS[stage],
    prompt: combinePrompt(DEFAULT_SYSTEM_PROMPT, userPrompt)
  };
}

function createTasksForStage(
  session: DebateSession,
  round: number,
  stage: Exclude<DebateStage, "completed">
): DebateTask[] {
  if (stage === "synthesis") {
    return [buildTask(session, round, "synthesis", pickRelator(session))];
  }

  return session.participants.map((platform) =>
    buildTask(session, round, stage, platform)
  );
}

// ============================================
// CONSULTAS
// ============================================

export async function listDebateSessions(): Promise<DebateSession[]> {
  const sessions = await readDebateSessions();
  return [...sessions].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
  );
}

export async function getDebateSessionById(
  debateId: string
): Promise<DebateSession | null> {
  const sessions = await readDebateSessions();
  return sessions.find((s) => s.id === debateId) ?? null;
}

export async function deleteDebateSession(
  debateId: string
): Promise<boolean> {
  return withDebateLock(async () => {
    const sessions = await readDebateSessions();
    const filtered = sessions.filter((s) => s.id !== debateId);

    if (filtered.length === sessions.length) {
      return false;
    }

    await writeDebateSessionsAtomically(filtered);
    return true;
  });
}

// ============================================
// CRIAÇÃO DE DEBATE
// ============================================

export async function createDebateSession(
  input: CreateDebateInput
): Promise<DebateSession> {
  const uniqueParticipants = Array.from(new Set(input.participants));

  if (uniqueParticipants.length < 2) {
    throw new Error(
      "O debate precisa ter pelo menos 2 inteligências participantes."
    );
  }

  const totalRounds = Math.min(Math.max(Number(input.totalRounds) || 2, 1), 3);
  const now = new Date().toISOString();
  const title = input.title.trim();
  const topic = input.topic.trim();
  const rules = (input.rules || DEFAULT_RULES).trim();

  const focus: DebateFocus =
    input.focus === "backend" || input.focus === "frontend"
      ? input.focus
      : "geral";

  if (!title || !topic) {
    throw new Error("Título e tema do debate são obrigatórios.");
  }

  return withDebateLock(async () => {
    const sessions = await readDebateSessions();

    // Pausa debates antigos abertos para que o novo seja o único ativo (running).
    for (const old of sessions) {
      if (old.status === "running") {
        old.status = "paused_manual";
        old.pauseInfo = {
          reason: "manual_pause",
          message: "Pausado automaticamente ao iniciar um novo debate.",
          pausedAt: now
        };
      }
    }

    const newSession: DebateSession = {
      id: randomUUID(),
      title,
      topic,
      rules,
      participants: uniqueParticipants,
      totalRounds,
      currentRound: 1,
      currentStage: "initial_response",
      status: "running",
      participantStates: createInitialParticipantStates(uniqueParticipants),
      tasks: [],
      responses: [],
      createdAt: now,
      updatedAt: now,
      focus,
      engineVersion: ENGINE_VERSION
    };

    newSession.tasks = createTasksForStage(newSession, 1, "initial_response");

    sessions.push(newSession);
    await writeDebateSessionsAtomically(sessions);

    return newSession;
  });
}

// ============================================
// REGISTRO DE RESPOSTAS
// ============================================

function stripLegacyWrappers(raw: string): string {
  return raw
    .replace(/^~~~~+markdown\s*/i, "")
    .replace(/^~~~+markdown\s*/i, "")
    .replace(/^```+markdown\s*/i, "")
    .replace(/~~~~+\s*$/i, "")
    .replace(/\[FIM_DA_RESPOSTA\]/gi, "")
    .trim();
}

export async function submitDebateTaskResponse(
  debateId: string,
  input: SubmitResponseInput,
  meta: SubmitResponseMeta = {}
): Promise<DebateSession> {
  const content = stripLegacyWrappers(input.content);

  if (!content) {
    throw new Error("O conteúdo da resposta não pode estar vazio.");
  }

  return withDebateLock(async () => {
    const sessions = await readDebateSessions();
    const session = sessions.find((s) => s.id === debateId);

    if (!session) {
      throw new Error("Sessão de debate não encontrada.");
    }

    if (session.status === "completed") {
      throw new Error("O debate já foi concluído.");
    }

    if (session.status !== "running" && !meta.allowWhilePaused) {
      throw new Error(
        "Não é possível registrar respostas enquanto o debate estiver pausado ou concluído."
      );
    }

    const task = session.tasks.find((t) => t.id === input.taskId);

    if (!task) {
      throw new Error("Tarefa não encontrada neste debate.");
    }

    if (task.status === "completed") {
      return session;
    }

    const echoProbe = task.userPrompt?.trim().slice(0, 120);

    if (
      content === task.prompt.trim() ||
      (echoProbe && echoProbe.length > 40 && content.includes(echoProbe))
    ) {
      throw new Error(
        "O texto colado é o próprio prompt da pergunta. Cole a resposta real da IA."
      );
    }

    const now = new Date().toISOString();

    task.status = "completed";
    task.completedAt = now;
    delete task.lastError;
    delete task.userPrompt;
    delete task.systemPrompt;
    task.prompt = "";

    const responseRecord: DebateResponse = {
      id: randomUUID(),
      taskId: task.id,
      round: task.round,
      stage: task.stage,
      platform: task.platform,
      promptUsed: "",
      content,
      submittedAt: now,
      ...(meta.model ? { model: meta.model } : {}),
      ...(meta.tokens !== undefined ? { tokens: meta.tokens } : {})
    };

    session.responses.push(responseRecord);
    session.updatedAt = now;

    const pendingInCurrentStage = session.tasks.some(
      (t) =>
        t.round === session.currentRound &&
        t.stage === session.currentStage &&
        t.status === "pending"
    );

    if (!pendingInCurrentStage) {
      if (session.currentStage === "synthesis") {
        session.currentStage = "completed";
        session.status = "completed";
        session.conclusion = content;
        session.completedAt = now;
        delete session.pauseInfo;
      } else if (session.currentRound < session.totalRounds) {
        session.currentRound += 1;
        session.currentStage = "critique";
        session.tasks.push(
          ...createTasksForStage(session, session.currentRound, "critique")
        );
      } else {
        session.currentStage = "synthesis";
        session.tasks.push(
          ...createTasksForStage(session, session.currentRound, "synthesis")
        );
      }
    }

    await writeDebateSessionsAtomically(sessions);
    return session;
  });
}

// ============================================
// FALHAS DE PROVEDOR
// ============================================

export async function recordTaskFailure(
  debateId: string,
  taskId: string,
  message: string,
  options: { maxAttempts?: number; fatal?: boolean } = {}
): Promise<DebateSession | null> {
  return withDebateLock(async () => {
    const sessions = await readDebateSessions();
    const session = sessions.find((s) => s.id === debateId);
    const task = session?.tasks.find((t) => t.id === taskId);

    if (!session || !task || task.status === "completed") {
      return null;
    }

    const now = new Date().toISOString();

    task.attempts = (task.attempts ?? 0) + 1;
    task.lastError = message.slice(0, 400);
    session.updatedAt = now;

    const exhausted =
      options.fatal === true || task.attempts >= (options.maxAttempts ?? 2);

    if (exhausted && session.status === "running") {
      session.status = "paused_error";
      session.pauseInfo = {
        reason: "provider_error",
        blockedBy: task.platform,
        message: `Debate pausado: ${PLATFORM_NAMES[task.platform]} falhou (${task.lastError}). Corrija o problema e clique em Retomar. O progresso foi preservado.`,
        pausedAt: now
      };
    }

    await writeDebateSessionsAtomically(sessions);
    return session;
  });
}

// ============================================
// PAUSA E RETOMADA
// ============================================

export async function pauseDebateManually(
  debateId: string,
  reasonMessage?: string
): Promise<DebateSession> {
  return withDebateLock(async () => {
    const sessions = await readDebateSessions();
    const session = sessions.find((s) => s.id === debateId);

    if (!session) {
      throw new Error("Sessão de debate não encontrada.");
    }

    if (session.status === "completed") {
      throw new Error("O debate já foi concluído.");
    }

    const now = new Date().toISOString();

    session.status = "paused_manual";
    session.pauseInfo = {
      reason: "manual_pause",
      message:
        reasonMessage?.trim() ||
        "Debate pausado manualmente pelo usuário. Todo o progresso foi salvo.",
      pausedAt: now
    };
    session.updatedAt = now;

    await writeDebateSessionsAtomically(sessions);
    return session;
  });
}

export async function resumeDebateSession(
  debateId: string
): Promise<DebateSession> {
  return withDebateLock(async () => {
    const sessions = await readDebateSessions();
    const session = sessions.find((s) => s.id === debateId);

    if (!session) {
      throw new Error("Sessão de debate não encontrada.");
    }

    if (session.status === "completed") {
      throw new Error("O debate já está concluído.");
    }

    const now = new Date().toISOString();

    if (session.pauseInfo?.blockedBy) {
      const blockedPlatform = session.pauseInfo.blockedBy;
      if (session.participantStates[blockedPlatform]) {
        session.participantStates[blockedPlatform] = {
          ...session.participantStates[blockedPlatform],
          availability: "unknown"
        };
      }
    }

    // Recomeça a contagem de tentativas das tarefas pendentes.
    for (const task of session.tasks) {
      if (task.status === "pending") {
        delete task.attempts;
        delete task.lastError;
      }
    }

    session.status = "running";
    delete session.pauseInfo;
    session.updatedAt = now;

    await writeDebateSessionsAtomically(sessions);
    return session;
  });
}

export async function applyLimitSignalToDebates(
  platform: AIPlatform,
  severity: "warning" | "blocked",
  matchedText: string,
  observedAt: string
): Promise<{ pausedDebateIds: string[] }> {
  return withDebateLock(async () => {
    const sessions = await readDebateSessions();
    const pausedDebateIds: string[] = [];
    let modified = false;

    for (const session of sessions) {
      if (!session.participants.includes(platform)) {
        continue;
      }

      if (session.status === "completed") {
        continue;
      }

      session.participantStates[platform] = {
        platform,
        availability: severity,
        lastSignalAt: observedAt,
        lastLimitMessage: matchedText
      };
      session.updatedAt = observedAt;
      modified = true;

      if (severity === "blocked" && session.status === "running") {
        session.status = "paused_limit";
        session.pauseInfo = {
          reason: "usage_limit_reached",
          blockedBy: platform,
          message: `Debate pausado automaticamente: ${PLATFORM_NAMES[platform]} atingiu o limite gratuito ("${matchedText}"). Estado preservado.`,
          pausedAt: observedAt
        };
        pausedDebateIds.push(session.id);
      }
    }

    if (modified) {
      await writeDebateSessionsAtomically(sessions);
    }

    return { pausedDebateIds };
  });
}
