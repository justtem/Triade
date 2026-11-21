import { GoogleGenAI } from "@google/genai";

import { runWithFallback, type HedgePlan } from "./policy.js";
import type { Provider, ProviderError } from "./types.js";
import type { UsageGate } from "./usage-gate.js";

export interface GeminiOptions {
  apiKey: string;
  models: readonly string[];
  resolveModels?: () => Promise<readonly string[]> | readonly string[];
  resolveHedgePlan?: (models: readonly string[]) => HedgePlan | null;
  onModelSuccess?: (model: string, ttfbMs?: number) => void;
  onModelError?: (model: string, error: ProviderError) => void;
  gate: UsageGate;
  maxHttpAttempts: number;

  /** Apenas para testes locais com servidor falso. */
  baseUrl?: string;
}

/**
 * Define o teto de thinking por família Gemini:
 * - 2.5 Flash: desliga thinking (0) para máxima velocidade e zero desperdício de saída.
 * - 3.x Flash: limita o orçamento de thinking (1024 ou 2048 em sínteses longas) para
 *   impedir que o modelo leve 2 minutos pensando e corte o código gerado no meio.
 */
function resolveThinkingBudget(model: string, maxTokens: number): number | null {
  if (/^gemini-2\.5-flash/.test(model)) return 0;
  if (/^gemini-3(?:\.\d+)?-flash/.test(model)) {
    return maxTokens >= 6000 ? 2048 : 1024;
  }
  return null;
}

function isGeminiMaxTokensFinish(candidate: unknown): boolean {
  if (!candidate || typeof candidate !== "object") return false;
  const reason = String((candidate as { finishReason?: unknown }).finishReason ?? "").toUpperCase();
  return reason === "MAX_TOKENS";
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
        resolveModels: options.resolveModels,
        resolveHedgePlan: options.resolveHedgePlan,
        onModelSuccess: options.onModelSuccess,
        onModelError: options.onModelError,
        maxHttpAttempts: options.maxHttpAttempts,
        gate: options.gate,
        request,
        headroom: 1_000,
        call: async (model, hooks) => {
          const effectiveSignal = hooks?.signal ?? request.signal;
          const effectiveOnDelta = hooks?.onDelta ?? request.onDelta;
          const thinkingBudget = resolveThinkingBudget(model, request.maxTokens);

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

          const executeGemini = async (useGrounding: boolean, useThinkingCap = true) => {
            const applyThinking = useThinkingCap && thinkingBudget !== null;
            const outputBudget = Math.min(
              16_384,
              request.maxTokens + (applyThinking ? thinkingBudget : 1_500)
            );
            const config = {
              systemInstruction: request.system,
              maxOutputTokens: outputBudget,
              temperature: 0.4,
              ...(effectiveSignal ? { abortSignal: effectiveSignal } : {}),
              ...(applyThinking ? { thinkingConfig: { thinkingBudget } } : {}),
              ...(useGrounding ? { tools: [{ googleSearch: {} }] } : {})
            };

            const groundingMap = new Map<string, string>();
            let truncated = false;

            if (effectiveOnDelta) {
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
                if (effectiveSignal?.aborted) {
                  break;
                }
                const piece = chunk.text ?? "";
                if (piece) {
                  fullText += piece;
                  effectiveOnDelta(piece);
                }
                if (chunk.usageMetadata) {
                  inputTokens = chunk.usageMetadata.promptTokenCount ?? inputTokens;
                  outputTokens =
                    chunk.usageMetadata.candidatesTokenCount ?? outputTokens;
                  totalTokens = chunk.usageMetadata.totalTokenCount ?? totalTokens;
                }
                const firstCand = (chunk as { candidates?: unknown[] }).candidates?.[0];
                if (isGeminiMaxTokensFinish(firstCand)) {
                  truncated = true;
                }
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
                ...(truncated ? { truncated: true } : {}),
                ...(groundingSources.length > 0 ? { groundingSources } : {})
              };
            }

            const response = await ai.models.generateContent({
              model,
              contents,
              config
            });

            const firstCand = (response as { candidates?: unknown[] }).candidates?.[0];
            if (isGeminiMaxTokensFinish(firstCand)) {
              truncated = true;
            }
            extractGeminiGroundingSources(firstCand, groundingMap);
            const groundingSources = Array.from(groundingMap.entries()).map(
              ([url, title]) => ({ title, url })
            );

            return {
              text: response.text ?? "",
              inputTokens: response.usageMetadata?.promptTokenCount,
              outputTokens: response.usageMetadata?.candidatesTokenCount,
              totalTokens: response.usageMetadata?.totalTokenCount,
              ...(truncated ? { truncated: true } : {}),
              ...(groundingSources.length > 0 ? { groundingSources } : {})
            };
          };

          const executeWithThinkingFallback = async (useGrounding: boolean) => {
            try {
              return await executeGemini(useGrounding, true);
            } catch (err) {
              if (effectiveSignal?.aborted || thinkingBudget === null) throw err;
              const msg = err instanceof Error ? err.message : String(err);
              if (/thinking|budget|400|invalid argument/i.test(msg)) {
                request.onReset?.();
                return executeGemini(useGrounding, false);
              }
              throw err;
            }
          };

          if (request.enableWebGrounding && Date.now() >= groundingDisabledUntil) {
            try {
              return await executeWithThinkingFallback(true);
            } catch (err) {
              if (effectiveSignal?.aborted) throw err;
              const msg = err instanceof Error ? err.message : String(err);
              const isGroundingQuotaOrUnsupported =
                /google_?search|tool|grounding|400|429|RESOURCE_EXHAUSTED|quota|not supported|invalid argument/i.test(
                  msg
                );
              if (!isGroundingQuotaOrUnsupported) throw err;
              // Desativa grounding por 6h para não desperdiçar cota no free tier
              groundingDisabledUntil = Date.now() + 6 * 60 * 60 * 1000;
              request.onReset?.();
              return executeWithThinkingFallback(false);
            }
          }

          return executeWithThinkingFallback(false);
        }
      });
    }
  };
}
