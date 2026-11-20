import type { WebSearchMode, WebSource } from "../shared/debate-types.js";

const MAX_PASTED_URLS = 3;
const MAX_SEARCH_RESULTS = 5;
const MAX_DEEP_FETCH_SEARCH_PAGES = 2;
const MAX_HTML_BYTES = 400 * 1024; // 400 KB por página
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const GREETING_ONLY_REGEX =
  /^(oi+|ol[aá]+|opa+|e\s*a[ií]|fala+|salve|bom\s+dia|boa\s+tarde|boa\s+noite|tudo\s+bem\??|obrigad[oa]+|valeu+|vlw|ok+|blz|beleza|show|perfeito|entendi|sim|n[aã]o|t[aá]\s+bom|legal|massa|top|hello|hi|hey|thanks|thank\s+you)[\s!.,?]*$/i;

const EXPLICIT_SEARCH_REGEX =
  /\b(pesquis[ae]|busqu[ea]|procur[ae]|na\s+web|na\s+internet|online|atualizad[oa]|hoje|ontem|agora|lan[cç]ament|not[ií]cia|pre[cç]o|cota[cç][aã]o|vers[aã]o\s+atual|2025|2026|2027|quem\s+[eé]|o\s+que\s+[eé])\b/i;

/** Desembrulha URLs redirecionadoras comuns (Google Search mobile, Facebook, Instagram, Reddit). */
export function unwrapRedirectUrl(rawUrl: string): string {
  let current = rawUrl;
  for (let depth = 0; depth < 2; depth++) {
    let parsed: URL;
    try {
      parsed = new URL(current);
    } catch {
      return current;
    }
    const host = parsed.hostname.toLowerCase();
    let candidate: string | null = null;

    if (
      (host === "www.google.com" ||
        host === "google.com" ||
        host.endsWith(".google.com") ||
        host.endsWith(".google.com.br")) &&
      parsed.pathname === "/url"
    ) {
      candidate = parsed.searchParams.get("url") ?? parsed.searchParams.get("q");
    } else if (
      (host === "l.facebook.com" ||
        host === "lm.facebook.com" ||
        host === "l.instagram.com") &&
      parsed.searchParams.get("u")
    ) {
      candidate = parsed.searchParams.get("u");
    } else if (host === "out.reddit.com" && parsed.searchParams.get("url")) {
      candidate = parsed.searchParams.get("url");
    }

    if (candidate && /^https?:\/\//i.test(candidate)) {
      current = candidate;
    } else {
      break;
    }
  }
  return current;
}

/** Extrai até 3 URLs http(s) válidas e deduplicadas de um texto. */
export function extractUrlsFromText(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/gi) ?? [];
  const seen = new Set<string>();
  const out: string[] = [];

  for (const raw of matches) {
    // Remove pontuação final comum colada na URL (.,;:!?)
    const cleaned = raw.replace(/[.,;:!?)]+$/, "");
    const unwrapped = unwrapRedirectUrl(cleaned);
    if (!isSafePublicUrl(unwrapped)) continue;
    if (seen.has(unwrapped)) continue;
    seen.add(unwrapped);
    out.push(unwrapped);
    if (out.length >= MAX_PASTED_URLS) break;
  }

  return out;
}

/** Proteção anti-SSRF: permite apenas URLs http(s) públicas (bloqueia localhost, LAN e Tailscale). */
export function isSafePublicUrl(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }

  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host) return false;

  if (
    host === "localhost" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host === "::" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".ts.net")
  ) {
    return false;
  }

  // Bloqueia faixas IPv4 privadas, loopback, link-local e CGNAT (inclui Tailscale 100.64.0.0/10)
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const a = Number(ipv4Match[1]);
    const b = Number(ipv4Match[2]);
    const c = Number(ipv4Match[3]);
    const d = Number(ipv4Match[4]);
    if (a > 255 || b > 255 || c > 255 || d > 255) return false;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a >= 224) return false;
  }

  // Bloqueia IPv6 link-local / unique-local (fe80::, fc00::, fd00::)
  if (host.includes(":")) {
    if (/^(fe80|fc|fd|::1$|::ffff:127\.|::ffff:10\.|::ffff:192\.168\.)/i.test(host)) {
      return false;
    }
  }

  return true;
}

export function extractDomain(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./i, "");
  } catch {
    return rawUrl;
  }
}

