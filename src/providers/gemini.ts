import { GoogleGenAI } from "@google/genai";

import { runWithFallback } from "./policy.js";
import type { Provider } from "./types.js";
import type { UsageGate } from "./usage-gate.js";

export interface GeminiOptions {
  apiKey: string;
  models: readonly string[];
  gate: UsageGate;
  maxHttpAttempts: number;

  /** Apenas para testes locais com servidor falso. */
  baseUrl?: string;
}

/** Modelos 2.5 Flash aceitam desligar o "thinking" (economiza tokens e evita resposta cortada). */
function canDisableThinking(model: string): boolean {
  return /^gemini-2\.5-flash/.test(model);
}

export function makeGemini(options: GeminiOptions): Provider {
  const ai = new GoogleGenAI({
    apiKey: options.apiKey,
    httpOptions: {
      timeout: 90_000,
      // Por padrão o SDK tenta até 5 vezes sozinho. Aqui é 1 só: as
      // retentativas são controladas (e contadas) pelo UsageGate.
      retryOptions: { attempts: 1 },
      ...(options.baseUrl ? { baseUrl: options.baseUrl } : {})
    }
  });

  return {
    id: "gemini",
    name: "Gemini",
    models: options.models,

    async generate(request) {
      return runWithFallback({
        models: options.models,
        maxHttpAttempts: options.maxHttpAttempts,
        gate: options.gate,
        request,
        headroom: 1_000,
        call: async (model) => {
          const noThinking = canDisableThinking(model);
          const config = {
            systemInstruction: request.system,
            maxOutputTokens: request.maxTokens + (noThinking ? 0 : 1_500),
            temperature: 0.4,
            ...(noThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {})
          };

          if (request.onDelta) {
            const stream = await ai.models.generateContentStream({
              model,
              contents: request.user,
              config
            });

            let fullText = "";
            let inputTokens: number | undefined;
            let outputTokens: number | undefined;
            let totalTokens: number | undefined;

            for await (const chunk of stream) {
              const piece = chunk.text ?? "";
              if (piece) {
                fullText += piece;
                request.onDelta(piece);
              }
              if (chunk.usageMetadata) {
                inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
                outputTokens =
                  chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
                totalTokens = chunk.usageMetadata.totalTokenCount ?? totalTokens;
              }
            }

            return {
              text: fullText,
              inputTokens,
              outputTokens,
              totalTokens
            };
          }

          const response = await ai.models.generateContent({
            model,
            contents: request.user,
            config
          });

          return {
            text: response.text ?? "",
            inputTokens: response.usageMetadata?.promptTokenCount,
            outputTokens: response.usageMetadata?.candidatesTokenCount,
            totalTokens: response.usageMetadata?.totalTokenCount
          };
        }
      });
    }
  };
}
