import { getProvidersStatus, type ProviderStatus } from "../providers/registry.js";
import {
  AUTO_PLATFORMS,
  type AutoPlatform,
  type AutoRouteDecision,
  type ChatAttachment,
  type InteractionMode,
  type ResolvedProjectContext,
  type ResponseMode,
  type WebSource
} from "../shared/debate-types.js";

const QUOTA_HEALTHY_MIN_RATIO = 0.1; // Pula provedores com menos de 10% de cota restante

const COMPLEX_COUNCIL_REGEX =
  /\b(compar[ae]|versus|vs\.?|pr[oó]s e contras|trade-?offs?|qual (escolher|melhor|usar|vale mais)|arquitetura|micros?servi[cç]os|monolito|refator[ae]|auditoria|vulnerabilidad|seguran[cç]a|design system|analise critic|avalia[cç][aã]o|estrat[eé]gia|decis[aã]o|otimiz[ae]|performance|concorr[eê]ncia|implemente um|sistema completo)\b/i;

export interface AutoRouteInput {
  prompt: string;
  responseMode: ResponseMode;
  interactionMode: InteractionMode;
  attachments?: ChatAttachment[];
  webSources?: WebSource[];
  resolvedProjectContext?: ResolvedProjectContext | null;
}

interface QuotaHealth {
  platform: AutoPlatform;
  ready: boolean;
  healthy: boolean;
  usable: boolean;
  remainingRatio: number;
}

function computeQuotaHealth(status: ProviderStatus): QuotaHealth {
  if (!status.ready) {
    return {
      platform: status.id,
      ready: false,
      healthy: false,
      usable: false,
      remainingRatio: 0
    };
  }

  const usage = status.usage;
  if (!usage) {
    return {
      platform: status.id,
      ready: true,
      healthy: true,
      usable: true,
      remainingRatio: 1
    };
  }

  const reqRatio =
    usage.requestsDailyCap > 0
      ? Math.max(0, (usage.requestsDailyCap - usage.requestsToday) / usage.requestsDailyCap)
      : 1;

  const tokRatio =
    usage.tokensDailyCap && usage.tokensDailyCap > 0
      ? Math.max(0, (usage.tokensDailyCap - usage.tokensToday) / usage.tokensDailyCap)
      : 1;

  const remainingRatio = Math.min(reqRatio, tokRatio);
  const usable = remainingRatio > 0;
  const healthy = remainingRatio >= QUOTA_HEALTHY_MIN_RATIO;

  return {
    platform: status.id,
    ready: true,
    healthy,
    usable,
    remainingRatio
  };
}

function pickFromPriority(
  preferred: AutoPlatform[],
  healthMap: Map<AutoPlatform, QuotaHealth>,
  minCount: number,
  maxCount: number
): { chosen: AutoPlatform[]; skippedForQuota: AutoPlatform[] } {
  const chosen: AutoPlatform[] = [];
  const skippedForQuota: AutoPlatform[] = [];

  const addIfHealthy = (p: AutoPlatform) => {
    if (chosen.length >= maxCount || chosen.includes(p)) return;
    const h = healthMap.get(p);
    if (h?.healthy) {
      chosen.push(p);
    } else if (h?.ready && !skippedForQuota.includes(p)) {
      skippedForQuota.push(p);
    }
  };

  for (const p of preferred) addIfHealthy(p);

  // Completa até minCount usando outros provedores saudáveis com maior cota livre
  if (chosen.length < minCount) {
    const healthyFallback = AUTO_PLATFORMS.filter(
      (p) => !chosen.includes(p) && healthMap.get(p)?.healthy
    ).sort(
      (a, b) =>
        (healthMap.get(b)?.remainingRatio ?? 0) -
        (healthMap.get(a)?.remainingRatio ?? 0)
    );
    for (const p of healthyFallback) {
      if (chosen.length >= minCount) break;
      chosen.push(p);
    }
  }

  // Fallback extremo: se todos estão < 10%, usa qualquer provedor ainda usable (> 0%)
  if (chosen.length < minCount) {
    const usableFallback = [...preferred, ...AUTO_PLATFORMS].filter(
      (p, idx, arr) =>
        arr.indexOf(p) === idx && !chosen.includes(p) && healthMap.get(p)?.usable
    );
    for (const p of usableFallback) {
      if (chosen.length >= minCount) break;
      chosen.push(p);
    }
  }

  // Último recurso (nenhuma chave ou todas 100% esgotadas): devolve os primeiros preferidos
  if (chosen.length === 0) {
    chosen.push(...preferred.slice(0, Math.max(1, minCount)));
  }

  return { chosen, skippedForQuota };
}

/**
 * Roteador local em 0ms (custo zero de API):
 * decide participantes com base em anexos, tamanho/complexidade, dinâmica e cota do UsageGate.
 */
