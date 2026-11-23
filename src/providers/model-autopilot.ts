import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { writeTextAtomically } from "../shared/atomic-fs.js";
import type { AutoPlatform } from "../shared/debate-types.js";
import type { ProviderError, ProviderErrorKind } from "./types.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const CATALOG_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h (0 reqs de geração)
const CATALOG_TIMEOUT_MS = 8_000;
const SAFE_MODEL_ID_REGEX = /^[a-zA-Z0-9._:/-]{3,120}$/;

// Cooldowns calibrados para piloto automático silencioso
const COOLDOWN_LIMIT_ZERO_MS = 24 * 60 * 60 * 1000; // 24h (modelo sem cota grátis)
const COOLDOWN_MODEL_404_MS = 30 * 60 * 1000; // 30m
const COOLDOWN_EMPTY_MS = 90 * 1000; // 90s
const GEMINI_FLAGSHIP_BACKOFF_MS = [
  60 * 60 * 1000, // 1ª lentidão / 503: 1h
  3 * 60 * 60 * 1000, // 2ª seguida: 3h
  8 * 60 * 60 * 1000 // 3ª+ seguida: 8h
];
const STANDARD_TRANSIENT_BACKOFF_MS = [
  2 * 60 * 1000, // 2m
  10 * 60 * 1000, // 10m
  30 * 60 * 1000 // 30m
];
const PROVEN_FAST_TTFB_MS = 4_500;
const GEMINI_HEDGE_DELAY_MS = 5_000;

export type AutopilotFetchLike = (
  url: string,
  init?: RequestInit
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export interface ModelHealthEntry {
  avgTtfbMs: number | null;
  lastSuccessAt: number | null;
  lastFailureAt: number | null;
  failureStreak: number;
  cooldownUntilMs: number;
  cooldownReason: string | null;
}

export interface ProviderAutopilotSnapshot {
  source: "live" | "cache" | "fallback";
  lastFetchedAt: string | null;
  discoveredCount: number;
  activeModels: string[];
  primaryModel: string | null;
  fastBackupModel: string | null;
  latenciesMs: Record<string, number>;
  cooledDown: Array<{
    model: string;
    reason: string;
    until: string;
  }>;
}

interface CatalogCacheState {
  models: string[];
  modelSet: Set<string>;
  lastFetchedAtMs: number | null;
  source: "live" | "cache" | "fallback";
  inFlight: Promise<string[]> | null;
}

function getDataDir(): string {
  return process.env.AI_COUNCIL_DATA_DIR
    ? resolve(process.env.AI_COUNCIL_DATA_DIR)
    : resolve(ROOT_DIR, "data");
}

function getHealthFilePath(): string {
  return resolve(getDataDir(), "model-health.json");
}

function emptyCatalog(): CatalogCacheState {
  return {
    models: [],
    modelSet: new Set<string>(),
    lastFetchedAtMs: null,
    source: "fallback",
    inFlight: null
  };
}

const catalogs: Record<"gemini" | "groq", CatalogCacheState> = {
  gemini: emptyCatalog(),
  groq: emptyCatalog()
};

const healthMap = new Map<string, ModelHealthEntry>();
let healthLoadedDir: string | null = null;
let persistQueue: Promise<void> = Promise.resolve();

function healthKey(provider: AutoPlatform, model: string): string {
  return `${provider}::${model}`;
}

async function ensureHealthLoaded(): Promise<void> {
  const currentDir = getDataDir();
  if (healthLoadedDir === currentDir) return;
  healthLoadedDir = currentDir;
  healthMap.clear();

  try {
    const raw = await readFile(getHealthFilePath(), "utf8");
    const parsed: unknown = JSON.parse(raw.replace(/^\uFEFF/, "").trim() || "{}");
    if (!parsed || typeof parsed !== "object") return;

    const now = Date.now();
    for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
      if (!val || typeof val !== "object") continue;
      const rec = val as Partial<ModelHealthEntry>;
      const cooldownUntilMs =
        typeof rec.cooldownUntilMs === "number" && Number.isFinite(rec.cooldownUntilMs)
          ? rec.cooldownUntilMs
          : 0;
      const lastSuccessAt =
        typeof rec.lastSuccessAt === "number" && Number.isFinite(rec.lastSuccessAt)
          ? rec.lastSuccessAt
          : null;
      // Descarta registros muito antigos (>7 dias) sem cooldown ativo
      if (
        cooldownUntilMs <= now &&
        lastSuccessAt !== null &&
        now - lastSuccessAt > 7 * 24 * 60 * 60 * 1000
      ) {
        continue;
      }
      healthMap.set(key, {
        avgTtfbMs:
          typeof rec.avgTtfbMs === "number" && Number.isFinite(rec.avgTtfbMs)
            ? Math.round(rec.avgTtfbMs)
            : null,
        lastSuccessAt,
        lastFailureAt:
          typeof rec.lastFailureAt === "number" && Number.isFinite(rec.lastFailureAt)
            ? rec.lastFailureAt
            : null,
        failureStreak:
          typeof rec.failureStreak === "number" && rec.failureStreak >= 0
            ? Math.floor(rec.failureStreak)
            : 0,
        cooldownUntilMs,
        cooldownReason:
          typeof rec.cooldownReason === "string" ? rec.cooldownReason.slice(0, 48) : null
      });
    }
  } catch {
    // Arquivo ainda não existe: inicia limpo.
  }
}

