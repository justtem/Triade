import { rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
import {
  applyNtfsOwnerOnlyPermissions,
  getDataProtectionStatus,
  setEncryptAtRestEnabled,
  writePrivacySettings
} from "../security/data-protection.js";
import { normalizePrivacyShieldMode } from "../security/privacy-shield.js";
import type { AuthManager } from "./auth.js";
import {
  getTransportSecurityHeaders,
  isRecord,
  readRequestBody,
  SECURITY_HEADERS,
  sendJson
} from "./http-utils.js";

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
    if (!auth.isAuthorizedLocalClient(request)) {
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
          isLocal: auth.isDirectLocalPCRequest(request)
        },
        origin
      );
    } catch (error) {
      console.error("[AI Council] Erro ao ler status de privacidade:", error);
      sendJson(response, 500, { error: "Falha ao consultar proteção local." }, origin);
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

      if (typeof payload.encryptAtRest === "boolean") {
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
        const res = await setEncryptAtRestEnabled(payload.encryptAtRest);
        migratedFiles = res.migratedFiles;
        invalidateUserMemoryCache();
        clearProjectRagCache();
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
