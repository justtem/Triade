import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_DESIGN_SYSTEMS_DIR = resolve(ROOT_DIR, "design-systems");
const MAX_COMPACT_BLOCK_CHARS = 3_800;

export type DesignSystemTheme = "dark" | "light" | "mixed";

export interface DesignSystemSwatch {
  name: string;
  hex: string;
  token?: string;
}

export interface DesignSystemEntry {
  id: string;
  fileName: string;
  name: string;
  tagline: string;
  theme: DesignSystemTheme;
  summary: string;
  swatches: DesignSystemSwatch[];
  accentHex: string;
  backgroundHex: string;
  tags: string[];
  compactPromptBlock: string;
}

export interface DesignSystemPublicMeta {
  id: string;
  name: string;
  tagline: string;
  theme: DesignSystemTheme;
  accentHex: string;
  backgroundHex: string;
  swatches: DesignSystemSwatch[];
  tags: string[];
}

export interface SelectDesignSystemOptions {
  modeOrId?: string;
  theme?: "dark" | "light";
  queryText?: string;
  excludeId?: string;
  randomFn?: () => number;
}

export interface SelectedDesignSystemResult {
  entry: DesignSystemEntry | null;
  reason: "explicit" | "matched" | "random" | "light_fallback" | "empty";
  matchedKeywords: string[];
}

interface CacheBucket {
  dir: string;
  signature: string;
  entries: DesignSystemEntry[];
}

let catalogCache: CacheBucket | null = null;
let lastRandomPickedId: string | null = null;

export function getDesignSystemsDir(): string {
  const override = process.env.AI_COUNCIL_DESIGN_SYSTEMS_DIR?.trim();
  return override ? resolve(override) : DEFAULT_DESIGN_SYSTEMS_DIR;
}

function normalizeText(raw: string): string {
  return String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function slugifyId(fileName: string): string {
  const base = basename(fileName, ".md");
  return base
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "style";
}

/**
 * Corrige typos comuns em hex (ex.: `#1e1e1` -> `#1e1e1e`) sem alterar hexes válidos de 3, 6 ou 8 dígitos.
 */
export function sanitizeMalformedHexes(text: string): string {
  return text.replace(/#([0-9a-fA-F]{5})(?![0-9a-fA-F])/g, (_full, five: string) => {
    // Padrão comum: `#1e1e1` (faltou o último caractere do par repetido)
    if (five[0]?.toLowerCase() === five[2]?.toLowerCase() && five[2]?.toLowerCase() === five[4]?.toLowerCase()) {
      return `#${five}${five[1]}`;
    }
    return `#${five}${five[4]}`;
  });
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.replace(/^#/, "").trim();
  if (clean.length === 3) {
    const r = parseInt(clean[0]! + clean[0]!, 16);
    const g = parseInt(clean[1]! + clean[1]!, 16);
    const b = parseInt(clean[2]! + clean[2]!, 16);
    return Number.isNaN(r) ? null : { r, g, b };
  }
  if (clean.length === 6) {
    const r = parseInt(clean.slice(0, 2), 16);
    const g = parseInt(clean.slice(2, 4), 16);
    const b = parseInt(clean.slice(4, 6), 16);
    return Number.isNaN(r) ? null : { r, g, b };
  }
  return null;
}

function classifyHexColorTags(hex: string): string[] {
  const rgb = hexToRgb(hex);
  if (!rgb) return [];
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  const l = (max + min) / 2;
  const s = delta === 0 ? 0 : delta / (1 - Math.abs(2 * l - 1));

  if (s < 0.14) {
    if (l < 0.16) return ["preto", "escuro", "minimalista"];
    if (l > 0.85) return ["branco", "claro"];
    return ["cinza", "minimalista"];
  }

  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue = Math.round(hue * 60);
    if (hue < 0) hue += 360;
  }

  const out: string[] = [];
  if (s > 0.7 && l > 0.45 && l < 0.72) out.push("neon");

  if (hue < 18 || hue >= 342) out.push("vermelho", "coral");
  else if (hue < 44) out.push("laranja", "coral");
  else if (hue < 68) out.push("amarelo", "dourado");
  else if (hue < 162) out.push("verde", "esmeralda");
  else if (hue < 200) out.push("ciano", "azul");
  else if (hue < 252) out.push("azul");
  else if (hue < 305) out.push("roxo", "violeta");
  else out.push("rosa", "magenta");

  return out;
}

