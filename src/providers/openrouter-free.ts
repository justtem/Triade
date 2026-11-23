import type { ProviderError, ProviderErrorKind } from "./types.js";

const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 horas
const FETCH_TIMEOUT_MS = 8_000;
const MAX_DISCOVERED_FREE_MODELS = 12;
const SAFE_MODEL_ID_REGEX = /^[a-zA-Z0-9._:/-]{3,120}$/;
const EXCLUDED_MODEL_REGEX =
  /(?:^|\/)(?:openrouter\/auto)|(?:embed|embedding|moderation|guard|rerank|whisper|tts|audio|speech|ocr|diffusion|flux|dall-e|image-gen)/i;

const COOLDOWN_MODEL_MS = 30 * 60 * 1000; // 30 min para 404 / modelo inválido
const COOLDOWN_RATE_LIMIT_MIN_MS = 2 * 60 * 1000; // mínimo 2 min para 429
const COOLDOWN_RATE_LIMIT_MAX_MS = 10 * 60 * 1000; // máximo 10 min para 429
const COOLDOWN_TRANSIENT_MS = 90 * 1000; // 90s para 5xx / timeout / vazio

export interface OpenRouterCatalogEntry {
  id: string;
  name?: string;
  contextLength: number;
  supportsVision: boolean;
  score: number;
}

export interface OpenRouterCooldownEntry {
  model: string;
  reason: ProviderErrorKind;
  untilMs: number;
}

export interface OpenRouterFreeDiscoverySnapshot {
  enabled: boolean;
  source: "live" | "cache" | "fallback";
  lastFetchedAt: string | null;
  lastError: string | null;
  discoveredCount: number;
  preferredCount: number;
  activeModels: string[];
  cooledDown: Array<{
    model: string;
    reason: ProviderErrorKind;
    until: string;
  }>;
}

export type FetchLike = (
  url: string,
  init?: RequestInit
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

interface DiscoveryState {
  discovered: OpenRouterCatalogEntry[];
  discoveredIdSet: Set<string>;
  lastFetchedAtMs: number | null;
  source: "live" | "cache" | "fallback";
  lastError: string | null;
  inFlight: Promise<OpenRouterCatalogEntry[]> | null;
  cooldowns: Map<string, OpenRouterCooldownEntry>;
  lastWorkingModel: string | null;
}

const state: DiscoveryState = {
  discovered: [],
  discoveredIdSet: new Set<string>(),
  lastFetchedAtMs: null,
  source: "fallback",
  lastError: null,
  inFlight: null,
  cooldowns: new Map<string, OpenRouterCooldownEntry>(),
  lastWorkingModel: null
};

function isZeroPrice(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return true;
  if (typeof value === "number") return value === 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return true;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed === 0;
  }
  return false;
}

function isExplicitlyZeroPrice(value: unknown): boolean {
  if (typeof value === "number") return value === 0;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return false;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) && parsed === 0;
  }
  return false;
}

/**
 * Trava rigorosa de custo zero: exige ID terminando em ":free",
 * formato seguro e precificação explicitamente zerada para prompt e completion.
 */
export function isStrictlyFreeOpenRouterEntry(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id.trim() : "";

  if (!id || !id.endsWith(":free") || !SAFE_MODEL_ID_REGEX.test(id)) {
    return false;
  }
  if (EXCLUDED_MODEL_REGEX.test(id)) {
    return false;
  }

  const pricing =
    item.pricing && typeof item.pricing === "object"
      ? (item.pricing as Record<string, unknown>)
      : null;

  if (!pricing) return false;

  if (
    !isExplicitlyZeroPrice(pricing.prompt) ||
    !isExplicitlyZeroPrice(pricing.completion)
  ) {
    return false;
  }

  if (
    !isZeroPrice(pricing.request) ||
    !isZeroPrice(pricing.image) ||
    !isZeroPrice(pricing.web_search) ||
    !isZeroPrice(pricing.internal_reasoning)
  ) {
    return false;
  }

  return true;
}

