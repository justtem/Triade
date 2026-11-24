import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { GrillAnswer } from "./app-grill-me.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ARCHETYPES_DIR = resolve(__dirname, "../../landing-archetypes");

export type LandingArchetypeId =
  | "editorial-luxe"
  | "bold-conversion"
  | "contrast-story"
  | "local-showcase"
  | "dark-bento";

export interface LandingArchetypeEntry {
  id: string;
  name: string;
  theme: "dark" | "light";
  vibe: string;
  tags: string[];
  compactPrompt: string;
}

export interface LandingArchetypePublicMeta {
  id: string;
  name: string;
  theme: "dark" | "light";
  vibe: string;
  tags: string[];
}

let cachedArchetypes: LandingArchetypeEntry[] | null = null;
let lastPickedArchetypeId: string | null = null;

function normalizeText(raw: string): string {
  return String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function parseArchetypeMarkdown(fileName: string, raw: string): LandingArchetypeEntry {
  const id = fileName.replace(/\.md$/i, "").trim().toLowerCase();
  const titleMatch = raw.match(/^#\s+(.+)$/m);
  const name = (titleMatch?.[1] ?? id).trim();
  const themeMatch = raw.match(/\*\*Tema:\*\*\s*`?(dark|light)`?/i);
  const theme: "dark" | "light" =
    themeMatch?.[1]?.toLowerCase() === "dark" ? "dark" : "light";
  const vibeMatch = raw.match(/\*\*Vibe:\*\*\s*(.+)$/m);
  const vibe = (vibeMatch?.[1] ?? "").trim();
  const tagsMatch = raw.match(/\*\*Tags:\*\*\s*(.+)$/m);
  const tags = (tagsMatch?.[1] ?? "")
    .split(/[,|]+/)
    .map((t) => normalizeText(t))
    .filter(Boolean);

  // Compacta mantendo 100% dos tokens :root, tipografia e composição obrigatória (<= 2.600 chars)
  const compactPrompt = raw.trim().slice(0, 2_600);

  return {
    id,
    name,
    theme,
    vibe,
    tags,
    compactPrompt
  };
}

export async function loadAllLandingArchetypes(): Promise<LandingArchetypeEntry[]> {
  if (cachedArchetypes) return cachedArchetypes;

  try {
    const entries = await readdir(ARCHETYPES_DIR, { withFileTypes: true });
    const mdFiles = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(".md"))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));

    const loaded: LandingArchetypeEntry[] = [];
    for (const fileName of mdFiles) {
      const content = await readFile(join(ARCHETYPES_DIR, fileName), "utf8");
      loaded.push(parseArchetypeMarkdown(fileName, content));
    }
    cachedArchetypes = loaded;
    return loaded;
  } catch {
    return [];
  }
}

export function resetLandingArchetypesCacheForTests(): void {
  cachedArchetypes = null;
  lastPickedArchetypeId = null;
}

export async function listLandingArchetypesPublic(): Promise<LandingArchetypePublicMeta[]> {
  const all = await loadAllLandingArchetypes();
  return all.map(({ id, name, theme, vibe, tags }) => ({
    id,
    name,
    theme,
    vibe,
    tags
  }));
}

const ARCHETYPE_EXPLICIT_PATTERNS: Array<{ id: LandingArchetypeId; re: RegExp }> = [
  { id: "editorial-luxe", re: /\b(editorial\s+luxo|editorial-luxe|serif|imobiliaria|clinica|luxo\s+claro)\b/ },
  { id: "bold-conversion", re: /\b(conversao\s+bold|bold-conversion|limao|vibrante|fintech|profinance|vendas\s+diretas)\b/ },
  { id: "contrast-story", re: /\b(contraste\s+escuro|contrast-story|escuro\s+e\s+claro|alternancia|hackerrank|b2b\s+consultiv)\b/ },
  { id: "local-showcase", re: /\b(vitrine\s+(?:de\s+)?negocio\s+local|local-showcase|vitrine\s+interativa|organico|cardapio|matcha)\b/ },
  { id: "dark-bento", re: /\b(dark\s+bento|dark-bento|bento\s+tech|escuro\s+cinematografico|defi|superlinked)\b/ }
];

