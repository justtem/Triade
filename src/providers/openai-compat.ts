import OpenAI from "openai";

import type { AutoPlatform } from "../shared/debate-types.js";
import { runWithFallback } from "./policy.js";
import type { Provider } from "./types.js";
import type { UsageGate } from "./usage-gate.js";

export interface OpenAICompatOptions {
  id: AutoPlatform;
  name: string;
  apiKey: string;
  baseURL: string;
  models: readonly string[];
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
        maxHttpAttempts: options.maxHttpAttempts,
        gate: options.gate,
        request,
        headroom,
        call: async (model) => {
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

            if (request.onDelta) {
              const streamParams = {
                ...baseParams,
                stream: true as const,
                ...(options.id === "groq"
                  ? { stream_options: { include_usage: true } }
                  : {})
              } as unknown as OpenAI.Chat.ChatCompletionCreateParamsStreaming;

              const stream = await client.chat.completions.create(
                streamParams,
                request.signal ? { signal: request.signal } : undefined
              );

              let fullText = "";
              let inputTokens: number | undefined;
              let outputTokens: number | undefined;
              let totalTokens: number | undefined;

              for await (const chunk of stream) {
                if (request.signal?.aborted) {
                  break;
                }
                const piece = chunk.choices?.[0]?.delta?.content ?? "";
                if (piece) {
                  fullText += piece;
                  request.onDelta(piece);
                }
                if (chunk.usage) {
                  inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
                  outputTokens = chunk.usage.completion_tokens ?? outputTokens;
                  totalTokens = chunk.usage.total_tokens ?? totalTokens;
                }
              }

              return {
                text: fullText,
                inputTokens,
                outputTokens,
                totalTokens
              };
            }

            const params =
              baseParams as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

            const response = await client.chat.completions.create(
              params,
              request.signal ? { signal: request.signal } : undefined
            );

            return {
              text: response.choices[0]?.message?.content ?? "",
              inputTokens: response.usage?.prompt_tokens,
              outputTokens: response.usage?.completion_tokens,
              totalTokens: response.usage?.total_tokens
            };
          };

          if (imageParts.length > 0) {
            try {
              return await executeCall(true);
            } catch (visionError) {
              if (request.signal?.aborted) {
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
