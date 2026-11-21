import type { IncomingMessage, ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import { gzipSync } from "node:zlib";

export const MAX_BODY_SIZE = 262_144;
export const MAX_MEDIA_BODY_SIZE = 10 * 1024 * 1024; // 10 MB para imagens/PDFs/áudio

export const MOZ_EXTENSION_ORIGIN_REGEX =
  /^moz-extension:\/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "microphone=(self), camera=(), geolocation=(), payment=()"
};

export const HTML_CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "connect-src 'self'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join("; ");

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMozExtensionOrigin(
  origin: string | undefined
): origin is string {
  return Boolean(origin && MOZ_EXTENSION_ORIGIN_REGEX.test(origin));
}

export function isLoopbackSocket(request: IncomingMessage | undefined): boolean {
  const remote = (request?.socket?.remoteAddress ?? "").replace(/^::ffff:/, "");
  return remote === "127.0.0.1" || remote === "::1";
}

export function isHttpsBehindLocalProxy(
  request: IncomingMessage | undefined
): boolean {
  return (
    isLoopbackSocket(request) &&
    request?.headers["x-forwarded-proto"] === "https"
  );
}

export function getTransportSecurityHeaders(
  request: IncomingMessage | undefined
): Record<string, string> {
  if (isHttpsBehindLocalProxy(request)) {
    return {
      "Strict-Transport-Security": "max-age=31536000; includeSubDomains"
    };
  }
  return {};
}

export function getClientIp(request: IncomingMessage): string {
  const remote = (request.socket?.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
  const isTrustedLocalProxy = isLoopbackSocket(request);

  // Só confia em cabeçalhos de proxy (Tailscale Serve / Cloudflare Tunnel) quando o socket vem de loopback
  if (isTrustedLocalProxy) {
    const cfIp = request.headers["cf-connecting-ip"];
    if (typeof cfIp === "string" && cfIp.trim()) {
      return cfIp.trim().slice(0, 64);
    }

    const forwarded = request.headers["x-forwarded-for"];
    if (typeof forwarded === "string" && forwarded.trim()) {
      const first = forwarded.split(",")[0]?.trim();
      if (first) return first.slice(0, 64);
    }
  }

  return remote;
}

export function getLocalWifiAddresses(): string[] {
  const nets = networkInterfaces();
  const ips: string[] = [];
  for (const list of Object.values(nets)) {
    if (!list) continue;
    for (const net of list) {
      if (net.family === "IPv4" && !net.internal) {
        ips.push(net.address);
      }
    }
  }
  return ips;
}

export function sendJson(
  response: ServerResponse,
  status: number,
  data: unknown,
  origin?: string,
  extraHeaders?: Record<string, string>
): void {
  const rawBody = Buffer.from(JSON.stringify(data), "utf8");
  const acceptEncoding = response.req?.headers["accept-encoding"];
  const useGzip =
    rawBody.byteLength > 1024 &&
    typeof acceptEncoding === "string" &&
    acceptEncoding.includes("gzip");
  const payload = useGzip ? gzipSync(rawBody) : rawBody;

  response.writeHead(status, {
    ...SECURITY_HEADERS,
    ...getTransportSecurityHeaders(response.req),
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...(useGzip
      ? {
          "Content-Encoding": "gzip",
          "Vary": isMozExtensionOrigin(origin)
            ? "Origin, Accept-Encoding"
            : "Accept-Encoding"
        }
      : {}),
    ...(isMozExtensionOrigin(origin)
      ? {
          "Access-Control-Allow-Origin": origin,
          ...(!useGzip ? { "Vary": "Origin" } : {})
        }
      : {}),
    ...(extraHeaders ?? {})
  });

  response.end(payload);
}

export async function readRequestBody(
  request: IncomingMessage,
  maxBytes: number = MAX_BODY_SIZE
): Promise<string> {
  const chunks: Buffer[] = [];
  let totalSize = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalSize += buffer.length;

    if (totalSize > maxBytes) {
      throw new Error("PAYLOAD_TOO_LARGE");
    }

    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}