/**
 * Decide se a pesquisa automática na web deve rodar.
 * Regra escolhida pelo usuário: pesquisar em praticamente TODA pergunta,
 * pulando apenas saudações curtas ou prompts com código/anexo grande (salvo pedido explícito).
 */
export function shouldAutoSearchWeb(
  prompt: string,
  options: { hasAttachments?: boolean; extractedUrls?: string[] } = {}
): boolean {
  const trimmed = prompt.trim();
  if (!trimmed) return false;

  // Se o usuário colou URL(s) e está apenas pedindo para ler/resumir/explicar o link,
  // ler a página diretamente já basta (sem poluir com busca genérica).
  const urls = options.extractedUrls ?? [];
  if (urls.length > 0) {
    // Remove tanto as URLs originais quanto as desembrulhadas antes de medir o texto restante
    const rawUrlMatches = trimmed.match(/https?:\/\/[^\s<>"{}|\\^`[\]]+/gi) ?? [];
    let textWithoutUrls = trimmed;
    for (const u of [...rawUrlMatches, ...urls]) {
      textWithoutUrls = textWithoutUrls.replace(u, "");
    }
    const remaining = textWithoutUrls.replace(/\s+/g, " ").trim();
    if (remaining.length < 45 && !/\b(pesquis[ae]|busqu[ea]|na\s+web|na\s+internet)\b/i.test(remaining)) {
      return false;
    }
  }

  // Se o usuário pediu explicitamente pesquisa web, sempre pesquisa
  if (EXPLICIT_SEARCH_REGEX.test(trimmed)) {
    return true;
  }

  // Saudações e confirmações curtas não precisam ir à internet
  if (GREETING_ONLY_REGEX.test(trimmed)) {
    return false;
  }

  // Se já tem anexo (print/PDF/código) ou bloco grande de código colado, foca no material enviado
  if (options.hasAttachments) {
    return false;
  }
  const hasBigCodeBlock =
    /```[\s\S]{120,}```/.test(trimmed) || trimmed.length > 900;
  if (hasBigCodeBlock) {
    return false;
  }

  // Requer ao menos 4 caracteres úteis
  return trimmed.length >= 4;
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_m, dec) => {
      const code = Number(dec);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    })
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex) => {
      const code = parseInt(hex, 16);
      return Number.isFinite(code) && code > 0 && code < 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    });
}

/** Converte HTML bruto em título + texto limpo (priorizando <article>/<main>). */
export function htmlToCleanText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch?.[1]
    ? decodeHtmlEntities(titleMatch[1]).replace(/\s+/g, " ").trim().slice(0, 160)
    : "";

  // Tenta focar no conteúdo principal se existir <article> ou <main> razoável
  const mainMatch =
    html.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i) ??
    html.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i);

  let body = mainMatch?.[1] && mainMatch[1].length > 350 ? mainMatch[1] : html;

  body = body
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|iframe|template|head|nav|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");

  const decoded = decodeHtmlEntities(body)
    .replace(/[ \t\r]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();

  return { title, text: decoded };
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return (await response.text()).slice(0, maxBytes);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = maxBytes - total;
      if (remaining <= 0) break;
      if (value.byteLength > remaining) {
        chunks.push(value.subarray(0, remaining));
        total += remaining;
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return Buffer.concat(chunks).toString("utf8");
}

/** Lê e extrai o texto principal de uma URL pública com timeout e limite de bytes. */
export async function fetchPageContent(
  url: string,
  timeoutMs = 5_000,
  maxExcerptChars = 3_200
): Promise<{ title: string; excerpt: string; ok: boolean }> {
  if (!isSafePublicUrl(url)) {
    return { title: extractDomain(url), excerpt: "", ok: false };
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,text/plain,application/json;q=0.8",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
      },
      signal: AbortSignal.timeout(timeoutMs)
    });

    if (!response.ok) {
      return { title: extractDomain(url), excerpt: "", ok: false };
    }

    // Revalida URL final após possíveis redirecionamentos (evita SSRF via redirect!)
    if (response.url && !isSafePublicUrl(response.url)) {
      return { title: extractDomain(url), excerpt: "", ok: false };
    }

    const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
    const isTextLike =
      contentType.includes("text/html") ||
      contentType.includes("text/plain") ||
      contentType.includes("application/json") ||
      contentType.includes("application/xml") ||
      contentType.includes("text/markdown") ||
      contentType === "";

    if (!isTextLike) {
      return { title: extractDomain(url), excerpt: "", ok: false };
    }

    const raw = await readLimitedText(response, MAX_HTML_BYTES);

    if (contentType.includes("text/html") || raw.trimStart().startsWith("<")) {
      const { title, text } = htmlToCleanText(raw);
      return {
        title: title || extractDomain(url),
        excerpt: text.slice(0, maxExcerptChars),
        ok: text.length > 40
      };
    }

    const clean = raw.replace(/\s+/g, " ").trim();
    return {
      title: extractDomain(url),
      excerpt: clean.slice(0, maxExcerptChars),
      ok: clean.length > 10
    };
  } catch {
    return { title: extractDomain(url), excerpt: "", ok: false };
  }
}

