import {
  getProvider,
  getProvidersStatus,
  initProviders
} from "../providers/registry.js";
import {
  isSensitiveMemoryText,
  readUserMemory,
  upsertUserMemoryFacts,
  type UserMemoryCategory,
  type UserMemoryFact
} from "../persistence/user-memory-store.js";
import type { AutoPlatform, ChatTurn, DebateSession } from "../shared/debate-types.js";

export const USER_MEMORY_MIN_QUOTA_RATIO = 0.2;

const PERSONAL_SIGNAL_REGEX =
  /\b(meu nome|me chamo|pode me chamar|sou (um |uma )?[a-zà-ú]{3,}|trabalho (com|como|na|no|em)|estudo |fa[cç]o faculdade|moro em|tenho \d{1,2} anos|minha [aá]rea|minha empresa|meu pc|meu computador|meu notebook|uso (windows|linux|mac|macos|ubuntu|vs\s?code|neovim|typescript|python|java|node|react|next|docker)|prefiro |sempre respond|n[aã]o gosto de|gosto (muito )?de|costumo usar|minha stack|meu foco|fale comigo|me explique sempre|lembre que|lembra que|guarda isso|salva na mem[oó]ria|anota a[ií]|meu objetivo|estou (criando|desenvolvendo|construindo|aprendendo|estudando|migrando)|meu projeto|minha rotina|meu treino|minha dieta|i am |i work as|my name is|i prefer |i use |remember that)\b/i;

const EXTRACTOR_SYSTEM_PROMPT = [
  "Você extrai APENAS fatos pessoais duradouros e preferências reais do usuário a partir da mensagem dele.",
  "Responda SOMENTE com JSON válido no formato:",
  '{ "add": [{ "text": "fato curto em 3ª pessoa (ex.: Usa Windows e TypeScript)", "category": "identity|preference|context|project|other" }], "removeIds": [] }',
  "Regras estritas:",
  "- Se a mensagem for apenas uma pergunta comum sem revelar nada duradouro sobre o usuário, devolva {\"add\":[],\"removeIds\":[]}.",
  "- Extraia no máximo 3 fatos curtos e objetivos em português (pt-BR).",
  "- NUNCA memorize senhas, tokens, chaves de API, CPF, cartões, contas bancárias ou dados confidenciais.",
  "- NUNCA memorize tarefas passageiras do momento (ex.: 'perguntou sobre receita de bolo').",
  "- Não duplique fatos que já constam na lista atual. Use removeIds apenas se o usuário contradisser/atualizar diretamente um fato antigo."
].join("\n");

/**
 * Pré-filtro local em 0ms (custo zero de API):
 * só permite acionar a extração em segundo plano quando a mensagem tem sinal real
 * de fato pessoal, preferência ou contexto duradouro — e nunca se contiver segredos.
 */
export function mightContainPersonalMemory(prompt: string): boolean {
  const clean = (prompt ?? "").trim();
  if (clean.length < 12 || clean.length > 4_000) return false;
  if (isSensitiveMemoryText(clean)) return false;
  return PERSONAL_SIGNAL_REGEX.test(clean);
}

export function parseMemoryExtractionJson(rawText: string): {
  add: Array<{ text: string; category: UserMemoryCategory }>;
  removeIds: string[];
} {
  const cleaned = rawText
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();

  const candidates = [cleaned];
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }

  const validCats = new Set<UserMemoryCategory>([
    "identity",
    "preference",
    "context",
    "project",
    "other"
  ]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        add?: unknown;
        removeIds?: unknown;
      };
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;

      const add: Array<{ text: string; category: UserMemoryCategory }> = [];
      if (Array.isArray(parsed.add)) {
        for (const item of parsed.add.slice(0, 3)) {
          if (typeof item === "string" && item.trim().length >= 6) {
            if (!isSensitiveMemoryText(item)) {
              add.push({ text: item.trim(), category: "other" });
            }
          } else if (
            item &&
            typeof item === "object" &&
            typeof (item as { text?: unknown }).text === "string"
          ) {
            const text = (item as { text: string }).text.trim();
            const rawCat = (item as { category?: unknown }).category;
            const category =
              typeof rawCat === "string" && validCats.has(rawCat as UserMemoryCategory)
                ? (rawCat as UserMemoryCategory)
                : "other";
            if (text.length >= 6 && !isSensitiveMemoryText(text)) {
              add.push({ text, category });
            }
          }
        }
      }

      const removeIds = Array.isArray(parsed.removeIds)
        ? parsed.removeIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0)
        : [];

      return { add, removeIds };
    } catch {
      // tenta próximo candidato
    }
  }

  return { add: [], removeIds: [] };
}

async function pickHealthyMemoryExtractorProvider(): Promise<AutoPlatform | null> {
  initProviders();
  const statuses = await getProvidersStatus();

  // Preferência: Gemini (200k TPM) > Groq (1000 RPD) > OpenRouter
  const priority: AutoPlatform[] = ["gemini", "groq", "openrouter"];

  for (const id of priority) {
    const st = statuses.find((s) => s.id === id);
    if (!st || !st.ready || !getProvider(id)) continue;
    const reqCap = Math.max(1, st.usage?.requestsDailyCap ?? 100);
    const reqRatio = Math.max(0, 1 - (st.usage?.requestsToday ?? 0) / reqCap);
    const tokCap = st.usage?.tokensDailyCap;
    const tokRatio =
      tokCap && tokCap > 0
        ? Math.max(0, 1 - (st.usage?.tokensToday ?? 0) / tokCap)
        : 1;
    const remainingRatio = Math.min(reqRatio, tokRatio);
    if (remainingRatio >= USER_MEMORY_MIN_QUOTA_RATIO) {
      return id;
    }
  }

  return null;
}

function buildExtractorUserPrompt(
  userPrompt: string,
  existingFacts: UserMemoryFact[]
): string {
  const existingLines =
    existingFacts.length > 0
      ? existingFacts.map((f) => `- [${f.id}] (${f.category}) ${f.text}`).join("\n")
      : "(vazia)";

  return [
    "Memória atual do usuário:",
    existingLines,
    "",
    "Nova mensagem enviada pelo usuário:",
    userPrompt.slice(0, 1_500),
    "",
    "Retorne APENAS o JSON."
  ].join("\n");
}

/**
 * Extrai fatos pessoais duradouros em segundo plano (best-effort silencioso).
 * - Só dispara se memória automática estiver ativa, filtro local der positivo e houver >= 20% cota livre.
 */
export async function extractAndSaveUserMemoryFromTurn(
  session: DebateSession,
  turn: ChatTurn
): Promise<{ addedCount: number; removedCount: number } | null> {
  const memory = await readUserMemory();
  if (!memory.enabled) return null;
  if (!mightContainPersonalMemory(turn.prompt)) return null;

  const providerId = await pickHealthyMemoryExtractorProvider();
  if (!providerId) return null;

  const provider = getProvider(providerId);
  if (!provider) return null;

  const result = await provider.generate({
    system: EXTRACTOR_SYSTEM_PROMPT,
    user: buildExtractorUserPrompt(turn.prompt, memory.facts),
    maxTokens: 320
  });

  const extracted = parseMemoryExtractionJson(result.text);
  if (extracted.add.length === 0 && extracted.removeIds.length === 0) {
    return { addedCount: 0, removedCount: 0 };
  }

  const saved = await upsertUserMemoryFacts(
    extracted.add,
    extracted.removeIds,
    session.id
  );
  return {
    addedCount: saved.addedCount,
    removedCount: saved.removedCount
  };
}
