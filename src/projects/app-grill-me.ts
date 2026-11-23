import { getProvider, getProvidersStatus, initProviders } from "../providers/registry.js";
import { ANTI_INJECTION_SYSTEM_RULE } from "../security/prompt-defense.js";
import type { AutoPlatform } from "../shared/debate-types.js";
import type { DesignSystemPublicMeta } from "./design-systems.js";

export interface GrillQuestion {
  id: string;
  question: string;
  category: "product" | "ux" | "visual" | "data";
  options: string[];
  allowCustom: boolean;
  recommended?: string;
}

export interface GrillAnswer {
  id: string;
  question: string;
  answer: string;
}

export type GrillMeMode = "app" | "general";

export interface GrillMeGenerationInput {
  prompt: string;
  mode?: GrillMeMode;
  appKind?: "web_app" | "api" | "landing";
  theme?: "dark" | "light";
  designSystems?: DesignSystemPublicMeta[];
}

export interface GrillMeGenerationResult {
  questions: GrillQuestion[];
  provider: AutoPlatform | "local_fallback";
  model: string;
}

const MAX_GRILL_QUESTIONS = 10;
const MIN_GRILL_QUESTIONS = 3;

const GENERAL_GRILL_NEG_GUARD_RE =
  /\b(sem\s+perguntas|direto\s+ao\s+ponto|responda\s+rapido|seja\s+breve|apenas\s+responda|so\s+responda|nao\s+pergunte)\b/;

const GENERAL_GRILL_FACTUAL_START_RE =
  /^(?:o\s+que\s+e|quem\s+e|quando|onde|quant[oa]s?|qual\s+(?:e\s+)?a\s+diferenca|explique|explica|traduza|resuma|corrija\s+o\s+texto|converta|calcule|que\s+horas|como\s+funciona\s+o)\b/;

const GENERAL_GRILL_BROAD_RE =
  /\b(me\s+ajud[ae]\s+a\s+(?:planejar|estruturar|criar|montar|definir|escolher|organizar|desenhar)|quero\s+(?:planejar|estruturar|montar|criar|desenhar|lancar)\s+(?:um|uma)|plano\s+de\s+(?:estudos|negocios|acao|projeto|carreira|marketing|arquitetura)|estrategia\s+(?:de|para)|arquitetura\s+(?:de|para)\s+(?:um|uma)|como\s+(?:estruturar|planejar|montar|comecar)\s+(?:um|uma))\b/;

/**
 * Classificador local 0ms para decidir se um pedido não-app é amplo/aberto o suficiente
 * para oferecer automaticamente o Grill-me Wizard (sem interromper perguntas curtas/factuais).
 */
