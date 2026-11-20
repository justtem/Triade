import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  getClientIp,
  getTransportSecurityHeaders,
  isHttpsBehindLocalProxy,
  isLoopbackSocket,
  isMozExtensionOrigin,
  isRecord,
  readRequestBody,
  SECURITY_HEADERS,
  sendJson
} from "./http-utils.js";

export const DEFAULT_WEAK_PASSWORD = "aicouncil2026";
export const LOGIN_MAX_ATTEMPTS = 5;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutos
export const LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutos
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const MAX_ACTIVE_SESSIONS = 25;
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface StoredSessionRecord {
  hash: string;
  createdAt: number;
  expiresAt: number;
}

function hashSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken).digest("hex");
}

function getSessionsFilePath(): string {
  const dataDir = process.env.AI_COUNCIL_DATA_DIR
    ? resolve(process.env.AI_COUNCIL_DATA_DIR)
    : resolve(ROOT_DIR, "data");
  return resolve(dataDir, "sessions.json");
}

export interface AuthConfig {
  token: string;
  accessPassword: string;
  requirePasswordLocal: boolean;
  host: string;
  port: number;
  nowFn?: () => number;
  maxLoginAttempts?: number;
  loginWindowMs?: number;
  loginLockoutMs?: number;
}

interface LoginAttemptBucket {
  failures: number[];
  lockedUntil: number;
}