function scoreFreeModel(id: string, contextLength: number, supportsVision: boolean): number {
  const lower = id.toLowerCase();
  let score = 0;

  // Janela de contexto (até +40 pts)
  if (contextLength >= 128_000) score += 40;
  else if (contextLength >= 64_000) score += 32;
  else if (contextLength >= 32_000) score += 24;
  else if (contextLength >= 16_000) score += 14;
  else if (contextLength >= 8_000) score += 6;

  // Famílias fortes para raciocínio, chat geral e código
  if (/deepseek.*(?:r1|v3|chat)/.test(lower)) score += 34;
  else if (/qwen.*(?:3|2\.5).*(?:72b|32b|coder|235b|480b)/.test(lower)) score += 32;
  else if (/llama-?(?:4|3\.3|3\.1).*(?:70b|405b|maverick|scout)/.test(lower)) score += 30;
  else if (/nemotron.*(?:ultra|super|253b|550b|70b|49b)/.test(lower)) score += 30;
  else if (/gemma-?(?:4|3).*(?:27b|31b)/.test(lower)) score += 28;
  else if (/gpt-oss-?120b/.test(lower)) score += 28;
  else if (/mistral.*(?:large|small|devstral|codestral)/.test(lower)) score += 24;
  else if (/glm-?(?:4|5)|kimi|command|north|phi-4|hermes/.test(lower)) score += 22;

  // Penaliza modelos ultra-pesados de raciocínio (550B/1T) para não duplicar latência com NVIDIA NIM
  if (/(?:550b|\b1t\b|-1t-|nemotron-3.*ultra)/.test(lower)) score -= 8;

  // Bônus leve para modelos flagship / grandes e multimodais
  if (/(?:70b|72b|120b|235b|253b|405b|550b|671b|deepseek-r1|deepseek-v3|deepseek-chat|kimi-k2)/i.test(lower)) score += 10;
  else if (/(?:27b|31b|32b|49b)/i.test(lower)) score += 6;
  else if (/(?:1b|2b|3b|4b)\b/i.test(lower)) score -= 12;

  if (supportsVision) score += 5;

  return score;
}

export function parseFreeOpenRouterCatalog(payload: unknown): OpenRouterCatalogEntry[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const seen = new Set<string>();
  const entries: OpenRouterCatalogEntry[] = [];

  for (const raw of data) {
    if (!isStrictlyFreeOpenRouterEntry(raw)) continue;
    const item = raw as Record<string, unknown>;
    const id = String(item.id).trim();
    if (seen.has(id)) continue;
    seen.add(id);

    const contextLength =
      typeof item.context_length === "number" && Number.isFinite(item.context_length)
        ? Math.max(0, Math.floor(item.context_length))
        : 0;

    const arch =
      item.architecture && typeof item.architecture === "object"
        ? (item.architecture as Record<string, unknown>)
        : null;
    const inputModalities = Array.isArray(arch?.input_modalities)
      ? arch.input_modalities.map((m) => String(m).toLowerCase())
      : [];
    const modalityStr = typeof arch?.modality === "string" ? arch.modality.toLowerCase() : "";
    const supportsVision =
      inputModalities.includes("image") || modalityStr.includes("image");

    const name = typeof item.name === "string" ? item.name.trim().slice(0, 120) : undefined;
    const score = scoreFreeModel(id, contextLength, supportsVision);

    entries.push({ id, name, contextLength, supportsVision, score });
  }

  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.contextLength !== a.contextLength) return b.contextLength - a.contextLength;
    return a.id.localeCompare(b.id);
  });

  return entries.slice(0, MAX_DISCOVERED_FREE_MODELS);
}

function normalizeModelsEndpoint(baseURL?: string): string {
  const clean = (baseURL?.trim() || DEFAULT_OPENROUTER_BASE_URL).replace(/\/+$/, "");
  return `${clean}/models`;
}

