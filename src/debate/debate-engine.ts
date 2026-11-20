import { randomUUID } from "node:crypto";

import {
  ALL_PLATFORMS,
  isAutoPlatform,
  type AIPlatform,
  type ChatAttachment,
  type ChatTurn,
  type ContinueDebateInput,
  type CreateDebateInput,
  type DebateFocus,
  type DebateResponse,
  type DebateSession,
  type DebateStage,
  type DebateSummary,
  type DebateTask,
  type InteractionMode,
  type ParticipantState,
  type ResponseMode,
  type SharedMemoryState,
  type SubmitResponseInput,
  type SubmitResponseMeta
} from "../shared/debate-types.js";

import {
  deleteDebateSessionFile,
  readDebateSessionById,
  readDebateSessions,
  readDebateSummaries,
  withDebateLock,
  writeDebateSessionAtomically
} from "../persistence/debate-store.js";
import {
  budgetForPlatform,
  RECENT_FULL_TURNS
} from "../shared/context-budget.js";
import { emitDebateUpdated } from "./stream-hub.js";

export { budgetForPlatform, RECENT_FULL_TURNS };

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

const MEMORY_COMPACTION_SYSTEM_PROMPT = [
  "Você mantém a Memória Compartilhada de uma conversa usada simultaneamente por 3 IAs (Gemini, Groq e OpenRouter).",
  "Resuma apenas fatos concretos, decisões tomadas, preferências do usuário, nomes/números/regras e estado atual do assunto ou código.",
  "Não invente nada, não dê opiniões e escreva em tópicos curtos em português do Brasil (máximo ~300 palavras)."
].join(" ");

export const DEFAULT_SYSTEM_PROMPT = [
  "Você integra o AI Council, um conselho técnico de IAs que debate para chegar à melhor resposta.",
  "Responda sempre em Markdown, em português do Brasil, de forma curta, direta e concreta.",
  "Sem introdução, sem elogios e sem repetir o enunciado.",
  "Use código somente quando necessário, em blocos com a linguagem indicada.",
  "Se faltar informação, assuma o mais razoável e escreva a suposição em uma linha."
].join(" ");

export const PROMPT_MD_DIRECT_SYSTEM_PROMPT = [
  "Responda sempre em Markdown estruturado, em português do Brasil, de forma curta, direta e concreta.",
  "Sem introdução, sem elogios e sem repetir o enunciado.",
  "Use código somente quando necessário, em blocos com a linguagem indicada.",
  "Se faltar informação, assuma o mais razoável e escreva a suposição em uma linha."
].join(" ");

export const NORMAL_DIRECT_SYSTEM_PROMPT = [
  "Você é um assistente de IA conversando em português do Brasil.",
  "Responda de forma natural, clara e objetiva, como em uma conversa normal.",
  "Evite respostas longas demais ou excessivamente descritivas; vá direto ao ponto sem perder a naturalidade."
].join(" ");

export const NORMAL_DEBATE_SYSTEM_PROMPT = [
  "Você participa de um debate entre IAs em português do Brasil.",
  "Responda de forma natural, clara e objetiva sobre o assunto pedido.",
  "Evite enrolação e textos excessivamente descritivos."
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

function normalRoleFor(platform: AIPlatform): Role {
  switch (platform) {
    case "gemini":
      return {
        title: "Perspectiva principal",
        round1: "Dê uma resposta natural, clara e prática.",
        critique:
          "Considere os pontos dos colegas e entregue uma versão ainda mais clara e equilibrada."
      };

    case "groq":
      return {
        title: "Olhar crítico",
        round1:
          "Responda de forma natural destacando nuances, riscos ou pontos que costumam passar despercebidos.",
        critique:
          "Aponte o que pode ser corrigido ou completado nas outras respostas e entregue sua versão refinada."
      };

    case "openrouter":
      return {
        title: "Visão alternativa",
        round1:
          "Responda de forma natural trazendo um ângulo diferente ou uma abordagem mais simples.",
        critique:
          "Simplifique e melhore a resposta juntando as melhores ideias dos colegas."
      };

    case "chatgpt":
      return {
        title: "Visão complementar",
        round1: "Responda de forma natural trazendo uma perspectiva complementar.",
        critique: "Integre os melhores pontos em uma resposta única e direta."
      };

    case "claude":
      return {
        title: "Clareza e síntese",
        round1: "Responda com naturalidade, clareza e boa organização.",
        critique: "Refine a clareza mantendo os pontos mais úteis dos colegas."
      };
  }
}

// ============================================
// UTILITÁRIOS DE PROMPT E HISTÓRICO
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

function normalizeResponseMode(value?: string): ResponseMode {
  return value === "normal" ? "normal" : "prompt_markdown";
}

function normalizeInteractionMode(value?: string): InteractionMode {
  return value === "direct" ? "direct" : "debate";
}

function normalizeFocus(value?: string): DebateFocus {
  return value === "backend" || value === "frontend" ? value : "geral";
}

function labelFor(
  platform: AIPlatform,
  focus: DebateFocus,
  responseMode: ResponseMode
): string {
  const role =
    responseMode === "normal"
      ? normalRoleFor(platform)
      : roleFor(platform, focus);
  return `${PLATFORM_NAMES[platform]} — ${role.title}`;
}

function systemPromptFor(
  responseMode: ResponseMode,
  interactionMode: InteractionMode
): string {
  if (responseMode === "normal") {
    return interactionMode === "direct"
      ? NORMAL_DIRECT_SYSTEM_PROMPT
      : NORMAL_DEBATE_SYSTEM_PROMPT;
  }

  return interactionMode === "direct"
    ? PROMPT_MD_DIRECT_SYSTEM_PROMPT
    : DEFAULT_SYSTEM_PROMPT;
}

function responsesForTurn(
  session: DebateSession,
  turnId: string
): DebateResponse[] {
  const isLegacyFirst =
    session.turns?.[0]?.id === turnId || turnId === "legacy_turn_1";

  return session.responses.filter(
    (resp) => resp.turnId === turnId || (isLegacyFirst && !resp.turnId)
  );
}

const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_CHARS = 60_000;
const MAX_TOTAL_ATTACHMENTS_CHARS = 150_000;

function sanitizeAttachments(raw?: ChatAttachment[]): ChatAttachment[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const result: ChatAttachment[] = [];
  let totalChars = 0;

  for (const item of raw.slice(0, MAX_ATTACHMENTS)) {
    if (!item || typeof item.name !== "string" || typeof item.content !== "string") {
      continue;
    }
    const name = item.name.trim().slice(0, 120);
    const content = item.content.replace(/\0/g, "").slice(0, MAX_ATTACHMENT_CHARS);
    if (!name || !content.trim()) continue;
    if (totalChars + content.length > MAX_TOTAL_ATTACHMENTS_CHARS) break;

    totalChars += content.length;
    result.push({
      name,
      content,
      size: typeof item.size === "number" && item.size >= 0 ? item.size : content.length
    });
  }

  return result;
}

function langFromFilename(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    ts: "ts",
    tsx: "tsx",
    js: "js",
    jsx: "jsx",
    json: "json",
    html: "html",
    css: "css",
    java: "java",
    py: "python",
    sql: "sql",
    md: "markdown",
    sh: "bash",
    ps1: "powershell",
    yml: "yaml",
    yaml: "yaml",
    xml: "xml",
    go: "go",
    rs: "rust",
    c: "c",
    cpp: "cpp",
    h: "c",
    php: "php",
    rb: "ruby"
  };
  return map[ext] ?? "";
}

