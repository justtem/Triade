import type { InteractionMode } from "../shared/debate-types.js";

export type BuilderFolderPolicy = "auto" | "confirm" | "readonly";

export type BuilderIntentLevel =
  | "write_explicit"
  | "ambiguous"
  | "read_or_explore";

export interface BuilderIntentInput {
  prompt: string;
  hasLinkedFolder: boolean;
  isLocalPc: boolean;
  folderPolicy?: BuilderFolderPolicy;
  interactionMode: InteractionMode;
  participantCount: number;
}

export interface BuilderIntentDecision {
  level: BuilderIntentLevel;
  shouldActivateBuilder: boolean;
  shouldAutoApply: boolean;
  injectBuilderHint: boolean;
  reason: string;
}

function normalizePrompt(raw: string): string {
  return String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

const NEGATIVE_GUARD_RE =
  /\b(nao\s+(?:mexa|altere|modifique|escreva|crie|grave|mude|aplique|edite|faca\s+nada)|so\s+(?:explique|compare|analise|mostre|responda|converse|planeje|diga)|apenas\s+(?:explique|compare|analise|mostre|responda|planeje|diga|ideias?)|somente\s+(?:explique|leitura|compare|analise)|antes\s+de\s+(?:implementar|alterar|mexer|codar|escrever)|sem\s+(?:modificar|alterar|criar\s+arquivos|escrever\s+na\s+pasta|mexer\s+no\s+codigo))\b/;

const EXPLAIN_START_RE =
  /^(?:me\s+)?(explique|explica|o\s+que\s+e|o\s+que\s+faz|como\s+funciona|por\s+que|porque|qual\s+(?:e\s+)?a\s+diferenca|compare|vale\s+a\s+pena|analise|resuma|me\s+diga|me\s+fale|liste|descreva|quais\s+sao|entenda)\b/;

const EXPLICIT_ACTION_VERB_RE =
  /\b(crie|criar|gere|gerar|implemente|implementar|adicione|adicionar|coloque|colocar|ponha|insira|inserir|inclua|incluir|corrija|corrigir|arrume|arrumar|conserte|consertar|refatore|refatorar|monte|montar|construa|construir|configure|configurar|escreva|escrever|atualize|atualizar|altere|alterar|modifique|modificar|mude|mudar|troque|trocar|ajuste|ajustar|melhore|melhorar|remova|remover|exclua|excluir|tire|tirar|deixe|deixar|substitua|substituir|integre|integrar|desenvolva|desenvolver|reescreva|reescrever|instale|estruture|cria|gera|implementa|adiciona|coloca|inclui|corrige|arruma|conserta|refatora|monta|constroi|muda|troca|ajusta|melhora|remove|tira|deixa)\b/;

const CODE_OR_PROJECT_TARGET_RE =
  /\b(arquivo|arquivos|pasta|pastas|projeto|codigo|api|endpoint|endpoints|rota|rotas|servico|servicos|service|controller|teste|testes|banco|tabela|tabelas|schema|componente|componentes|pagina|paginas|tela|telas|modal|css|html|script|scripts|funcao|funcoes|classe|classes|modulo|modulos|middleware|bug|erro|erros|build|estrutura|backend|frontend|app|sistema|site|web|dashboard|painel|landing|portal|loja|calculadora|rastreador|gerenciador|controlador|agenda|repositorio|interface|ui|ux|layout|visual|estilo|estilos|tema|cor|cores|fonte|icone|icones|animacao|responsivo|botao|botoes|filtro|filtros|busca|pesquisa|campo|campos|input|formulario|form|card|cards|cartao|cartoes|lista|listas|cabecalho|header|rodape|footer|menu|barra|sidebar|aba|abas|badge|alerta|notificacao|toast|popover|tooltip|grafico|graficos|chart|contador|timer|relogio|calendario|kanban|atalho|atalhos|exportacao|exportar|importar|download|upload|backup|login|autenticacao|cadastro|perfil|usuario|usuarios|validacao|paginacao|ordenacao|cache|persistencia|metricas|estatisticas|funcionalidade|funcionalidades|recurso|recursos|feature|features|melhoria|melhorias|package\.json|tsconfig|index\.ts|src\/|tests\/|public\/)\b/;

const DIRECT_SHORT_BUILD_RE =
  /\b(corrija\s+(?:esse|o|os)\s+(?:erro|erros|bug|bugs|build|testes?)|arrume\s+(?:o\s+)?(?:build|erro|codigo|testes?)|crie\s+(?:os\s+)?testes|implemente\s+isso|aplique\s+(?:isso|na\s+pasta)|monte\s+a\s+estrutura|gere\s+os\s+arquivos)\b/;

const AMBIGUOUS_FEATURE_RE =
  /\b(precisamos\s+de|quero\s+(?:colocar|ter|adicionar|fazer)|seria\s+bom\s+ter|vamos\s+(?:colocar|adicionar|fazer|montar|criar)|estou\s+pensando\s+em\s+(?:criar|adicionar|implementar|usar))\b/;

const FOLLOWUP_EDIT_CLAUSE_RE =
  /\b(e\s+(?:crie|implemente|corrija|arrume|adicione|refatore|atualize|altere|gere\s+os\s+arquivos)|ja\s+(?:crie|implemente|corrija|altere|aplique))\b/;

export const AUTO_BUILDER_HINT_RULE =
  "Modo Construtor Automático ativo: entregue cada arquivo completo precedido pelo caminho relativo exato (ex.: ### `src/index.ts`), sem omitir código.";

export function normalizeFolderPolicy(raw: unknown): BuilderFolderPolicy {
  if (raw === "confirm" || raw === "readonly" || raw === "auto") {
    return raw;
  }
  return "auto";
}

/**
 * Classifica em 0ms (sem gastar tokens de IA) se uma mensagem dentro de um
 * Projeto com pasta vinculada deve acionar o Modo Construtor automaticamente,
 * preparar apenas o diff para confirmação ou apenas responder no chat.
 */
export function classifyBuilderIntent(
  input: BuilderIntentInput
): BuilderIntentDecision {
  const policy = normalizeFolderPolicy(input.folderPolicy);

  if (!input.hasLinkedFolder || !input.isLocalPc) {
    return {
      level: "read_or_explore",
      shouldActivateBuilder: false,
      shouldAutoApply: false,
      injectBuilderHint: false,
      reason: "Sem pasta local vinculada no PC."
    };
  }

  if (policy === "readonly") {
    return {
      level: "read_or_explore",
      shouldActivateBuilder: false,
      shouldAutoApply: false,
      injectBuilderHint: false,
      reason: "Pasta em modo somente leitura."
    };
  }

  const norm = normalizePrompt(input.prompt);
  if (!norm) {
    return {
      level: "read_or_explore",
      shouldActivateBuilder: false,
      shouldAutoApply: false,
      injectBuilderHint: false,
      reason: "Mensagem vazia."
    };
  }

  // 1. Trava negativa explícita sempre bloqueia escrita automática
  if (NEGATIVE_GUARD_RE.test(norm)) {
    return {
      level: "read_or_explore",
      shouldActivateBuilder: false,
      shouldAutoApply: false,
      injectBuilderHint: false,
      reason: "Pedido explícito para não alterar arquivos."
    };
  }

  const isCouncilParallel =
    input.interactionMode === "direct" && input.participantCount > 1;

  // 2. Pergunta/explicação/comparação pura (exceto se contiver cláusula clara "e corrija / e implemente")
  if (EXPLAIN_START_RE.test(norm) && !FOLLOWUP_EDIT_CLAUSE_RE.test(norm)) {
    return {
      level: "read_or_explore",
      shouldActivateBuilder: false,
      shouldAutoApply: false,
      injectBuilderHint: false,
      reason: "Pergunta explicativa ou comparativa."
    };
  }

  // 3. Pedido explícito de construção/edição no projeto
  const isExplicitWrite =
    DIRECT_SHORT_BUILD_RE.test(norm) ||
    (EXPLICIT_ACTION_VERB_RE.test(norm) && CODE_OR_PROJECT_TARGET_RE.test(norm));

  if (isExplicitWrite) {
    if (isCouncilParallel) {
      return {
        level: "write_explicit",
        shouldActivateBuilder: true,
        shouldAutoApply: false,
        injectBuilderHint: true,
        reason: "Modo Conselho (várias IAs em paralelo): prepara diff para você escolher qual aplicar."
      };
    }

    if (policy === "confirm") {
      return {
        level: "write_explicit",
        shouldActivateBuilder: true,
        shouldAutoApply: false,
        injectBuilderHint: true,
        reason: "Política da pasta configurada para confirmar diff antes de gravar."
      };
    }

    return {
      level: "write_explicit",
      shouldActivateBuilder: true,
      shouldAutoApply: true,
      injectBuilderHint: true,
      reason: "Pedido explícito de código em pasta vinculada (auto-aplicação ativa)."
    };
  }

  // 4. Zona cinzenta (fala em feature/código de forma declarativa/exploratória)
  if (AMBIGUOUS_FEATURE_RE.test(norm) && CODE_OR_PROJECT_TARGET_RE.test(norm)) {
    return {
      level: "ambiguous",
      shouldActivateBuilder: true,
      shouldAutoApply: false,
      injectBuilderHint: false,
      reason: "Intenção exploratória: prepara preview/diff sem gravar automaticamente."
    };
  }

  return {
    level: "read_or_explore",
    shouldActivateBuilder: false,
    shouldAutoApply: false,
    injectBuilderHint: false,
    reason: "Conversa geral sem pedido de edição na pasta."
  };
}
