import {
  readDebateSessionById,
  withDebateLock,
  writeDebateSessionAtomically
} from "../persistence/debate-store.js";
import { getProvider, getProvidersStatus, initProviders } from "../providers/registry.js";
import { scanAndRedactText } from "../security/privacy-shield.js";
import { ANTI_INJECTION_SYSTEM_RULE } from "../security/prompt-defense.js";
import { emitDebateUpdated } from "./stream-hub.js";

const MAX_AUTO_TITLE_CHARS = 58;

const AUTO_TITLE_SYSTEM_PROMPT = [
  "Gere um título curto, natural e claro (3 a 6 palavras, máximo 52 caracteres) em português do Brasil para identificar esta conversa na barra lateral.",
  "Responda SOMENTE com o título puro — sem aspas, sem prefixos como 'Título:', sem emojis e sem ponto final.",
  "Nunca inclua senhas, tokens, e-mails, CPFs ou caminhos longos de pasta.",
  ANTI_INJECTION_SYSTEM_RULE
].join("\n");

function isRunningUnderTest(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.argv.some((arg) => arg === "--test" || arg.includes(".test."))
  );
}

/**
 * Sanitiza um título retornado pelo LLM ou gerado localmente.
 */
export function sanitizeAutoTitleText(raw: string): string {
  const firstLine = String(raw || "")
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean) ?? "";

  let clean = firstLine
    .replace(/^#{1,6}\s*/, "")
    .replace(/^(?:t[ií]tulo|assunto|resumo)\s*[:\-–—]\s*/i, "")
    .replace(/^["'`“”‘’*_\[\(]+|["'`“”‘’*_\]\)]+$/g, "")
    .replace(/\s+/g, " ")
    .replace(/[.!?;:,\-–—]+$/g, "")
    .trim();

  if (clean.length > MAX_AUTO_TITLE_CHARS) {
    const sliced = clean.slice(0, MAX_AUTO_TITLE_CHARS);
    const lastSpace = sliced.lastIndexOf(" ");
    clean = (lastSpace > 20 ? sliced.slice(0, lastSpace) : sliced).trim();
  }

  return clean;
}

/**
 * Gera em 0 ms um título inicial limpo e legível (remove prefixos técnicos
 * como "Crie na pasta...", "Stack obrigatória:", URLs longas e markdown).
 */
export function buildLocalCleanTitle(rawTopic: string): string {
  const text = String(rawTopic || "").replace(/\r\n/g, "\n").trim();
  if (!text) return "Nova Conversa";

  // 1. Se vier de um blueprint expandido ("Crie na pasta o projeto completo e funcional \"NomeApp\"...")
  const blueprintName = text.match(
    /projeto\s+completo\s+e\s+funcional\s+["'`“]?([A-Za-zÀ-ÿ0-9_-]{2,32})["'`”]?/i
  );
  if (blueprintName?.[1]) {
    const ideaMatch = text.match(/Ideia solicitada pelo usu[aá]rio:\s*\n["'`“]?([^\n"`”]{4,80})/i);
    if (ideaMatch?.[1]) {
      const cleanIdea = sanitizeAutoTitleText(
        ideaMatch[1].replace(/^(?:cria|crie|faca|faz|quero\s+criar|monte)\s+(?:um|uma)\s+(?:app|aplicativo|site|sistema)\s+(?:de\s+)?/i, "")
      );
      if (cleanIdea && !cleanIdea.toLowerCase().includes(blueprintName[1].toLowerCase())) {
        return sanitizeAutoTitleText(`${blueprintName[1]} · ${cleanIdea}`);
      }
    }
    return sanitizeAutoTitleText(blueprintName[1]);
  }

  // 2. Remove blocos de código, URLs e prefixos burocráticos comuns
  let clean = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^stack\s+obrigat[oó]ria\s*:/i.test(l) && !/^---+$/.test(l))[0] ?? text;

  clean = clean
    .replace(/^\/grill\s+/i, "")
    .replace(
      /^(?:ol[aá],?\s+|oi,?\s+)?(?:por\s+favor,?\s+)?(?:crie|cria|criar|fa[cç]a|faz|monte|construa|refa[cç]a|me\s+ajud[ae]\s+a|quero\s+que\s+voc[eê]|preciso\s+que\s+voc[eê])\s+(?:na\s+pasta\s+)?(?:completamente\s+)?(?:o|a|um|uma)?\s*/i,
      ""
    )
    .replace(/^["'`“”]+|["'`“”]+$/g, "")
    .trim();

  if (clean.length < 4) {
    clean = text.replace(/\s+/g, " ").trim();
  }

  const normalized = sanitizeAutoTitleText(clean);
  if (!normalized) return "Nova Conversa";
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

/**
 * Gera um título curto e natural via Groq (~0,4s, 900 req/dia).
 * NUNCA gasta cota do Gemini nem do OpenRouter; devolve null em falha para manter o fallback local.
 */
export async function generateSmartDebateTitle(rawTopic: string): Promise<string | null> {
  const shielded = scanAndRedactText(String(rawTopic || "").slice(0, 700), "strict").redactedText.trim();
  if (shielded.length < 8) return null;

  initProviders();
  const statuses = await getProvidersStatus();
  const groqSt = statuses.find((s) => s.id === "groq");
  const groqProvider = getProvider("groq");
  if (!groqSt?.ready || !groqProvider) return null;

  const usage = groqSt.usage;
  if (usage && usage.requestsDailyCap > 0) {
    const ratio = (usage.requestsDailyCap - usage.requestsToday) / usage.requestsDailyCap;
    if (ratio < 0.15) return null;
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6_000);
  timer.unref?.();

  try {
    const res = await groqProvider.generate({
      system: AUTO_TITLE_SYSTEM_PROMPT,
      user: `Mensagem inicial da conversa:\n"${shielded}"\n\nTítulo curto (3 a 6 palavras):`,
      maxTokens: 48,
      signal: ctrl.signal
    });
    const cleaned = sanitizeAutoTitleText(res.text);
    if (cleaned.length < 3) return null;
    return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Atualiza silenciosamente o título da conversa em background usando Groq.
 * Garante via lock que NUNCA sobrescreve se o usuário já renomeou a conversa manualmente.
 */
export function scheduleAutoTitleForDebate(
  debateId: string,
  rawTopic: string,
  expectedInitialTitle: string,
  options: {
    generator?: (topic: string) => Promise<string | null>;
    forceInTest?: boolean;
  } = {}
): Promise<boolean> {
  if (isRunningUnderTest() && !options.forceInTest) {
    return Promise.resolve(false);
  }

  const runGenerator = options.generator ?? generateSmartDebateTitle;

  return (async () => {
    try {
      const smartTitle = await runGenerator(rawTopic);
      if (!smartTitle || smartTitle === expectedInitialTitle) {
        return false;
      }

      return await withDebateLock(async () => {
        const session = await readDebateSessionById(debateId);
        if (!session) return false;
        // Se o usuário já editou o título manualmente, respeita intacto!
        if (session.title !== expectedInitialTitle) {
          return false;
        }
        session.title = smartTitle;
        session.updatedAt = new Date().toISOString();
        await writeDebateSessionAtomically(session);
        emitDebateUpdated(session);
        return true;
      });
    } catch {
      return false;
    }
  })();
}
