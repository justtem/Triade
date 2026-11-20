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

function extractGeminiGroundingSources(
  candidate: unknown,
  sink: Map<string, string>
): void {
  if (!candidate || typeof candidate !== "object") return;
  const meta = (candidate as { groundingMetadata?: unknown }).groundingMetadata;
  if (!meta || typeof meta !== "object") return;
  const chunks = (meta as { groundingChunks?: unknown }).groundingChunks;
  if (!Array.isArray(chunks)) return;

  for (const chunk of chunks) {
    if (!chunk || typeof chunk !== "object") continue;
    const web = (chunk as { web?: { uri?: string; title?: string } }).web;
    if (web?.uri && /^https?:\/\//i.test(web.uri)) {
      if (!sink.has(web.uri)) {
        sink.set(web.uri, (web.title ?? web.uri).trim().slice(0, 140));
      }
    }
  }
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

  // Cooldown automático caso a conta/modelo gratuita não tenha cota para Google Search Grounding
  let groundingDisabledUntil = 0;

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

          const mediaParts = (request.media ?? [])
            .filter((m) => m.dataBase64 && m.mimeType)
            .map((m) => ({
              inlineData: {
                mimeType: m.mimeType,
                data: m.dataBase64
              }
            }));

          const contents =
            mediaParts.length > 0
              ? [{ text: request.user }, ...mediaParts]
              : request.user;

          const executeGemini = async (useGrounding: boolean) => {
            const config = {
              systemInstruction: request.system,
              maxOutputTokens: request.maxTokens + (noThinking ? 0 : 1_500),
              temperature: 0.4,
              ...(request.signal ? { abortSignal: request.signal } : {}),
              ...(noThinking ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
              ...(useGrounding ? { tools: [{ googleSearch: {} }] } : {})
            };

            const groundingMap = new Map<string, string>();

            if (request.onDelta) {
              const stream = await ai.models.generateContentStream({
                model,
                contents,
                config
              });

              let fullText = "";
              let inputTokens: number | undefined;
              let outputTokens: number | undefined;
              let totalTokens: number | undefined;

              for await (const chunk of stream) {
                if (request.signal?.aborted) {
                  break;
                }
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
                const firstCand = (chunk as { candidates?: unknown[] }).candidates?.[0];
                extractGeminiGroundingSources(firstCand, groundingMap);
              }

              const groundingSources = Array.from(groundingMap.entries()).map(
                ([url, title]) => ({ title, url })
              );

              return {
                text: fullText,
                inputTokens,
                outputTokens,
                totalTokens,
                ...(groundingSources.length > 0 ? { groundingSources } : {})
              };
            }

            const response = await ai.models.generateContent({
              model,
              contents,
              config
            });

            const firstCand = (response as { candidates?: unknown[] }).candidates?.[0];
            extractGeminiGroundingSources(firstCand, groundingMap);
            const groundingSources = Array.from(groundingMap.entries()).map(
              ([url, title]) => ({ title, url })
            );

            return {
              text: response.text ?? "",
              inputTokens: response.usageMetadata?.promptTokenCount,
              outputTokens: response.usageMetadata?.candidatesTokenCount,
              totalTokens: response.usageMetadata?.totalTokenCount,
              ...(groundingSources.length > 0 ? { groundingSources } : {})
            };
          };

          if (request.enableWebGrounding && Date.now() >= groundingDisabledUntil) {
            try {
              return await executeGemini(true);
            } catch (err) {
              if (request.signal?.aborted) throw err;
              const msg = err instanceof Error ? err.message : String(err);
              const isGroundingQuotaOrUnsupported =
                /google_?search|tool|grounding|400|429|RESOURCE_EXHAUSTED|quota|not supported|invalid argument/i.test(
                  msg
                );
              if (!isGroundingQuotaOrUnsupported) throw err;
              // Desativa grounding por 6h para não desperdiçar cota no free tier
              groundingDisabledUntil = Date.now() + 6 * 60 * 60 * 1000;
              request.onReset?.();
              return executeGemini(false);
            }
          }

          return executeGemini(false);
        }
      });
    }
  };
}
