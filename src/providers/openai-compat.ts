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
          const params = {
            model,
            messages: [
              { role: "system", content: request.system },
              { role: "user", content: request.user }
            ],
            [options.maxTokensParam]: request.maxTokens + headroom,
            ...(options.extraBody ? options.extraBody(model) : {})
          } as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

          const response = await client.chat.completions.create(params);

          return {
            text: response.choices[0]?.message?.content ?? "",
            inputTokens: response.usage?.prompt_tokens,
            outputTokens: response.usage?.completion_tokens,
            totalTokens: response.usage?.total_tokens
          };
        }
      });
    }
  };
}
