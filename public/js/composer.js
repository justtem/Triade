import {
  PLATFORMS,
  AUTO_PLATFORM_IDS,
  ALL_PLATFORM_IDS,
  SVG_ICONS,
  RESPONSE_MODE_STORAGE_KEY,
  INTERACTION_MODE_STORAGE_KEY,
  SINGLE_AI_STORAGE_KEY,
  RESPONSE_MODE_LABELS,
  INTERACTION_MODE_LABELS,
  $,
  $$,
  getAiBrandSvg,
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

export function getSelectedParticipants() {
  return $$('input[name="participants"]:checked').map((cb) => cb.value);
}

export function getActiveResponderInfo() {
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
      isTrio: false
    };
  }

  if (isTrio) {
    return {
      key: "trio",
      shortLabel: "Trio",
      fullLabel: "Trio (Gemini, Groq, OpenRouter)",
      isSingle: false,
      isTrio: true
    };
  }

  return {
    key: "custom",
    shortLabel: `${selected.length} IAs`,
    fullLabel: selected.map((id) => PLATFORMS[id] || id).join(", ") || "Conselho",
    isSingle: false,
    isTrio: false
  };
}

export function syncAiSelectionUi() {
  const checkedValues = getSelectedParticipants();
  const isSingle = state.isSingleAiMode || checkedValues.length === 1;
  const isTrio =
    !state.isSingleAiMode &&
    checkedValues.length === AUTO_PLATFORM_IDS.length &&
    AUTO_PLATFORM_IDS.every((id) => checkedValues.includes(id));

  const pillsGroup = $(".participant-pills");
  if (pillsGroup) {
    pillsGroup.classList.toggle("is-single-mode", state.isSingleAiMode);
  }

  for (const cb of $$('input[name="participants"]')) {
    cb.closest(".participant-pill")?.classList.toggle("is-selected", cb.checked);
  }

  for (const btn of $$("#ai-preset-toggle .mode-seg-btn")) {
    const preset = btn.getAttribute("data-ai-preset");
    const active = (preset === "single" && isSingle) || (preset === "trio" && isTrio);
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
  }

  // Mantém o seletor rápido da barra superior ("Respondendo: ...") sincronizado
  const info = getActiveResponderInfo();
  const topbarLabel = $("#topbar-ai-switcher-label");
  if (topbarLabel) {
    topbarLabel.innerHTML = `<span class="topbar-ai-prefix">Respondendo: </span>${escapeHtml(info.shortLabel)}`;
  }
  const topbarIcon = $("#topbar-ai-switcher-icon");
  if (topbarIcon) {
    topbarIcon.setAttribute("data-active-ai", info.key);
    topbarIcon.innerHTML = getAiBrandSvg(info.key);
  }
  for (const item of $$(".topbar-ai-option")) {
    const optVal = item.getAttribute("data-ai-switch");
    const isMatch =
      (optVal === "trio" && info.isTrio) ||
      (info.isSingle && optVal === info.key);
    item.classList.toggle("is-active", isMatch);
  }
}

