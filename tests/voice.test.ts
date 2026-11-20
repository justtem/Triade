import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import {
  normalizeAudioMimeType,
  transcribeAudioWithGroq
} from "../src/providers/whisper.js";
import {
  resolvePersonaVoiceConfig,
  sanitizeTextForNeuralSpeech
} from "../src/providers/tts.js";

const voiceMod = await import(
  pathToFileURL(resolve("public/js/voice.js")).href
);

describe("voice & whisper — Transcrição Groq Whisper e TTS", () => {
  it("normaliza mime-types de áudio de Android (webm;codecs=opus) e iOS (mp4/m4a)", () => {
    assert.deepEqual(normalizeAudioMimeType("audio/webm;codecs=opus"), {
      mimeType: "audio/webm",
      extension: "webm"
    });
    assert.deepEqual(normalizeAudioMimeType("audio/mp4"), {
      mimeType: "audio/mp4",
      extension: "m4a"
    });
    assert.deepEqual(normalizeAudioMimeType("audio/ogg; codecs=opus"), {
      mimeType: "audio/ogg",
      extension: "ogg"
    });
    assert.deepEqual(normalizeAudioMimeType("unknown/format"), {
      mimeType: "audio/webm",
      extension: "webm"
    });
  });

  it("rejeita áudio vazio ou curto demais antes de chamar a API da Groq", async () => {
    const prevKey = process.env.GROQ_API_KEY;
    process.env.GROQ_API_KEY = "gsk_test_dummy";
    try {
      await assert.rejects(
        () => transcribeAudioWithGroq({ audioBase64: "" }),
        /vazio/i
      );
      await assert.rejects(
        () =>
          transcribeAudioWithGroq({
            audioBase64: Buffer.from("tiny").toString("base64")
          }),
        /curta demais/i
      );
    } finally {
      if (prevKey !== undefined) process.env.GROQ_API_KEY = prevKey;
      else delete process.env.GROQ_API_KEY;
    }
  });

  it("cleanMarkdownForSpeech remove blocos de código, links e citações mantendo leitura natural", () => {
    const md = [
      "## Resposta Principal [1]",
      "Use **Node.js** conforme [a documentação](https://nodejs.org).",
      "```js",
      "const x = 1 + 2;",
      "```",
      "- Item `importante` final."
    ].join("\n");

    const spoken = voiceMod.cleanMarkdownForSpeech(md);
    assert.ok(spoken.includes("Resposta Principal"));
    assert.ok(spoken.includes("Use Node.js conforme a documentação."));
    assert.ok(spoken.includes("Bloco de código omitido"));
    assert.ok(!spoken.includes("https://nodejs.org"));
    assert.ok(!spoken.includes("[1]"));
    assert.ok(!spoken.includes("const x = 1 + 2"));
  });

  it("splitSpeechChunks divide textos longos em blocos seguros <= 220 caracteres", () => {
    const longText =
      "Primeira frase longa explicando o conceito de arquitetura de software. ".repeat(
        10
      );
    const chunks = voiceMod.splitSpeechChunks(longText, 220);
    assert.ok(chunks.length >= 3);
    for (const chunk of chunks) {
      assert.ok(chunk.length <= 220);
    }
  });

  it("resolvePersonaVoiceConfig atribui vozes e ritmos distintos para cada IA + suporta personalização", () => {
    const gemini = resolvePersonaVoiceConfig("gemini");
    const groq = resolvePersonaVoiceConfig("groq");
    const openrouter = resolvePersonaVoiceConfig("openrouter");
    const judge = resolvePersonaVoiceConfig("judge");

    assert.equal(gemini.edgeVoice, "pt-BR-ThalitaMultilingualNeural");
    assert.equal(groq.edgeVoice, "pt-BR-AntonioNeural");
    assert.equal(groq.rate, "+6%");
    assert.equal(openrouter.edgeVoice, "pt-BR-FranciscaNeural");
    assert.equal(judge.edgeVoice, "pt-BR-AntonioNeural");
    assert.equal(judge.pitch, "-4Hz");

    const custom = resolvePersonaVoiceConfig("gemini", "antonio");
    assert.equal(custom.edgeVoice, "pt-BR-AntonioNeural");
  });

  it("sanitizeTextForNeuralSpeech limpa SSML/código e trunca em fim de frase até o limite", () => {
    const dirty = "Veja <tag> & ```ts\nconst a = 1;\n``` Fim da frase.";
    const clean = sanitizeTextForNeuralSpeech(dirty, 3500);
    assert.ok(!clean.includes("<tag>"));
    assert.ok(!clean.includes("&"));
    assert.ok(clean.includes("Bloco de código omitido"));

    const huge = "Esta é uma frase completa sobre engenharia de software. ".repeat(100);
    const truncated = sanitizeTextForNeuralSpeech(huge, 300);
    assert.ok(truncated.length <= 360);
    assert.ok(truncated.includes("Continuação resumida no texto."));
  });
});