function scheduleHealthPersist(): void {
  const targetFile = getHealthFilePath();
  const snapshot = Object.fromEntries(healthMap.entries());

  persistQueue = persistQueue
    .then(async () => {
      await writeTextAtomically(targetFile, JSON.stringify(snapshot, null, 2));
    })
    .catch(() => {});
}

// ---------------------------------------------------------------
// Regras de segurança & classificação de modelos (Gemini e Groq)
// ---------------------------------------------------------------

const GEMINI_FLASH_VERSION_REGEX = /^gemini-(\d+(?:\.\d+)?)-flash(-lite)?$/;
const GEMMA_CHAT_REGEX = /^gemma-4-(\d+)b(?:-[a-z0-9]+)?-it$/;

export function parseGeminiFlashVersion(model: string): {
  version: number;
  isLite: boolean;
} | null {
  const m = model.trim().match(GEMINI_FLASH_VERSION_REGEX);
  if (!m?.[1]) return null;
  const version = Number(m[1]);
  if (!Number.isFinite(version) || version < 2.0 || version >= 4.0) {
    return null;
  }
  return { version, isLite: Boolean(m[2]) };
}

/**
 * Allowlist estrita de custo zero para Gemini:
 * aceita APENAS modelos Flash/Flash-Lite 2.x–3.x (e Gemma 4 chat),
 * bloqueando Pro, Gemini 4, TTS, Image/Nano-Banana, Lyria, Robotics,
 * Computer-Use, Transcribe, Deep-Research, Omni e Previews instáveis.
 */
