import { createServer, type Server } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { listDebateSummaries } from "../debate/debate-engine.js";
import { getActiveStreams, subscribeStreamHub } from "../debate/stream-hub.js";
import { listProjects } from "../persistence/project-store.js";
import { getProvidersStatus } from "../providers/registry.js";
import {
  createAuthManager,
  DEFAULT_WEAK_PASSWORD,
  type AuthConfig
} from "./auth.js";
import { handleEventsRoute, readMonitorEvents } from "./events-store.js";
import { getSetupMissingProviders, type KeyValidatorFn } from "./env-config.js";
import {
  getTransportSecurityHeaders,
  isMozExtensionOrigin,
  SECURITY_HEADERS,
  sendJson
} from "./http-utils.js";
import { handleAudioRoutes } from "./routes-audio.js";
import { handleDebateRoutes } from "./routes-debates.js";
import { handleUserMemoryRoutes } from "./routes-memory.js";
import { handlePrivacyRoutes } from "./routes-privacy.js";
import { handleProjectRoutes } from "./routes-projects.js";
import { handleSetupRoutes } from "./routes-setup.js";
import { handleTemplateRoutes } from "./routes-templates.js";
import {
  resolveDashboardFilename,
  serveDashboardFile
} from "./static-files.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_PUBLIC_DIR = resolve(ROOT_DIR, "public");

export interface MonitorServerOptions extends Partial<AuthConfig> {
  publicDir?: string;
  envPath?: string;
  validateKeyFn?: KeyValidatorFn;
}

