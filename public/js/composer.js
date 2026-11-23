import {
  PLATFORMS,
  AUTO_PLATFORM_IDS,
  ALL_PLATFORM_IDS,
  SVG_ICONS,
  COMPOSER_MODE_STORAGE_KEY,
  COMPOSER_MODE_LABELS,
  RESPONSE_MODE_STORAGE_KEY,
  INTERACTION_MODE_STORAGE_KEY,
  AUTO_VERDICT_STORAGE_KEY,
  SINGLE_AI_STORAGE_KEY,
  AUTO_ROUTE_STORAGE_KEY,
  $,
  $$,
  saveStoredOption,
  state,
  localTaskStartMs,
  debateDetailsById,
  getSessionTurns,
  getActiveOrSelectedDebate,
  upsertDebateSessionLocally,
  uiHooks
} from "./state.js";
import { fetchJson, loadPromptTemplates, refreshDashboard } from "./api.js";
import { escapeHtml } from "./markdown.js";
import { openImageLightbox } from "./motion.js";
import { updateRightAiPanel } from "./telemetry.js";
import {
  openImageRedactModal,
  promptPrivacyShieldDecision,
  redactImageAttachmentsWithBoxes
} from "./user-memory.js";
import {
  closeAppBriefingCard,
  looksLikeNewAppIdeaClient,
  openAppBriefingForPrompt
} from "./briefing.js";

let bypassBriefingOnce = false;

export function getSelectedParticipants() {
  return $$('input[name="participants"]:checked').map((cb) => cb.value);
}

export function getActiveResponderInfo() {
  if (state.isAutoRouteMode) {
    return {
      key: "auto",
      shortLabel: "Auto",
      fullLabel: "Auto (Roteador Inteligente)",
      isSingle: false,
      isTrio: false,
      isAuto: true
    };
  }

  const selected = getSelectedParticipants();
  const isTrio =
    selected.length === AUTO_PLATFORM_IDS.length &&
    AUTO_PLATFORM_IDS.every((id) => selected.includes(id));

  if (selected.length === 1) {
    const id = selected[0];
    return {
      key: id,
      shortLabel: PLATFORMS[id] || id,
      fullLabel: PLATFORMS[id] || id,
      isSingle: true,
      isTrio: false,
      isAuto: false
    };
  }

  if (isTrio) {
    return {
      key: "trio",
      shortLabel: "Trio",
      fullLabel: "Trio (Gemini, Groq, OpenRouter)",
      isSingle: false,
      isTrio: true,
      isAuto: false
    };
  }

  return {
    key: "custom",
    shortLabel: `${selected.length} IAs`,
    fullLabel: selected.map((id) => PLATFORMS[id] || id).join(", ") || "Conselho",
    isSingle: false,
    isTrio: false,
    isAuto: false
  };
}

export function syncAiSelectionUi() {
  const checkedValues = getSelectedParticipants();
  const isAuto = Boolean(state.isAutoRouteMode);
  const isSingle = !isAuto && (state.isSingleAiMode || checkedValues.length === 1);
  const isTrio =
    !isAuto &&
    !state.isSingleAiMode &&
    checkedValues.length === AUTO_PLATFORM_IDS.length &&
    AUTO_PLATFORM_IDS.every((id) => checkedValues.includes(id));

  for (const pillsGroup of $$(".participant-pills")) {
    pillsGroup.classList.toggle("is-single-mode", !isAuto && state.isSingleAiMode);
    pillsGroup.classList.toggle("is-auto-mode", isAuto);
  }

  for (const cb of $$('input[name="participants"]')) {
    cb.closest(".participant-pill")?.classList.toggle("is-selected", !isAuto && cb.checked);
  }

  for (const btn of $$("#ai-preset-toggle .mode-seg-btn")) {
    const preset = btn.getAttribute("data-ai-preset");
    const active =
      (preset === "auto" && isAuto) ||
      (preset === "single" && isSingle) ||
      (preset === "trio" && isTrio);
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
  }

  const activeSingleKey =
    checkedValues.length === 1
      ? checkedValues[0]
      : AUTO_PLATFORM_IDS.includes(state.preferredSingleAi)
        ? state.preferredSingleAi
        : "gemini";

  for (const chip of $$("#composer-quick-ai-picker .quick-ai-chip")) {
    const platKey = chip.getAttribute("data-quick-ai");
    const active = !isAuto && platKey === activeSingleKey;
    chip.classList.toggle("is-active", active);
    chip.setAttribute("aria-pressed", String(active));
  }

  const hasManualChecked = checkedValues.some((id) => !AUTO_PLATFORM_IDS.includes(id));
  const manualDetails = $("#composer-manual-ais-details");
  if (manualDetails && hasManualChecked) {
    manualDetails.open = true;
  }
}

const CLIENT_NEG_GUARD_RE =
  /\b(nao\s+(?:mexa|altere|modifique|escreva|crie|grave|mude|aplique|edite|faca\s+nada)|so\s+(?:explique|compare|analise|mostre|responda|converse|planeje|diga)|apenas\s+(?:explique|compare|analise|mostre|responda|planeje|diga|ideias?)|somente\s+(?:explique|leitura|compare|analise)|antes\s+de\s+(?:implementar|alterar|mexer|codar|escrever)|sem\s+(?:modificar|alterar|criar\s+arquivos|escrever\s+na\s+pasta|mexer\s+no\s+codigo))\b/;

const CLIENT_EXPLAIN_START_RE =
  /^(?:me\s+)?(explique|explica|o\s+que\s+e|o\s+que\s+faz|como\s+funciona|por\s+que|porque|qual\s+(?:e\s+)?a\s+diferenca|compare|vale\s+a\s+pena|analise|resuma|me\s+diga|me\s+fale|liste|descreva|quais\s+sao|entenda)\b/;

const CLIENT_ACTION_VERB_RE =
  /\b(crie|criar|gere|gerar|implemente|implementar|adicione|adicionar|coloque|colocar|ponha|insira|inserir|inclua|incluir|corrija|corrigir|arrume|arrumar|conserte|consertar|refatore|refatorar|monte|montar|construa|construir|configure|configurar|escreva|escrever|atualize|atualizar|altere|alterar|modifique|modificar|mude|mudar|troque|trocar|ajuste|ajustar|melhore|melhorar|remova|remover|exclua|excluir|tire|tirar|deixe|deixar|substitua|substituir|integre|integrar|desenvolva|desenvolver|reescreva|reescrever|instale|estruture|cria|gera|implementa|adiciona|coloca|inclui|corrige|arruma|conserta|refatora|monta|constroi|muda|troca|ajusta|melhora|remove|tira|deixa)\b/;