interface RawSearchHit {
  title: string;
  url: string;
  snippet: string;
}

function unwrapDuckDuckGoHref(rawHref: string): string {
  const decoded = decodeHtmlEntities(rawHref).trim();
  if (!decoded) return "";
  try {
    const asUrl = decoded.startsWith("//")
      ? new URL(`https:${decoded}`)
      : decoded.startsWith("/")
        ? new URL(`https://duckduckgo.com${decoded}`)
        : new URL(decoded);
    // Ignora anúncios patrocinados (/y.js) e links internos do próprio DuckDuckGo
    if (asUrl.hostname.endsWith("duckduckgo.com") && asUrl.pathname.startsWith("/y.js")) {
      return "";
    }
    const uddg = asUrl.searchParams.get("uddg");
    if (uddg) {
      if (!isSafePublicUrl(uddg)) return "";
      const targetHost = extractDomain(uddg).toLowerCase();
      if (targetHost === "duckduckgo.com") return "";
      return uddg;
    }
    if (asUrl.hostname.endsWith("duckduckgo.com")) return "";
    return isSafePublicUrl(asUrl.href) ? asUrl.href : "";
  } catch {
    return "";
  }
}

/** Busca web gratuita via DuckDuckGo HTML (sem API key). */
async function searchDuckDuckGoHtml(
  query: string,
  limit = MAX_SEARCH_RESULTS
): Promise<RawSearchHit[]> {
  const params = new URLSearchParams({ q: query, kl: "br-pt" });
  const response = await fetch(`https://html.duckduckgo.com/html/?${params.toString()}`, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html,application/xhtml+xml",
      "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
    },
    signal: AbortSignal.timeout(4_500)
  });

  if (!response.ok) return [];
  const html = await readLimitedText(response, MAX_HTML_BYTES);

  const hits: RawSearchHit[] = [];
  const seen = new Set<string>();

  // Extrai links de resultado (<a class="result__a" href="...">Title</a>) e snippets próximos
  const blockRegex = /<div[^>]*class="[^"]*result__body[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
  let match: RegExpExecArray | null;

  while ((match = blockRegex.exec(html)) !== null) {
    const block = match[1] ?? "";
    const linkMatch = block.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch?.[1]) continue;

    const url = unwrapDuckDuckGoHref(linkMatch[1]);
    if (!url || seen.has(url)) continue;

    const title = decodeHtmlEntities((linkMatch[2] ?? "").replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    const snippetMatch = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|span)>/i);
    const snippet = decodeHtmlEntities((snippetMatch?.[1] ?? "").replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();

    if (!title) continue;
    seen.add(url);
    hits.push({ title: title.slice(0, 140), url, snippet: snippet.slice(0, 320) });
    if (hits.length >= limit) break;
  }

  // Fallback de regex mais permissivo caso a marcação do DDG mude levemente
  if (hits.length === 0) {
    const anchorRegex = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = anchorRegex.exec(html)) !== null) {
      const url = unwrapDuckDuckGoHref(match[1] ?? "");
      if (!url || seen.has(url)) continue;
      const title = decodeHtmlEntities((match[2] ?? "").replace(/<[^>]+>/g, ""))
        .replace(/\s+/g, " ")
        .trim();
      if (!title) continue;
      seen.add(url);
      hits.push({ title: title.slice(0, 140), url, snippet: "" });
      if (hits.length >= limit) break;
    }
  }

  return hits;
}

