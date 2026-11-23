import { $, state, uiHooks } from "./state.js";
import { fetchJson } from "./api.js";

const BRIEFING_BASE_DIR_KEY = "ai-council-briefing-base-dir";

const GENERAL_GRILL_NEG_GUARD_RE =
  /\b(sem\s+perguntas|direto\s+ao\s+ponto|responda\s+rapido|seja\s+breve|apenas\s+responda|so\s+responda|nao\s+pergunte)\b/;

const GENERAL_GRILL_FACTUAL_START_RE =
  /^(?:o\s+que\s+e|quem\s+e|quando|onde|quant[oa]s?|qual\s+(?:e\s+)?a\s+diferenca|explique|explica|traduza|resuma|corrija\s+o\s+texto|converta|calcule|que\s+horas|como\s+funciona\s+o)\b/;

const GENERAL_GRILL_BROAD_RE =
  /\b(me\s+ajud[ae]\s+a\s+(?:planejar|estruturar|criar|montar|definir|escolher|organizar|desenhar)|quero\s+(?:planejar|estruturar|montar|criar|desenhar|lancar)\s+(?:um|uma)|plano\s+de\s+(?:estudos|negocios|acao|projeto|carreira|marketing|arquitetura)|estrategia\s+(?:de|para)|arquitetura\s+(?:de|para)\s+(?:um|uma)|como\s+(?:estruturar|planejar|montar|comecar)\s+(?:um|uma))\b/;

let activeKeydownHandler = null;

