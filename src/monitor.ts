import "dotenv/config";

import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from "node:http";

import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm
} from "node:fs/promises";

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import { dirname, resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import {
  ALL_PLATFORMS,
  type AIPlatform,
  type ChatAttachment,
  type DebateSession,
  type WebSearchMode
} from "./shared/debate-types.js";
import { gatherWebContext } from "./web/web-context.js";
import {
  applyLimitSignalToDebates,
  assignDebateToProject,
  clearDeletedProjectFromDebates,
  continueDebateSession,
  createDebateSession,
  deleteDebateSession,
  getDebateSessionById,
  listDebateSummaries,
  pauseDebateManually,
  regenerateDebateResponse,
  renameDebateSession,
  resumeDebateSession,
  reviewDebateResponseWithPlatform,
  searchDebateSessions,
  stopDebateGeneration,
  submitDebateTaskResponse,
  togglePinDebateSession,
  updateSessionSharedMemoryManually
} from "./debate/debate-engine.js";
import {
  addProjectFile,
  createProject,
  deleteProject,
  getProjectById,
  listProjects,
  removeProjectFile,
  updateProject
} from "./persistence/project-store.js";
import {
  gatherProjectContext,
  inspectLinkedFolder
} from "./projects/project-rag.js";
import {
  createPromptTemplate,
  deletePromptTemplate,
  listPromptTemplates,
  updatePromptTemplate
} from "./persistence/template-store.js";
import { abortDebateTasks, kickRunner, startRunner } from "./debate/runner.js";
import { generateTurnVerdict } from "./debate/verdict.js";
import { getActiveStreams, subscribeStreamHub } from "./debate/stream-hub.js";
import { getProvidersStatus } from "./providers/registry.js";
import { transcribeAudioWithGroq } from "./providers/whisper.js";
import { synthesizeSpeechWithEdge } from "./providers/tts.js";

// ============================================
// CONFIGURAÇÃO
// ============================================

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT_DIR, "data");
const EVENTS_FILE = resolve(DATA_DIR, "monitor-events.json");
const PUBLIC_DIR = resolve(ROOT_DIR, "public");

const HOST = "127.0.0.1";
const LISTEN_HOST = process.env.HOST?.trim() || "0.0.0.0";
const PORT = Number(process.env.PORT) || 4317;

const DASHBOARD_ORIGIN = `http://${HOST}:${PORT}`;

const TOKEN = process.env.MONITOR_TOKEN;
const ACCESS_PASSWORD = process.env.ACCESS_PASSWORD?.trim() || "aicouncil2026";
const REQUIRE_PASSWORD_LOCAL = process.env.REQUIRE_PASSWORD_LOCAL === "true";

function getExpectedSessionToken(): string {
  return createHmac("sha256", TOKEN ?? "ai-council-fallback-secret")
    .update(`ai-council-session:${ACCESS_PASSWORD}`)
    .digest("hex");
}

function safeCompareString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      out[k] = decodeURIComponent(v);
    }
  }
  return out;
}

function getLocalWifiAddresses(): string[] {
  const nets = networkInterfaces();
  const ips: string[] = [];
  for (const list of Object.values(nets)) {
    if (!list) continue;
    for (const net of list) {
      if (net.family === "IPv4" && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

const MAX_BODY_SIZE = 262_144;
const MAX_MEDIA_BODY_SIZE = 10 * 1024 * 1024; // 10 MB para imagens/PDFs anexados
const MAX_HISTORY = 200;
const SERVER_DEDUP_WINDOW_MS = 30_000;

const MOZ_EXTENSION_ORIGIN_REGEX =
  /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Fontes de eventos de limite enviados pela extensão (opcional, legado).
const VALID_SOURCES = new Set<string>([
  "chatgpt",
  "claude",
  "gemini"
]);

// Participantes aceitos nos debates (automáticos e manuais).
const VALID_PARTICIPANTS = new Set<string>(ALL_PLATFORMS);

const VALID_SEVERITIES = new Set<string>([
  "warning",
  "blocked"
]);

const VALID_SIGNALS = new Set<string>([
  "usage_limit_reached",
  "approaching_usage_limit"
]);

const VALID_CONFIDENCE = new Set<string>([
  "high",
  "medium"
]);

const VALID_URLS = new Set<string>([
  "https://chatgpt.com",
  "https://claude.ai",
  "https://gemini.google.com"
]);

const EXPECTED_SIGNAL_BY_SEVERITY: Record<
  IncomingMonitorEvent["severity"],
  IncomingMonitorEvent["signal"]
> = {
  warning: "approaching_usage_limit",
  blocked: "usage_limit_reached"
};

const EXPECTED_URL_BY_SOURCE: Record<
  IncomingMonitorEvent["source"],
  string
> = {
  chatgpt: "https://chatgpt.com",
  claude: "https://claude.ai",
  gemini: "https://gemini.google.com"
};

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon"
};

// ============================================
// TIPOS
// ============================================

interface IncomingMonitorEvent {
  source: "chatgpt" | "claude" | "gemini";
  severity: "warning" | "blocked";
  signal:
    | "usage_limit_reached"
    | "approaching_usage_limit";
  confidence: "high" | "medium";
  message: string;
  matchedText: string;
  url: string;
}

interface StoredMonitorEvent {
  source: "chatgpt" | "claude" | "gemini";
  severity: "warning" | "blocked";

  signal?:
    | "usage_limit_reached"
    | "approaching_usage_limit";

  confidence?: "high" | "medium";

  message: string;
  matchedText: string;
  url: string;
  observedAt: string;
}

// ============================================
// VALIDAÇÃO
// ============================================

function isRecord(
  value: unknown
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isIncomingEvent(
  value: unknown
): value is IncomingMonitorEvent {
  if (!isRecord(value)) return false;

  const hasValidFields =
    typeof value.source === "string" &&
    VALID_SOURCES.has(value.source) &&

    typeof value.severity === "string" &&
    VALID_SEVERITIES.has(value.severity) &&

    typeof value.signal === "string" &&
    VALID_SIGNALS.has(value.signal) &&

    typeof value.confidence === "string" &&
    VALID_CONFIDENCE.has(value.confidence) &&

    typeof value.message === "string" &&
    value.message.trim().length > 0 &&
    value.message.length <= 500 &&

    typeof value.matchedText === "string" &&
    value.matchedText.trim().length > 0 &&
    value.matchedText.length <= 800 &&

    typeof value.url === "string" &&
    VALID_URLS.has(value.url);

  if (!hasValidFields) return false;

  const source = value.source as IncomingMonitorEvent["source"];
  const severity = value.severity as IncomingMonitorEvent["severity"];
  const signal = value.signal as IncomingMonitorEvent["signal"];
  const url = value.url as string;

  // Validação de consistência entre severity e signal (Problema 5)
  if (EXPECTED_SIGNAL_BY_SEVERITY[severity] !== signal) {
    return false;
  }

  // Validação de consistência entre source e url
  if (EXPECTED_URL_BY_SOURCE[source] !== url) {
    return false;
  }

  return true;
}

function isStoredEvent(
  value: unknown
): value is StoredMonitorEvent {
  if (!isRecord(value)) return false;

  const validSignal =
    value.signal === undefined ||
    (
      typeof value.signal === "string" &&
      VALID_SIGNALS.has(value.signal)
    );

  const validConfidence =
    value.confidence === undefined ||
    (
      typeof value.confidence === "string" &&
      VALID_CONFIDENCE.has(value.confidence)
    );

  return (
    typeof value.source === "string" &&
    VALID_SOURCES.has(value.source) &&

    typeof value.severity === "string" &&
    VALID_SEVERITIES.has(value.severity) &&

    validSignal &&
    validConfidence &&

    typeof value.message === "string" &&
    typeof value.matchedText === "string" &&
    typeof value.url === "string" &&
    typeof value.observedAt === "string"
  );
}

function isRecentDuplicate(
  events: StoredMonitorEvent[],
  incoming: IncomingMonitorEvent,
  nowMs: number
): StoredMonitorEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const existing = events[i];
    if (!existing) continue;

    const observedMs = Date.parse(existing.observedAt);
    if (Number.isNaN(observedMs)) continue;

    if (nowMs - observedMs > SERVER_DEDUP_WINDOW_MS) {
      break;
    }

    if (
      existing.source === incoming.source &&
      existing.severity === incoming.severity &&
      existing.signal === incoming.signal &&
      existing.matchedText === incoming.matchedText
    ) {
      return existing;
    }
  }

  return null;
}

// ============================================
// RESPOSTAS HTTP
// ============================================

function isMozExtensionOrigin(origin: string | undefined): origin is string {
  return Boolean(origin && MOZ_EXTENSION_ORIGIN_REGEX.test(origin));
}

function sendJson(
  response: ServerResponse,
  status: number,
  data: unknown,
  origin?: string
): void {
  const rawBody = Buffer.from(JSON.stringify(data), "utf8");
  const acceptEncoding = response.req?.headers["accept-encoding"];
  const useGzip =
    rawBody.byteLength > 1024 &&
    typeof acceptEncoding === "string" &&
    acceptEncoding.includes("gzip");
  const payload = useGzip ? gzipSync(rawBody) : rawBody;

  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(useGzip
      ? {
          "Content-Encoding": "gzip",
          "Vary": isMozExtensionOrigin(origin)
            ? "Origin, Accept-Encoding"
            : "Accept-Encoding"
        }
      : {}),

    ...(isMozExtensionOrigin(origin)
      ? {
          "Access-Control-Allow-Origin": origin,
          ...(!useGzip ? { "Vary": "Origin" } : {})
        }
      : {})
  });

  response.end(payload);
}