function buildAttachmentsBlock(turn: ChatTurn, platform: AIPlatform): string {
  const files = turn.attachments;
  if (!Array.isArray(files) || files.length === 0) return "";

  const budget = budgetForPlatform(platform).attachmentChars;
  const perFile = Math.max(800, Math.floor(budget / files.length));

  const blocks = files.map((file) => {
    const lang = langFromFilename(file.name);
    const snippet = compactForPrompt(file.content, perFile);
    return `### Arquivo: ${file.name}\n\`\`\`${lang}\n${snippet}\n\`\`\``;
  });

  return `Arquivos anexados:\n\n${blocks.join("\n\n")}`;
}

function formatUnifiedTurnForContext(
  session: DebateSession,
  turn: ChatTurn,
  userBudget: number,
  assistantBudget: number
): string {
  const filesSuffix =
    Array.isArray(turn.attachments) && turn.attachments.length > 0
      ? ` [Anexos: ${turn.attachments.map((f) => f.name).join(", ")}]`
      : "";
  const userText = `${compactForPrompt(turn.prompt, userBudget)}${filesSuffix}`;
  let assistantText = "";

  if (turn.conclusion?.trim()) {
    assistantText = `Consenso: ${compactForPrompt(turn.conclusion, assistantBudget)}`;
  } else {
    const turnResps = responsesForTurn(session, turn.id).filter(
      (r) => r.stage !== "synthesis"
    );

    if (turnResps.length === 1 && turnResps[0]) {
      const only = turnResps[0];
      assistantText = `[${PLATFORM_NAMES[only.platform]}]: ${compactForPrompt(only.content, assistantBudget)}`;
    } else if (turnResps.length > 1) {
      const perRespBudget = Math.max(
        260,
        Math.floor(assistantBudget / turnResps.length)
      );
      assistantText = turnResps
        .map(
          (r) =>
            `[${PLATFORM_NAMES[r.platform]}]: ${compactForPrompt(r.content, perRespBudget)}`
        )
        .join("\n\n");
    }
  }

  return assistantText
    ? `Usuário: ${userText}\n\nRespostas:\n${assistantText}`
    : `Usuário: ${userText}`;
}

function buildConversationHistoryBlock(
  session: DebateSession,
  currentTurnId: string,
  platform: AIPlatform
): string {
  const budget = budgetForPlatform(platform);
  const turns = session.turns ?? [];
  const currentIdx = turns.findIndex((t) => t.id === currentTurnId);
  const previousTurns = (
    currentIdx >= 0 ? turns.slice(0, currentIdx) : turns
  ).filter((t) => t.status === "completed");

  const sections: string[] = [];
  let remainingChars = budget.historyChars;

  // 1. Memória Compartilhada (automática ou editada manualmente — sempre idêntica para as 3 IAs).
  const memory = session.sharedMemory;
  const hasMemoryText = Boolean(memory && memory.summary.trim());
  const coveredCount = hasMemoryText && memory
    ? Math.min(memory.coveredTurnCount, previousTurns.length)
    : 0;

  if (hasMemoryText && memory) {
    const summaryText = compactForPrompt(
      memory.summary,
      budget.memorySummaryChars
    );
    const label =
      coveredCount > 0
        ? `Memória compartilhada (turnos 1–${coveredCount}):`
        : "Memória compartilhada (fixada pelo usuário):";
    const memoryBlock = `${label}\n${summaryText}`;
    sections.push(memoryBlock);
    remainingChars = Math.max(1200, remainingChars - memoryBlock.length);
  }

  if (previousTurns.length === 0) {
    return sections.length > 0 ? `${sections.join("\n\n")}\n\n---` : "";
  }

  // 2. Turnos recentes unificados (todas as 3 IAs veem o que as colegas responderam).
  const uncompactedTurns = previousTurns.slice(coveredCount);
  const candidateTurns = (
    uncompactedTurns.length > 0 ? uncompactedTurns : previousTurns
  ).slice(-budget.maxRecentTurns);

  const entries = candidateTurns.map((prev) =>
    formatUnifiedTurnForContext(
      session,
      prev,
      budget.turnUserChars,
      budget.turnAssistantChars
    )
  );

  const kept: string[] = [];
  let recentChars = 0;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i] ?? "";
    if (kept.length > 0 && recentChars + entry.length > remainingChars) {
      break;
    }
    kept.unshift(entry);
    recentChars += entry.length;
  }

  if (kept.length > 0) {
    sections.push(`Histórico recente compartilhado:\n\n${kept.join("\n\n---\n\n")}`);
  }

  if (sections.length === 0) {
    return "";
  }

  return `${sections.join("\n\n===\n\n")}\n\n---`;
}

