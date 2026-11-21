import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  buildGeminiAutopilotQueue,
  buildGroqAutopilotQueue,
  getProviderAutopilotSnapshot,
  isAllowedFreeGeminiModel,
  isAllowedGroqChatModel,
  isAutopilotModelCooledDown,
  parseGeminiCatalog,
  parseGroqCatalog,
  pickGeminiHedgePlan,
  recordAutopilotFailure,
  recordAutopilotSuccess,
  refreshGeminiCatalog,
  refreshGroqCatalog,
  resetModelAutopilotForTests
} from "../src/providers/model-autopilot.js";
import { runWithFallback } from "../src/providers/policy.js";
import { ProviderError } from "../src/providers/types.js";
import { UsageGate } from "../src/providers/usage-gate.js";

describe("Piloto Automático de Modelos (Gemini + Groq + Hedge Cirúrgico)", () => {
  let tempDir = "";
  let prevDataDir: string | undefined;

  beforeEach(async () => {
    prevDataDir = process.env.AI_COUNCIL_DATA_DIR;
    tempDir = await mkdtemp(join(tmpdir(), "ai-council-autopilot-"));
    process.env.AI_COUNCIL_DATA_DIR = tempDir;
    resetModelAutopilotForTests();
  });

  afterEach(async () => {
    resetModelAutopilotForTests();
    if (prevDataDir === undefined) {
      delete process.env.AI_COUNCIL_DATA_DIR;
    } else {
      process.env.AI_COUNCIL_DATA_DIR = prevDataDir;
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("Gemini allowlist aceita apenas Flash/Gemma gratuitos e bloqueia Pro, Gemini 4, TTS, Imagem e Lyria", () => {
    assert.equal(
      isAllowedFreeGeminiModel({
        name: "models/gemini-3.8-flash",
        supportedGenerationMethods: ["generateContent"]
      }),
      "gemini-3.8-flash"
    );
    assert.equal(
      isAllowedFreeGeminiModel({
        name: "models/gemini-3.5-flash-lite",
        supportedGenerationMethods: ["generateContent"]
      }),
      "gemini-3.5-flash-lite"
    );
    assert.equal(
      isAllowedFreeGeminiModel({
        name: "models/gemma-4-31b-it",
        supportedGenerationMethods: ["generateContent"]
      }),
      "gemma-4-31b-it"
    );

    const blocked = [
      "models/gemini-3.1-pro-preview",
      "models/gemini-2.5-pro",
      "models/gemini-4-argon",
      "models/gemini-4-neon",
      "models/gemini-3.8-flash-tts",
      "models/gemini-3.1-flash-image",
      "models/nano-banana-pro",
      "models/lyria-3.5",
      "models/gemini-robotics-er-2-preview",
      "models/deep-research-preview-04-2026",
      "models/gemini-flash-latest"
    ];
    for (const name of blocked) {
      assert.equal(
        isAllowedFreeGeminiModel({
          name,
          supportedGenerationMethods: ["generateContent"]
        }),
        null,
        `Deveria bloquear ${name}`
      );
    }
  });

  it("Groq allowlist descobre qwen3.8-27b e filtra Whisper, Orpheus, Prompt Guard, Safeguard e Allam", () => {
    const parsed = parseGroqCatalog({
      data: [
        { id: "whisper-large-v3", active: true, context_window: 448 },
        { id: "canopylabs/orpheus-v1-english", active: true, context_window: 4000 },
        { id: "meta-llama/llama-prompt-guard-2-86m", active: true, context_window: 512 },
        { id: "openai/gpt-oss-safeguard-20b", active: true, context_window: 131072 },
        { id: "allam-2-7b", active: true, context_window: 4096 },
        { id: "openai/gpt-oss-20b", active: true, context_window: 131072 },
        { id: "qwen/qwen3.8-27b", active: true, context_window: 131072 },
        { id: "openai/gpt-oss-120b", active: true, context_window: 131072 }
      ]
    });

    assert.deepEqual(parsed, [
      "openai/gpt-oss-120b",
      "qwen/qwen3.8-27b",
      "openai/gpt-oss-20b"
    ]);
    assert.equal(
      isAllowedGroqChatModel({ id: "inactive/model", active: false, context_window: 131072 }),
      null
    );
  });

  it("monta fila enxuta no Gemini (3.8 #1 -> 3.5-flash-lite #2 imediato) e aplica backoff exponencial + quarentena 24h", async () => {
    await refreshGeminiCatalog({
      apiKey: "test-key",
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          models: [
            { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-3.6-flash", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-3.7-flash", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
            { name: "models/gemini-4-neon", supportedGenerationMethods: ["generateContent"] }
          ]
        })
      })
    });

    const preferred = ["gemini-3.5-flash-lite", "gemini-3.5-flash"];
    const t0 = 1_700_000_000_000;
    const queue = buildGeminiAutopilotQueue(preferred, t0);

    // #1 é o mais novo (3.8), #2 e #3 são a pista rápida 3.5 (sem pedágio triplo 3.7/3.6 antes do 3.5!)
    assert.equal(queue[0], "gemini-3.8-flash");
    assert.equal(queue[1], "gemini-3.5-flash-lite");
    assert.equal(queue[2], "gemini-3.5-flash");
    assert.equal(queue.includes("gemini-4-neon"), false);

    const plan = pickGeminiHedgePlan(queue, preferred, t0);
    assert.ok(plan);
    assert.equal(plan.primary, "gemini-3.8-flash");
    assert.equal(plan.fastBackup, "gemini-3.5-flash-lite");

    // 1ª falha 503 no 3.8 -> cooldown de 1h; fila cai imediatamente pro 3.5-flash-lite!
    await recordAutopilotFailure(
      "gemini",
      "gemini-3.8-flash",
      { kind: "transient", message: "503 high demand" },
      t0
    );
    assert.equal(isAutopilotModelCooledDown("gemini", "gemini-3.8-flash", t0 + 30 * 60_000), true);
    assert.equal(buildGeminiAutopilotQueue(preferred, t0 + 30 * 60_000)[0], "gemini-3.5-flash-lite");
    // Depois de 1h01m sai do cooldown
    assert.equal(isAutopilotModelCooledDown("gemini", "gemini-3.8-flash", t0 + 61 * 60_000), false);

    // 2ª falha seguida -> sobe para 3h!
    await recordAutopilotFailure(
      "gemini",
      "gemini-3.8-flash",
      { kind: "transient", message: "503 high demand" },
      t0 + 62 * 60_000
    );
    assert.equal(
      isAutopilotModelCooledDown("gemini", "gemini-3.8-flash", t0 + 62 * 60_000 + 2 * 60 * 60_000),
      true
    );

    // Erro limit: 0 -> quarentena de 24h
    await recordAutopilotFailure(
      "gemini",
      "gemini-3.6-flash",
      { kind: "rate_limit", message: "Quota exceeded, limit: 0" },
      t0
    );
    assert.equal(
      isAutopilotModelCooledDown("gemini", "gemini-3.6-flash", t0 + 20 * 60 * 60_000),
      true
    );

    // Sucesso zera cooldown e salva latência
    await recordAutopilotSuccess("gemini", "gemini-3.8-flash", 950, t0 + 400_000_000);
    assert.equal(isAutopilotModelCooledDown("gemini", "gemini-3.8-flash", t0 + 400_001_000), false);
    const snap = await getProviderAutopilotSnapshot("gemini", preferred, t0 + 400_001_000);
    assert.equal(snap.latenciesMs["gemini-3.8-flash"], 950);
  });

  it("Groq integra qwen3.8-27b descoberto na fila híbrida atrás dos preferidos", async () => {
    await refreshGroqCatalog({
      apiKey: "test-groq-key",
      fetchFn: async () => ({
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { id: "openai/gpt-oss-120b", active: true, context_window: 131072 },
            { id: "qwen/qwen3.8-27b", active: true, context_window: 131072 },
            { id: "openai/gpt-oss-20b", active: true, context_window: 131072 }
          ]
        })
      })
    });

    const queue = buildGroqAutopilotQueue(["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
    assert.deepEqual(queue, [
      "openai/gpt-oss-120b",
      "openai/gpt-oss-20b",
      "qwen/qwen3.8-27b"
    ]);
  });

  it("Hedged Request: quando 3.8 é rápido (<delayMs), vence com 1 req só e nunca chama o backup", async () => {
    const gate = new UsageGate("gemini-hedge-fast", { rpm: 5, rpd: 100 }, "UTC", 0.9);
    const calls: string[] = [];
    const chunks: string[] = [];

    const res = await runWithFallback({
      models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"],
      resolveHedgePlan: () => ({
        primary: "gemini-3.8-flash",
        fastBackup: "gemini-3.5-flash-lite",
        delayMs: 120,
        primaryProvenFast: false
      }),
      maxHttpAttempts: 2,
      gate,
      request: {
        system: "sys",
        user: "hi",
        maxTokens: 50,
        onDelta: (d) => chunks.push(d)
      },
      call: async (model, hooks) => {
        calls.push(model);
        await new Promise((r) => setTimeout(r, 15));
        hooks?.onDelta?.("Resposta ");
        hooks?.onDelta?.("3.8");
        return { text: "Resposta 3.8", totalTokens: 20 };
      }
    });

    assert.equal(res.model, "gemini-3.8-flash");
    assert.deepEqual(calls, ["gemini-3.8-flash"]);
    assert.equal(chunks.join(""), "Resposta 3.8");
  });

  it("Hedged Request: quando 3.8 trava (>delayMs), dispara 3.5-flash-lite, vence sem misturar chunks e marca 3.8 em cooldown", async () => {
    const gate = new UsageGate("gemini-hedge-slow", { rpm: 5, rpd: 100 }, "UTC", 0.9);
    const calls: string[] = [];
    const chunks: string[] = [];
    const errors: string[] = [];

    const res = await runWithFallback({
      models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"],
      resolveHedgePlan: () => ({
        primary: "gemini-3.8-flash",
        fastBackup: "gemini-3.5-flash-lite",
        delayMs: 40,
        primaryProvenFast: false
      }),
      maxHttpAttempts: 2,
      gate,
      request: {
        system: "sys",
        user: "hi",
        maxTokens: 50,
        onDelta: (d) => chunks.push(d)
      },
      onModelError: (m) => errors.push(m),
      call: async (model, hooks) => {
        calls.push(model);
        if (model === "gemini-3.8-flash") {
          // Simula modelo mudo/congestionado até ser abortado
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, 2000);
            hooks?.signal?.addEventListener("abort", () => {
              clearTimeout(t);
              reject(new ProviderError("aborted", "Abortado"));
            });
          });
          return { text: "tarde demais" };
        }
        await new Promise((r) => setTimeout(r, 15));
        hooks?.onDelta?.("Rápido ");
        hooks?.onDelta?.("3.5");
        return { text: "Rápido 3.5", totalTokens: 18 };
      }
    });

    assert.equal(res.model, "gemini-3.5-flash-lite");
    assert.deepEqual(calls, ["gemini-3.8-flash", "gemini-3.5-flash-lite"]);
    assert.equal(chunks.join(""), "Rápido 3.5");
    assert.ok(errors.includes("gemini-3.8-flash"));
  });

  it("Hedged Request: sem folga de RPM e com 3.8 não comprovado rápido, pula direto pro 3.5-flash-lite sem gastar 2 reqs", async () => {
    // RPM=3 * 0.9 -> cap=2; ocupa 1 slot -> sobra só 1 slot (<2 exigido pro hedge)
    const gate = new UsageGate("gemini-tight-rpm", { rpm: 3, rpd: 100 }, "UTC", 0.9);
    const t = await gate.acquire(10);
    t.settle(10);

    const calls: string[] = [];
    const res = await runWithFallback({
      models: ["gemini-3.8-flash", "gemini-3.5-flash-lite"],
      resolveHedgePlan: () => ({
        primary: "gemini-3.8-flash",
        fastBackup: "gemini-3.5-flash-lite",
        delayMs: 50,
        primaryProvenFast: false
      }),
      maxHttpAttempts: 2,
      gate,
      request: { system: "sys", user: "hi", maxTokens: 50 },
      call: async (model) => {
        calls.push(model);
        return { text: `ok ${model}`, totalTokens: 15 };
      }
    });

    assert.equal(res.model, "gemini-3.5-flash-lite");
    assert.deepEqual(calls, ["gemini-3.5-flash-lite"]);
  });

  it("parseGeminiCatalog ordena versões Flash em ordem decrescente e ignora modelos fora da allowlist", () => {
    const parsed = parseGeminiCatalog({
      models: [
        { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.8-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.5-flash-lite", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemma-4-31b-it", supportedGenerationMethods: ["generateContent"] },
        { name: "models/gemini-3.1-pro", supportedGenerationMethods: ["generateContent"] }
      ]
    });
    assert.deepEqual(parsed, [
      "gemini-3.8-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-2.5-flash",
      "gemma-4-31b-it"
    ]);
  });
});
