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

import { randomUUID } from "node:crypto";
import { dirname, resolve, extname, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ALL_PLATFORMS, type AIPlatform } from "./shared/debate-types.js";
import {
  applyLimitSignalToDebates,
  createDebateSession,
  listDebateSessions,
  pauseDebateManually,
  resumeDebateSession,
  submitDebateTaskResponse
} from "./debate/debate-engine.js";
import { kickRunner, startRunner } from "./debate/runner.js";
import { getProvidersStatus } from "./providers/registry.js";

// ============================================
// CONFIGURAÇÃO
// ============================================

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = resolve(ROOT_DIR, "data");
const EVENTS_FILE = resolve(DATA_DIR, "monitor-events.json");
const PUBLIC_DIR = resolve(ROOT_DIR, "public");

const HOST = "127.0.0.1";
const PORT = 4317;

const DASHBOARD_ORIGIN = `http://${HOST}:${PORT}`;

const TOKEN = process.env.MONITOR_TOKEN;

const MAX_BODY_SIZE = 65_536;
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
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",

    ...(isMozExtensionOrigin(origin)
      ? {
          "Access-Control-Allow-Origin": origin,
          "Vary": "Origin"
        }
      : {})
  });

  response.end(JSON.stringify(data));
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
  origin: string | undefined
): boolean {
  if (!origin) return true;

  if (origin === DASHBOARD_ORIGIN) {
    return true;
  }

  return isMozExtensionOrigin(origin);
}

// ============================================
// AUTORIZAÇÃO DO DASHBOARD / TOKEN
// ============================================

function isDashboardRequest(
  request: IncomingMessage
): boolean {
  const origin = request.headers.origin;
  const fetchSite = request.headers["sec-fetch-site"];
  const host = request.headers.host;

  return (
    host === `${HOST}:${PORT}` &&
    fetchSite === "same-origin" &&
    (
      origin === undefined ||
      origin === DASHBOARD_ORIGIN
    )
  );
}

function isAuthorizedLocalClient(
  request: IncomingMessage
): boolean {
  const suppliedToken = request.headers["x-ai-council-token"];
  const authorizedByToken = suppliedToken === TOKEN;
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

    response.writeHead(200, {
      "Content-Type":
        MIME_TYPES[extname(filePath)] ??
        "application/octet-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    });

    response.end(content);
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

      if (!isAllowedOrigin(origin)) {
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
      // STATUS, HISTÓRICO E DEBATES
      // ----------------------------------------

      if (
        request.method === "GET" &&
        url.pathname === "/status"
      ) {
        if (!isAuthorizedLocalClient(request)) {
          sendJson(response, 401, {
            error: "Não autorizado."
          }, origin);

          return;
        }

        try {
          const [events, debates] = await Promise.all([
            readEvents(),
            listDebateSessions()
          ]);

          const activeDebatesCount = debates.filter(
            (d) => d.status === "running"
          ).length;

          // Trava de segurança: a extensão de navegador (legado) usa o token e
          // lia as tarefas pendentes para automatizar o ChatGPT/Claude pela
          // interface web, o que pode violar os termos de uso. Só o painel
          // (mesma origem) recebe as tarefas pendentes.
          const visibleDebates = isDashboardRequest(request)
            ? debates
            : debates.map((debate) => ({
                ...debate,
                tasks: debate.tasks.filter((task) => task.status !== "pending")
              }));

          sendJson(response, 200, {
            status: "online",
            totalEvents: events.length,
            latestEvents: events.slice(-20),
            activeDebatesCount,
            debates: visibleDebates
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
            const debates = await listDebateSessions();
            sendJson(response, 200, { debates }, origin);
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
                  : "geral"
            });

            console.log(
              "[AI Council] Debate criado:",
              session.id,
              session.title
            );

            // Os assentos automáticos começam a responder imediatamente.
            kickRunner();

            sendJson(response, 201, {
              created: true,
              debate: session
            }, origin);
          } catch (error) {
            sendJson(response, 400, {
              error:
                error instanceof Error
                  ? error.message
                  : "Não foi possível criar o debate."
            }, origin);
          }

          return;
        }
      }

      // ----------------------------------------
      // AÇÕES EM UM DEBATE (/debates/:id/:action)
      // ----------------------------------------

      const debateActionMatch = url.pathname.match(
        /^\/debates\/([0-9a-fA-F-]{36})\/(respond|pause|resume)$/
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
              debate: updated
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
              debate: updated
            }, origin);
            return;
          }

          if (action === "resume") {
            const updated = await resumeDebateSession(debateId);

            kickRunner();

            sendJson(response, 200, {
              updated: true,
              debate: updated
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

  server.listen(PORT, HOST, () => {
    console.log(
      `AI Council Usage Monitor ativo em http://${HOST}:${PORT}`
    );

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
