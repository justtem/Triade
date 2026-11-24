import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { validateSubfolderName } from "./folder-picker.js";
import { inspectLinkedFolder } from "./project-rag.js";
import type { GrillAnswer } from "./app-grill-me.js";
import type { DesignSystemEntry } from "./design-systems.js";
import type { LandingArchetypeEntry } from "./landing-archetypes.js";

export type AppBriefingKind = "web_app" | "api" | "landing";
export type AppBriefingTheme = "dark" | "light";

export interface SecurityProfileDetection {
  baseOwasp: true;
  financial: boolean;
  lgpd: boolean;
  financialMatches: string[];
  lgpdMatches: string[];
  suppressedAsGame: boolean;
}

export interface AppBriefingAnalysis {
  isNewAppIdea: boolean;
  suggestedName: string;
  baseDir: string;
  folderPath: string;
  appKind: AppBriefingKind;
  theme: AppBriefingTheme;
  port: number;
  security: SecurityProfileDetection;
}

export interface ExpandAppBriefingInput {
  rawIdea: string;
  appName: string;
  appKind: AppBriefingKind;
  theme: AppBriefingTheme;
  port?: number;
  security: {
    financial: boolean;
    lgpd: boolean;
  };
  designSystem?: DesignSystemEntry | null;
  landingArchetype?: LandingArchetypeEntry | null;
  grillAnswers?: GrillAnswer[];
}

export interface ExpandedAppBriefingSpec {
  projectInstructions: string;
  expandedPrompt: string;
  description: string;
  color: "iris" | "sky" | "saffron" | "rose";
  port: number;
}

function normalizeText(raw: string): string {
  return String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const NEGATIVE_GUARD_RE =
  /\b(nao\s+(?:mexa|altere|modifique|escreva|crie|grave|mude|aplique|edite|faca\s+nada)|so\s+(?:explique|compare|analise|mostre|responda|converse|planeje|diga|ideias?)|apenas\s+(?:explique|compare|analise|mostre|responda|planeje|diga|ideias?)|somente\s+(?:explique|leitura|compare|analise)|antes\s+de\s+(?:implementar|alterar|mexer|codar|escrever)|sem\s+(?:modificar|alterar|criar\s+arquivos|escrever\s+na\s+pasta|mexer\s+no\s+codigo))\b/;

const EXPLAIN_START_RE =
  /^(?:me\s+)?(explique|explica|o\s+que\s+e|o\s+que\s+faz|como\s+funciona|por\s+que|porque|qual\s+(?:e\s+)?a\s+diferenca|compare|vale\s+a\s+pena|analise|resuma|me\s+diga|me\s+fale|liste|descreva|quais\s+sao)\b/;

const NEW_APP_VERB_RE =
  /\b(crie|cria|criar|faca|faz|fazer|monte|monta|montar|construa|constroi|construir|desenvolva|desenvolve|desenvolver|gere|gera|gerar|quero\s+(?:criar|fazer|montar|construir|um|uma)|preciso\s+de\s+(?:um|uma)|vamos\s+(?:criar|fazer|montar|construir))\b/;

const NEW_APP_TARGET_RE =
  /\b(app|aplicativo|aplicacao|site|web\s*app|webapp|sistema|painel|dashboard|pagina|landing\s*page|landing|portal|loja|ecommerce|e-commerce|calculadora|rastreador|gerenciador|controlador|controle\s+de|contador\s+de|agenda|agendamento|kanban|pomodoro|crm|pdv|estoque|catalogo|blog|portfolio|portifolio|api|backend|crud|ferramenta|plataforma|saas|projeto)\b/;

const GAME_OR_FICTION_GUARD_RE =
  /\b(jogo|game|rpg|pocao|pocoes|personagem|personagens|inimigo|inimigos|masmorra|dungeon|quiz|xadrez|tetris|snake|minigame|flappy|arcade|tabuleiro|cartas\s+de\s+jogo|guilda|espada)\b/;

const FINANCIAL_TERMS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(financeir[oa]s?|financas?)\b/, label: "financeiro" },
  { re: /\b(gastos?|despesas?|receitas?|orcamentos?)\b/, label: "gastos/orçamento" },
  { re: /\b(pagamentos?|pix|boletos?|faturas?|cobrancas?|mensalidades?|assinaturas?)\b/, label: "pagamentos" },
  { re: /\b(vendas?|pedidos?|carrinhos?|lojas?|ecommerce|e-commerce|pdv|caixas?)\b/, label: "loja/vendas" },
  { re: /\b(estoques?|carteiras?|saldos?|contas?\s+a\s+pagar|contas?\s+a\s+receber|investimentos?|fluxo\s+de\s+caixa)\b/, label: "caixa/estoque" }
];