export function shouldAutoTriggerGeneralGrillMe(prompt: string): boolean {
  const norm = String(prompt || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

  if (norm.length < 18 || norm.length > 260) return false;
  if (norm.includes("```")) return false;
  if (GENERAL_GRILL_NEG_GUARD_RE.test(norm)) return false;
  if (GENERAL_GRILL_FACTUAL_START_RE.test(norm)) return false;
  return GENERAL_GRILL_BROAD_RE.test(norm);
}

const GRILL_APP_SYSTEM_PROMPT = [
  "Você é um arquiteto de produto experiente conduzindo um Grill-me rápido e adaptativo antes de construir um app/site.",
  "Objetivo: resolver apenas as decisões que realmente mudam o produto e o visual, SEM fazer perguntas óbvias que já estão na ideia do usuário.",
  "Responda APENAS com um objeto JSON válido (sem texto fora do JSON) no formato:",
  '{ "questions": [{ "id": "q1", "category": "product|ux|visual|data", "question": "Pergunta curta e direta?", "options": ["Opção recomendada", "Opção 2", "Opção 3"], "recommended": "Opção recomendada" }] }',
  "Regras estritas:",
  `- Gere ENTRE ${MIN_GRILL_QUESTIONS} e NO MÁXIMO ${MAX_GRILL_QUESTIONS} perguntas (prefira 3 a 6 para ideias simples; nunca invente perguntas só para chegar a 10).`,
  "- Escreva em português do Brasil (pt-BR), de forma leve e prática (linguagem humana, sem jargão excessivo).",
  "- Coloque SEMPRE a melhor opção recomendada em PRIMEIRO lugar na lista options (options[0] === recommended).",
  "- Inclua EXATAMENTE 1 pergunta com category=\"visual\" perguntando sobre paleta de cores / atmosfera visual preferida (ex.: Verde escuro moderno, Azul minimalista, Roxo/Violeta tech, Terminal financeiro escuro, Claro minimalista, ou Surpreenda-me / Aleatório).",
  "- Cada pergunta deve ter de 2 a 4 opções curtas e concretas; o usuário também terá a opção 'Outro...' para digitar livremente.",
  "- NUNCA peça senhas, chaves de API, CPF, dados bancários ou dados pessoais reais.",
  ANTI_INJECTION_SYSTEM_RULE
].join("\n");

const GRILL_GENERAL_SYSTEM_PROMPT = [
  "Você é um consultor estratégico e arquiteto conduzindo um Grill-me rápido e objetivo antes de responder a um pedido amplo do usuário.",
  "Objetivo: esclarecer apenas os 3 a 5 pontos decisivos (meta principal, contexto/nível, restrições e formato desejado) SEM fazer perguntas óbvias.",
  "Responda APENAS com um objeto JSON válido (sem texto fora do JSON) no formato:",
  '{ "questions": [{ "id": "q1", "category": "product|ux|data", "question": "Pergunta curta e direta?", "options": ["Opção recomendada", "Opção 2", "Opção 3"], "recommended": "Opção recomendada" }] }',
  "Regras estritas:",
  `- Gere ENTRE ${MIN_GRILL_QUESTIONS} e 6 perguntas (teto absoluto ${MAX_GRILL_QUESTIONS}). Nunca encha linguiça.`,
  "- Escreva em português do Brasil (pt-BR), de forma leve, direta e prática.",
  "- Coloque SEMPRE a opção recomendada em PRIMEIRO lugar na lista options (options[0] === recommended).",
  "- NÃO faça perguntas sobre paleta de cores ou design visual (este pedido não é de criação de interface).",
  "- Cada pergunta deve ter de 2 a 4 opções curtas e concretas; o usuário também terá a opção 'Outro...'.",
  "- NUNCA peça senhas, chaves de API, CPF, dados bancários ou dados pessoais reais.",
  ANTI_INJECTION_SYSTEM_RULE
].join("\n");

function sanitizeShortText(raw: unknown, maxLen: number): string {
  return String(raw ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLen);
}

function normalizeCategory(raw: unknown): GrillQuestion["category"] {
  const clean = String(raw ?? "").toLowerCase().trim();
  if (clean === "visual" || clean === "ux" || clean === "data" || clean === "product") {
    return clean;
  }
  return "product";
}

function buildVisualStyleQuestion(
  designSystems: DesignSystemPublicMeta[] = []
): GrillQuestion {
  const hasGreen = designSystems.some((d) => d.tags.includes("verde"));
  const hasViolet = designSystems.some((d) => d.tags.includes("roxo") || d.tags.includes("violeta"));
  const hasBlue = designSystems.some((d) => d.tags.includes("azul"));
  const options = [
    "Surpreenda-me (escolher estilo automaticamente)",
    ...(hasGreen ? ["Verde escuro moderno / botânico"] : []),
    ...(hasBlue ? ["Azul minimalista / painel limpo"] : []),
    ...(hasViolet ? ["Roxo / violeta tech escuro"] : []),
    "Preto minimalista / terminal de dados",
    "Claro minimalista (fundo branco)"
  ].slice(0, 5);

  return {
    id: "q_visual",
    category: "visual",
    question: "Qual estilo visual ou cor principal combina mais com esse projeto?",
    options,
    allowCustom: true,
    recommended: options[0]
  };
}

export function buildFallbackGrillQuestions(
  input: GrillMeGenerationInput
): GrillQuestion[] {
  if (input.mode === "general") {
    return [
      {
        id: "q_goal",
        category: "product",
        question: "Qual é o objetivo principal que você quer alcançar com isso?",
        options: [
          "Plano prático passo a passo para começar hoje",
          "Comparar opções, prós/contras e riscos antes de decidir",
          "Estrutura completa e detalhada de longo prazo"
        ],
        allowCustom: true,
        recommended: "Plano prático passo a passo para começar hoje"
      },
      {
        id: "q_level",
        category: "ux",
        question: "Qual é o nível de profundidade ideal para a resposta?",
        options: [
          "Equilibrado: claro, objetivo e com exemplos reais",
          "Direto ao ponto (resumo executivo em tópicos)",
          "Técnico e aprofundado com detalhes de implementação"
        ],
        allowCustom: true,
        recommended: "Equilibrado: claro, objetivo e com exemplos reais"
      },
      {
        id: "q_constraints",
        category: "data",
        question: "Existe alguma restrição principal que devo respeitar?",
        options: [
          "Custo zero / ferramentas gratuitas",
          "Máxima rapidez para colocar no ar logo",
          "Foco em escala e qualidade de produção"
        ],
        allowCustom: true,
        recommended: "Custo zero / ferramentas gratuitas"
      }
    ];
  }

  const isApi = input.appKind === "api";
  const isLanding = input.appKind === "landing";

  const questions: GrillQuestion[] = [
    {
      id: "q_scope",
      category: "product",
      question: isLanding
        ? "Qual é a ação principal que o visitante deve fazer na página?"
        : "Qual é o fluxo principal que você vai usar todos os dias nesse app?",
      options: isLanding
        ? ["Preencher formulário / contato", "Explorar recursos e benefícios", "Comparar planos ou portfólio"]
        : ["Cadastrar e organizar itens rapidamente", "Acompanhar metas/indicadores em painel", "Filtrar, buscar e exportar registros"],
      allowCustom: true,
      recommended: isLanding ? "Explorar recursos e benefícios" : "Cadastrar e organizar itens rapidamente"
    },
    {
      id: "q_features",
      category: "ux",
      question: "Quais recursos extras mais fazem diferença já na primeira versão?",
      options: [
        "Busca rápida + filtros por categoria",
        "Exportar/importar em JSON + estatísticas",
        "Layout ultra enxuto só com o essencial"
      ],
      allowCustom: true,
      recommended: "Busca rápida + filtros por categoria"
    },
    {
      id: "q_data",
      category: "data",
      question: "Quer começar com alguns exemplos preenchidos ou totalmente vazio?",
      options: [
        "Começar com 4–5 exemplos realistas (fácil de testar)",
        "Começar totalmente limpo (zero itens iniciais)"
      ],
      allowCustom: true,
      recommended: "Começar com 4–5 exemplos realistas (fácil de testar)"
    }
  ];

  if (!isApi) {
    questions.push(buildVisualStyleQuestion(input.designSystems));
  }

  return questions.slice(0, MAX_GRILL_QUESTIONS);
}

/**
 * Faz parsing resiliente do JSON retornado pelo LLM, impondo teto de 10 perguntas
 * e garantindo a presença de 1 pergunta visual quando não for API pura.
 */
export function parseGrillQuestionsJson(
  rawText: string,
  input: GrillMeGenerationInput
): GrillQuestion[] {
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

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { questions?: unknown };
      if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.questions)) {
        continue;
      }

      const seenQuestions = new Set<string>();
      const out: GrillQuestion[] = [];

      for (let i = 0; i < parsed.questions.length && out.length < MAX_GRILL_QUESTIONS; i++) {
        const rawItem = parsed.questions[i];
        if (!rawItem || typeof rawItem !== "object") continue;
        const item = rawItem as Record<string, unknown>;
        const question = sanitizeShortText(item.question, 180);
        if (question.length < 8) continue;
        const qKey = question.toLowerCase();
        if (seenQuestions.has(qKey)) continue;
        seenQuestions.add(qKey);

        const rawOpts = Array.isArray(item.options) ? item.options : [];
        let options = Array.from(
          new Set(
            rawOpts
              .map((o) => sanitizeShortText(o, 90))
              .filter((o) => o.length >= 2)
          )
        ).slice(0, 5);
        if (options.length < 2) {
          options = ["Sim (recomendado)", "Não / manter simples"];
        }

        const rawRec = sanitizeShortText(item.recommended, 90);
        const recIdx = rawRec
          ? options.findIndex((o) => o.toLowerCase() === rawRec.toLowerCase())
          : -1;
        // Garante sempre a opção recomendada em 1º lugar (options[0])
        if (recIdx > 0) {
          const [picked] = options.splice(recIdx, 1);
          if (picked) options.unshift(picked);
        }
        const recommended = options[0];
        const id = sanitizeShortText(item.id, 24).replace(/[^a-zA-Z0-9_-]/g, "") || `q${out.length + 1}`;
        const normalizedCat = normalizeCategory(item.category);

        out.push({
          id,
          category: input.mode === "general" && normalizedCat === "visual" ? "ux" : normalizedCat,
          question,
          options,
          allowCustom: true,
          ...(recommended ? { recommended } : {})
        });
      }

      if (out.length >= 2) {
        const needsVisual = input.mode !== "general" && input.appKind !== "api";
        if (needsVisual && !out.some((q) => q.category === "visual")) {
          if (out.length >= MAX_GRILL_QUESTIONS) {
            out[out.length - 1] = buildVisualStyleQuestion(input.designSystems);
          } else {
            out.push(buildVisualStyleQuestion(input.designSystems));
          }
        }
        return out.slice(0, MAX_GRILL_QUESTIONS);
      }
    } catch {
      // Tenta próximo candidato
    }
  }

  return buildFallbackGrillQuestions(input);
}

