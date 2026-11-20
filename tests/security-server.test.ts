import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLoginRateLimiter } from "../src/server/auth.js";
import { createMonitorServer } from "../src/server/app.js";
import { getClientIp } from "../src/server/http-utils.js";
import {
  clearWebCache,
  fetchPageContent,
  isPublicIpAddress,
  isSafeResolvedUrl
} from "../src/web/web-context.js";
import type { IncomingMessage } from "node:http";

describe("Segurança de Acesso Remoto & Servidor Modularizado (Prioridade #1)", () => {
  let tempDataDir = "";
  let baseUrl = "";
  let closeServer: () => Promise<void>;
  const testToken = "a".repeat(64);
  const testPassword = "SenhaForteDeTeste!2026";

  before(async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "ai-council-sec-test-"));
    process.env.AI_COUNCIL_DATA_DIR = tempDataDir;

    const { server } = createMonitorServer({
      host: "127.0.0.1",
      port: 0,
      token: testToken,
      accessPassword: testPassword,
      requirePasswordLocal: true
    });

    await new Promise<void>((resolvePromise) => {
      server.listen(0, "127.0.0.1", () => resolvePromise());
    });

    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    closeServer = () =>
      new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
  });

  after(async () => {
    await closeServer?.();
    delete process.env.AI_COUNCIL_DATA_DIR;
    if (tempDataDir) {
      await rm(tempDataDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("LoginRateLimiter bloqueia após 5 falhas em 15 min, libera após expiração e zera no sucesso", () => {
    let fakeNow = 1_000_000;
    const limiter = createLoginRateLimiter({
      maxAttempts: 5,
      windowMs: 15 * 60 * 1000,
      lockoutMs: 15 * 60 * 1000,
      nowFn: () => fakeNow
    });

    for (let i = 1; i <= 4; i++) {
      assert.equal(limiter.check("10.0.0.1").allowed, true);
      const res = limiter.recordFailure("10.0.0.1");
      assert.equal(res.locked, false);
      assert.equal(res.remaining, 5 - i);
    }

    // 5ª falha ativa o bloqueio de 15 min
    const fifth = limiter.recordFailure("10.0.0.1");
    assert.equal(fifth.locked, true);
    assert.equal(fifth.retryAfterSec, 900);
    assert.equal(limiter.check("10.0.0.1").allowed, false);

    // Outro IP não é afetado
    assert.equal(limiter.check("10.0.0.2").allowed, true);

    // Avança 15 min + 1s -> desbloqueado
    fakeNow += 15 * 60 * 1000 + 1000;
    assert.equal(limiter.check("10.0.0.1").allowed, true);

    // Zera imediatamente ao acertar
    limiter.recordFailure("10.0.0.1");
    limiter.reset("10.0.0.1");
    assert.equal(limiter.check("10.0.0.1").remaining, 5);
  });

  it("aplica headers de segurança (CSP, X-Frame-Options, Referrer-Policy, Permissions-Policy, nosniff)", async () => {
    const htmlRes = await fetch(`${baseUrl}/`);
    assert.equal(htmlRes.status, 200);
    assert.equal(htmlRes.headers.get("x-frame-options"), "DENY");
    assert.equal(htmlRes.headers.get("x-content-type-options"), "nosniff");
    assert.equal(htmlRes.headers.get("referrer-policy"), "no-referrer");
    assert.ok(htmlRes.headers.get("permissions-policy")?.includes("microphone=(self)"));
    const csp = htmlRes.headers.get("content-security-policy") ?? "";
    assert.ok(csp.includes("default-src 'self'"));
    assert.ok(csp.includes("frame-ancestors 'none'"));
    assert.ok(csp.includes("media-src 'self' blob: data:"));

    const healthRes = await fetch(`${baseUrl}/health`);
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get("x-frame-options"), "DENY");
    assert.equal(healthRes.headers.get("x-content-type-options"), "nosniff");
  });

  it("bloqueia origem cruzada maliciosa (403) e rotas privadas sem autenticação (401)", async () => {
    const badOriginRes = await fetch(`${baseUrl}/health`, {
      headers: { Origin: "https://site-malicioso.example" }
    });
    assert.equal(badOriginRes.status, 403);

    const unauthStatus = await fetch(`${baseUrl}/status`);
    assert.equal(unauthStatus.status, 401);

    const unauthProjects = await fetch(`${baseUrl}/projects`);
    assert.equal(unauthProjects.status, 401);
  });

  it("aplica rate-limit HTTP 429 + Retry-After no /auth/login após 5 senhas erradas e permite login com senha correta em outro IP", async () => {
    for (let i = 1; i <= 4; i++) {
      const r = await fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.10"
        },
        body: JSON.stringify({ password: "errada" })
      });
      assert.equal(r.status, 401);
    }

    // 5ª tentativa errada -> 429 bloqueado
    const lockedRes = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.10"
      },
      body: JSON.stringify({ password: "errada" })
    });
    assert.equal(lockedRes.status, 429);
    assert.ok(Number(lockedRes.headers.get("retry-after")) >= 60);

    // Mesmo com senha certa, IP bloqueado continua em 429
    const stillLocked = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.10"
      },
      body: JSON.stringify({ password: testPassword })
    });
    assert.equal(stillLocked.status, 429);

    // IP legítimo autentica via cookie HttpOnly (sem vazar sessionToken no JSON) e acessa /status e /projects
    const okLogin = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.20"
      },
      body: JSON.stringify({ password: testPassword })
    });
    assert.equal(okLogin.status, 200);
    const loginBody = (await okLogin.json()) as {
      authenticated: boolean;
      sessionToken?: string;
    };
    assert.equal(loginBody.authenticated, true);
    assert.equal(
      loginBody.sessionToken,
      undefined,
      "sessionToken não deve ser exposto no JSON (apenas cookie HttpOnly)"
    );

    const setCookie = okLogin.headers.get("set-cookie") ?? "";
    assert.ok(setCookie.includes("ai_council_session="));
    assert.ok(setCookie.includes("HttpOnly"));
    assert.ok(setCookie.includes("SameSite=Lax"));
    const cookiePair = setCookie.split(";")[0] ?? "";

    const statusRes = await fetch(`${baseUrl}/status`, {
      headers: { Cookie: cookiePair }
    });
    assert.equal(statusRes.status, 200);
    const statusJson = (await statusRes.json()) as {
      status: string;
      capabilities: { projects: boolean };
    };
    assert.equal(statusJson.status, "online");
    assert.equal(statusJson.capabilities.projects, true);

    // Query string ?session= no /events/stream não deve mais autenticar sem cookie/token
    const rawCookieValue = cookiePair.split("=")[1] ?? "";
    const sseQueryBlocked = await fetch(
      `${baseUrl}/events/stream?session=${encodeURIComponent(rawCookieValue)}`
    );
    assert.equal(sseQueryBlocked.status, 401);

    // Sessão remota autenticada não pode inspecionar ou vincular pastas locais do PC (403)
    const remoteInspect = await fetch(`${baseUrl}/projects/inspect-folder`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookiePair,
        "X-Forwarded-For": "203.0.113.20"
      },
      body: JSON.stringify({ path: tempDataDir })
    });
    assert.equal(remoteInspect.status, 403);

    const remoteLinkFolder = await fetch(`${baseUrl}/projects`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookiePair,
        "X-Forwarded-For": "203.0.113.20"
      },
      body: JSON.stringify({
        name: "Projeto Remoto",
        instructions: "ok",
        linkedFolderPath: tempDataDir
      })
    });
    assert.equal(remoteLinkFolder.status, 403);
  });

  it("getClientIp ignora X-Forwarded-For / CF-Connecting-IP falsificados em conexões LAN diretas", () => {
    const lanSpoofReq = {
      socket: { remoteAddress: "192.168.1.55" },
      headers: {
        "x-forwarded-for": "1.2.3.4",
        "cf-connecting-ip": "5.6.7.8"
      }
    } as unknown as IncomingMessage;
    assert.equal(getClientIp(lanSpoofReq), "192.168.1.55");

    const localProxyReq = {
      socket: { remoteAddress: "::ffff:127.0.0.1" },
      headers: {
        "x-forwarded-for": "203.0.113.99, 100.64.0.1"
      }
    } as unknown as IncomingMessage;
    assert.equal(getClientIp(localProxyReq), "203.0.113.99");
  });

  it("anti-SSRF bloqueia DNS rebinding e redirecionamento HTTP 302 para localhost sem conectar ao destino interno", async () => {
    assert.equal(isPublicIpAddress("93.184.216.34"), true);
    assert.equal(isPublicIpAddress("127.0.0.1"), false);
    assert.equal(isPublicIpAddress("192.168.1.10"), false);
    assert.equal(isPublicIpAddress("100.64.0.1"), false);
    assert.equal(isPublicIpAddress("::ffff:127.0.0.1"), false);

    // DNS rebinding: domínio público que resolve para 127.0.0.1 deve ser recusado
    assert.equal(
      await isSafeResolvedUrl("https://rebind.example.com/x", async () => [
        { address: "127.0.0.1" }
      ]),
      false
    );
    // Se um dos registros A/AAAA for privado, bloqueia também
    assert.equal(
      await isSafeResolvedUrl("https://dual.example.com/x", async () => [
        { address: "93.184.216.34" },
        { address: "192.168.0.5" }
      ]),
      false
    );

    clearWebCache();
    const originalFetch = globalThis.fetch;
    const calledUrls: string[] = [];

    globalThis.fetch = (async (input: string | URL | Request) => {
      const urlStr =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      calledUrls.push(urlStr);
      return new Response("", {
        status: 302,
        headers: { Location: "http://127.0.0.1:4317/setup/status" }
      });
    }) as typeof fetch;

    try {
      const res = await fetchPageContent(
        "https://public-redirect.example/go",
        4_000,
        1_500,
        {
          lookupFn: async () => [{ address: "93.184.216.34" }]
        }
      );
      assert.equal(res.ok, false);
      assert.equal(calledUrls.length, 1);
      assert.equal(calledUrls[0], "https://public-redirect.example/go");
      assert.ok(
        !calledUrls.some((u) => u.includes("127.0.0.1")),
        "Nunca deve seguir redirect 302 para localhost"
      );
    } finally {
      globalThis.fetch = originalFetch;
      clearWebCache();
    }
  });

  it("sessão opaca é revogada de verdade no /auth/logout, bloqueia CSRF cross-site e envia HSTS atrás de proxy HTTPS loopback", async () => {
    // 1. Login remoto atrás de proxy HTTPS (Tailscale Serve)
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.55",
        "X-Forwarded-Proto": "https"
      },
      body: JSON.stringify({ password: testPassword })
    });
    assert.equal(loginRes.status, 200);
    assert.ok(
      loginRes.headers.get("strict-transport-security")?.includes("max-age=31536000")
    );
    const setCookie = loginRes.headers.get("set-cookie") ?? "";
    assert.ok(setCookie.includes("Secure"));
    const cookiePair = setCookie.split(";")[0] ?? "";

    // 2. Sessão ativa funciona no /status
    const okStatus = await fetch(`${baseUrl}/status`, {
      headers: { Cookie: cookiePair }
    });
    assert.equal(okStatus.status, 200);

    // 3. CSRF defense-in-depth: POST com Sec-Fetch-Site: cross-site é bloqueado (403)
    const csrfBlocked = await fetch(`${baseUrl}/user-memory`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookiePair,
        "Sec-Fetch-Site": "cross-site"
      },
      body: JSON.stringify({ enabled: false })
    });
    assert.equal(csrfBlocked.status, 403);

    // 4. Logout revoga sessão no servidor -> reutilizar o MESMO cookie antigo falha com 401
    const logoutRes = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookiePair }
    });
    assert.equal(logoutRes.status, 200);

    const revokedStatus = await fetch(`${baseUrl}/status`, {
      headers: { Cookie: cookiePair }
    });
    assert.equal(
      revokedStatus.status,
      401,
      "Cookie antigo não pode mais autenticar após /auth/logout"
    );
  });

  it("LGPD: /privacy/export gera portabilidade sem segredos e /privacy/wipe exige localhost + confirmação explícita", async () => {
    // Autentica localmente para testar exportação e eliminação
    const loginRes = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: testPassword })
    });
    assert.equal(loginRes.status, 200);
    const cookiePair = (loginRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

    // Exportação autenticada retorna JSON válido sem segredos
    const exportRes = await fetch(`${baseUrl}/privacy/export`, {
      headers: { Cookie: cookiePair }
    });
    assert.equal(exportRes.status, 200);
    assert.ok(
      exportRes.headers.get("content-disposition")?.includes("ai-council-dados-")
    );
    const exportText = await exportRes.text();
    assert.ok(!exportText.includes(testToken), "Exportação nunca pode vazar MONITOR_TOKEN");
    assert.ok(!exportText.includes(testPassword), "Exportação nunca pode vazar ACCESS_PASSWORD");
    const bundle = JSON.parse(exportText) as {
      schemaVersion: number;
      debates: unknown[];
      projects: unknown[];
      templates: unknown[];
      userMemory: { facts: unknown[] };
    };
    assert.equal(bundle.schemaVersion, 1);
    assert.ok(Array.isArray(bundle.debates));
    assert.ok(Array.isArray(bundle.projects));
    assert.ok(Array.isArray(bundle.templates));

    // /privacy/wipe remoto (com X-Forwarded-For) é bloqueado com 403
    const remoteWipe = await fetch(`${baseUrl}/privacy/wipe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookiePair,
        "X-Forwarded-For": "203.0.113.77"
      },
      body: JSON.stringify({ confirm: "APAGAR TUDO" })
    });
    assert.equal(remoteWipe.status, 403);

    // /privacy/wipe local sem confirmação exata retorna 400
    const badConfirmWipe = await fetch(`${baseUrl}/privacy/wipe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookiePair
      },
      body: JSON.stringify({ confirm: "apagar" })
    });
    assert.equal(badConfirmWipe.status, 400);

    // /privacy/wipe local com confirmação exata apaga dados e revoga sessões
    const okWipe = await fetch(`${baseUrl}/privacy/wipe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookiePair
      },
      body: JSON.stringify({ confirm: "APAGAR TUDO" })
    });
    assert.equal(okWipe.status, 200);
    const wipeJson = (await okWipe.json()) as { wiped: boolean };
    assert.equal(wipeJson.wiped, true);

    // Sessão antiga deve ter sido revogada após o wipe
    const afterWipeStatus = await fetch(`${baseUrl}/status`, {
      headers: { Cookie: cookiePair }
    });
    assert.equal(afterWipeStatus.status, 401);
  });
});