const CLIENT_CODE_TARGET_RE =
  /\b(arquivo|arquivos|pasta|pastas|projeto|codigo|api|endpoint|endpoints|rota|rotas|servico|servicos|service|controller|teste|testes|banco|tabela|tabelas|schema|componente|componentes|pagina|paginas|tela|telas|modal|css|html|script|scripts|funcao|funcoes|classe|classes|modulo|modulos|middleware|bug|erro|erros|build|estrutura|backend|frontend|app|sistema|site|web|dashboard|painel|landing|portal|loja|calculadora|rastreador|gerenciador|controlador|agenda|repositorio|interface|ui|ux|layout|visual|estilo|estilos|tema|cor|cores|fonte|icone|icones|animacao|responsivo|botao|botoes|filtro|filtros|busca|pesquisa|campo|campos|input|formulario|form|card|cards|cartao|cartoes|lista|listas|cabecalho|header|rodape|footer|menu|barra|sidebar|aba|abas|badge|alerta|notificacao|toast|popover|tooltip|grafico|graficos|chart|contador|timer|relogio|calendario|kanban|atalho|atalhos|exportacao|exportar|importar|download|upload|backup|login|autenticacao|cadastro|perfil|usuario|usuarios|validacao|paginacao|ordenacao|cache|persistencia|metricas|estatisticas|funcionalidade|funcionalidades|recurso|recursos|feature|features|melhoria|melhorias|package\.json|tsconfig|index\.ts|src\/|tests\/|public\/)\b/;

const CLIENT_DIRECT_BUILD_RE =
  /\b(corrija\s+(?:esse|o|os)\s+(?:erro|erros|bug|bugs|build|testes?)|arrume\s+(?:o\s+)?(?:build|erro|codigo|testes?)|crie\s+(?:os\s+)?testes|implemente\s+isso|aplique\s+(?:isso|na\s+pasta)|monte\s+a\s+estrutura|gere\s+os\s+arquivos)\b/;

const CLIENT_FOLLOWUP_EDIT_RE =
  /\b(e\s+(?:crie|implemente|corrija|arrume|adicione|refatore|atualize|altere|gere\s+os\s+arquivos)|ja\s+(?:crie|implemente|corrija|altere|aplique))\b/;