function slimDebateForDashboard(
  debate: DebateSession,
  includePendingTasks: boolean
): unknown {
  return {
    ...debate,
    ...(Array.isArray(debate.turns)
      ? {
          turns: debate.turns.map((turn) => ({
            ...turn,
            ...(Array.isArray(turn.attachments) && turn.attachments.length > 0
              ? {
                  attachments: turn.attachments.map((att) => ({
                    name: att.name,
                    size: att.size,
                    ...(att.kind ? { kind: att.kind } : {}),
                    ...(att.mimeType ? { mimeType: att.mimeType } : {}),
                    ...(att.kind === "image" && att.dataBase64
                      ? { dataBase64: att.dataBase64 }
                      : {})
                  }))
                }
              : {}),
            ...(Array.isArray(turn.webSources) && turn.webSources.length > 0
              ? {
                  webSources: turn.webSources.map((src) => ({
                    index: src.index,
                    title: src.title,
                    url: src.url,
                    domain: src.domain,
                    snippet: src.snippet,
                    origin: src.origin,
                    ...(src.fetchedOk !== undefined ? { fetchedOk: src.fetchedOk } : {})
                  }))
                }
              : {})
          }))
        }
      : {}),
    tasks: (includePendingTasks
      ? debate.tasks
      : debate.tasks.filter((task) => task.status !== "pending")
    ).map((task) => {
      const keepPrompt =
        includePendingTasks &&
        task.status === "pending" &&
        task.seat === "manual";
      return {
        id: task.id,
        ...(task.turnId ? { turnId: task.turnId } : {}),
        round: task.round,
        stage: task.stage,
        platform: task.platform,
        status: task.status,
        createdAt: task.createdAt,
        ...(task.completedAt ? { completedAt: task.completedAt } : {}),
        ...(task.seat ? { seat: task.seat } : {}),
        ...(task.role ? { role: task.role } : {}),
        ...(task.attempts !== undefined ? { attempts: task.attempts } : {}),
        ...(task.lastError ? { lastError: task.lastError } : {}),
        prompt: keepPrompt ? task.prompt : ""
      };
    }),
    responses: debate.responses.map((resp) => ({
      id: resp.id,
      ...(resp.turnId ? { turnId: resp.turnId } : {}),
      taskId: resp.taskId,
      round: resp.round,
      stage: resp.stage,
      platform: resp.platform,
      content: resp.content,
      submittedAt: resp.submittedAt,
      ...(resp.model ? { model: resp.model } : {}),
      ...(resp.tokens !== undefined ? { tokens: resp.tokens } : {})
    }))
  };
}

// ============================================
// HISTÓRICO DE EVENTOS
// ============================================

async function readEvents(): Promise<StoredMonitorEvent[]> {
  let content: string;

  try {
    content = await readFile(EVENTS_FILE, "utf8");
  } catch (error) {
    if (
      isRecord(error) &&
      error.code === "ENOENT"
    ) {
      return [];
    }

    throw error;
  }

  const cleanContent = content.replace(/^\uFEFF/, "").trim();

  if (!cleanContent) {
    return [];
  }

  const parsed: unknown = JSON.parse(cleanContent);

  if (
    !Array.isArray(parsed) ||
    !parsed.every(isStoredEvent)
  ) {
    throw new Error(
      "O arquivo de histórico possui uma estrutura inválida."
    );
  }

  return parsed;
}

// ============================================
// GRAVAÇÃO SEGURA
// ============================================

async function writeEventsAtomically(
  events: StoredMonitorEvent[]
): Promise<void> {
  const temporaryFile =
    `${EVENTS_FILE}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(
      temporaryFile,
      JSON.stringify(events.slice(-MAX_HISTORY), null, 2),
      "utf8"
    );

    await rename(temporaryFile, EVENTS_FILE);
  } finally {
    await rm(temporaryFile, { force: true }).catch(() => {});
  }
}

// ============================================
// FILA DE GRAVAÇÃO
// ============================================

let writeQueue: Promise<void> = Promise.resolve();

function withEventLock<T>(
  operation: () => Promise<T>
): Promise<T> {
  const result = writeQueue.then(
    operation,
    operation
  );

  writeQueue = result.then(
    () => undefined,
    () => undefined
  );

  return result;
}

// ============================================
// LEITURA DO CORPO HTTP
// ============================================

async function readRequestBody(
  request: IncomingMessage,
  maxBytes: number = MAX_BODY_SIZE
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalSize = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);

    totalSize += buffer.length;

    if (totalSize > maxBytes) {
      throw new Error(
        "Corpo da requisição muito grande."
      );
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

// ============================================
// VALIDAÇÃO DE ORIGEM
// ============================================

function isAllowedOrigin(
  origin: string | undefined,
  request: IncomingMessage
): boolean {
  if (!origin) return true;

  if (
    origin === DASHBOARD_ORIGIN ||
    origin === `http://localhost:${PORT}`
  ) {
    return true;
  }

  // Permite acesso same-origin via Wi-Fi local (192.168.x.x) ou túnel HTTPS (Cloudflare / localhost.run / ngrok)
  const host =
    (typeof request.headers["x-forwarded-host"] === "string"
      ? request.headers["x-forwarded-host"].split(",")[0]?.trim()
      : undefined) || request.headers.host;

  if (host) {
    if (origin === `http://${host}` || origin === `https://${host}`) {
      return true;
    }
  }

  return isMozExtensionOrigin(origin);
}

// ============================================
// AUTORIZAÇÃO DO DASHBOARD / SENHA REMOTA / TOKEN
// ============================================

