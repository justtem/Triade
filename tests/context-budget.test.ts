import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  budgetForPlatform,
  RECENT_FULL_TURNS
} from "../src/shared/context-budget.js";

describe("context-budget — Orçamento de Contexto por Provedor", () => {
  it("define RECENT_FULL_TURNS positivo para compactação da Memória Compartilhada", () => {
    assert.ok(RECENT_FULL_TURNS >= 2);
  });

  it("retorna o maior orçamento para Gemini e margem ampla para código sem cortes", () => {
    const gemini = budgetForPlatform("gemini");
    const openrouter = budgetForPlatform("openrouter");

    assert.ok(gemini.historyChars >= openrouter.historyChars);
    assert.ok(gemini.attachmentChars >= openrouter.attachmentChars);
    assert.ok(gemini.maxTokens.initial_response >= 6000);
    assert.ok(gemini.maxTokens.synthesis >= 8000);
    assert.ok(openrouter.maxTokens.initial_response >= 4800);
    assert.ok(gemini.maxTokens.synthesis >= gemini.maxTokens.initial_response);
  });

  it("protege o Groq gratuito (8.000 TPM) com orçamento compacto por padrão", () => {
    const prev = process.env.GROQ_TPM;
    delete process.env.GROQ_TPM;
    try {
      const groq = budgetForPlatform("groq");
      const gemini = budgetForPlatform("gemini");

      assert.ok(groq.historyChars < gemini.historyChars);
      assert.ok(groq.maxTokens.initial_response <= 1600);
      assert.ok(groq.maxRecentTurns <= 3);
    } finally {
      if (prev !== undefined) process.env.GROQ_TPM = prev;
    }
  });

  it("eleva o orçamento do Groq automaticamente quando GROQ_TPM >= 30000", () => {
    const prev = process.env.GROQ_TPM;
    process.env.GROQ_TPM = "30000";
    try {
      const groqHigh = budgetForPlatform("groq");
      const openrouter = budgetForPlatform("openrouter");
      assert.deepEqual(groqHigh, openrouter);
    } finally {
      if (prev !== undefined) {
        process.env.GROQ_TPM = prev;
      } else {
        delete process.env.GROQ_TPM;
      }
    }
  });
});
