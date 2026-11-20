import { randomBytes } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { AutoPlatform } from "../shared/debate-types.js";

const PLACEHOLDER_PREFIXES = [
  "sua_chave_",
  "cole_aqui_",
  "defina_uma_senha_",
  "your_api_key",
  "your_key",
  "changeme",
  "replace_me"
];

export const PROVIDER_ENV_KEYS: Record<AutoPlatform, string> = {
  gemini: "GEMINI_API_KEY",
  groq: "GROQ_API_KEY",
  openrouter: "OPENROUTER_API_KEY"
};

export const PROVIDER_KEY_URLS: Record<AutoPlatform, string> = {
  gemini: "https://aistudio.google.com/apikey",
  groq: "https://console.groq.com/keys",
  openrouter: "https://openrouter.ai/keys"
};

export function isPlaceholderSecret(value: string | undefined): boolean {
  const clean = (value ?? "").trim();
  if (!clean) return true;
  const lower = clean.toLowerCase();
  return PLACEHOLDER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

export function isValidApiKeyValue(value: string | undefined): value is string {
  const clean = (value ?? "").trim();
  if (!clean || clean.length < 10) return false;
  return !isPlaceholderSecret(clean);
}

export function maskApiKey(value: string | undefined): string {
  const clean = (value ?? "").trim();
  if (!isValidApiKeyValue(clean)) return "";
  const tail = clean.slice(-4);
  return `••••${tail}`;
}

function sanitizeEnvValue(raw: string): string {
  return raw.replace(/[\r\n\0]+/g, "").trim();
}

/**
 * Atualiza ou adiciona chaves em um arquivo .env preservando comentários e demais variáveis.
 * Escreve de forma atômica (arquivo temporário + rename).
 */
export async function upsertEnvFile(
  envPath: string,
  updates: Record<string, string>
): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(envPath, "utf8");
  } catch {
    existing = [
      "# ============================================================",
      "# AI Council — configuração local (gerada automaticamente)",
      "# NUNCA compartilhe este arquivo .env.",
      "# ============================================================",
      ""
    ].join("\n");
  }

  const normalized = existing.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const remaining = new Map<string, string>();
  for (const [k, v] of Object.entries(updates)) {
    const cleanKey = k.trim();
    if (!/^[A-Z0-9_]+$/.test(cleanKey)) continue;
    remaining.set(cleanKey, sanitizeEnvValue(v));
  }

  const outLines = lines.map((line) => {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!match?.[1]) return line;
    const key = match[1];
    if (!remaining.has(key)) return line;
    const nextVal = remaining.get(key)!;
    remaining.delete(key);
    return `${key}=${nextVal}`;
  });

  if (remaining.size > 0) {
    if (outLines.length > 0 && outLines[outLines.length - 1]?.trim() !== "") {
      outLines.push("");
    }
    for (const [key, val] of remaining.entries()) {
      outLines.push(`${key}=${val}`);
    }
  }

  const finalContent = `${outLines.join("\n").replace(/\n+$/, "")}\n`;
  const tempPath = `${envPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, finalContent, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, envPath);
}

export interface BootstrapEnvResult {
  envPath: string;
  token: string;
  createdEnv: boolean;
  generatedToken: boolean;
}

/**
 * Garante que o arquivo .env exista e contenha um MONITOR_TOKEN seguro (>= 32 chars).
 * Se um amigo baixar o projeto sem .env, cria tudo automaticamente na primeira abertura.
 */
export async function ensureBootstrapEnv(
  rootDir: string,
  customEnvPath?: string
): Promise<BootstrapEnvResult> {
  const envPath = customEnvPath ?? resolve(rootDir, ".env");
  let createdEnv = false;
  let existingContent = "";

  try {
    existingContent = await readFile(envPath, "utf8");
  } catch {
    createdEnv = true;
  }

  // Lê MONITOR_TOKEN de process.env ou do arquivo .env existente
  let currentToken = process.env.MONITOR_TOKEN?.trim() ?? "";
  if (!currentToken && existingContent) {
    const m = existingContent.match(/^\s*MONITOR_TOKEN\s*=\s*(.+)$/m);
    if (m?.[1]) {
      currentToken = m[1].trim();
    }
  }

  const tokenInvalid =
    !currentToken ||
    currentToken.length < 32 ||
    isPlaceholderSecret(currentToken);

  if (tokenInvalid) {
    const generated = randomBytes(32).toString("hex");
    await upsertEnvFile(envPath, { MONITOR_TOKEN: generated });
    process.env.MONITOR_TOKEN = generated;
    return {
      envPath,
      token: generated,
      createdEnv,
      generatedToken: true
    };
  }

  if (createdEnv) {
    await upsertEnvFile(envPath, { MONITOR_TOKEN: currentToken });
  }
  process.env.MONITOR_TOKEN = currentToken;

  return {
    envPath,
    token: currentToken,
    createdEnv,
    generatedToken: false
  };
}

export interface KeyValidationResult {
  ok: boolean;
  error?: string;
}

export type KeyValidatorFn = (
  platform: AutoPlatform,
  apiKey: string
) => Promise<KeyValidationResult>;

/**
 * Valida uma chave de API online usando endpoints gratuitos de listagem/autenticação
 * (0 tokens de geração consumidos, timeout curto de 8 segundos).
 */
export async function validateProviderApiKey(
  platform: AutoPlatform,
  apiKey: string
): Promise<KeyValidationResult> {
  const cleanKey = sanitizeEnvValue(apiKey);
  if (!isValidApiKeyValue(cleanKey)) {
    return { ok: false, error: "Chave ausente ou formato inválido." };
  }

  const timeout = AbortSignal.timeout(8_000);

  try {
    if (platform === "gemini") {
      const base = (
        process.env.GEMINI_BASE_URL?.trim() ||
        "https://generativelanguage.googleapis.com"
      ).replace(/\/+$/, "");
      const res = await fetch(
        `${base}/v1beta/models?pageSize=1&key=${encodeURIComponent(cleanKey)}`,
        { method: "GET", signal: timeout }
      );
      if (res.ok) return { ok: true };
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        return { ok: false, error: "Chave Gemini recusada pela Google AI Studio." };
      }
      return { ok: false, error: `Gemini retornou HTTP ${res.status}.` };
    }

    if (platform === "groq") {
      const base = (
        process.env.GROQ_BASE_URL?.trim() || "https://api.groq.com/openai/v1"
      ).replace(/\/+$/, "");
      const res = await fetch(`${base}/models`, {
        method: "GET",
        headers: { Authorization: `Bearer ${cleanKey}` },
        signal: timeout
      });
      if (res.ok) return { ok: true };
      if (res.status === 401 || res.status === 403) {
        return { ok: false, error: "Chave Groq inválida ou revogada." };
      }
      return { ok: false, error: `Groq retornou HTTP ${res.status}.` };
    }

    const base = (
      process.env.OPENROUTER_BASE_URL?.trim() || "https://openrouter.ai/api/v1"
    ).replace(/\/+$/, "");
    const res = await fetch(`${base}/auth/key`, {
      method: "GET",
      headers: { Authorization: `Bearer ${cleanKey}` },
      signal: timeout
    });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: "Chave OpenRouter inválida ou revogada." };
    }
    return { ok: false, error: `OpenRouter retornou HTTP ${res.status}.` };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (/abort|timeout/i.test(msg)) {
      return { ok: false, error: "Tempo esgotado ao validar a chave (verifique a internet)." };
    }
    return { ok: false, error: "Falha de rede ao testar a chave." };
  }
}

export function getSetupMissingProviders(): AutoPlatform[] {
  const missing: AutoPlatform[] = [];
  for (const plat of ["gemini", "groq", "openrouter"] as AutoPlatform[]) {
    const envVar = PROVIDER_ENV_KEYS[plat];
    if (!isValidApiKeyValue(process.env[envVar])) {
      missing.push(plat);
    }
  }
  return missing;
}