export interface PendingMemoryCompaction {
  debateId: string;
  targetCoveredCount: number;
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
}

/**
 * Verifica se há turnos concluídos antigos (além dos últimos RECENT_FULL_TURNS)
 * que ainda não foram incorporados na Memória Compartilhada da sessão.
 */
export function getPendingMemoryCompaction(
  session: DebateSession
): PendingMemoryCompaction | null {
  const turns = session.turns ?? [];
  const completedTurns = turns.filter((t) => t.status === "completed");

  if (completedTurns.length <= RECENT_FULL_TURNS) {
    return null;
  }

  const targetCoveredCount = completedTurns.length - RECENT_FULL_TURNS;
  const alreadyCovered = session.sharedMemory?.coveredTurnCount ?? 0;

  if (targetCoveredCount <= alreadyCovered) {
    return null;
  }

  const turnsToFold = completedTurns.slice(alreadyCovered, targetCoveredCount);
  if (turnsToFold.length === 0) {
    return null;
  }

  const foldedBlock = turnsToFold
    .map((t) =>
      `### Turno ${t.index}\n${formatUnifiedTurnForContext(session, t, 1400, 2600)}`
    )
    .join("\n\n");

  const parts: string[] = [];
  if (session.sharedMemory?.summary?.trim()) {
    parts.push(
      `Memória compartilhada anterior (turnos 1–${alreadyCovered}):`,
      session.sharedMemory.summary.trim(),
      ""
    );
  }

  parts.push(
    `Novos turnos concluídos para incorporar (turnos ${alreadyCovered + 1}–${targetCoveredCount}):`,
    "",
    foldedBlock,
    "",
    "Atualize a Memória Compartilhada fundindo tudo em tópicos curtos, factuais e sem repetir texto desnecessário."
  );

  return {
    debateId: session.id,
    targetCoveredCount,
    systemPrompt: MEMORY_COMPACTION_SYSTEM_PROMPT,
    userPrompt: parts.join("\n"),
    maxTokens: 900
  };
}

export async function saveSessionSharedMemory(
  debateId: string,
  memory: SharedMemoryState
): Promise<DebateSession | null> {
  const cleanSummary = memory.summary.trim();
  if (!cleanSummary) return null;

  return withDebateLock(async () => {
    const session = await readDebateSessionById(debateId);
    if (!session) return null;

    const existingCovered = session.sharedMemory?.coveredTurnCount ?? 0;
    if (memory.coveredTurnCount <= existingCovered) {
      return session;
    }

    session.sharedMemory = {
      summary: compactForPrompt(cleanSummary, 3000),
      coveredTurnCount: memory.coveredTurnCount,
      updatedAt: memory.updatedAt,
      ...(memory.model ? { model: memory.model } : {})
    };
    session.updatedAt = memory.updatedAt;

    await writeDebateSessionAtomically(session);
    emitDebateUpdated(session);
    return session;
  });
}

export async function updateSessionSharedMemoryManually(
  debateId: string,
  summary: string
): Promise<DebateSession> {
  const cleanSummary = summary.trim();
  const now = new Date().toISOString();

  return withDebateLock(async () => {
    const session = await readDebateSessionById(debateId);
    if (!session) {
      throw new Error("Conversa não encontrada.");
    }

    if (!cleanSummary) {
      delete session.sharedMemory;
    } else {
      session.sharedMemory = {
        summary: compactForPrompt(cleanSummary, 3500),
        coveredTurnCount: session.sharedMemory?.coveredTurnCount ?? 0,
        updatedAt: now,
        model: "manual"
      };
    }

    session.updatedAt = now;
    await writeDebateSessionAtomically(session);
    emitDebateUpdated(session);
    return session;
  });
}

function buildPreviousBlock(
  session: DebateSession,
  turn: ChatTurn,
  round: number,
  maxChars: number
): string {
  return responsesForTurn(session, turn.id)
    .filter((resp) => resp.round === round && resp.stage !== "synthesis")
    .map((resp) =>
      [
        `### ${labelFor(resp.platform, turn.focus, turn.responseMode)}`,
        compactForPrompt(resp.content, maxChars)
      ].join("\n")
    )
    .join("\n\n");
}