function isChromaticHex(hex: string): boolean {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  const max = Math.max(rgb.r, rgb.g, rgb.b);
  const min = Math.min(rgb.r, rgb.g, rgb.b);
  return max - min >= 42;
}

function isDarkHex(hex: string): boolean {
  const rgb = hexToRgb(hex);
  if (!rgb) return false;
  const lum = 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;
  return lum < 52;
}

function extractMarkdownSection(markdown: string, headingTitleRe: RegExp): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = line.match(/^##\s+(.+)$/);
    if (m?.[1] && headingTitleRe.test(m[1].trim())) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) return "";

  const collected: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^##\s+/.test(line)) break;
    collected.push(line);
  }
  return collected.join("\n").trim();
}

function extractRootCssBlock(markdown: string): string {
  const quickStart = extractMarkdownSection(markdown, /^Quick\s+Start/i);
  const source = quickStart || markdown;
  const cssBlockMatch = source.match(/```css\s*\n([\s\S]*?:root\s*\{[\s\S]*?\})\s*\n```/i);
  if (!cssBlockMatch?.[1]) return "";

  const rawLines = sanitizeMalformedHexes(cssBlockMatch[1]).split("\n");
  const kept: string[] = [];
  let skippingSection = false;

  for (const line of rawLines) {
    const trimmed = line.trim();
    if (/^\/\*\s*Typography\s*[—-]\s*Scale/i.test(trimmed)) {
      skippingSection = true;
      continue;
    }
    if (/^\/\*\s*(Spacing|Layout|Border Radius|Named Radii|Surfaces|Shadows|Colors|Typography)/i.test(trimmed)) {
      skippingSection = /^\/\*\s*(Spacing|Layout)/i.test(trimmed);
      if (!skippingSection) kept.push(line);
      continue;
    }
    if (skippingSection) continue;
    // Ignora propriedades CSS inválidas com range tipo `16-24px` ou `8px (compact) or 28px`
    if (/^\s*--[a-z0-9-]+\s*:\s*[^;]*(?:\d+-\d+px|\bor\b)/i.test(line)) continue;
    kept.push(line);
  }

  const joined = kept.join("\n").trim();
  if (!joined.includes("}")) {
    return `${joined}\n}`;
  }
  return joined.slice(0, 1_350);
}

