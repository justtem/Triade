import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractLoopbackPortFromText,
  getProjectDevServerStatus,
  startProjectDevServer,
  stopProjectDevServer
} from "../src/projects/dev-server-manager.js";
import { auditWorkspaceSecurity } from "../src/projects/workspace-security-audit.js";
import { verifyWorkspaceProject } from "../src/projects/workspace-verifier.js";
import { createMonitorServer } from "../src/server/app.js";

describe("Etapa 3 — Mini-Auditor de Segurança 0ms & Preview App (npm run dev)", () => {
  it("aprova código seguro (textContent, 127.0.0.1, scryptSync, hashPayload SHA-256 sem senha)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aic-sec-audit-ok-"));
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await mkdir(join(dir, "public"), { recursive: true });
      await writeFile(
        join(dir, "src", "server.ts"),
        [
          "import http from 'node:http';",
          "import crypto from 'node:crypto';",
          "export function hashPayload(body: string) {",
          "  return crypto.createHash('sha256').update(body).digest('hex');",
          "}",
          "export function hashPassword(password: string, salt: string) {",
          "  return crypto.scryptSync(password, salt, 64).toString('hex');",
          "}",
          "export function createApp() {",
          "  const srv = http.createServer((_req, res) => {",
          "    res.setHeader('X-Content-Type-Options', 'nosniff');",
          "    res.setHeader('X-Frame-Options', 'DENY');",
          "    res.end('ok');",
          "  });",
          "  srv.listen(4120, '127.0.0.1');",
          "  return srv;",
          "}"
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        join(dir, "public", "app.js"),
        [
          "const list = document.getElementById('list');",
          "list.innerHTML = '';",
          "const li = document.createElement('li');",
          "li.textContent = 'Seguro';",
          "list.appendChild(li);"
        ].join("\n"),
        "utf8"
      );

      const res = await auditWorkspaceSecurity(dir);
      assert.equal(res.passed, true);
      assert.equal(res.criticalCount, 0);
      assert.equal(res.warningCount, 0);
      assert.equal(res.checkRun.ok, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reprova falhas críticas (innerHTML dinâmico, 0.0.0.0, md5 para senha, log de CPF) e aciona falha no verifier", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aic-sec-audit-fail-"));
    try {
      await mkdir(join(dir, "src"), { recursive: true });
      await mkdir(join(dir, "public"), { recursive: true });
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "unsafe-sample",
          version: "1.0.0",
          scripts: {
            test: "node -e \"console.log('ok')\""
          }
        }),
        "utf8"
      );
      await writeFile(
        join(dir, "src", "server.ts"),
        [
          "import http from 'node:http';",
          "import crypto from 'node:crypto';",
          "export function badHash(password: string) {",
          "  return crypto.createHash('md5').update(password).digest('hex');",
          "}",
          "export function badLog(cpf: string) {",
          "  console.log('Paciente cpf:', cpf);",
          "}",
          "const srv = http.createServer((_req, res) => res.end('hi'));",
          "srv.listen(4125, '0.0.0.0');"
        ].join("\n"),
        "utf8"
      );
      await writeFile(
        join(dir, "public", "app.js"),
        "el.innerHTML = `<div>${userInput}</div>`;\n",
        "utf8"
      );

      const audit = await auditWorkspaceSecurity(dir);
      assert.equal(audit.passed, false);
      assert.equal(audit.criticalCount, 4);
      const ruleIds = new Set(audit.findings.map((f) => f.ruleId));
      assert.ok(ruleIds.has("xss_dynamic_innerhtml"));
      assert.ok(ruleIds.has("network_bind_all_interfaces"));
      assert.ok(ruleIds.has("weak_password_hash"));
      assert.ok(ruleIds.has("pii_secret_console_log"));

      // Mesmo com npm test passando, verifyWorkspaceProject reprova para disparar Auto-Fix
      const verified = await verifyWorkspaceProject(dir);
      assert.equal(verified.allPassed, false);
      assert.equal(verified.checks.at(-1)?.command, "security-audit (0ms)");
      assert.equal(verified.checks.at(-1)?.ok, false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("extrai portas loopback válidas e rejeita a porta do próprio AI Council (4317)", () => {
    assert.equal(extractLoopbackPortFromText("Server running at http://127.0.0.1:4180"), 4180);
    assert.equal(extractLoopbackPortFromText("Listening on http://localhost:4205"), 4205);
    assert.equal(extractLoopbackPortFromText("App started on port 4199"), 4199);
    assert.equal(extractLoopbackPortFromText("http://127.0.0.1:4317"), null);
  });

  it("sobe npm run dev em 127.0.0.1, valida HTTP real e encerra o processo limpo no Stop", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aic-dev-preview-test-"));
    const projId = "proj_preview_test_01";
    try {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "preview-sample",
          version: "1.0.0",
          type: "module",
          scripts: {
            dev: "node server.mjs"
          }
        }),
        "utf8"
      );
      await writeFile(
        join(dir, "server.mjs"),
        [
          "import http from 'node:http';",
          "const srv = http.createServer((_req, res) => {",
          "  res.writeHead(200, { 'Content-Type': 'text/plain' });",
          "  res.end('PREVIEW_ALIVE');",
          "});",
          "srv.listen(0, '127.0.0.1', () => {",
          "  const addr = srv.address();",
          "  console.log(`Ready at http://127.0.0.1:${addr.port}`);",
          "});"
        ].join("\n"),
        "utf8"
      );

      const before = await getProjectDevServerStatus(projId, dir);
      assert.equal(before.running, false);
      assert.equal(before.canRun, true);
      assert.equal(before.scriptName, "dev");

      const started = await startProjectDevServer(projId, dir);
      assert.equal(started.running, true);
      assert.ok(started.url?.startsWith("http://127.0.0.1:"));

      const resp = await fetch(started.url!);
      assert.equal(resp.status, 200);
      assert.equal(await resp.text(), "PREVIEW_ALIVE");

      const stopped = await stopProjectDevServer(projId);
      assert.equal(stopped, true);

      const after = await getProjectDevServerStatus(projId, dir);
      assert.equal(after.running, false);
    } finally {
      await stopProjectDevServer(projId).catch(() => {});
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    }
  });

  it("bloqueia /projects/:id/dev-server/start com HTTP 403 no acesso remoto/proxy", async () => {
    const prevDataDir = process.env.AI_COUNCIL_DATA_DIR;
    const isolatedDataDir = await mkdtemp(join(tmpdir(), "aic-devsrv-remote-data-"));
    process.env.AI_COUNCIL_DATA_DIR = isolatedDataDir;

    const { server } = createMonitorServer({
      host: "127.0.0.1",
      port: 0,
      accessPassword: "StrongTestPassword!99",
      requirePasswordLocal: false
    });

    await new Promise<void>((resolveListen) => {
      server.listen(0, "127.0.0.1", () => resolveListen());
    });

    try {
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      const loginRes = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "100.64.0.12",
          "X-Forwarded-Proto": "https"
        },
        body: JSON.stringify({ password: "StrongTestPassword!99" })
      });
      assert.equal(loginRes.status, 200);
      const cookiePair = (loginRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

      const res = await fetch(`${base}/projects/proj_123456/dev-server/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookiePair,
          "X-Forwarded-For": "100.64.0.12",
          "X-Forwarded-Proto": "https"
        },
        body: JSON.stringify({})
      });
      assert.equal(res.status, 403);
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      if (prevDataDir === undefined) {
        delete process.env.AI_COUNCIL_DATA_DIR;
      } else {
        process.env.AI_COUNCIL_DATA_DIR = prevDataDir;
      }
      await rm(isolatedDataDir, { recursive: true, force: true });
    }
  });
});
