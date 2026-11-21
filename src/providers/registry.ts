import "dotenv/config";

import { budgetForPlatform } from "../shared/context-budget.js";
import type { AutoPlatform } from "../shared/debate-types.js";
import { isValidApiKeyValue } from "../server/env-config.js";
import { makeGemini } from "./gemini.js";
import { makeOpenAICompat } from "./openai-compat.js";
import {
  getProviderAutopilotSnapshot,
  pickGeminiHedgePlan,
  recordAutopilotFailure,
  recordAutopilotSuccess,
  refreshGeminiCatalog,
  refreshGroqCatalog,
  resolveGeminiAutopilotModels,
  resolveGroqAutopilotModels,
  type ProviderAutopilotSnapshot
} from "./model-autopilot.js";
import {
  buildHybridFreeModelList,
  getOpenRouterFreeDiscoverySnapshot,
  recordOpenRouterModelFailure,
  recordOpenRouterModelSuccess,
  refreshOpenRouterFreeCatalog,
  resolveOpenRouterFreeModels,
  type OpenRouterFreeDiscoverySnapshot
} from "./openrouter-free.js";
import type { Provider } from "./types.js";
import { UsageGate, type GateSnapshot } from "./usage-gate.js";

// ---------------------------------------------------------------
// Leitura de configuração (.env)
// ---------------------------------------------------------------