function buildInitialUserPrompt(
  session: DebateSession,
  turn: ChatTurn,
  platform: AIPlatform
): string {
  const history = buildConversationHistoryBlock(session, turn.id, platform);
  const attachmentsBlock = buildAttachmentsBlock(turn, platform);
  const customRules = turn.rules.trim();

  // 1) Normal + Direto: conversa natural e direta
  if (turn.responseMode === "normal" && turn.interactionMode === "direct") {
    const parts: string[] = [];
    if (history) {
      parts.push(history, "", "Mensagem atual:", turn.prompt);
    } else {
      parts.push(turn.prompt);
    }
    if (attachmentsBlock) {
      parts.push("", attachmentsBlock);
    }
    if (customRules) {
      parts.push("", `Instrução adicional: ${customRules}`);
    }
    return parts.join("\n");
  }

  // 2) Normal + Debate: perspectivas naturais sem forçar código
  if (turn.responseMode === "normal" && turn.interactionMode === "debate") {
    const role = normalRoleFor(platform);
    const parts: string[] = [];
    if (history) {
      parts.push(history, "");
    }
    parts.push(`Pergunta:`, turn.prompt);
    if (attachmentsBlock) {
      parts.push("", attachmentsBlock);
    }
    if (customRules) {
      parts.push("", `Diretriz: ${customRules}`);
    }
    parts.push(
      "",
      `Seu papel: ${role.title}.`,
      role.round1,
      "Seja claro e objetivo."
    );
    return parts.join("\n");
  }

  // 3) Prompt Markdown + Direto: resposta técnica estruturada em 1 turno
  if (
    turn.responseMode === "prompt_markdown" &&
    turn.interactionMode === "direct"
  ) {
    const effectiveRules = customRules || DEFAULT_RULES;
    const focusHint =
      turn.focus === "frontend"
        ? FRONTEND_RULES
        : turn.focus === "backend"
          ? "Priorize simplicidade, validações essenciais e código limpo."
          : "";
    const parts: string[] = [];
    if (history) {
      parts.push(history, "");
    }
    parts.push(
      `Problema:`,
      turn.prompt
    );
    if (attachmentsBlock) {
      parts.push("", attachmentsBlock);
    }
    parts.push("", `Diretriz: ${effectiveRules}`);
    if (focusHint) {
      parts.push(focusHint);
    }
    parts.push("Entregue a resposta completa em Markdown de forma enxuta.");
    return parts.join("\n");
  }

  // 4) Prompt Markdown + Debate: formato técnico do AI Council
  const role = roleFor(platform, turn.focus);
  const effectiveRules = customRules || DEFAULT_RULES;
  const parts: string[] = [];
  if (history) {
    parts.push(history, "");
  }
  parts.push(
    `Tema: ${session.title}`,
    "",
    `Problema:`,
    turn.prompt
  );
  if (attachmentsBlock) {
    parts.push("", attachmentsBlock);
  }
  parts.push(
    "",
    `Diretriz: ${effectiveRules}`,
    "",
    `Seu papel: ${role.title}.`,
    role.round1,
    `Seja enxuto: no máximo ~350 palavras fora blocos de código.`
  );
  return parts.join("\n");
}

function buildCritiqueUserPrompt(
  session: DebateSession,
  turn: ChatTurn,
  round: number,
  platform: AIPlatform
): string {
  const budget = budgetForPlatform(platform);
  const history = buildConversationHistoryBlock(session, turn.id, platform);
  const previousRound = round - 1;
  const previousBlock = buildPreviousBlock(
    session,
    turn,
    previousRound,
    budget.critiquePeerChars
  );
  const customRules = turn.rules.trim();

  if (turn.responseMode === "normal") {
    const role = normalRoleFor(platform);
    const parts: string[] = [];
    if (history) {
      parts.push(history, "");
    }
    parts.push(`Pergunta: ${turn.prompt}`);
    if (customRules) {
      parts.push(`Diretriz: ${customRules}`);
    }
    parts.push(
      "",
      `Respostas da rodada ${previousRound}:`,
      "",
      previousBlock,
      "",
      `Seu papel: ${role.title}.`,
      role.critique,
      "Comente brevemente o que ajustou e entregue sua resposta refinada em tom natural e objetivo."
    );
    return parts.join("\n");
  }

  const role = roleFor(platform, turn.focus);
  const effectiveRules = customRules || DEFAULT_RULES;
  const parts: string[] = [];
  if (history) {
    parts.push(history, "");
  }
  parts.push(
    `Problema: ${turn.prompt}`,
    `Diretriz: ${effectiveRules}`,
    "",
    `Propostas da rodada ${previousRound} (resumidas):`,
    "",
    previousBlock,
    "",
    `Seu papel: ${role.title}.`,
    role.critique,
    `Formato: (1) até 3 falhas reais (não invente se já estiver correto); (2) código único mesclando o melhor das 3 propostas (proibido TODOs ou cortes). Seja curto.`
  );
  return parts.join("\n");
}