const ARCHETYPE_DOMAIN_AFFINITY: Array<{ re: RegExp; preferredIds: LandingArchetypeId[] }> = [
  {
    re: /\b(clinica|dentista|odontolog|medic|advogad|escritorio|imobiliaria|imoveis|arquitet|consultori|psicolog|contabilidad)\b/,
    preferredIds: ["editorial-luxe", "contrast-story"]
  },
  {
    re: /\b(cafeteria|cafe|restaurante|pizzaria|hamburguer|padaria|doceria|confeitaria|barbearia|salao|estetica|academia|pet\s*shop|floricultura|loja\s+local|negocio\s+local|delivery|cardapio)\b/,
    preferredIds: ["local-showcase", "editorial-luxe"]
  },
  {
    re: /\b(vendas|infoproduto|curso|mentoria|ebook|lancamento|captura\s+de\s+leads?|funil|oferta|saas|fintech|app|assinatura)\b/,
    preferredIds: ["bold-conversion", "contrast-story"]
  },
  {
    re: /\b(agencia|startup|ia|inteligencia\s+artificial|software|automacao|api|developer|crypto|web3|tech|tecnologia|plataforma)\b/,
    preferredIds: ["dark-bento", "contrast-story"]
  }
];

export async function selectLandingArchetype(options: {
  prompt: string;
  grillAnswers?: GrillAnswer[];
  explicitId?: string;
  excludeId?: string | null;
}): Promise<{ archetype: LandingArchetypeEntry | null; matchReason: string }> {
  const all = await loadAllLandingArchetypes();
  if (all.length === 0) {
    return { archetype: null, matchReason: "none_loaded" };
  }

  const pickWithRemember = (entry: LandingArchetypeEntry, matchReason: string) => {
    lastPickedArchetypeId = entry.id;
    return { archetype: entry, matchReason };
  };

  // 1. ID explícito
  if (options.explicitId) {
    const exact = all.find((a) => a.id === options.explicitId!.trim().toLowerCase());
    if (exact) return pickWithRemember(exact, "explicit_id");
  }

  const grillText = (options.grillAnswers ?? [])
    .map((a) => `${a.question} ${a.answer}`)
    .join(" ");
  const normGrill = normalizeText(grillText);
  const normPrompt = normalizeText(options.prompt);
  const combined = `${normGrill} ${normPrompt}`.trim();

  // 2. Escolha explícita vinda das respostas do Grill-me ou do prompt
  for (const pat of ARCHETYPE_EXPLICIT_PATTERNS) {
    if (pat.re.test(normGrill)) {
      const found = all.find((a) => a.id === pat.id);
      if (found) return pickWithRemember(found, `grill_match:${found.id}`);
    }
  }

  const avoidId = options.excludeId ?? lastPickedArchetypeId;

  // 3. Afinidade por nicho/domínio com anti-repetição
  for (const rule of ARCHETYPE_DOMAIN_AFFINITY) {
    if (rule.re.test(combined)) {
      const candidates = rule.preferredIds
        .map((id) => all.find((a) => a.id === id))
        .filter((x): x is LandingArchetypeEntry => Boolean(x));
      if (candidates.length > 0) {
        const fresh = candidates.filter((c) => c.id !== avoidId);
        const chosen = fresh[0] ?? candidates[0]!;
        return pickWithRemember(chosen, `domain_match:${chosen.id}`);
      }
    }
  }

  // 4. Fallback rotativo (anti-repetição)
  const pool = all.filter((a) => a.id !== avoidId);
  const chosen = pool[0] ?? all[0]!;
  return pickWithRemember(chosen, "anti_repeat_rotation");
}
