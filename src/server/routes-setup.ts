import { tmpdir } from "node:os";
import type { IncomingMessage, ServerResponse } from "node:http";

import { emitProvidersUpdated } from "../debate/stream-hub.js";
import { reinitProviders } from "../providers/registry.js";
import {
  applyNtfsOwnerOnlyPermissions,
  readPrivacySettings,
  sealApiKeysIntoVault,
  type SealedApiEnvKey
} from "../security/data-protection.js";
import type { AutoPlatform } from "../shared/debate-types.js";
import { DEFAULT_WEAK_PASSWORD, type AuthManager } from "./auth.js";
import {
  getSetupMissingProviders,
  isValidApiKeyValue,
  maskApiKey,
  PROVIDER_ENV_KEYS,
  PROVIDER_KEY_URLS,
  upsertEnvFile,
  validateProviderApiKey,
  type KeyValidationResult,
  type KeyValidatorFn
} from "./env-config.js";
import { isRecord, readRequestBody, sendJson } from "./http-utils.js";

const REQUIRED_PROVIDERS: AutoPlatform[] = ["gemini", "groq", "openrouter"];
const OPTIONAL_PROVIDERS: AutoPlatform[] = ["nvidia"];

function buildSetupProvidersPayload() {
  return {
    gemini: {
      configured: isValidApiKeyValue(process.env.GEMINI_API_KEY),
      maskedKey: maskApiKey(process.env.GEMINI_API_KEY),
      keyUrl: PROVIDER_KEY_URLS.gemini
    },
    groq: {
      configured: isValidApiKeyValue(process.env.GROQ_API_KEY),
      maskedKey: maskApiKey(process.env.GROQ_API_KEY),
      keyUrl: PROVIDER_KEY_URLS.groq
    },
    openrouter: {
      configured: isValidApiKeyValue(process.env.OPENROUTER_API_KEY),
      maskedKey: maskApiKey(process.env.OPENROUTER_API_KEY),
      keyUrl: PROVIDER_KEY_URLS.openrouter
    },
    nvidia: {
      optional: true,
      configured: isValidApiKeyValue(process.env.NVIDIA_API_KEY),
      maskedKey: maskApiKey(process.env.NVIDIA_API_KEY),
      keyUrl: PROVIDER_KEY_URLS.nvidia
    }
  };
}

export interface SetupRouteOptions {
  envPath: string;
  validateKeyFn?: KeyValidatorFn;
}

/**
 * Rotas de Setup Guiado (/setup/status e /setup/save).
 * SEGURANÇA: restritas 100% a requisições diretas do próprio PC (localhost / 127.0.0.1 / ::1).
 * Nunca acessíveis remotamente via celular, Wi-Fi externo ou Tailscale, e nunca retornam chaves completas.
 */