/**
 * Gera de 3 a 10 perguntas objetivas em 1 única chamada ultrarrápida.
 * Prioriza Groq (~0,6s, 900 req/dia) -> NVIDIA NIM -> Gemini -> OpenRouter
 * para NÃO sobrecarregar o Gemini nem o OpenRouter!
 */
export async function generateBriefingGrillQuestions(
  input: GrillMeGenerationInput
): Promise<GrillMeGenerationResult> {
  initProviders();
  const statuses = await getProvidersStatus();

  const priority: AutoPlatform[] = ["groq", "nvidia", "gemini", "openrouter"];
  const catalogHint =
    Array.isArray(input.designSystems) && input.designSystems.length > 0
      ? input.designSystems
          .slice(0, 10)
          .map((d) => `${d.name} (${d.theme}; tags: ${d.tags.slice(0, 4).join(", ")})`)
          .join("; ")
      : "dark minimalista, verde escuro, violeta tech, claro minimalista";

  const isGeneral = input.mode === "general";
  const systemPrompt = isGeneral ? GRILL_GENERAL_SYSTEM_PROMPT : GRILL_APP_SYSTEM_PROMPT;
  const userPrompt = isGeneral
    ? [
        `Pedido amplo do usuário: "${sanitizeShortText(input.prompt, 700)}"`,
        "",
        "Gere apenas as 3 a 5 perguntas mais decisivas (máx. 10) colocando a opção recomendada em primeiro. Retorne SOMENTE o JSON."
      ].join("\n")
    : [
        `Ideia inicial do usuário: "${sanitizeShortText(input.prompt, 700)}"`,
        `Tipo provável: ${input.appKind ?? "web_app"} | Tema sugerido: ${input.theme ?? "dark"}`,
        `Estilos visuais disponíveis no catálogo local: ${catalogHint}`,
        "",
        "Gere apenas as perguntas que realmente fazem diferença (entre 3 e 6; máx. 10), com a opção recomendada em primeiro. Retorne SOMENTE o JSON."
      ].join("\n");

  for (const plat of priority) {
    const st = statuses.find((s) => s.id === plat);
    const provider = getProvider(plat);
    if (!st?.ready || !provider) continue;

    // Pula se cota diária estiver muito baixa (< 15%)
    const usage = st.usage;
    if (usage && usage.requestsDailyCap > 0) {
      const ratio = (usage.requestsDailyCap - usage.requestsToday) / usage.requestsDailyCap;
      if (ratio < 0.15) continue;
    }

    try {
      const res = await provider.generate({
        system: systemPrompt,
        user: userPrompt,
        maxTokens: 1_100,
        onDelta: () => {}
      });
      const questions = parseGrillQuestionsJson(res.text, input);
      return {
        questions,
        provider: plat,
        model: res.model
      };
    } catch {
      // Tenta próximo provedor saudável
    }
  }

  return {
    questions: buildFallbackGrillQuestions(input),
    provider: "local_fallback",
    model: "local-heuristics"
  };
}