function purgeExpiredCooldowns(nowMs: number): void {
  for (const [model, entry] of state.cooldowns.entries()) {
    if (entry.untilMs <= nowMs) {
      state.cooldowns.delete(model);
    }
  }
}

export function recordOpenRouterModelFailure(
  model: string,
  error: Pick<ProviderError, "kind" | "retryAfterMs">,
  nowMs = Date.now()
): void {
  if (!model || !model.endsWith(":free")) return;
  if (
    error.kind === "auth" ||
    error.kind === "quota_exhausted" ||
    error.kind === "aborted"
  ) {
    return;
  }

  let durationMs = COOLDOWN_TRANSIENT_MS;
  if (error.kind === "model") {
    durationMs = COOLDOWN_MODEL_MS;
  } else if (error.kind === "rate_limit") {
    const requested =
      typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs)
        ? error.retryAfterMs
        : COOLDOWN_RATE_LIMIT_MIN_MS;
    durationMs = Math.min(
      COOLDOWN_RATE_LIMIT_MAX_MS,
      Math.max(COOLDOWN_RATE_LIMIT_MIN_MS, requested)
    );
  }

  state.cooldowns.set(model, {
    model,
    reason: error.kind,
    untilMs: nowMs + durationMs
  });
}

export function recordOpenRouterModelSuccess(model: string): void {
  if (!model) return;
  state.cooldowns.delete(model);
  state.lastWorkingModel = model;
}

/**
 * Consulta GET /api/v1/models do OpenRouter (catálogo público, 0 tokens, custo zero)
 * com cache de 6 horas e dedup de chamadas simultâneas.
 */
export async function refreshOpenRouterFreeCatalog(options: {
  baseURL?: string;
  force?: boolean;
  nowMs?: number;
  fetchFn?: FetchLike;
} = {}): Promise<OpenRouterCatalogEntry[]> {
  const nowMs = options.nowMs ?? Date.now();
  const isFresh =
    state.lastFetchedAtMs !== null &&
    nowMs - state.lastFetchedAtMs < CACHE_TTL_MS &&
    state.discovered.length > 0;

  if (!options.force && isFresh) {
    state.source = "cache";
    return state.discovered;
  }

  if (state.inFlight && !options.force) {
    return state.inFlight;
  }

  const endpoint = normalizeModelsEndpoint(options.baseURL);
  const fetcher: FetchLike =
    options.fetchFn ??
    ((url, init) => fetch(url, init));

  let task: Promise<OpenRouterCatalogEntry[]> | null = null;
  task = (async () => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const res = await fetcher(endpoint, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "X-Title": "AI Council"
        },
        signal: controller.signal
      });

      if (!res.ok) {
        throw new Error(`OpenRouter /models respondeu HTTP ${res.status}`);
      }

      const json = await res.json();
      const parsed = parseFreeOpenRouterCatalog(json);

      if (parsed.length === 0) {
        throw new Error("Nenhum modelo :free válido encontrado no catálogo.");
      }

      state.discovered = parsed;
      state.discoveredIdSet = new Set(parsed.map((item) => item.id));
      state.lastFetchedAtMs = options.nowMs ?? Date.now();
      state.source = "live";
      state.lastError = null;
      return parsed;
    } catch (error) {
      const msg =
        error instanceof Error ? error.message : "Falha ao consultar catálogo OpenRouter.";
      state.lastError = msg.slice(0, 180);
      if (state.discovered.length === 0) {
        state.source = "fallback";
      } else {
        state.source = "cache";
      }
      return state.discovered;
    } finally {
      clearTimeout(timer);
      if (state.inFlight === task) {
        state.inFlight = null;
      }
    }
  })();

  state.inFlight = task;
  return task;
}