function isDirectLocalBrowser() {
  const host = window.location?.hostname || "";
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function classifyClientFolderPrompt(rawText) {
  const norm = String(rawText || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!norm) return "read";
  if (CLIENT_NEG_GUARD_RE.test(norm)) return "read";
  if (CLIENT_EXPLAIN_START_RE.test(norm) && !CLIENT_FOLLOWUP_EDIT_RE.test(norm)) {
    return "read";
  }
  if (
    CLIENT_DIRECT_BUILD_RE.test(norm) ||
    (CLIENT_ACTION_VERB_RE.test(norm) && CLIENT_CODE_TARGET_RE.test(norm))
  ) {
    return "write_explicit";
  }
  return "read";
}

export function syncComposerSubmitIntentUi() {
  const activeDebate = getActiveOrSelectedDebate();
  const isContinuing = Boolean(activeDebate);
  const isRunningActive = Boolean(activeDebate && activeDebate.status === "running");
  const modeKey = state.activeComposerMode || deriveComposerModeFromState();
  const submitBtn = $("#composer-submit-btn");
  const submitSpan = $("#composer-submit-btn span:first-child");
  const submitArrow = $("#composer-submit-btn .cta-arrow");

  if (!submitBtn) return;

  if (isRunningActive) {
    submitBtn.classList.add("is-stop-mode");
    submitBtn.classList.remove("is-builder-intent");
    submitBtn.title = "Parar geração agora (mantém o texto já escrito)";
    submitBtn.disabled = false;
    if (submitSpan) submitSpan.textContent = "Parar";
    if (submitArrow) submitArrow.textContent = "■";
    return;
  }

  submitBtn.classList.remove("is-stop-mode");

  const linkedProj = uiHooks.getEffectiveProjectForComposer();
  const hasLocalFolder = Boolean(linkedProj?.linkedFolderPath) && isDirectLocalBrowser();
  const policyVal = state.folderPolicy || "auto";
  const isAutoComposer = modeKey === "auto" || Boolean(state.isAutoRouteMode);
  const isCouncilParallel =
    !isAutoComposer &&
    state.selectedInteractionMode === "direct" &&
    !state.isSingleAiMode &&
    getSelectedParticipants().length > 1;
  const typedText = $("#debate-topic")?.value || "";
  const clientIntent =
    hasLocalFolder && policyVal !== "readonly" && !isCouncilParallel
      ? classifyClientFolderPrompt(typedText)
      : "read";

  const willAutoBuild = clientIntent === "write_explicit" && policyVal === "auto";
  const willConfirmDiff = clientIntent === "write_explicit" && policyVal === "confirm";
  const willOpenBriefing =
    !isContinuing &&
    !hasLocalFolder &&
    isDirectLocalBrowser() &&
    (modeKey === "auto" || modeKey === "debate") &&
    looksLikeNewAppIdeaClient(typedText);

  submitBtn.classList.toggle(
    "is-builder-intent",
    willAutoBuild || willConfirmDiff || willOpenBriefing
  );

  if (willAutoBuild) {
    submitBtn.title = `Construtor automático: vai gerar arquivos, gravar em "${linkedProj.name}" (com backup) e rodar build/test`;
    if (submitSpan) submitSpan.textContent = "Construir na Pasta";
  } else if (willConfirmDiff) {
    submitBtn.title = `Vai gerar o preview/diff para você confirmar antes de gravar em "${linkedProj.name}"`;
    if (submitSpan) submitSpan.textContent = "Preparar Diff";
  } else if (willOpenBriefing) {
    submitBtn.title = "Abre o briefing rápido para criar a pasta, ativar boas práticas OWASP/LGPD e construir o app";
    if (submitSpan) submitSpan.textContent = "Preparar Novo App";
  } else {
    submitBtn.title = "Enviar mensagem";
    if (submitSpan) {
      submitSpan.textContent = isContinuing
        ? "Enviar"
        : modeKey === "debate"
          ? "Debater"
          : "Enviar";
    }
  }

  if (submitArrow) submitArrow.textContent = "→";
}

export function deriveComposerModeFromState() {
  if (state.isAutoRouteMode) return "auto";
  if (state.selectedInteractionMode === "debate") return "debate";
  if (state.isSingleAiMode || getSelectedParticipants().length === 1) {
    return "quick";
  }
  return "council";
}

export function applyComposerMode(modeKey, options = {}) {
  const validModes = ["auto", "quick", "council", "debate"];
  const nextMode = validModes.includes(modeKey) ? modeKey : "auto";
  state.activeComposerMode = nextMode;
  saveStoredOption(COMPOSER_MODE_STORAGE_KEY, nextMode);

  const roundsSelect = $("#debate-rounds");

  if (nextMode === "auto") {
    state.isAutoRouteMode = true;
    saveStoredOption(AUTO_ROUTE_STORAGE_KEY, "on");
    state.isSingleAiMode = false;
    state.selectedInteractionMode = "direct";
    state.selectedResponseMode = "normal";
    saveStoredOption(INTERACTION_MODE_STORAGE_KEY, "direct");
    saveStoredOption(RESPONSE_MODE_STORAGE_KEY, "normal");
    for (const cb of $$('input[name="participants"]')) {
      cb.checked = AUTO_PLATFORM_IDS.includes(cb.value);
    }
  } else if (nextMode === "quick") {
    state.isAutoRouteMode = false;
    saveStoredOption(AUTO_ROUTE_STORAGE_KEY, "off");
    const chosenAi =
      options.singleAi && ALL_PLATFORM_IDS.includes(options.singleAi)
        ? options.singleAi
        : AUTO_PLATFORM_IDS.includes(state.preferredSingleAi)
          ? state.preferredSingleAi
          : "gemini";
    state.preferredSingleAi = chosenAi;
    saveStoredOption(SINGLE_AI_STORAGE_KEY, chosenAi);
    state.isSingleAiMode = true;
    state.selectedInteractionMode = "direct";
    state.selectedResponseMode = "normal";
    state.selectedAutoVerdict = "off";
    saveStoredOption(INTERACTION_MODE_STORAGE_KEY, "direct");
    saveStoredOption(RESPONSE_MODE_STORAGE_KEY, "normal");
    saveStoredOption(AUTO_VERDICT_STORAGE_KEY, "off");
    for (const cb of $$('input[name="participants"]')) {
      cb.checked = cb.value === chosenAi;
    }
  } else if (nextMode === "council") {
    state.isAutoRouteMode = false;
    saveStoredOption(AUTO_ROUTE_STORAGE_KEY, "off");
    state.isSingleAiMode = false;
    state.selectedInteractionMode = "direct";
    state.selectedResponseMode = "normal";
    state.selectedAutoVerdict = "off";
    saveStoredOption(INTERACTION_MODE_STORAGE_KEY, "direct");
    saveStoredOption(RESPONSE_MODE_STORAGE_KEY, "normal");
    saveStoredOption(AUTO_VERDICT_STORAGE_KEY, "off");
    for (const cb of $$('input[name="participants"]')) {
      cb.checked = AUTO_PLATFORM_IDS.includes(cb.value);
    }
  } else if (nextMode === "debate") {
    state.isAutoRouteMode = false;
    saveStoredOption(AUTO_ROUTE_STORAGE_KEY, "off");
    state.isSingleAiMode = false;
    state.selectedInteractionMode = "debate";
    if (options.responseMode === "prompt_markdown" || options.responseMode === "normal") {
      state.selectedResponseMode = options.responseMode;
      saveStoredOption(RESPONSE_MODE_STORAGE_KEY, options.responseMode);
    }
    saveStoredOption(INTERACTION_MODE_STORAGE_KEY, "debate");
    if (roundsSelect && Number(roundsSelect.value) < 1) {
      roundsSelect.value = "2";
    }
    for (const cb of $$('input[name="participants"]')) {
      cb.checked = AUTO_PLATFORM_IDS.includes(cb.value);
    }
  }

  syncAiSelectionUi();
  syncComposerModeUi();
}

export function setAutoRouteMode(enabled = true) {
  const next = Boolean(enabled);
  state.isAutoRouteMode = next;
  saveStoredOption(AUTO_ROUTE_STORAGE_KEY, next ? "on" : "off");
  if (next) {
    state.isSingleAiMode = false;
    state.activeComposerMode = "auto";
    saveStoredOption(COMPOSER_MODE_STORAGE_KEY, "auto");
    for (const cb of $$('input[name="participants"]')) {
      cb.checked = AUTO_PLATFORM_IDS.includes(cb.value);
    }
  } else if (state.activeComposerMode === "auto") {
    const fallback = state.selectedInteractionMode === "debate" ? "debate" : "council";
    state.activeComposerMode = fallback;
    saveStoredOption(COMPOSER_MODE_STORAGE_KEY, fallback);
  }
  syncAiSelectionUi();
  syncComposerModeUi();
}

export function setSelectedParticipants(platformIds, options = {}) {
  const valid = Array.from(new Set((platformIds || []).filter((id) => ALL_PLATFORM_IDS.includes(id))));
  const targetIds = valid.length > 0 ? valid : [state.preferredSingleAi || "gemini"];
  const nextSingle =
    options.singleMode !== undefined
      ? Boolean(options.singleMode)
      : targetIds.length === 1;

  if (!options.preserveAuto) {
    state.isAutoRouteMode = false;
    saveStoredOption(AUTO_ROUTE_STORAGE_KEY, "off");
  }

  state.isSingleAiMode = nextSingle;
  const finalIds = nextSingle ? [targetIds[0]] : targetIds;

  if (nextSingle && finalIds[0]) {
    state.preferredSingleAi = finalIds[0];
    saveStoredOption(SINGLE_AI_STORAGE_KEY, state.preferredSingleAi);
    if (state.selectedInteractionMode !== "direct") {
      state.selectedInteractionMode = "direct";
      saveStoredOption(INTERACTION_MODE_STORAGE_KEY, "direct");
    }
    state.activeComposerMode = "quick";
    saveStoredOption(COMPOSER_MODE_STORAGE_KEY, "quick");
  } else if (state.activeComposerMode === "quick") {
    state.activeComposerMode = state.selectedInteractionMode === "debate" ? "debate" : "council";
    saveStoredOption(COMPOSER_MODE_STORAGE_KEY, state.activeComposerMode);
  }

  for (const cb of $$('input[name="participants"]')) {
    cb.checked = finalIds.includes(cb.value);
  }

  syncAiSelectionUi();
  syncComposerModeUi();
}

export function syncComposerWithDebate(debate) {
  if (!debate || !debate.id) return;
  if (state.lastSyncedComposerDebateId === debate.id) return;

  const turns = getSessionTurns(debate);
  const lastTurn = turns.at(-1);
  const participants =
    Array.isArray(lastTurn?.participants) && lastTurn.participants.length > 0
      ? lastTurn.participants
      : Array.isArray(debate.participants) && debate.participants.length > 0
        ? debate.participants
        : AUTO_PLATFORM_IDS;

  const respMode = lastTurn?.responseMode || debate.responseMode;
  if (respMode === "normal" || respMode === "prompt_markdown") {
    state.selectedResponseMode = respMode;
  }

  const interMode = lastTurn?.interactionMode || debate.interactionMode;
  if (interMode === "direct" || interMode === "debate") {
    state.selectedInteractionMode = interMode;
  }

  state.lastSyncedComposerDebateId = debate.id;
  if (lastTurn?.autoRoute) {
    state.activeComposerMode = "auto";
    setAutoRouteMode(true);
    return;
  }

  if (participants.length === 1) {
    state.activeComposerMode = "quick";
  } else if (interMode === "debate") {
    state.activeComposerMode = "debate";
  } else {
    state.activeComposerMode = "council";
  }

  setSelectedParticipants(participants, {
    singleMode: participants.length === 1
  });
}

export function syncComposerModeUi() {
  const modeKey = state.activeComposerMode || deriveComposerModeFromState();

  for (const btn of $$("#composer-mode-pills .composer-mode-btn")) {
    const key = btn.getAttribute("data-composer-mode");
    const active = key === modeKey;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
  }

  const quickPicker = $("#composer-quick-ai-picker");
  if (quickPicker) {
    quickPicker.hidden = modeKey !== "quick" || Boolean(state.isAutoRouteMode);
  }

  for (const btn of $$("#response-mode-toggle .mode-seg-btn")) {
    const mode = btn.getAttribute("data-response-mode");
    const active = mode === state.selectedResponseMode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
  }

  for (const btn of $$("#auto-verdict-toggle .mode-seg-btn")) {
    const val = btn.getAttribute("data-auto-verdict");
    const active = val === state.selectedAutoVerdict;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
  }

  const roundsWrap = $("#rounds-control-wrap");
  const focusWrap = $("#focus-control-wrap");
  const extraDivider = $("#composer-extra-divider");

  const showRounds = state.selectedInteractionMode === "debate";
  const showFocus = state.selectedResponseMode === "prompt_markdown";

  if (roundsWrap) roundsWrap.hidden = !showRounds;
  if (focusWrap) focusWrap.hidden = !showFocus;
  if (extraDivider) extraDivider.hidden = !showRounds && !showFocus;

  const webBtn = $("#composer-web-btn");
  if (webBtn) {
    const isWebAuto = state.selectedWebSearchMode !== "off";
    webBtn.classList.toggle("is-web-active", isWebAuto);
    webBtn.setAttribute("aria-pressed", String(isWebAuto));
    const span = webBtn.querySelector("span");
    if (span) {
      span.textContent = isWebAuto ? "Web" : "Web off";
    }
  }

  const activeDebate = getActiveOrSelectedDebate();
  const isContinuing = Boolean(activeDebate);
  const responder = getActiveResponderInfo();

  const summaryEl = $("#composer-config-summary");
  if (summaryEl) {
    const extras = [];
    if (state.isAutoRouteMode) extras.push("Auto");
    if (state.selectedResponseMode === "prompt_markdown") {
      extras.push("Prompt MD");
    }
    if (state.selectedAutoVerdict === "on") extras.push("Veredito");
    const checkedNow = getSelectedParticipants();
    if (checkedNow.some((id) => !AUTO_PLATFORM_IDS.includes(id))) {
      extras.push("Manual");
    }
    summaryEl.textContent = extras.length > 0 ? `Avançado · ${extras.join(" · ")}` : "Avançado";
  }

  syncComposerSubmitIntentUi();

  const topicInput = $("#debate-topic");
  if (topicInput) {
    const linkedProj = uiHooks.getEffectiveProjectForComposer();
    const hasFolder = Boolean(linkedProj?.linkedFolderPath) && isDirectLocalBrowser();
    if (isContinuing) {
      topicInput.placeholder = `Continuar (${COMPOSER_MODE_LABELS[modeKey] || responder.shortLabel})... (Enter envia · / templates)`;
    } else if (modeKey === "auto") {
      topicInput.placeholder = hasFolder
        ? `Descreva o que criar, corrigir ou perguntar em ${linkedProj.name} — o Auto escolhe tudo... (Enter envia)`
        : "Pergunte algo, compare ideias ou peça um app — o Auto escolhe o melhor modo... (Enter envia · / templates)";
    } else if (modeKey === "debate") {
      topicInput.placeholder = hasFolder
        ? `Peça para criar/corrigir código em ${linkedProj.name} ou debata uma ideia... (Enter envia)`
        : "Descreva o problema para as IAs debaterem e fecharem uma síntese... (Enter envia)";
    } else if (modeKey === "quick") {
      topicInput.placeholder = hasFolder
        ? `Pergunte ou peça edição rápida em ${linkedProj.name} com ${responder.shortLabel}... (Enter envia)`
        : `Pergunte direto ao ${responder.shortLabel}... (Enter envia · / templates)`;
    } else {
      topicInput.placeholder =
        "Compare 3 opiniões em paralelo no Conselho ou digite / para templates... (Enter envia)";
    }
  }

  syncAiSelectionUi();
  uiHooks.syncComposerProjectPill();
}

export function generateTitleFromTopic(topicText) {
  const clean = String(topicText || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "Debate em Consenso";
  if (clean.length <= 64) return clean;
  const sliced = clean.slice(0, 64);
  const lastSpace = sliced.lastIndexOf(" ");
  return `${(lastSpace > 24 ? sliced.slice(0, lastSpace) : sliced).trim()}...`;
}

export async function handleCreateDebate(event) {
  event.preventDefault();

  const titleInput = $("#debate-title");
  const topicInput = $("#debate-topic");
  const rulesInput = $("#debate-rules");
  const roundsSelect = $("#debate-rounds");
  const focusSelect = $("#debate-focus");
  const feedback = $("#debate-form-feedback");
  const submitBtn = $("#composer-submit-btn");

  const currentDebate = getActiveOrSelectedDebate();
  if (currentDebate && currentDebate.status === "running") {
    // Se o usuário clicou no botão "■ Parar" do composer, cancela imediatamente
    if (submitBtn && submitBtn.classList.contains("is-stop-mode") && event.submitter === submitBtn) {
      submitBtn.disabled = true;
      await uiHooks.handleStopDebate(currentDebate.id);
      submitBtn.disabled = false;
      return;
    }
    if (feedback) {
      feedback.textContent = "Aguarde a resposta atual ou clique em ■ Parar.";
    }
    return;
  }

  let topicValue = (topicInput?.value || "").trim();
  if (!topicValue && state.pendingAttachments.length > 0) {
    topicValue =
      state.pendingAttachments.length === 1
        ? `Analise o anexo enviado (${state.pendingAttachments[0].name}).`
        : `Analise os ${state.pendingAttachments.length} anexos enviados.`;
  }
  if (!topicValue) {
    if (feedback) {
      feedback.textContent = "Digite sua mensagem.";
    }
    topicInput?.focus();
    return;
  }

  // Briefing 1-frase: em conversa nova sem pasta vinculada no PC local,
  // intercepta ideias de novos apps para oferecer criação de pasta + Expansor OWASP/LGPD
  const shouldBypassBriefing = bypassBriefingOnce;
  bypassBriefingOnce = false;
  const effectiveProjectNow = uiHooks.getEffectiveProjectForComposer();
  const activeModeNow = state.activeComposerMode || deriveComposerModeFromState();
  if (
    !shouldBypassBriefing &&
    !currentDebate &&
    !effectiveProjectNow?.linkedFolderPath &&
    isDirectLocalBrowser() &&
    (activeModeNow === "auto" || activeModeNow === "debate") &&
    looksLikeNewAppIdeaClient(topicValue)
  ) {
    if (feedback) feedback.textContent = "";
    await openAppBriefingForPrompt(topicValue, {
      onBuildReady: ({ expandedPrompt, title }) => {
        applyComposerMode("auto");
        if (titleInput && title) titleInput.value = title;
        if (topicInput && expandedPrompt) {
          topicInput.value = expandedPrompt;
        }
        bypassBriefingOnce = true;
        $("#create-debate-form")?.requestSubmit();
      },
      onSendPlainChat: () => {
        bypassBriefingOnce = true;
        $("#create-debate-form")?.requestSubmit();
      }
    });
    return;
  }

  closeAppBriefingCard();

  const checkboxes = $$('input[name="participants"]:checked');
  const participants = state.isAutoRouteMode
    ? [...AUTO_PLATFORM_IDS]
    : checkboxes.map((cb) => cb.value);

  if (
    !state.isAutoRouteMode &&
    state.selectedInteractionMode === "debate" &&
    participants.length < 2
  ) {
    if (feedback) {
      feedback.textContent = "Debate exige ao menos 2 IAs.";
    }
    return;
  }

  if (!state.isAutoRouteMode && participants.length < 1) {
    if (feedback) {
      feedback.textContent = "Selecione ao menos 1 IA.";
    }
    return;
  }

  const rawTitle = (titleInput?.value || "").trim();
  const finalTitle = currentDebate
    ? currentDebate.title
    : rawTitle || generateTitleFromTopic(topicValue);

  const totalRounds =
    state.selectedInteractionMode === "direct" ? 1 : Number(roundsSelect?.value) || 2;
  const focus =
    state.selectedResponseMode === "prompt_markdown"
      ? focusSelect?.value || "geral"
      : "geral";
  const rules = (rulesInput?.value || "").trim();

  const attachmentsSnapshot = state.pendingAttachments.map((f) => ({ ...f }));

  state.optimisticSubmission = {
    parentDebateId: currentDebate ? currentDebate.id : null,
    title: finalTitle,
    topic: topicValue,
    participants,
    totalRounds,
    focus,
    rules,
    responseMode: state.selectedResponseMode,
    interactionMode: state.selectedInteractionMode,
    attachments: attachmentsSnapshot.map((f) => ({
      name: f.name,
      kind: f.kind || "text",
      mimeType: f.mimeType,
      dataBase64: f.kind === "image" ? f.dataBase64 : undefined,
      size: f.size
    })),
    startedAtMs: Date.now()
  };

  if (state.currentView !== "chat") {
    uiHooks.switchView("chat");
  }
  uiHooks.updateStageTopbar();
  uiHooks.renderChatStage();
  updateRightAiPanel();

  try {
    if (submitBtn) submitBtn.disabled = true;
    if (feedback) {
      feedback.textContent =
        state.selectedWebSearchMode === "auto"
          ? "Pesquisando & enviando..."
          : "Enviando...";
    }

    const routingMode = state.isAutoRouteMode ? "auto" : "manual";
    const autoSelectInteraction =
      state.activeComposerMode === "auto" && Boolean(state.isAutoRouteMode);
    const autoVerdict = state.selectedAutoVerdict === "on";
    const policyToSend = state.folderPolicy || "auto";

    let currentAttachments = attachmentsSnapshot;

    const sendRequest = (privacyAction) =>
      currentDebate
        ? fetchJson(`/debates/${currentDebate.id}/message`, {
            method: "POST",
            timeoutMs: 32000,
            body: {
              message: topicValue,
              rules: rules || undefined,
              participants,
              routingMode,
              autoSelectInteraction,
              autoVerdict,
              folderPolicy: policyToSend,
              totalRounds,
              focus,
              responseMode: state.selectedResponseMode,
              interactionMode: state.selectedInteractionMode,
              webSearchMode: state.selectedWebSearchMode,
              attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
              ...(privacyAction ? { privacyAction } : {})
            }
          })
        : fetchJson("/debates", {
            method: "POST",
            timeoutMs: 32000,
            body: {
              title: finalTitle,
              topic: topicValue,
              rules: rules || undefined,
              participants,
              routingMode,
              autoSelectInteraction,
              autoVerdict,
              folderPolicy: policyToSend,
              totalRounds,
              focus,
              responseMode: state.selectedResponseMode,
              interactionMode: state.selectedInteractionMode,
              webSearchMode: state.selectedWebSearchMode,
              projectId:
                state.activeNewChatProjectId ||
                state.selectedProjectFilterId ||
                undefined,
              attachments: currentAttachments.length > 0 ? currentAttachments : undefined,
              ...(privacyAction ? { privacyAction } : {})
            }
          });

    let result;
    try {
      result = await sendRequest(undefined);
    } catch (firstErr) {
      if (
        firstErr?.status === 409 &&
        firstErr?.data?.code === "PRIVACY_SHIELD_WARNING"
      ) {
        state.optimisticSubmission = null;
        uiHooks.renderChatStage();
        updateRightAiPanel();
        if (feedback) feedback.textContent = "";

        const imgFindings = Array.isArray(firstErr.data.imageFindings)
          ? firstErr.data.imageFindings
          : [];
        const decision = await promptPrivacyShieldDecision(
          firstErr.data.findings,
          imgFindings
        );
        if (decision === "cancel") {
          topicInput?.focus();
          return;
        }
        if (decision === "mask" && imgFindings.length > 0) {
          if (feedback) feedback.textContent = "Aplicando tarjas automáticas na imagem...";
          currentAttachments = await redactImageAttachmentsWithBoxes(
            currentAttachments,
            imgFindings
          );
          state.pendingAttachments = currentAttachments.map((f) => ({ ...f }));
          renderAttachmentsBar();
        }
        if (feedback) {
          feedback.textContent =
            decision === "mask"
              ? "Mascarando dados sensíveis e enviando..."
              : "Enviando...";
        }
        result = await sendRequest(decision);
      } else {
        throw firstErr;
      }
    }

    state.optimisticSubmission = null;
    state.pendingAttachments = [];
    renderAttachmentsBar();

    if (titleInput) titleInput.value = "";
    if (topicInput) {
      topicInput.value = "";
      topicInput.style.height = "auto";
    }

    if (result?.debate?.id) {
      state.selectedDebateId = result.debate.id;
      const activeTurnId = result.debate.turns?.at(-1)?.id;
      for (const t of result.debate.tasks || []) {
        if (t.status === "pending" && (!activeTurnId || t.turnId === activeTurnId)) {
          localTaskStartMs.set(t.id, Date.now());
        }
      }
      upsertDebateSessionLocally(result.debate);
    }

    if (feedback) {
      const shieldInfo = result?.privacyShield;
      const autoMasked =
        (Number(shieldInfo?.attachmentsMaskedCount) || 0) +
        (Number(shieldInfo?.projectMaskedCount) || 0);
      if (shieldInfo?.promptMasked || autoMasked > 0) {
        feedback.textContent =
          autoMasked > 0
            ? `Escudo de Privacidade protegeu ${autoMasked} dado(s) em anexos/projeto.`
            : "Escudo de Privacidade mascarou os dados sensíveis antes do envio.";
      } else {
        feedback.textContent = "";
      }
    }

    state.lastDebatesSignature = "";
    state.lastRenderedChatSignature = "";
    uiHooks.renderSidebarDebatesList();
    uiHooks.updateStageTopbar();
    uiHooks.renderChatStage();
    updateRightAiPanel();
    syncComposerModeUi();
    void refreshDashboard();
  } catch (error) {
    state.optimisticSubmission = null;
    uiHooks.renderChatStage();
    updateRightAiPanel();
    if (feedback) {
      feedback.textContent =
        error instanceof Error ? error.message : "Erro ao enviar.";
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function formatFileSizeShort(bytes) {
  const num = Number(bytes) || 0;
  if (num >= 1024 * 1024) {
    return `${(num / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${Math.max(1, Math.round(num / 1024))} KB`;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Falha ao ler arquivo."));
    reader.readAsDataURL(file);
  });
}

async function compressImageFile(file) {
  const MAX_DIM = 1600;
  const MAX_RAW_BASE64_BYTES = 2.4 * 1024 * 1024;
  const allowedMimes = ["image/png", "image/jpeg", "image/webp", "image/gif"];
  const originalMime = allowedMimes.includes(file.type) ? file.type : "image/jpeg";

  const dataUrl = await readFileAsDataUrl(file);
  // GIFs animados ou imagens pequenas (< 450 KB) não precisam re-encodar via canvas
  if (
    originalMime === "image/gif" ||
    (file.size <= 450 * 1024 && originalMime !== "image/jpeg")
  ) {
    const base64 = dataUrl.split(",")[1] || "";
    const byteSize = Math.floor((base64.length * 3) / 4);
    if (byteSize <= MAX_RAW_BASE64_BYTES) {
      return {
        name: file.name || `print-${Date.now()}.png`,
        kind: "image",
        mimeType: originalMime,
        dataBase64: base64,
        content: "",
        size: byteSize
      };
    }
  }

  // Redimensiona e comprime fotos grandes de câmera/print via <canvas>
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Imagem inválida."));
    el.src = dataUrl;
  });

  let width = img.naturalWidth || img.width || 1;
  let height = img.naturalHeight || img.height || 1;
  const maxSide = Math.max(width, height);
  if (maxSide > MAX_DIM) {
    const scale = MAX_DIM / maxSide;
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    const base64 = dataUrl.split(",")[1] || "";
    return {
      name: file.name || `imagem-${Date.now()}.jpg`,
      kind: "image",
      mimeType: originalMime,
      dataBase64: base64,
      content: "",
      size: file.size
    };
  }
  ctx.drawImage(img, 0, 0, width, height);

  const targetMime = originalMime === "image/png" && file.size < 900 * 1024 ? "image/png" : "image/jpeg";
  let outDataUrl = canvas.toDataURL(targetMime, 0.82);
  let outMime = targetMime;
  let base64 = outDataUrl.split(",")[1] || "";
  let byteSize = Math.floor((base64.length * 3) / 4);

  if (byteSize > MAX_RAW_BASE64_BYTES) {
    outMime = "image/jpeg";
    outDataUrl = canvas.toDataURL("image/jpeg", 0.68);
    base64 = outDataUrl.split(",")[1] || "";
    byteSize = Math.floor((base64.length * 3) / 4);
  }

  const safeName =
    file.name && file.name.trim()
      ? file.name.trim()
      : `print-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}.${outMime === "image/png" ? "png" : "jpg"}`;

  return {
    name: safeName,
    kind: "image",
    mimeType: outMime,
    dataBase64: base64,
    content: "",
    size: byteSize
  };
}

async function readPdfFile(file) {
  const MAX_PDF_BYTES = 3.5 * 1024 * 1024;
  if (file.size > MAX_PDF_BYTES) {
    throw new Error(`${file.name} passa de 3.5 MB.`);
  }
  const dataUrl = await readFileAsDataUrl(file);
  const base64 = dataUrl.split(",")[1] || "";
  if (!base64) {
    throw new Error(`Não foi possível ler ${file.name}.`);
  }
  return {
    name: file.name || `documento-${Date.now()}.pdf`,
    kind: "pdf",
    mimeType: "application/pdf",
    dataBase64: base64,
    content: "",
    size: file.size
  };
}

export function renderAttachmentsBar() {
  const bar = $("#composer-attachments-bar");
  if (!bar) return;

  bar.replaceChildren();
  if (state.pendingAttachments.length === 0) {
    bar.hidden = true;
    return;
  }

  bar.hidden = false;
  state.pendingAttachments.forEach((file, idx) => {
    const pill = document.createElement("span");
    pill.className = `attachment-pill${file.kind === "image" ? " is-image" : file.kind === "pdf" ? " is-pdf" : ""}`;

    if (file.kind === "image" && file.dataBase64) {
      const mime = file.mimeType || "image/jpeg";
      const dataUrl = `data:${mime};base64,${file.dataBase64}`;
      const thumb = document.createElement("img");
      thumb.className = "attachment-pill-thumb";
      thumb.src = dataUrl;
      thumb.alt = file.name;
      thumb.title = "Clique para ampliar";
      thumb.addEventListener("click", () => openImageLightbox(dataUrl, file.name));
      pill.appendChild(thumb);
    } else if (file.kind === "pdf") {
      const pdfBadge = document.createElement("span");
      pdfBadge.className = "attachment-pill-badge";
      pdfBadge.innerHTML = `${SVG_ICONS.pdf}<span>PDF</span>`;
      pill.appendChild(pdfBadge);
    }

    const nameSpan = document.createElement("span");
    nameSpan.className = "attachment-pill-name";
    nameSpan.textContent = file.name;

    const sizeSpan = document.createElement("span");
    sizeSpan.className = "attachment-pill-size";
    sizeSpan.textContent = formatFileSizeShort(file.size);

    let redactBtn = null;
    if (file.kind === "image" && file.dataBase64) {
      redactBtn = document.createElement("button");
      redactBtn.type = "button";
      redactBtn.className = "attachment-pill-redact";
      redactBtn.title = "Desenhar tarja preta manual sobre áreas sensíveis antes de enviar";
      redactBtn.textContent = "Tarjar";
      redactBtn.addEventListener("click", () => {
        void openImageRedactModal(file, (updatedFile) => {
          state.pendingAttachments[idx] = updatedFile;
          renderAttachmentsBar();
        });
      });
    }

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "attachment-pill-remove";
    removeBtn.setAttribute("aria-label", `Remover ${file.name}`);
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      state.pendingAttachments.splice(idx, 1);
      renderAttachmentsBar();
    });

    if (redactBtn) {
      pill.append(nameSpan, sizeSpan, redactBtn, removeBtn);
    } else {
      pill.append(nameSpan, sizeSpan, removeBtn);
    }
    bar.appendChild(pill);
  });
}