/** Fallback gratuito via DuckDuckGo Lite. */
async function searchDuckDuckGoLite(
  query: string,
  limit = MAX_SEARCH_RESULTS
): Promise<RawSearchHit[]> {
  const params = new URLSearchParams({ q: query, kl: "br-pt" });
  const response = await fetch(`https://lite.duckduckgo.com/lite/?${params.toString()}`, {
    method: "GET",
    headers: {
      "User-Agent": USER_AGENT,
      "Accept": "text/html",
      "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
    },
    signal: AbortSignal.timeout(4_000)
  });

  if (!response.ok) return [];
  const html = await readLimitedText(response, MAX_HTML_BYTES);

  const hits: RawSearchHit[] = [];
  const seen = new Set<string>();
  const linkRegex = /<a[^>]*class=['"]result-link['"][^>]*href=['"]([^'"]+)['"][^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRegex = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;

  const snippets: string[] = [];
  let sMatch: RegExpExecArray | null;
  while ((sMatch = snippetRegex.exec(html)) !== null) {
    snippets.push(
      decodeHtmlEntities((sMatch[1] ?? "").replace(/<[^>]+>/g, ""))
        .replace(/\s+/g, " ")
        .trim()
    );
  }

  let lMatch: RegExpExecArray | null;
  let idx = 0;
  while ((lMatch = linkRegex.exec(html)) !== null) {
    const url = unwrapDuckDuckGoHref(lMatch[1] ?? "");
    const snippet = snippets[idx] ?? "";
    idx++;
    if (!url || seen.has(url)) continue;
    const title = decodeHtmlEntities((lMatch[2] ?? "").replace(/<[^>]+>/g, ""))
      .replace(/\s+/g, " ")
      .trim();
    if (!title) continue;
    seen.add(url);
    hits.push({ title: title.slice(0, 140), url, snippet: snippet.slice(0, 320) });
    if (hits.length >= limit) break;
  }

  return hits;
}

/** Fallback gratuito via Wikipedia API (PT-BR) quando motores HTML bloquearem. */
async function searchWikipediaFallback(
  query: string,
  limit = 3
): Promise<RawSearchHit[]> {
  try {
    const params = new URLSearchParams({
      action: "query",
      list: "search",
      srsearch: query.slice(0, 140),
      srlimit: String(limit),
      format: "json",
      utf8: "1"
    });
    const response = await fetch(`https://pt.wikipedia.org/w/api.php?${params.toString()}`, {
      headers: { "User-Agent": "AI-Council-Local/1.0" },
      signal: AbortSignal.timeout(3_500)
    });
    if (!response.ok) return [];
    const data = (await response.json()) as {
      query?: { search?: Array<{ title?: string; snippet?: string }> };
    };
    const items = data?.query?.search ?? [];
    return items
      .filter((item) => typeof item.title === "string" && item.title.length > 0)
      .map((item) => {
        const title = item.title!;
        const slug = encodeURIComponent(title.replace(/ /g, "_"));
        const snippet = decodeHtmlEntities((item.snippet ?? "").replace(/<[^>]+>/g, ""))
          .replace(/\s+/g, " ")
          .trim();
        return {
          title: `${title} — Wikipédia`,
          url: `https://pt.wikipedia.org/wiki/${slug}`,
          snippet: snippet.slice(0, 300)
        };
      });
  } catch {
    return [];
  }
}

async function performWebSearch(query: string): Promise<RawSearchHit[]> {
  const cleanQuery = query.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!cleanQuery) return [];

  try {
    const ddgHtml = await searchDuckDuckGoHtml(cleanQuery, MAX_SEARCH_RESULTS);
    if (ddgHtml.length > 0) return ddgHtml;
  } catch {
    // Tenta fallback
  }

  try {
    const ddgLite = await searchDuckDuckGoLite(cleanQuery, MAX_SEARCH_RESULTS);
    if (ddgLite.length > 0) return ddgLite;
  } catch {
    // Tenta fallback
  }

  return searchWikipediaFallback(cleanQuery, 3);
}

/**
 * Coleta fontes web em tempo real:
 * 1) Lê até 3 links colados diretamente na mensagem.
 * 2) Executa busca web gratuita (top 5 snippets + leitura profunda das 2 principais páginas).
 */
export async function gatherWebContext(
  prompt: string,
  options: { mode?: WebSearchMode; hasAttachments?: boolean } = {}
): Promise<WebSource[]> {
  const mode = options.mode ?? "auto";
  if (mode === "off") return [];

  const pastedUrls = extractUrlsFromText(prompt);
  const runSearch = shouldAutoSearchWeb(prompt, {
    hasAttachments: options.hasAttachments,
    extractedUrls: pastedUrls
  });

  if (pastedUrls.length === 0 && !runSearch) {
    return [];
  }

  // Remove URLs da query de busca para não poluir os resultados
  let searchQuery = prompt;
  for (const u of pastedUrls) {
    searchQuery = searchQuery.replace(u, " ");
  }
  searchQuery = searchQuery.replace(/\s+/g, " ").trim();

  const [urlPages, searchHits] = await Promise.all([
    Promise.all(
      pastedUrls.map(async (url) => {
        const page = await fetchPageContent(url, 5_500, 3_500);
        return {
          url,
          title: page.title || extractDomain(url),
          domain: extractDomain(url),
          snippet: page.excerpt
            ? page.excerpt.slice(0, 240)
            : "Link fornecido pelo usuário (conteúdo indisponível para leitura direta).",
          excerpt: page.excerpt || undefined,
          origin: "url" as const,
          fetchedOk: page.ok
        };
      })
    ),
    runSearch && searchQuery.length >= 4
      ? performWebSearch(searchQuery)
      : Promise.resolve([] as RawSearchHit[])
  ]);

  const seenUrls = new Set<string>(urlPages.map((p) => p.url));
  const uniqueHits = searchHits.filter((h) => !seenUrls.has(h.url));

  // Leitura profunda das 2 páginas principais retornadas na busca (em paralelo, timeout curto)
  const deepTargets = uniqueHits.slice(0, MAX_DEEP_FETCH_SEARCH_PAGES);
  const deepPages = await Promise.all(
    deepTargets.map((hit) => fetchPageContent(hit.url, 3_600, 2_000))
  );

  const searchSources = uniqueHits.map((hit, idx) => {
    const deep = idx < deepPages.length ? deepPages[idx] : undefined;
    return {
      url: hit.url,
      title: hit.title || deep?.title || extractDomain(hit.url),
      domain: extractDomain(hit.url),
      snippet: hit.snippet || (deep?.excerpt ? deep.excerpt.slice(0, 240) : ""),
      excerpt: deep?.ok && deep.excerpt ? deep.excerpt : undefined,
      origin: "search" as const,
      fetchedOk: deep ? deep.ok : undefined
    };
  });

  const combined = [...urlPages, ...searchSources];
  return combined.map((item, idx) => ({
    index: idx + 1,
    ...item
  }));
}

/**
 * Formata o bloco de contexto web respeitando o limite de caracteres de cada provedor
 * (Gemini ~6.500 chars, OpenRouter ~6.000 chars, Groq gratuito ~2.200 chars).
 */
export function buildWebContextBlock(
  sources: WebSource[] | undefined,
  maxChars: number
): string {
  if (!sources || sources.length === 0 || maxChars <= 0) return "";

  const today = new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric"
  }).format(new Date());

  const header = [
    `[FONTES WEB CONSULTADAS EM TEMPO REAL — ${today}]`,
    "Use estas informações atualizadas como base prioritária quando relevantes e cite as fontes no formato [1], [2], etc. Nunca invente links que não estejam listados abaixo."
  ].join("\n");

  const parts: string[] = [header];
  let used = header.length;

  for (const src of sources) {
    const remaining = maxChars - used;
    if (remaining < 140) break;

    const tag =
      src.origin === "url"
        ? "LINK ENVIADO"
        : src.origin === "grounding"
          ? "GOOGLE"
          : "WEB";

    const baseLine = `\n[${src.index}] (${tag}) ${src.title} — ${src.url}`;
    const rawDetail = src.excerpt && src.excerpt.length > src.snippet.length
      ? src.excerpt
      : src.snippet;

    // Reserva orçamento equilibrado por fonte (links enviados pelo usuário recebem mais espaço)
    const perSourceCap =
      src.origin === "url"
        ? Math.min(remaining - baseLine.length - 16, Math.floor(maxChars * 0.55))
        : Math.min(remaining - baseLine.length - 16, Math.floor(maxChars * 0.32));

    const detail =
      rawDetail && perSourceCap > 60
        ? rawDetail.length > perSourceCap
          ? `${rawDetail.slice(0, perSourceCap - 3).trimEnd()}...`
          : rawDetail
        : "";

    const entry = detail ? `${baseLine}\nConteúdo: ${detail}` : baseLine;
    if (used + entry.length > maxChars && parts.length > 1) {
      break;
    }

    parts.push(entry);
    used += entry.length;
  }

  return parts.join("\n");
}
