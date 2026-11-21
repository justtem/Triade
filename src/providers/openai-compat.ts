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

/** Provedor para qualquer API compatível com o SDK da OpenAI (Groq, OpenRouter...). */
export function makeOpenAICompat(options: OpenAICompatOptions): Provider {
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL,
    // Sem retentativas escondidas do SDK: cada chamada HTTP passa pelo UsageGate.
    maxRetries: 0,
    timeout: 90_000,
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

            const baseParams = {
              model,
              messages: [
                { role: "system" as const, content: request.system },
                { role: "user" as const, content: userContent }
              ],
              [options.maxTokensParam]: request.maxTokens + headroom,
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

              // Proteção anti-travamento (TTFB): evita que um modelo gratuito congestionado segure o Trio por 90s
              const ttfbLimitMs = options.id === "openrouter" ? 28_000 : 18_000;
              const ttfbCtrl = new AbortController();
              let timedOutBeforeFirstToken = false;
              let firstTokenSeen = false;

              const onOuterAbort = () => ttfbCtrl.abort(effectiveSignal?.reason);
              if (effectiveSignal) {
                if (effectiveSignal.aborted) {
                  ttfbCtrl.abort(effectiveSignal.reason);
                } else {
                  effectiveSignal.addEventListener("abort", onOuterAbort, { once: true });
                }
              }

              const ttfbTimer = setTimeout(() => {
                if (!firstTokenSeen) {
                  timedOutBeforeFirstToken = true;
                  ttfbCtrl.abort();
                }
              }, ttfbLimitMs);

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
                  const piece = choice?.delta?.content ?? "";
                  if (piece) {
                    if (!firstTokenSeen) {
                      firstTokenSeen = true;
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
                throw streamErr;
              } finally {
                clearTimeout(ttfbTimer);
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
