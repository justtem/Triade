import {
  PLATFORMS,
  STATUS_LABELS,
  RESPONSE_MODE_LABELS,
  INTERACTION_MODE_LABELS,
  SVG_ICONS,
  debateDetailsById,
  getSessionTurns,
  getResponsesForTurn,
  formatDate
} from "./state.js";
import { loadDebateDetail } from "./api.js";
import {
  createMermaidBlockElement,
  hydrateRichBlocks,
  looksLikeRealInlineMath
} from "./rich-render.js";

export function escapeHtml(raw) {
  return String(raw || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Valida URLs de links gerados em Markdown (permite estritamente http: e https:,
 * bloqueando javascript:, data:, vbscript:, file: e caracteres de controle).
 */
export function safeMarkdownLinkUrl(rawEscapedOrPlainUrl) {
  const decoded = String(rawEscapedOrPlainUrl || "")
    .replace(/&amp;/g, "&")
    .trim();
  if (!decoded || /[\u0000-\u001F\u007F\s]/.test(decoded)) {
    return null;
  }
  if (decoded.startsWith("//")) {
    return null;
  }
  try {
    const parsed = new URL(decoded);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return null;
    }
    return parsed.href;
  } catch {
    return null;
  }
}

export function formatInlineMarkdown(escapedLine, options = {}) {
  const isStreaming = Boolean(options.isStreaming);
  const codeSlots = [];
  // 1. Protege inline code (`...`) primeiro para evitar mutação por negrito/itálico/links/fórmulas
  let out = String(escapedLine || "").replace(/`([^`]+)`/g, (_m, codeBody) => {
    const idx = codeSlots.length;
    codeSlots.push(`<code>${codeBody}</code>`);
    return `\u0000CODE_${idx}\u0000`;
  });

  // 1b. Fórmulas inline KaTeX: \(...\) e $...$ (com proteção inteligente contra valores monetários R$ 50 / $100)
  const mathSlots = [];
  if (!isStreaming) {
    const decodeEntitiesForLatex = (txt) =>
      String(txt || "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'");

    const pushInlineMath = (escapedInner) => {
      const latex = decodeEntitiesForLatex(escapedInner).trim();
      if (!latex) return null;
      const idx = mathSlots.length;
      const safeAttr = escapeHtml(latex);
      mathSlots.push(
        `<span class="math-inline" data-katex-latex="${safeAttr}" data-katex-display="false" title="Clique para copiar o LaTeX"><span class="math-katex-output"><code>${escapedInner}</code></span></span>`
      );
      return `\u0000MATH_${idx}\u0000`;
    };

    // Delimitador explícito \( ... \)
    out = out.replace(/\\\(([^)\n]{1,260}?)\\\)/g, (full, inner) => {
      return pushInlineMath(inner) || full;
    });

    // Delimitador $...$ com proteção contra R$ 50, US$ 100 e números monetários comuns
    out = out.replace(
      /(^|[^\\$])\$([^$\n]{1,260}?)\$(?!\$)/g,
      (full, beforeChar, inner, offset, fullStr) => {
        const prefixSlice = fullStr.slice(Math.max(0, offset - 4), offset + beforeChar.length);
        const plainInner = decodeEntitiesForLatex(inner);
        if (!looksLikeRealInlineMath(plainInner, prefixSlice)) {
          return full;
        }
        const token = pushInlineMath(inner);
        return token ? `${beforeChar}${token}` : full;
      }
    );
  }

  // 2. Neutraliza imagens Markdown externas (![alt](url)) para impedir exfiltração silenciosa via Prompt Injection
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, altText) => {
    const label = altText && altText.trim() ? altText.trim() : "imagem";
    return `<span class="md-blocked-img" title="Imagem externa bloqueada por segurança (anti-exfiltração)">[Imagem externa bloqueada: ${label}]</span>`;
  });

  // 3. Links Markdown [texto](url) — permite estritamente http(s) com noopener noreferrer
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, linkText, rawUrl) => {
    const safeHref = safeMarkdownLinkUrl(rawUrl);
    if (!safeHref) {
      return `<span class="md-blocked-link" title="Link bloqueado por protocolo inseguro">${linkText}</span>`;
    }
    return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer" class="md-ext-link">${linkText}</a>`;
  });

  // 4. Formatação básica
  out = out
    .replace(/&lt;br\s*\/?&gt;/gi, "<br>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");

  // 5. Restaura fórmulas e spans de inline code intactos
  out = out.replace(/\u0000MATH_(\d+)\u0000/g, (_m, idx) => mathSlots[Number(idx)] || "");
  return out.replace(/\u0000CODE_(\d+)\u0000/g, (_m, idx) => codeSlots[Number(idx)] || "");
}