function extractSwatches(markdown: string): DesignSystemSwatch[] {
  const colorsSec = extractMarkdownSection(markdown, /^Tokens\s*[—-]\s*Colors/i);
  const swatches: DesignSystemSwatch[] = [];
  const seenHex = new Set<string>();

  if (colorsSec) {
    for (const line of colorsSec.split("\n")) {
      if (!line.trim().startsWith("|")) continue;
      const cells = line
        .split("|")
        .map((c) => c.trim())
        .filter(Boolean);
      if (cells.length < 2) continue;
      const hexMatch = sanitizeMalformedHexes(cells[1] ?? "").match(/#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{3}\b/);
      if (!hexMatch?.[0]) continue;
      const hex = hexMatch[0].toLowerCase();
      if (seenHex.has(hex)) continue;
      seenHex.add(hex);
      const tokenMatch = (cells[2] ?? "").match(/--[a-z0-9-]+/i);
      swatches.push({
        name: (cells[0] ?? "").replace(/[*`]/g, "").slice(0, 32),
        hex,
        ...(tokenMatch?.[0] ? { token: tokenMatch[0] } : {})
      });
    }
  }

  if (swatches.length === 0) {
    const rootCss = extractRootCssBlock(markdown);
    for (const m of rootCss.matchAll(/(--color-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{3,6})\b/gi)) {
      const hex = (m[2] ?? "").toLowerCase();
      if (!hex || seenHex.has(hex)) continue;
      seenHex.add(hex);
      swatches.push({
        name: (m[1] ?? "").replace(/^--color-/, "").replace(/-/g, " "),
        hex,
        token: m[1]
      });
    }
  }

  return swatches.slice(0, 10);
}

function extractQuickColorReference(markdown: string): string {
  // Alguns .md (ex.: gsap, supabase) usam seção própria `## Quick Color Reference`;
  // outros colocam dentro de `## Agent Prompt Guide`.
  const standalone = extractMarkdownSection(markdown, /^Quick\s+Color\s+Reference/i);
  if (standalone) {
    return standalone
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("-"))
      .slice(0, 7)
      .map((l) => sanitizeMalformedHexes(l))
      .join("\n");
  }

  const guide = extractMarkdownSection(markdown, /^Agent\s+Prompt\s+Guide/i);
  if (!guide) return "";
  const lines = guide.split("\n");
  const out: string[] = [];
  let inColorRef = false;

  for (const line of lines) {
    const t = line.trim();
    if (/^(?:\*\*)?Quick\s+Color\s+Reference(?:\*\*)?:?/i.test(t)) {
      inColorRef = true;
      continue;
    }
    if (inColorRef) {
      if (!t && out.length > 0) break;
      if (/^\*\*/.test(t) || /^##/.test(t) || /^Example\s+Component/i.test(t)) break;
      if (t.startsWith("-")) out.push(sanitizeMalformedHexes(t));
    }
  }

  return out.slice(0, 7).join("\n");
}

function extractSurfacesSummary(markdown: string): string {
  const sec = extractMarkdownSection(markdown, /^Surfaces/i);
  if (!sec) return "";
  const rows: string[] = [];
  for (const line of sec.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("|") || /^\|[\s-|]+\|$/.test(t)) continue;
    const cells = t.split("|").map((c) => c.trim()).filter(Boolean);
    if (cells.length >= 3 && !/^level$/i.test(cells[0] ?? "")) {
      const label = sanitizeMalformedHexes(`${cells[1]} (${cells[2]}): ${cells[3] ?? ""}`).trim();
      rows.push(`- L${cells[0]} ${label.slice(0, 120)}`);
    }
  }
  return rows.slice(0, 4).join("\n");
}

function extractShapesAndLayoutSummary(markdown: string): string {
  const shapesSec = extractMarkdownSection(markdown, /^Tokens\s*[—-]\s*Spacing\s*&\s*Shapes/i);
  const typoSec = extractMarkdownSection(markdown, /^Tokens\s*[—-]\s*Typography/i);
  const parts: string[] = [];

  if (typoSec) {
    const firstFace = typoSec
      .split("\n")
      .find((l) => l.trim().startsWith("### "))
      ?.replace(/^###\s+/, "")
      .trim();
    if (firstFace) {
      parts.push(`Tipografia: ${firstFace.slice(0, 170)}`);
    }
  }

  if (shapesSec) {
    const radii: string[] = [];
    const lines = shapesSec.split("\n");
    let inRadii = false;
    for (const line of lines) {
      const t = line.trim();
      if (/^###\s+Border\s+Radius/i.test(t)) {
        inRadii = true;
        continue;
      }
      if (inRadii && /^###\s+/.test(t)) {
        inRadii = false;
      }
      if (inRadii && t.startsWith("|") && !/^\|[\s-|]+\|$/.test(t)) {
        const cells = t.split("|").map((c) => c.trim()).filter(Boolean);
        if (cells.length >= 2 && !/^element$/i.test(cells[0] ?? "")) {
          radii.push(`${cells[0]}=${cells[1]}`);
        }
      }
    }
    if (radii.length > 0) {
      parts.push(`Raios: ${radii.slice(0, 5).join(", ")}`);
    }
    const layoutBullets = lines
      .map((l) => l.trim())
      .filter((l) => /^-\s+\*\*(?:Page max-width|Card padding|Section gap|Element gap)/i.test(l))
      .slice(0, 4)
      .map((l) => l.replace(/^-\s+/, "").replace(/\*\*/g, ""));
    if (layoutBullets.length > 0) {
      parts.push(`Layout: ${layoutBullets.join(" | ")}`);
    }
  }

  return parts.join("\n");
}

function extractComponentRecipes(markdown: string): string {
  const sec = extractMarkdownSection(markdown, /^Components/i);
  if (!sec) return "";
  const blocks = sec.split(/\n(?=###\s+)/);
  const recipes: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const title = lines[0]?.match(/^###\s+(.+)$/)?.[1]?.trim();
    if (!title) continue;
    const desc = lines
      .slice(1)
      .filter((l) => !l.startsWith("**Role:**"))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (desc) {
      recipes.push(`- ${title}: ${sanitizeMalformedHexes(desc).slice(0, 155)}`);
    }
    if (recipes.length >= 4) break;
  }
  return recipes.join("\n");
}

function extractConciseDosAndDonts(markdown: string): string {
  const sec = extractMarkdownSection(markdown, /^Do'?s\s+and\s+Don'?ts/i);
  if (!sec) return "";
  const bullets = sec
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[-*]\s+/.test(l))
    .slice(0, 6)
    .map((l) => sanitizeMalformedHexes(l).slice(0, 140));
  return bullets.join("\n");
}

function extractDomainTagsFromText(text: string): string[] {
  const norm = normalizeText(text);
  const tagRules: Array<[RegExp, string[]]> = [
    [/\b(verde|green|emerald|sprout|forest|botanical|greenhouse|verdant|supabase)\b/, ["verde", "esmeralda"]],
    [/\b(azul|blue|cornflower|sky|indigo|cobalt)\b/, ["azul"]],
    [/\b(roxo|violeta|violet|purple|lavender|iris|plum|lilac)\b/, ["roxo", "violeta"]],
    [/\b(rosa|pink|rose|magenta|coral|red|vermelho|ember)\b/, ["coral", "vermelho", "rosa"]],
    [/\b(laranja|orange|amber|dourado|gold|yellow|amarelo)\b/, ["laranja", "dourado"]],
    [/\b(ciano|cyan|aqua|teal|aurora)\b/, ["ciano", "neon"]],
    [/\b(neon|glow|frosted|glass|glassmorphism|aurora)\b/, ["neon", "vidro", "glass"]],
    [/\b(terminal|bloomberg|fey)\b/, ["terminal"]],
    [/\b(finance|financial|financeiro|trading|acoes|bolsa|investimentos)\b/, ["financeiro"]],
    [/\b(dashboard|command\s+center|painel|dados|data)\b/, ["dashboard"]],
    [/\b(minimal|minimalista|clean|flat|zero\s+shadows|weightless|hairline)\b/, ["minimalista", "clean"]],
    [/\b(editorial|serif|botanical|organic|warm|bone)\b/, ["editorial", "organico"]],
    [/\b(branco|claro|light|white|mixed)\b/, ["claro", "branco"]],
    [/\b(preto|escuro|dark|midnight|black|nocturnal)\b/, ["escuro", "preto"]]
  ];

  const found = new Set<string>();
  for (const [re, tags] of tagRules) {
    if (re.test(norm)) {
      for (const t of tags) found.add(t);
    }
  }
  return Array.from(found);
}

/**
 * Faz parsing determinístico em 0 ms de um arquivo `.md` de Design System
 * e gera um bloco compacto (~2.0k–2.6k chars) seguro para qualquer LLM (inclusive Groq 8k TPM).
 */
export function parseDesignSystemMarkdown(
  fileName: string,
  rawContent: string
): DesignSystemEntry {
  const cleanContent = sanitizeMalformedHexes(rawContent.replace(/\r\n/g, "\n"));
  const lines = cleanContent.split("\n");

  let name = basename(fileName, ".md");
  let tagline = "";
  let theme: DesignSystemTheme = "dark";
  let summary = "";

  for (const line of lines.slice(0, 30)) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const h1 = trimmed.match(/^#\s+(.+)$/);
    if (h1?.[1] && name === basename(fileName, ".md")) {
      name = h1[1].replace(/\s*[—–-]\s*Style\s+Reference$/i, "").trim();
      continue;
    }

    if (!tagline && trimmed.startsWith(">")) {
      tagline = trimmed.replace(/^>\s*/, "").trim().slice(0, 160);
      continue;
    }

    const themeMatch = trimmed.match(/^\*\*Theme:\*\*\s*(dark|light|mixed)\b/i);
    if (themeMatch?.[1]) {
      theme = themeMatch[1].toLowerCase() as DesignSystemTheme;
      continue;
    }

    if (
      !summary &&
      !trimmed.startsWith("#") &&
      !trimmed.startsWith(">") &&
      !trimmed.startsWith("**") &&
      !trimmed.startsWith("Source measurements") &&
      trimmed.length >= 60
    ) {
      summary = trimmed.slice(0, 420);
    }
  }

  const swatches = extractSwatches(cleanContent);
  const accentSwatch = swatches.find((s) => isChromaticHex(s.hex)) ?? swatches[0];
  const bgSwatch =
    swatches.find((s) => /canvas|page|background|bg|ink|depths|midnight/i.test(s.name + " " + (s.token ?? ""))) ??
    swatches.find((s) => isDarkHex(s.hex)) ??
    swatches[0];

  const accentHex = accentSwatch?.hex ?? "#6798ff";
  const backgroundHex = bgSwatch?.hex ?? (theme === "light" ? "#ffffff" : "#0a0a0a");

  const rootCss = extractRootCssBlock(cleanContent);
  const quickColorRef = extractQuickColorReference(cleanContent);
  const surfaces = extractSurfacesSummary(cleanContent);
  const shapesLayout = extractShapesAndLayoutSummary(cleanContent);
  const componentRecipes = extractComponentRecipes(cleanContent);
  const elevation = extractMarkdownSection(cleanContent, /^Elevation/i).slice(0, 200);
  const dosDonts = extractConciseDosAndDonts(cleanContent);

  const tagSet = new Set<string>([theme]);
  for (const t of extractDomainTagsFromText(`${fileName} ${name} ${tagline} ${summary}`)) {
    tagSet.add(t);
  }
  for (const sw of swatches.slice(0, 6)) {
    for (const t of classifyHexColorTags(sw.hex)) {
      tagSet.add(t);
    }
  }

  const uiCraftChecklist = [
    "ACABAMENTO VISUAL OBRIGATÓRIO (public/style.css 100% completo, sem cortar):",
    "- Centralize o layout em container amplo (max-width 1160px–1280px, padding generoso) com header polido, faixa hero/KPIs em destaque, cards bem espaçados e badges/pills.",
    "- ESTILIZE 100% de input, select, textarea e button com as cores de :root (PROIBIDO deixar campos brancos/cinza padrão do navegador).",
    "- Inclua obrigatoriamente regras de visibilidade para abas/estados: `.view { display: none; } .view.active { display: block; } .hidden, [hidden] { display: none !important; }`."
  ].join("\n");

  // Prioriza na ordem: Identidade -> Superfícies -> Formas/Layout -> Componentes -> Tokens :root -> Checklist visual
  // para garantir que :root e receitas de componentes NUNCA sejam cortados pelo teto de caracteres.
  const promptParts = [
    `DESIGN SYSTEM APLICADO: "${name}" (${theme}${tagline ? ` — ${tagline}` : ""})`,
    "REGRA OBRIGATÓRIA DE IDENTIDADE: aplique fielmente a estética, paleta CSS, superfícies, tipografia (com fallback nativo de sistema e ZERO CDN externa), raios e proporções desta referência ao app do usuário. NUNCA copie nomes de marcas, logos ou textos da referência.",
    surfaces ? `Hierarquia de superfícies:\n${surfaces}` : "",
    shapesLayout ? `Formas, tipografia e layout:\n${shapesLayout}` : "",
    componentRecipes ? `Receitas de componentes desta referência:\n${componentRecipes}` : "",
    rootCss ? `Tokens CSS base (coloque em :root no public/style.css e use em toda a UI):\n\`\`\`css\n${rootCss.slice(0, 880)}\n\`\`\`` : "",
    uiCraftChecklist,
    quickColorRef ? `Mapa rápido de cores:\n${quickColorRef}` : "",
    elevation ? `Elevação: ${elevation}` : "",
    dosDonts ? `Regras essenciais:\n${dosDonts}` : ""
  ].filter(Boolean);

  const compactPromptBlock = promptParts.join("\n\n").slice(0, MAX_COMPACT_BLOCK_CHARS);

  return {
    id: slugifyId(fileName),
    fileName,
    name,
    tagline,
    theme,
    summary,
    swatches: swatches.slice(0, 6),
    accentHex,
    backgroundHex,
    tags: Array.from(tagSet),
    compactPromptBlock
  };
}

export async function listDesignSystems(): Promise<DesignSystemEntry[]> {
  const dir = getDesignSystemsDir();
  let names: string[];
  try {
    names = (await readdir(dir))
      .filter((f) => f.toLowerCase().endsWith(".md"))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }

  if (names.length === 0) return [];

  const stats = await Promise.all(
    names.map(async (fileName) => {
      const fullPath = resolve(dir, fileName);
      const st = await stat(fullPath).catch(() => null);
      return { fileName, fullPath, mtimeMs: st?.mtimeMs ?? 0, size: st?.size ?? 0 };
    })
  );

  const signature = stats.map((s) => `${s.fileName}:${s.mtimeMs}:${s.size}`).join("|");
  if (catalogCache && catalogCache.dir === dir && catalogCache.signature === signature) {
    return catalogCache.entries;
  }

  const entries: DesignSystemEntry[] = [];
  for (const item of stats) {
    try {
      const content = await readFile(item.fullPath, "utf8");
      if (!content.trim()) continue;
      entries.push(parseDesignSystemMarkdown(item.fileName, content));
    } catch {
      // Ignora arquivo ilegível
    }
  }

  catalogCache = { dir, signature, entries };
  return entries;
}

export function toPublicDesignSystemMeta(
  entry: DesignSystemEntry
): DesignSystemPublicMeta {
  return {
    id: entry.id,
    name: entry.name,
    tagline: entry.tagline,
    theme: entry.theme,
    accentHex: entry.accentHex,
    backgroundHex: entry.backgroundHex,
    swatches: entry.swatches,
    tags: entry.tags
  };
}

/**
 * Seleciona o Design System ideal:
 * - ID explícito -> devolve o estilo escolhido pelo usuário;
 * - "none" -> desativa design system (usa tema padrão enxuto);
 * - "random" -> escolhe aleatoriamente evitando repetir o último usado;
 * - "auto" (padrão) -> casa palavras-chave de cor/atmosfera do prompt + Grill-me;
 *   se não houver preferência forte, sorteia um estilo diferente para cada projeto.
 */
export function selectDesignSystem(
  catalog: readonly DesignSystemEntry[],
  options: SelectDesignSystemOptions = {}
): SelectedDesignSystemResult {
  if (catalog.length === 0) {
    return { entry: null, reason: "empty", matchedKeywords: [] };
  }

  const modeOrId = (options.modeOrId ?? "auto").trim().toLowerCase();
  if (modeOrId === "none" || modeOrId === "off") {
    return { entry: null, reason: "explicit", matchedKeywords: [] };
  }

  // 1. Seleção explícita por ID
  if (modeOrId && modeOrId !== "auto" && modeOrId !== "random") {
    const exact = catalog.find((e) => e.id.toLowerCase() === modeOrId);
    if (exact) {
      return { entry: exact, reason: "explicit", matchedKeywords: [] };
    }
  }

  const requestedLight = options.theme === "light";
  const lightCandidates = catalog.filter((e) => e.theme === "light");
  const mixedCandidates = catalog.filter((e) => e.theme === "mixed");

  // 2. Se usuário pediu tema claro e não existe nenhum .md light nem mixed compatível,
  //    respeita honestamente o pedido de fundo claro em vez de forçar um tema escuro.
  const queryTags = extractDomainTagsFromText(options.queryText ?? "");
  const colorPreferenceTags = queryTags.filter(
    (t) => !["escuro", "preto", "claro", "branco"].includes(t)
  );

  let pool: DesignSystemEntry[];
  if (requestedLight) {
    if (lightCandidates.length > 0) {
      pool = lightCandidates;
    } else if (
      mixedCandidates.length > 0 &&
      colorPreferenceTags.some((t) => mixedCandidates.some((m) => m.tags.includes(t)))
    ) {
      pool = mixedCandidates;
    } else {
      return { entry: null, reason: "light_fallback", matchedKeywords: [] };
    }
  } else {
    pool = [...catalog];
  }

  // 3. Modo "auto": pontua aderência às cores/vibe citadas no prompt ou Grill-me
  if (modeOrId !== "random" && colorPreferenceTags.length > 0) {
    const scored = pool
      .map((entry) => {
        const matched = colorPreferenceTags.filter((t) => entry.tags.includes(t));
        const nameNorm = normalizeText(`${entry.name} ${entry.tagline}`);
        const queryNorm = normalizeText(options.queryText ?? "");
        const directNameBonus =
          entry.name.length >= 3 && queryNorm.includes(normalizeText(entry.name)) ? 5 : 0;
        const taglineBonus = matched.some((m) => nameNorm.includes(m)) ? 1 : 0;
        return {
          entry,
          matched,
          score: matched.length * 3 + directNameBonus + taglineBonus
        };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length > 0) {
      const topScore = scored[0]!.score;
      const topTied = scored.filter((s) => s.score === topScore);
      const rand = options.randomFn ?? Math.random;
      const pick = topTied[Math.floor(rand() * topTied.length)] ?? topTied[0]!;
      return {
        entry: pick.entry,
        reason: "matched",
        matchedKeywords: pick.matched
      };
    }
  }

  // 4. Seleção aleatória anti-repetição (garante que cada projeto novo tenha uma cara diferente!)
  const avoidId = options.excludeId ?? lastRandomPickedId;
  const nonRepeat = pool.length > 1 && avoidId
    ? pool.filter((e) => e.id !== avoidId)
    : pool;
  const rand = options.randomFn ?? Math.random;
  const chosen = nonRepeat[Math.floor(rand() * nonRepeat.length)] ?? nonRepeat[0]!;
  lastRandomPickedId = chosen.id;

  return {
    entry: chosen,
    reason: "random",
    matchedKeywords: []
  };
}

/** Apenas para testes unitários isolados. */
export function resetDesignSystemsCacheForTests(): void {
  catalogCache = null;
  lastRandomPickedId = null;
}