export function looksLikeBroadIdeaForGrillClient(rawText) {
  const norm = String(rawText || "")
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

function getStoredBaseDir() {
  try {
    return localStorage.getItem(BRIEFING_BASE_DIR_KEY) || "";
  } catch {
    return "";
  }
}

function saveStoredBaseDir(dir) {
  try {
    if (dir) localStorage.setItem(BRIEFING_BASE_DIR_KEY, dir);
  } catch {
    // Ignora
  }
}

function joinDisplayPath(baseDir, folderName) {
  const cleanBase = String(baseDir || "").replace(/[\\/]+$/, "");
  const cleanName = String(folderName || "").trim() || "MeuApp";
  const sep = cleanBase.includes("\\") ? "\\" : "/";
  return cleanBase ? `${cleanBase}${sep}${cleanName}` : cleanName;
}

function detachWizardKeyboard() {
  if (activeKeydownHandler) {
    document.removeEventListener("keydown", activeKeydownHandler);
    activeKeydownHandler = null;
  }
}

export function closeGrillWizard() {
  detachWizardKeyboard();
  const card = $("#composer-briefing-card");
  if (!card) return;
  card.hidden = true;
  card.replaceChildren();
}

function matchDesignSystemByText(text, designSystems) {
  const norm = String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (!norm || !Array.isArray(designSystems) || designSystems.length === 0) {
    return null;
  }
  if (/\b(surpreenda|aleatori[oa]|automatic[oa])\b/.test(norm)) {
    return "random";
  }
  if (/\b(claro\s+minimalista|fundo\s+branco|tema\s+claro|light)\b/.test(norm)) {
    const lightDs = designSystems.find((d) => d.theme === "light");
    return lightDs ? lightDs.id : "auto";
  }
  const keywords = [
    ["verde", /\b(verde|esmeralda|botanico|green|supabase)\b/],
    ["roxo", /\b(roxo|violeta|purple|violet|iris)\b/],
    ["azul", /\b(azul|blue|sky|ciano)\b/],
    ["terminal", /\b(terminal|bloomberg|financeiro|preto\s+minimalista)\b/],
    ["neon", /\b(neon|aurora|vidro|glass)\b/],
    ["coral", /\b(coral|vermelho|laranja)\b/]
  ]
    .filter(([, re]) => re.test(norm))
    .map(([tag]) => tag);

  if (keywords.length === 0) return null;
  let best = null;
  let bestScore = 0;
  for (const ds of designSystems) {
    const score = keywords.filter(
      (k) => Array.isArray(ds.tags) && ds.tags.includes(k)
    ).length;
    if (score > bestScore) {
      bestScore = score;
      best = ds.id;
    }
  }
  return best;
}

function getSwatchesForVisualOption(optionText, designSystems) {
  const matchedId = matchDesignSystemByText(optionText, designSystems);
  if (!matchedId) return [];
  if (matchedId === "random") {
    return designSystems.slice(0, 4).map((d) => ({ name: d.name, hex: d.accentHex }));
  }
  const ds = designSystems.find((d) => d.id === matchedId);
  if (!ds) return [];
  if (Array.isArray(ds.swatches) && ds.swatches.length > 0) {
    return ds.swatches.slice(0, 4);
  }
  return [
    { name: "Fundo", hex: ds.backgroundHex },
    { name: "Destaque", hex: ds.accentHex }
  ];
}

function formatGeneralPromptWithAnswers(rawPrompt, answers) {
  if (!answers || answers.length === 0) return rawPrompt;
  const lines = answers.map((a) => `- ${a.question} → ${a.answer}`);
  return `${rawPrompt}\n\nDecisões refinadas (Grill-me):\n${lines.join("\n")}`;
}

function renderLoadingState(card, { eyebrowText, subtitleText, onSkip, onClose }) {
  card.hidden = false;
  card.replaceChildren();

  const wrap = document.createElement("div");
  wrap.className = "grill-wizard";

  const top = document.createElement("div");
  top.className = "grill-wizard-top";

  const titleMeta = document.createElement("div");
  titleMeta.className = "grill-wizard-meta";
  const badge = document.createElement("span");
  badge.className = "grill-wizard-badge";
  badge.textContent = eyebrowText;
  const status = document.createElement("span");
  status.className = "grill-wizard-step-label";
  status.textContent = subtitleText;
  titleMeta.append(badge, status);

  const actions = document.createElement("div");
  actions.className = "grill-wizard-head-actions";
  const skipBtn = document.createElement("button");
  skipBtn.type = "button";
  skipBtn.className = "grill-wizard-skip-btn";
  skipBtn.textContent = "Pular e ir direto →";
  skipBtn.addEventListener("click", () => {
    closeGrillWizard();
    onSkip?.();
  });
  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "icon-btn";
  closeBtn.setAttribute("aria-label", "Fechar Grill-me");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => {
    closeGrillWizard();
    onClose?.();
  });
  actions.append(skipBtn, closeBtn);
  top.append(titleMeta, actions);

  const progressTrack = document.createElement("div");
  progressTrack.className = "grill-wizard-progress-track";
  const progressFill = document.createElement("div");
  progressFill.className = "grill-wizard-progress-fill is-indeterminate";
  progressTrack.appendChild(progressFill);

  const body = document.createElement("div");
  body.className = "grill-wizard-loading-body";
  const line1 = document.createElement("div");
  line1.className = "grill-skeleton-line is-wide";
  const line2 = document.createElement("div");
  line2.className = "grill-skeleton-line";
  const line3 = document.createElement("div");
  line3.className = "grill-skeleton-line";
  body.append(line1, line2, line3);

  wrap.append(top, progressTrack, body);
  card.appendChild(wrap);
}

/**
 * Núcleo reutilizável do Grill-me Wizard (1 pergunta por vez, opções numeradas,
 * destaque (Recomendado), Outro... inline e suporte total a teclado 1-9 / Enter / Esc).
 */