export function isAllowedFreeGeminiModel(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const rawName = typeof item.name === "string" ? item.name.trim() : "";
  const id = rawName.replace(/^models\//, "");

  if (!id || !SAFE_MODEL_ID_REGEX.test(id)) return null;

  const methods = Array.isArray(item.supportedGenerationMethods)
    ? item.supportedGenerationMethods.map((m) => String(m))
    : [];
  if (methods.length > 0 && !methods.includes("generateContent")) {
    return null;
  }

  if (parseGeminiFlashVersion(id) !== null) {
    return id;
  }

  if (GEMMA_CHAT_REGEX.test(id)) {
    return id;
  }

  return null;
}

export function isGeminiFlagshipCandidate(model: string): boolean {
  const parsed = parseGeminiFlashVersion(model);
  return parsed !== null && parsed.version >= 3.6 && !parsed.isLite;
}

export function parseGeminiCatalog(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const rawModels = (payload as { models?: unknown }).models;
  if (!Array.isArray(rawModels)) return [];

  const seen = new Set<string>();
  const allowed: string[] = [];

  for (const item of rawModels) {
    const id = isAllowedFreeGeminiModel(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    allowed.push(id);
  }

  // Ordena por versão Flash decrescente (3.8 > 3.7 > 3.6 > 3.5 > 3.5-lite > 2.5 > gemma)
  allowed.sort((a, b) => {
    const pa = parseGeminiFlashVersion(a);
    const pb = parseGeminiFlashVersion(b);
    if (pa && pb) {
      if (pb.version !== pa.version) return pb.version - pa.version;
      if (pa.isLite !== pb.isLite) return pa.isLite ? 1 : -1;
      return a.localeCompare(b);
    }
    if (pa && !pb) return -1;
    if (!pa && pb) return 1;
    return b.localeCompare(a);
  });

  return allowed;
}

const GROQ_EXCLUDED_REGEX =
  /(?:whisper|orpheus|guard|safeguard|moderation|embed|embedding|rerank|tts|audio|speech|allam|playai|distil-whisper|vision-preview)/i;

export function isAllowedGroqChatModel(raw: unknown): {
  id: string;
  contextWindow: number;
  score: number;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const id = typeof item.id === "string" ? item.id.trim() : "";

  if (!id || !SAFE_MODEL_ID_REGEX.test(id)) return null;
  if (item.active === false) return null;
  if (GROQ_EXCLUDED_REGEX.test(id)) return null;

  const ctx =
    typeof item.context_window === "number" && Number.isFinite(item.context_window)
      ? Math.floor(item.context_window)
      : 0;
  // Filtra modelos utilitários minúsculos (< 8k contexto)
  if (ctx > 0 && ctx < 8_192) return null;

  const lower = id.toLowerCase();
  let score = ctx >= 128_000 ? 30 : ctx >= 32_000 ? 20 : 10;
  if (/gpt-oss-120b/.test(lower)) score += 45;
  else if (/llama-3\.3-70b|llama-4/.test(lower)) score += 40;
  else if (/qwen.*3\.\d|qwen-?3|deepseek/.test(lower)) score += 35;
  else if (/gpt-oss-20b/.test(lower)) score += 28;
  else if (/70b|72b|120b/.test(lower)) score += 32;
  else if (/27b|32b|20b/.test(lower)) score += 24;

  return { id, contextWindow: ctx, score };
}

export function parseGroqCatalog(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) return [];

  const seen = new Set<string>();
  const entries: Array<{ id: string; contextWindow: number; score: number }> = [];

  for (const raw of data) {
    const entry = isAllowedGroqChatModel(raw);
    if (!entry || seen.has(entry.id)) continue;
    seen.add(entry.id);
    entries.push(entry);
  }

  entries.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.contextWindow !== a.contextWindow) return b.contextWindow - a.contextWindow;
    return a.id.localeCompare(b.id);
  });

  return entries.map((e) => e.id);
}

// ---------------------------------------------------------------
// Atualização de catálogos (/models — 0 tokens, 0 reqs de chat)
// ---------------------------------------------------------------

