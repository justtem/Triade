import {
  AUTO_PLATFORMS,
  type AIPlatform,
  type AutoPlatform,
  type ChatTurn,
  type DebateResponse,
  type DebateSession,
  type TurnVerdict
} from "../shared/debate-types.js";
import { budgetForPlatform } from "../shared/context-budget.js";
import {
  readDebateSessionById,
  withDebateLock,
  writeDebateSessionAtomically
} from "../persistence/debate-store.js";
import {
  getProvider,
  getProvidersStatus,
  initProviders
} from "../providers/registry.js";
import { classifyError } from "../providers/types.js";
import { emitDebateUpdated, emitProvidersUpdated } from "./stream-hub.js";
import { compactForPrompt, PLATFORM_NAMES } from "./debate-engine.js";

const VERDICT_SYSTEM_PROMPT = [
  "Você é um Juiz técnico imparcial comparando respostas de múltiplas IAs sobre o mesmo pedido.",
  "Responda APENAS com um objeto JSON válido (sem texto fora do JSON) seguindo exatamente este formato:",
  "{",
  '  "consensus": ["ponto objetivo 1 onde concordam", "ponto 2"],',
  '  "divergences": ["divergência, risco ou erro que uma IA apontou ou cometeu"],',
  '  "winner": "gemini" | "groq" | "openrouter" | "chatgpt" | "claude" | "tie",',
  '  "winnerReason": "1 a 2 frases diretas explicando por que essa resposta é a melhor",',
  '  "practicalSummary": "Síntese prática em 3 a 5 linhas combinando o melhor de todas as respostas"',
  "}",
  "Regras:",
  "- Seja extremamente objetivo, em português (pt-BR).",
  "- Em consensus: 2 a 4 itens curtos.",
  "- Em divergences: 1 a 4 itens curtos (se não houver divergência relevante, informe isso em 1 item).",
  "- Em winner: use APENAS o ID exato de uma das IAs presentes ou \"tie\" em caso de empate real.",
  "- Seja crítico: aponte alucinações, omissões ou riscos de segurança se alguma IA tiver errado."
].join("\n");

function normalizeWinnerId(
  raw: unknown,
  allowedPlatforms: AIPlatform[]
): AIPlatform | "tie" {
  if (typeof raw !== "string") return allowedPlatforms[0] ?? "tie";
  const clean = raw.toLowerCase().trim();
  if (clean === "tie" || clean === "empate" || clean === "nenhuma") {
    return "tie";
  }

  for (const plat of allowedPlatforms) {
    if (clean === plat || clean.includes(plat)) {
      return plat;
    }
    const label = PLATFORM_NAMES[plat].toLowerCase();
    if (clean.includes(label)) {
      return plat;
    }
  }

  return allowedPlatforms[0] ?? "tie";
}

function toStringList(value: unknown, maxItems = 4): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item ?? "").replace(/\s+/g, " ").trim())
      .filter((s) => s.length > 0)
      .slice(0, maxItems);
  }
  if (typeof value === "string" && value.trim()) {
    return value
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-•*\d.)\s]+/, "").trim())
      .filter((s) => s.length > 0)
      .slice(0, maxItems);
  }
  return [];
}

/** Faz parsing resiliente do JSON retornado pelo Juiz (com fallback caso fuja do JSON). */
export function parseVerdictJson(
  rawText: string,
  allowedPlatforms: AIPlatform[]
): Omit<TurnVerdict, "judgePlatform" | "judgeModel" | "tokens" | "generatedAt"> {
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  const candidates: string[] = [cleaned];
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const consensus = toStringList(parsed.consensus, 4);
        const divergences = toStringList(parsed.divergences, 4);
        const winner = normalizeWinnerId(parsed.winner, allowedPlatforms);
        const winnerReason = String(parsed.winnerReason ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 420);
        const practicalSummary = String(parsed.practicalSummary ?? "")
          .trim()
          .slice(0, 1200);

        if (
          consensus.length > 0 ||
          divergences.length > 0 ||
          practicalSummary.length > 0
        ) {
          return {
            consensus:
              consensus.length > 0
                ? consensus
                : ["As respostas convergem na abordagem principal do problema."],
            divergences:
              divergences.length > 0
                ? divergences
                : ["Sem divergências críticas — diferenças apenas de estilo e detalhamento."],
            winner,
            winnerReason:
              winnerReason ||
              (winner === "tie"
                ? "As respostas tiveram nível equivalente de qualidade."
                : `${PLATFORM_NAMES[winner]} entregou a resposta mais completa e direta.`),
            practicalSummary:
              practicalSummary ||
              winnerReason ||
              "Veja os pontos de consenso e o card destacado abaixo."
          };
        }
      }
    } catch {
      // Tenta próximo candidato
    }
  }

  // Fallback gracioso se o modelo respondeu em texto livre
  const fallbackSummary = cleaned.slice(0, 900) || "Comparação concluída.";
  return {
    consensus: ["Veja a síntese consolidada abaixo com os pontos comuns."],
    divergences: ["Verifique os detalhes individuais nos cards se precisar comparar nuances."],
    winner: "tie",
    winnerReason: "Comparação gerada em formato livre pelo juiz.",
    practicalSummary: fallbackSummary
  };
}

