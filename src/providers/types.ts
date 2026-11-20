import type { AutoPlatform } from "../shared/debate-types.js";

export interface ProviderMediaPart {
  name: string;
  kind: "image" | "pdf";
  mimeType: string;
  dataBase64: string;
}

export interface GenerateRequest {
  system: string;
  user: string;
  maxTokens: number;
  media?: ProviderMediaPart[];
  enableWebGrounding?: boolean;
  signal?: AbortSignal;
  onDelta?: (delta: string) => void;
  onReset?: () => void;
}

export interface GenerateResult {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  groundingSources?: Array<{ title: string; url: string }>;
}

export type ProviderErrorKind =
  | "rate_limit"
  | "quota_exhausted"
  | "auth"
  | "model"
  | "transient"
  | "empty"
  | "aborted"
  | "unknown";

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status?: number;
  readonly retryAfterMs?: number;

  constructor(
    kind: ProviderErrorKind,
    message: string,
    options: { status?: number; retryAfterMs?: number } = {}
  ) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export interface Provider {
  readonly id: AutoPlatform;
  readonly name: string;
  readonly models: readonly string[];
  generate(request: GenerateRequest): Promise<GenerateResult>;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function readHeader(headers: unknown, name: string): string | null {
  if (!headers) return null;

  const withGet = asRecord(headers);

  if (withGet && typeof withGet.get === "function") {
    const value = (withGet.get as (key: string) => unknown).call(headers, name);
    return typeof value === "string" ? value : null;
  }

  if (withGet) {
    const value = withGet[name] ?? withGet[name.toLowerCase()];
    return typeof value === "string" ? value : null;
  }

  return null;
}

function parseRetryAfterMs(error: unknown, message: string): number | undefined {
  const record = asRecord(error);
  const header = readHeader(record?.headers, "retry-after");

  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.ceil(seconds * 1000);
    }
  }

  // Gemini costuma informar "retryDelay": "34s" dentro da mensagem de erro.
  const match = message.match(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/i);
  if (match?.[1]) {
    return Math.ceil(Number(match[1]) * 1000);
  }

  return undefined;
}

/** Converte qualquer erro de SDK/rede em um ProviderError com categoria previsível. */
export function classifyError(error: unknown): ProviderError {
  if (error instanceof ProviderError) {
    return error;
  }

  const record = asRecord(error);
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "Erro desconhecido.";

  const rawStatus =
    record?.status ?? record?.statusCode ?? record?.code ?? undefined;
  const status = typeof rawStatus === "number" ? rawStatus : undefined;
  const errName = typeof record?.name === "string" ? record.name : "";
  const errCode = typeof record?.code === "string" ? record.code : "";
  const retryAfterMs = parseRetryAfterMs(error, message);

  if (errName === "APIUserAbortError") {
    return new ProviderError("aborted", "Geração interrompida pelo usuário.");
  }

  const looksDaily =
    /per.?day|daily|requests? per day|RPD|TPD|free-models-per-day/i.test(
      message
    );

  if (status === 402) {
    return new ProviderError(
      "quota_exhausted",
      "O provedor respondeu 402 (pagamento necessário). Use apenas modelos gratuitos e não adicione créditos.",
      { status }
    );
  }

  if (status === 429 || /RESOURCE_EXHAUSTED/i.test(message)) {
    return new ProviderError(
      looksDaily ? "quota_exhausted" : "rate_limit",
      message,
      { status: status ?? 429, retryAfterMs }
    );
  }

  if (status === 401 || status === 403) {
    return new ProviderError(
      "auth",
      `Chave recusada ou sem acesso a este modelo (HTTP ${status}). ${message}`,
      { status }
    );
  }

  if (status === 404 || (status === 400 && /model/i.test(message))) {
    return new ProviderError(
      "model",
      `Modelo indisponível ou nome inválido. ${message}`,
      { status }
    );
  }

  if (
    (status !== undefined && (status === 408 || status === 409 || status >= 500)) ||
    errName === "AbortError" ||
    errName === "APIConnectionError" ||
    errName === "APIConnectionTimeoutError" ||
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed|timeout|timed out/i.test(
      `${message} ${errCode}`
    )
  ) {
    return new ProviderError("transient", message, { status, retryAfterMs });
  }

  return new ProviderError("unknown", message, { status });
}