export function safeCompareString(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function parseCookies(
  cookieHeader: string | undefined
): Record<string, string> {
  if (!cookieHeader) return {};
  const out: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx > 0) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export function createLoginRateLimiter(options?: {
  maxAttempts?: number;
  windowMs?: number;
  lockoutMs?: number;
  nowFn?: () => number;
}) {
  const maxAttempts = options?.maxAttempts ?? LOGIN_MAX_ATTEMPTS;
  const windowMs = options?.windowMs ?? LOGIN_WINDOW_MS;
  const lockoutMs = options?.lockoutMs ?? LOGIN_LOCKOUT_MS;
  const nowFn = options?.nowFn ?? (() => Date.now());
  const buckets = new Map<string, LoginAttemptBucket>();

  function prune(now: number): void {
    if (buckets.size < 200) return;
    for (const [ip, bucket] of buckets.entries()) {
      const recent = bucket.failures.filter((ts) => now - ts < windowMs);
      if (recent.length === 0 && bucket.lockedUntil <= now) {
        buckets.delete(ip);
      }
    }
  }

  function check(ip: string): { allowed: boolean; retryAfterSec: number; remaining: number } {
    const now = nowFn();
    const bucket = buckets.get(ip);
    if (!bucket) {
      return { allowed: true, retryAfterSec: 0, remaining: maxAttempts };
    }

    if (bucket.lockedUntil > now) {
      const retryAfterSec = Math.max(1, Math.ceil((bucket.lockedUntil - now) / 1000));
      return { allowed: false, retryAfterSec, remaining: 0 };
    }

    bucket.failures = bucket.failures.filter((ts) => now - ts < windowMs);
    return {
      allowed: true,
      retryAfterSec: 0,
      remaining: Math.max(0, maxAttempts - bucket.failures.length)
    };
  }

  function recordFailure(ip: string): {
    locked: boolean;
    retryAfterSec: number;
    remaining: number;
  } {
    const now = nowFn();
    prune(now);

    const bucket = buckets.get(ip) ?? { failures: [], lockedUntil: 0 };
    bucket.failures = bucket.failures.filter((ts) => now - ts < windowMs);
    bucket.failures.push(now);

    if (bucket.failures.length >= maxAttempts) {
      bucket.lockedUntil = now + lockoutMs;
      bucket.failures = [];
      buckets.set(ip, bucket);
      return {
        locked: true,
        retryAfterSec: Math.max(1, Math.ceil(lockoutMs / 1000)),
        remaining: 0
      };
    }

    buckets.set(ip, bucket);
    return {
      locked: false,
      retryAfterSec: 0,
      remaining: Math.max(0, maxAttempts - bucket.failures.length)
    };
  }

  function reset(ip: string): void {
    buckets.delete(ip);
  }

  return { check, recordFailure, reset };
}

export function createAuthManager(config: AuthConfig) {
  let currentAccessPassword = config.accessPassword;
  const nowFn = config.nowFn ?? (() => Date.now());
  const dashboardOrigin = `http://${config.host}:${config.port}`;
  const loginLimiter = createLoginRateLimiter({
    maxAttempts: config.maxLoginAttempts,
    windowMs: config.loginWindowMs,
    lockoutMs: config.loginLockoutMs,
    nowFn
  });

  // Registro server-side de sessões opacas (armazenadas apenas por hash SHA-256, com expiração e revogação real)
  const activeSessions = new Map<string, StoredSessionRecord>();

  function loadPersistedSessions(): void {
    try {
      const file = getSessionsFilePath();
      if (!existsSync(file)) return;
      const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!Array.isArray(parsed)) return;
      const now = nowFn();
      for (const item of parsed) {
        if (
          item &&
          typeof item === "object" &&
          typeof (item as StoredSessionRecord).hash === "string" &&
          typeof (item as StoredSessionRecord).expiresAt === "number" &&
          (item as StoredSessionRecord).expiresAt > now
        ) {
          const rec = item as StoredSessionRecord;
          activeSessions.set(rec.hash, rec);
        }
      }
    } catch {
      // Inicia sem sessões anteriores se o arquivo não existir ou estiver corrompido
    }
  }

  function persistSessions(): void {
    try {
      const file = getSessionsFilePath();
      mkdirSync(dirname(file), { recursive: true });
      const now = nowFn();
      const valid = Array.from(activeSessions.values()).filter((s) => s.expiresAt > now);
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(valid, null, 2), { encoding: "utf8", mode: 0o600 });
      renameSync(tmp, file);
    } catch {
      // Não derruba a requisição caso o disco falhe temporariamente
    }
  }

  loadPersistedSessions();

  function issueRemoteSession(): string {
    const rawToken = randomBytes(32).toString("hex");
    const hash = hashSessionToken(rawToken);
    const now = nowFn();

    // Remove expiradas e aplica teto máximo de sessões simultâneas
    for (const [h, rec] of activeSessions.entries()) {
      if (rec.expiresAt <= now) activeSessions.delete(h);
    }
    while (activeSessions.size >= MAX_ACTIVE_SESSIONS) {
      const oldest = activeSessions.keys().next().value;
      if (oldest === undefined) break;
      activeSessions.delete(oldest);
    }

    activeSessions.set(hash, {
      hash,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS
    });
    persistSessions();
    return rawToken;
  }

  function isOpaqueSessionValid(rawToken: string | undefined): boolean {
    if (!rawToken || rawToken.length < 32) return false;
    const hash = hashSessionToken(rawToken.trim());
    const rec = activeSessions.get(hash);
    if (!rec) return false;
    if (rec.expiresAt <= nowFn()) {
      activeSessions.delete(hash);
      persistSessions();
      return false;
    }
    return true;
  }

  function revokeSessionToken(rawToken: string | undefined): void {
    if (!rawToken) return;
    const hash = hashSessionToken(rawToken.trim());
    if (activeSessions.delete(hash)) {
      persistSessions();
    }
  }

  function revokeAllSessions(): void {
    activeSessions.clear();
    persistSessions();
  }

  function updateAccessPassword(newPassword: string): void {
    const clean = newPassword.trim();
    if (clean.length >= 8) {
      currentAccessPassword = clean;
      // Rotação de senha revoga todas as sessões remotas anteriores
      revokeAllSessions();
    }
  }

  function isAllowedOrigin(
    origin: string | undefined,
    request: IncomingMessage
  ): boolean {
    if (!origin) return true;

    if (
      origin === dashboardOrigin ||
      origin === `http://localhost:${config.port}`
    ) {
      return true;
    }

    // Só confia em X-Forwarded-Host quando recebido via proxy loopback (Tailscale / Cloudflare Tunnel)
    const forwardedHost =
      isLoopbackSocket(request) && typeof request.headers["x-forwarded-host"] === "string"
        ? request.headers["x-forwarded-host"].split(",")[0]?.trim()
        : undefined;
    const host = forwardedHost || request.headers.host;

    if (host) {
      if (origin === `http://${host}` || origin === `https://${host}`) {
        return true;
      }
    }

    return isMozExtensionOrigin(origin);
  }

  /**
   * Defesa em profundidade contra CSRF em operações mutáveis (POST/PUT/PATCH/DELETE):
   * bloqueia requisições sinalizadas pelo navegador como `Sec-Fetch-Site: cross-site`.
   */
  function isCrossSiteStateChangingRequest(request: IncomingMessage): boolean {
    const method = (request.method ?? "GET").toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
      return false;
    }
    const origin = request.headers.origin;
    if (isMozExtensionOrigin(origin)) {
      return false;
    }
    const fetchSite = String(request.headers["sec-fetch-site"] ?? "").trim().toLowerCase();
    return fetchSite === "cross-site";
  }

  function isDirectLocalPCRequest(request: IncomingMessage): boolean {
    const host = request.headers.host ?? "";
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

    const hostWithoutPort = host.split(":")[0]?.toLowerCase() ?? "";
    const isLocalHostHeader =
      host === `${config.host}:${config.port}` ||
      host === `localhost:${config.port}` ||
      (config.port === 0 &&
        (hostWithoutPort === "127.0.0.1" || hostWithoutPort === "localhost"));

    return isLoopbackAddr && isLocalHostHeader && !hasProxyHeaders;
  }

  function hasValidRemoteSession(request: IncomingMessage): boolean {
    const cookies = parseCookies(request.headers.cookie);
    if (isOpaqueSessionValid(cookies.ai_council_session)) {
      return true;
    }

    const headerSession = request.headers["x-ai-council-session"];
    if (typeof headerSession === "string" && isOpaqueSessionValid(headerSession)) {
      return true;
    }

    const headerPass = request.headers["x-ai-council-password"];
    if (
      typeof headerPass === "string" &&
      safeCompareString(headerPass.trim(), currentAccessPassword)
    ) {
      return true;
    }

    return false;
  }

  function isDashboardRequest(request: IncomingMessage): boolean {
    if (!config.requirePasswordLocal && isDirectLocalPCRequest(request)) {
      return true;
    }
    return hasValidRemoteSession(request);
  }

  function hasValidMonitorToken(request: IncomingMessage): boolean {
    const suppliedToken = request.headers["x-ai-council-token"];
    return (
      typeof suppliedToken === "string" &&
      config.token.length > 0 &&
      safeCompareString(suppliedToken, config.token)
    );
  }

  function isAuthorizedLocalClient(request: IncomingMessage): boolean {
    return hasValidMonitorToken(request) || isDashboardRequest(request);
  }

  function isUsingWeakDefaultPassword(): boolean {
    const pass = currentAccessPassword.trim();
    return pass === DEFAULT_WEAK_PASSWORD || pass.length < 8;
  }

  async function handleAuthRoute(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL,
    origin: string | undefined
  ): Promise<boolean> {
    if (request.method === "GET" && url.pathname === "/auth/status") {
      sendJson(
        response,
        200,
        {
          authenticated: isDashboardRequest(request),
          isRemote: !isDirectLocalPCRequest(request)
        },
        origin
      );
      return true;
    }

    if (request.method === "POST" && url.pathname === "/auth/login") {
      const clientIp = getClientIp(request);
      const gate = loginLimiter.check(clientIp);
      if (!gate.allowed) {
        const mins = Math.ceil(gate.retryAfterSec / 60);
        sendJson(
          response,
          429,
          {
            authenticated: false,
            retryAfterSec: gate.retryAfterSec,
            error: `Muitas tentativas incorretas. Aguarde ${
              gate.retryAfterSec >= 60
                ? `${mins} min`
                : `${gate.retryAfterSec}s`
            } para tentar novamente.`
          },
          origin,
          { "Retry-After": String(gate.retryAfterSec) }
        );
        return true;
      }

      let payload: unknown;
      try {
        const body = await readRequestBody(request);
        payload = JSON.parse(body);
      } catch {
        sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
        return true;
      }

      const password =
        isRecord(payload) && typeof payload.password === "string"
          ? payload.password.trim()
          : "";

      const validPassword =
        (password.length > 0 && safeCompareString(password, currentAccessPassword)) ||
        (password.length > 0 &&
          config.token.length > 0 &&
          safeCompareString(password, config.token));

      if (!validPassword) {
        const fail = loginLimiter.recordFailure(clientIp);
        if (fail.locked) {
          const mins = Math.ceil(fail.retryAfterSec / 60);
          sendJson(
            response,
            429,
            {
              authenticated: false,
              retryAfterSec: fail.retryAfterSec,
              error: `Muitas tentativas incorretas. Acesso bloqueado por ${mins} min.`
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
            authenticated: false,
            remainingAttempts: fail.remaining,
            error: `Senha incorreta. Restam ${fail.remaining} tentativa(s) antes do bloqueio temporário.`
          },
          origin
        );
        return true;
      }

      loginLimiter.reset(clientIp);
      const sessionToken = issueRemoteSession();
      const isHttps = isHttpsBehindLocalProxy(request);
      const secureFlag = isHttps ? "; Secure" : "";

      response.writeHead(200, {
        ...SECURITY_HEADERS,
        ...getTransportSecurityHeaders(request),
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": `ai_council_session=${sessionToken}; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=2592000`
      });
      // Sessão mantida exclusivamente em cookie HttpOnly (não exposta ao JavaScript / localStorage)
      response.end(JSON.stringify({ authenticated: true }));
      return true;
    }

    if (request.method === "POST" && url.pathname === "/auth/logout") {
      const cookies = parseCookies(request.headers.cookie);
      revokeSessionToken(cookies.ai_council_session);
      const isHttps = isHttpsBehindLocalProxy(request);
      const secureFlag = isHttps ? "; Secure" : "";
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        ...getTransportSecurityHeaders(request),
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Set-Cookie": `ai_council_session=; Path=/; HttpOnly; SameSite=Lax${secureFlag}; Max-Age=0`
      });
      response.end(JSON.stringify({ authenticated: false }));
      return true;
    }

    return false;
  }

  return {
    isAllowedOrigin,
    isCrossSiteStateChangingRequest,
    isDirectLocalPCRequest,
    hasValidRemoteSession,
    isDashboardRequest,
    hasValidMonitorToken,
    isAuthorizedLocalClient,
    isUsingWeakDefaultPassword,
    updateAccessPassword,
    revokeAllSessions,
    handleAuthRoute
  };
}

export type AuthManager = ReturnType<typeof createAuthManager>;