/** Constrói o prompt do Juiz respeitando o orçamento de contexto da IA julgadora. */
export function buildVerdictUserPrompt(
  turnPrompt: string,
  responses: DebateResponse[],
  judgePlatform: AutoPlatform
): string {
  const budget = budgetForPlatform(judgePlatform);
  const totalPeerBudget = budget.synthesisPeerChars;
  const perRespBudget = Math.max(
    600,
    Math.floor(totalPeerBudget / Math.max(1, responses.length))
  );

  const blocks = responses.map((resp) => {
    const label = PLATFORM_NAMES[resp.platform] ?? resp.platform;
    const excerpt = compactForPrompt(resp.content, perRespBudget);
    return `### Resposta de ${label} (id: "${resp.platform}"):\n${excerpt}`;
  });

  const ids = responses.map((r) => `"${r.platform}"`).join(", ");

  return [
    `Pergunta do usuário:`,
    compactForPrompt(turnPrompt, 800),
    "",
    `Compare as ${responses.length} respostas abaixo (IDs válidos para winner: ${ids} ou "tie"):`,
    "",
    blocks.join("\n\n---\n\n"),
    "",
    "Devolva APENAS o objeto JSON solicitado."
  ].join("\n");
}

export const AUTO_VERDICT_MIN_QUOTA_RATIO = 0.15;

/**
 * Verifica se um turno concluído atende todos os requisitos para o Veredito Automático:
 * - Opt-in ativado no turno (autoVerdict === true)
 * - Sessão e turno concluídos (nunca interrompidos/pausados)
 * - Ainda sem veredito gerado
 * - Pelo menos 2 IAs diferentes responderam integralmente (sem interrupção)
 */
export function shouldTriggerAutoVerdict(
  session: DebateSession,
  turn: ChatTurn
): boolean {
  if (session.status !== "completed") return false;
  if (!turn.autoVerdict || turn.status !== "completed" || turn.verdict) {
    return false;
  }
  const responses = getLatestResponsesPerPlatformForTurn(session, turn).filter(
    (r) => !r.interrupted && r.content.trim().length > 0
  );
  return responses.length >= 2;
}

/**
 * Ordena os juízes automáticos por melhor custo-benefício no momento:
 * - Prioriza Gemini / OpenRouter (janela de contexto maior para ler as 3 respostas inteiras),
 *   ponderando pela % de cota diária ainda disponível no UsageGate (requisições e tokens).
 * - Quando minRemainingQuotaRatio é informado (ex.: 0.15 no Veredito Automático),
 *   ignora juízes abaixo dessa margem para preservar a cota gratuita.
 * - Se preferredJudge for informado, coloca-o em 1º lugar.
 */
export async function rankJudgeCandidates(
  preferredJudge?: AutoPlatform,
  options: { minRemainingQuotaRatio?: number } = {}
): Promise<AutoPlatform[]> {
  initProviders();
  const statuses = await getProvidersStatus();
  const minRatio = options.minRemainingQuotaRatio ?? 0;

  const available = statuses.filter(
    (s) => s.ready && Boolean(getProvider(s.id))
  );

  const scored = available
    .map((s) => {
      const cap = Math.max(1, s.usage?.requestsDailyCap ?? 100);
      const used = s.usage?.requestsToday ?? 0;
      const reqRatio = Math.max(0, 1 - used / cap);
      const tokCap = s.usage?.tokensDailyCap;
      const tokUsed = s.usage?.tokensToday ?? 0;
      const tokRatio =
        tokCap && tokCap > 0 ? Math.max(0, 1 - tokUsed / tokCap) : 1;
      const remainingRatio = Math.min(reqRatio, tokRatio);

      // Bônus de contexto para OpenRouter e Gemini (Groq gratuito tem 8k TPM)
      const contextBonus =
        s.id === "openrouter" ? 0.18 : s.id === "gemini" ? 0.14 : 0;
      return {
        id: s.id,
        remainingRatio,
        score: remainingRatio + contextBonus
      };
    })
    .filter((item) => item.remainingRatio >= minRatio);

  scored.sort((a, b) => b.score - a.score);
  const ordered = scored.map((s) => s.id);

  if (preferredJudge && getProvider(preferredJudge)) {
    if (minRatio <= 0 || ordered.includes(preferredJudge)) {
      return [preferredJudge, ...ordered.filter((id) => id !== preferredJudge)];
    }
  }

  if (ordered.length > 0) {
    return ordered;
  }

  return minRatio > 0
    ? []
    : AUTO_PLATFORMS.filter((id) => Boolean(getProvider(id)));
}

