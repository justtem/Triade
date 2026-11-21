import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { gzipSync } from "node:zlib";

import {
  getTransportSecurityHeaders,
  HTML_CONTENT_SECURITY_POLICY,
  SECURITY_HEADERS,
  sendJson
} from "./http-utils.js";

const STATIC_JS_MODULE_REGEX = /^\/js\/([a-z0-9_-]+)\.js$/;
const STATIC_ICON_REGEX = /^\/icons\/([a-z0-9_-]+\.(?:svg|png|ico))$/;
const STATIC_FONT_REGEX = /^\/fonts\/([a-z0-9_-]+\.(?:woff2|css))$/;
const STATIC_VENDOR_REGEX =
  /^\/vendor\/(?:katex\/(?:katex\.min\.(?:js|css)|fonts\/[A-Za-z0-9_-]+\.woff2)|mermaid\/mermaid\.min\.js)$/;

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2"
};

export function resolveDashboardFilename(pathname: string): string | null {
  const rootFiles: Record<string, string> = {
    "/": "index.html",
    "/index.html": "index.html",
    "/offline.html": "offline.html",
    "/styles.css": "styles.css",
    "/dashboard.js": "dashboard.js",
    "/manifest.json": "manifest.json",
    "/sw.js": "sw.js",
    "/favicon.ico": "icons/ai-council.ico"
  };

  if (rootFiles[pathname]) {
    return rootFiles[pathname];
  }

  const jsMatch = pathname.match(STATIC_JS_MODULE_REGEX);
  if (jsMatch?.[1]) {
    return `js/${jsMatch[1]}.js`;
  }

  const iconMatch = pathname.match(STATIC_ICON_REGEX);
  if (iconMatch?.[1]) {
    return `icons/${iconMatch[1]}`;
  }

  const fontMatch = pathname.match(STATIC_FONT_REGEX);
  if (fontMatch?.[1]) {
    return `fonts/${fontMatch[1]}`;
  }

  if (STATIC_VENDOR_REGEX.test(pathname)) {
    return pathname.slice(1);
  }

  return null;
}

export async function serveDashboardFile(
  publicDir: string,
  pathname: string,
  response: ServerResponse
): Promise<void> {
  const filename = resolveDashboardFilename(pathname);

  if (!filename) {
    sendJson(response, 404, { error: "Arquivo não encontrado." });
    return;
  }

  const filePath = resolve(publicDir, filename);

  if (!filePath.startsWith(publicDir + sep)) {
    sendJson(response, 403, { error: "Acesso negado." });
    return;
  }

  try {
    const content = await readFile(filePath);
    const ext = extname(filePath);
    const acceptEncoding = response.req?.headers["accept-encoding"];
    const compressible = ext !== ".png" && ext !== ".ico" && ext !== ".woff2";
    const useGzip =
      compressible &&
      content.byteLength > 1024 &&
      typeof acceptEncoding === "string" &&
      acceptEncoding.includes("gzip");
    const payload = useGzip ? gzipSync(content) : content;

    response.writeHead(200, {
      ...SECURITY_HEADERS,
      ...getTransportSecurityHeaders(response.req),
      ...(ext === ".html"
        ? { "Content-Security-Policy": HTML_CONTENT_SECURITY_POLICY }
        : {}),
      "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
      "Content-Length": String(payload.byteLength),
      "Cache-Control":
        ext === ".woff2" || pathname.startsWith("/vendor/")
          ? "public, max-age=31536000, immutable"
          : ext === ".png" || ext === ".ico" || ext === ".svg"
            ? "public, max-age=86400"
            : "no-store",
      ...(pathname === "/sw.js" ? { "Service-Worker-Allowed": "/" } : {}),
      ...(useGzip
        ? {
            "Content-Encoding": "gzip",
            "Vary": "Accept-Encoding"
          }
        : {})
    });

    response.end(payload);
  } catch {
    sendJson(response, 404, { error: "Arquivo não encontrado." });
  }
}
