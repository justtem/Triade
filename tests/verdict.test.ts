import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildVerdictUserPrompt,
  parseVerdictJson
} from "../src/debate/verdict.js";

describe("verdict — Consenso vs. Divergência / Veredito", () => {
  it("faz parsing de JSON estruturado dentro de code block markdown e normaliza winner", () => {
    const raw = `\`\`\`json
{
  "consensus": ["Usar índice composto no banco", "Validar payload com Zod"],
  "divergences": ["Groq alertou sobre race condition no lock, Gemini não citou"],
  "winner": "Groq",
  "winnerReason": "Groq identificou o bug crítico de concorrência.",
  "practicalSummary": "Aplique a arquitetura do Gemini com a trava de concorrência apontada pelo Groq."
}
\`\`\``;

    const parsed = parseVerdictJson(raw, ["gemini", "groq", "openrouter"]);
    assert.equal(parsed.winner, "groq");
    assert.equal(parsed.consensus.length, 2);
    assert.equal(parsed.divergences.length, 1);
    assert.ok(parsed.winnerReason.includes("concorrência"));
    assert.ok(parsed.practicalSummary.includes("trava"));
  });

  it("reconhece empate (tie) e faz fallback seguro quando o modelo foge do JSON", () => {
    const tie = parseVerdictJson(
      JSON.stringify({
        consensus: ["Ambas corretas"],
        divergences: ["Apenas estilo"],
        winner: "empate",
        winnerReason: "Mesmo nível técnico",
        practicalSummary: "Qualquer uma das duas resolve bem."
      }),
      ["gemini", "openrouter"]
    );
    assert.equal(tie.winner, "tie");

    const plainText = parseVerdictJson(
      "As duas respostas são parecidas e recomendam usar SQLite.",
      ["gemini", "groq"]
    );
    assert.equal(plainText.winner, "tie");
    assert.ok(plainText.practicalSummary.includes("SQLite"));
  });

  it("buildVerdictUserPrompt compacta adequadamente para Groq (8k TPM) vs Gemini", () => {
    const longResponses = [
      {
        id: "r1",
        taskId: "t1",
        round: 1,
        stage: "initial_response" as const,
        platform: "gemini" as const,
        promptUsed: "",
        content: "Análise extensa do Gemini. ".repeat(500),
        submittedAt: "2026-11-20T00:00:00.000Z"
      },
      {
        id: "r2",
        taskId: "t2",
        round: 1,
        stage: "initial_response" as const,
        platform: "openrouter" as const,
        promptUsed: "",
        content: "Análise extensa do OpenRouter. ".repeat(500),
        submittedAt: "2026-11-20T00:00:01.000Z"
      }
    ];

    const groqPrompt = buildVerdictUserPrompt("Compare opções", longResponses, "groq");
    const geminiPrompt = buildVerdictUserPrompt("Compare opções", longResponses, "gemini");

    assert.ok(groqPrompt.length < geminiPrompt.length);
    assert.ok(groqPrompt.includes('"gemini"'));
    assert.ok(groqPrompt.includes('"openrouter"'));
  });
});