/**
 * Monta a fila híbrida inteligente de modelos :free:
 * 1. Modelos configurados no .env que continuam ativos no catálogo (ou todos se catálogo ainda não baixou).
 * 2. Melhores modelos :free descobertos automaticamente no OpenRouter.
 * 3. Modelos configurados que sumiram do catálogo (demovidos para o fim como último recurso).
 * Modelos em cooldown ficam no final da fila para dar vez imediata aos saudáveis.
 */
export function buildHybridFreeModelList(
  preferredModels: readonly string[],
  nowMs = Date.now()
): string[] {
  purgeExpiredCooldowns(nowMs);

  const safePreferred = preferredModels.filter(
    (m) => typeof m === "string" && m.endsWith(":free") && SAFE_MODEL_ID_REGEX.test(m)
  );

  const hasCatalog = state.discovered.length > 0;
  const preferredOnline: string[] = [];
  const preferredMissing: string[] = [];

  for (const model of safePreferred) {
    if (!hasCatalog || state.discoveredIdSet.has(model)) {
      if (!preferredOnline.includes(model)) preferredOnline.push(model);
    } else if (!preferredMissing.includes(model)) {
      preferredMissing.push(model);
    }
  }

  const ordered: string[] = [...preferredOnline];
  for (const entry of state.discovered) {
    if (!ordered.includes(entry.id)) {
      ordered.push(entry.id);
    }
  }
  for (const model of preferredMissing) {
    if (!ordered.includes(model)) {
      ordered.push(model);
    }
  }

  const healthy: string[] = [];
  const cooled: string[] = [];

  for (const model of ordered) {
    const cd = state.cooldowns.get(model);
    if (cd && cd.untilMs > nowMs) {
      cooled.push(model);
    } else {
      healthy.push(model);
    }
  }

  // Se o último modelo que respondeu com sucesso está saudável e pertence aos descobertos,
  // mantém prioridade dos preferidos online sem perder estabilidade.
  const combined = [...healthy, ...cooled];
  return combined.filter((m) => m.endsWith(":free"));
}

export async function resolveOpenRouterFreeModels(
  preferredModels: readonly string[],
  options: {
    baseURL?: string;
    skipNetwork?: boolean;
    nowMs?: number;
    fetchFn?: FetchLike;
  } = {}
): Promise<string[]> {
  const nowMs = options.nowMs ?? Date.now();
  const shouldFetch =
    !options.skipNetwork &&
    (state.lastFetchedAtMs === null || nowMs - state.lastFetchedAtMs >= CACHE_TTL_MS);

  if (shouldFetch) {
    await refreshOpenRouterFreeCatalog({
      baseURL: options.baseURL,
      nowMs,
      fetchFn: options.fetchFn
    });
  }

  return buildHybridFreeModelList(preferredModels, nowMs);
}

export function getOpenRouterFreeDiscoverySnapshot(
  preferredModels: readonly string[],
  nowMs = Date.now()
): OpenRouterFreeDiscoverySnapshot {
  purgeExpiredCooldowns(nowMs);
  const activeModels = buildHybridFreeModelList(preferredModels, nowMs);

  return {
    enabled: true,
    source: state.source,
    lastFetchedAt:
      state.lastFetchedAtMs !== null
        ? new Date(state.lastFetchedAtMs).toISOString()
        : null,
    lastError: state.lastError,
    discoveredCount: state.discovered.length,
    preferredCount: preferredModels.filter((m) => m.endsWith(":free")).length,
    activeModels,
    cooledDown: Array.from(state.cooldowns.values())
      .filter((entry) => entry.untilMs > nowMs)
      .map((entry) => ({
        model: entry.model,
        reason: entry.reason,
        until: new Date(entry.untilMs).toISOString()
      }))
  };
}

/** Apenas para testes unitários isolados. */
export function resetOpenRouterFreeDiscoveryForTests(): void {
  state.discovered = [];
  state.discoveredIdSet = new Set<string>();
  state.lastFetchedAtMs = null;
  state.source = "fallback";
  state.lastError = null;
  state.inFlight = null;
  state.cooldowns.clear();
  state.lastWorkingModel = null;
}