function getLatestResponsesPerPlatformForTurn(
  session: DebateSession,
  turn: ChatTurn
): DebateResponse[] {
  const isFirst = turn.index === 1;
  const turnResponses = session.responses.filter(
    (r) =>
      r.stage !== "synthesis" &&
      (r.turnId === turn.id || (isFirst && !r.turnId))
  );

  // Mantém a resposta mais recente de cada IA naquele turno (evita duplicatas de rodadas)
  const latestByPlatform = new Map<AIPlatform, DebateResponse>();
  for (const resp of turnResponses) {
    latestByPlatform.set(resp.platform, resp);
  }

  return Array.from(latestByPlatform.values());
}

function ensureTurnsForVerdict(session: DebateSession): ChatTurn[] {
  if (Array.isArray(session.turns) && session.turns.length > 0) {
    return session.turns;
  }
  const legacyTurn: ChatTurn = {
    id: "legacy_turn_1",
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
  session.turns = [legacyTurn];
  return session.turns;
}

export async function generateTurnVerdict(
  debateId: string,
  options: {
    turnId?: string;
    judge?: AutoPlatform;
    minRemainingQuotaRatio?: number;
  } = {}
): Promise<{ debate: DebateSession; verdict: TurnVerdict }> {
  const initialSession = await readDebateSessionById(debateId);
  if (!initialSession) {
    throw new Error("Conversa não encontrada.");
  }

  const turnsSnapshot = ensureTurnsForVerdict(initialSession);
  const targetTurn =
    (options.turnId
      ? turnsSnapshot.find((t) => t.id === options.turnId)
      : undefined) ?? turnsSnapshot[turnsSnapshot.length - 1];

  if (!targetTurn) {
    throw new Error("Turno não encontrado.");
  }

  const candidateResponses = getLatestResponsesPerPlatformForTurn(
    initialSession,
    targetTurn
  );

  if (candidateResponses.length < 2) {
    throw new Error(
      "O Veredito precisa de pelo menos 2 respostas de IAs diferentes neste turno."
    );
  }

  const judgeOrder = await rankJudgeCandidates(options.judge, {
    ...(options.minRemainingQuotaRatio !== undefined
      ? { minRemainingQuotaRatio: options.minRemainingQuotaRatio }
      : {})
  });
  if (judgeOrder.length === 0) {
    throw new Error(
      options.minRemainingQuotaRatio
        ? "Cota livre insuficiente para Veredito Automático."
        : "Nenhuma IA automática está configurada para gerar o Veredito."
    );
  }

  const allowedPlatforms = candidateResponses.map((r) => r.platform);
  let lastErrorMessage = "Não foi possível gerar o Veredito.";
  let generatedVerdict: TurnVerdict | null = null;

  for (const judgePlatform of judgeOrder) {
    const provider = getProvider(judgePlatform);
    if (!provider) continue;

    const userPrompt = buildVerdictUserPrompt(
      targetTurn.prompt,
      candidateResponses,
      judgePlatform
    );

    try {
      const result = await provider.generate({
        system: VERDICT_SYSTEM_PROMPT,
        user: userPrompt,
        maxTokens: 900
      });

      emitProvidersUpdated();
      const parsed = parseVerdictJson(result.text, allowedPlatforms);
      generatedVerdict = {
        judgePlatform,
        judgeModel: result.model,
        ...parsed,
        ...(result.totalTokens !== undefined ? { tokens: result.totalTokens } : {}),
        generatedAt: new Date().toISOString()
      };
      break;
    } catch (error) {
      emitProvidersUpdated();
      const classified = classifyError(error);
      lastErrorMessage = `${PLATFORM_NAMES[judgePlatform]}: ${classified.message.slice(0, 140)}`;
      // Se o usuário escolheu um juiz específico e ele falhou, ainda tenta fallback automático apenas se não foi escolha explícita
      if (options.judge && judgePlatform === options.judge) {
        throw new Error(
          `${PLATFORM_NAMES[judgePlatform]} não pôde gerar o Veredito agora (${classified.kind}). Tente "Auto" ou outro juiz.`
        );
      }
    }
  }

  if (!generatedVerdict) {
    throw new Error(lastErrorMessage);
  }

  const finalVerdict = generatedVerdict;

  const updatedSession = await withDebateLock(async () => {
    const fresh = await readDebateSessionById(debateId);
    if (!fresh) {
      throw new Error("Conversa não encontrada.");
    }
    const turns = ensureTurnsForVerdict(fresh);
    const turn =
      turns.find((t) => t.id === targetTurn.id) ?? turns[turns.length - 1];
    if (!turn) {
      throw new Error("Turno não encontrado.");
    }

    turn.verdict = finalVerdict;
    fresh.updatedAt = new Date().toISOString();

    await writeDebateSessionAtomically(fresh);
    emitDebateUpdated(fresh);
    return fresh;
  });

  console.log(
    `[AI Council] Veredito gerado por ${PLATFORM_NAMES[finalVerdict.judgePlatform]} -> vencedora: ${finalVerdict.winner}`
  );

  return { debate: updatedSession, verdict: finalVerdict };
}