const LGPD_TERMS: Array<{ re: RegExp; label: string }> = [
  { re: /\b(pacientes?|dentistas?|medicos?|clinicas?|consultas?|prontuarios?|saude)\b/, label: "saúde/pacientes" },
  { re: /\b(clientes?|crm|agendamentos?|agenda\s+de\s+(?:clientes|pacientes|contatos))\b/, label: "clientes/CRM" },
  { re: /\b(funcionarios?|colaboradores?|rh|folha\s+de\s+pagamento|alunos?|escolas?|matriculas?)\b/, label: "RH/alunos" },
  { re: /\b(cadastros?|login|autenticacao|senhas?|usuarios?|perfis?)\b/, label: "cadastro/login" },
  { re: /\b(cpfs?|cnpjs?|telefones?|enderecos?|emails?|dados?\s+pessoais?|lgpd|privacidade)\b/, label: "dados pessoais" }
];

const APP_STOPWORDS = new Set([
  "crie",
  "cria",
  "criar",
  "faca",
  "faz",
  "fazer",
  "monte",
  "monta",
  "montar",
  "construa",
  "constroi",
  "construir",
  "desenvolva",
  "gere",
  "gera",
  "quero",
  "preciso",
  "vamos",
  "um",
  "uma",
  "uns",
  "umas",
  "o",
  "a",
  "os",
  "as",
  "de",
  "da",
  "do",
  "das",
  "dos",
  "para",
  "pra",
  "com",
  "sem",
  "no",
  "na",
  "nos",
  "nas",
  "em",
  "por",
  "sobre",
  "que",
  "app",
  "aplicativo",
  "aplicacao",
  "site",
  "sistema",
  "projeto",
  "web",
  "simples",
  "completo",
  "completa",
  "moderno",
  "moderna",
  "bonito",
  "bonita",
  "funcional",
  "novo",
  "nova",
  "meu",
  "minha",
  "pessoal",
  "pessoais",
  "basico",
  "basica",
  "rapido",
  "rapida"
]);

export function detectNewAppIdea(prompt: string): boolean {
  const norm = normalizeText(prompt);
  if (!norm || norm.length < 8) return false;
  if (NEGATIVE_GUARD_RE.test(norm)) return false;
  if (EXPLAIN_START_RE.test(norm)) return false;
  return NEW_APP_VERB_RE.test(norm) && NEW_APP_TARGET_RE.test(norm);
}

export function detectSecurityProfiles(prompt: string): SecurityProfileDetection {
  const norm = normalizeText(prompt);
  const suppressedAsGame = GAME_OR_FICTION_GUARD_RE.test(norm);

  if (suppressedAsGame) {
    return {
      baseOwasp: true,
      financial: false,
      lgpd: false,
      financialMatches: [],
      lgpdMatches: [],
      suppressedAsGame: true
    };
  }

  const financialMatches: string[] = [];
  for (const item of FINANCIAL_TERMS) {
    if (item.re.test(norm)) {
      financialMatches.push(item.label);
    }
  }

  const lgpdMatches: string[] = [];
  for (const item of LGPD_TERMS) {
    if (item.re.test(norm)) {
      lgpdMatches.push(item.label);
    }
  }

  return {
    baseOwasp: true,
    financial: financialMatches.length > 0,
    lgpd: lgpdMatches.length > 0,
    financialMatches: Array.from(new Set(financialMatches)),
    lgpdMatches: Array.from(new Set(lgpdMatches)),
    suppressedAsGame: false
  };
}

export function inferAppKindFromPrompt(prompt: string): AppBriefingKind {
  const norm = normalizeText(prompt);
  if (
    /\b(landing\s*page|landing|pagina\s+de\s+(?:vendas|captura|lancamento|conversao)|captura\s+de\s+leads?|pagina\s+institucional|site\s+institucional|site\s+(?:para|de)\s+(?:meu\s+)?(?:negocio|clinica|loja|restaurante|cafeteria|barbearia|escritorio|consultorio|academia|empresa|servicos?)|negocio\s+local|portfolio|portifolio)\b/.test(
      norm
    )
  ) {
    return "landing";
  }
  if (
    /\b(apenas\s+api|so\s+api|somente\s+api|api\s+rest|backend\s+puro|micros?servico)\b/.test(norm) &&
    !/\b(interface|tela|frontend|site|painel|dashboard|pagina)\b/.test(norm)
  ) {
    return "api";
  }
  return "web_app";
}

