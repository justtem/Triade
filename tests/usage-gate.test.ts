import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "ai-council-usage-test-"));
process.env.AI_COUNCIL_DATA_DIR = tempDir;

const { UsageGate } = await import("../src/providers/usage-gate.js");
const { ProviderError } = await import("../src/providers/types.js");

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("UsageGate — Trava de Custo Zero (90% safety)", () => {
  it("aplica margem de segurança de 90% nos limites diários e por minuto", async () => {
    const gate = new UsageGate("test-safety", {
      rpm: 10,
      rpd: 100,
      tpm: 10_000,
      tpd: 100_000
    });

    const snap = await gate.snapshot();
    assert.equal(snap.requestsPerMinuteCap, 9);
    assert.equal(snap.requestsDailyCap, 90);
    assert.equal(snap.tokensPerMinuteCap, 9_000);
    assert.equal(snap.tokensDailyCap, 90_000);
    assert.equal(snap.requestsToday, 0);
    assert.equal(snap.tokensToday, 0);
  });

  it("bloqueia com quota_exhausted ao atingir o teto efetivo de requisições diárias", async () => {
    // rpd = 3 com safety 0.9 -> Math.floor(2.7) = 2 chamadas efetivas
    const gate = new UsageGate("test-rpd-cap", {
      rpm: 10,
      rpd: 3
    });

    const t1 = await gate.acquire(100);
    t1.settle(120);

    const t2 = await gate.acquire(100);
    t2.settle(80);

    const snap = await gate.snapshot();
    assert.equal(snap.requestsToday, 2);
    assert.equal(snap.tokensToday, 200);

    await assert.rejects(
      () => gate.acquire(100),
      (err: unknown) =>
        err instanceof ProviderError && err.kind === "quota_exhausted"
    );
  });

  it("ajusta tokens corretamente no settle() e zera estimativa em falha (settle(0))", async () => {
    const gate = new UsageGate("test-settle", {
      rpm: 10,
      rpd: 20,
      tpd: 1_000
    });

    // 1ª chamada: estimou 300, consumiu apenas 150
    const t1 = await gate.acquire(300);
    t1.settle(150);
    // Chamar settle() uma segunda vez deve ser idempotente
    t1.settle(999);

    let snap = await gate.snapshot();
    assert.equal(snap.tokensToday, 150);

    // 2ª chamada: falhou antes de gerar saída -> settle(0)
    const t2 = await gate.acquire(400);
    t2.settle(0);

    snap = await gate.snapshot();
    assert.equal(snap.requestsToday, 2);
    assert.equal(snap.tokensToday, 150);
  });

  it("bloqueia com quota_exhausted quando a estimativa ultrapassa o TPD efetivo", async () => {
    // tpd = 1000 com safety 0.9 -> 900 tokens efetivos
    const gate = new UsageGate("test-tpd-cap", {
      rpm: 10,
      rpd: 50,
      tpd: 1_000
    });

    const t1 = await gate.acquire(500);
    t1.settle(600);

    await assert.rejects(
      () => gate.acquire(350),
      (err: unknown) =>
        err instanceof ProviderError && err.kind === "quota_exhausted"
    );
  });

  it("aborta imediatamente sem consumir cota quando AbortSignal já está abortado", async () => {
    const gate = new UsageGate("test-abort-signal", {
      rpm: 10,
      rpd: 20
    });

    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () => gate.acquire(100, controller.signal),
      (err: unknown) =>
        err instanceof ProviderError && err.kind === "aborted"
    );

    const snap = await gate.snapshot();
    assert.equal(snap.requestsToday, 0);
    assert.equal(snap.tokensToday, 0);
  });
});