export async function refreshGeminiCatalog(options: {
  apiKey: string;
  baseUrl?: string;
  force?: boolean;
  nowMs?: number;
  fetchFn?: AutopilotFetchLike;
}): Promise<string[]> {
  const nowMs = options.nowMs ?? Date.now();
  const cache = catalogs.gemini;
  const isFresh =
    cache.lastFetchedAtMs !== null &&
    nowMs - cache.lastFetchedAtMs < CATALOG_CACHE_TTL_MS &&
    cache.models.length > 0;

  if (!options.force && isFresh) {
    cache.source = "cache";
    return cache.models;
  }
  if (cache.inFlight && !options.force) {
    return cache.inFlight;
  }

  const base = (options.baseUrl?.trim() || "https://generativelanguage.googleapis.com").replace(
    /\/+$/,
    ""
  );
  const endpoint = `${base}/v1beta/models?pageSize=100`;
  const fetcher: AutopilotFetchLike = options.fetchFn ?? ((url, init) => fetch(url, init));

  let task: Promise<string[]> | null = null;
  task = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CATALOG_TIMEOUT_MS);
    try {
      const res = await fetcher(endpoint, {
        method: "GET",
        headers: {
          Accept: "application/json",
          "x-goog-api-key": options.apiKey
        },
        signal: ctrl.signal
      });
      if (!res.ok) {
        throw new Error(`Gemini /models HTTP ${res.status}`);
      }
      const parsed = parseGeminiCatalog(await res.json());
      if (parsed.length > 0) {
        cache.models = parsed;
        cache.modelSet = new Set(parsed);
        cache.lastFetchedAtMs = options.nowMs ?? Date.now();
        cache.source = "live";
      }
      return cache.models;
    } catch {
      cache.source = cache.models.length > 0 ? "cache" : "fallback";
      return cache.models;
    } finally {
      clearTimeout(timer);
      if (cache.inFlight === task) {
        cache.inFlight = null;
      }
    }
  })();

  cache.inFlight = task;
  return task;
}