export async function handleSetupRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  auth: AuthManager,
  options: SetupRouteOptions
): Promise<boolean> {
  if (url.pathname !== "/setup/status" && url.pathname !== "/setup/save") {
    return false;
  }

  // Trava rigorosa: somente PC local direto (sem proxy, sem LAN, sem Tailscale)
  if (!auth.isDirectLocalPCRequest(request)) {
    sendJson(
      response,
      403,
      {
        error:
          "Configuração de chaves permitida somente diretamente no PC local (http://127.0.0.1:4317)."
      },
      origin
    );
    return true;
  }

  if (request.method === "GET" && url.pathname === "/setup/status") {
    const missing = getSetupMissingProviders();
    sendJson(
      response,
      200,
      {
        isLocal: true,
        setupComplete: missing.length === 0,
        missingProviders: missing,
        providers: buildSetupProvidersPayload(),
        accessPassword: {
          configured: !auth.isUsingWeakDefaultPassword(),
          isWeakDefault: auth.isUsingWeakDefaultPassword()
        }
      },
      origin
    );
    return true;
  }

  if (request.method === "POST" && url.pathname === "/setup/save") {
    let payload: unknown;
    try {
      payload = JSON.parse(await readRequestBody(request));
    } catch {
      sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
      return true;
    }

    if (!isRecord(payload)) {
      sendJson(response, 400, { error: "Dados de configuração inválidos." }, origin);
      return true;
    }

    const incomingKeys: Record<AutoPlatform, string> = {
      gemini:
        typeof payload.geminiApiKey === "string" ? payload.geminiApiKey.trim() : "",
      groq:
        typeof payload.groqApiKey === "string" ? payload.groqApiKey.trim() : "",
      openrouter:
        typeof payload.openrouterApiKey === "string"
          ? payload.openrouterApiKey.trim()
          : "",
      nvidia:
        typeof payload.nvidiaApiKey === "string" ? payload.nvidiaApiKey.trim() : ""
    };

    const incomingPassword =
      typeof payload.accessPassword === "string"
        ? payload.accessPassword.trim()
        : "";

    if (incomingPassword) {
      if (incomingPassword.length < 8) {
        sendJson(
          response,
          400,
          { error: "A senha de acesso remoto deve ter pelo menos 8 caracteres." },
          origin
        );
        return true;
      }
      if (incomingPassword === DEFAULT_WEAK_PASSWORD) {
        sendJson(
          response,
          400,
          { error: "Escolha uma senha diferente da senha padrão." },
          origin
        );
        return true;
      }
    }

    // Resolve chaves efetivas: aceita manter chave já salva se o campo vier vazio na edição
    const effectiveKeys: Record<AutoPlatform, string> = {
      gemini: incomingKeys.gemini || (process.env.GEMINI_API_KEY?.trim() ?? ""),
      groq: incomingKeys.groq || (process.env.GROQ_API_KEY?.trim() ?? ""),
      openrouter:
        incomingKeys.openrouter || (process.env.OPENROUTER_API_KEY?.trim() ?? ""),
      nvidia: incomingKeys.nvidia || (process.env.NVIDIA_API_KEY?.trim() ?? "")
    };

    const validation: Partial<Record<AutoPlatform, KeyValidationResult>> = {
      gemini: { ok: false },
      groq: { ok: false },
      openrouter: { ok: false }
    };

    const missingBeforeTest: AutoPlatform[] = [];
    for (const plat of REQUIRED_PROVIDERS) {
      if (!isValidApiKeyValue(effectiveKeys[plat])) {
        missingBeforeTest.push(plat);
        validation[plat] = {
          ok: false,
          error: "Chave obrigatória para liberar o AI Council."
        };
      }
    }

    if (missingBeforeTest.length > 0) {
      sendJson(
        response,
        400,
        {
          error: "Informe todas as 3 chaves (Gemini, Groq e OpenRouter) para continuar.",
          validation
        },
        origin
      );
      return true;
    }

    const validator = options.validateKeyFn ?? validateProviderApiKey;

    const providersToValidate: AutoPlatform[] = [...REQUIRED_PROVIDERS];
    for (const optPlat of OPTIONAL_PROVIDERS) {
      // Só valida provedor opcional se o usuário enviou uma chave nova ou já tem uma válida salva
      if (incomingKeys[optPlat] || isValidApiKeyValue(effectiveKeys[optPlat])) {
        providersToValidate.push(optPlat);
      }
    }

    // Testa online todas as chaves configuradas em paralelo (endpoints gratuitos, 0 tokens gastos)
    const results = await Promise.all(
      providersToValidate.map(async (plat) => {
        const res = await validator(plat, effectiveKeys[plat]);
        return [plat, res] as const;
      })
    );

    let allValid = true;
    for (const [plat, res] of results) {
      validation[plat] = res;
      if (!res.ok) allValid = false;
    }

    if (!allValid) {
      sendJson(
        response,
        400,
        {
          error: "Uma ou mais chaves falharam na validação. Corrija os itens destacados.",
          validation
        },
        origin
      );
      return true;
    }

    // Salva as 3 chaves obrigatórias + eventuais opcionais válidas + senha se fornecida
    const apiKeyUpdates: Partial<Record<SealedApiEnvKey, string>> = {};
    for (const plat of providersToValidate) {
      const envName = PROVIDER_ENV_KEYS[plat] as SealedApiEnvKey;
      if (isValidApiKeyValue(effectiveKeys[plat])) {
        apiKeyUpdates[envName] = effectiveKeys[plat];
      }
    }

    const privacySettings = await readPrivacySettings();
    const keepKeysInVault =
      privacySettings.sealApiKeysInVault && privacySettings.vaultMode !== "off";

    try {
      if (keepKeysInVault) {
        if (incomingPassword) {
          await upsertEnvFile(options.envPath, {
            ACCESS_PASSWORD: incomingPassword
          });
        }
        await sealApiKeysIntoVault(options.envPath, apiKeyUpdates);
      } else {
        const envUpdates: Record<string, string> = { ...apiKeyUpdates };
        if (incomingPassword) {
          envUpdates.ACCESS_PASSWORD = incomingPassword;
        }
        await upsertEnvFile(options.envPath, envUpdates);
      }
      if (process.platform === "win32" && !options.envPath.startsWith(tmpdir())) {
        await applyNtfsOwnerOnlyPermissions([options.envPath]).catch(() => {});
      }
    } catch (error) {
      console.error("[AI Council] Falha ao gravar configuração no setup:", error);
      sendJson(
        response,
        500,
        { error: "Não foi possível gravar as chaves localmente." },
        origin
      );
      return true;
    }

    // Hot-reload imediato em memória (sem precisar reiniciar o servidor!)
    for (const [envKey, envVal] of Object.entries(apiKeyUpdates)) {
      if (envVal) process.env[envKey] = envVal;
    }
    if (incomingPassword) {
      process.env.ACCESS_PASSWORD = incomingPassword;
      auth.updateAccessPassword(incomingPassword);
    }
    reinitProviders();
    emitProvidersUpdated();

    sendJson(
      response,
      200,
      {
        saved: true,
        setupComplete: true,
        validation,
        providers: buildSetupProvidersPayload(),
        accessPassword: {
          configured: !auth.isUsingWeakDefaultPassword(),
          isWeakDefault: auth.isUsingWeakDefaultPassword()
        }
      },
      origin
    );
    return true;
  }

  sendJson(response, 405, { error: "Método não permitido." }, origin);
  return true;
}