// ============================================================================
// SYNTAX HIGHLIGHTER NATIVO (ZERO DEPENDÊNCIAS // PALETA NEON BLUEPRINT)
// ============================================================================

export function highlightHtmlTag(tagText) {
  return tagText.replace(
    /^(<\/?)([\w:-]+)|([\w:-]+)(\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)|(\/?>)/g,
    (m, open, tagName, attrName, eq, attrVal, close) => {
      if (open && tagName) {
        return `<span class="tok-punct">${escapeHtml(open)}</span><span class="tok-keyword">${escapeHtml(tagName)}</span>`;
      }
      if (attrName) {
        return `<span class="tok-type">${escapeHtml(attrName)}</span><span class="tok-punct">${escapeHtml(eq)}</span><span class="tok-string">${escapeHtml(attrVal)}</span>`;
      }
      if (close) {
        return `<span class="tok-punct">${escapeHtml(close)}</span>`;
      }
      return escapeHtml(m);
    }
  );
}

export function highlightCodeHtml(rawCode, rawLang) {
  const code = String(rawCode || "");
  const lang = String(rawLang || "").toLowerCase().trim();

  if (!code) return "";

  // HTML / XML / SVG
  if (["html", "htm", "xml", "svg"].includes(lang)) {
    const htmlRegex = /(<!--[\s\S]*?-->)|(<!DOCTYPE[^>]*>)|(<\/?[\w:-]+(?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*\s*\/?>)/gi;
    let out = "";
    let last = 0;
    let m;
    while ((m = htmlRegex.exec(code)) !== null) {
      if (m.index > last) out += escapeHtml(code.slice(last, m.index));
      if (m[1]) out += `<span class="tok-comment">${escapeHtml(m[1])}</span>`;
      else if (m[2]) out += `<span class="tok-keyword">${escapeHtml(m[2])}</span>`;
      else if (m[3]) out += highlightHtmlTag(m[3]);
      last = htmlRegex.lastIndex;
    }
    if (last < code.length) out += escapeHtml(code.slice(last));
    return out;
  }

  // CSS / SCSS
  if (["css", "scss", "less"].includes(lang)) {
    const cssRegex = /(\/\*[\s\S]*?\*\/)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|(@[a-zA-Z-]+)|(--[a-zA-Z0-9-]+)|(#[0-9a-fA-F]{3,8}\b|\b\d+(?:\.\d+)?(?:px|rem|em|vh|vw|dvh|%|s|ms|deg|fr)?\b)|([a-zA-Z-]+)(?=\s*:)/g;
    let out = "";
    let last = 0;
    let m;
    while ((m = cssRegex.exec(code)) !== null) {
      if (m.index > last) out += escapeHtml(code.slice(last, m.index));
      if (m[1]) out += `<span class="tok-comment">${escapeHtml(m[1])}</span>`;
      else if (m[2]) out += `<span class="tok-string">${escapeHtml(m[2])}</span>`;
      else if (m[3]) out += `<span class="tok-keyword">${escapeHtml(m[3])}</span>`;
      else if (m[4]) out += `<span class="tok-fn">${escapeHtml(m[4])}</span>`;
      else if (m[5]) out += `<span class="tok-number">${escapeHtml(m[5])}</span>`;
      else if (m[6]) out += `<span class="tok-type">${escapeHtml(m[6])}</span>`;
      last = cssRegex.lastIndex;
    }
    if (last < code.length) out += escapeHtml(code.slice(last));
    return out;
  }

  // JSON
  if (lang === "json") {
    const jsonRegex = /("(?:\\.|[^"\\])*")(\s*:)|("(?:\\.|[^"\\])*")|\b(true|false|null)\b|(-?\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)/g;
    let out = "";
    let last = 0;
    let m;
    while ((m = jsonRegex.exec(code)) !== null) {
      if (m.index > last) out += escapeHtml(code.slice(last, m.index));
      if (m[1]) out += `<span class="tok-type">${escapeHtml(m[1])}</span>${escapeHtml(m[2])}`;
      else if (m[3]) out += `<span class="tok-string">${escapeHtml(m[3])}</span>`;
      else if (m[4]) out += `<span class="tok-keyword">${escapeHtml(m[4])}</span>`;
      else if (m[5]) out += `<span class="tok-number">${escapeHtml(m[5])}</span>`;
      last = jsonRegex.lastIndex;
    }
    if (last < code.length) out += escapeHtml(code.slice(last));
    return out;
  }

  // SQL
  if (lang === "sql") {
    const sqlRegex = /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:''|[^'])*')|\b(SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|ALTER|DROP|INDEX|JOIN|LEFT|RIGHT|INNER|OUTER|ON|AS|AND|OR|NOT|NULL|IS|IN|LIKE|ORDER|BY|GROUP|HAVING|LIMIT|OFFSET|PRIMARY|KEY|FOREIGN|REFERENCES|DEFAULT|UNIQUE|DISTINCT|COUNT|SUM|AVG|MIN|MAX|CASE|WHEN|THEN|ELSE|END|BEGIN|COMMIT|ROLLBACK|TRANSACTION|UNION|ALL|EXISTS|DESC|ASC|VARCHAR|INT|INTEGER|BOOLEAN|TEXT|TIMESTAMP)\b|(\b\d+(?:\.\d+)?\b)/gi;
    let out = "";
    let last = 0;
    let m;
    while ((m = sqlRegex.exec(code)) !== null) {
      if (m.index > last) out += escapeHtml(code.slice(last, m.index));
      if (m[1]) out += `<span class="tok-comment">${escapeHtml(m[1])}</span>`;
      else if (m[2]) out += `<span class="tok-string">${escapeHtml(m[2])}</span>`;
      else if (m[3]) out += `<span class="tok-keyword">${escapeHtml(m[3])}</span>`;
      else if (m[4]) out += `<span class="tok-number">${escapeHtml(m[4])}</span>`;
      last = sqlRegex.lastIndex;
    }
    if (last < code.length) out += escapeHtml(code.slice(last));
    return out;
  }

  // Linguagens gerais (JS, TS, Java, Python, Go, C/C++, Rust, Bash, PowerShell, PHP, Ruby, YAML)
  const usesHashComment = [
    "py", "python", "sh", "bash", "zsh", "shell", "ps1", "powershell",
    "yml", "yaml", "rb", "ruby", "php", "perl", "r", "toml", "dockerfile", "env"
  ].includes(lang);

  const generalRegex = usesHashComment
    ? /(#[^\n]*|\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(@[A-Za-z_]\w*)|(\b(?:const|let|var|function|return|if|else|elif|for|while|do|switch|case|break|continue|default|try|catch|except|finally|throw|raise|new|class|extends|implements|interface|type|enum|import|export|from|as|async|await|yield|of|in|typeof|instanceof|void|delete|this|self|super|static|public|private|protected|readonly|abstract|final|package|def|lambda|pass|with|global|nonlocal|and|or|not|is|struct|fn|impl|pub|mod|use|match|mut|trait|func|go|defer|chan|select|range|echo|then|fi|done|esac|local|exit|set)\b)|(\b(?:true|false|null|undefined|NaN|Infinity|None|True|False|nil)\b)|(\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fFlLuU]?\b)|(\b[A-Z][A-Za-z0-9_]*\b)|(\b[a-zA-Z_]\w*)(?=\s*\()/g
    : /(\/\*[\s\S]*?\*\/|\/\/[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(@[A-Za-z_]\w*)|(\b(?:const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|default|try|catch|finally|throw|throws|new|class|extends|implements|interface|type|enum|import|export|from|as|async|await|yield|of|in|typeof|instanceof|void|delete|this|super|static|public|private|protected|readonly|abstract|final|package|struct|fn|impl|pub|mod|use|match|mut|trait|func|go|defer|chan|select|range|int|long|float|double|boolean|char|byte|short|string|bool|auto|sizeof|namespace|using|override|record|sealed)\b)|(\b(?:true|false|null|undefined|NaN|Infinity|nil)\b)|(\b0x[0-9a-fA-F]+\b|\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[fFlLuU]?\b)|(\b[A-Z][A-Za-z0-9_]*\b)|(\b[a-zA-Z_]\w*)(?=\s*\()/g;

  let out = "";
  let last = 0;
  let m;
  while ((m = generalRegex.exec(code)) !== null) {
    if (m.index > last) out += escapeHtml(code.slice(last, m.index));
    if (m[1]) out += `<span class="tok-comment">${escapeHtml(m[1])}</span>`;
    else if (m[2]) out += `<span class="tok-string">${escapeHtml(m[2])}</span>`;
    else if (m[3]) out += `<span class="tok-fn">${escapeHtml(m[3])}</span>`;
    else if (m[4]) out += `<span class="tok-keyword">${escapeHtml(m[4])}</span>`;
    else if (m[5]) out += `<span class="tok-number">${escapeHtml(m[5])}</span>`;
    else if (m[6]) out += `<span class="tok-number">${escapeHtml(m[6])}</span>`;
    else if (m[7]) out += `<span class="tok-type">${escapeHtml(m[7])}</span>`;
    else if (m[8]) out += `<span class="tok-fn">${escapeHtml(m[8])}</span>`;
    last = generalRegex.lastIndex;
  }
  if (last < code.length) out += escapeHtml(code.slice(last));
  return out;
}

function createMathBlockElement(latexRaw, isStreaming) {
  const latex = String(latexRaw || "").trim();
  const wrap = document.createElement("div");
  wrap.className = "math-block-wrap";

  if (isStreaming) {
    const badge = document.createElement("span");
    badge.className = "mermaid-streaming-badge";
    badge.textContent = "Gerando fórmula...";
    const code = document.createElement("code");
    code.className = "math-block-fallback";
    code.textContent = latex;
    wrap.append(badge, code);
    return wrap;
  }

  wrap.setAttribute("data-katex-latex", latex);
  wrap.setAttribute("data-katex-display", "true");

  const output = document.createElement("div");
  output.className = "math-katex-output";
  const fallback = document.createElement("code");
  fallback.className = "math-block-fallback";
  fallback.textContent = latex;
  output.appendChild(fallback);

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "btn-copy-code math-copy-btn";
  copyBtn.title = "Copiar código LaTeX";
  copyBtn.textContent = "LaTeX";
  copyBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(latex);
      copyBtn.textContent = "Copiado";
      setTimeout(() => {
        copyBtn.textContent = "LaTeX";
      }, 1500);
    } catch {
      copyBtn.textContent = "Erro";
    }
  });

  wrap.append(output, copyBtn);
  return wrap;
}

function parseCodeFenceHeader(rawHeader, rawBody) {
  const header = String(rawHeader || "").trim();
  let body = String(rawBody || "").replace(/\n$/, "");

  if (!header) {
    return { lang: "code", label: "código", body };
  }

  const firstSpace = header.search(/\s/);
  if (firstSpace < 0) {
    // Ex.: "ts", "html", "ts:src/server.ts"
    const colonIdx = header.indexOf(":");
    if (colonIdx > 0) {
      const langPart = header.slice(0, colonIdx).trim();
      const filePart = header.slice(colonIdx + 1).trim();
      return {
        lang: langPart || "code",
        label: filePart ? `${langPart} · ${filePart}` : langPart,
        body
      };
    }
    return { lang: header, label: header, body };
  }

  const firstToken = header.slice(0, firstSpace).trim();
  const rest = header.slice(firstSpace).trim();

  // Caso a IA coloque código na mesma linha da abertura (ex.: ```html <!DOCTYPE html>...)
  const looksLikeInlineCodeStart =
    /^(?:<[!a-zA-Z/?]|[{[(]|import\b|export\b|const\b|let\b|var\b|function\b|class\b|\/[/*]|#include|SELECT\b|body\b|:root\b|@media\b)/i.test(
      rest
    );

  if (looksLikeInlineCodeStart) {
    body = body ? `${rest}\n${body}` : rest;
    return { lang: firstToken || "code", label: firstToken || "código", body };
  }

  // Caso a IA coloque o caminho do arquivo na abertura (ex.: ```html public/index.html)
  const cleanTitle = rest.replace(/^title=["']?|["']?$/g, "").trim();
  return {
    lang: firstToken || "code",
    label: cleanTitle ? `${firstToken} · ${cleanTitle}` : firstToken || "código",
    body
  };
}

export function buildMarkdownDom(markdownText, options = {}) {
  const isStreaming = Boolean(options.isStreaming);
  const container = document.createElement("div");
  container.className = "markdown-content";

  const raw = String(markdownText || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return container;

  // 1. Divide blocos cercados (```lang [opcional] ... ```), blocos de matemática ($$...$$ e \[...\])
  //    e também blocos abertos (durante streaming ou truncados sem ``` final) para NUNCA virar texto branco.
  const segments = [];
  const blockRegex =
    /```([^\n`]*)(?:\n([\s\S]*?))?```|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g;
  let lastIndex = 0;
  let match;

  while ((match = blockRegex.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: "prose",
        content: raw.slice(lastIndex, match.index)
      });
    }
    if (match[1] !== undefined) {
      const parsed = parseCodeFenceHeader(match[1], match[2] ?? "");
      const langNorm = parsed.lang.toLowerCase();
      if (langNorm === "mermaid") {
        segments.push({ type: "mermaid", content: parsed.body });
      } else if (langNorm === "math" || langNorm === "latex") {
        segments.push({ type: "math", content: parsed.body });
      } else {
        segments.push({
          type: "code",
          lang: parsed.lang,
          label: parsed.label,
          content: parsed.body
        });
      }
    } else if (match[3] !== undefined || match[4] !== undefined) {
      segments.push({
        type: "math",
        content: (match[3] ?? match[4] ?? "").trim()
      });
    }
    lastIndex = blockRegex.lastIndex;
  }

  if (lastIndex < raw.length) {
    const tail = raw.slice(lastIndex);
    // Captura qualquer bloco ``` aberto (streaming ao vivo OU resposta truncada sem ``` de fechamento)
    const openFence = tail.match(/^([\s\S]*?)```([^\n`]*)(?:\n([\s\S]*))?$/);
    if (openFence) {
      if (openFence[1] && openFence[1].trim()) {
        segments.push({ type: "prose", content: openFence[1] });
      }
      const parsedOpen = parseCodeFenceHeader(openFence[2] ?? "", openFence[3] ?? "");
      const langNorm = parsedOpen.lang.toLowerCase();
      if (langNorm === "mermaid") {
        segments.push({ type: "mermaid", content: parsedOpen.body });
      } else if (langNorm === "math" || langNorm === "latex") {
        segments.push({ type: "math", content: parsedOpen.body });
      } else {
        segments.push({
          type: "code",
          lang: parsedOpen.lang,
          label: parsedOpen.label,
          content: parsedOpen.body
        });
      }
    } else {
      segments.push({ type: "prose", content: tail });
    }
  }

  for (const seg of segments) {
    if (seg.type === "mermaid") {
      container.appendChild(createMermaidBlockElement(seg.content, { isStreaming }));
      continue;
    }

    if (seg.type === "math") {
      container.appendChild(createMathBlockElement(seg.content, isStreaming));
      continue;
    }

    if (seg.type === "code") {
      const codeWrapper = document.createElement("div");
      codeWrapper.className = "code-block-wrapper";

      const codeHeader = document.createElement("div");
      codeHeader.className = "code-block-header";

      const langSpan = document.createElement("span");
      langSpan.className = "code-lang-label";
      langSpan.textContent = seg.label || seg.lang || "código";

      const copyCodeBtn = document.createElement("button");
      copyCodeBtn.type = "button";
      copyCodeBtn.className = "btn-copy-code";
      copyCodeBtn.innerHTML = `${SVG_ICONS.clipboard}<span>Copiar código</span>`;
      copyCodeBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(seg.content);
          copyCodeBtn.innerHTML = `${SVG_ICONS.check}<span>Copiado</span>`;
          setTimeout(() => {
            copyCodeBtn.innerHTML = `${SVG_ICONS.clipboard}<span>Copiar código</span>`;
          }, 1800);
        } catch {
          copyCodeBtn.textContent = "Erro ao copiar";
        }
      });

      codeHeader.append(langSpan, copyCodeBtn);

      const pre = document.createElement("pre");
      pre.className = "code-block-pre";
      const codeEl = document.createElement("code");
      codeEl.innerHTML = highlightCodeHtml(seg.content, seg.lang);
      pre.appendChild(codeEl);

      codeWrapper.append(codeHeader, pre);
      container.appendChild(codeWrapper);
      continue;
    }

    const lines = seg.content.split("\n");
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i++;
        continue;
      }

      if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
        container.appendChild(document.createElement("hr"));
        i++;
        continue;
      }

      const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        const level = Math.min(4, headingMatch[1].length);
        const h = document.createElement(`h${level}`);
        h.innerHTML = formatInlineMarkdown(escapeHtml(headingMatch[2]), { isStreaming });
        container.appendChild(h);
        i++;
        continue;
      }

      if (
        trimmed.startsWith("|") &&
        i + 1 < lines.length &&
        /^\|\s*[-:]+/.test(lines[i + 1].trim())
      ) {
        const tableWrap = document.createElement("div");
        tableWrap.className = "md-table-wrap";
        const table = document.createElement("table");
        table.className = "md-table";

        const parseRow = (rowStr) =>
          rowStr
            .trim()
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map((c) => c.trim());

        const headers = parseRow(trimmed);
        const thead = document.createElement("thead");
        const trHead = document.createElement("tr");
        for (const hText of headers) {
          const th = document.createElement("th");
          th.innerHTML = formatInlineMarkdown(escapeHtml(hText), { isStreaming });
          trHead.appendChild(th);
        }
        thead.appendChild(trHead);
        table.appendChild(thead);

        i += 2;
        const tbody = document.createElement("tbody");
        while (i < lines.length && lines[i].trim().startsWith("|")) {
          const cells = parseRow(lines[i]);
          const tr = document.createElement("tr");
          for (const cText of cells) {
            const td = document.createElement("td");
            td.innerHTML = formatInlineMarkdown(escapeHtml(cText), { isStreaming });
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
          i++;
        }
        table.appendChild(tbody);
        tableWrap.appendChild(table);
        container.appendChild(tableWrap);
        continue;
      }

      if (/^[-*]\s+/.test(trimmed)) {
        const ul = document.createElement("ul");
        while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
          const itemText = lines[i].trim().replace(/^[-*]\s+/, "");
          const li = document.createElement("li");
          li.innerHTML = formatInlineMarkdown(escapeHtml(itemText), { isStreaming });
          ul.appendChild(li);
          i++;
        }
        container.appendChild(ul);
        continue;
      }

      if (/^\d+\.\s+/.test(trimmed)) {
        const ol = document.createElement("ol");
        while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
          const itemText = lines[i].trim().replace(/^\d+\.\s+/, "");
          const li = document.createElement("li");
          li.innerHTML = formatInlineMarkdown(escapeHtml(itemText), { isStreaming });
          ol.appendChild(li);
          i++;
        }
        container.appendChild(ol);
        continue;
      }

      if (trimmed.startsWith(">")) {
        const bq = document.createElement("blockquote");
        const quoteLines = [];
        while (i < lines.length && lines[i].trim().startsWith(">")) {
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
          i++;
        }
        bq.innerHTML = formatInlineMarkdown(escapeHtml(quoteLines.join(" ")), { isStreaming });
        container.appendChild(bq);
        continue;
      }

      const paraLines = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !/^(#{1,4}\s|[-*]\s|\d+\.\s|---|\*\*\*|\||>)/.test(lines[i].trim())
      ) {
        paraLines.push(lines[i].trim());
        i++;
      }
      if (paraLines.length > 0) {
        const p = document.createElement("p");
        p.innerHTML = formatInlineMarkdown(escapeHtml(paraLines.join(" ")), { isStreaming });
        container.appendChild(p);
      } else {
        i++;
      }
    }
  }

  // Clique em qualquer fórmula inline copia o LaTeX original
  if (!isStreaming) {
    container.addEventListener("click", async (e) => {
      const inlineMath = e.target?.closest?.(".math-inline[data-katex-latex]");
      if (!inlineMath) return;
      const latex = inlineMath.getAttribute("data-katex-latex") || "";
      if (!latex) return;
      try {
        await navigator.clipboard.writeText(latex);
        inlineMath.classList.add("is-copied");
        setTimeout(() => inlineMath.classList.remove("is-copied"), 1200);
      } catch {
        // Ignora
      }
    });
    hydrateRichBlocks(container);
  }

  return container;
}


export function createCopyMarkdownButton(markdownText, defaultLabel, className = "btn-secondary") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.innerHTML = `${SVG_ICONS.clipboard}<span>${escapeHtml(defaultLabel)}</span>`;

  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(markdownText);
      btn.innerHTML = `${SVG_ICONS.check}<span>Markdown Copiado</span>`;
      setTimeout(() => {
        btn.innerHTML = `${SVG_ICONS.clipboard}<span>${escapeHtml(defaultLabel)}</span>`;
      }, 2000);
    } catch {
      btn.textContent = "Selecione manualmente abaixo";
    }
  });

  return btn;
}


export function slugifyFilename(text) {
  const clean = String(text || "conversa-ai-council")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return clean || "conversa-ai-council";
}

export function buildConversationMarkdownExport(debate) {
  const lines = [];
  const participantsList = (debate.participants || [])
    .map((p) => PLATFORMS[p] || p)
    .join(", ");

  lines.push(`# ${debate.title || "Conversa AI Council"}`);
  lines.push("");
  lines.push(`- **Criada em:** ${formatDate(debate.createdAt)}`);
  if (debate.updatedAt) {
    lines.push(`- **Atualizada em:** ${formatDate(debate.updatedAt)}`);
  }
  if (participantsList) {
    lines.push(`- **Participantes:** ${participantsList}`);
  }
  lines.push(`- **Status:** ${STATUS_LABELS[debate.status] || debate.status}`);
  lines.push("");

  if (debate.sharedMemory?.summary?.trim()) {
    lines.push("## Memória Compartilhada");
    lines.push("");
    lines.push(debate.sharedMemory.summary.trim());
    lines.push("");
  }

  const turns = getSessionTurns(debate);
  turns.forEach((turn, idx) => {
    const turnResponses = getResponsesForTurn(debate, turn);
    const modeLabel = RESPONSE_MODE_LABELS[turn.responseMode] || "Prompt MD";
    const dynLabel = INTERACTION_MODE_LABELS[turn.interactionMode] || "Debate";

    lines.push("---");
    lines.push("");
    lines.push(
      `## Turno ${idx + 1} · ${modeLabel} / ${dynLabel}${turn.createdAt ? ` (${formatDate(turn.createdAt)})` : ""}`
    );
    lines.push("");
    lines.push("### Pergunta");
    lines.push("");
    lines.push(turn.prompt || "");
    lines.push("");

    if (Array.isArray(turn.attachments) && turn.attachments.length > 0) {
      lines.push(
        `**Anexos:** ${turn.attachments.map((f) => `\`${f.name}\``).join(", ")}`
      );
      lines.push("");
    }

    const isDirect = turn.interactionMode === "direct";
    const nonSynth = turnResponses.filter((r) => r.stage !== "synthesis");

    if (isDirect) {
      if (nonSynth.length > 0) {
        lines.push("### Respostas");
        lines.push("");
        for (const resp of nonSynth) {
          lines.push(`#### ${PLATFORMS[resp.platform] || resp.platform}`);
          lines.push("");
          lines.push((resp.content || "").trim());
          lines.push("");
        }
      }
    } else {
      const roundsCount = Math.max(1, Number(turn.totalRounds) || 1);
      for (let r = 1; r <= roundsCount; r++) {
        const roundResps = nonSynth.filter((resp) => resp.round === r);
        if (roundResps.length === 0) continue;
        lines.push(`### Rodada ${r}`);
        lines.push("");
        for (const resp of roundResps) {
          lines.push(`#### ${PLATFORMS[resp.platform] || resp.platform}`);
          lines.push("");
          lines.push((resp.content || "").trim());
          lines.push("");
        }
      }
    }

    if (turn.conclusion?.trim()) {
      const synthResp = turnResponses.find((r) => r.stage === "synthesis");
      const relator = synthResp
        ? ` (${PLATFORMS[synthResp.platform] || synthResp.platform})`
        : "";
      lines.push(`### Síntese Final${relator}`);
      lines.push("");
      lines.push(turn.conclusion.trim());
      lines.push("");
    }
  });

  return lines.join("\n").trim() + "\n";
}

export async function handleExportConversationMarkdown(debateId, triggerBtn) {
  let debate = debateDetailsById.get(debateId);
  if (!debate || !Array.isArray(debate.responses)) {
    debate = await loadDebateDetail(debateId);
  }
  if (!debate) return;

  const mdContent = buildConversationMarkdownExport(debate);
  const blob = new Blob([mdContent], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${slugifyFilename(debate.title)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  if (triggerBtn) {
    const prevHtml = triggerBtn.innerHTML;
    triggerBtn.innerHTML = `${SVG_ICONS.check}<span>Exportado</span>`;
    setTimeout(() => {
      triggerBtn.innerHTML = prevHtml;
    }, 1800);
  }
}