export function resolveAutoRoute(
  input: AutoRouteInput,
  providerStatuses: ProviderStatus[]
): AutoRouteDecision {
  const healthMap = new Map<AutoPlatform, QuotaHealth>();
  for (const st of providerStatuses) {
    healthMap.set(st.id, computeQuotaHealth(st));
  }
  for (const p of AUTO_PLATFORMS) {
    if (!healthMap.has(p)) {
      healthMap.set(p, {
        platform: p,
        ready: true,
        healthy: true,
        usable: true,
        remainingRatio: 1
      });
    }
  }

  const prompt = (input.prompt ?? "").trim();
  const attachments = input.attachments ?? [];
  const hasPdf = attachments.some((a) => a.kind === "pdf");
  const hasImage = attachments.some((a) => a.kind === "image");
  const attachedTextChars = attachments
    .filter((a) => a.kind !== "pdf" && a.kind !== "image")
    .reduce((sum, a) => sum + (a.content?.length ?? 0), 0);
  const projectChars =
    (input.resolvedProjectContext?.instructions.length ?? 0) +
    (input.resolvedProjectContext?.chunks.reduce(
      (sum, c) => sum + c.content.length,
      0
    ) ?? 0);
  const hasCodeFence = prompt.includes("```");

  // 1. Modo Debate: respeita a dinâmica e exige 2 a 3 IAs saudáveis
  if (input.interactionMode === "debate") {
    const { chosen, skippedForQuota } = pickFromPriority(
      ["gemini", "groq", "openrouter"],
      healthMap,
      2,
      3
    );
    const reason =
      skippedForQuota.length > 0
        ? "debate (cota preservada)"
        : "debate multi-IA";
    return {
      participants: chosen,
      reason,
      category: "debate",
      ...(skippedForQuota.length > 0 ? { skippedForQuota } : {})
    };
  }

  // 2. PDF anexado -> Gemini por padrão (tabelas/gráficos/scans),
  //    mas aciona o Trio se o prompt pedir análise crítica/comparação/auditoria e houver texto extraível
  if (hasPdf) {
    const hasExtractablePdfText = attachments.some(
      (a) => a.kind === "pdf" && typeof a.content === "string" && a.content.trim().length > 0
    );
    const wantsCriticalCouncil =
      COMPLEX_COUNCIL_REGEX.test(prompt) || hasCodeFence;

    if (hasExtractablePdfText && wantsCriticalCouncil) {
      const { chosen, skippedForQuota } = pickFromPriority(
        ["gemini", "groq", "openrouter"],
        healthMap,
        2,
        3
      );
      return {
        participants: chosen,
        reason:
          skippedForQuota.length > 0
            ? "PDF · análise crítica (cota preservada)"
            : "PDF · análise crítica",
        category: "complex_council",
        ...(skippedForQuota.length > 0 ? { skippedForQuota } : {})
      };
    }

    const { chosen, skippedForQuota } = pickFromPriority(
      ["gemini", "openrouter", "groq"],
      healthMap,
      1,
      1
    );
    const fellBack = chosen[0] !== "gemini";
    return {
      participants: chosen,
      reason: fellBack ? "PDF (Gemini sem cota)" : "PDF anexado",
      category: fellBack ? "quota_fallback" : "pdf",
      ...(skippedForQuota.length > 0 ? { skippedForQuota } : {})
    };
  }

  // 3. Imagem anexada -> Gemini + OpenRouter (suporte multimodal)
  if (hasImage) {
    const { chosen, skippedForQuota } = pickFromPriority(
      ["gemini", "openrouter"],
      healthMap,
      1,
      2
    );
    return {
      participants: chosen,
      reason:
        skippedForQuota.length > 0
          ? "imagem (cota preservada)"
          : "imagem anexada",
      category: "image",
      ...(skippedForQuota.length > 0 ? { skippedForQuota } : {})
    };
  }

  // 4. Análise comparativa, arquitetura, código complexo ou decisão -> Trio saudável
  const isComplexCouncil =
    COMPLEX_COUNCIL_REGEX.test(prompt) ||
    hasCodeFence ||
    (input.responseMode === "prompt_markdown" && prompt.length >= 160);

  if (isComplexCouncil) {
    const { chosen, skippedForQuota } = pickFromPriority(
      ["gemini", "groq", "openrouter"],
      healthMap,
      2,
      3
    );
    return {
      participants: chosen,
      reason:
        skippedForQuota.length > 0
          ? "análise técnica (cota preservada)"
          : "análise técnica / comparativa",
      category: "complex_council",
      ...(skippedForQuota.length > 0 ? { skippedForQuota } : {})
    };
  }

  // 5. Contexto extenso (prompt longo, arquivo grande ou projeto com bastante conteúdo) -> Gemini
  const isLongContext =
    prompt.length >= 650 ||
    attachedTextChars >= 3_500 ||
    projectChars >= 3_500 ||
    (input.webSources?.length ?? 0) >= 3;

  if (isLongContext) {
    const { chosen, skippedForQuota } = pickFromPriority(
      ["gemini", "openrouter", "groq"],
      healthMap,
      1,
      1
    );
    const fellBack = chosen[0] !== "gemini";
    return {
      participants: chosen,
      reason: fellBack ? "contexto longo (fallback de cota)" : "contexto extenso",
      category: fellBack ? "quota_fallback" : "long_context",
      ...(skippedForQuota.length > 0 ? { skippedForQuota } : {})
    };
  }

  // 6. Padrão: pergunta direta / rápida -> Groq (ultrarrápido e 1.000 RPD)
  const { chosen, skippedForQuota } = pickFromPriority(
    ["groq", "gemini", "openrouter"],
    healthMap,
    1,
    1
  );
  const fellBack = chosen[0] !== "groq";
  return {
    participants: chosen,
    reason: fellBack ? "pergunta direta (cota preservada)" : "pergunta direta",
    category: fellBack ? "quota_fallback" : "quick",
    ...(skippedForQuota.length > 0 ? { skippedForQuota } : {})
  };
}

export async function routeAutoParticipants(
  input: AutoRouteInput
): Promise<AutoRouteDecision> {
  const statuses = await getProvidersStatus();
  return resolveAutoRoute(input, statuses);
}
