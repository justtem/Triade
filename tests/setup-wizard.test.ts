import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ensureBootstrapEnv,
  isPlaceholderSecret,
  maskApiKey,
  upsertEnvFile
} from "../src/server/env-config.js";
import { createMonitorServer } from "../src/server/app.js";
import { getProvidersStatus, reinitProviders } from "../src/providers/registry.js";

let tempDir = "";
let savedEnv: Record<string, string | undefined> = {};

describe("Ganho #1 — Setup Guiado em 1 Passo, Auto-.env & Segurança Localhost", () => {
  before(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ai-council-setup-test-"));
    savedEnv = {
      AI_COUNCIL_DATA_DIR: process.env.AI_COUNCIL_DATA_DIR,
      MONITOR_TOKEN: process.env.MONITOR_TOKEN,
      GEMINI_API_KEY: process.env.GEMINI_API_KEY,
      GROQ_API_KEY: process.env.GROQ_API_KEY,
      OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
      ACCESS_PASSWORD: process.env.ACCESS_PASSWORD
    };
    process.env.AI_COUNCIL_DATA_DIR = join(tempDir, "data");
  });

  after(async () => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    reinitProviders();
    if (tempDir) await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  });

  it("ensureBootstrapEnv cria .env e gera MONITOR_TOKEN seguro de 64 chars automaticamente", async () => {
    delete process.env.MONITOR_TOKEN;
    const envPath = join(tempDir, ".env.bootstrap");

    const res = await ensureBootstrapEnv(tempDir, envPath);
    assert.equal(res.createdEnv, true);
    assert.equal(res.generatedToken, true);
    assert.equal(res.token.length, 64);

    const diskContent = await readFile(envPath, "utf8");
    assert.ok(diskContent.includes(`MONITOR_TOKEN=${res.token}`));

    // Segunda chamada reutiliza o token sem regenerar
    const res2 = await ensureBootstrapEnv(tempDir, envPath);
    assert.equal(res2.generatedToken, false);
    assert.equal(res2.token, res.token);
  });

  it("upsertEnvFile preserva comentários e variáveis existentes e mascara chaves sem vazar segredo", async () => {
    const envPath = join(tempDir, ".env.preserve");
    await writeFile(
      envPath,
      "# Comentario importante\nGEMINI_API_KEY=sua_chave_gemini_aqui\nCUSTOM_VAR=ok\n",
      "utf8"
    );

    assert.equal(isPlaceholderSecret("sua_chave_gemini_aqui"), true);
    assert.equal(maskApiKey("sua_chave_gemini_aqui"), "");
    assert.equal(maskApiKey("AIzaSyTestKey1234567890ABCD"), "••••ABCD");

    await upsertEnvFile(envPath, {
      GEMINI_API_KEY: "AIzaSyTestKey1234567890ABCD",
      GROQ_API_KEY: "gsk_test_groq_key_987654321"
    });

    const content = await readFile(envPath, "utf8");
    assert.ok(content.includes("# Comentario importante"));
    assert.ok(content.includes("CUSTOM_VAR=ok"));
    assert.ok(content.includes("GEMINI_API_KEY=AIzaSyTestKey1234567890ABCD"));
    assert.ok(content.includes("GROQ_API_KEY=gsk_test_groq_key_987654321"));
  });

  it("bloqueia /setup/* para acesso remoto/proxy (403), exige as 3 chaves válidas, grava .env e faz hot-reload sem reiniciar", async () => {
    const envPath = join(tempDir, ".env.server");
    const token = "a".repeat(64);
    delete process.env.GEMINI_API_KEY;
    delete process.env.GROQ_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    reinitProviders();

    const { server } = createMonitorServer({
      host: "127.0.0.1",
      port: 0,
      token,
      accessPassword: "old-password-123",
      envPath,
      validateKeyFn: async (plat, key) => {
        if (key.includes("INVALID")) {
          return { ok: false, error: `Chave ${plat} rejeitada no teste.` };
        }
        return { ok: true };
      }
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      // 1. Trava de segurança: requisição com X-Forwarded-For (simulando acesso remoto/Tailscale) deve dar 403!
      const remoteBlocked = await fetch(`${base}/setup/status`, {
        headers: { "X-Forwarded-For": "203.0.113.42" }
      });
      assert.equal(remoteBlocked.status, 403);

      // 2. Localhost recebe setupComplete=false quando faltam chaves
      const statusBefore = await fetch(`${base}/setup/status`);
      assert.equal(statusBefore.status, 200);
      const statusJson = (await statusBefore.json()) as {
        setupComplete: boolean;
        missingProviders: string[];
      };
      assert.equal(statusJson.setupComplete, false);
      assert.deepEqual(statusJson.missingProviders, ["gemini", "groq", "openrouter"]);

      // 3. Tentar salvar só 2 chaves (faltando OpenRouter) -> 400
      const partialRes = await fetch(`${base}/setup/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          geminiApiKey: "AIzaSyValidKeyForGemini0001",
          groqApiKey: "gsk_valid_key_for_groq_0002"
        })
      });
      assert.equal(partialRes.status, 400);

      // 4. Tentar salvar com 1 chave inválida -> 400 e não grava .env
      const invalidRes = await fetch(`${base}/setup/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          geminiApiKey: "AIzaSyValidKeyForGemini0001",
          groqApiKey: "gsk_INVALID_key_for_groq_0002",
          openrouterApiKey: "sk-or-v1-valid-openrouter-0003"
        })
      });
      assert.equal(invalidRes.status, 400);
      const invalidBody = (await invalidRes.json()) as {
        validation: Record<string, { ok: boolean }>;
      };
      assert.equal(invalidBody.validation.gemini?.ok, true);
      assert.equal(invalidBody.validation.groq?.ok, false);

      // 5. Salvar as 3 chaves válidas + nova ACCESS_PASSWORD forte -> 200 + hot-reload imediato!
      const saveRes = await fetch(`${base}/setup/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          geminiApiKey: "AIzaSyValidKeyForGemini1111",
          groqApiKey: "gsk_valid_key_for_groq_2222",
          openrouterApiKey: "sk-or-v1-valid-openrouter-3333",
          accessPassword: "NovaSenhaForte!2026"
        })
      });
      assert.equal(saveRes.status, 200);
      const saveBody = (await saveRes.json()) as {
        saved: boolean;
        setupComplete: boolean;
        providers: Record<string, { configured: boolean; maskedKey: string }>;
      };
      assert.equal(saveBody.saved, true);
      assert.equal(saveBody.setupComplete, true);
      // Nunca vaza a chave completa na resposta HTTP!
      assert.equal(saveBody.providers.gemini?.maskedKey, "••••1111");
      assert.equal(saveBody.providers.groq?.maskedKey, "••••2222");
      assert.equal(saveBody.providers.openrouter?.maskedKey, "••••3333");

      // Verifica hot-reload dos 3 provedores em memória
      const liveProviders = await getProvidersStatus();
      assert.equal(liveProviders.every((p) => p.ready), true);

      // Verifica hot-reload da nova ACCESS_PASSWORD no /auth/login
      const loginRes = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: "NovaSenhaForte!2026" })
      });
      assert.equal(loginRes.status, 200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