export function createMonitorServer(options: MonitorServerOptions = {}): {
  server: Server;
  auth: ReturnType<typeof createAuthManager>;
} {
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? (Number(process.env.PORT) || 4317);
  const dashboardOrigin = `http://${host}:${port}`;
  const publicDir = options.publicDir ?? DEFAULT_PUBLIC_DIR;
  const envPath = options.envPath ?? resolve(ROOT_DIR, ".env");

  const auth = createAuthManager({
    token: options.token ?? process.env.MONITOR_TOKEN ?? "",
    accessPassword:
      options.accessPassword ??
      (process.env.ACCESS_PASSWORD?.trim() || DEFAULT_WEAK_PASSWORD),
    requirePasswordLocal:
      options.requirePasswordLocal ??
      process.env.REQUIRE_PASSWORD_LOCAL === "true",
    host,
    port,
    nowFn: options.nowFn,
    maxLoginAttempts: options.maxLoginAttempts,
    loginWindowMs: options.loginWindowMs,
    loginLockoutMs: options.loginLockoutMs
  });

  const MAX_SSE_CLIENTS = 20;
  let activeSseClients = 0;

  const server = createServer(async (request, response) => {
    const origin = request.headers.origin;

    // 1. Validação de Origem & Defesa contra CSRF cross-site
    if (!auth.isAllowedOrigin(origin, request)) {
      sendJson(response, 403, { error: "Origem não autorizada." });
      return;
    }

    if (auth.isCrossSiteStateChangingRequest(request)) {
      sendJson(response, 403, { error: "Requisição cross-site bloqueada (CSRF)." });
      return;
    }

    // 2. CORS Preflight (apenas extensão Firefox autorizada)
    if (request.method === "OPTIONS") {
      if (!isMozExtensionOrigin(origin)) {
        sendJson(response, 403, { error: "Preflight não autorizado." });
        return;
      }

      response.writeHead(204, {
        ...SECURITY_HEADERS,
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, X-AI-Council-Token",
        "Access-Control-Max-Age": "600",
        "Vary": "Origin"
      });
      response.end();
      return;
    }

    const url = new URL(request.url ?? "/", dashboardOrigin);

    // 3. Arquivos estáticos do Dashboard / PWA
    if (resolveDashboardFilename(url.pathname) !== null) {
      if (request.method !== "GET") {
        sendJson(response, 405, { error: "Método não permitido." }, origin);
        return;
      }
      await serveDashboardFile(publicDir, url.pathname, response);
      return;
    }

    // 4. Health check público
    if (request.method === "GET" && url.pathname === "/health") {
      sendJson(
        response,
        200,
        {
          status: "online",
          service: "ai-council-usage-monitor",
          timestamp: new Date().toISOString()
        },
        origin
      );
      return;
    }

    // 5. Autenticação remota + Rate-Limiter (/auth/*)
    if (await auth.handleAuthRoute(request, response, url, origin)) {
      return;
    }

    // 6. Stream em tempo real (SSE: /events/stream — autenticado via cookie HttpOnly ou loopback local, nunca query string)
    if (request.method === "GET" && url.pathname === "/events/stream") {
      if (!auth.isAuthorizedLocalClient(request)) {
        sendJson(response, 401, { error: "Não autorizado." }, origin);
        return;
      }

      if (activeSseClients >= MAX_SSE_CLIENTS) {
        sendJson(
          response,
          429,
          { error: "Limite de conexões em tempo real atingido." },
          origin
        );
        return;
      }

      activeSseClients++;
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        ...getTransportSecurityHeaders(request),
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

      let cleaned = false;
      request.on("close", () => {
        if (cleaned) return;
        cleaned = true;
        activeSseClients = Math.max(0, activeSseClients - 1);
        clearInterval(heartbeat);
        unsubscribe();
      });
      return;
    }

    // 7. Status consolidado (/status)
    if (request.method === "GET" && url.pathname === "/status") {
      if (!auth.isAuthorizedLocalClient(request)) {
        sendJson(
          response,
          401,
          { error: "Senha de acesso necessária.", requiresPassword: true },
          origin
        );
        return;
      }

      try {
        const [events, summaries, projects] = await Promise.all([
          readMonitorEvents(),
          listDebateSummaries(),
          listProjects()
        ]);

        const activeDebatesCount = summaries.filter(
          (d) => d.status === "running"
        ).length;
        const missingProviders = getSetupMissingProviders();

        sendJson(
          response,
          200,
          {
            status: "online",
            capabilities: {
              responseModes: true,
              multiTurn: true,
              streaming: true,
              lightweightStatus: true,
              projects: true,
              autoRouter: true,
              universalPdfChat: true,
              projectBm25Cache: true,
              autoVerdict: true,
              webSearchCache: true,
              guidedSetup: true,
              autoUserMemory: true,
              editTurn: true,
              privacyShield: true,
              encryptAtRest: true
            },
            setup: {
              complete: missingProviders.length === 0,
              isLocal: auth.isDirectLocalPCRequest(request),
              missingProviders
            },
            totalEvents: events.length,
            latestEvents: events.slice(-20),
            activeDebatesCount,
            debates: summaries,
            projects
          },
          origin
        );
      } catch (error) {
        console.error("[AI Council] Erro ao ler status:", error);
        sendJson(
          response,
          500,
          { error: "Não foi possível ler o histórico ou estado." },
          origin
        );
      }
      return;
    }

    // 8. Provedores e Uso Diário (/providers)
    if (request.method === "GET" && url.pathname === "/providers") {
      if (!auth.isAuthorizedLocalClient(request)) {
        sendJson(response, 401, { error: "Não autorizado." }, origin);
        return;
      }

      try {
        sendJson(
          response,
          200,
          { providers: await getProvidersStatus() },
          origin
        );
      } catch (error) {
        console.error("[AI Council] Erro ao ler provedores:", error);
        sendJson(
          response,
          500,
          { error: "Não foi possível ler o estado dos provedores." },
          origin
        );
      }
      return;
    }

    // 9. Roteadores modulares por domínio
    if (
      await handleSetupRoutes(request, response, url, origin, auth, {
        envPath,
        validateKeyFn: options.validateKeyFn
      })
    ) {
      return;
    }
    if (await handlePrivacyRoutes(request, response, url, origin, auth, { envPath })) return;
    if (await handleUserMemoryRoutes(request, response, url, origin, auth)) return;
    if (await handleAudioRoutes(request, response, url, origin, auth)) return;
    if (await handleProjectRoutes(request, response, url, origin, auth)) return;
    if (await handleTemplateRoutes(request, response, url, origin, auth)) return;
    if (await handleDebateRoutes(request, response, url, origin, auth)) return;
    if (await handleEventsRoute(request, response, url, origin, auth)) return;

    sendJson(response, 404, { error: "Rota não encontrada." }, origin);
  });

  // Proteção contra Slowloris / conexões penduradas (mantendo suporte a uploads/SSE)
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 15_000;
  server.requestTimeout = 90_000;

  return { server, auth };
}
