import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, it, beforeEach } from "node:test";

// Isola data/usage.json em pasta temporária para os testes nunca lerem ou consumirem a cota real do usuário.
const tempDataDir = mkdtempSync(join(tmpdir(), "ai-council-or-test-"));
process.env.AI_COUNCIL_DATA_DIR = tempDataDir;

after(() => {
  rmSync(tempDataDir, { recursive: true, force: true });
});

const {
  buildHybridFreeModelList,
  getOpenRouterFreeDiscoverySnapshot,
  isStrictlyFreeOpenRouterEntry,
  parseFreeOpenRouterCatalog,
  recordOpenRouterModelFailure,
  recordOpenRouterModelSuccess,
  refreshOpenRouterFreeCatalog,
  resetOpenRouterFreeDiscoveryForTests,
  resolveOpenRouterFreeModels
} = await import("../src/providers/openrouter-free.js");
const { runWithFallback } = await import("../src/providers/policy.js");
const { ProviderError } = await import("../src/providers/types.js");
const { UsageGate } = await import("../src/providers/usage-gate.js");

describe("OpenRouter :free Auto-Discovery & Fallback Híbrido", () => {
  beforeEach(() => {
    resetOpenRouterFreeDiscoveryForTests();
  });

  it("aceita estritamente modelos :free com custo zero e bloqueia modelos pagos ou suspeitos", () => {
    assert.equal(
      isStrictlyFreeOpenRouterEntry({
        id: "deepseek/deepseek-r1:free",
        pricing: { prompt: "0", completion: "0", request: "0", image: "0" }
      }),
      true
    );

    // Sem sufixo :free -> rejeitado mesmo com preço 0
    assert.equal(
      isStrictlyFreeOpenRouterEntry({
        id: "deepseek/deepseek-r1",
        pricing: { prompt: "0", completion: "0" }
      }),
      false
    );

    // Preço não zero -> rejeitado mesmo com sufixo :free
    assert.equal(
      isStrictlyFreeOpenRouterEntry({
        id: "evil/paid-model:free",
        pricing: { prompt: "0.0001", completion: "0" }
      }),
      false
    );

    assert.equal(
      isStrictlyFreeOpenRouterEntry({
        id: "evil/image-paid:free",
        pricing: { prompt: "0", completion: "0", image: "0.05" }
      }),
      false
    );

    // Sem objeto pricing -> rejeitado (fail-closed)
    assert.equal(
      isStrictlyFreeOpenRouterEntry({
        id: "unknown/no-pricing:free"
      }),
      false
    );

    // Embedding / moderation / caracteres inválidos -> rejeitado
    assert.equal(
      isStrictlyFreeOpenRouterEntry({
        id: "openai/text-embedding-3:free",
        pricing: { prompt: "0", completion: "0" }
      }),
      false
    );

    assert.equal(
      isStrictlyFreeOpenRouterEntry({
        id: "bad/model name;drop:free",
        pricing: { prompt: "0", completion: "0" }
      }),
      false
    );
  });

  it("ranqueia catálogo :free, mantém preferidos online no topo e demove modelos removidos", async () => {
    let fetchCalls = 0;
    const mockFetch = async () => {
      fetchCalls++;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            {
              id: "paid/gpt-5",
              context_length: 256000,
              pricing: { prompt: "0.005", completion: "0.015" }
            },
            {
              id: "tiny/mini-2b:free",
              context_length: 8192,
              pricing: { prompt: "0", completion: "0" }
            },
            {
              id: "deepseek/deepseek-r1:free",
              context_length: 163840,
              pricing: { prompt: "0", completion: "0" }
            },
            {
              id: "google/gemma-4-31b-it:free",
              context_length: 131072,
              architecture: { input_modalities: ["text", "image"] },
              pricing: { prompt: "0", completion: "0" }
            },
            {
              id: "meta-llama/llama-3.3-70b-instruct:free",
              context_length: 131072,
              pricing: { prompt: "0", completion: "0" }
            }
          ]
        })
      };
    };

    const parsed = parseFreeOpenRouterCatalog(await (await mockFetch()).json());
    assert.equal(parsed.every((m) => m.id.endsWith(":free")), true);
    assert.equal(parsed[0]?.id, "deepseek/deepseek-r1:free");

    fetchCalls = 0;
    const now = 1_700_000_000_000;
    const preferred = [
      "legacy/removed-model:free",
      "google/gemma-4-31b-it:free"
    ];

    const list1 = await resolveOpenRouterFreeModels(preferred, {
      nowMs: now,
      fetchFn: mockFetch
    });
    assert.equal(fetchCalls, 1);

    // Preferido online fica em #1, descobertos vêm em seguida, preferido que sumiu vai pro fim
    assert.equal(list1[0], "google/gemma-4-31b-it:free");
    assert.equal(list1[1], "deepseek/deepseek-r1:free");
    assert.equal(list1[list1.length - 1], "legacy/removed-model:free");

    // Segunda chamada dentro das 6h usa cache (0 novos fetches)
    await resolveOpenRouterFreeModels(preferred, {
      nowMs: now + 60_000,
      fetchFn: mockFetch
    });
    assert.equal(fetchCalls, 1);

    // Force refresh consulta novamente
    await refreshOpenRouterFreeCatalog({
      force: true,
      nowMs: now + 60_000,
      fetchFn: mockFetch
    });
    assert.equal(fetchCalls, 2);
  });

  it("coloca modelos com 404/429 em cooldown e restaura após expirar ou sucesso", () => {
    const preferred = [
      "a/first:free",
      "b/second:free",
      "c/third:free"
    ];
    const t0 = 1_700_000_000_000;

    recordOpenRouterModelFailure(
      "a/first:free",
      { kind: "rate_limit", retryAfterMs: 180_000 },
      t0
    );

    const duringCooldown = buildHybridFreeModelList(preferred, t0 + 10_000);
    assert.deepEqual(duringCooldown, [
      "b/second:free",
      "c/third:free",
      "a/first:free"
    ]);

    const snap = getOpenRouterFreeDiscoverySnapshot(preferred, t0 + 10_000);
    assert.equal(snap.cooledDown.length, 1);
    assert.equal(snap.cooledDown[0]?.model, "a/first:free");

    // Depois de expirar o cooldown de 3 min, volta ao topo
    const afterCooldown = buildHybridFreeModelList(preferred, t0 + 200_000);
    assert.equal(afterCooldown[0], "a/first:free");

    // Sucesso limpa cooldown imediatamente
    recordOpenRouterModelFailure("b/second:free", { kind: "model" }, t0);
    assert.equal(buildHybridFreeModelList(preferred, t0 + 1000).at(-1), "b/second:free");
    recordOpenRouterModelSuccess("b/second:free");
    assert.equal(buildHybridFreeModelList(preferred, t0 + 1000)[1], "b/second:free");
  });

  it("faz fallback imediato para outro modelo :free quando o primeiro retorna 429 com retryAfter longo", async () => {
    const gate = new UsageGate("openrouter", { rpm: 20, rpd: 50 }, "UTC", 0.9);
    const tried: string[] = [];
    const failed: string[] = [];
    const succeeded: string[] = [];

    const result = await runWithFallback({
      models: ["a/congested:free", "b/healthy:free"],
      resolveModels: () => ["a/congested:free", "b/healthy:free"],
      maxHttpAttempts: 3,
      gate,
      request: {
        system: "sys",
        user: "hi",
        maxTokens: 100
      },
      onModelError: (m, err) => {
        failed.push(`${m}:${err.kind}`);
        recordOpenRouterModelFailure(m, err);
      },
      onModelSuccess: (m) => {
        succeeded.push(m);
        recordOpenRouterModelSuccess(m);
      },
      call: async (model) => {
        tried.push(model);
        if (model === "a/congested:free") {
          throw new ProviderError("rate_limit", "429 upstream busy", {
            status: 429,
            retryAfterMs: 120_000
          });
        }
        return { text: "Resposta via modelo B", totalTokens: 42 };
      }
    });

    assert.equal(result.model, "b/healthy:free");
    assert.equal(result.text, "Resposta via modelo B");
    assert.deepEqual(tried, ["a/congested:free", "b/healthy:free"]);
    assert.deepEqual(failed, ["a/congested:free:rate_limit"]);
    assert.deepEqual(succeeded, ["b/healthy:free"]);
  });

  it("mantém fallback seguro para lista do .env se /models do OpenRouter falhar", async () => {
    const preferred = ["a/env-model:free", "b/env-model:free"];
    const result = await resolveOpenRouterFreeModels(preferred, {
      fetchFn: async () => ({
        ok: false,
        status: 503,
        json: async () => ({})
      })
    });

    assert.deepEqual(result, preferred);
    const snap = getOpenRouterFreeDiscoverySnapshot(preferred);
    assert.equal(snap.source, "fallback");
    assert.ok(snap.lastError?.includes("503"));
  });
});

describe("Integridade de Atalhos (Ctrl+K, Menu / Templates) e Segurança XSS", () => {
  it("contém elementos DOM de Paleta, Menu / e OpenRouter :free e zero innerHTML em shortcuts.js", async () => {
    const html = await readFile(resolve("public/index.html"), "utf8");
    const shortcutsJs = await readFile(resolve("public/js/shortcuts.js"), "utf8");

    assert.ok(html.includes('id="command-palette-modal"'));
    assert.ok(html.includes('id="command-palette-input"'));
    assert.ok(html.includes('id="slash-templates-menu"'));
    assert.ok(html.includes('id="openrouter-refresh-free-btn"'));
    assert.ok(html.includes('id="openrouter-free-models-list"'));

    // Segurança XSS: shortcuts.js constrói todo DOM com textContent, nunca innerHTML
    assert.equal(/\binnerHTML\b/.test(shortcutsJs), false);
    assert.ok(shortcutsJs.includes("isSecurityLockVisible"));
  });
});
