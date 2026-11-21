import { $, SVG_ICONS } from "./state.js";

let katexLoadPromise = null;
let mermaidLoadPromise = null;
let mermaidRenderSeq = 0;

const ERASER_MERMAID_THEME = {
  darkMode: true,
  background: "#181818",
  primaryColor: "#2a2b2b",
  primaryTextColor: "#ffffff",
  primaryBorderColor: "#9985ff",
  secondaryColor: "#080808",
  secondaryTextColor: "#e3e3e3",
  secondaryBorderColor: "#94dbff",
  tertiaryColor: "#181818",
  tertiaryTextColor: "#e3e3e3",
  tertiaryBorderColor: "#d6ca6f",
  lineColor: "#e3e3e3",
  textColor: "#e3e3e3",
  mainBkg: "#181818",
  nodeBorder: "#9985ff",
  clusterBkg: "#080808",
  clusterBorder: "#4b4b4b",
  edgeLabelBackground: "#181818",
  actorBkg: "#181818",
  actorBorder: "#94dbff",
  actorTextColor: "#ffffff",
  signalColor: "#e3e3e3",
  signalTextColor: "#ffffff",
  noteBkgColor: "#2a2b2b",
  noteBorderColor: "#d6ca6f",
  noteTextColor: "#ffffff",
  fontFamily: "'Inter', sans-serif",
  fontSize: "13px"
};

/**
 * Defesa em profundidade contra XSS em SVGs gerados dinamicamente (além de securityLevel: "strict").
 */
export function sanitizeRenderedSvg(rawSvg) {
  let svg = String(rawSvg || "");
  if (!svg) return "";
  svg = svg
    .replace(/<script\b[\s\S]*?<\/script>/gi, "")
    .replace(/<iframe\b[\s\S]*?<\/iframe>/gi, "")
    .replace(/<object\b[\s\S]*?<\/object>/gi, "")
    .replace(/<embed\b[^>]*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(
      /\s(xlink:)?href\s*=\s*(?:"\s*(?:javascript|vbscript|data:text\/html)[^"]*"|'\s*(?:javascript|vbscript|data:text\/html)[^']*')/gi,
      ""
    );
  return svg;
}

/**
 * Heurística precisa para decidir se um par `$...$` inline é realmente matemática
 * e NÃO um valor monetário (ex.: "R$ 50 até R$ 100", "$100 ou $200").
 */
export function looksLikeRealInlineMath(innerRaw, prefixText = "") {
  const inner = String(innerRaw || "");
  if (!inner || inner.length > 260) return false;
  if (/[\r\n]/.test(inner)) return false;
  // Pandoc/GitHub rule: "$ 50" ou "50 $" nunca é fórmula inline
  if (/^\s/.test(inner) || /\s$/.test(inner)) return false;

  // Bloqueia moedas prefixadas imediatamente antes do "$" (R$, US$, U$, C$, A$, MX$)
  if (/(?:R|US|U|C|A|MX|CAD|AUD|NZ|HK|SG|S|B)$/i.test(prefixText)) {
    return false;
  }

  // Se começa com dígito seguido de espaço/vírgula/palavras comuns de moeda sem símbolos matemáticos -> moeda
  if (/^\d[\d.,\s]*(?:reais|real|usd|brl|k|mil|m|bi|por|a|ou|e|de|em|\b)/i.test(inner)) {
    if (!/[\\^_=<>±×÷∑∫√∞α-ωΑ-Ω]/.test(inner)) {
      return false;
    }
  }

  // Número puro sem sinal/operador (ex: "$100$") também não é matemática
  if (/^\d+(?:[.,]\d+)?$/.test(inner)) {
    return false;
  }

  // Aceita comandos LaTeX, expoentes/subscritos, operadores matemáticos, notação O(...)/f(x) ou variável isolada
  return (
    /\\[a-zA-Z]+/.test(inner) ||
    /[\^_=<>+\-*/|±×÷≤≥≠≈∞∑∏∫√]/.test(inner) ||
    /[A-Za-z]\s*\([^)]+\)/.test(inner) ||
    /^[A-Za-z]$/.test(inner)
  );
}

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if (typeof document === "undefined") {
      resolve(false);
      return;
    }
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      if (existing.getAttribute("data-loaded") === "true") {
        resolve(true);
        return;
      }
      existing.addEventListener("load", () => resolve(true), { once: true });
      existing.addEventListener("error", () => reject(new Error(`Falha ao carregar ${src}`)), {
        once: true
      });
      return;
    }
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.addEventListener(
      "load",
      () => {
        script.setAttribute("data-loaded", "true");
        resolve(true);
      },
      { once: true }
    );
    script.addEventListener(
      "error",
      () => reject(new Error(`Falha ao carregar ${src}`)),
      { once: true }
    );
    document.head.appendChild(script);
  });
}