export function setSelectedParticipants(platformIds, options = {}) {
  const valid = Array.from(new Set((platformIds || []).filter((id) => ALL_PLATFORM_IDS.includes(id))));
  const targetIds = valid.length > 0 ? valid : [state.preferredSingleAi || "gemini"];
  const nextSingle =
    options.singleMode !== undefined
      ? Boolean(options.singleMode)
      : targetIds.length === 1;

  state.isSingleAiMode = nextSingle;
  const finalIds = nextSingle ? [targetIds[0]] : targetIds;

  if (nextSingle && finalIds[0]) {
    state.preferredSingleAi = finalIds[0];
    saveStoredOption(SINGLE_AI_STORAGE_KEY, state.preferredSingleAi);
    if (state.selectedInteractionMode !== "direct") {
      state.selectedInteractionMode = "direct";
      saveStoredOption(INTERACTION_MODE_STORAGE_KEY, "direct");
    }
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
  setSelectedParticipants(participants, {
    singleMode: participants.length === 1
  });
}

export function syncComposerModeUi() {
  for (const btn of $$("#response-mode-toggle .mode-seg-btn")) {
    const mode = btn.getAttribute("data-response-mode");
    const active = mode === state.selectedResponseMode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
  }

  for (const btn of $$("#interaction-mode-toggle .mode-seg-btn")) {
    const mode = btn.getAttribute("data-interaction-mode");
    const active = mode === state.selectedInteractionMode;
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
      span.textContent = isWebAuto ? "Web: Auto" : "Web: Off";
    }
  }

  const activeDebate = getActiveOrSelectedDebate();
  const isContinuing = Boolean(activeDebate);
  const isRunningActive = Boolean(activeDebate && activeDebate.status === "running");
  const responder = getActiveResponderInfo();
  const submitBtn = $("#composer-submit-btn");
  const submitSpan = $("#composer-submit-btn span:first-child");
  const submitArrow = $("#composer-submit-btn .cta-arrow");

  if (submitBtn) {
    submitBtn.classList.toggle("is-stop-mode", isRunningActive);
    submitBtn.title = isRunningActive
      ? "Parar geração agora (mantém o texto já escrito)"
      : "Enviar mensagem";
    if (isRunningActive) {
      submitBtn.disabled = false;
    }
  }
  if (submitSpan) {
    submitSpan.textContent = isRunningActive
      ? "Parar"
      : isContinuing
        ? "Enviar"
        : state.selectedInteractionMode === "debate"
          ? "Debater"
          : "Enviar";
  }
  if (submitArrow) {
    submitArrow.textContent = isRunningActive ? "■" : "→";
  }

  const topicInput = $("#debate-topic");
  if (topicInput) {
    if (isContinuing) {
      topicInput.placeholder = responder.isSingle
        ? `Continuar com ${responder.shortLabel}... (Enter envia)`
        : `Continuar com ${responder.shortLabel}... (Enter envia)`;
    } else if (responder.isSingle) {
      topicInput.placeholder = `Pergunte ao ${responder.shortLabel}... (Enter envia, Shift + Enter quebra linha)`;
    } else {
      topicInput.placeholder =
        state.selectedResponseMode === "normal"
          ? "Pergunte algo... (Enter envia, Shift + Enter quebra linha)"
          : "Descreva o problema... (Enter envia, Shift + Enter quebra linha)";
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

  const checkboxes = $$('input[name="participants"]:checked');
  const participants = checkboxes.map((cb) => cb.value);

  if (state.selectedInteractionMode === "debate" && participants.length < 2) {
    if (feedback) {
      feedback.textContent = "Debate exige ao menos 2 IAs.";
    }
    return;
  }

  if (participants.length < 1) {
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

    const result = currentDebate
      ? await fetchJson(`/debates/${currentDebate.id}/message`, {
          method: "POST",
          timeoutMs: 32000,
          body: {
            message: topicValue,
            rules: rules || undefined,
            participants,
            totalRounds,
            focus,
            responseMode: state.selectedResponseMode,
            interactionMode: state.selectedInteractionMode,
            webSearchMode: state.selectedWebSearchMode,
            attachments: attachmentsSnapshot.length > 0 ? attachmentsSnapshot : undefined
          }
        })
      : await fetchJson("/debates", {
          method: "POST",
          timeoutMs: 32000,
          body: {
            title: finalTitle,
            topic: topicValue,
            rules: rules || undefined,
            participants,
            totalRounds,
            focus,
            responseMode: state.selectedResponseMode,
            interactionMode: state.selectedInteractionMode,
            webSearchMode: state.selectedWebSearchMode,
            projectId:
              state.activeNewChatProjectId ||
              state.selectedProjectFilterId ||
              undefined,
            attachments: attachmentsSnapshot.length > 0 ? attachmentsSnapshot : undefined
          }
        });

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
      feedback.textContent = "";
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

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "attachment-pill-remove";
    removeBtn.setAttribute("aria-label", `Remover ${file.name}`);
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      state.pendingAttachments.splice(idx, 1);
      renderAttachmentsBar();
    });

    pill.append(nameSpan, sizeSpan, removeBtn);
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

export function applyPromptTemplate(tpl) {
  if (!tpl) return;
  const titleInput = $("#debate-title");
  const topicInput = $("#debate-topic");
  const rulesInput = $("#debate-rules");
  const focusSelect = $("#debate-focus");
  const advPanel = $("#composer-advanced");
  const advBtn = $("#toggle-advanced-btn");

  const nextResponseMode =
    tpl.responseMode === "prompt_markdown" || tpl.responseMode === "normal"
      ? tpl.responseMode
      : "prompt_markdown";
  const nextInteractionMode =
    tpl.interactionMode === "debate" || tpl.interactionMode === "direct"
      ? tpl.interactionMode
      : "debate";

  state.selectedResponseMode = nextResponseMode;
  state.selectedInteractionMode = nextInteractionMode;
  saveStoredOption(RESPONSE_MODE_STORAGE_KEY, state.selectedResponseMode);
  saveStoredOption(INTERACTION_MODE_STORAGE_KEY, state.selectedInteractionMode);

  if (
    nextInteractionMode === "debate" &&
    (state.isSingleAiMode || getSelectedParticipants().length < 2)
  ) {
    setSelectedParticipants(AUTO_PLATFORM_IDS, { singleMode: false });
  } else {
    syncComposerModeUi();
  }

  if (titleInput && !getActiveOrSelectedDebate() && tpl.title) {
    titleInput.value = tpl.title;
  }
  if (focusSelect && tpl.focus) {
    focusSelect.value = tpl.focus;
  }
  if (rulesInput) {
    rulesInput.value = tpl.rules || "";
    if (tpl.rules && advPanel && advPanel.hidden) {
      advPanel.hidden = false;
      advBtn?.setAttribute("aria-expanded", "true");
      const span = advBtn?.querySelector("span");
      if (span) span.textContent = "− Opções";
    }
  }

  const promptText = tpl.prompt || tpl.topic || "";
  if (topicInput) {
    topicInput.value = promptText;
    topicInput.style.height = "auto";
    topicInput.style.height = `${Math.min(180, topicInput.scrollHeight)}px`;
    topicInput.focus();
  }

  closeTemplatesModal();
}

export function resetTemplateEditorForm() {
  state.editingTemplateId = null;
  const modeLabel = $("#tpl-editor-mode-label");
  const resetBtn = $("#tpl-reset-btn");
  const saveBtnSpan = $("#tpl-save-btn span");
  const fb = $("#templates-modal-feedback");

  if (modeLabel) modeLabel.textContent = "NOVO TEMPLATE";
  if (resetBtn) resetBtn.hidden = true;
  if (saveBtnSpan) saveBtnSpan.textContent = "Salvar Template";
  if (fb) fb.textContent = "";

  const titleEl = $("#tpl-title");
  const tagEl = $("#tpl-tag");
  const promptEl = $("#tpl-prompt");
  const rulesEl = $("#tpl-rules");
  const respEl = $("#tpl-response-mode");
  const interEl = $("#tpl-interaction-mode");
  const focusEl = $("#tpl-focus");

  if (titleEl) titleEl.value = "";
  if (tagEl) tagEl.value = "";
  if (promptEl) promptEl.value = "";
  if (rulesEl) rulesEl.value = "";
  if (respEl) respEl.value = "normal";
  if (interEl) interEl.value = "direct";
  if (focusEl) focusEl.value = "geral";

  renderTemplatesModalList();
}

export function startEditTemplate(tpl) {
  if (!tpl) return;
  state.editingTemplateId = tpl.id;

  const modeLabel = $("#tpl-editor-mode-label");
  const resetBtn = $("#tpl-reset-btn");
  const saveBtnSpan = $("#tpl-save-btn span");
  const fb = $("#templates-modal-feedback");

  if (modeLabel) modeLabel.textContent = "EDITANDO TEMPLATE";
  if (resetBtn) resetBtn.hidden = false;
  if (saveBtnSpan) saveBtnSpan.textContent = "Atualizar Template";
  if (fb) fb.textContent = "";

  const titleEl = $("#tpl-title");
  const tagEl = $("#tpl-tag");
  const promptEl = $("#tpl-prompt");
  const rulesEl = $("#tpl-rules");
  const respEl = $("#tpl-response-mode");
  const interEl = $("#tpl-interaction-mode");
  const focusEl = $("#tpl-focus");

  if (titleEl) titleEl.value = tpl.title || "";
  if (tagEl) tagEl.value = tpl.tag || "";
  if (promptEl) promptEl.value = tpl.prompt || "";
  if (rulesEl) rulesEl.value = tpl.rules || "";
  if (respEl) respEl.value = tpl.responseMode || "normal";
  if (interEl) interEl.value = tpl.interactionMode || "direct";
  if (focusEl) focusEl.value = tpl.focus || "geral";

  renderTemplatesModalList();
  titleEl?.focus();
}

export function renderTemplatesModalList() {
  const listEl = $("#templates-modal-list");
  if (!listEl) return;

  listEl.replaceChildren();
  const templates = Array.isArray(state.promptTemplates) ? state.promptTemplates : [];

  if (templates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "Nenhum template salvo ainda. Crie um ao lado!";
    listEl.appendChild(empty);
    return;
  }

  for (const tpl of templates) {
    const card = document.createElement("article");
    card.className = `template-list-card${state.editingTemplateId === tpl.id ? " is-editing" : ""}`;
    card.setAttribute("role", "listitem");

    const top = document.createElement("div");
    top.className = "template-list-card-top";

    const tag = document.createElement("span");
    tag.className = "zero-h-tag";
    tag.textContent = tpl.tag || "TEMPLATE";

    const modeMeta = document.createElement("span");
    modeMeta.className = "template-list-meta";
    const respLabel = RESPONSE_MODE_LABELS[tpl.responseMode] || "Normal";
    const interLabel = INTERACTION_MODE_LABELS[tpl.interactionMode] || "Direto";
    modeMeta.textContent = `${respLabel} · ${interLabel}`;

    top.append(tag, modeMeta);

    const h4 = document.createElement("h4");
    h4.textContent = tpl.title;

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
    editBtn.addEventListener("click", () => startEditTemplate(tpl));

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
    card.append(top, h4, preview, actions);
    listEl.appendChild(card);
  }
}

export function openTemplatesModal() {
  const modal = $("#templates-modal");
  if (!modal) return;
  modal.hidden = false;
  resetTemplateEditorForm();
  renderTemplatesModalList();
  void loadPromptTemplates();
}

export function closeTemplatesModal() {
  const modal = $("#templates-modal");
  if (modal) modal.hidden = true;
  state.editingTemplateId = null;
}

export async function handleSaveTemplateForm(event) {
  event.preventDefault();
  const fb = $("#templates-modal-feedback");
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
    resetTemplateEditorForm();
    if (fb) fb.textContent = "Template salvo!";
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
  const fb = $("#templates-modal-feedback");
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
    if (state.editingTemplateId === templateId) {
      resetTemplateEditorForm();
    } else {
      renderTemplatesModalList();
    }
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