export async function addComposerFiles(fileList) {
  const feedback = $("#debate-form-feedback");
  const files = Array.from(fileList || []);
  if (files.length === 0) return;

  const MAX_FILES = 5;
  const MAX_TEXT_BYTES = 60 * 1024;
  let notice = "";

  for (const file of files) {
    if (state.pendingAttachments.length >= MAX_FILES) {
      notice = `Máximo de ${MAX_FILES} anexos por mensagem.`;
      break;
    }

    const fileType = (file.type || "").toLowerCase();
    const fileNameLower = (file.name || "").toLowerCase();
    const isImage =
      fileType.startsWith("image/") ||
      /\.(png|jpe?g|webp|gif)$/i.test(fileNameLower);
    const isPdf =
      fileType === "application/pdf" || fileNameLower.endsWith(".pdf");

    try {
      let entry = null;

      if (isImage) {
        if (feedback) feedback.textContent = "Processando imagem...";
        entry = await compressImageFile(file);
      } else if (isPdf) {
        if (feedback) feedback.textContent = "Lendo PDF...";
        entry = await readPdfFile(file);
      } else {
        if (file.size > MAX_TEXT_BYTES) {
          notice = `${file.name} passa de 60 KB.`;
          continue;
        }
        const content = await file.text();
        if (content.includes("\0")) {
          notice = `${file.name} não é imagem, PDF ou texto válido.`;
          continue;
        }
        entry = {
          name: file.name,
          kind: "text",
          mimeType: file.type || "text/plain",
          content,
          size: file.size
        };
      }

      if (entry) {
        const existingIdx = state.pendingAttachments.findIndex((a) => a.name === entry.name);
        if (existingIdx >= 0) {
          state.pendingAttachments[existingIdx] = entry;
        } else {
          state.pendingAttachments.push(entry);
        }
      }
    } catch (err) {
      notice =
        err instanceof Error ? err.message : `Não foi possível ler ${file.name}.`;
    }
  }

  renderAttachmentsBar();
  if (feedback) {
    feedback.textContent = notice;
  }
}

