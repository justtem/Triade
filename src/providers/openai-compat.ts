import OpenAI from "openai";

import type { AutoPlatform } from "../shared/debate-types.js";
import { runWithFallback } from "./policy.js";
import type { Provider, ProviderError } from "./types.js";
import type { UsageGate } from "./usage-gate.js";

export interface OpenAICompatOptions {
  id: AutoPlatform;
  name: string;
  apiKey: string;
  baseURL: string;
  models: readonly string[];
  resolveModels?: () => Promise<readonly string[]> | readonly string[];
  onModelSuccess?: (model: string, ttfbMs?: number) => void;
  onModelError?: (model: string, error: ProviderError) => void;
  gate: UsageGate;
  maxHttpAttempts: number;

  /** Groq usa max_completion_tokens; OpenRouter usa max_tokens. */
  maxTokensParam: "max_tokens" | "max_completion_tokens";

  /** Margem extra para modelos que "pensam" antes de responder. */
  tokenHeadroom?: number;

  extraBody?: (model: string) => Record<string, unknown>;
  extraHeaders?: Record<string, string>;
}

/** Provedor para qualquer API compatível com o SDK da OpenAI (Groq, OpenRouter, NVIDIA NIM...). */
export function makeOpenAICompat(options: OpenAICompatOptions): Provider {
  const isNvidia = options.id === "nvidia";
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    // Sem retentativas escondidas do SDK: cada chamada HTTP passa pelo UsageGate.
    maxRetries: 0,
    // Apenas NVIDIA NIM recebe janela longa (180s) para modelos 550B gerando projetos inteiros sem corte;
    // Groq e OpenRouter mantêm 60s fixos (com proteção de inatividade/TTFB no stream abaixo).
    timeout: isNvidia ? 180_000 : 60_000,
    defaultHeaders: options.extraHeaders
  });

  const headroom = options.tokenHeadroom ?? 0;

  return {
    id: options.id,
    name: options.name,
    models: options.models,

    async generate(request) {
      return runWithFallback({
        models: options.models,
        resolveModels: options.resolveModels,
        onModelSuccess: options.onModelSuccess,
        onModelError: options.onModelError,
        maxHttpAttempts: options.maxHttpAttempts,
        gate: options.gate,
        request,
        headroom,
        call: async (model, hooks) => {
          const effectiveSignal = hooks?.signal ?? request.signal;
          const effectiveOnDelta = hooks?.onDelta ?? request.onDelta;
          const imageParts =
            options.id === "openrouter"
              ? (request.media ?? []).filter(
                  (m) => m.kind === "image" && m.dataBase64 && m.mimeType
                )
              : [];

          const executeCall = async (useVision: boolean) => {
            const userContent =
              useVision && imageParts.length > 0
                ? [
                    { type: "text" as const, text: request.user },
                    ...imageParts.map((img) => ({
                      type: "image_url" as const,
                      image_url: {
                        url: `data:${img.mimeType};base64,${img.dataBase64}`
                      }
                    }))
                  ]
                : request.user;

            // Folga dedicada de saída para modelos reasoning pesados:
            // - Na NVIDIA NIM (modelos 550B+): eleva até 16.384 tokens em código/debates (e teto 8.192 em modelos normais)
            //   para comportar o reasoning_content oculto + arquivos completos sem truncar.
            // - No OpenRouter: mantém +3.500 em modelos reasoning pesados; Groq/Gemini permanecem intactos.
            const isHeavyReasoningModel =
              /(?:nemotron-3.*ultra|deepseek-r1|reasoner|thinking|kimi-k3)/i.test(model);
            let effectiveMaxTokens = request.maxTokens + headroom;
            if (isNvidia) {
              if (isHeavyReasoningModel) {
                const reasoningExtra = request.maxTokens <= 1_200 ? 2_500 : 6_000;
                effectiveMaxTokens = Math.min(16_384, request.maxTokens + headroom + reasoningExtra);
              } else {
                effectiveMaxTokens = Math.min(8_192, request.maxTokens + headroom);
              }
            } else if (options.id === "openrouter" && isHeavyReasoningModel) {
              effectiveMaxTokens = request.maxTokens + headroom + 3_500;
            }

            const baseParams = {
              model,
              messages: [
                { role: "system" as const, content: request.system },
                { role: "user" as const, content: userContent }
              ],
              [options.maxTokensParam]: effectiveMaxTokens,
              ...(options.extraBody ? options.extraBody(model) : {})
            };

            if (effectiveOnDelta) {
              const streamParams = {
                ...baseParams,
                stream: true as const,
                ...(options.id === "groq"
                  ? { stream_options: { include_usage: true } }
                  : {})
              } as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming;

              // Proteção anti-travamento (TTFB + inatividade no stream):
              // Na NVIDIA NIM: 25s TTFB + 30s de folga para reasoning_content + 30s idle entre chunks
              // (permite até 180s enquanto estiver escrevendo código ativamente, mas aborta rápido se congelar).
              const ttfbLimitMs =
                options.id === "openrouter"
                  ? 25_000
                  : isNvidia
                    ? 25_000
                    : 18_000;
              const reasoningGraceMs = isNvidia ? 30_000 : 15_000;
              const streamIdleLimitMs = isNvidia ? 30_000 : 0;
              const ttfbCtrl = new AbortController();
              let timedOutBeforeFirstToken = false;
              let timedOutIdleStream = false;
              let firstContentSeen = false;
              let reasoningGraceUsed = false;

              const onOuterAbort = () => ttfbCtrl.abort(effectiveSignal?.reason);
              if (effectiveSignal) {
                if (effectiveSignal.aborted) {
                  ttfbCtrl.abort(effectiveSignal.reason);
                } else {
                  effectiveSignal.addEventListener("abort", onOuterAbort, { once: true });
                }
              }

              let ttfbTimer = setTimeout(() => {
                if (!firstContentSeen) {
                  timedOutBeforeFirstToken = true;
                  ttfbCtrl.abort();
                }
              }, ttfbLimitMs);

              let idleTimer: ReturnType<typeof setTimeout> | undefined;
              const resetIdleTimer = () => {
                if (!streamIdleLimitMs) return;
                if (idleTimer) clearTimeout(idleTimer);
                idleTimer = setTimeout(() => {
                  timedOutIdleStream = true;
                  ttfbCtrl.abort();
                }, streamIdleLimitMs);
              };

              try {
                const stream = await client.chat.completions.create(streamParams, {
                  signal: ttfbCtrl.signal
                });

                let fullText = "";
                let inputTokens: number | undefined;
                let outputTokens: number | undefined;
                let totalTokens: number | undefined;
                let truncated = false;

                for await (const chunk of stream) {
                  if (effectiveSignal?.aborted || ttfbCtrl.signal.aborted) {
                    break;
                  }
                  const choice = chunk.choices?.[0];
                  const deltaObj = choice?.delta as
                    | { content?: string | null; reasoning_content?: string | null }
                    | undefined;
                  const piece = deltaObj?.content ?? "";
                  const reasoningPiece = deltaObj?.reasoning_content ?? "";
                  if (piece || reasoningPiece) {
                    resetIdleTimer();
                  }
                  // Se o modelo só está emitindo reasoning_content oculto, dá folga dedicada
                  // (30s na NVIDIA 550B / 15s nos demais) para começar a emitir código real.
                  if (reasoningPiece && !firstContentSeen && !reasoningGraceUsed) {
                    reasoningGraceUsed = true;
                    clearTimeout(ttfbTimer);
                    ttfbTimer = setTimeout(() => {
                      if (!firstContentSeen) {
                        timedOutBeforeFirstToken = true;
                        ttfbCtrl.abort();
                      }
                    }, reasoningGraceMs);
                  }
                  if (piece) {
                    if (!firstContentSeen) {
                      firstContentSeen = true;
                      clearTimeout(ttfbTimer);
                    }
                    fullText += piece;
                    effectiveOnDelta(piece);
                  }
                  if (choice?.finish_reason === "length") {
                    truncated = true;
                  }
                  if (chunk.usage) {
                    inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
                    outputTokens = chunk.usage.completion_tokens ?? outputTokens;
                    totalTokens = chunk.usage.total_tokens ?? totalTokens;
                  }
                }

                if (timedOutBeforeFirstToken && !fullText) {
                  throw new Error(
                    `Timeout TTFB (${Math.round(ttfbLimitMs / 1000)}s sem primeiro token em ${model})`
                  );
                }
                if (timedOutIdleStream && !fullText) {
                  throw new Error(
                    `Timeout de inatividade (${Math.round(streamIdleLimitMs / 1000)}s sem tokens em ${model})`
                  );
                }

                return {
                  text: fullText,
                  inputTokens,
                  outputTokens,
                  totalTokens,
                  ...(truncated ? { truncated: true } : {})
                };
              } catch (streamErr) {
                if (timedOutBeforeFirstToken && !effectiveSignal?.aborted) {
                  throw new Error(
                    `Timeout TTFB (${Math.round(ttfbLimitMs / 1000)}s sem primeiro token em ${model})`
                  );
                }
                if (timedOutIdleStream && !effectiveSignal?.aborted) {
                  throw new Error(
                    `Timeout de inatividade (${Math.round(streamIdleLimitMs / 1000)}s sem tokens em ${model})`
                  );
                }
                throw streamErr;
              } finally {
                clearTimeout(ttfbTimer);
                if (idleTimer) clearTimeout(idleTimer);
                if (effectiveSignal) {
                  effectiveSignal.removeEventListener("abort", onOuterAbort);
                }
              }
            }

            const params =
              baseParams as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

            const response = await client.chat.completions.create(
              params,
              effectiveSignal ? { signal: effectiveSignal } : undefined
            );

            const truncated = response.choices[0]?.finish_reason === "length";
            return {
              text: response.choices[0]?.message?.content ?? "",
              inputTokens: response.usage?.prompt_tokens,
              outputTokens: response.usage?.completion_tokens,
              totalTokens: response.usage?.total_tokens,
              ...(truncated ? { truncated: true } : {})
            };
          };

          if (imageParts.length > 0) {
            try {
              return await executeCall(true);
            } catch (visionError) {
              if (effectiveSignal?.aborted) {
                throw visionError;
              }
              const msg =
                visionError instanceof Error
                  ? visionError.message
                  : String(visionError);
              const status =
                typeof visionError === "object" &&
                visionError !== null &&
                "status" in visionError
                  ? (visionError as { status?: number }).status
                  : undefined;

              // Se o modelo gratuito do OpenRouter não aceitar visão (400/404/422),
              // faz fallback automático para texto puro sem derrubar o debate.
              if (
                status === 400 ||
                status === 404 ||
                status === 422 ||
                /image|vision|multimodal|media|content/i.test(msg)
              ) {
                request.onReset?.();
                return executeCall(false);
              }
              throw visionError;
            }
          }

          return executeCall(false);
        }
      });
    }
  };
}