function isDirectLocalPCRequest(
  request: IncomingMessage
): boolean {
  const host = request.headers.host;
  const remoteAddr = request.socket.remoteAddress ?? "";
  const isLoopbackAddr =
    remoteAddr === "127.0.0.1" ||
    remoteAddr === "::1" ||
    remoteAddr === "::ffff:127.0.0.1";

  const hasProxyHeaders = Boolean(
    request.headers["cf-connecting-ip"] ||
      request.headers["x-forwarded-for"] ||
      request.headers["x-forwarded-host"] ||
      request.headers["x-forwarded-proto"] ||
      request.headers["true-client-ip"]
  );

  const isLocalHostHeader =
    host === `${HOST}:${PORT}` || host === `localhost:${PORT}`;

  return isLoopbackAddr && isLocalHostHeader && !hasProxyHeaders;
}

function hasValidRemoteSession(request: IncomingMessage): boolean {
  const expectedSession = getExpectedSessionToken();

  const headerSession = request.headers["x-ai-council-session"];
  if (
    typeof headerSession === "string" &&
    safeCompareString(headerSession.trim(), expectedSession)
  ) {
    return true;
  }

  const cookies = parseCookies(request.headers.cookie);
  if (
    cookies.ai_council_session &&
    safeCompareString(cookies.ai_council_session, expectedSession)
  ) {
    return true;
  }

  const headerPass = request.headers["x-ai-council-password"];
  if (
    typeof headerPass === "string" &&
    safeCompareString(headerPass.trim(), ACCESS_PASSWORD)
  ) {
    return true;
  }

  return false;
}

function isDashboardRequest(
  request: IncomingMessage
): boolean {
  if (!REQUIRE_PASSWORD_LOCAL && isDirectLocalPCRequest(request)) {
    return true;
  }
  return hasValidRemoteSession(request);
}

function isAuthorizedLocalClient(
  request: IncomingMessage
): boolean {
  const suppliedToken = request.headers["x-ai-council-token"];
  const authorizedByToken =
    typeof suppliedToken === "string" &&
    TOKEN !== undefined &&
    safeCompareString(suppliedToken, TOKEN);
  const authorizedByDashboard = isDashboardRequest(request);

  return authorizedByToken || authorizedByDashboard;
}

// ============================================
// ARQUIVOS DO DASHBOARD
// ============================================

const STATIC_JS_MODULE_REGEX = /^\/js\/([a-z0-9_-]+)\.js$/;
const STATIC_ICON_REGEX = /^\/icons\/([a-z0-9_-]+\.(?:svg|png|ico))$/;

function resolveDashboardFilename(pathname: string): string | null {
  const rootFiles: Record<string, string> = {
    "/": "index.html",
    "/index.html": "index.html",
    "/offline.html": "offline.html",
    "/styles.css": "styles.css",
    "/dashboard.js": "dashboard.js",
    "/manifest.json": "manifest.json",
    "/sw.js": "sw.js",
    "/favicon.ico": "icons/ai-council.ico"
  };

  if (rootFiles[pathname]) {
    return rootFiles[pathname];
  }

  const jsMatch = pathname.match(STATIC_JS_MODULE_REGEX);
  if (jsMatch?.[1]) {
    return `js/${jsMatch[1]}.js`;
  }

  const iconMatch = pathname.match(STATIC_ICON_REGEX);
  if (iconMatch?.[1]) {
    return `icons/${iconMatch[1]}`;
  }

  return null;
}

async function serveDashboard(
  pathname: string,
  response: ServerResponse
): Promise<void> {
  const filename = resolveDashboardFilename(pathname);

  if (!filename) {
    sendJson(response, 404, {
      error: "Arquivo não encontrado."
    });
    return;
  }

  const filePath = resolve(PUBLIC_DIR, filename);

  if (!filePath.startsWith(PUBLIC_DIR + sep)) {
    sendJson(response, 403, {
      error: "Acesso negado."
    });
    return;
  }

  try {
    const content = await readFile(filePath);
    const ext = extname(filePath);
    const acceptEncoding = response.req?.headers["accept-encoding"];
    const compressible = ext !== ".png" && ext !== ".ico";
    const useGzip =
      compressible &&
      content.byteLength > 1024 &&
      typeof acceptEncoding === "string" &&
      acceptEncoding.includes("gzip");
    const payload = useGzip ? gzipSync(content) : content;

    response.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
      "Content-Length": String(payload.byteLength),
      "Cache-Control":
        ext === ".png" || ext === ".ico" || ext === ".svg"
          ? "public, max-age=86400"
          : "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(pathname === "/sw.js" ? { "Service-Worker-Allowed": "/" } : {}),
      ...(useGzip
        ? {
            "Content-Encoding": "gzip",
            "Vary": "Accept-Encoding"
          }
        : {})
    });

    response.end(payload);
  } catch {
    sendJson(response, 404, {
      error: "Arquivo não encontrado."
    });
  }
}

// ============================================
// SERVIDOR
// ============================================

