import { rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { emitProvidersUpdated } from "../debate/stream-hub.js";
import {
  readDebateSessions,
  resetDebateStorageState
} from "../persistence/debate-store.js";
import { listProjects, readProjectFileText } from "../persistence/project-store.js";
import { listPromptTemplates } from "../persistence/template-store.js";
import {
  clearUserMemory,
  invalidateUserMemoryCache,
  readUserMemory
} from "../persistence/user-memory-store.js";
import { clearProjectRagCache } from "../projects/project-rag.js";
import { reinitProviders } from "../providers/registry.js";
import {
  applyNtfsOwnerOnlyPermissions,
  getDataProtectionStatus,
  loadSealedApiKeysIntoRam,
  lockMasterVault,
  sealApiKeysIntoVault,
  setVaultModeOffOrDpapi,
  setupMasterPasswordVault,
  unlockMasterVault,
  unsealApiKeysToEnv,
  writePrivacySettings
} from "../security/data-protection.js";
import { normalizePrivacyShieldMode } from "../security/privacy-shield.js";
import { createLoginRateLimiter, type AuthManager } from "./auth.js";
import {
  getClientIp,
  getTransportSecurityHeaders,
  isRecord,
  readRequestBody,
  SECURITY_HEADERS,
  sendJson
} from "./http-utils.js";

const vaultUnlockLimiter = createLoginRateLimiter({
  maxAttempts: 5,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 15 * 60 * 1000
});

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function getDataDir(): string {
  return process.env.AI_COUNCIL_DATA_DIR
    ? resolve(process.env.AI_COUNCIL_DATA_DIR)
    : resolve(ROOT_DIR, "data");
}

export interface PrivacyRouteOptions {
  envPath?: string;
}

/**
 * Rotas de Privacidade, Escudo DLP & Proteção Local (LGPD):
 * - GET   /privacy/status      : estado do Escudo de Privacidade, NTFS e criptografia em repouso.
 * - PATCH /privacy/settings    : altera modo do Escudo (strict/standard/off) e criptografia em repouso (PC local).
 * - POST  /privacy/ntfs-harden : reaplica permissões NTFS exclusivas do usuário no .env e data/ (PC local).
 * - GET   /privacy/export      : portabilidade/backup completo em JSON (nunca inclui .env, chaves ou sessões).
 * - POST  /privacy/wipe        : eliminação total dos dados locais (somente PC local + confirmação explícita).
 */
export async function handlePrivacyRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  auth: AuthManager,
  options: PrivacyRouteOptions = {}
): Promise<boolean> {
  if (url.pathname === "/privacy/status" && request.method === "GET") {
    const isLocal = auth.isDirectLocalPCRequest(request);
    if (!isLocal && !auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    try {
      const protection = await getDataProtectionStatus();
      sendJson(
        response,
        200,
        {
          protection,
          isLocal
        },
        origin
      );
    } catch (error) {
      console.error("[AI Council] Erro ao ler status de privacidade:", error);
      sendJson(response, 500, { error: "Falha ao consultar proteção local." }, origin);
    }
    return true;
  }

  if (url.pathname === "/privacy/vault/unlock" && request.method === "POST") {
    if (!auth.isDirectLocalPCRequest(request)) {
      sendJson(
        response,
        403,
        {
          error:
            "O cofre local só pode ser destrancado diretamente no PC local."
        },
        origin
      );
      return true;
    }

    const clientIp = getClientIp(request);
    const gate = vaultUnlockLimiter.check(clientIp);
    if (!gate.allowed) {
      const mins = Math.ceil(gate.retryAfterSec / 60);
      sendJson(
        response,
        429,
        {
          unlocked: false,
          retryAfterSec: gate.retryAfterSec,
          error: `Muitas tentativas incorretas no cofre. Aguarde ${
            gate.retryAfterSec >= 60 ? `${mins} min` : `${gate.retryAfterSec}s`
          }.`
        },
        origin,
        { "Retry-After": String(gate.retryAfterSec) }
      );
      return true;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await readRequestBody(request));
    } catch {
      sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
      return true;
    }

    const secret =
      isRecord(payload) && typeof payload.secret === "string"
        ? payload.secret
        : isRecord(payload) && typeof payload.passphrase === "string"
          ? payload.passphrase
          : "";
    const isRecovery = Boolean(isRecord(payload) && payload.isRecovery === true);

    try {
      const res = await unlockMasterVault(secret, { isRecovery });
      vaultUnlockLimiter.reset(clientIp);
      await loadSealedApiKeysIntoRam().catch(() => {});
      reinitProviders();
      emitProvidersUpdated();
      invalidateUserMemoryCache();
      clearProjectRagCache();
      resetDebateStorageState();
      const protection = await getDataProtectionStatus();
      sendJson(
        response,
        200,
        {
          unlocked: true,
          usedRecovery: res.usedRecovery,
          protection
        },
        origin
      );
    } catch (error) {
      const fail = vaultUnlockLimiter.recordFailure(clientIp);
      if (fail.locked) {
        const mins = Math.ceil(fail.retryAfterSec / 60);
        sendJson(
          response,
          429,
          {
            unlocked: false,
            retryAfterSec: fail.retryAfterSec,
            error: `Muitas tentativas incorretas no cofre. Bloqueado por ${mins} min.`
          },
          origin,
          { "Retry-After": String(fail.retryAfterSec) }
        );
        return true;
      }
      sendJson(
        response,
        401,
        {
          unlocked: false,
          remainingAttempts: fail.remaining,
          error:
            error instanceof Error
              ? `${error.message} Restam ${fail.remaining} tentativa(s).`
              : "Senha Mestra incorreta."
        },
        origin
      );
    }
    return true;
  }

  if (url.pathname === "/privacy/vault/lock" && request.method === "POST") {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    lockMasterVault();
    reinitProviders();
    emitProvidersUpdated();
    invalidateUserMemoryCache();
    clearProjectRagCache();
    const protection = await getDataProtectionStatus();
    sendJson(response, 200, { locked: true, protection }, origin);
    return true;
  }

  if (url.pathname === "/privacy/vault/seal-keys" && request.method === "POST") {
    if (!auth.isDirectLocalPCRequest(request)) {
      sendJson(
        response,
        403,
        {
          error:
            "As chaves de API no cofre só podem ser alteradas diretamente no PC local."
        },
        origin
      );
      return true;
    }
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }
    if (!options.envPath) {
      sendJson(response, 500, { error: "Caminho do .env não configurado." }, origin);
      return true;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await readRequestBody(request));
    } catch {
      sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
      return true;
    }

    const wantSeal = isRecord(payload) && payload.seal === true;

    try {
      const result = wantSeal
        ? await sealApiKeysIntoVault(options.envPath)
        : await unsealApiKeysToEnv(options.envPath);
      reinitProviders();
      emitProvidersUpdated();
      const protection = await getDataProtectionStatus();
      sendJson(
        response,
        200,
        {
          sealed: result.sealed,
          keysCount: result.keysCount,
          protection
        },
        origin
      );
    } catch (error) {
      sendJson(
        response,
        400,
        {
          error:
            error instanceof Error
              ? error.message
              : "Falha ao atualizar cofre de chaves de API."
        },
        origin
      );
    }
    return true;
  }

  if (url.pathname === "/privacy/vault/setup-master" && request.method === "POST") {
    if (!auth.isDirectLocalPCRequest(request)) {
      sendJson(
        response,
        403,
        {
          error:
            "A Senha Mestra do cofre só pode ser configurada diretamente no PC local."
        },
        origin
      );
      return true;
    }
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await readRequestBody(request));
    } catch {
      sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
      return true;
    }

    const masterPassword =
      isRecord(payload) && typeof payload.masterPassword === "string"
        ? payload.masterPassword
        : "";
    const autoLockMinutes =
      isRecord(payload) && typeof payload.autoLockMinutes === "number"
        ? payload.autoLockMinutes
        : undefined;

    try {
      const res = await setupMasterPasswordVault(masterPassword, autoLockMinutes);
      invalidateUserMemoryCache();
      clearProjectRagCache();
      resetDebateStorageState();
      const protection = await getDataProtectionStatus();
      sendJson(
        response,
        200,
        {
          enabled: true,
          recoveryKey: res.recoveryKey,
          migratedFiles: res.migratedFiles,
          protection
        },
        origin
      );
    } catch (error) {
      sendJson(
        response,
        400,
        {
          error:
            error instanceof Error
              ? error.message
              : "Falha ao configurar Senha Mestra do cofre."
        },
        origin
      );
    }
    return true;
  }

  if (url.pathname === "/privacy/settings" && request.method === "PATCH") {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await readRequestBody(request));
    } catch {
      sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
      return true;
    }

    if (!isRecord(payload)) {
      sendJson(response, 400, { error: "Configuração inválida." }, origin);
      return true;
    }

    try {
      let migratedFiles = 0;

      if (typeof payload.shieldMode === "string") {
        await writePrivacySettings({
          shieldMode: normalizePrivacyShieldMode(payload.shieldMode)
        });
      }

      if (typeof payload.vaultAutoLockMinutes === "number") {
        if (!auth.isDirectLocalPCRequest(request)) {
          sendJson(
            response,
            403,
            {
              error:
                "O tempo de auto-bloqueio do cofre só pode ser alterado no PC local."
            },
            origin
          );
          return true;
        }
        await writePrivacySettings({
          vaultAutoLockMinutes: payload.vaultAutoLockMinutes
        });
      }

      const targetVaultMode =
        payload.vaultMode === "off" || payload.vaultMode === "dpapi"
          ? payload.vaultMode
          : typeof payload.encryptAtRest === "boolean"
            ? payload.encryptAtRest
              ? "dpapi"
              : "off"
            : null;

      if (targetVaultMode !== null) {
        if (!auth.isDirectLocalPCRequest(request)) {
          sendJson(
            response,
            403,
            {
              error:
                "A criptografia de arquivos locais só pode ser alterada diretamente no PC local."
            },
            origin
          );
          return true;
        }
        const res = await setVaultModeOffOrDpapi(targetVaultMode, {
          envPath: options.envPath
        });
        migratedFiles = res.migratedFiles;
        reinitProviders();
        emitProvidersUpdated();
        invalidateUserMemoryCache();
        clearProjectRagCache();
        resetDebateStorageState();
      }

      const protection = await getDataProtectionStatus();
      sendJson(
        response,
        200,
        {
          updated: true,
          migratedFiles,
          protection
        },
        origin
      );
    } catch (error) {
      sendJson(
        response,
        400,
        {
          error:
            error instanceof Error
              ? error.message
              : "Falha ao atualizar configurações de privacidade."
        },
        origin
      );
    }
    return true;
  }

  if (url.pathname === "/privacy/ntfs-harden" && request.method === "POST") {
    if (!auth.isDirectLocalPCRequest(request)) {
      sendJson(
        response,
        403,
        {
          error:
            "Permissões NTFS só podem ser aplicadas diretamente no PC local."
        },
        origin
      );
      return true;
    }
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    const targets = [getDataDir()];
    if (options.envPath) {
      targets.push(options.envPath);
    }
    const ntfs = await applyNtfsOwnerOnlyPermissions(targets);
    const protection = await getDataProtectionStatus();
    sendJson(
      response,
      ntfs.error ? 500 : 200,
      {
        ...ntfs,
        protection
      },
      origin
    );
    return true;
  }

  if (url.pathname === "/privacy/export" && request.method === "GET") {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    try {
      const [debates, projects, templates, userMemory] = await Promise.all([
        readDebateSessions(),
        listProjects(),
        listPromptTemplates(),
        readUserMemory()
      ]);

      const projectsWithFiles = await Promise.all(
        projects.map(async (proj) => ({
          ...proj,
          uploadedFilesContent: await Promise.all(
            proj.files.map(async (f) => ({
              id: f.id,
              name: f.name,
              kind: f.kind,
              content: (await readProjectFileText(proj.id, f.id).catch(() => "")) ?? ""
            }))
          )
        }))
      );

      const exportBundle = {
        schemaVersion: 1,
        exportedAt: new Date().toISOString(),
        notice:
          "Exportação de portabilidade/backup do AI Council. Não contém arquivo .env, chaves de API, senhas nem tokens de sessão.",
        userMemory,
        projects: projectsWithFiles,
        templates,
        debates
      };

      const body = Buffer.from(JSON.stringify(exportBundle, null, 2), "utf8");
      const dateStamp = new Date().toISOString().slice(0, 10);

      response.writeHead(200, {
        ...SECURITY_HEADERS,
        ...getTransportSecurityHeaders(request),
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": String(body.byteLength),
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="ai-council-dados-${dateStamp}.json"`
      });
      response.end(body);
    } catch (error) {
      console.error("[AI Council] Erro ao exportar dados:", error);
      sendJson(response, 500, { error: "Falha ao exportar dados locais." }, origin);
    }
    return true;
  }

  if (url.pathname === "/privacy/wipe" && request.method === "POST") {
    if (!auth.isDirectLocalPCRequest(request)) {
      sendJson(
        response,
        403,
        {
          error:
            "A eliminação total de dados locais é permitida apenas diretamente no PC local."
        },
        origin
      );
      return true;
    }

    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await readRequestBody(request));
    } catch {
      sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
      return true;
    }

    const confirmText =
      isRecord(payload) && typeof payload.confirm === "string"
        ? payload.confirm.trim()
        : "";
    if (confirmText !== "APAGAR TUDO") {
      sendJson(
        response,
        400,
        { error: 'Confirmação obrigatória: envie { "confirm": "APAGAR TUDO" }.' },
        origin
      );
      return true;
    }

    try {
      const dataDir = getDataDir();
      await Promise.all([
        rm(resolve(dataDir, "sessions"), { recursive: true, force: true }).catch(() => {}),
        rm(resolve(dataDir, "debates"), { recursive: true, force: true }).catch(() => {}),
        rm(resolve(dataDir, "debates.json"), { force: true }).catch(() => {}),
        rm(resolve(dataDir, "projects"), { recursive: true, force: true }).catch(() => {}),
        rm(resolve(dataDir, "monitor-events.json"), { force: true }).catch(() => {}),
        clearUserMemory().catch(() => {})
      ]);
      resetDebateStorageState();
      invalidateUserMemoryCache();
      clearProjectRagCache();
      auth.revokeAllSessions();

      sendJson(
        response,
        200,
        {
          wiped: true,
          message:
            "Conversas, projetos, memória pessoal, histórico e sessões remotas foram apagados. Suas chaves no .env foram preservadas."
        },
        origin
      );
    } catch (error) {
      console.error("[AI Council] Erro ao apagar dados locais:", error);
      sendJson(response, 500, { error: "Falha ao apagar dados locais." }, origin);
    }
    return true;
  }

  return false;
}