export async function refreshGroqCatalog(options: {
  apiKey: string;
  baseURL?: string;
  force?: boolean;
  nowMs?: number;
  fetchFn?: AutopilotFetchLike;
}): Promise<string[]> {
  const nowMs = options.nowMs ?? Date.now();
  const cache = catalogs.groq;
  const isFresh =
    cache.lastFetchedAtMs !== null &&
    nowMs - cache.lastFetchedAtMs < CATALOG_CACHE_TTL_MS &&
    cache.models.length > 0;

  if (!options.force && isFresh) {
    cache.source = "cache";
    return cache.models;
  }
  if (cache.inFlight && !options.force) {
    return cache.inFlight;
  }

  const base = (options.baseURL?.trim() || "https://api.groq.com/openai/v1").replace(
    /\/+$/,
    ""
  );
  const endpoint = `${base}/models`;
  const fetcher: AutopilotFetchLike = options.fetchFn ?? ((url, init) => fetch(url, init));

  let task: Promise<string[]> | null = null;
  task = (async () => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CATALOG_TIMEOUT_MS);
    try {
      const res = await fetcher(endpoint, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${options.apiKey}`
        },
        signal: ctrl.signal
      });
      if (!res.ok) {
        throw new Error(`Groq /models HTTP ${res.status}`);
      }
      const parsed = parseGroqCatalog(await res.json());
      if (parsed.length > 0) {
        cache.models = parsed;
        cache.modelSet = new Set(parsed);
        cache.lastFetchedAtMs = options.nowMs ?? Date.now();
        cache.source = "live";
      }
      return cache.models;
    } catch {
      cache.source = cache.models.length > 0 ? "cache" : "fallback";
      return cache.models;
    } finally {
      clearTimeout(timer);
      if (cache.inFlight === task) {
        cache.inFlight = null;
      }
    }
  })();

  cache.inFlight = task;
  return task;
}

// ---------------------------------------------------------------
// Registro de saúde, latência real (EWMA) e cooldown exponencial
// ---------------------------------------------------------------

export async function recordAutopilotSuccess(
  provider: AutoPlatform,
  model: string,
  ttfbMs?: number,
  nowMs = Date.now()
): Promise<void> {
  await ensureHealthLoaded();
  const key = healthKey(provider, model);
  const prev = healthMap.get(key);

  let nextAvg = prev?.avgTtfbMs ?? null;
  if (typeof ttfbMs === "number" && Number.isFinite(ttfbMs) && ttfbMs > 0) {
    nextAvg =
      nextAvg === null
        ? Math.round(ttfbMs)
        : Math.round(nextAvg * 0.6 + ttfbMs * 0.4);
  }

  healthMap.set(key, {
    avgTtfbMs: nextAvg,
    lastSuccessAt: nowMs,
    lastFailureAt: prev?.lastFailureAt ?? null,
    failureStreak: 0,
    cooldownUntilMs: 0,
    cooldownReason: null
  });
  scheduleHealthPersist();
}

export async function recordAutopilotFailure(
  provider: AutoPlatform,
  model: string,
  error: Pick<ProviderError, "kind" | "message" | "retryAfterMs">,
  nowMs = Date.now()
): Promise<void> {
  if (
    error.kind === "aborted" ||
    error.kind === "auth" ||
    error.kind === "quota_exhausted"
  ) {
    return;
  }

  await ensureHealthLoaded();
  const key = healthKey(provider, model);
  const prev = healthMap.get(key);
  const nextStreak = (prev?.failureStreak ?? 0) + 1;

  let durationMs = COOLDOWN_EMPTY_MS;
  let reason: string = error.kind;

  const isLimitZero =
    error.kind === "rate_limit" &&
    /\blimit\s*:\s*0\b|free.?tier.*0|quota.*exceeded.*0/i.test(error.message || "");

  if (isLimitZero) {
    durationMs = COOLDOWN_LIMIT_ZERO_MS;
    reason = "limit_zero";
  } else if (error.kind === "model") {
    durationMs = COOLDOWN_MODEL_404_MS;
    reason = "unavailable";
  } else if (error.kind === "transient") {
    const isGeminiFlagship =
      provider === "gemini" && isGeminiFlagshipCandidate(model);
    const ladder = isGeminiFlagship
      ? GEMINI_FLAGSHIP_BACKOFF_MS
      : STANDARD_TRANSIENT_BACKOFF_MS;
    durationMs = ladder[Math.min(nextStreak - 1, ladder.length - 1)] as number;
    reason = /slow|ttfb|high demand|503/i.test(error.message || "")
      ? "congested"
      : "transient";
  } else if (error.kind === "rate_limit") {
    const baseMs = Math.max(
      2 * 60 * 1000,
      typeof error.retryAfterMs === "number" && Number.isFinite(error.retryAfterMs)
        ? error.retryAfterMs
        : 2 * 60 * 1000
    );
    durationMs = Math.min(15 * 60 * 1000, baseMs * Math.min(nextStreak, 3));
    reason = "rate_limit";
  }

  healthMap.set(key, {
    avgTtfbMs: prev?.avgTtfbMs ?? null,
    lastSuccessAt: prev?.lastSuccessAt ?? null,
    lastFailureAt: nowMs,
    failureStreak: nextStreak,
    cooldownUntilMs: nowMs + durationMs,
    cooldownReason: reason
  });
  scheduleHealthPersist();
}

export function isAutopilotModelCooledDown(
  provider: AutoPlatform,
  model: string,
  nowMs = Date.now()
): boolean {
  const entry = healthMap.get(healthKey(provider, model));
  return Boolean(entry && entry.cooldownUntilMs > nowMs);
}

export function isAutopilotModelProvenFast(
  provider: AutoPlatform,
  model: string,
  nowMs = Date.now()
): boolean {
  const entry = healthMap.get(healthKey(provider, model));
  if (!entry) return false;
  if (entry.cooldownUntilMs > nowMs) return false;
  if (entry.avgTtfbMs === null || entry.avgTtfbMs > PROVEN_FAST_TTFB_MS) return false;
  if (!entry.lastSuccessAt || nowMs - entry.lastSuccessAt > 6 * 60 * 60 * 1000) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------
// Construção inteligente das filas (Gemini enxuta, Groq híbrida)
// ---------------------------------------------------------------

/**
 * Fila enxuta do Gemini (sem "pedágio triplo"):
 * - #1: o modelo Flash mais novo descoberto (ex.: gemini-3.8-flash), se ativo
 * - #2/#3 (Pista Rápida imediata): os modelos preferidos estáveis (ex.: gemini-3.5-flash-lite, gemini-3.5-flash)
 * - Reservas: demais Flash/Gemma ativos
 * Modelos em cooldown vão automaticamente para o final da fila.
 */
export function buildGeminiAutopilotQueue(
  preferredModels: readonly string[],
  nowMs = Date.now()
): string[] {
  const discovered = catalogs.gemini.models;
  const hasCatalog = discovered.length > 0;
  const ordered: string[] = [];
  const pushUnique = (id: string) => {
    if (id && !ordered.includes(id)) ordered.push(id);
  };

  // 1. Melhor Flash novo no topo (#1) — apenas 1 flagship antes da pista rápida!
  const topFlagship = discovered.find((id) => isGeminiFlagshipCandidate(id));
  if (topFlagship) {
    pushUnique(topFlagship);
  }

  // 2. Pista Rápida garantida logo atrás (#2 / #3)
  for (const pref of preferredModels) {
    if (!hasCatalog || catalogs.gemini.modelSet.has(pref)) {
      pushUnique(pref);
    }
  }

  // 3. Reservas descobertas (ex.: 3.6-flash, 2.5-flash, gemma-4-31b-it)
  for (const id of discovered) {
    // Evita colocar outros flagships intermediários congestionados (ex. 3.7) na frente dos estáveis
    const parsed = parseGeminiFlashVersion(id);
    if (parsed && parsed.version < 3.6) {
      pushUnique(id);
    }
  }
  for (const id of discovered) {
    pushUnique(id);
  }
  for (const pref of preferredModels) {
    pushUnique(pref);
  }

  const healthy: string[] = [];
  const cooled: string[] = [];
  for (const id of ordered) {
    if (isAutopilotModelCooledDown("gemini", id, nowMs)) {
      cooled.push(id);
    } else {
      healthy.push(id);
    }
  }

  return [...healthy, ...cooled];
}

export function pickGeminiHedgePlan(
  queue: readonly string[],
  preferredFastModels: readonly string[],
  nowMs = Date.now()
): {
  primary: string;
  fastBackup: string;
  delayMs: number;
  primaryProvenFast: boolean;
} | null {
  const primary = queue[0];
  if (!primary || !isGeminiFlagshipCandidate(primary)) return null;
  if (isAutopilotModelCooledDown("gemini", primary, nowMs)) return null;

  const fastBackup =
    queue.find(
      (id) =>
        id !== primary &&
        !isGeminiFlagshipCandidate(id) &&
        !isAutopilotModelCooledDown("gemini", id, nowMs) &&
        (preferredFastModels.includes(id) || /3\.5-flash|2\.5-flash/.test(id))
    ) ?? queue.find((id) => id !== primary && !isGeminiFlagshipCandidate(id));

  if (!fastBackup) return null;

  return {
    primary,
    fastBackup,
    delayMs: GEMINI_HEDGE_DELAY_MS,
    primaryProvenFast: isAutopilotModelProvenFast("gemini", primary, nowMs)
  };
}

export function buildGroqAutopilotQueue(
  preferredModels: readonly string[],
  nowMs = Date.now()
): string[] {
  const discovered = catalogs.groq.models;
  const hasCatalog = discovered.length > 0;
  const ordered: string[] = [];
  const pushUnique = (id: string) => {
    if (id && !ordered.includes(id)) ordered.push(id);
  };

  for (const pref of preferredModels) {
    if (!hasCatalog || catalogs.groq.modelSet.has(pref)) {
      pushUnique(pref);
    }
  }
  for (const id of discovered) {
    pushUnique(id);
  }
  for (const pref of preferredModels) {
    pushUnique(pref);
  }

  const healthy: string[] = [];
  const cooled: string[] = [];
  for (const id of ordered) {
    if (isAutopilotModelCooledDown("groq", id, nowMs)) {
      cooled.push(id);
    } else {
      healthy.push(id);
    }
  }

  return [...healthy, ...cooled];
}

export async function resolveGeminiAutopilotModels(
  preferredModels: readonly string[],
  options: {
    apiKey: string;
    baseUrl?: string;
    skipNetwork?: boolean;
    nowMs?: number;
    fetchFn?: AutopilotFetchLike;
  }
): Promise<string[]> {
  await ensureHealthLoaded();
  const nowMs = options.nowMs ?? Date.now();
  const cache = catalogs.gemini;
  if (
    !options.skipNetwork &&
    (cache.lastFetchedAtMs === null || nowMs - cache.lastFetchedAtMs >= CATALOG_CACHE_TTL_MS)
  ) {
    await refreshGeminiCatalog({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      nowMs,
      fetchFn: options.fetchFn
    });
  }
  return buildGeminiAutopilotQueue(preferredModels, nowMs);
}

export async function resolveGroqAutopilotModels(
  preferredModels: readonly string[],
  options: {
    apiKey: string;
    baseURL?: string;
    skipNetwork?: boolean;
    nowMs?: number;
    fetchFn?: AutopilotFetchLike;
  }
): Promise<string[]> {
  await ensureHealthLoaded();
  const nowMs = options.nowMs ?? Date.now();
  const cache = catalogs.groq;
  if (
    !options.skipNetwork &&
    (cache.lastFetchedAtMs === null || nowMs - cache.lastFetchedAtMs >= CATALOG_CACHE_TTL_MS)
  ) {
    await refreshGroqCatalog({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      nowMs,
      fetchFn: options.fetchFn
    });
  }
  return buildGroqAutopilotQueue(preferredModels, nowMs);
}

export async function getProviderAutopilotSnapshot(
  provider: "gemini" | "groq",
  preferredModels: readonly string[],
  nowMs = Date.now()
): Promise<ProviderAutopilotSnapshot> {
  await ensureHealthLoaded();
  const cache = catalogs[provider];
  const activeModels =
    provider === "gemini"
      ? buildGeminiAutopilotQueue(preferredModels, nowMs)
      : buildGroqAutopilotQueue(preferredModels, nowMs);

  const latenciesMs: Record<string, number> = {};
  const cooledDown: ProviderAutopilotSnapshot["cooledDown"] = [];

  for (const model of activeModels) {
    const entry = healthMap.get(healthKey(provider, model));
    if (entry?.avgTtfbMs) {
      latenciesMs[model] = entry.avgTtfbMs;
    }
    if (entry && entry.cooldownUntilMs > nowMs) {
      cooledDown.push({
        model,
        reason: entry.cooldownReason || "cooldown",
        until: new Date(entry.cooldownUntilMs).toISOString()
      });
    }
  }

  const hedge =
    provider === "gemini"
      ? pickGeminiHedgePlan(activeModels, preferredModels, nowMs)
      : null;

  return {
    source: cache.source,
    lastFetchedAt:
      cache.lastFetchedAtMs !== null
        ? new Date(cache.lastFetchedAtMs).toISOString()
        : null,
    discoveredCount: cache.models.length,
    activeModels,
    primaryModel: activeModels[0] ?? null,
    fastBackupModel: hedge?.fastBackup ?? activeModels[1] ?? null,
    latenciesMs,
    cooledDown
  };
}

/** Apenas para testes unitários isolados. */
export function resetModelAutopilotForTests(): void {
  catalogs.gemini = emptyCatalog();
  catalogs.groq = emptyCatalog();
  healthMap.clear();
  healthLoadedDir = null;
}