export function openMemoryModal(debateId) {
  const modal = $("#memory-modal");
  const textarea = $("#memory-editor-input");
  const fb = $("#memory-modal-feedback");
  if (!modal || !textarea) return;

  const debate = debateDetailsById.get(debateId) || getActiveOrSelectedDebate();
  state.memoryModalDebateId = debateId;
  textarea.value = debate?.sharedMemory?.summary || "";
  if (fb) fb.textContent = "";
  modal.hidden = false;
  textarea.focus();
}

export function closeMemoryModal() {
  const modal = $("#memory-modal");
  if (modal) modal.hidden = true;
  state.memoryModalDebateId = null;
}

export async function saveMemoryModal(summaryText) {
  if (!state.memoryModalDebateId) return;
  const fb = $("#memory-modal-feedback");
  const saveBtn = $("#memory-save-btn");
  const clearBtn = $("#memory-clear-btn");

  try {
    if (saveBtn) saveBtn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
    if (fb) fb.textContent = "Salvando...";

    const res = await fetchJson(`/debates/${state.memoryModalDebateId}/memory`, {
      method: "POST",
      body: { summary: summaryText }
    });

    if (res?.debate) {
      upsertDebateSessionLocally(res.debate);
    }

    state.lastRenderedChatSignature = "";
    uiHooks.updateStageTopbar();
    updateRightAiPanel();
    closeMemoryModal();
  } catch (error) {
    if (fb) {
      fb.textContent =
        error instanceof Error ? error.message : "Falha ao salvar memória.";
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    if (clearBtn) clearBtn.disabled = false;
  }
}

function inferTemplatePresetMode(tpl) {
  if (!tpl) return "debate";
  if (tpl.interactionMode === "debate") return "debate";
  return "council";
}

function formatTemplateModeBadge(tpl) {
  const preset = inferTemplatePresetMode(tpl);
  return COMPOSER_MODE_LABELS[preset] || "Conselho";
}

export function syncTemplatePresetFields(presetVal) {
  const respEl = $("#tpl-response-mode");
  const interEl = $("#tpl-interaction-mode");
  if (presetVal === "quick" || presetVal === "council") {
    if (respEl) respEl.value = "normal";
    if (interEl) interEl.value = "direct";
  } else {
    if (respEl) respEl.value = "normal";
    if (interEl) interEl.value = "debate";
  }
}

export function applyPromptTemplate(tpl) {
  if (!tpl) return;
  const titleInput = $("#debate-title");
  const topicInput = $("#debate-topic");
  const rulesInput = $("#debate-rules");
  const focusSelect = $("#debate-focus");

  const nextResponseMode =
    tpl.responseMode === "prompt_markdown" || tpl.responseMode === "normal"
      ? tpl.responseMode
      : "normal";
  const nextInteractionMode =
    tpl.interactionMode === "debate" || tpl.interactionMode === "direct"
      ? tpl.interactionMode
      : "debate";

  const targetMode = nextInteractionMode === "debate" ? "debate" : "council";
  applyComposerMode(targetMode, { responseMode: nextResponseMode });

  if (titleInput && !getActiveOrSelectedDebate() && tpl.title) {
    titleInput.value = tpl.title;
  }
  if (focusSelect && tpl.focus) {
    focusSelect.value = tpl.focus;
  }
  if (rulesInput) {
    rulesInput.value = tpl.rules || "";
  }

  const promptText = tpl.prompt || tpl.topic || "";
  if (topicInput) {
    topicInput.value = promptText;
    topicInput.style.height = "auto";
    topicInput.style.height = `${Math.min(180, topicInput.scrollHeight)}px`;
    topicInput.focus();
    try {
      topicInput.setSelectionRange(promptText.length, promptText.length);
    } catch {
      // Ignora em navegadores que não suportam seleção imediata
    }
  }

  closeTemplatesModal();
}

export function showTemplatesListView() {
  state.templatesViewMode = "list";
  state.editingTemplateId = null;

  const bodyEl = $("#templates-modal-body");
  const listPane = $("#templates-list-pane");
  const editorPane = $("#template-editor-form");
  const newBtn = $("#templates-new-btn");
  const fb = $("#templates-modal-feedback");

  if (bodyEl) bodyEl.classList.add("is-list-view");
  if (listPane) listPane.hidden = false;
  if (editorPane) editorPane.hidden = true;
  if (newBtn) newBtn.hidden = false;
  if (fb) fb.textContent = "";

  renderTemplatesModalList();
}

export function resetTemplateEditorForm() {
  state.editingTemplateId = null;
  const modeLabel = $("#tpl-editor-mode-label");
  const resetBtn = $("#tpl-reset-btn");
  const saveBtnSpan = $("#tpl-save-btn span");
  const fb = $("#templates-modal-feedback");
  const moreDetails = $("#tpl-more-details");

  if (modeLabel) modeLabel.textContent = "NOVO TEMPLATE";
  if (resetBtn) resetBtn.hidden = true;
  if (saveBtnSpan) saveBtnSpan.textContent = "Salvar Template";
  if (fb) fb.textContent = "";
  if (moreDetails) moreDetails.open = false;

  const titleEl = $("#tpl-title");
  const tagEl = $("#tpl-tag");
  const promptEl = $("#tpl-prompt");
  const rulesEl = $("#tpl-rules");
  const presetEl = $("#tpl-preset-mode");
  const respEl = $("#tpl-response-mode");
  const interEl = $("#tpl-interaction-mode");
  const focusEl = $("#tpl-focus");

  if (titleEl) titleEl.value = "";
  if (tagEl) tagEl.value = "";
  if (promptEl) promptEl.value = "";
  if (rulesEl) rulesEl.value = "";
  if (presetEl) presetEl.value = "debate";
  if (respEl) respEl.value = "normal";
  if (interEl) interEl.value = "debate";
  if (focusEl) focusEl.value = "geral";
}

export function openTemplateEditorView(tpl = null) {
  state.templatesViewMode = "editor";

  const bodyEl = $("#templates-modal-body");
  const listPane = $("#templates-list-pane");
  const editorPane = $("#template-editor-form");
  const newBtn = $("#templates-new-btn");

  if (bodyEl) bodyEl.classList.remove("is-list-view");
  if (listPane) listPane.hidden = true;
  if (editorPane) editorPane.hidden = false;
  if (newBtn) newBtn.hidden = true;

  if (tpl) {
    startEditTemplate(tpl);
  } else {
    resetTemplateEditorForm();
    $("#tpl-title")?.focus();
  }
}

export function startEditTemplate(tpl) {
  if (!tpl) return;
  state.editingTemplateId = tpl.id;
  state.templatesViewMode = "editor";

  const listPane = $("#templates-list-pane");
  const editorPane = $("#template-editor-form");
  const newBtn = $("#templates-new-btn");
  const moreDetails = $("#tpl-more-details");
  if (listPane) listPane.hidden = true;
  if (editorPane) editorPane.hidden = false;
  if (newBtn) newBtn.hidden = true;

  const modeLabel = $("#tpl-editor-mode-label");
  const resetBtn = $("#tpl-reset-btn");
  const saveBtnSpan = $("#tpl-save-btn span");
  const fb = $("#templates-modal-feedback");

  if (modeLabel) modeLabel.textContent = "EDITANDO TEMPLATE";
  if (resetBtn) resetBtn.hidden = true;
  if (saveBtnSpan) saveBtnSpan.textContent = "Atualizar Template";
  if (fb) fb.textContent = "";

  const titleEl = $("#tpl-title");
  const tagEl = $("#tpl-tag");
  const promptEl = $("#tpl-prompt");
  const rulesEl = $("#tpl-rules");
  const presetEl = $("#tpl-preset-mode");
  const respEl = $("#tpl-response-mode");
  const interEl = $("#tpl-interaction-mode");
  const focusEl = $("#tpl-focus");

  if (titleEl) titleEl.value = tpl.title || "";
  if (tagEl) tagEl.value = tpl.tag || "";
  if (promptEl) promptEl.value = tpl.prompt || "";
  if (rulesEl) rulesEl.value = tpl.rules || "";
  if (presetEl) presetEl.value = inferTemplatePresetMode(tpl);
  if (respEl) respEl.value = tpl.responseMode || "normal";
  if (interEl) interEl.value = tpl.interactionMode || "direct";
  if (focusEl) focusEl.value = tpl.focus || "geral";
  if (moreDetails) {
    moreDetails.open = Boolean(tpl.rules || tpl.tag);
  }

  titleEl?.focus();
}

export function renderTemplatesModalList() {
  const listEl = $("#templates-modal-list");
  if (!listEl) return;

  listEl.replaceChildren();
  const templates = Array.isArray(state.promptTemplates) ? state.promptTemplates : [];
  const rawFilter = String(state.templatesSearchQuery || "").trim().toLowerCase();
  const filtered = rawFilter
    ? templates.filter((t) => {
        const hay = `${t.title || ""} ${t.tag || ""} ${t.prompt || ""}`.toLowerCase();
        return hay.includes(rawFilter);
      })
    : templates;

  if (templates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "Nenhum template salvo ainda. Clique em \"+ Novo Template\" acima.";
    listEl.appendChild(empty);
    return;
  }

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = `Nenhum template encontrado para "${state.templatesSearchQuery}".`;
    listEl.appendChild(empty);
    return;
  }

  for (const tpl of filtered) {
    const card = document.createElement("article");
    card.className = "template-list-card";
    card.setAttribute("role", "listitem");

    const top = document.createElement("div");
    top.className = "template-list-card-top";

    const h4 = document.createElement("h4");
    h4.textContent = tpl.title;

    const modeMeta = document.createElement("span");
    modeMeta.className = "template-list-meta";
    const tagPrefix = tpl.tag ? `${tpl.tag} · ` : "";
    modeMeta.textContent = `${tagPrefix}${formatTemplateModeBadge(tpl)}`;

    top.append(h4, modeMeta);

    const preview = document.createElement("p");
    preview.textContent = tpl.prompt;

    const actions = document.createElement("div");
    actions.className = "template-list-actions";

    const useBtn = document.createElement("button");
    useBtn.type = "button";
    useBtn.className = "btn-primary template-use-btn";
    useBtn.textContent = "Usar";
    useBtn.addEventListener("click", () => applyPromptTemplate(tpl));

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "btn-secondary template-edit-btn";
    editBtn.innerHTML = `${SVG_ICONS.pencil}<span>Editar</span>`;
    editBtn.addEventListener("click", () => openTemplateEditorView(tpl));

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "btn-ghost-pill template-del-btn";
    delBtn.title = "Excluir template";
    delBtn.setAttribute("aria-label", `Excluir ${tpl.title}`);
    delBtn.innerHTML = SVG_ICONS.trash;
    delBtn.addEventListener("click", () => {
      void handleDeleteTemplate(tpl.id);
    });

    actions.append(useBtn, editBtn, delBtn);
    card.append(top, preview, actions);
    listEl.appendChild(card);
  }
}

