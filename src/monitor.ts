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
  type DebateSession
} from "./shared/debate-types.js";
import {
  applyLimitSignalToDebates,
  continueDebateSession,
  createDebateSession,
  getDebateSessionById,
  listDebateSummaries,
  pauseDebateManually,
  regenerateDebateResponse,
  resumeDebateSession,
  reviewDebateResponseWithPlatform,
  submitDebateTaskResponse,
  updateSessionSharedMemoryManually
} from "./debate/debate-engine.js";
import { kickRunner, startRunner } from "./debate/runner.js";
import { getActiveStreams, subscribeStreamHub } from "./debate/stream-hub.js";
import { getProvidersStatus } from "./providers/registry.js";

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
  ".js": "text/javascript; charset=utf-8"
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
                    size: att.size
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
  request: IncomingMessage
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalSize = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk);

    totalSize += buffer.length;

    if (totalSize > MAX_BODY_SIZE) {
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

async function serveDashboard(
  pathname: string,
  response: ServerResponse
): Promise<void> {
  const files: Record<string, string> = {
    "/": "index.html",
    "/index.html": "index.html",
    "/styles.css": "styles.css",
    "/dashboard.js": "dashboard.js"
  };

  const filename = files[pathname];

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
    const acceptEncoding = response.req?.headers["accept-encoding"];
    const useGzip =
      content.byteLength > 1024 &&
      typeof acceptEncoding === "string" &&
      acceptEncoding.includes("gzip");
    const payload = useGzip ? gzipSync(content) : content;

    response.writeHead(200, {
      "Content-Type":
        MIME_TYPES[extname(filePath)] ??
        "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
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

      const dashboardFiles = new Set([
        "/",
        "/index.html",
        "/styles.css",
        "/dashboard.js"
      ]);

      if (dashboardFiles.has(url.pathname)) {
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
          const [events, summaries] = await Promise.all([
            readEvents(),
            listDebateSummaries()
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
              lightweightStatus: true
            },
            totalEvents: events.length,
            latestEvents: events.slice(-20),
            activeDebatesCount,
            debates: summaries
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
            const body = await readRequestBody(request);
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

          try {
            const session = await createDebateSession({
              title: typeof payload.title === "string" ? payload.title : "",
              topic: typeof payload.topic === "string" ? payload.topic : "",
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
              attachments: rawAttachments
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
        /^\/debates\/([0-9a-fA-F-]{8,64})\/(respond|pause|resume|message|regenerate|review|memory)$/
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
          const body = await readRequestBody(request);
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

            const updated = await continueDebateSession(debateId, {
              message:
                typeof payload.message === "string" ? payload.message : "",
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
              attachments: rawAttachments
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

          if (action === "pause") {
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