function mountInteractiveQuestionWizard(card, config) {
  const {
    mode,
    questions,
    provider,
    designSystems = [],
    onAnswerVisual,
    onComplete,
    onSkip,
    onClose
  } = config;

  const answersById = new Map();
  let stepIndex = 0;
  let customOpen = false;

  const collectAnswersList = () =>
    questions
      .map((q) => {
        const answer = (answersById.get(q.id) || "").trim();
        return answer ? { id: q.id, question: q.question, answer } : null;
      })
      .filter(Boolean);

  const finishWizard = () => {
    detachWizardKeyboard();
    onComplete(collectAnswersList());
  };

  const renderStep = () => {
    detachWizardKeyboard();
    const q = questions[stepIndex];
    if (!q) {
      finishWizard();
      return;
    }

    const total = questions.length;
    const currentAnswer = answersById.get(q.id) || "";
    const opts = Array.isArray(q.options) ? q.options : [];
    const isCustomValue = Boolean(currentAnswer && !opts.includes(currentAnswer));
    if (isCustomValue) customOpen = true;

    card.hidden = false;
    card.replaceChildren();

    const wrap = document.createElement("div");
    wrap.className = "grill-wizard";

    // Top bar
    const top = document.createElement("div");
    top.className = "grill-wizard-top";

    const meta = document.createElement("div");
    meta.className = "grill-wizard-meta";
    const badge = document.createElement("span");
    badge.className = "grill-wizard-badge";
    badge.textContent = mode === "app" ? "GRILL-ME · NOVO APP" : "GRILL-ME";
    const stepLabel = document.createElement("span");
    stepLabel.className = "grill-wizard-step-label";
    const viaHint = provider && provider !== "local_fallback" ? ` · via ${provider.toUpperCase()}` : "";
    stepLabel.textContent = `Pergunta ${stepIndex + 1} de ${total}${viaHint}`;
    meta.append(badge, stepLabel);

    const actions = document.createElement("div");
    actions.className = "grill-wizard-head-actions";

    const skipBtn = document.createElement("button");
    skipBtn.type = "button";
    skipBtn.className = "grill-wizard-skip-btn";
    skipBtn.textContent = mode === "app" ? "Pular para resumo →" : "Pular e ir direto →";
    skipBtn.addEventListener("click", () => {
      if (mode === "app") {
        finishWizard();
      } else {
        closeGrillWizard();
        onSkip?.();
      }
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "icon-btn";
    closeBtn.setAttribute("aria-label", "Fechar Grill-me");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => {
      closeGrillWizard();
      onClose?.();
    });

    actions.append(skipBtn, closeBtn);
    top.append(meta, actions);

    // Progress bar
    const progressTrack = document.createElement("div");
    progressTrack.className = "grill-wizard-progress-track";
    const progressFill = document.createElement("div");
    progressFill.className = "grill-wizard-progress-fill";
    const pct = Math.round(((stepIndex + 1) / Math.max(1, total)) * 100);
    progressFill.style.width = `${pct}%`;
    progressTrack.appendChild(progressFill);

    // Question Heading
    const heading = document.createElement("h4");
    heading.className = "grill-wizard-question";
    heading.textContent = q.question;

    // Numbered vertical options
    const optionsList = document.createElement("div");
    optionsList.className = "grill-wizard-options";
    optionsList.setAttribute("role", "listbox");
    optionsList.setAttribute("aria-label", q.question);

    const selectOptionAndAdvance = (optText) => {
      answersById.set(q.id, optText);
      if (q.category === "visual") {
        onAnswerVisual?.(optText);
      }
      customOpen = false;
      if (stepIndex + 1 < total) {
        stepIndex += 1;
        renderStep();
      } else {
        finishWizard();
      }
    };

    opts.forEach((optText, idx) => {
      const btn = document.createElement("button");
      btn.type = "button";
      const isSelected = currentAnswer === optText;
      const isRecommended =
        idx === 0 || (q.recommended && optText.toLowerCase() === q.recommended.toLowerCase());
      btn.className = `grill-wizard-option${isSelected ? " is-selected" : ""}`;
      btn.setAttribute("role", "option");
      btn.setAttribute("aria-selected", String(isSelected));

      const num = document.createElement("span");
      num.className = "grill-option-num";
      num.textContent = String(idx + 1);

      const content = document.createElement("span");
      content.className = "grill-option-content";
      const textEl = document.createElement("span");
      textEl.className = "grill-option-text";
      textEl.textContent = optText;
      content.appendChild(textEl);

      if (isRecommended) {
        const recBadge = document.createElement("span");
        recBadge.className = "grill-option-rec";
        recBadge.textContent = "Recomendado";
        content.appendChild(recBadge);
      }

      btn.append(num, content);

      if (q.category === "visual" && designSystems.length > 0) {
        const swList = getSwatchesForVisualOption(optText, designSystems);
        if (swList.length > 0) {
          const swWrap = document.createElement("span");
          swWrap.className = "grill-option-swatches";
          for (const sw of swList) {
            const dot = document.createElement("span");
            dot.className = "briefing-swatch-dot";
            dot.style.backgroundColor = sw.hex;
            dot.title = `${sw.name}: ${sw.hex}`;
            swWrap.appendChild(dot);
          }
          btn.appendChild(swWrap);
        }
      }

      btn.addEventListener("click", () => selectOptionAndAdvance(optText));
      optionsList.appendChild(btn);
    });

    // Opção "Outro..." no final da lista (idêntica ao estilo interativo)
    const otherNumIndex = opts.length + 1;
    const otherRow = document.createElement("div");
    otherRow.className = `grill-wizard-other-wrap${customOpen ? " is-open" : ""}`;

    const otherBtn = document.createElement("button");
    otherBtn.type = "button";
    otherBtn.className = `grill-wizard-option grill-wizard-other-btn${isCustomValue ? " is-selected" : ""}`;
    const otherNum = document.createElement("span");
    otherNum.className = "grill-option-num";
    otherNum.textContent = String(otherNumIndex);
    const otherLabel = document.createElement("span");
    otherLabel.className = "grill-option-text";
    otherLabel.textContent = isCustomValue ? `Outro: ${currentAnswer}` : "Outro (digitar resposta)...";
    otherBtn.append(otherNum, otherLabel);

    const customForm = document.createElement("div");
    customForm.className = "grill-wizard-custom-row";
    customForm.hidden = !customOpen;

    const customInput = document.createElement("input");
    customInput.type = "text";
    customInput.className = "grill-wizard-custom-input";
    customInput.maxLength = 200;
    customInput.placeholder = "Digite sua preferência e aperte Enter...";
    customInput.value = isCustomValue ? currentAnswer : "";

    const customConfirmBtn = document.createElement("button");
    customConfirmBtn.type = "button";
    customConfirmBtn.className = "btn-primary grill-wizard-custom-ok";
    customConfirmBtn.textContent = "Ok →";

    const commitCustom = () => {
      const val = customInput.value.trim();
      if (!val) {
        customInput.focus();
        return;
      }
      selectOptionAndAdvance(val);
    };

    customConfirmBtn.addEventListener("click", commitCustom);
    customInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        commitCustom();
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        customOpen = false;
        renderStep();
      }
    });

    otherBtn.addEventListener("click", () => {
      customOpen = true;
      customForm.hidden = false;
      otherRow.classList.add("is-open");
      customInput.focus();
    });

    customForm.append(customInput, customConfirmBtn);
    otherRow.append(otherBtn, customForm);
    optionsList.appendChild(otherRow);

    // Footer
    const footer = document.createElement("div");
    footer.className = "grill-wizard-footer";

    const backBtn = document.createElement("button");
    backBtn.type = "button";
    backBtn.className = "btn-ghost-pill";
    backBtn.textContent = "← Voltar";
    backBtn.disabled = stepIndex === 0;
    backBtn.addEventListener("click", () => {
      if (stepIndex > 0) {
        customOpen = false;
        stepIndex -= 1;
        renderStep();
      }
    });

    const hint = document.createElement("span");
    hint.className = "grill-wizard-kbd-hint";
    hint.textContent = `Teclado: 1–${otherNumIndex} escolhe · Esc fecha`;

    const nextBtn = document.createElement("button");
    nextBtn.type = "button";
    nextBtn.className = "btn-secondary grill-wizard-next-btn";
    nextBtn.textContent = stepIndex + 1 < total ? "Pular esta →" : "Concluir →";
    nextBtn.addEventListener("click", () => {
      if (customOpen && customInput.value.trim()) {
        commitCustom();
        return;
      }
      customOpen = false;
      if (stepIndex + 1 < total) {
        stepIndex += 1;
        renderStep();
      } else {
        finishWizard();
      }
    });

    footer.append(backBtn, hint, nextBtn);
    wrap.append(top, progressTrack, heading, optionsList, footer);
    card.appendChild(wrap);

    if (customOpen) {
      requestAnimationFrame(() => customInput.focus());
    }

    // Atalhos de teclado 1..9 / Escape (sem sequestrar digitação em inputs!)
    activeKeydownHandler = (ev) => {
      if (card.hidden) return;
      const tag = (document.activeElement?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select") {
        return;
      }
      if (ev.key === "Escape") {
        ev.preventDefault();
        closeGrillWizard();
        onClose?.();
        return;
      }
      const num = Number(ev.key);
      if (Number.isInteger(num) && num >= 1 && num <= opts.length) {
        ev.preventDefault();
        selectOptionAndAdvance(opts[num - 1]);
      } else if (Number.isInteger(num) && num === otherNumIndex) {
        ev.preventDefault();
        customOpen = true;
        customForm.hidden = false;
        otherRow.classList.add("is-open");
        customInput.focus();
      }
    };
    document.addEventListener("keydown", activeKeydownHandler);
  };

  renderStep();
}