function buildSynthesisUserPrompt(
  session: DebateSession,
  turn: ChatTurn,
  relator: AIPlatform
): string {
  const budget = budgetForPlatform(relator);
  const history = buildConversationHistoryBlock(session, turn.id, relator);
  const finalBlock = buildPreviousBlock(
    session,
    turn,
    turn.totalRounds,
    budget.synthesisPeerChars
  );
  const customRules = turn.rules.trim();

  if (turn.responseMode === "normal") {
    const parts: string[] = [];
    if (history) {
      parts.push(history, "");
    }
    parts.push(`Pergunta original: ${turn.prompt}`);
    if (customRules) {
      parts.push(`Diretriz: ${customRules}`);
    }
    parts.push(
      "",
      `Respostas finais da rodada ${turn.totalRounds}:`,
      "",
      finalBlock,
      "",
      "Junte o melhor das respostas acima em uma única resposta final natural, clara e direta para o usuário."
    );
    return parts.join("\n");
  }

  const effectiveRules = customRules || DEFAULT_RULES;
  const parts: string[] = [];
  if (history) {
    parts.push(history, "");
  }
  parts.push(
    `Pedido original: ${turn.prompt}`,
    `Diretriz: ${effectiveRules}`,
    "",
    `Posições finais da rodada ${turn.totalRounds}:`,
    "",
    finalBlock,
    "",
    `Você é o relator. Faça um MERGE linha a linha mantendo sua estrutura base (Gemini) somada às validações do Groq e otimizações do OpenRouter (ignore códigos cortados/TODOs e restaure qualquer trava de estado omitida):`,
    `1. "# Solução final" — a solução consolidada completa.`,
    `2. "## Conclusão do conselho" — 1 parágrafo curto sobre o que foi fundido.`
  );
  return parts.join("\n");
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

function pickRelator(participants: AIPlatform[]): AIPlatform {
  if (participants.includes("gemini")) return "gemini";

  const firstAuto = participants.find((p) => isAutoPlatform(p));
  return firstAuto ?? participants[0] ?? "gemini";
}

function buildTask(
  session: DebateSession,
  turn: ChatTurn,
  round: number,
  stage: Exclude<DebateStage, "completed">,
  platform: AIPlatform
): DebateTask {
  const systemPrompt = systemPromptFor(turn.responseMode, turn.interactionMode);
  const roleLabel =
    stage === "synthesis"
      ? "Relator"
      : turn.interactionMode === "direct"
        ? "Resposta direta"
        : turn.responseMode === "normal"
          ? normalRoleFor(platform).title
          : roleFor(platform, turn.focus).title;

  const userPrompt =
    stage === "initial_response"
      ? buildInitialUserPrompt(session, turn, platform)
      : stage === "critique"
        ? buildCritiqueUserPrompt(session, turn, round, platform)
        : buildSynthesisUserPrompt(session, turn, platform);

  const budget = budgetForPlatform(platform);

  return {
    id: randomUUID(),
    turnId: turn.id,
    round,
    stage,
    platform,
    status: "pending",
    createdAt: new Date().toISOString(),
    seat: isAutoPlatform(platform) ? "auto" : "manual",
    role: roleLabel,
    systemPrompt,
    userPrompt,
    maxTokens: budget.maxTokens[stage],
    prompt: combinePrompt(systemPrompt, userPrompt)
  };
}

function createTasksForStage(
  session: DebateSession,
  turn: ChatTurn,
  round: number,
  stage: Exclude<DebateStage, "completed">
): DebateTask[] {
  if (stage === "synthesis") {
    return [
      buildTask(session, turn, round, "synthesis", pickRelator(turn.participants))
    ];
  }

  return turn.participants.map((platform) =>
    buildTask(session, turn, round, stage, platform)
  );
}

function ensureSessionTurns(session: DebateSession): ChatTurn[] {
  if (Array.isArray(session.turns) && session.turns.length > 0) {
    return session.turns;
  }

  const legacyTurnId = "legacy_turn_1";
  const legacyTurn: ChatTurn = {
    id: legacyTurnId,
    index: 1,
    prompt: session.topic,
    rules: session.rules,
    participants: [...session.participants],
    responseMode: session.responseMode ?? "prompt_markdown",
    interactionMode: session.interactionMode ?? "debate",
    totalRounds: session.totalRounds,
    focus: session.focus ?? "geral",
    currentRound: session.currentRound,
    currentStage: session.currentStage,
    status: session.status,
    ...(session.conclusion ? { conclusion: session.conclusion } : {}),
    createdAt: session.createdAt,
    ...(session.completedAt ? { completedAt: session.completedAt } : {})
  };

  for (const task of session.tasks) {
    if (!task.turnId) {
      task.turnId = legacyTurnId;
    }
  }

  for (const resp of session.responses) {
    if (!resp.turnId) {
      resp.turnId = legacyTurnId;
    }
  }

  session.turns = [legacyTurn];
  return session.turns;
}

function syncActiveTurnStatus(session: DebateSession): void {
  const activeTurn = session.turns?.at(-1);
  if (!activeTurn) return;
  activeTurn.status = session.status;
  activeTurn.currentRound = session.currentRound;
  activeTurn.currentStage = session.currentStage;
}

// ============================================
// CONSULTAS
// ============================================

export async function listDebateSummaries(): Promise<DebateSummary[]> {
  return readDebateSummaries();
}

export async function listDebateSessions(): Promise<DebateSession[]> {
  const sessions = await readDebateSessions();
  return [...sessions].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
  );
}

export async function getDebateSessionById(
  debateId: string
): Promise<DebateSession | null> {
  return readDebateSessionById(debateId);
}

export async function deleteDebateSession(
  debateId: string
): Promise<boolean> {
  return withDebateLock(async () => deleteDebateSessionFile(debateId));
}

async function pauseOtherRunningSessions(
  excludeId: string | null,
  reasonMessage: string,
  now: string
): Promise<void> {
  const summaries = await readDebateSummaries();
  const runningSummaries = summaries.filter(
    (s) => s.status === "running" && s.id !== excludeId
  );

  for (const summary of runningSummaries) {
    const old = await readDebateSessionById(summary.id);
    if (!old || old.status !== "running") continue;

    old.status = "paused_manual";
    old.pauseInfo = {
      reason: "manual_pause",
      message: reasonMessage,
      pausedAt: now
    };
    old.updatedAt = now;
    syncActiveTurnStatus(old);
    await writeDebateSessionAtomically(old);
    emitDebateUpdated(old);
  }
}