async function main(): Promise<void> {
  if (!TOKEN || TOKEN.length < 32) {
    throw new Error(
      "MONITOR_TOKEN ausente ou inválido no arquivo .env."
    );
  }

  await mkdir(DATA_DIR, { recursive: true });

  const server = createServer(
    async (request, response) => {
      const origin = request.headers.origin;

      // ----------------------------------------
      // VALIDAÇÃO DA ORIGEM
      // ----------------------------------------

      if (!isAllowedOrigin(origin, request)) {
        sendJson(response, 403, {
          error: "Origem não autorizada."
        });

        return;
      }

      // ----------------------------------------
      // CORS
      // ----------------------------------------

      if (request.method === "OPTIONS") {
        if (!isMozExtensionOrigin(origin)) {
          sendJson(response, 403, {
            error: "Preflight não autorizado."
          });

          return;
        }

        response.writeHead(204, {
          "Access-Control-Allow-Origin": origin,
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers":
            "Content-Type, X-AI-Council-Token",
          "Access-Control-Max-Age": "600",
          "Vary": "Origin"
        });

        response.end();
        return;
      }

      const url = new URL(
        request.url ?? "/",
        DASHBOARD_ORIGIN
      );

      // ----------------------------------------
      // DASHBOARD
      // ----------------------------------------

      if (resolveDashboardFilename(url.pathname) !== null) {
        if (request.method !== "GET") {
          sendJson(response, 405, {
            error: "Método não permitido."
          }, origin);

          return;
        }

        await serveDashboard(url.pathname, response);
        return;
      }

      // ----------------------------------------
      // HEALTH CHECK
      // ----------------------------------------

      if (
        request.method === "GET" &&
        url.pathname === "/health"
      ) {
        sendJson(response, 200, {
          status: "online",
          service: "ai-council-usage-monitor",
          timestamp: new Date().toISOString()
        }, origin);

        return;
      }

      // ----------------------------------------
      // AUTENTICAÇÃO POR SENHA (CELULAR / HTTPS)
      // ----------------------------------------

      if (
        request.method === "GET" &&
        url.pathname === "/auth/status"
      ) {
        sendJson(response, 200, {
          authenticated: isDashboardRequest(request),
          isRemote: !isDirectLocalPCRequest(request)
        }, origin);
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/auth/login"
      ) {
        let payload: unknown;
        try {
          const body = await readRequestBody(request);
          payload = JSON.parse(body);
        } catch {
          sendJson(response, 400, {
            error: "Corpo da requisição inválido."
          }, origin);
          return;
        }

        const password =
          isRecord(payload) && typeof payload.password === "string"
            ? payload.password.trim()
            : "";

        const validPassword =
          (password.length > 0 && safeCompareString(password, ACCESS_PASSWORD)) ||
          (password.length > 0 && TOKEN !== undefined && safeCompareString(password, TOKEN));

        if (!validPassword) {
          sendJson(response, 401, {
            authenticated: false,
            error: "Senha incorreta. Confira ACCESS_PASSWORD no arquivo .env."
          }, origin);
          return;
        }

        const sessionToken = getExpectedSessionToken();
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Set-Cookie": `ai_council_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
        });
        response.end(
          JSON.stringify({
            authenticated: true,
            sessionToken
          })
        );
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/auth/logout"
      ) {
        response.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "Set-Cookie": "ai_council_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0"
        });
        response.end(JSON.stringify({ authenticated: false }));
        return;
      }

      // ----------------------------------------
      // STREAM EM TEMPO REAL (SSE: /events/stream)
      // ----------------------------------------

      if (
        request.method === "GET" &&
        url.pathname === "/events/stream"
      ) {
        const querySession = url.searchParams.get("session") ?? "";
        const authorizedByQuery =
          querySession.length > 0 &&
          safeCompareString(querySession.trim(), getExpectedSessionToken());

        if (!isAuthorizedLocalClient(request) && !authorizedByQuery) {
          sendJson(response, 401, {
            error: "Não autorizado."
          }, origin);
          return;
        }

        response.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no"
        });

        const sendSse = (eventName: string, data: unknown): void => {
          if (response.writableEnded || response.destroyed) return;
          response.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        sendSse("ready", {
          at: new Date().toISOString(),
          activeStreams: getActiveStreams()
        });

        const unsubscribe = subscribeStreamHub((evt) => {
          sendSse(evt.type, evt.data);
        });

        const heartbeat = setInterval(() => {
          if (!response.writableEnded && !response.destroyed) {
            response.write(": ping\n\n");
          }
        }, 25_000);

        request.on("close", () => {
          clearInterval(heartbeat);
          unsubscribe();
        });

        return;
      }

      // ----------------------------------------
      // STATUS, HISTÓRICO E RESUMO DE CONVERSAS
      // ----------------------------------------

      if (
        request.method === "GET" &&
        url.pathname === "/status"
      ) {
        if (!isAuthorizedLocalClient(request)) {
          sendJson(response, 401, {
            error: "Senha de acesso necessária.",
            requiresPassword: true
          }, origin);

          return;
        }

        try {
          const [events, summaries, projects] = await Promise.all([
            readEvents(),
            listDebateSummaries(),
            listProjects()
          ]);

          const activeDebatesCount = summaries.filter(
            (d) => d.status === "running"
          ).length;

          sendJson(response, 200, {
            status: "online",
            capabilities: {
              responseModes: true,
              multiTurn: true,
              streaming: true,
              lightweightStatus: true,
              projects: true
            },
            totalEvents: events.length,
            latestEvents: events.slice(-20),
            activeDebatesCount,
            debates: summaries,
            projects
          }, origin);
        } catch (error) {
          console.error(
            "[AI Council] Erro ao ler status:",
            error
          );

          sendJson(response, 500, {
            error: "Não foi possível ler o histórico ou estado."
          }, origin);
        }

        return;
      }

      // ----------------------------------------
      // TRANSCRIÇÃO DE VOZ (GROQ WHISPER)
      // ----------------------------------------

      if (
        request.method === "POST" &&
        url.pathname === "/audio/transcribe"
      ) {
        if (!isAuthorizedLocalClient(request)) {
          sendJson(response, 401, {
            error: "Não autorizado."
          }, origin);
          return;
        }

        let payload: unknown;
        try {
          const body = await readRequestBody(request, MAX_MEDIA_BODY_SIZE);
          payload = JSON.parse(body);
        } catch {
          sendJson(response, 400, {
            error: "Áudio inválido ou grande demais (máx. 10 MB)."
          }, origin);
          return;
        }

        if (!isRecord(payload) || typeof payload.audioBase64 !== "string") {
          sendJson(response, 400, {
            error: "Campo audioBase64 obrigatório."
          }, origin);
          return;
        }

        try {
          const result = await transcribeAudioWithGroq({
            audioBase64: payload.audioBase64,
            mimeType:
              typeof payload.mimeType === "string"
                ? payload.mimeType
                : undefined,
            language:
              typeof payload.language === "string"
                ? payload.language
                : "pt"
          });

          console.log(
            `[AI Council] Voz transcrita (${result.model}): ${result.text.slice(0, 80)}`
          );

          sendJson(response, 200, {
            text: result.text,
            model: result.model
          }, origin);
        } catch (error) {
          sendJson(response, 400, {
            error:
              error instanceof Error
                ? error.message
                : "Falha ao transcrever o áudio."
          }, origin);
        }

        return;
      }

      // ----------------------------------------
      // SÍNTESE DE VOZ NEURAL POR IA (EDGE TTS)
      // ----------------------------------------

      if (
        request.method === "POST" &&
        url.pathname === "/audio/speak"
      ) {
        if (!isAuthorizedLocalClient(request)) {
          sendJson(response, 401, {
            error: "Não autorizado."
          }, origin);
          return;
        }

        let payload: unknown;
        try {
          const body = await readRequestBody(request, MAX_BODY_SIZE);
          payload = JSON.parse(body);
        } catch {
          sendJson(response, 400, {
            error: "Corpo da requisição inválido."
          }, origin);
          return;
        }

        if (!isRecord(payload) || typeof payload.text !== "string") {
          sendJson(response, 400, {
            error: "Campo text obrigatório."
          }, origin);
          return;
        }

        try {
          const result = await synthesizeSpeechWithEdge({
            text: payload.text,
            persona:
              typeof payload.persona === "string" ? payload.persona : undefined,
            voiceKey:
              typeof payload.voiceKey === "string"
                ? payload.voiceKey
                : undefined
          });

          const headers: Record<string, string> = {
            "Content-Type": result.contentType,
            "Content-Length": String(result.audioBuffer.byteLength),
            "Cache-Control": "no-store",
            "X-TTS-Voice": result.voice,
            "X-TTS-Cached": result.cached ? "1" : "0",
            "X-Content-Type-Options": "nosniff"
          };
          if (origin && isAllowedOrigin(origin, request)) {
            headers["Access-Control-Allow-Origin"] = origin;
            headers["Vary"] = "Origin";
          }

          response.writeHead(200, headers);
          response.end(result.audioBuffer);
        } catch (error) {
          console.warn(
            "[AI Council] Edge Neural TTS falhou:",
            error instanceof Error ? error.message : error
          );
          sendJson(response, 502, {
            error:
              error instanceof Error
                ? error.message
                : "Falha ao gerar áudio neural."
          }, origin);
        }

        return;
      }

      // ----------------------------------------
      // PROVEDORES (API) E USO DIÁRIO
      // ----------------------------------------

      if (
        request.method === "GET" &&
        url.pathname === "/providers"
      ) {
        if (!isAuthorizedLocalClient(request)) {
          sendJson(response, 401, {
            error: "Não autorizado."
          }, origin);

          return;
        }

        try {
          sendJson(response, 200, {
            providers: await getProvidersStatus()
          }, origin);
        } catch (error) {
          console.error("[AI Council] Erro ao ler provedores:", error);

          sendJson(response, 500, {
            error: "Não foi possível ler o estado dos provedores."
          }, origin);
        }

        return;
      }

      // ----------------------------------------
      // PROJETOS / PASTAS COM CÉREBRO LOCAL (/projects)
      // ----------------------------------------

      if (url.pathname === "/projects") {
        if (!isAuthorizedLocalClient(request)) {
          sendJson(response, 401, { error: "Não autorizado." }, origin);
          return;
        }

        if (request.method === "GET") {
          try {
            const projects = await listProjects();
            sendJson(response, 200, { projects }, origin);
          } catch (error) {
            console.error("[AI Council] Erro ao listar projetos:", error);
            sendJson(response, 500, { error: "Falha ao listar projetos." }, origin);
          }
          return;
        }

        if (request.method === "POST") {
          let payload: unknown;
          try {
            payload = JSON.parse(await readRequestBody(request));
          } catch {
            sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
            return;
          }

          if (!isRecord(payload)) {
            sendJson(response, 400, { error: "Dados do projeto inválidos." }, origin);
            return;
          }

          try {
            const created = await createProject({
              name: typeof payload.name === "string" ? payload.name : "",
              description:
                typeof payload.description === "string"
                  ? payload.description
                  : undefined,
              color:
                typeof payload.color === "string" ? payload.color : undefined,
              instructions:
                typeof payload.instructions === "string"
                  ? payload.instructions
                  : "",
              linkedFolderPath:
                typeof payload.linkedFolderPath === "string"
                  ? payload.linkedFolderPath
                  : undefined
            });
            const projects = await listProjects();
            sendJson(response, 201, { created: true, project: created, projects }, origin);
          } catch (error) {
            sendJson(
              response,
              400,
              {
                error:
                  error instanceof Error
                    ? error.message
                    : "Não foi possível criar o projeto."
              },
              origin
            );
          }
          return;
        }
      }

      if (
        request.method === "POST" &&
        url.pathname === "/projects/inspect-folder"
      ) {
        if (!isAuthorizedLocalClient(request)) {
          sendJson(response, 401, { error: "Não autorizado." }, origin);
          return;
        }

        let payload: unknown;
        try {
          payload = JSON.parse(await readRequestBody(request));
        } catch {
          sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
          return;
        }

        const folderPath =
          isRecord(payload) && typeof payload.path === "string"
            ? payload.path
            : "";

        try {
          const inspection = await inspectLinkedFolder(folderPath);
          sendJson(response, 200, { inspection }, origin);
        } catch (error) {
          sendJson(
            response,
            400,
            {
              error:
                error instanceof Error
                  ? error.message
                  : "Falha ao inspecionar pasta."
            },
            origin
          );
        }
        return;
      }

      const projectFileMatch = url.pathname.match(
        /^\/projects\/([a-zA-Z0-9_-]{6,64})\/files(?:\/([a-zA-Z0-9_-]{6,64})(?:\/(delete))?)?$/
      );

      if (projectFileMatch) {
        if (!isAuthorizedLocalClient(request)) {
          sendJson(response, 401, { error: "Não autorizado." }, origin);
          return;
        }

        const projectId = projectFileMatch[1] ?? "";
        const fileId = projectFileMatch[2] ?? "";
        const fileAction = projectFileMatch[3] ?? "";

        if (!fileId && request.method === "POST") {
          let payload: unknown;
          try {
            payload = JSON.parse(await readRequestBody(request, MAX_MEDIA_BODY_SIZE));
          } catch {
            sendJson(
              response,
              400,
              { error: "Arquivo inválido ou grande demais (máx. 10 MB)." },
              origin
            );
            return;
          }

          if (!isRecord(payload)) {
            sendJson(response, 400, { error: "Dados do arquivo inválidos." }, origin);
            return;
          }

          try {
            const { project, file } = await addProjectFile(projectId, {
              name: typeof payload.name === "string" ? payload.name : "",
              kind: payload.kind === "pdf" ? "pdf" : "text",
              mimeType:
                typeof payload.mimeType === "string" ? payload.mimeType : undefined,
              content:
                typeof payload.content === "string" ? payload.content : undefined,
              dataBase64:
                typeof payload.dataBase64 === "string"
                  ? payload.dataBase64
                  : undefined,
              size: typeof payload.size === "number" ? payload.size : undefined
            });
            const projects = await listProjects();
            sendJson(response, 201, { uploaded: true, file, project, projects }, origin);
          } catch (error) {
            sendJson(
              response,
              400,
              {
                error:
                  error instanceof Error
                    ? error.message
                    : "Falha ao adicionar arquivo ao projeto."
              },
              origin
            );
          }
          return;
        }

        if (
          fileId &&
          (request.method === "DELETE" ||
            (request.method === "POST" && fileAction === "delete"))
        ) {
          try {
            const project = await removeProjectFile(projectId, fileId);
            if (!project) {
              sendJson(response, 404, { error: "Arquivo não encontrado." }, origin);
              return;
            }
            const projects = await listProjects();
            sendJson(response, 200, { deleted: true, project, projects }, origin);
          } catch (error) {
            sendJson(
              response,
              500,
              { error: "Falha ao remover arquivo do projeto." },
              origin
            );
          }
          return;
        }
      }

      const projectItemMatch = url.pathname.match(
        /^\/projects\/([a-zA-Z0-9_-]{6,64})(?:\/(update|delete))?$/
      );

      if (projectItemMatch) {
        if (!isAuthorizedLocalClient(request)) {
          sendJson(response, 401, { error: "Não autorizado." }, origin);
          return;
        }

        const projectId = projectItemMatch[1] ?? "";
        const subAction = projectItemMatch[2] ?? "";

        if (!subAction && request.method === "GET") {
          const project = await getProjectById(projectId);
          if (!project) {
            sendJson(response, 404, { error: "Projeto não encontrado." }, origin);
            return;
          }
          sendJson(response, 200, { project }, origin);
          return;
        }

        if (
          request.method === "DELETE" ||
          (request.method === "POST" && subAction === "delete")
        ) {
          try {
            const deleted = await deleteProject(projectId);
            if (!deleted) {
              sendJson(response, 404, { error: "Projeto não encontrado." }, origin);
              return;
            }
            await clearDeletedProjectFromDebates(projectId);
            const projects = await listProjects();
            sendJson(response, 200, { deleted: true, id: projectId, projects }, origin);
          } catch (error) {
            sendJson(response, 500, { error: "Falha ao excluir projeto." }, origin);
          }
          return;
        }

        if (
          request.method === "PATCH" ||
          (request.method === "POST" && subAction === "update")
        ) {
          let payload: unknown;
          try {
            payload = JSON.parse(await readRequestBody(request));
          } catch {
            sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
            return;
          }
          if (!isRecord(payload)) {
            sendJson(response, 400, { error: "Dados do projeto inválidos." }, origin);
            return;
          }

          try {
            const updated = await updateProject(projectId, {
              ...(typeof payload.name === "string" ? { name: payload.name } : {}),
              ...(typeof payload.description === "string"
                ? { description: payload.description }
                : {}),
              ...(typeof payload.color === "string" ? { color: payload.color } : {}),
              ...(typeof payload.instructions === "string"
                ? { instructions: payload.instructions }
                : {}),
              ...(typeof payload.linkedFolderPath === "string"
                ? { linkedFolderPath: payload.linkedFolderPath }
                : {})
            });
            const projects = await listProjects();
            sendJson(response, 200, { updated: true, project: updated, projects }, origin);
          } catch (error) {
            const msg =
              error instanceof Error ? error.message : "Erro ao atualizar projeto.";
            sendJson(
              response,
              msg.includes("não encontrado") ? 404 : 400,
              { error: msg },
              origin
            );
          }
          return;
        }
      }

      // ----------------------------------------
      // TEMPLATES DE PROMPT (/templates)
      // ----------------------------------------

      if (url.pathname === "/templates") {
        if (!isAuthorizedLocalClient(request)) {
          sendJson(response, 401, { error: "Não autorizado." }, origin);
          return;
        }

        if (request.method === "GET") {
          try {
            const templates = await listPromptTemplates();
            sendJson(response, 200, { templates }, origin);
          } catch (error) {
            console.error("[AI Council] Erro ao listar templates:", error);
            sendJson(response, 500, { error: "Falha ao listar templates." }, origin);
          }
          return;
        }

        if (request.method === "POST") {
          let payload: unknown;
          try {
            payload = JSON.parse(await readRequestBody(request));
          } catch {
            sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
            return;
          }

          if (!isRecord(payload)) {
            sendJson(response, 400, { error: "Dados do template inválidos." }, origin);
            return;
          }

          try {
            const created = await createPromptTemplate({
              tag: typeof payload.tag === "string" ? payload.tag : undefined,
              title: typeof payload.title === "string" ? payload.title : "",
              prompt: typeof payload.prompt === "string" ? payload.prompt : "",
              rules: typeof payload.rules === "string" ? payload.rules : undefined,
              focus:
                payload.focus === "backend" || payload.focus === "frontend"
                  ? payload.focus
                  : "geral",
              responseMode:
                payload.responseMode === "prompt_markdown"
                  ? "prompt_markdown"
                  : "normal",
              interactionMode:
                payload.interactionMode === "debate" ? "debate" : "direct"
            });
            sendJson(response, 201, { created: true, template: created }, origin);
          } catch (error) {
            sendJson(
              response,
              400,
              {
                error:
                  error instanceof Error
                    ? error.message
                    : "Não foi possível salvar o template."
              },
              origin
            );
          }
          return;
        }
      }

      const templateItemMatch = url.pathname.match(
        /^\/templates\/([a-zA-Z0-9_-]{4,64})(?:\/(update|delete))?$/
      );

      if (templateItemMatch) {
        if (!isAuthorizedLocalClient(request)) {
          sendJson(response, 401, { error: "Não autorizado." }, origin);
          return;
        }

        const tplId = templateItemMatch[1] ?? "";
        const subAction = templateItemMatch[2] ?? "";

        if (
          request.method === "DELETE" ||
          (request.method === "POST" && subAction === "delete")
        ) {
          try {
            const deleted = await deletePromptTemplate(tplId);
            if (!deleted) {
              sendJson(response, 404, { error: "Template não encontrado." }, origin);
              return;
            }
            sendJson(response, 200, { deleted: true, id: tplId }, origin);
          } catch (error) {
            sendJson(response, 500, { error: "Falha ao excluir template." }, origin);
          }
          return;
        }

        if (
          request.method === "PATCH" ||
          (request.method === "POST" && subAction === "update")
        ) {
          let payload: unknown;
          try {
            payload = JSON.parse(await readRequestBody(request));
          } catch {
            sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
            return;
          }
          if (!isRecord(payload)) {
            sendJson(response, 400, { error: "Dados do template inválidos." }, origin);
            return;
          }

          try {
            const updated = await updatePromptTemplate(tplId, {
              tag: typeof payload.tag === "string" ? payload.tag : undefined,
              title: typeof payload.title === "string" ? payload.title : "",
              prompt: typeof payload.prompt === "string" ? payload.prompt : "",
              rules: typeof payload.rules === "string" ? payload.rules : undefined,
              focus:
                payload.focus === "backend" || payload.focus === "frontend"
                  ? payload.focus
                  : "geral",
              responseMode:
                payload.responseMode === "prompt_markdown"
                  ? "prompt_markdown"
                  : "normal",
              interactionMode:
                payload.interactionMode === "debate" ? "debate" : "direct"
            });
            sendJson(response, 200, { updated: true, template: updated }, origin);
          } catch (error) {
            const msg =
              error instanceof Error ? error.message : "Erro ao atualizar template.";
            sendJson(
              response,
              msg.includes("não encontrado") ? 404 : 400,
              { error: msg },
              origin
            );
          }
          return;
        }
      }

      // ----------------------------------------
      // BUSCA FULL-TEXT DE CONVERSAS (/debates/search)
      // ----------------------------------------

      if (request.method === "GET" && url.pathname === "/debates/search") {
        if (!isAuthorizedLocalClient(request)) {
          sendJson(response, 401, { error: "Não autorizado." }, origin);
          return;
        }

        const q = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
        try {
          const matchingIds = q ? await searchDebateSessions(q) : [];
          sendJson(response, 200, { query: q, matchingIds }, origin);
        } catch (error) {
          console.error("[AI Council] Erro ao buscar conversas:", error);
          sendJson(response, 500, { error: "Falha ao buscar conversas." }, origin);
        }
        return;
      }

      // ----------------------------------------
      // DETALHE DE UMA CONVERSA (/debates/:id)
      // ----------------------------------------

      const debateDetailMatch = url.pathname.match(
        /^\/debates\/([0-9a-fA-F-]{8,64})$/
      );

      if (debateDetailMatch && request.method === "GET") {
        if (!isAuthorizedLocalClient(request)) {
          sendJson(response, 401, {
            error: "Não autorizado."
          }, origin);
          return;
        }

        const debateId = debateDetailMatch[1] ?? "";
        try {
          const session = await getDebateSessionById(debateId);
          if (!session) {
            sendJson(response, 404, {
              error: "Conversa não encontrada."
            }, origin);
            return;
          }

          const includePending = isDashboardRequest(request);
          sendJson(
            response,
            200,
            {
              debate: slimDebateForDashboard(session, includePending),
              activeStreams: getActiveStreams(debateId)
            },
            origin
          );
        } catch (error) {
          console.error("[AI Council] Erro ao ler conversa:", error);
          sendJson(response, 500, {
            error: "Falha ao carregar a conversa."
          }, origin);
        }
        return;
      }

      if (debateDetailMatch && request.method === "PATCH") {
        if (!isAuthorizedLocalClient(request)) {
          sendJson(response, 401, {
            error: "Não autorizado."
          }, origin);
          return;
        }

        const debateId = debateDetailMatch[1] ?? "";
        let payload: unknown;
        try {
          const body = await readRequestBody(request);
          payload = JSON.parse(body);
        } catch {
          sendJson(response, 400, {
            error: "Corpo da requisição inválido."
          }, origin);
          return;
        }

        const pinnedValue =
          isRecord(payload) && typeof payload.pinned === "boolean"
            ? payload.pinned
            : undefined;
        const hasProjectField =
          isRecord(payload) &&
          Object.prototype.hasOwnProperty.call(payload, "projectId");
        const projectIdValue =
          hasProjectField && isRecord(payload) && typeof payload.projectId === "string"
            ? payload.projectId
            : null;
        const title =
          isRecord(payload) && typeof payload.title === "string"
            ? payload.title
            : "";

        try {
          const updated = hasProjectField && !title
            ? await assignDebateToProject(debateId, projectIdValue)
            : typeof pinnedValue === "boolean" && !title
              ? await togglePinDebateSession(debateId, pinnedValue)
              : await renameDebateSession(debateId, title);
          sendJson(
            response,
            200,
            {
              updated: true,
              debate: slimDebateForDashboard(updated, isDashboardRequest(request))
            },
            origin
          );
        } catch (error) {
          const msg =
            error instanceof Error ? error.message : "Erro ao renomear conversa.";
          sendJson(
            response,
            msg.includes("não encontrada") ? 404 : 400,
            { error: msg },
            origin
          );
        }
        return;
      }

      if (debateDetailMatch && request.method === "DELETE") {
        if (!isAuthorizedLocalClient(request)) {
          sendJson(response, 401, {
            error: "Não autorizado."
          }, origin);
          return;
        }

        const debateId = debateDetailMatch[1] ?? "";
        try {
          const deleted = await deleteDebateSession(debateId);
          if (!deleted) {
            sendJson(response, 404, {
              error: "Conversa não encontrada."
            }, origin);
            return;
          }

          sendJson(response, 200, {
            deleted: true,
            id: debateId
          }, origin);
        } catch (error) {
          console.error("[AI Council] Erro ao excluir conversa:", error);
          sendJson(response, 500, {
            error: "Falha ao excluir a conversa."
          }, origin);
        }
        return;
      }

      // ----------------------------------------
      // LISTAR OU CRIAR DEBATES (/debates)
      // ----------------------------------------

      if (url.pathname === "/debates") {
        if (!isAuthorizedLocalClient(request)) {
          sendJson(response, 401, {
            error: "Não autorizado."
          }, origin);

          return;
        }

        if (request.method === "GET") {
          try {
            const summaries = await listDebateSummaries();
            sendJson(
              response,
              200,
              {
                debates: summaries
              },
              origin
            );
          } catch (error) {
            console.error("[AI Council] Erro ao listar debates:", error);
            sendJson(response, 500, {
              error: "Falha ao listar debates."
            }, origin);
          }
          return;
        }

        if (request.method === "POST") {
          let payload: unknown;

          try {
            const body = await readRequestBody(request, MAX_MEDIA_BODY_SIZE);
            payload = JSON.parse(body);
          } catch {
            sendJson(response, 400, {
              error: "Corpo da requisição inválido."
            }, origin);
            return;
          }

          if (!isRecord(payload)) {
            sendJson(response, 400, {
              error: "Dados do debate inválidos."
            }, origin);
            return;
          }

          const rawParticipants = Array.isArray(payload.participants)
            ? payload.participants.filter(
                (p): p is AIPlatform =>
                  typeof p === "string" && VALID_PARTICIPANTS.has(p)
              )
            : [];

          const rawAttachments = Array.isArray(payload.attachments)
            ? (payload.attachments as ChatAttachment[])
            : undefined;
          const webSearchMode: WebSearchMode =
            payload.webSearchMode === "off" ? "off" : "auto";
          const topicStr = typeof payload.topic === "string" ? payload.topic : "";
          const projectId =
            typeof payload.projectId === "string" && payload.projectId.trim()
              ? payload.projectId.trim()
              : undefined;

          try {
            const [webSources, resolvedProjectContext] = await Promise.all([
              gatherWebContext(topicStr, {
                mode: webSearchMode,
                hasAttachments: Boolean(rawAttachments && rawAttachments.length > 0)
              }).catch(() => []),
              gatherProjectContext(projectId, topicStr).catch(() => null)
            ]);

            const session = await createDebateSession({
              title: typeof payload.title === "string" ? payload.title : "",
              topic: topicStr,
              rules: typeof payload.rules === "string" ? payload.rules : undefined,
              participants: rawParticipants,
              totalRounds: Number(payload.totalRounds) || 2,
              focus:
                payload.focus === "backend" || payload.focus === "frontend"
                  ? payload.focus
                  : "geral",
              responseMode:
                payload.responseMode === "normal"
                  ? "normal"
                  : "prompt_markdown",
              interactionMode:
                payload.interactionMode === "direct" ? "direct" : "debate",
              webSearchMode,
              attachments: rawAttachments,
              webSources,
              ...(projectId && resolvedProjectContext ? { projectId } : {}),
              ...(resolvedProjectContext ? { resolvedProjectContext } : {})
            });

            console.log(
              "[AI Council] Sessão criada:",
              session.id,
              session.title,
              `(${session.responseMode}/${session.interactionMode})`
            );

            // Os assentos automáticos começam a responder imediatamente.
            kickRunner();

            sendJson(response, 201, {
              created: true,
              debate: slimDebateForDashboard(session, true)
            }, origin);
          } catch (error) {
            sendJson(response, 400, {
              error:
                error instanceof Error
                  ? error.message
                  : "Não foi possível criar a conversa."
            }, origin);
          }

          return;
        }
      }

      // ----------------------------------------
      // AÇÕES EM UM DEBATE (/debates/:id/:action)
      // ----------------------------------------

      const debateActionMatch = url.pathname.match(
        /^\/debates\/([0-9a-fA-F-]{8,64})\/(respond|pause|stop|resume|message|regenerate|review|verdict|memory|rename|delete|pin|project)$/
      );

      if (debateActionMatch && request.method === "POST") {
        if (!isAuthorizedLocalClient(request)) {
          sendJson(response, 401, {
            error: "Não autorizado."
          }, origin);

          return;
        }

        const debateId = debateActionMatch[1] ?? "";
        const action = debateActionMatch[2] ?? "";

        let payload: Record<string, unknown> = {};

        try {
          const body = await readRequestBody(
            request,
            action === "message" ? MAX_MEDIA_BODY_SIZE : MAX_BODY_SIZE
          );
          if (body.trim()) {
            const parsed: unknown = JSON.parse(body);
            if (isRecord(parsed)) {
              payload = parsed;
            }
          }
        } catch {
          sendJson(response, 400, {
            error: "Corpo da requisição inválido."
          }, origin);
          return;
        }

        try {
          if (action === "message") {
            const rawParticipants = Array.isArray(payload.participants)
              ? payload.participants.filter(
                  (p): p is AIPlatform =>
                    typeof p === "string" && VALID_PARTICIPANTS.has(p)
                )
              : [];

            const rawAttachments = Array.isArray(payload.attachments)
              ? (payload.attachments as ChatAttachment[])
              : undefined;
            const webSearchMode: WebSearchMode =
              payload.webSearchMode === "off" ? "off" : "auto";
            const messageStr =
              typeof payload.message === "string" ? payload.message : "";

            const existingSession = await getDebateSessionById(debateId).catch(() => null);
            const activeProjectId = existingSession?.projectId;

            const [webSources, resolvedProjectContext] = await Promise.all([
              gatherWebContext(messageStr, {
                mode: webSearchMode,
                hasAttachments: Boolean(rawAttachments && rawAttachments.length > 0)
              }).catch(() => []),
              gatherProjectContext(activeProjectId, messageStr).catch(() => null)
            ]);

            const updated = await continueDebateSession(debateId, {
              message: messageStr,
              rules:
                typeof payload.rules === "string" ? payload.rules : undefined,
              participants: rawParticipants,
              totalRounds: Number(payload.totalRounds) || 2,
              focus:
                payload.focus === "backend" || payload.focus === "frontend"
                  ? payload.focus
                  : "geral",
              responseMode:
                payload.responseMode === "normal"
                  ? "normal"
                  : "prompt_markdown",
              interactionMode:
                payload.interactionMode === "direct" ? "direct" : "debate",
              webSearchMode,
              attachments: rawAttachments,
              webSources,
              ...(resolvedProjectContext ? { resolvedProjectContext } : {})
            });

            kickRunner();

            sendJson(response, 200, {
              updated: true,
              debate: slimDebateForDashboard(updated, true)
            }, origin);
            return;
          }

          if (action === "regenerate") {
            const responseId =
              typeof payload.responseId === "string" ? payload.responseId : "";

            const updated = await regenerateDebateResponse(debateId, responseId);
            kickRunner();

            sendJson(response, 200, {
              updated: true,
              debate: slimDebateForDashboard(updated, true)
            }, origin);
            return;
          }

          if (action === "review") {
            const responseId =
              typeof payload.responseId === "string" ? payload.responseId : "";
            const reviewer =
              typeof payload.reviewer === "string" &&
              VALID_PARTICIPANTS.has(payload.reviewer)
                ? (payload.reviewer as AIPlatform)
                : null;

            if (!reviewer) {
              sendJson(response, 400, {
                error: "Selecione uma IA válida para revisar."
              }, origin);
              return;
            }

            const updated = await reviewDebateResponseWithPlatform(
              debateId,
              responseId,
              reviewer
            );
            kickRunner();

            sendJson(response, 200, {
              updated: true,
              debate: slimDebateForDashboard(updated, true)
            }, origin);
            return;
          }

          if (action === "verdict") {
            const turnId =
              typeof payload.turnId === "string" && payload.turnId.trim()
                ? payload.turnId.trim()
                : undefined;
            const judge =
              payload.judge === "gemini" ||
              payload.judge === "groq" ||
              payload.judge === "openrouter"
                ? payload.judge
                : undefined;

            const { debate: updated, verdict } = await generateTurnVerdict(
              debateId,
              { turnId, judge }
            );

            sendJson(response, 200, {
              updated: true,
              verdict,
              debate: slimDebateForDashboard(updated, true)
            }, origin);
            return;
          }

          if (action === "memory") {
            const summary =
              typeof payload.summary === "string" ? payload.summary : "";

            const updated = await updateSessionSharedMemoryManually(
              debateId,
              summary
            );

            sendJson(response, 200, {
              updated: true,
              debate: slimDebateForDashboard(updated, true)
            }, origin);
            return;
          }

          if (action === "respond") {
            const taskId =
              typeof payload.taskId === "string" ? payload.taskId : "";
            const content =
              typeof payload.content === "string" ? payload.content : "";

            const updated = await submitDebateTaskResponse(debateId, {
              taskId,
              content
            });

            // Se a próxima etapa tiver assentos automáticos, o runner assume.
            kickRunner();

            sendJson(response, 200, {
              updated: true,
              debate: slimDebateForDashboard(updated, true)
            }, origin);
            return;
          }

          if (action === "stop") {
            const partials = abortDebateTasks(debateId);
            const updated = await stopDebateGeneration(debateId, partials);

            sendJson(response, 200, {
              stopped: true,
              debate: slimDebateForDashboard(updated, true)
            }, origin);
            return;
          }

          if (action === "pause") {
            abortDebateTasks(debateId);
            const reason =
              typeof payload.reason === "string"
                ? payload.reason
                : undefined;

            const updated = await pauseDebateManually(debateId, reason);

            sendJson(response, 200, {
              updated: true,
              debate: slimDebateForDashboard(updated, true)
            }, origin);
            return;
          }

          if (action === "resume") {
            const updated = await resumeDebateSession(debateId);

            kickRunner();

            sendJson(response, 200, {
              updated: true,
              debate: slimDebateForDashboard(updated, true)
            }, origin);
            return;
          }

          if (action === "rename") {
            const title =
              typeof payload.title === "string" ? payload.title : "";
            const updated = await renameDebateSession(debateId, title);

            sendJson(response, 200, {
              updated: true,
              debate: slimDebateForDashboard(updated, true)
            }, origin);
            return;
          }

          if (action === "pin") {
            const pinned =
              typeof payload.pinned === "boolean" ? payload.pinned : undefined;
            const updated = await togglePinDebateSession(debateId, pinned);

            sendJson(response, 200, {
              updated: true,
              debate: slimDebateForDashboard(updated, true)
            }, origin);
            return;
          }

          if (action === "project") {
            const nextProjectId =
              typeof payload.projectId === "string" && payload.projectId.trim()
                ? payload.projectId.trim()
                : null;
            const updated = await assignDebateToProject(debateId, nextProjectId);

            sendJson(response, 200, {
              updated: true,
              debate: slimDebateForDashboard(updated, true)
            }, origin);
            return;
          }

          if (action === "delete") {
            const deleted = await deleteDebateSession(debateId);
            if (!deleted) {
              sendJson(response, 404, {
                error: "Conversa não encontrada."
              }, origin);
              return;
            }

            sendJson(response, 200, {
              deleted: true,
              id: debateId
            }, origin);
            return;
          }
        } catch (error) {
          sendJson(response, 400, {
            error:
              error instanceof Error
                ? error.message
                : "Erro ao atualizar o debate."
          }, origin);
          return;
        }
      }

      // ----------------------------------------
      // RECEBIMENTO DE EVENTOS DE LIMITE
      // ----------------------------------------

      if (
        request.method === "POST" &&
        url.pathname === "/events"
      ) {
        if (
          request.headers["x-ai-council-token"] !== TOKEN
        ) {
          sendJson(response, 401, {
            error: "Não autorizado."
          }, origin);

          return;
        }

        let event: unknown;

        try {
          const body = await readRequestBody(request);
          event = JSON.parse(body);
        } catch {
          sendJson(response, 400, {
            error: "Corpo da requisição inválido."
          }, origin);

          return;
        }

        if (!isIncomingEvent(event)) {
          sendJson(response, 400, {
            error: "Evento inválido ou campos incompatíveis."
          }, origin);

          return;
        }

        try {
          const result = await withEventLock(
            async () => {
              const events = await readEvents();
              const now = new Date();

              const duplicate = isRecentDuplicate(
                events,
                event,
                now.getTime()
              );

              if (duplicate) {
                return {
                  deduplicated: true,
                  event: duplicate
                };
              }

              const newEvent: StoredMonitorEvent = {
                ...event,
                observedAt: now.toISOString()
              };

              events.push(newEvent);

              await writeEventsAtomically(events);

              return {
                deduplicated: false,
                event: newEvent
              };
            }
          );

          // Proteção financeira e controle de sessão (Seção 2 e Seção 12):
          // Propaga o sinal de limite para pausar debates ativos caso severity === "blocked".
          const debateImpact = await applyLimitSignalToDebates(
            result.event.source,
            result.event.severity,
            result.event.matchedText,
            result.event.observedAt
          );

          if (debateImpact.pausedDebateIds.length > 0) {
            console.warn(
              "[AI Council] Debates pausados automaticamente por limite atingido:",
              debateImpact.pausedDebateIds.join(", ")
            );
          }

          if (result.deduplicated) {
            console.log(
              "[AI Council] Evento duplicado ignorado:",
              result.event.source,
              result.event.severity,
              result.event.signal
            );

            sendJson(response, 200, {
              saved: true,
              deduplicated: true,
              pausedDebates: debateImpact.pausedDebateIds,
              event: result.event
            }, origin);

            return;
          }

          console.log(
            "[AI Council] Evento armazenado:",
            result.event.source,
            result.event.severity,
            result.event.signal
          );

          sendJson(response, 201, {
            saved: true,
            pausedDebates: debateImpact.pausedDebateIds,
            event: result.event
          }, origin);
        } catch (error) {
          console.error(
            "[AI Council] Erro ao salvar evento:",
            error
          );

          sendJson(response, 500, {
            error: "Não foi possível salvar o evento."
          }, origin);
        }

        return;
      }

      // ----------------------------------------
      // ROTA NÃO ENCONTRADA
      // ----------------------------------------

      sendJson(response, 404, {
        error: "Rota não encontrada."
      }, origin);
    }
  );

  server.listen(PORT, LISTEN_HOST, () => {
    const wifiIps = getLocalWifiAddresses();
    console.log("==========================================================");
    console.log(`AI Council ativo!`);
    console.log(`• No PC (Local):       http://${HOST}:${PORT}`);
    if (wifiIps.length > 0) {
      for (const ip of wifiIps) {
        console.log(`• No Celular (Wi-Fi):  http://${ip}:${PORT}`);
      }
    }
    console.log(`• À distância (HTTPS): execute 'npm.cmd run tunnel' em outro terminal`);
    console.log(`• Senha no celular:    ${ACCESS_PASSWORD} (configurável em ACCESS_PASSWORD no .env)`);
    console.log("==========================================================");

    // Assentos automáticos (Gemini, Groq, OpenRouter) respondem sozinhos.
    startRunner();
  });
}

// ============================================
// INICIALIZAÇÃO
// ============================================

main().catch((error: unknown) => {
  console.error(
    "Falha ao iniciar monitor:",
    error instanceof Error
      ? error.message
      : "Erro desconhecido"
  );

  process.exitCode = 1;
});