export function inferThemeFromPrompt(prompt: string): AppBriefingTheme {
  const norm = normalizeText(prompt);
  if (/\b(tema\s+claro|modo\s+claro|visual\s+claro|fundo\s+branco|claro\s+minimalista|light\s+mode)\b/.test(norm)) {
    return "light";
  }
  return "dark";
}

export function suggestAppNameFromPrompt(prompt: string): string {
  // 1. Se o usuário já deu um nome próprio após "chamado X" ou "nome X"
  const explicitMatch = prompt.match(
    /\b(?:chamado|chamada|nomeado|nome)\s+["'`]?([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9_-]{2,28})["'`]?/i
  );
  if (explicitMatch?.[1]) {
    const cleanExplicit = explicitMatch[1]
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9_-]/g, "");
    if (cleanExplicit.length >= 2 && validateSubfolderName(cleanExplicit).valid) {
      return cleanExplicit;
    }
  }

  const norm = normalizeText(prompt);
  const words = norm
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !APP_STOPWORDS.has(w) && !/^\d+$/.test(w));

  const picked = words.slice(0, 3);
  if (picked.length === 0) {
    return "MeuApp";
  }

  const pascal = picked
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("")
    .slice(0, 32);

  return validateSubfolderName(pascal).valid ? pascal : "MeuApp";
}

function deriveSuggestedPort(appName: string): number {
  let hash = 0;
  for (let i = 0; i < appName.length; i++) {
    hash = (hash * 31 + appName.charCodeAt(i)) % 400;
  }
  // Evita 4317 (porta do AI Council) -> faixa limpa 4100..4299
  return 4100 + (hash % 200);
}

export async function resolveDefaultProjectsBaseDir(
  preferredBaseDir?: string
): Promise<string> {
  const candidates: string[] = [];
  if (preferredBaseDir && isAbsolute(preferredBaseDir.trim())) {
    candidates.push(preferredBaseDir.trim());
  }
  const home = homedir();
  candidates.push(join(home, "Desktop"));
  candidates.push(join(home, "Documents"));
  candidates.push(home);

  for (const candidate of candidates) {
    try {
      const st = await stat(candidate);
      if (!st.isDirectory()) continue;
      const insp = await inspectLinkedFolder(candidate);
      if (insp.valid) {
        return resolve(candidate);
      }
    } catch {
      // Tenta próximo candidato
    }
  }

  return resolve(home);
}

export async function analyzeAppBriefing(
  prompt: string,
  options: { baseDir?: string } = {}
): Promise<AppBriefingAnalysis> {
  const isNewAppIdea = detectNewAppIdea(prompt);
  const suggestedName = suggestAppNameFromPrompt(prompt);
  const baseDir = await resolveDefaultProjectsBaseDir(options.baseDir);
  const folderPath = join(baseDir, suggestedName);
  const appKind = inferAppKindFromPrompt(prompt);
  const theme = inferThemeFromPrompt(prompt);
  const security = detectSecurityProfiles(prompt);
  const port = deriveSuggestedPort(suggestedName);

  return {
    isNewAppIdea,
    suggestedName,
    baseDir,
    folderPath,
    appKind,
    theme,
    port,
    security
  };
}

/**
 * Expande uma ideia simples em 1 frase num blueprint técnico completo, enxuto,
 * 100% nativo em Node.js + TypeScript, com boas práticas OWASP + Financeiro/LGPD
 * proporcionais ao contexto (Regra dos 4 itens — sem over-engineering).
 */
