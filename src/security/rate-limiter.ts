import type { IncomingMessage } from "node:http";

import { getClientIp } from "../server/http-utils.js";

export type RateLimitBucketName =
  | "ai_write"
  | "audio"
  | "privacy_heavy"
  | "api_general";

export interface RateLimitRule {
  maxRequests: number;
  windowMs: number;
  label: string;
}

export const DEFAULT_API_RATE_LIMITS: Record<RateLimitBucketName, RateLimitRule> = {
  ai_write: {
    maxRequests: 30,
    windowMs: 60_000,
    label: "envio para IAs"
  },
  audio: {
    maxRequests: 40,
    windowMs: 60_000,
    label: "áudio/voz"
  },
  privacy_heavy: {
    maxRequests: 12,
    windowMs: 60_000,
    label: "operações de privacidade/cofre"
  },
  api_general: {
    maxRequests: 240,
    windowMs: 60_000,
    label: "API geral"
  }
};

export interface RateLimitCheckResult {
  allowed: boolean;
  bucket: RateLimitBucketName;
  limit: number;
  remaining: number;
  retryAfterSec: number;
  label: string;
}

const MAX_TRACKED_KEYS = 1000;

/**
 * Classifica uma rota da API no bucket adequado de rate-limit.
 * Retorna `null` para rotas que já possuem limitador próprio (/auth/login, /privacy/vault/unlock)
 * ou rotas públicas leves (/health, /events/stream).
 */
export function classifyApiRateLimitBucket(
  method: string | undefined,
  pathname: string
): RateLimitBucketName | null {
  const m = (method ?? "GET").toUpperCase();

  if (
    pathname === "/health" ||
    pathname === "/auth/login" ||
    pathname === "/auth/logout" ||
    pathname === "/auth/status" ||
    pathname === "/privacy/vault/unlock" ||
    pathname === "/events/stream"
  ) {
    return null;
  }

  if (
    m === "POST" &&
    (pathname === "/debates" ||
      /^\/debates\/[0-9a-fA-F-]{8,64}\/(message|edit|regenerate|review|verdict)$/.test(
        pathname
      ))
  ) {
    return "ai_write";
  }

  if (pathname === "/audio/transcribe" || pathname === "/audio/speak") {
    return "audio";
  }

  if (
    pathname === "/privacy/export" ||
    pathname === "/privacy/wipe" ||
    pathname === "/privacy/ntfs-harden" ||
    pathname === "/privacy/vault/setup-master" ||
    pathname === "/privacy/vault/seal-keys"
  ) {
    return "privacy_heavy";
  }

  return "api_general";
}

/**
 * Rate-limiter de janela deslizante em memória por (IP + categoria de rota).
 * Possui limpeza automática para impedir crescimento ilimitado de memória.
 */
export function createApiRateLimiter(options?: {
  rules?: Partial<Record<RateLimitBucketName, Partial<RateLimitRule>>>;
  nowFn?: () => number;
}) {
  const nowFn = options?.nowFn ?? (() => Date.now());
  const rules: Record<RateLimitBucketName, RateLimitRule> = {
    ai_write: { ...DEFAULT_API_RATE_LIMITS.ai_write, ...(options?.rules?.ai_write ?? {}) },
    audio: { ...DEFAULT_API_RATE_LIMITS.audio, ...(options?.rules?.audio ?? {}) },
    privacy_heavy: {
      ...DEFAULT_API_RATE_LIMITS.privacy_heavy,
      ...(options?.rules?.privacy_heavy ?? {})
    },
    api_general: {
      ...DEFAULT_API_RATE_LIMITS.api_general,
      ...(options?.rules?.api_general ?? {})
    }
  };

  const buckets = new Map<string, number[]>();

  function pruneIfNeeded(now: number): void {
    if (buckets.size < MAX_TRACKED_KEYS) return;
    for (const [key, timestamps] of buckets.entries()) {
      const bucketName = key.split(":")[0] as RateLimitBucketName;
      const win = rules[bucketName]?.windowMs ?? 60_000;
      const fresh = timestamps.filter((ts) => now - ts < win);
      if (fresh.length === 0) {
        buckets.delete(key);
      } else {
        buckets.set(key, fresh);
      }
    }
    while (buckets.size >= MAX_TRACKED_KEYS) {
      const oldest = buckets.keys().next().value;
      if (oldest === undefined) break;
      buckets.delete(oldest);
    }
  }

  function consume(ip: string, bucket: RateLimitBucketName): RateLimitCheckResult {
    const rule = rules[bucket];
    const now = nowFn();
    pruneIfNeeded(now);

    const key = `${bucket}:${ip}`;
    const existing = buckets.get(key) ?? [];
    const fresh = existing.filter((ts) => now - ts < rule.windowMs);

    if (fresh.length >= rule.maxRequests) {
      buckets.set(key, fresh);
      const oldestTs = fresh[0] ?? now;
      const retryAfterMs = Math.max(1000, rule.windowMs - (now - oldestTs));
      return {
        allowed: false,
        bucket,
        limit: rule.maxRequests,
        remaining: 0,
        retryAfterSec: Math.max(1, Math.ceil(retryAfterMs / 1000)),
        label: rule.label
      };
    }

    fresh.push(now);
    buckets.set(key, fresh);
    return {
      allowed: true,
      bucket,
      limit: rule.maxRequests,
      remaining: Math.max(0, rule.maxRequests - fresh.length),
      retryAfterSec: 0,
      label: rule.label
    };
  }

  function checkRequest(
    request: IncomingMessage,
    pathname: string
  ): RateLimitCheckResult | null {
    const bucket = classifyApiRateLimitBucket(request.method, pathname);
    if (!bucket) return null;
    const ip = getClientIp(request);
    return consume(ip, bucket);
  }

  function resetAll(): void {
    buckets.clear();
  }

  return { consume, checkRequest, resetAll };
}