/**
 * Fluxo unificado minimalista para NOVO APP:
 * 1) Abre direto o Grill-me Wizard (1 pergunta por vez, com swatches na pergunta visual e botão Pular);
 * 2) Na tela final, exibe resumo compacto de 1 bloco (Pasta + Design System + Segurança) + 1 clique para construir.
 */
export async function openGrillWizardForApp(
  rawPrompt,
  { onBuildReady, onSendPlainChat }
) {
  const card = $("#composer-briefing-card");
  if (!card) {
    onSendPlainChat?.();
    return;
  }

  let aborted = false;
  renderLoadingState(card, {
    eyebrowText: "GRILL-ME · NOVO APP",
    subtitleText: "Preparando perguntas rápidas (Groq)...",
    onSkip: () => {
      aborted = true;
      onSendPlainChat?.();
    },
    onClose: () => {
      aborted = true;
      $("#debate-topic")?.focus();
    }
  });

  let analysis;
  let designSystems = [];
  let recommendedDesignSystemId = "auto";
  try {
    const res = await fetchJson("/projects/briefing/analyze", {
      method: "POST",
      body: {
        prompt: rawPrompt,
        baseDir: getStoredBaseDir() || undefined
      }
    });
    if (aborted) return;
    analysis = res?.analysis;
    designSystems = Array.isArray(res?.designSystems) ? res.designSystems : [];
    recommendedDesignSystemId =
      typeof res?.recommendedDesignSystemId === "string" && res.recommendedDesignSystemId
        ? res.recommendedDesignSystemId
        : "auto";
  } catch {
    if (!aborted) {
      closeGrillWizard();
      onSendPlainChat?.();
    }
    return;
  }

  if (!analysis || !analysis.isNewAppIdea) {
    if (!aborted) {
      closeGrillWizard();
      onSendPlainChat?.();
    }
    return;
  }

  const draft = {
    rawPrompt,
    appName: analysis.suggestedName || "MeuApp",
    baseDir: analysis.baseDir || "",
    appKind: analysis.appKind || "web_app",
    theme: analysis.theme || "dark",
    designSystemId: recommendedDesignSystemId || "auto",
    financial: Boolean(analysis.security?.financial),
    lgpd: Boolean(analysis.security?.lgpd),
    grillAnswers: []
  };

  let questions = [];
  let provider = "local_fallback";
  try {
    const grillRes = await fetchJson("/projects/briefing/grill", {
      method: "POST",
      body: {
        prompt: rawPrompt,
        appKind: draft.appKind,
        theme: draft.theme
      }
    });
    if (aborted) return;
    questions = Array.isArray(grillRes?.questions) ? grillRes.questions : [];
    provider = grillRes?.provider || "local_fallback";
  } catch {
    if (aborted) return;
    questions = [];
  }

  const renderCompactAppSummary = (answersList) => {
    detachWizardKeyboard();
    draft.grillAnswers = answersList;
    card.hidden = false;
    card.replaceChildren();

    const wrap = document.createElement("div");
    wrap.className = "grill-wizard grill-summary-stage";

    // Header
    const top = document.createElement("div");
    top.className = "grill-wizard-top";

    const meta = document.createElement("div");
    meta.className = "grill-wizard-meta";
    const badge = document.createElement("span");
    badge.className = "grill-wizard-badge";
    badge.textContent = "PRONTO PARA CONSTRUIR";
    const stepLabel = document.createElement("span");
    stepLabel.className = "grill-wizard-step-label";
    stepLabel.textContent =
      answersList.length > 0
        ? `${answersList.length} decisão(ões) do Grill-me aplicadas`
        : "Configuração automática pronta";
    meta.append(badge, stepLabel);

    const headActions = document.createElement("div");
    headActions.className = "grill-wizard-head-actions";
    if (questions.length > 0) {
      const editAnswersBtn = document.createElement("button");
      editAnswersBtn.type = "button";
      editAnswersBtn.className = "grill-wizard-skip-btn";
      editAnswersBtn.textContent = "← Refinar perguntas";
      editAnswersBtn.addEventListener("click", () => launchQuestions());
      headActions.appendChild(editAnswersBtn);
    }
    const plainBtn = document.createElement("button");
    plainBtn.type = "button";
    plainBtn.className = "grill-wizard-skip-btn";
    plainBtn.textContent = "Só conversar";
    plainBtn.addEventListener("click", () => {
      closeGrillWizard();
      onSendPlainChat?.();
    });
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "icon-btn";
    closeBtn.setAttribute("aria-label", "Fechar resumo");
    closeBtn.textContent = "×";
    closeBtn.addEventListener("click", () => {
      closeGrillWizard();
      $("#debate-topic")?.focus();
    });
    headActions.append(plainBtn, closeBtn);
    top.append(meta, headActions);

    // Bloco compacto: Nome + Pasta + Design System + Segurança
    const grid = document.createElement("div");
    grid.className = "grill-summary-grid";

    // 1. Nome + Pasta
    const folderItem = document.createElement("div");
    folderItem.className = "grill-summary-item";
    const folderLbl = document.createElement("span");
    folderLbl.className = "grill-summary-label";
    folderLbl.textContent = "Projeto & Pasta";
    const folderControls = document.createElement("div");
    folderControls.className = "grill-summary-folder-row";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.className = "grill-summary-name-input";
    nameInput.value = draft.appName;
    nameInput.maxLength = 64;
    nameInput.setAttribute("aria-label", "Nome do projeto");
    const pathCode = document.createElement("code");
    pathCode.className = "briefing-path-code";
    pathCode.textContent = joinDisplayPath(draft.baseDir, draft.appName);
    const pickBtn = document.createElement("button");
    pickBtn.type = "button";
    pickBtn.className = "btn-secondary briefing-pick-btn";
    pickBtn.textContent = "Pasta...";
    nameInput.addEventListener("input", () => {
      draft.appName = nameInput.value.trim();
      pathCode.textContent = joinDisplayPath(draft.baseDir, draft.appName);
    });
    pickBtn.addEventListener("click", async () => {
      pickBtn.disabled = true;
      try {
        const picked = await fetchJson("/projects/pick-folder", {
          method: "POST",
          timeoutMs: 125000,
          body: { initialPath: draft.baseDir || undefined }
        });
        if (!picked?.cancelled && picked?.path) {
          draft.baseDir = picked.path;
          saveStoredBaseDir(picked.path);
          pathCode.textContent = joinDisplayPath(draft.baseDir, draft.appName);
        }
      } catch (err) {
        feedbackEl.textContent =
          err instanceof Error ? err.message : "Falha ao abrir seletor de pastas.";
      } finally {
        pickBtn.disabled = false;
      }
    });
    folderControls.append(nameInput, pickBtn);
    folderItem.append(folderLbl, folderControls, pathCode);
    grid.appendChild(folderItem);

    // 2. Design System (com swatches)
    if (draft.appKind !== "api" && designSystems.length > 0) {
      const dsItem = document.createElement("div");
      dsItem.className = "grill-summary-item";
      const dsLbl = document.createElement("span");
      dsLbl.className = "grill-summary-label";
      dsLbl.textContent = "Design System (.md)";
      const dsRow = document.createElement("div");
      dsRow.className = "briefing-design-row";
      const dsSelect = document.createElement("select");
      dsSelect.className = "briefing-design-select";
      for (const optDef of [
        { value: "auto", label: "Automático (inteligente)" },
        { value: "random", label: "Aleatório (sempre diferente)" },
        ...designSystems.map((d) => ({ value: d.id, label: `${d.name} (${d.theme})` })),
        { value: "none", label: "Padrão limpo (sem .md)" }
      ]) {
        const opt = document.createElement("option");
        opt.value = optDef.value;
        opt.textContent = optDef.label;
        dsSelect.appendChild(opt);
      }
      dsSelect.value = draft.designSystemId;

      const swatchesWrap = document.createElement("div");
      swatchesWrap.className = "briefing-swatches";
      const renderSwatches = () => {
        swatchesWrap.replaceChildren();
        const found = designSystems.find((d) => d.id === draft.designSystemId);
        const list = found
          ? (found.swatches || []).slice(0, 4)
          : designSystems.slice(0, 4).map((d) => ({ name: d.name, hex: d.accentHex }));
        for (const sw of list) {
          const dot = document.createElement("span");
          dot.className = "briefing-swatch-dot";
          dot.style.backgroundColor = sw.hex;
          dot.title = `${sw.name}: ${sw.hex}`;
          swatchesWrap.appendChild(dot);
        }
      };
      renderSwatches();
      dsSelect.addEventListener("change", () => {
        draft.designSystemId = dsSelect.value || "auto";
        const found = designSystems.find((d) => d.id === draft.designSystemId);
        if (found?.theme === "light") draft.theme = "light";
        else if (found?.theme === "dark") draft.theme = "dark";
        renderSwatches();
      });
      dsRow.append(dsSelect, swatchesWrap);
      dsItem.append(dsLbl, dsRow);
      grid.appendChild(dsItem);
    }

    // 3. Chips compactos de Segurança
    const secRow = document.createElement("div");
    secRow.className = "grill-summary-sec-row";
    const baseChip = document.createElement("span");
    baseChip.className = "briefing-sec-pill is-locked";
    baseChip.textContent = "✓ Base OWASP";
    secRow.appendChild(baseChip);

    const makeSecToggle = (label, checked, onChange) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `briefing-sec-pill${checked ? " is-active" : ""}`;
      btn.setAttribute("aria-pressed", String(checked));
      btn.textContent = `${checked ? "✓ " : "+ "}${label}`;
      btn.addEventListener("click", () => {
        const next = btn.getAttribute("aria-pressed") !== "true";
        btn.setAttribute("aria-pressed", String(next));
        btn.classList.toggle("is-active", next);
        btn.textContent = `${next ? "✓ " : "+ "}${label}`;
        onChange(next);
      });
      return btn;
    };
    secRow.append(
      makeSecToggle("Financeiro", draft.financial, (v) => { draft.financial = v; }),
      makeSecToggle("LGPD", draft.lgpd, (v) => { draft.lgpd = v; })
    );

    // Footer CTA
    const footer = document.createElement("div");
    footer.className = "grill-wizard-footer";
    const feedbackEl = document.createElement("span");
    feedbackEl.className = "form-feedback";
    feedbackEl.setAttribute("role", "status");

    const buildBtn = document.createElement("button");
    buildBtn.type = "button";
    buildBtn.className = "btn-primary briefing-build-btn";
    buildBtn.textContent = "Criar pasta e construir →";
    buildBtn.addEventListener("click", async () => {
      const cleanName = (draft.appName || "").trim();
      if (!cleanName) {
        feedbackEl.textContent = "Informe um nome para a pasta do projeto.";
        nameInput.focus();
        return;
      }
      buildBtn.disabled = true;
      buildBtn.textContent = "Preparando pasta...";
      feedbackEl.textContent = "";
      try {
        const prepared = await fetchJson("/projects/briefing/prepare", {
          method: "POST",
          body: {
            prompt: draft.rawPrompt,
            appName: cleanName,
            baseDir: draft.baseDir,
            appKind: draft.appKind,
            theme: draft.theme,
            designSystemId: draft.designSystemId,
            grillAnswers: draft.grillAnswers,
            security: {
              financial: draft.financial,
              lgpd: draft.lgpd
            }
          }
        });
        if (draft.baseDir) saveStoredBaseDir(draft.baseDir);
        if (Array.isArray(prepared?.projects)) {
          state.userProjects = prepared.projects;
        }
        if (prepared?.project?.id) {
          state.activeProjectId = prepared.project.id;
          uiHooks.renderSidebarProjects?.();
          uiHooks.syncComposerProjectPill?.();
        }
        closeGrillWizard();
        onBuildReady?.({
          project: prepared?.project,
          expandedPrompt: prepared?.expandedPrompt || draft.rawPrompt,
          title: prepared?.project?.name || cleanName
        });
      } catch (err) {
        feedbackEl.textContent =
          err instanceof Error ? err.message : "Não foi possível preparar a pasta.";
        buildBtn.disabled = false;
        buildBtn.textContent = "Criar pasta e construir →";
      }
    });

    footer.append(feedbackEl, buildBtn);
    wrap.append(top, grid, secRow, footer);
    card.appendChild(wrap);
  };

  const launchQuestions = () => {
    if (questions.length === 0) {
      renderCompactAppSummary([]);
      return;
    }
    mountInteractiveQuestionWizard(card, {
      mode: "app",
      questions,
      provider,
      designSystems,
      onAnswerVisual: (answerText) => {
        const matched = matchDesignSystemByText(answerText, designSystems);
        if (matched) {
          draft.designSystemId = matched;
          const found = designSystems.find((d) => d.id === matched);
          if (found?.theme === "light") draft.theme = "light";
          else if (found?.theme === "dark") draft.theme = "dark";
        } else if (/\b(claro|branco|light)\b/i.test(answerText)) {
          draft.theme = "light";
          draft.designSystemId = "auto";
        }
      },
      onComplete: (answersList) => renderCompactAppSummary(answersList),
      onSkip: () => renderCompactAppSummary([]),
      onClose: () => $("#debate-topic")?.focus()
    });
  };

  launchQuestions();
}