export function expandAppBriefingToSpec(
  input: ExpandAppBriefingInput
): ExpandedAppBriefingSpec {
  const cleanName = input.appName.trim() || "MeuApp";
  const slug = cleanName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "meu-app";
  const envDataVar = `${slug.replace(/-/g, "_").toUpperCase()}_DATA_FILE`;
  const port =
    typeof input.port === "number" && input.port >= 3000 && input.port <= 65000
      ? Math.floor(input.port)
      : deriveSuggestedPort(cleanName);

  const financial = Boolean(input.security?.financial);
  const lgpd = Boolean(input.security?.lgpd);

  const baseRules = [
    'Stack obrigatória: Node.js 20+ com TypeScript ESM ("type": "module"), ZERO dependências externas em runtime (use apenas módulos nativos node:http, node:fs/promises, node:path, node:crypto).',
    "DevDependencies permitidas APENAS: typescript, tsx e @types/node. Proibido instalar express, bcrypt, jsonwebtoken, prisma ou bibliotecas pesadas.",
    'Scripts obrigatórios no package.json: "dev": "tsx src/index.ts", "build": "tsc", "test": "node --test --import tsx tests/*.test.ts".',
    "Segurança Base (OWASP): valide toda entrada no servidor (HTTP 400 em payload inválido), bloqueie path traversal ao servir public/, envie headers X-Content-Type-Options: nosniff e X-Frame-Options: DENY, faça bind estrito em 127.0.0.1 e nunca use innerHTML com dados do usuário (use textContent).",
    "Nos testes HTTP, sempre use diretório temporário isolado e encerre com server.closeAllConnections?.() e server.close() no finally.",
    "Sempre entregue cada arquivo 100% completo com o caminho exato no cabeçalho (ex.: ### `src/server.ts`), sem abreviações."
  ];

  const extraRules: string[] = [];
  if (financial) {
    extraRules.push(
      "Boas Práticas Financeiras (4 regras nativas): (1) armazene e calcule valores monetários em centavos inteiros (amountCents: number) para evitar erro de ponto flutuante; (2) rejeite com HTTP 400 valores <= 0, NaN ou não-inteiros; (3) suporte header opcional Idempotency-Key nas criações financeiras (replay do mesmo payload retorna o registro original; payload divergente retorna HTTP 409); (4) inclua testes automatizados cobrindo valor inválido (400) e conflito de idempotência (409)."
    );
  }
  if (lgpd) {
    extraRules.push(
      "Boas Práticas de Privacidade / LGPD (4 regras nativas): (1) minimização de dados (colete apenas campos essenciais) e mascaramento de dados sensíveis em listagens/logs (ex.: CPF/email parcialmente mascarado; nunca imprima dados pessoais ou senhas em console.log); (2) se houver login/senha, use exclusivamente node:crypto scryptSync + salt aleatório + timingSafeEqual (nunca texto puro ou md5); (3) disponibilize endpoint/botão de Exportar dados em JSON (portabilidade) e Excluir registro definitivamente; (4) inclua testes provando que dados sensíveis não vazam e que a exclusão funciona."
    );
  }

  const activeLandingArchetype =
    input.appKind === "landing" && input.landingArchetype ? input.landingArchetype : null;
  const activeDesignSystem =
    input.appKind !== "api" && !activeLandingArchetype && input.designSystem
      ? input.designSystem
      : null;

  if (activeLandingArchetype) {
    extraRules.push(
      `Arquétipo de Landing Page ("${activeLandingArchetype.name}" — tema ${activeLandingArchetype.theme}): preserve exatamente a hierarquia tipográfica, paleta :root, ritmo de seções, placeholders de imagem numerados (data-image-slot="1", "2", "3") e conversão dupla (WhatsApp + Formulário de Leads). Zero links de imagem externos quebrados e zero CDN.`
    );
  } else if (activeDesignSystem) {
    extraRules.push(
      `Identidade Visual (Design System "${activeDesignSystem.name}" — ${activeDesignSystem.theme}, destaque ${activeDesignSystem.accentHex}, fundo ${activeDesignSystem.backgroundHex}): preserve exatamente esta paleta, tipografia com fallback nativo (zero CDN) e estilo de superfícies em todas as edições futuras; nunca copie marcas ou textos de exemplo da referência.`
    );
  }

  const projectInstructions = [...baseRules, ...extraRules].join("\n");

  const themeInstruction = activeLandingArchetype
    ? `Siga rigorosamente o Arquétipo de Landing Page "${activeLandingArchetype.name}" detalhado abaixo (use exatamente os tokens :root, tipografia e ritmo de seções dele em public/style.css, com zero CDN externa).`
    : activeDesignSystem
      ? `Siga o Design System "${activeDesignSystem.name}" detalhado abaixo (use os tokens :root dele em public/style.css, com zero CDN externa).`
      : input.theme === "light"
        ? "Tema visual claro minimalista (fundo claro limpo, alto contraste, tipografia nítida, bordas finas sólidas, responsivo, zero CDN externa)."
        : "Tema visual escuro moderno (fundo escuro limpo, alto contraste, tipografia nítida, bordas finas sólidas, responsivo, zero CDN externa).";

  const kindBlock =
    input.appKind === "api"
      ? [
          `3. src/server.ts: exporta createApp() retornando o http.Server com endpoints REST completos em JSON para a ideia abaixo, incluindo GET /health e validação rigorosa (400/404).`,
          `4. src/index.ts: sobe o servidor em 127.0.0.1 na porta process.env.PORT || ${port} e imprime a URL pronta no terminal.`
        ]
      : input.appKind === "landing"
        ? [
            `3. src/server.ts: exporta createApp() servindo public/index.html, public/style.css, public/app.js e a subpasta public/assets/* (suportando .svg, .png, .jpg, .webp, .gif com Content-Type correto e anti-path-traversal resolvendo via resolve(process.cwd(), "public")), mais API real de captura de leads: POST /api/leads (valida nome + contato/email/whatsapp, retorna 201 ou 400 em payload inválido, salva atomicamente em data/leads.json) e GET /api/leads (lista leads capturados localmente).`,
            `4. src/index.ts: sobe o servidor em 127.0.0.1 na porta process.env.PORT || ${port} e imprime a URL pronta no terminal.`,
            `5. public/index.html, public/style.css e public/app.js (ENTREGUE OS 3 ARQUIVOS 100% COMPLETOS, NUNCA TRUNCADOS): Landing Page Pro de nível agência pronta para publicar:`,
            `   - Copywriting real e persuasivo em português do Brasil (zero Lorem Ipsum); meta tags SEO/OpenGraph completas.`,
            `   - Conversão dupla obrigatória: (a) Botão de WhatsApp no Hero, seção final e botão flutuante discreto (configurável via const LANDING_CONFIG = { whatsappNumber: "5511999999999", whatsappMessage: "...", externalFormAction: "" } no topo de public/app.js) e (b) Formulário de Captura de Leads conectado a POST /api/leads localmente (ou externalFormAction como Formspree quando configurado), com feedback visual elegante e sem innerHTML inseguro.`,
            `   - Slots numerados de imagem (ZERO URLs externas de imagem): inclua 3 espaços visuais bem enquadrados usando <figure class="media-slot" data-slot-wrapper="1"><img src="/assets/slot-1.svg" data-image-slot="1" alt="..."><figcaption class="slot-badge" data-slot-placeholder="1">Espaço Imagem 1 · Envie no chat para trocar</figcaption></figure> (repita para slots 2 e 3 nas seções certas — o sistema gera automaticamente os SVG locais e substitui quando o usuário enviar fotos no chat).`,
            `   - Motion & interatividade 60fps: IntersectionObserver com reveal escalonado (respeitando prefers-reduced-motion), contadores numéricos animados, tabs/passos interativos (01/02/03 ou seletor de serviços/planos), FAQ acordeão suave e navbar sticky.`,
            `   - ${themeInstruction}`
          ]
        : [
            `3. src/server.ts: exporta createApp() retornando o http.Server com API REST completa em JSON (/api/...) + serviço seguro de arquivos estáticos da pasta public/ (/, /style.css, /app.js) resolvendo o diretório via resolve(process.cwd(), "public") (para funcionar tanto em src/ quanto compilado em dist/), com proteção anti-path-traversal e headers X-Content-Type-Options: nosniff e X-Frame-Options: DENY.`,
            `4. src/index.ts: sobe o servidor em 127.0.0.1 na porta process.env.PORT || ${port} e imprime a URL pronta no terminal.`,
            `5. public/index.html, public/style.css e public/app.js (ENTREGUE OS 3 ARQUIVOS 100% COMPLETOS, NUNCA TRUNCADOS): interface de produto acabado, interativa e responsiva ligada à API — inclua cabeçalho polido, faixa hero/resumo com cards KPI em destaque, barra de filtros estilizada, grid responsivo de cards ricos com badges/pills de status e ações, formulário bem diagramado em card próprio (ZERO inputs/selects/botões com estilo padrão cinza/branco do navegador; sem innerHTML com dados do usuário; inclua teste verificando GET / retornando HTTP 200 com text/html). ${themeInstruction}`
          ];

  const securityPromptLines: string[] = [];
  if (financial) {
    securityPromptLines.push(
      "- Proteção Financeira: use centavos inteiros (amountCents), formate em R$ apenas na exibição, rejeite valores <= 0 com 400 e suporte Idempotency-Key (replay + conflito 409)."
    );
  }
  if (lgpd) {
    securityPromptLines.push(
      "- Proteção de Privacidade (LGPD): minimize dados coletados, mascare identificadores sensíveis em listagens/logs (zero console.log de PII), adicione botão/endpoint Exportar JSON (portabilidade) e Excluir definitivamente."
    );
  }

  const readmeRequirement =
    financial || lgpd
      ? `7. README.md + .gitignore (ignorando node_modules/, dist/, data/ e .env): inclua uma seção honesta e curta separando "Boas práticas aplicadas neste protótipo local" e "Passos necessários antes de ir para produção pública (HTTPS/TLS, banco criptografado, autenticação/RBAC e avaliação jurídica da LGPD)".`
      : `7. .gitignore ignorando node_modules/, dist/, data/ e .env.`;

  const cleanGrillAnswers = (input.grillAnswers ?? [])
    .filter((a) => a && typeof a.answer === "string" && a.answer.trim().length > 0)
    .slice(0, 10)
    .map((a) => {
      const q = String(a.question || a.id || "Decisão").replace(/[\r\n]+/g, " ").trim().slice(0, 140);
      const ans = a.answer.replace(/[\r\n]+/g, " ").trim().slice(0, 220);
      return `- ${q} → ${ans}`;
    });

  const expandedPrompt = [
    `Crie na pasta o projeto completo e funcional "${cleanName}" pronto para rodar com \`npm run dev\` em http://127.0.0.1:${port} (ou process.env.PORT).`,
    "",
    `Ideia solicitada pelo usuário:\n"${input.rawIdea.trim()}"`,
    ...(cleanGrillAnswers.length > 0
      ? ["", "Decisões refinadas pelo usuário (Grill-me — siga todas):", ...cleanGrillAnswers]
      : []),
    "",
    "Arquitetura e entregáveis obrigatórios:",
    `1. package.json ("type": "module", scripts dev/build/test, apenas devDependencies typescript, tsx, @types/node) e tsconfig.json (rootDir "./src", outDir "./dist", include ["src/**/*"], strict: true).`,
    `2. src/store.ts: persistência atômica em arquivo JSON (caminho configurável via process.env.${envDataVar}, padrão data/${slug}.json). Se o arquivo ainda não existir e o usuário não tiver pedido para começar vazio, semeie automaticamente 4 a 5 registros iniciais realistas para que a interface já abra preenchida e visualmente rica no primeiro acesso.`,
    ...kindBlock,
    `6. tests/app.test.ts: pelo menos 5 testes automatizados reais usando node:test + node:assert/strict em diretório temporário isolado, testando fluxo principal, validação 400, 404${financial ? ", valor inválido/idempotência 409" : ""}${lgpd ? ", mascaramento/portabilidade/exclusão" : ""} e fechando o servidor com server.closeAllConnections?.() e server.close() no finally.`,
    readmeRequirement,
    ...(securityPromptLines.length > 0
      ? ["", "Boas práticas reforçadas ativadas:", ...securityPromptLines]
      : []),
    ...(activeLandingArchetype
      ? ["", "---", activeLandingArchetype.compactPrompt]
      : activeDesignSystem
        ? ["", "---", activeDesignSystem.compactPromptBlock]
        : [])
  ].join("\n");

  const profileLabels = ["Base OWASP"];
  if (financial) profileLabels.push("Financeiro");
  if (lgpd) profileLabels.push("Privacidade (LGPD)");
  if (activeLandingArchetype) {
    profileLabels.push(`Landing: ${activeLandingArchetype.name}`);
  } else if (activeDesignSystem) {
    profileLabels.push(`Estilo: ${activeDesignSystem.name}`);
  }

  const description = `${input.rawIdea.trim().slice(0, 140)} · ${profileLabels.join(" + ")}`;
  const color: "iris" | "sky" | "saffron" | "rose" =
    financial && lgpd
      ? "rose"
      : financial
        ? "saffron"
        : lgpd
          ? "iris"
          : "sky";

  return {
    projectInstructions,
    expandedPrompt,
    description,
    color,
    port
  };
}