export function openTemplatesModal() {
  const modal = $("#templates-modal");
  if (!modal) return;
  state.templatesSearchQuery = "";
  const searchInput = $("#templates-search-input");
  if (searchInput) searchInput.value = "";
  const listFb = $("#templates-list-feedback");
  if (listFb) listFb.textContent = "";
  modal.hidden = false;
  showTemplatesListView();
  searchInput?.focus();
  void loadPromptTemplates();
}

export function closeTemplatesModal() {
  const modal = $("#templates-modal");
  if (modal) modal.hidden = true;
  state.editingTemplateId = null;
  state.templatesViewMode = "list";
}

export async function handleSaveTemplateForm(event) {
  event.preventDefault();
  const fb = $("#templates-modal-feedback");
  const listFb = $("#templates-list-feedback");
  const saveBtn = $("#tpl-save-btn");

  const title = ($("#tpl-title")?.value || "").trim();
  const tag = ($("#tpl-tag")?.value || "").trim();
  const prompt = ($("#tpl-prompt")?.value || "").trim();
  const rules = ($("#tpl-rules")?.value || "").trim();
  const responseMode = $("#tpl-response-mode")?.value || "normal";
  const interactionMode = $("#tpl-interaction-mode")?.value || "direct";
  const focus = $("#tpl-focus")?.value || "geral";

  if (!title) {
    if (fb) fb.textContent = "Informe um título para o template.";
    $("#tpl-title")?.focus();
    return;
  }
  if (!prompt) {
    if (fb) fb.textContent = "Digite o texto do prompt.";
    $("#tpl-prompt")?.focus();
    return;
  }

  const payload = {
    title,
    tag: tag || undefined,
    prompt,
    rules: rules || undefined,
    responseMode,
    interactionMode,
    focus
  };

  try {
    if (saveBtn) saveBtn.disabled = true;
    if (fb) fb.textContent = "Salvando...";

    let res;
    if (state.editingTemplateId) {
      try {
        res = await fetchJson(`/templates/${state.editingTemplateId}`, {
          method: "PATCH",
          body: payload
        });
      } catch {
        res = await fetchJson(`/templates/${state.editingTemplateId}/update`, {
          method: "POST",
          body: payload
        });
      }
    } else {
      res = await fetchJson("/templates", {
        method: "POST",
        body: payload
      });
    }

    if (Array.isArray(res?.templates)) {
      state.promptTemplates = res.templates;
    } else {
      await loadPromptTemplates();
    }

    state.lastZeroShowcaseSignature = "";
    uiHooks.renderZeroStateHorizontalShowcase();
    showTemplatesListView();
    if (listFb) listFb.textContent = "Template salvo!";
  } catch (error) {
    if (fb) {
      fb.textContent =
        error instanceof Error ? error.message : "Erro ao salvar template.";
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

export async function handleDeleteTemplate(templateId) {
  const fb = $("#templates-list-feedback") || $("#templates-modal-feedback");
  try {
    let res;
    try {
      res = await fetchJson(`/templates/${templateId}`, { method: "DELETE" });
    } catch {
      res = await fetchJson(`/templates/${templateId}/delete`, {
        method: "POST",
        body: {}
      });
    }
    if (Array.isArray(res?.templates)) {
      state.promptTemplates = res.templates;
    } else {
      state.promptTemplates = state.promptTemplates.filter((t) => t.id !== templateId);
    }
    renderTemplatesModalList();
    state.lastZeroShowcaseSignature = "";
    uiHooks.renderZeroStateHorizontalShowcase();
    if (fb) fb.textContent = "Template removido.";
  } catch (error) {
    if (fb) {
      fb.textContent =
        error instanceof Error ? error.message : "Erro ao remover template.";
    }
  }
}