// ============================================
// CRIAÇÃO E CONTINUAÇÃO DE CONVERSA / DEBATE
// ============================================

export async function createDebateSession(
  input: CreateDebateInput
): Promise<DebateSession> {
  const uniqueParticipants = Array.from(new Set(input.participants));
  const responseMode = normalizeResponseMode(input.responseMode);
  const interactionMode = normalizeInteractionMode(input.interactionMode);

  if (interactionMode === "debate" && uniqueParticipants.length < 2) {
    throw new Error("O modo Debate precisa de pelo menos 2 IAs.");
  }

  if (uniqueParticipants.length < 1) {
    throw new Error("Selecione pelo menos 1 IA.");
  }

  const totalRounds =
    interactionMode === "direct"
      ? 1
      : Math.min(Math.max(Number(input.totalRounds) || 2, 1), 3);

  const now = new Date().toISOString();
  const title = input.title.trim();
  const topic = input.topic.trim();
  const rawRules = (input.rules ?? "").trim();
  const storedRules =
    responseMode === "prompt_markdown" ? rawRules || DEFAULT_RULES : rawRules;
  const focus = normalizeFocus(input.focus);
  const attachments = sanitizeAttachments(input.attachments);

  if (!title || !topic) {
    throw new Error("Título e mensagem são obrigatórios.");
  }

  return withDebateLock(async () => {
    await pauseOtherRunningSessions(
      null,
      "Pausado automaticamente ao iniciar uma nova conversa.",
      now
    );

    const firstTurn: ChatTurn = {
      id: randomUUID(),
      index: 1,
      prompt: topic,
      rules: rawRules,
      participants: uniqueParticipants,
      responseMode,
      interactionMode,
      totalRounds,
      focus,
      currentRound: 1,
      currentStage: "initial_response",
      status: "running",
      ...(attachments.length > 0 ? { attachments } : {}),
      createdAt: now
    };

    const newSession: DebateSession = {
      id: randomUUID(),
      title,
      topic,
      rules: storedRules,
      participants: uniqueParticipants,
      totalRounds,
      currentRound: 1,
      currentStage: "initial_response",
      status: "running",
      participantStates: createInitialParticipantStates(uniqueParticipants),
      tasks: [],
      responses: [],
      turns: [firstTurn],
      createdAt: now,
      updatedAt: now,
      focus,
      responseMode,
      interactionMode,
      engineVersion: ENGINE_VERSION
    };

    newSession.tasks = createTasksForStage(
      newSession,
      firstTurn,
      1,
      "initial_response"
    );

    await writeDebateSessionAtomically(newSession);
    emitDebateUpdated(newSession);

    return newSession;
  });
}

export async function continueDebateSession(
  debateId: string,
  input: ContinueDebateInput
): Promise<DebateSession> {
  const uniqueParticipants = Array.from(new Set(input.participants));
  const responseMode = normalizeResponseMode(input.responseMode);
  const interactionMode = normalizeInteractionMode(input.interactionMode);

  if (interactionMode === "debate" && uniqueParticipants.length < 2) {
    throw new Error("O modo Debate precisa de pelo menos 2 IAs.");
  }

  if (uniqueParticipants.length < 1) {
    throw new Error("Selecione pelo menos 1 IA.");
  }

  const message = input.message.trim();
  if (!message) {
    throw new Error("Digite uma mensagem para continuar.");
  }

  const totalRounds =
    interactionMode === "direct"
      ? 1
      : Math.min(Math.max(Number(input.totalRounds) || 2, 1), 3);
  const rawRules = (input.rules ?? "").trim();
  const focus = normalizeFocus(input.focus);
  const attachments = sanitizeAttachments(input.attachments);
  const now = new Date().toISOString();

  return withDebateLock(async () => {
    const session = await readDebateSessionById(debateId);

    if (!session) {
      throw new Error("Conversa não encontrada.");
    }

    if (session.status === "running") {
      throw new Error("Aguarde a resposta atual terminar ou pause antes de enviar.");
    }

    await pauseOtherRunningSessions(
      session.id,
      "Pausado automaticamente ao continuar outra conversa.",
      now
    );

    const turns = ensureSessionTurns(session);

    for (const platform of uniqueParticipants) {
      if (!session.participantStates[platform]) {
        session.participantStates[platform] = {
          platform,
          availability: "unknown"
        };
      }
    }

    const nextTurn: ChatTurn = {
      id: randomUUID(),
      index: turns.length + 1,
      prompt: message,
      rules: rawRules,
      participants: uniqueParticipants,
      responseMode,
      interactionMode,
      totalRounds,
      focus,
      currentRound: 1,
      currentStage: "initial_response",
      status: "running",
      ...(attachments.length > 0 ? { attachments } : {}),
      createdAt: now
    };

    turns.push(nextTurn);

    session.participants = uniqueParticipants;
    session.totalRounds = totalRounds;
    session.currentRound = 1;
    session.currentStage = "initial_response";
    session.status = "running";
    session.focus = focus;
    session.responseMode = responseMode;
    session.interactionMode = interactionMode;
    session.engineVersion = ENGINE_VERSION;
    session.updatedAt = now;
    delete session.pauseInfo;

    const nextTasks = createTasksForStage(
      session,
      nextTurn,
      1,
      "initial_response"
    );
    session.tasks.push(...nextTasks);

    await writeDebateSessionAtomically(session);
    emitDebateUpdated(session);
    return session;
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
    const session = await readDebateSessionById(debateId);

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
      (task.seat === "manual" &&
        echoProbe &&
        echoProbe.length > 40 &&
        content.includes(echoProbe))
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
      ...(task.turnId ? { turnId: task.turnId } : {}),
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

    const activeTurn = task.turnId
      ? session.turns?.find((t) => t.id === task.turnId)
      : session.turns?.at(-1);

    const pendingInCurrentStage = session.tasks.some(
      (t) =>
        (!task.turnId || t.turnId === task.turnId) &&
        t.round === session.currentRound &&
        t.stage === session.currentStage &&
        t.status === "pending"
    );

    if (!pendingInCurrentStage) {
      const activeInteractionMode =
        activeTurn?.interactionMode ?? session.interactionMode ?? "debate";

      if (task.singleTaskOnly) {
        session.currentStage = "completed";
        session.status = "completed";
        session.completedAt = now;
        delete session.pauseInfo;

        if (task.stage === "synthesis") {
          if (activeTurn) {
            activeTurn.conclusion = content;
          }
          if (!session.turns || activeTurn === session.turns.at(-1)) {
            session.conclusion = content;
          }
        }

        if (activeTurn) {
          activeTurn.currentStage = "completed";
          activeTurn.status = "completed";
          activeTurn.completedAt = now;
        }
      } else if (activeInteractionMode === "direct") {
        session.currentStage = "completed";
        session.status = "completed";
        session.completedAt = now;
        delete session.pauseInfo;

        if (activeTurn) {
          activeTurn.currentStage = "completed";
          activeTurn.status = "completed";
          activeTurn.completedAt = now;
        }
      } else if (session.currentStage === "synthesis") {
        session.currentStage = "completed";
        session.status = "completed";
        session.conclusion = content;
        session.completedAt = now;
        delete session.pauseInfo;

        if (activeTurn) {
          activeTurn.currentStage = "completed";
          activeTurn.status = "completed";
          activeTurn.conclusion = content;
          activeTurn.completedAt = now;
        }
      } else if (session.currentRound < session.totalRounds) {
        session.currentRound += 1;
        session.currentStage = "critique";
        const turnForStage = activeTurn ?? ensureSessionTurns(session).at(-1)!;
        turnForStage.currentRound = session.currentRound;
        turnForStage.currentStage = "critique";
        session.tasks.push(
          ...createTasksForStage(
            session,
            turnForStage,
            session.currentRound,
            "critique"
          )
        );
      } else {
        session.currentStage = "synthesis";
        const turnForStage = activeTurn ?? ensureSessionTurns(session).at(-1)!;
        turnForStage.currentStage = "synthesis";
        session.tasks.push(
          ...createTasksForStage(
            session,
            turnForStage,
            session.currentRound,
            "synthesis"
          )
        );
      }
    }

    await writeDebateSessionAtomically(session);
    emitDebateUpdated(session);
    return session;
  });
}

