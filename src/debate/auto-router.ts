import { getProvidersStatus, type ProviderStatus } from "../providers/registry.js";
import {
  classifyBuilderIntent,
  type BuilderFolderPolicy
} from "../projects/builder-intent.js";
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

  // Se todos os modelos do Piloto Automático deste provedor estiverem em cooldown
  // (ex.: queda global 503 no Google AI Studio), trata como indisponível temporariamente
  // para que outra IA saudável (ex.: NVIDIA NIM) assuma automaticamente.
  const ap = status.autopilot;
  const allModelsCooledDown = Boolean(
    ap &&
      Array.isArray(ap.activeModels) &&
      ap.activeModels.length > 0 &&
      Array.isArray(ap.cooledDown) &&
      ap.cooledDown.length >= ap.activeModels.length
  );

  // OpenRouter gratuito tem teto curto (45 req/dia): preserva acima de 20% quando há folga em outras IAs.
  const minHealthyRatio =
    status.id === "openrouter" && usage.requestsDailyCap <= 60
      ? 0.2
      : QUOTA_HEALTHY_MIN_RATIO;

  const healthy = remainingRatio >= minHealthyRatio && !allModelsCooledDown;

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
      const isOptional = p === "nvidia";
      healthMap.set(p, {
        platform: p,
        ready: !isOptional,
        healthy: !isOptional,
        usable: !isOptional,
        remainingRatio: isOptional ? 0 : 1
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
  //    Se alguma das 3 principais estiver com cota baixa, NVIDIA NIM entra como reserva automática.
  if (input.interactionMode === "debate") {
    const { chosen, skippedForQuota } = pickFromPriority(
      ["gemini", "groq", "openrouter", "nvidia"],
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
      ["gemini", "groq", "openrouter", "nvidia"],
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

  // 5. Contexto extenso (prompt longo, arquivo grande ou projeto volumoso)
  //    Mantém Gemini em #1 quando saudável (>= 20% cota); NVIDIA NIM entra apenas como reserva
  //    de emergência quando Gemini estiver em 503/cooldown ou com cota baixa (< 20%).
  const isLongContext =
    prompt.length >= 650 ||
    attachedTextChars >= 3_500 ||
    projectChars >= 3_500 ||
    (input.webSources?.length ?? 0) >= 3;

  if (isLongContext) {
    const geminiHealth = healthMap.get("gemini");
    const geminiRatio = geminiHealth?.remainingRatio ?? 0;
    const openRouterRatio = healthMap.get("openrouter")?.remainingRatio ?? 0;
    const longPriority: AutoPlatform[] =
      !geminiHealth?.healthy || geminiRatio < 0.2
        ? ["nvidia", "openrouter", "gemini", "groq"]
        : geminiRatio < 0.45 && openRouterRatio >= 0.3
          ? ["openrouter", "gemini", "nvidia", "groq"]
          : ["gemini", "nvidia", "openrouter", "groq"];
    const { chosen, skippedForQuota } = pickFromPriority(
      longPriority,
      healthMap,
      1,
      1
    );
    const fellBack = chosen[0] !== "gemini";
    return {
      participants: chosen,
      reason:
        chosen[0] === "nvidia"
          ? "contexto extenso (NVIDIA NIM · reserva)"
          : fellBack
            ? "contexto longo (cota preservada)"
            : "contexto extenso",
      category:
        fellBack && geminiRatio < QUOTA_HEALTHY_MIN_RATIO
          ? "quota_fallback"
          : "long_context",
      ...(skippedForQuota.length > 0 ? { skippedForQuota } : {})
    };
  }

  // 6. Padrão: pergunta direta / rápida -> Groq (ultrarrápido e 1.000 RPD), Gemini em #2, NVIDIA só reserva
  const { chosen, skippedForQuota } = pickFromPriority(
    ["groq", "gemini", "nvidia", "openrouter"],
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

const FULL_PROJECT_BUILD_RE =
  /\b(projeto\s+completo|app\s+completo|sistema\s+completo|site\s+completo|do\s+zero|from\s+scratch|crie\s+(?:na\s+pasta\s+)?(?:o|um|uma)\s+(?:projeto|app|sistema|site|api|painel|dashboard)|monte\s+(?:o|um|uma)\s+(?:projeto|app|sistema|site|api)|construa\s+(?:o|um|uma)\s+(?:projeto|app|sistema|site|api)|requisitos\s+obrigatorios)\b/i;

export interface AutoComposerStrategyInput {
  prompt: string;
  isContinuation: boolean;
  hasLinkedFolder: boolean;
  isLocalPc: boolean;
  folderPolicy: BuilderFolderPolicy;
  responseMode: ResponseMode;
  attachments?: ChatAttachment[];
  webSources?: WebSource[];
  resolvedProjectContext?: ResolvedProjectContext | null;
}

export interface AutoComposerStrategyResult {
  interactionMode: InteractionMode;
  totalRounds: number;
  autoRoute: AutoRouteDecision;
}

/**
 * Estratégia completa do botão "Auto" na barra do composer (0ms, custo zero):
 * - Pedido de criar app/projeto completo em pasta vinculada → Debate (1 rodada + Síntese única) + Construtor auto;
 * - Edição/correção incremental em projeto existente → 1 IA forte de código (Gemini → OpenRouter) + Construtor auto;
 * - Perguntas gerais / comparações / anexos → delega para resolveAutoRoute (Groq rápido, Gemini longo ou Trio Conselho).
 */
export function resolveAutoComposerStrategy(
  input: AutoComposerStrategyInput,
  providerStatuses: ProviderStatus[]
): AutoComposerStrategyResult {
  const probeIntent = classifyBuilderIntent({
    prompt: input.prompt,
    hasLinkedFolder: input.hasLinkedFolder,
    isLocalPc: input.isLocalPc,
    folderPolicy: input.folderPolicy,
    interactionMode: "debate",
    participantCount: 3
  });

  if (
    probeIntent.level === "write_explicit" &&
    input.hasLinkedFolder &&
    input.isLocalPc &&
    input.folderPolicy !== "readonly"
  ) {
    const normPrompt = input.prompt
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase();
    // Em projeto já existente (isContinuation=true), NUNCA dispara Debate só por texto longo (>=220 chars):
    // mantém edição direta focada nos arquivos reais da pasta (preservando contrato frontend/backend),
    // salvo quando o usuário pedir explicitamente "crie do zero / projeto completo".
    const isMajorBuild =
      !input.isContinuation ||
      FULL_PROJECT_BUILD_RE.test(normPrompt);

    if (isMajorBuild) {
      // Construção completa de app/site na pasta:
      // Gemini volta para #1 (Gemini + Groq + OpenRouter) para código completo sem truncamento;
      // NVIDIA NIM entra automaticamente apenas como reserva de emergência (503 / cota baixa).
      const healthMap = new Map<AutoPlatform, QuotaHealth>();
      for (const st of providerStatuses) {
        healthMap.set(st.id, computeQuotaHealth(st));
      }
      for (const p of AUTO_PLATFORMS) {
        if (!healthMap.has(p)) {
          const isOptional = p === "nvidia";
          healthMap.set(p, {
            platform: p,
            ready: !isOptional,
            healthy: !isOptional,
            usable: !isOptional,
            remainingRatio: isOptional ? 0 : 1
          });
        }
      }
      const buildOrder: AutoPlatform[] = ["gemini", "groq", "openrouter", "nvidia"];
      const { chosen, skippedForQuota } = pickFromPriority(
        buildOrder,
        healthMap,
        2,
        3
      );
      return {
        interactionMode: "debate",
        totalRounds: 1,
        autoRoute: {
          participants: chosen,
          category: "debate",
          reason:
            skippedForQuota.length > 0
              ? "construção completa em Debate (reserva automática ativa)"
              : "construção completa (Debate + Síntese)",
          ...(skippedForQuota.length > 0 ? { skippedForQuota } : {})
        }
      };
    }

    // Edição pontual em conversa contínua: 1 IA forte de código (rápido e direto na pasta)
    const healthMap = new Map<AutoPlatform, QuotaHealth>();
    for (const st of providerStatuses) {
      healthMap.set(st.id, computeQuotaHealth(st));
    }
    for (const p of AUTO_PLATFORMS) {
      if (!healthMap.has(p)) {
        const isOptional = p === "nvidia";
        healthMap.set(p, {
          platform: p,
          ready: !isOptional,
          healthy: !isOptional,
          usable: !isOptional,
          remainingRatio: isOptional ? 0 : 1
        });
      }
    }
    const geminiHealth = healthMap.get("gemini");
    const geminiRatio = geminiHealth?.remainingRatio ?? 0;
    const openRouterRatio = healthMap.get("openrouter")?.remainingRatio ?? 0;
    // Edição rápida na pasta: prioriza Gemini quando saudável (>= 20% cota) pela velocidade e precisão em TS;
    // se Gemini cair em 503/cooldown ou baixar de 20%, NVIDIA NIM e OpenRouter assumem automaticamente.
    const editPriority: AutoPlatform[] =
      !geminiHealth?.healthy || geminiRatio < 0.2
        ? ["nvidia", "openrouter", "gemini", "groq"]
        : geminiRatio < 0.45 && openRouterRatio >= 0.3
          ? ["openrouter", "gemini", "nvidia", "groq"]
          : ["gemini", "nvidia", "openrouter", "groq"];
    const { chosen, skippedForQuota } = pickFromPriority(
      editPriority,
      healthMap,
      1,
      1
    );
    return {
      interactionMode: "direct",
      totalRounds: 1,
      autoRoute: {
        participants: chosen,
        reason:
          chosen[0] === "nvidia"
            ? "edição rápida na pasta (NVIDIA NIM · failover)"
            : skippedForQuota.length > 0
              ? "edição rápida na pasta (cota preservada)"
              : "edição rápida na pasta",
        category: "quick",
        ...(skippedForQuota.length > 0 ? { skippedForQuota } : {})
      }
    };
  }

  const autoRoute = resolveAutoRoute(
    {
      prompt: input.prompt,
      responseMode: input.responseMode,
      interactionMode: "direct",
      attachments: input.attachments,
      webSources: input.webSources,
      resolvedProjectContext: input.resolvedProjectContext
    },
    providerStatuses
  );

  return {
    interactionMode: "direct",
    totalRounds: 1,
    autoRoute
  };
}

export async function routeAutoComposerStrategy(
  input: AutoComposerStrategyInput
): Promise<AutoComposerStrategyResult> {
  const statuses = await getProvidersStatus();
  return resolveAutoComposerStrategy(input, statuses);
}