function ensureStylesheetOnce(href) {
  if (typeof document === "undefined") return;
  if (document.querySelector(`link[href="${href}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.appendChild(link);
}

export async function ensureKatexLoaded() {
  if (typeof window === "undefined") return null;
  if (window.katex && typeof window.katex.renderToString === "function") {
    return window.katex;
  }
  if (!katexLoadPromise) {
    ensureStylesheetOnce("/vendor/katex/katex.min.css");
    katexLoadPromise = loadScriptOnce("/vendor/katex/katex.min.js")
      .then(() => window.katex || null)
      .catch(() => {
        katexLoadPromise = null;
        return null;
      });
  }
  return katexLoadPromise;
}

export async function ensureMermaidLoaded() {
  if (typeof window === "undefined") return null;
  if (window.mermaid && typeof window.mermaid.render === "function") {
    return window.mermaid;
  }
  if (!mermaidLoadPromise) {
    mermaidLoadPromise = loadScriptOnce("/vendor/mermaid/mermaid.min.js")
      .then(() => {
        if (!window.mermaid) return null;
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: "strict",
          theme: "base",
          themeVariables: ERASER_MERMAID_THEME
        });
        return window.mermaid;
      })
      .catch(() => {
        mermaidLoadPromise = null;
        return null;
      });
  }
  return mermaidLoadPromise;
}

export function openDiagramLightbox(svgMarkup, captionText = "Diagrama Mermaid") {
  const modal = $("#diagram-lightbox-modal");
  const stage = $("#diagram-lightbox-stage");
  const caption = $("#diagram-lightbox-caption");
  const dlBtn = $("#diagram-lightbox-download");
  if (!modal || !stage) return;

  const safeSvg = sanitizeRenderedSvg(svgMarkup);
  stage.innerHTML = safeSvg;
  if (caption) caption.textContent = captionText;
  if (dlBtn) {
    dlBtn.onclick = () => downloadSvgMarkup(safeSvg, "diagrama-ai-council.svg");
  }
  modal.hidden = false;
}

export function closeDiagramLightbox() {
  const modal = $("#diagram-lightbox-modal");
  const stage = $("#diagram-lightbox-stage");
  if (modal) modal.hidden = true;
  if (stage) stage.replaceChildren();
}

export function downloadSvgMarkup(svgMarkup, filename = "diagrama-ai-council.svg") {
  const safeSvg = sanitizeRenderedSvg(svgMarkup);
  if (!safeSvg) return;
  const blob = new Blob([safeSvg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1200);
}

/**
 * Hidrata fórmulas KaTeX (`[data-katex-latex]`) de forma assíncrona e segura (`trust: false`).
 */
export async function hydrateMathInContainer(container) {
  if (!container || typeof container.querySelectorAll !== "function") return;
  const nodes = Array.from(container.querySelectorAll("[data-katex-latex]"));
  if (nodes.length === 0) return;

  const katex = await ensureKatexLoaded();
  if (!katex) return;

  for (const el of nodes) {
    if (el.getAttribute("data-katex-rendered") === "true") continue;
    const latex = el.getAttribute("data-katex-latex") || "";
    const displayMode = el.getAttribute("data-katex-display") === "true";
    if (!latex.trim()) continue;

    try {
      const rendered = katex.renderToString(latex, {
        displayMode,
        throwOnError: false,
        strict: "ignore",
        trust: false,
        maxExpand: 500,
        maxSize: 20
      });
      const target = el.querySelector(".math-katex-output") || el;
      target.innerHTML = rendered;
      el.setAttribute("data-katex-rendered", "true");
    } catch {
      // Mantém texto LaTeX legível em fallback
    }
  }
}

/**
 * Cria o card Eraser para um bloco Mermaid (em streaming mostra preview sem piscar;
 * quando finalizado renderiza SVG interativo com alternância Diagrama/Código, Ampliar e Baixar SVG).
 */
export function createMermaidBlockElement(rawCode, options = {}) {
  const code = String(rawCode || "").trim();
  const isStreaming = Boolean(options.isStreaming);

  const card = document.createElement("div");
  card.className = `mermaid-card${isStreaming ? " is-streaming" : ""}`;

  const header = document.createElement("div");
  header.className = "mermaid-card-header";

  const left = document.createElement("div");
  left.className = "mermaid-card-left";

  const label = document.createElement("span");
  label.className = "code-lang-label";
  label.textContent = "MERMAID";
  left.appendChild(label);

  if (isStreaming) {
    const badge = document.createElement("span");
    badge.className = "mermaid-streaming-badge";
    badge.textContent = "Gerando diagrama...";
    left.appendChild(badge);
    header.appendChild(left);

    const pre = document.createElement("pre");
    pre.className = "code-block-pre";
    const codeEl = document.createElement("code");
    codeEl.textContent = code;
    pre.appendChild(codeEl);

    card.append(header, pre);
    return card;
  }

  const actions = document.createElement("div");
  actions.className = "mermaid-card-actions";

  const viewToggle = document.createElement("div");
  viewToggle.className = "mode-segmented-pill mermaid-view-toggle";
  const btnDiagram = document.createElement("button");
  btnDiagram.type = "button";
  btnDiagram.className = "mode-seg-btn is-active";
  btnDiagram.textContent = "Diagrama";
  const btnCode = document.createElement("button");
  btnCode.type = "button";
  btnCode.className = "mode-seg-btn";
  btnCode.textContent = "Código";
  viewToggle.append(btnDiagram, btnCode);

  const zoomBtn = document.createElement("button");
  zoomBtn.type = "button";
  zoomBtn.className = "btn-copy-code";
  zoomBtn.textContent = "Ampliar";
  zoomBtn.disabled = true;

  const dlBtn = document.createElement("button");
  dlBtn.type = "button";
  dlBtn.className = "btn-copy-code";
  dlBtn.textContent = "Baixar SVG";
  dlBtn.disabled = true;

  const copyBtn = document.createElement("button");
  copyBtn.type = "button";
  copyBtn.className = "btn-copy-code";
  copyBtn.innerHTML = `${SVG_ICONS.clipboard}<span>Copiar</span>`;
  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(code);
      copyBtn.innerHTML = `${SVG_ICONS.check}<span>Copiado</span>`;
      setTimeout(() => {
        copyBtn.innerHTML = `${SVG_ICONS.clipboard}<span>Copiar</span>`;
      }, 1800);
    } catch {
      copyBtn.textContent = "Erro";
    }
  });

  actions.append(viewToggle, zoomBtn, dlBtn, copyBtn);
  header.append(left, actions);

  const diagramPane = document.createElement("div");
  diagramPane.className = "mermaid-diagram-pane";
  diagramPane.innerHTML = `<span class="mermaid-loading-text">Renderizando diagrama...</span>`;

  const codePane = document.createElement("pre");
  codePane.className = "code-block-pre mermaid-code-pane";
  codePane.hidden = true;
  const codeEl = document.createElement("code");
  codeEl.textContent = code;
  codePane.appendChild(codeEl);

  const switchMode = (showCode) => {
    diagramPane.hidden = showCode;
    codePane.hidden = !showCode;
    btnDiagram.classList.toggle("is-active", !showCode);
    btnCode.classList.toggle("is-active", showCode);
  };
  btnDiagram.addEventListener("click", () => switchMode(false));
  btnCode.addEventListener("click", () => switchMode(true));

  card.append(header, diagramPane, codePane);

  // Marca para hidratação assíncrona de SVG
  card.setAttribute("data-mermaid-pending", "true");
  card._mermaidMeta = { code, diagramPane, zoomBtn, dlBtn, switchMode };
  return card;
}

export async function hydrateMermaidInContainer(container) {
  if (!container || typeof container.querySelectorAll !== "function") return;
  const cards = Array.from(container.querySelectorAll('[data-mermaid-pending="true"]'));
  if (cards.length === 0) return;

  const mermaid = await ensureMermaidLoaded();
  if (!mermaid) {
    for (const card of cards) {
      card.removeAttribute("data-mermaid-pending");
      const meta = card._mermaidMeta;
      if (meta) meta.switchMode(true);
    }
    return;
  }

  for (const card of cards) {
    card.removeAttribute("data-mermaid-pending");
    const meta = card._mermaidMeta;
    if (!meta || !meta.code) continue;

    const renderId = `aic-mmd-${Date.now()}-${++mermaidRenderSeq}`;
    try {
      const result = await mermaid.render(renderId, meta.code);
      const safeSvg = sanitizeRenderedSvg(result?.svg || "");
      if (!safeSvg) throw new Error("SVG vazio");

      meta.diagramPane.innerHTML = safeSvg;
      meta.zoomBtn.disabled = false;
      meta.dlBtn.disabled = false;
      meta.zoomBtn.onclick = () => openDiagramLightbox(safeSvg, "Diagrama Mermaid");
      meta.dlBtn.onclick = () => downloadSvgMarkup(safeSvg, "diagrama-ai-council.svg");
    } catch {
      meta.diagramPane.innerHTML = `<span class="mermaid-error-note">Sintaxe Mermaid incompleta ou inválida — exibindo código fonte.</span>`;
      meta.switchMode(true);
    }
  }
}

export function hydrateRichBlocks(container) {
  void hydrateMathInContainer(container);
  void hydrateMermaidInContainer(container);
}