// ============================================
// REGENERAR 1 IA E REVISÃO CRUZADA PONTUAL
// ============================================

export async function regenerateDebateResponse(
  debateId: string,
  responseId: string
): Promise<DebateSession> {
  const now = new Date().toISOString();

  return withDebateLock(async () => {
    const session = await readDebateSessionById(debateId);
    if (!session) {
      throw new Error("Conversa não encontrada.");
    }

    if (session.status === "running") {
      throw new Error("Aguarde a resposta atual terminar ou pause antes de regenerar.");
    }

    const turns = ensureSessionTurns(session);
    const respIdx = session.responses.findIndex((r) => r.id === responseId);
    if (respIdx < 0) {
      throw new Error("Resposta não encontrada.");
    }

    const targetResp = session.responses[respIdx]!;
    const turn =
      turns.find((t) => t.id === targetResp.turnId) ?? turns[0];

    if (!turn) {
      throw new Error("Turno da resposta não encontrado.");
    }

    await pauseOtherRunningSessions(
      session.id,
      "Pausado automaticamente ao regenerar resposta em outra conversa.",
      now
    );

    // Remove a resposta antiga e a tarefa antiga para substituir no mesmo lugar
    session.responses.splice(respIdx, 1);
    session.tasks = session.tasks.filter((t) => t.id !== targetResp.taskId);

    if (targetResp.stage === "synthesis") {
      delete turn.conclusion;
      if (turn === turns.at(-1)) {
        delete session.conclusion;
      }
    }

    const newTask = buildTask(
      session,
      turn,
      targetResp.round,
      targetResp.stage,
      targetResp.platform
    );
    newTask.singleTaskOnly = true;

    session.tasks.push(newTask);
    session.currentRound = targetResp.round;
    session.currentStage = targetResp.stage;
    session.status = "running";
    session.engineVersion = ENGINE_VERSION;
    session.updatedAt = now;
    delete session.pauseInfo;

    turn.currentRound = targetResp.round;
    turn.currentStage = targetResp.stage;
    turn.status = "running";

    await writeDebateSessionAtomically(session);
    emitDebateUpdated(session);
    return session;
  });
}