function envString(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function envInt(name: string, fallback: number): number {
  const raw = envString(name);
  if (raw === undefined) return fallback;

  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function envList(name: string, fallback: string[]): string[] {
  const raw = envString(name);
  if (raw === undefined) return fallback;

  const items = raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  return items.length > 0 ? items : fallback;
}

// ---------------------------------------------------------------
// Padrões (podem ser trocados no .env sem mexer no código)
// ---------------------------------------------------------------

const DEFAULT_GEMINI_MODELS = ["gemini-3.5-flash-lite", "gemini-3.5-flash"];
const DEFAULT_GROQ_MODELS = ["openai/gpt-oss-120b", "openai/gpt-oss-20b"];
const DEFAULT_OPENROUTER_MODELS = [
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "google/gemma-4-31b-it:free",
  "cohere/north-mini-code:free"
];

const PLATFORM_LABELS: Record<AutoPlatform, string> = {
  gemini: "Gemini",
  groq: "Groq",
  openrouter: "OpenRouter"
};

// ---------------------------------------------------------------
// Estado
// ---------------------------------------------------------------

const providers = new Map<AutoPlatform, Provider>();
const gates = new Map<AutoPlatform, UsageGate>();
const issues = new Map<AutoPlatform, string>();
const configuredModels = new Map<AutoPlatform, string[]>();
let initialized = false;

function safetyFactor(): number {
  const raw = Number(envString("USAGE_SAFETY") ?? "0.9");
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.9;
}

function initGemini(): void {
  const models = envList("GEMINI_MODELS", [
    envString("GEMINI_MODEL") ?? DEFAULT_GEMINI_MODELS[0] ?? "gemini-2.5-flash",
    ...envList("GEMINI_FALLBACK_MODELS", DEFAULT_GEMINI_MODELS.slice(1))
  ]);

  configuredModels.set("gemini", models);

  const apiKey = envString("GEMINI_API_KEY");
  if (!isValidApiKeyValue(apiKey)) {
    issues.set("gemini", "GEMINI_API_KEY ausente no .env.");
    return;
  }

  const baseUrl = envString("GEMINI_BASE_URL");
  const autopilotEnabled = envString("GEMINI_AUTOPILOT") !== "false";

  // O Google não publica mais os limites gratuitos por modelo na documentação:
  // confira o console do AI Studio e ajuste estes valores no .env se precisar.
  const gate = new UsageGate(
    "gemini",
    {
      rpm: envInt("GEMINI_RPM", 5),
      rpd: envInt("GEMINI_RPD", 100),
      tpm: envInt("GEMINI_TPM", 200_000)
    },
    "America/Los_Angeles",
    safetyFactor()
  );

  gates.set("gemini", gate);

  providers.set(
    "gemini",
    makeGemini({
      apiKey,
      models,
      resolveModels: autopilotEnabled
        ? () =>
            resolveGeminiAutopilotModels(models, {
              apiKey,
              baseUrl,
              skipNetwork: isRunningUnderTest()
            })
        : undefined,
      resolveHedgePlan: autopilotEnabled
        ? (activeModels) => pickGeminiHedgePlan(activeModels, models)
        : undefined,
      onModelSuccess: (model, ttfbMs) => {
        void recordAutopilotSuccess("gemini", model, ttfbMs);
      },
      onModelError: (model, error) => {
        void recordAutopilotFailure("gemini", model, error);
      },
      gate,
      maxHttpAttempts: envInt("GEMINI_MAX_ATTEMPTS", 2),
      baseUrl
    })
  );

  if (autopilotEnabled && !isRunningUnderTest()) {
    void refreshGeminiCatalog({ apiKey, baseUrl }).catch(() => {});
  }
}

function initGroq(): void {
  const models = envList("GROQ_MODELS", [
    envString("GROQ_MODEL") ?? DEFAULT_GROQ_MODELS[0] ?? "openai/gpt-oss-120b",
    ...envList("GROQ_FALLBACK_MODELS", DEFAULT_GROQ_MODELS.slice(1))
  ]);

  configuredModels.set("groq", models);

  const apiKey = envString("GROQ_API_KEY");
  if (!isValidApiKeyValue(apiKey)) {
    issues.set("groq", "GROQ_API_KEY ausente no .env.");
    return;
  }

  const baseURL = envString("GROQ_BASE_URL") ?? "https://api.groq.com/openai/v1";
  const autopilotEnabled = envString("GROQ_AUTOPILOT") !== "false";

  // Limites do plano gratuito para gpt-oss-120b (por organização).
  // A página de limites da sua conta na Groq é a referência final.
  const gate = new UsageGate(
    "groq",
    {
      rpm: envInt("GROQ_RPM", 30),
      rpd: envInt("GROQ_RPD", 1000),
      tpm: envInt("GROQ_TPM", 8000),
      tpd: envInt("GROQ_TPD", 200_000)
    },
    "UTC",
    safetyFactor()
  );

  gates.set("groq", gate);

  providers.set(
    "groq",
    makeOpenAICompat({
      id: "groq",
      name: "Groq",
      apiKey,
      baseURL,
      models,
      resolveModels: autopilotEnabled
        ? () =>
            resolveGroqAutopilotModels(models, {
              apiKey,
              baseURL,
              skipNetwork: isRunningUnderTest()
            })
        : undefined,
      onModelSuccess: (model, ttfbMs) => {
        void recordAutopilotSuccess("groq", model, ttfbMs);
      },
      onModelError: (model, error) => {
        void recordAutopilotFailure("groq", model, error);
      },
      gate,
      maxHttpAttempts: envInt("GROQ_MAX_ATTEMPTS", 2),
      maxTokensParam: "max_completion_tokens",
      tokenHeadroom: 600,
      extraBody: (model) =>
        model.startsWith("openai/gpt-oss") ? { reasoning_effort: "low" } : {}
    })
  );

  if (autopilotEnabled && !isRunningUnderTest()) {
    void refreshGroqCatalog({ apiKey, baseURL }).catch(() => {});
  }
}

function isRunningUnderTest(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.argv.some((arg) => arg === "--test" || arg.includes(".test."))
  );
}

function initOpenRouter(): void {
  const models = envList("OPENROUTER_MODELS", DEFAULT_OPENROUTER_MODELS);
  configuredModels.set("openrouter", models);

  const apiKey = envString("OPENROUTER_API_KEY");
  if (!isValidApiKeyValue(apiKey)) {
    issues.set("openrouter", "OPENROUTER_API_KEY ausente no .env.");
    return;
  }

  // PROTEÇÃO CONTRA GASTO: só aceita modelos gratuitos (ID terminando em :free).
  const paid = models.filter((model) => !model.endsWith(":free"));
  if (paid.length > 0) {
    issues.set(
      "openrouter",
      `Recusado por segurança: estes modelos não são gratuitos (sem :free): ${paid.join(", ")}.`
    );
    return;
  }

  const baseURL = envString("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1";
  const autoDiscoverFree = envString("OPENROUTER_AUTO_DISCOVER_FREE") !== "false";

  const gate = new UsageGate(
    "openrouter",
    {
      rpm: envInt("OPENROUTER_RPM", 20),
      // 50/dia vale enquanto você nunca tiver comprado créditos.
      rpd: envInt("OPENROUTER_RPD", 50)
    },
    "UTC",
    safetyFactor()
  );

  gates.set("openrouter", gate);

  providers.set(
    "openrouter",
    makeOpenAICompat({
      id: "openrouter",
      name: "OpenRouter",
      apiKey,
      baseURL,
      models,
      resolveModels: autoDiscoverFree
        ? () =>
            resolveOpenRouterFreeModels(models, {
              baseURL,
              skipNetwork: isRunningUnderTest()
            })
        : () => buildHybridFreeModelList(models),
      onModelSuccess: (model, ttfbMs) => {
        recordOpenRouterModelSuccess(model);
        void recordAutopilotSuccess("openrouter", model, ttfbMs);
      },
      onModelError: (model, error) => {
        recordOpenRouterModelFailure(model, error);
        void recordAutopilotFailure("openrouter", model, error);
      },
      gate,
      // Cada tentativa gasta 1 das 50 requisições diárias: no máximo 3, com troca de modelo.
      maxHttpAttempts: envInt("OPENROUTER_MAX_ATTEMPTS", 3),
      maxTokensParam: "max_tokens",
      tokenHeadroom: 400,
      extraHeaders: { "X-Title": "AI Council" }
    })
  );

  // Aquecimento assíncrono não-bloqueante do catálogo :free (zero tokens, custo zero)
  if (autoDiscoverFree && !isRunningUnderTest()) {
    void refreshOpenRouterFreeCatalog({ baseURL }).catch(() => {});
  }
}

export function initProviders(): void {
  if (initialized) return;
  initialized = true;

  initGemini();
  initGroq();
  initOpenRouter();
}

/** Recarrega imediatamente os provedores após salvar novas chaves no Setup guiado (hot-reload). */
export function reinitProviders(): void {
  providers.clear();
  gates.clear();
  issues.clear();
  configuredModels.clear();
  initialized = false;
  initProviders();
}

export function getProvider(id: AutoPlatform): Provider | null {
  initProviders();
  return providers.get(id) ?? null;
}

export function getProviderIssue(id: AutoPlatform): string | null {
  initProviders();
  return issues.get(id) ?? null;
}

export function getProviderLabel(id: AutoPlatform): string {
  return PLATFORM_LABELS[id];
}

export interface ProviderStatus {
  id: AutoPlatform;
  name: string;
  ready: boolean;
  reason: string | null;
  models: string[];
  usage: GateSnapshot | null;
  contextBudget: {
    historyChars: number;
    maxOutputTokens: number;
    synthesisOutputTokens: number;
  };
  autopilot?: ProviderAutopilotSnapshot;
  freeDiscovery?: OpenRouterFreeDiscoverySnapshot;
}

export async function refreshOpenRouterFreeModelsNow(options: {
  force?: boolean;
} = {}): Promise<OpenRouterFreeDiscoverySnapshot> {
  initProviders();
  const baseURL = envString("OPENROUTER_BASE_URL") ?? "https://openrouter.ai/api/v1";
  const preferred = configuredModels.get("openrouter") ?? DEFAULT_OPENROUTER_MODELS;
  await refreshOpenRouterFreeCatalog({
    baseURL,
    force: options.force ?? true
  });
  return getOpenRouterFreeDiscoverySnapshot(preferred);
}

export async function getProvidersStatus(): Promise<ProviderStatus[]> {
  initProviders();

  const ids: AutoPlatform[] = ["gemini", "groq", "openrouter"];
  const result: ProviderStatus[] = [];

  for (const id of ids) {
    const gate = gates.get(id);
    const budget = budgetForPlatform(id);
    const preferred = configuredModels.get(id) ?? [];
    const autopilot =
      id === "gemini" || id === "groq"
        ? await getProviderAutopilotSnapshot(id, preferred)
        : undefined;
    const freeDiscovery =
      id === "openrouter"
        ? getOpenRouterFreeDiscoverySnapshot(preferred)
        : undefined;

    result.push({
      id,
      name: PLATFORM_LABELS[id],
      ready: providers.has(id),
      reason: issues.get(id) ?? null,
      models:
        id === "openrouter" && freeDiscovery && freeDiscovery.activeModels.length > 0
          ? freeDiscovery.activeModels
          : autopilot && autopilot.activeModels.length > 0
            ? autopilot.activeModels
            : preferred,
      usage: gate ? await gate.snapshot() : null,
      contextBudget: {
        historyChars: budget.historyChars,
        maxOutputTokens: budget.maxTokens.initial_response,
        synthesisOutputTokens: budget.maxTokens.synthesis
      },
      ...(autopilot ? { autopilot } : {}),
      ...(freeDiscovery ? { freeDiscovery } : {})
    });
  }

  return result;
}