/**
 * Fluxo do Grill-me Wizard para PEDIDOS AMPLOS GERAIS (arquitetura, planejamento, ideias)
 * ou acionados manualmente via `/grill <ideia>`.
 */
export async function openGrillWizardForGeneralPrompt(
  rawPrompt,
  { onSendEnriched, onSkipPlain }
) {
  const card = $("#composer-briefing-card");
  if (!card) {
    onSkipPlain?.();
    return;
  }

  let aborted = false;
  renderLoadingState(card, {
    eyebrowText: "GRILL-ME",
    subtitleText: "Montando perguntas rápidas para alinhar sua ideia (Groq)...",
    onSkip: () => {
      aborted = true;
      onSkipPlain?.();
    },
    onClose: () => {
      aborted = true;
      $("#debate-topic")?.focus();
    }
  });

  let questions = [];
  let provider = "local_fallback";
  try {
    const res = await fetchJson("/debates/grill-me", {
      method: "POST",
      body: { prompt: rawPrompt }
    });
    if (aborted) return;
    questions = Array.isArray(res?.questions) ? res.questions : [];
    provider = res?.provider || "local_fallback";
  } catch {
    if (!aborted) {
      closeGrillWizard();
      onSkipPlain?.();
    }
    return;
  }

  if (questions.length === 0) {
    closeGrillWizard();
    onSkipPlain?.();
    return;
  }

  mountInteractiveQuestionWizard(card, {
    mode: "general",
    questions,
    provider,
    onComplete: (answersList) => {
      closeGrillWizard();
      const enriched = formatGeneralPromptWithAnswers(rawPrompt, answersList);
      onSendEnriched?.(enriched);
    },
    onSkip: () => {
      closeGrillWizard();
      onSkipPlain?.();
    },
    onClose: () => $("#debate-topic")?.focus()
  });
}