export async function reviewDebateResponseWithPlatform(
  debateId: string,
  responseId: string,
  reviewerPlatform: AIPlatform
): Promise<DebateSession> {
  const now = new Date().toISOString();

  return withDebateLock(async () => {
    const session = await readDebateSessionById(debateId);
    if (!session) {
      throw new Error("Conversa não encontrada.");
    }

    if (session.status === "running") {
      throw new Error("Aguarde a resposta atual terminar ou pause antes de pedir revisão.");
    }

    const turns = ensureSessionTurns(session);
    const targetResp = session.responses.find((r) => r.id === responseId);
    if (!targetResp) {
      throw new Error("Resposta não encontrada.");
    }

    const originTurn =
      turns.find((t) => t.id === targetResp.turnId) ?? turns[0];
    const responseMode: ResponseMode =
      originTurn?.responseMode ?? session.responseMode ?? "normal";
    const focus: DebateFocus = originTurn?.focus ?? session.focus ?? "geral";

    await pauseOtherRunningSessions(
      session.id,
      "Pausado automaticamente ao iniciar revisão em outra conversa.",
      now
    );

    if (!session.participantStates[reviewerPlatform]) {
      session.participantStates[reviewerPlatform] = {
        platform: reviewerPlatform,
        availability: "unknown"
      };
    }

    const authorName = PLATFORM_NAMES[targetResp.platform] ?? targetResp.platform;
    const reviewerName = PLATFORM_NAMES[reviewerPlatform] ?? reviewerPlatform;

    const reviewTurn: ChatTurn = {
      id: randomUUID(),
      index: turns.length + 1,
      prompt: `Revisão por ${reviewerName} sobre a resposta de ${authorName}`,
      rules: "",
      participants: [reviewerPlatform],
      responseMode,
      interactionMode: "direct",
      totalRounds: 1,
      focus,
      currentRound: 1,
      currentStage: "initial_response",
      status: "running",
      createdAt: now
    };

    turns.push(reviewTurn);

    const budget = budgetForPlatform(reviewerPlatform);
    const systemPrompt = systemPromptFor(responseMode, "direct");
    const history = buildConversationHistoryBlock(
      session,
      reviewTurn.id,
      reviewerPlatform
    );
    const compactedOriginal = compactForPrompt(
      targetResp.content,
      budget.critiquePeerChars
    );
    const originQuestion = originTurn?.prompt || session.topic;

    const instruction =
      responseMode === "normal"
        ? `Revise a resposta acima de ${authorName}. Aponte apenas erros reais ou pontos importantes que faltaram e entregue a versão corrigida de forma natural, clara e direta.`
        : `Revise tecnicamente a resposta acima de ${authorName}. Aponte apenas bugs ou falhas reais (se houver) e entregue a versão corrigida completa em Markdown.`;

    const userParts: string[] = [];
    if (history) {
      userParts.push(history, "");
    }
    userParts.push(
      `Pergunta original:\n${compactForPrompt(originQuestion, budget.turnUserChars)}`,
      "",
      `Resposta de ${authorName} para revisar:\n${compactedOriginal}`,
      "",
      instruction
    );
    const userPrompt = userParts.join("\n");

    const reviewTask: DebateTask = {
      id: randomUUID(),
      turnId: reviewTurn.id,
      round: 1,
      stage: "initial_response",
      platform: reviewerPlatform,
      status: "pending",
      createdAt: now,
      seat: isAutoPlatform(reviewerPlatform) ? "auto" : "manual",
      role: `Revisão (${authorName})`,
      systemPrompt,
      userPrompt,
      maxTokens: budget.maxTokens.initial_response,
      prompt: combinePrompt(systemPrompt, userPrompt),
      singleTaskOnly: true
    };

    session.tasks.push(reviewTask);
    session.participants = [reviewerPlatform];
    session.totalRounds = 1;
    session.currentRound = 1;
    session.currentStage = "initial_response";
    session.status = "running";
    session.focus = focus;
    session.responseMode = responseMode;
    session.interactionMode = "direct";
    session.engineVersion = ENGINE_VERSION;
    session.updatedAt = now;
    delete session.pauseInfo;

    await writeDebateSessionAtomically(session);
    emitDebateUpdated(session);
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
    const session = await readDebateSessionById(debateId);
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
        message: `Pausado: ${PLATFORM_NAMES[task.platform]} falhou (${task.lastError}). Clique em Retomar.`,
        pausedAt: now
      };
      syncActiveTurnStatus(session);
    }

    await writeDebateSessionAtomically(session);
    emitDebateUpdated(session);
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
    const session = await readDebateSessionById(debateId);

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
        "Pausado manualmente. Progresso salvo.",
      pausedAt: now
    };
    session.updatedAt = now;
    syncActiveTurnStatus(session);

    await writeDebateSessionAtomically(session);
    emitDebateUpdated(session);
    return session;
  });
}

export async function resumeDebateSession(
  debateId: string
): Promise<DebateSession> {
  return withDebateLock(async () => {
    const session = await readDebateSessionById(debateId);

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
    syncActiveTurnStatus(session);

    await writeDebateSessionAtomically(session);
    emitDebateUpdated(session);
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
    const summaries = await readDebateSummaries();
    const candidates = summaries.filter(
      (s) => s.status !== "completed" && s.participants.includes(platform)
    );
    const pausedDebateIds: string[] = [];

    for (const summary of candidates) {
      const session = await readDebateSessionById(summary.id);
      if (!session || session.status === "completed") {
        continue;
      }

      session.participantStates[platform] = {
        platform,
        availability: severity,
        lastSignalAt: observedAt,
        lastLimitMessage: matchedText
      };
      session.updatedAt = observedAt;

      if (severity === "blocked" && session.status === "running") {
        session.status = "paused_limit";
        session.pauseInfo = {
          reason: "usage_limit_reached",
          blockedBy: platform,
          message: `Pausado: ${PLATFORM_NAMES[platform]} atingiu o limite gratuito ("${matchedText}").`,
          pausedAt: observedAt
        };
        syncActiveTurnStatus(session);
        pausedDebateIds.push(session.id);
      }

      await writeDebateSessionAtomically(session);
      emitDebateUpdated(session);
    }

    return { pausedDebateIds };
  });
}
