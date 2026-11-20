import {
  PLATFORMS,
  PLATFORM_MONOGRAMS,
  AUTO_PLATFORM_IDS,
  STAGE_LABELS,
  FOCUS_LABELS,
  SVG_ICONS,
  RESPONSE_MODE_LABELS,
  INTERACTION_MODE_LABELS,
  $,
  $$,
  getAiBrandSvg,
  state,
  draftResponsesByTaskId,
  collapsedStageKeys,
  collapsedResponseIds,
  expandedWebSourcesTurnKeys,
  expandedProjectContextTurnKeys,
  appliedVerdictCollapseKeys,
  verdictLoadingTurnKeys,
  stackedRoundKeys,
  localTaskStartMs,
  debateDetailsById,
  activeStreamsByTaskId,
  pendingStreamPaintIds,
  getSessionTurns,
  getTasksForTurn,
  getResponsesForTurn,
  getActiveOrSelectedDebate,
  formatDate,
  formatShortTime,
  formatStopwatch,
  formatSecondsCompact,
  formatSecondsPadded,
  getTaskStartMs,
  getCompletedTaskDurationSec,
  observeScrollRevealElements,
  setScrollFocusedAiInRightDock,
  upsertDebateSessionLocally
} from "./state.js";
import { fetchJson, loadDebateDetail, refreshDashboard } from "./api.js";
import {
  escapeHtml,
  buildMarkdownDom,
  createCopyMarkdownButton
} from "./markdown.js";
import {
  attachHorizontalScrollPhysics,
  buildChatRoundMinimap,
  isChatNearBottom,
  setUnreadScrollPillVisible,
  scrollChatToBottom,
  handleSmartAutoScroll,
  updateChatScrollLinkedEffects,
  openImageLightbox
} from "./motion.js";
import { updateRightAiPanel } from "./telemetry.js";
import {
  renderZeroStateHorizontalShowcase,
  updateStageTopbar,
  handleResumeDebate
} from "./sidebar.js";
import { createSpeakButton, playVoiceQueue } from "./voice.js";

export function formatCleanErrorText(rawMessage) {
  const str = String(rawMessage || "").trim();
  if (!str) return "Falha temporária no provedor.";

  // Detecta se a mensagem contém JSON bruto (ou JSON truncado/escapado do Google/OpenAI)
  if (str.includes("{")) {
    if (/503|high demand|UNAVAILABLE|overloaded/i.test(str)) {
      return str.replace(
        /\(\{[\s\S]*$/g,
        "(alta demanda temporária no servidor da IA — código 503)."
      );
    }
    if (/429|rate limit|quota|exceeded your current quota/i.test(str)) {
      return str.replace(
        /\(["']?\{[\s\S]*$/g,
        "(limite de cota gratuita da API atingido — código 429)."
      );
    }
    const msgMatch = str.match(/"message"\s*:\s*"([^"]+)"/);
    if (msgMatch && msgMatch[1]) {
      return str.replace(/\(["']?\{[\s\S]*$/g, `(${msgMatch[1]}).`);
    }
  }

  return str;
}

export function saveCurrentDraftsFromDom() {
  const inputs = $$(".task-response-input[data-task-id]");
  for (const input of inputs) {
    const taskId = input.getAttribute("data-task-id");
    if (taskId) {
      draftResponsesByTaskId.set(taskId, input.value);
    }
  }
}

export function buildTurnUserMessage(debate, turn, isMultiTurn) {
  const userCard = document.createElement("article");
  userCard.className = "chat-user-message";
  if (!isMultiTurn) {
    userCard.id = "step-user";
    userCard.setAttribute("data-minimap-section", "step-user");
  }
  userCard.setAttribute("data-scroll-reveal", "");

  const header = document.createElement("div");
  header.className = "chat-user-header";

  const author = document.createElement("span");
  author.className = "chat-user-author";
  author.innerHTML = `${SVG_ICONS.user}<span>Você</span>`;

  const time = document.createElement("span");
  time.className = "chat-user-time";
  time.textContent = formatShortTime(turn.createdAt) || formatDate(turn.createdAt);

  header.append(author, time);

  const topic = document.createElement("div");
  topic.className = "chat-user-topic";
  topic.textContent = turn.prompt;

  const tagsRow = document.createElement("div");
  tagsRow.className = "chat-user-tags";

  const modeLabel = RESPONSE_MODE_LABELS[turn.responseMode] || "Prompt MD";
  const dynLabel = INTERACTION_MODE_LABELS[turn.interactionMode] || "Debate";

  const tagMode = document.createElement("span");
  tagMode.className = "chat-config-tag";
  tagMode.textContent = `${modeLabel} · ${dynLabel}`;
  tagsRow.appendChild(tagMode);

  const participantsNames = (turn.participants || [])
    .map((p) => PLATFORMS[p] || p)
    .join(", ");
  if (participantsNames) {
    const tagParticipants = document.createElement("span");
    tagParticipants.className = "chat-config-tag";
    tagParticipants.textContent = participantsNames;
    tagsRow.appendChild(tagParticipants);
  }

  if (turn.interactionMode === "debate") {
    const tagRounds = document.createElement("span");
    tagRounds.className = "chat-config-tag";
    tagRounds.textContent = `${turn.totalRounds}x + Síntese`;
    tagsRow.appendChild(tagRounds);
  }

  if (turn.responseMode === "prompt_markdown" && turn.focus && turn.focus !== "geral") {
    const tagFocus = document.createElement("span");
    tagFocus.className = "chat-config-tag";
    tagFocus.textContent = FOCUS_LABELS[turn.focus] || turn.focus;
    tagsRow.appendChild(tagFocus);
  }

  const imageAttachments = [];
  if (Array.isArray(turn.attachments) && turn.attachments.length > 0) {
    for (const file of turn.attachments) {
      if (file.kind === "image" && file.dataBase64) {
        imageAttachments.push(file);
        continue;
      }
      const tagFile = document.createElement("span");
      tagFile.className = `chat-config-tag${file.kind === "pdf" ? " tag-pdf" : ""}`;
      if (file.kind === "pdf") {
        tagFile.innerHTML = `${SVG_ICONS.pdf}<span>PDF · ${escapeHtml(file.name)}</span>`;
      } else if (file.kind === "image") {
        tagFile.innerHTML = `${SVG_ICONS.image}<span>${escapeHtml(file.name)}</span>`;
      } else {
        tagFile.textContent = `[${file.name}]`;
      }
      tagsRow.appendChild(tagFile);
    }
  }

  userCard.append(header, topic);

  if (imageAttachments.length > 0) {
    const mediaGrid = document.createElement("div");
    mediaGrid.className = "chat-user-media-grid";
    for (const imgFile of imageAttachments) {
      const mime = imgFile.mimeType || "image/jpeg";
      const dataUrl = `data:${mime};base64,${imgFile.dataBase64}`;
      const thumbBtn = document.createElement("button");
      thumbBtn.type = "button";
      thumbBtn.className = "chat-user-image-thumb";
      thumbBtn.title = `Ampliar ${imgFile.name}`;

      const imgEl = document.createElement("img");
      imgEl.src = dataUrl;
      imgEl.alt = imgFile.name || "Imagem anexada";
      imgEl.loading = "lazy";

      const caption = document.createElement("span");
      caption.className = "chat-user-image-name";
      caption.textContent = imgFile.name || "imagem";

      thumbBtn.append(imgEl, caption);
      thumbBtn.addEventListener("click", () => {
        openImageLightbox(dataUrl, imgFile.name || "Imagem anexada");
      });
      mediaGrid.appendChild(thumbBtn);
    }
    userCard.appendChild(mediaGrid);
  }

  userCard.appendChild(tagsRow);
  return userCard;
}

export function buildReasoningBlockForStage(debate, stageKey, roundNumber, stageType, stageTasks, stageResponses) {
  const pendingTasks = stageTasks.filter((t) => t.status === "pending");
  const isStageRunning = pendingTasks.length > 0 && debate.status === "running";
  const isStagePaused = pendingTasks.length > 0 && debate.status !== "running";

  const block = document.createElement("div");
  block.className = "thinking-reasoning-block";
  block.setAttribute("data-scroll-reveal", "");
  if (isStageRunning) {
    block.classList.add("is-active");
  }

  const isCollapsed = isStageRunning
    ? collapsedStageKeys.has(stageKey)
    : !collapsedStageKeys.has(`open_${stageKey}`);

  if (isCollapsed) {
    block.classList.add("is-collapsed");
  }

  const headerBtn = document.createElement("button");
  headerBtn.type = "button";
  headerBtn.className = "thinking-header-btn";

  const left = document.createElement("div");
  left.className = "thinking-header-left";

  const iconWrap = document.createElement("span");
  iconWrap.className = "thinking-spinner-icon";
  iconWrap.innerHTML = isStageRunning ? SVG_ICONS.pulse : SVG_ICONS.clock;

  const textGroup = document.createElement("div");
  const titleSpan = document.createElement("span");
  titleSpan.className = "thinking-title-text";

  const subtitleSpan = document.createElement("span");
  subtitleSpan.className = "thinking-subtitle-text";

  const stageName = STAGE_LABELS[stageType] || stageType;
  const completedCount = stageTasks.filter((t) => t.status === "completed").length;

  let earliestStartMs = Infinity;
  let latestEndMs = 0;

  for (const t of stageTasks) {
    const sMs = getTaskStartMs(t, debate);
    if (sMs < earliestStartMs) earliestStartMs = sMs;
    const resp = stageResponses.find((r) => r.taskId === t.id);
    const eMs = Date.parse(t.completedAt || resp?.submittedAt || "");
    if (!Number.isNaN(eMs) && eMs > latestEndMs) latestEndMs = eMs;
  }
  if (!Number.isFinite(earliestStartMs)) {
    earliestStartMs = Date.now();
  }

  const stageDurationSec =
    latestEndMs >= earliestStartMs
      ? Math.max(0.1, (latestEndMs - earliestStartMs) / 1000)
      : 0.1;

  if (isStageRunning) {
    titleSpan.textContent =
      stageType === "synthesis"
        ? "Pensando... Consensuando Síntese Final"
        : `Pensando... Rodada ${roundNumber} de ${debate.totalRounds} (${stageName})`;
    subtitleSpan.textContent = `${completedCount}/${stageTasks.length} concluído(s) • Clique para expandir ou recolher`;
  } else if (isStagePaused) {
    titleSpan.textContent = `Pausado — Rodada ${roundNumber} (${stageName})`;
    subtitleSpan.textContent = `${completedCount}/${stageTasks.length} concluído(s) antes da pausa`;
  } else {
    titleSpan.textContent =
      stageType === "synthesis"
        ? `Pensou por ${formatSecondsCompact(stageDurationSec)} — Síntese Final`
        : `Pensou por ${formatSecondsCompact(stageDurationSec)} — Rodada ${roundNumber}`;
    subtitleSpan.textContent = `${stageName} (${stageTasks.length} IAs) • Clique para ver detalhes de tempo`;
  }

  textGroup.append(titleSpan, subtitleSpan);
  left.append(iconWrap, textGroup);

  const right = document.createElement("div");
  right.className = "thinking-header-right";

  const stopwatch = document.createElement("span");
  stopwatch.className = "thinking-stopwatch";

  if (isStageRunning) {
    const initialElapsed = (Date.now() - earliestStartMs) / 1000;
    stopwatch.textContent = formatStopwatch(initialElapsed);
    stopwatch.setAttribute("data-live-stage-start", String(earliestStartMs));
  } else {
    stopwatch.textContent = formatSecondsPadded(stageDurationSec);
  }

  const chevronSpan = document.createElement("span");
  chevronSpan.innerHTML = SVG_ICONS.chevronDown;

  right.append(stopwatch, chevronSpan);
  headerBtn.append(left, right);

  headerBtn.addEventListener("click", () => {
    if (isStageRunning) {
      if (collapsedStageKeys.has(stageKey)) {
        collapsedStageKeys.delete(stageKey);
      } else {
        collapsedStageKeys.add(stageKey);
      }
    } else {
      const openKey = `open_${stageKey}`;
      if (collapsedStageKeys.has(openKey)) {
        collapsedStageKeys.delete(openKey);
      } else {
        collapsedStageKeys.add(openKey);
      }
    }
    block.classList.toggle("is-collapsed");
  });

  const stepsBody = document.createElement("div");
  stepsBody.className = "thinking-steps-body";

  for (const task of stageTasks) {
    const resp = stageResponses.find((r) => r.taskId === task.id);
    const stepItem = document.createElement("div");
    const isTaskRunning = task.status === "pending" && debate.status === "running";
    stepItem.className = `thinking-step-item${isTaskRunning ? " step-running" : ""}`;

    const stepLeft = document.createElement("div");
    stepLeft.className = "thinking-step-left";

    const stepIndicator = document.createElement("span");
    if (isTaskRunning) {
      stepIndicator.className = "thinking-wave";
      stepIndicator.innerHTML = "<span></span><span></span><span></span>";
    } else {
      stepIndicator.className = "step-check-icon";
      stepIndicator.innerHTML = SVG_ICONS.check;
    }

    const nameEl = document.createElement("span");
    nameEl.className = "thinking-step-name";
    nameEl.textContent = PLATFORMS[task.platform] || task.platform;

    const roleEl = document.createElement("span");
    roleEl.className = "thinking-step-role";
    if (task.role) {
      roleEl.textContent = `• ${task.role}`;
    }

    stepLeft.append(stepIndicator, nameEl, roleEl);

    const stepStatus = document.createElement("span");
    stepStatus.className = "thinking-step-status";

    if (task.status === "completed") {
      const dur = getCompletedTaskDurationSec(task, resp);
      stepStatus.textContent = dur
        ? `Concluído em ${formatSecondsCompact(dur)}`
        : "Concluído";
    } else if (isTaskRunning) {
      const startMs = getTaskStartMs(task, debate);
      const elapsed = (Date.now() - startMs) / 1000;
      const prefix = task.seat === "auto" ? "Pensando há " : "Aguardando há ";
      stepStatus.textContent = `${prefix}${formatSecondsCompact(elapsed)}...`;
      stepStatus.setAttribute("data-live-task-start", String(startMs));
      stepStatus.setAttribute("data-live-task-prefix", prefix);
    } else if (task.lastError) {
      stepStatus.textContent = `Falha: ${formatCleanErrorText(task.lastError)}`;
    } else {
      stepStatus.textContent = "Pausado";
    }

    stepItem.append(stepLeft, stepStatus);
    stepsBody.appendChild(stepItem);
  }

  block.append(headerBtn, stepsBody);
  return block;
}

export function buildPendingManualTasksForStage(debate, stageTasks) {
  const pendingTasks = stageTasks.filter((t) => t.status === "pending");
  if (pendingTasks.length === 0 || debate.status === "completed") return null;

  const actionableTasks = pendingTasks.filter(
    (t) => t.seat !== "auto" || Boolean(t.lastError)
  );

  if (actionableTasks.length === 0) return null;

  const tasksGrid = document.createElement("div");
  tasksGrid.className = "debate-tasks-grid";

  for (const task of actionableTasks) {
    const taskBox = document.createElement("div");
    taskBox.className = "debate-task-box";
    taskBox.setAttribute("data-scroll-reveal", "");

    const taskTop = document.createElement("div");
    taskTop.className = "debate-task-top";

    const taskTitle = document.createElement("strong");
    const aiName = PLATFORMS[task.platform] || task.platform;
    taskTitle.textContent = `Tarefa pendente para ${aiName} — Rodada ${task.round} (${STAGE_LABELS[task.stage] || task.stage})`;

    if (task.seat === "auto") {
      const autoNote = document.createElement("div");
      autoNote.className = "task-auto-note";
      autoNote.textContent = `Última falha: ${formatCleanErrorText(task.lastError)}`;
      taskTop.appendChild(taskTitle);
      taskBox.append(taskTop, autoNote);
      tasksGrid.appendChild(taskBox);
      continue;
    }

    const copyBtn = createCopyMarkdownButton(
      task.prompt,
      "Copiar Prompt",
      "btn-secondary"
    );

    taskTop.append(taskTitle, copyBtn);

    const promptPre = document.createElement("pre");
    promptPre.className = "prompt-preview";
    promptPre.textContent = task.prompt;

    const submitRow = document.createElement("div");
    submitRow.className = "task-submit-row";

    const responseInput = document.createElement("textarea");
    responseInput.className = "task-response-input";
    responseInput.rows = 4;
    responseInput.setAttribute("data-task-id", task.id);
    responseInput.placeholder =
      debate.status === "running"
        ? `Cole aqui a resposta recebida na interface oficial do ${aiName}...`
        : "Debate pausado. Clique em 'Retomar' quando o acesso gratuito estiver disponível.";
    responseInput.disabled = debate.status !== "running";
    responseInput.value = draftResponsesByTaskId.get(task.id) || "";
    responseInput.addEventListener("input", () => {
      draftResponsesByTaskId.set(task.id, responseInput.value);
    });

    const submitActions = document.createElement("div");
    submitActions.className = "task-submit-actions";

    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn-primary";
    saveBtn.innerHTML = `<span>Salvar Resposta de ${escapeHtml(aiName)}</span><span class="cta-arrow" aria-hidden="true">→</span>`;
    saveBtn.disabled = debate.status !== "running";
    saveBtn.addEventListener("click", () =>
      handleSubmitTaskResponse(debate.id, task.id, responseInput, saveBtn)
    );

    submitActions.appendChild(saveBtn);
    submitRow.append(responseInput, submitActions);

    taskBox.append(taskTop, promptPre, submitRow);
    tasksGrid.appendChild(taskBox);
  }

  return tasksGrid;
}

export function renderStreamingMarkdownInto(containerEl, rawText) {
  if (!containerEl) return;
  const wasNearBottom =
    containerEl.scrollHeight - containerEl.scrollTop - containerEl.clientHeight < 48;

  let text = String(rawText || "");
  // Fecha temporariamente bloco de código aberto enquanto está sendo digitado
  const fenceMatches = text.match(/^```/gm);
  if (fenceMatches && fenceMatches.length % 2 === 1) {
    text += "\n```";
  }

  containerEl.replaceChildren();
  if (text.trim()) {
    const mdDom = buildMarkdownDom(text);
    const caret = document.createElement("span");
    caret.className = "streaming-caret";
    caret.setAttribute("aria-hidden", "true");
    const lastChild = mdDom.lastElementChild;
    if (lastChild && lastChild.tagName === "P") {
      lastChild.appendChild(caret);
    } else {
      mdDom.appendChild(caret);
    }
    containerEl.appendChild(mdDom);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "markdown-content";
    const p = document.createElement("p");
    const caret = document.createElement("span");
    caret.className = "streaming-caret";
    caret.setAttribute("aria-hidden", "true");
    p.appendChild(caret);
    placeholder.appendChild(p);
    containerEl.appendChild(placeholder);
  }

  if (wasNearBottom) {
    containerEl.scrollTop = containerEl.scrollHeight;
  }
}

export function scheduleStreamBodyPaint(taskId) {
  pendingStreamPaintIds.add(taskId);
  if (state.streamPaintRafId !== null) return;
  state.streamPaintRafId = requestAnimationFrame(() => {
    state.streamPaintRafId = null;
    const ids = Array.from(pendingStreamPaintIds);
    pendingStreamPaintIds.clear();

    let needsFullRerender = false;
    let paintedAny = false;
    for (const id of ids) {
      const stream = activeStreamsByTaskId.get(id);
      if (!stream || stream.debateId !== state.selectedDebateId) continue;
      const bodyEl = document.getElementById(`stream-body-${id}`);
      if (!bodyEl) {
        needsFullRerender = true;
      } else {
        renderStreamingMarkdownInto(bodyEl, stream.content);
        paintedAny = true;
      }
    }

    if (needsFullRerender) {
      state.lastRenderedChatSignature = "";
      renderChatStage();
    } else if (paintedAny) {
      handleSmartAutoScroll({ smooth: false, label: "Respondendo ao vivo" });
    }
  });
}

export function getStreamingResponsesForStage(debate, turn, roundNum, stageMode, savedResponses) {
  const savedTaskIds = new Set((savedResponses || []).map((r) => r.taskId));
  const isFirstTurn = turn.index === 1;
  const out = [];

  for (const stream of activeStreamsByTaskId.values()) {
    if (stream.debateId !== debate.id) continue;
    if (savedTaskIds.has(stream.taskId)) continue;

    const matchesTurn =
      stream.turnId === turn.id || (isFirstTurn && !stream.turnId);
    if (!matchesTurn) continue;

    if (stageMode === "synthesis") {
      if (stream.stage !== "synthesis") continue;
    } else {
      if (stream.stage === "synthesis") continue;
      if (stream.round !== roundNum) continue;
    }

    out.push({
      id: `stream_${stream.taskId}`,
      taskId: stream.taskId,
      turnId: stream.turnId,
      round: stream.round,
      stage: stream.stage,
      platform: stream.platform,
      content: stream.content,
      submittedAt: stream.startedAt,
      isStreaming: true
    });
  }

  return out;
}

export function getWinnerResponseIdForTurn(turn, turnResponses) {
  const winner = turn?.verdict?.winner;
  if (!winner || winner === "tie") return null;
  const nonSynth = (turnResponses || []).filter((r) => r.stage !== "synthesis");
  let winnerResp = null;
  for (const r of nonSynth) {
    if (r.platform === winner) {
      winnerResp = r;
    }
  }
  return winnerResp ? winnerResp.id : null;
}

export function applyVerdictAutoCollapseIfNeeded(debate, turn, turnResponses) {
  const verdict = turn?.verdict;
  if (!verdict || !verdict.winner || verdict.winner === "tie") return;

  const vKey = `${debate.id}_${turn.id}_${verdict.generatedAt || "v"}`;
  if (appliedVerdictCollapseKeys.has(vKey)) return;
  appliedVerdictCollapseKeys.add(vKey);

  const nonSynth = (turnResponses || []).filter((r) => r.stage !== "synthesis");
  const winnerRespId = getWinnerResponseIdForTurn(turn, nonSynth);
  if (!winnerRespId) return;

  for (const r of nonSynth) {
    if (r.id === winnerRespId) {
      collapsedResponseIds.delete(r.id);
    } else {
      collapsedResponseIds.add(r.id);
    }
  }
}

export async function handleGenerateVerdict(debateId, turnId, judge = "auto") {
  const loadKey = `${debateId}_${turnId}`;
  if (verdictLoadingTurnKeys.has(loadKey)) return;

  const feedback = $("#debate-form-feedback");
  verdictLoadingTurnKeys.add(loadKey);
  state.lastRenderedChatSignature = "";
  renderChatStage();

  try {
    const res = await fetchJson(`/debates/${debateId}/verdict`, {
      method: "POST",
      timeoutMs: 45000,
      body: {
        turnId,
        ...(judge && judge !== "auto" ? { judge } : {})
      }
    });

    if (res?.debate) {
      upsertDebateSessionLocally(res.debate);
    }
    if (feedback) feedback.textContent = "";
    void refreshDashboard();
  } catch (error) {
    if (feedback) {
      feedback.textContent =
        error instanceof Error ? error.message : "Erro ao gerar Veredito.";
    }
  } finally {
    verdictLoadingTurnKeys.delete(loadKey);
    state.lastRenderedChatSignature = "";
    renderChatStage();
    updateRightAiPanel();
  }
}

export function buildResponseCard(debate, resp, turn) {
  const isStreaming = Boolean(resp.isStreaming);
  const matchingTask = (debate.tasks || []).find((t) => t.id === resp.taskId);
  const durationSec = isStreaming
    ? null
    : getCompletedTaskDurationSec(matchingTask, resp);
  const isDirect = turn?.interactionMode === "direct";
  const isNormal = turn?.responseMode === "normal";

  const turnNonSynth = getResponsesForTurn(debate, turn).filter(
    (r) => r.stage !== "synthesis"
  );
  const winnerRespId = !isStreaming
    ? getWinnerResponseIdForTurn(turn, turnNonSynth)
    : null;
  const isVerdictWinner = Boolean(winnerRespId && winnerRespId === resp.id);

  const card = document.createElement("article");
  card.className = `ai-response-card${isStreaming ? " is-streaming" : ""}${isVerdictWinner ? " is-verdict-winner" : ""}`;
  card.id = `resp-card-${resp.id}`;
  card.setAttribute("data-response-platform", resp.platform);
  card.setAttribute("data-scroll-reveal", "");
  if (isStreaming) {
    card.classList.add("is-revealed");
  }
  if (!isStreaming && collapsedResponseIds.has(resp.id)) {
    card.classList.add("is-collapsed");
  }

  const header = document.createElement("header");
  header.className = "ai-response-header";

  const metaLeft = document.createElement("div");
  metaLeft.className = "ai-response-meta-left";

  const monogram = document.createElement("div");
  monogram.className = "ai-monogram";
  monogram.setAttribute("data-brand", resp.platform || "trio");
  monogram.setAttribute("aria-hidden", "true");
  monogram.innerHTML = getAiBrandSvg(resp.platform);

  const titleWrap = document.createElement("div");
  titleWrap.className = "ai-response-title-wrap";

  const titleRow = document.createElement("div");
  titleRow.className = "ai-response-title-row";

  const nameEl = document.createElement("span");
  nameEl.className = "ai-response-name";
  nameEl.textContent = PLATFORMS[resp.platform] || resp.platform;
  titleRow.appendChild(nameEl);

  if (isVerdictWinner) {
    const winBadge = document.createElement("span");
    winBadge.className = "winner-star-badge";
    winBadge.innerHTML = `${SVG_ICONS.star}<span>Recomendada</span>`;
    winBadge.title = "Melhor resposta escolhida no Veredito do Conselho";
    titleRow.appendChild(winBadge);
  }

  if (isStreaming) {
    const liveBadge = document.createElement("span");
    liveBadge.className = "streaming-live-pill";
    liveBadge.textContent = "Ao vivo";
    titleRow.appendChild(liveBadge);
  } else {
    if (resp.interrupted) {
      const stopBadge = document.createElement("span");
      stopBadge.className = "interrupted-badge";
      stopBadge.textContent = "Interrompido";
      stopBadge.title = "Geração interrompida manualmente — clique em ↻ se quiser refazer";
      titleRow.appendChild(stopBadge);
    }
    if (durationSec !== null) {
      const thoughtBadge = document.createElement("span");
      thoughtBadge.className = "thought-duration-pill";
      thoughtBadge.textContent = formatSecondsCompact(durationSec);
      titleRow.appendChild(thoughtBadge);
    }
  }

  const subMeta = document.createElement("div");
  subMeta.className = "ai-response-submeta";

  const roundLabel = document.createElement("span");
  roundLabel.textContent = isStreaming
    ? "Escrevendo..."
    : isDirect
      ? formatShortTime(resp.submittedAt) || formatDate(resp.submittedAt)
      : `R${resp.round} · ${formatShortTime(resp.submittedAt) || formatDate(resp.submittedAt)}`;
  subMeta.appendChild(roundLabel);

  if (!isStreaming && resp.tokens) {
    const tokensSpan = document.createElement("span");
    tokensSpan.textContent = `• ${resp.tokens} tok`;
    subMeta.appendChild(tokensSpan);
  }

  titleWrap.append(titleRow, subMeta);
  metaLeft.append(monogram, titleWrap);

  const actions = document.createElement("div");
  actions.className = "ai-response-actions";

  if (!isStreaming) {
    const isBusy = debate.status === "running";

    const regenBtn = document.createElement("button");
    regenBtn.type = "button";
    regenBtn.className = "icon-btn";
    regenBtn.title = `Regenerar só ${PLATFORMS[resp.platform] || resp.platform}`;
    regenBtn.setAttribute("aria-label", regenBtn.title);
    regenBtn.textContent = "↻";
    regenBtn.disabled = isBusy;
    regenBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      void handleRegenerateResponse(debate.id, resp.id);
    });

    const otherAuto = AUTO_PLATFORM_IDS.filter((p) => p !== resp.platform);
    const reviewWrap = document.createElement("div");
    reviewWrap.className = "review-dropdown-wrap";

    const reviewBtn = document.createElement("button");
    reviewBtn.type = "button";
    reviewBtn.className = "btn-secondary";
    reviewBtn.textContent = "Revisar";
    reviewBtn.title = "Pedir para outra IA revisar esta resposta";
    reviewBtn.disabled = isBusy;

    const reviewMenu = document.createElement("div");
    reviewMenu.className = "review-dropdown-menu";
    reviewMenu.hidden = true;

    for (const candidate of otherAuto) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "review-menu-item";
      item.textContent = `Com ${PLATFORMS[candidate]}`;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        reviewMenu.hidden = true;
        void handleReviewResponse(debate.id, resp.id, candidate);
      });
      reviewMenu.appendChild(item);
    }

    reviewBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const willOpen = reviewMenu.hidden;
      for (const openMenu of $$(".review-dropdown-menu")) {
        openMenu.hidden = true;
      }
      reviewMenu.hidden = !willOpen;
    });

    reviewWrap.append(reviewBtn, reviewMenu);

    const speakBtn = createSpeakButton(resp.content, "btn-secondary", {
      persona: resp.platform,
      label: PLATFORMS[resp.platform] || resp.platform,
      cardId: `resp-card-${resp.id}`
    });

    const copyBtn = createCopyMarkdownButton(
      resp.content,
      isNormal ? "Copiar" : "Copiar .md",
      "btn-secondary"
    );

    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "icon-btn";
    toggleBtn.setAttribute("aria-label", "Minimizar ou expandir resposta");
    toggleBtn.innerHTML = SVG_ICONS.chevronDown;

    const toggleCollapse = () => {
      if (collapsedResponseIds.has(resp.id)) {
        collapsedResponseIds.delete(resp.id);
      } else {
        collapsedResponseIds.add(resp.id);
      }
      card.classList.toggle("is-collapsed");
    };

    metaLeft.addEventListener("click", toggleCollapse);
    toggleBtn.addEventListener("click", toggleCollapse);

    actions.append(regenBtn, reviewWrap, speakBtn, copyBtn, toggleBtn);
  }

  header.append(metaLeft, actions);

  const body = document.createElement("div");
  body.className = "ai-response-body";
  if (isStreaming) {
    body.id = `stream-body-${resp.taskId}`;
    renderStreamingMarkdownInto(body, resp.content);
  } else {
    body.appendChild(buildMarkdownDom(resp.content));
  }

  card.append(header, body);
  return card;
}

/**
 * Constrói a trilha de Horizontal Scroll para comparar as respostas das IAs na rodada
 */

export function buildRoundHorizontalResponsesTrack(debate, roundNum, roundResponses, turn) {
  const isDirect = turn?.interactionMode === "direct";
  const roundKey = `${debate.id}_${turn?.id || "t1"}_r${roundNum}`;
  const isStacked = stackedRoundKeys.has(roundKey);

  // Em modo direto com apenas 1 resposta, exibe o card limpo diretamente sem cabeçalho de comparativo.
  if (isDirect && roundResponses.length === 1) {
    const singleWrap = document.createElement("div");
    singleWrap.className = "direct-single-response-wrap";
    singleWrap.appendChild(buildResponseCard(debate, roundResponses[0], turn));
    return singleWrap;
  }

  const wrapper = document.createElement("div");
  wrapper.className = `round-horizontal-wrapper${isStacked ? " is-stacked" : ""}`;

  // Barra de cabeçalho da trilha horizontal com pulo rápido por IA, barra scroll-linked e alternância de visão
  const hHeader = document.createElement("div");
  hHeader.className = "h-scroll-header";

  const leftGroup = document.createElement("div");
  leftGroup.className = "h-scroll-ai-Tabs";

  const eyebrow = document.createElement("span");
  eyebrow.className = "h-scroll-eyebrow";
  eyebrow.textContent = isDirect
    ? `${roundResponses.length} IAs`
    : `RODADA ${roundNum} (${roundResponses.length} IAs)`;
  leftGroup.appendChild(eyebrow);

  const jumpBtns = [];
  const viewport = document.createElement("div");
  viewport.className = "round-horizontal-viewport";

  const respList = document.createElement("div");
  respList.className = `round-responses-list${roundResponses.length === 1 ? " single-item" : ""}`;

  roundResponses.forEach((resp, idx) => {
    const cardEl = buildResponseCard(debate, resp, turn);
    respList.appendChild(cardEl);

    if (roundResponses.length > 1) {
      const jumpBtn = document.createElement("button");
      jumpBtn.type = "button";
      jumpBtn.className = `h-scroll-ai-jump${idx === 0 ? " is-active" : ""}`;
      jumpBtn.setAttribute("data-jump-platform", resp.platform);
      jumpBtn.textContent = `${PLATFORM_MONOGRAMS[resp.platform] || resp.platform}`;
      jumpBtn.title = `Ver ${PLATFORMS[resp.platform] || resp.platform}`;

      jumpBtn.addEventListener("click", () => {
        for (const item of jumpBtns) {
          item.btn.classList.toggle("is-active", item.card === cardEl);
        }
        cardEl.scrollIntoView({
          behavior: "smooth",
          block: "nearest",
          inline: "nearest"
        });
      });

      jumpBtns.push({ btn: jumpBtn, card: cardEl, platform: resp.platform });
      leftGroup.appendChild(jumpBtn);
    }
  });

  const controls = document.createElement("div");
  controls.className = "h-scroll-controls";

  const modeBtn = document.createElement("button");
  modeBtn.type = "button";
  modeBtn.className = "h-scroll-mode-btn";
  modeBtn.textContent = isStacked ? "⊞ Lado a lado" : "☰ Empilhar";
  modeBtn.title = "Alternar entre cards lado a lado e empilhados";

  modeBtn.addEventListener("click", () => {
    const nowStacked = wrapper.classList.toggle("is-stacked");
    if (nowStacked) {
      stackedRoundKeys.add(roundKey);
      modeBtn.textContent = "⊞ Lado a lado";
    } else {
      stackedRoundKeys.delete(roundKey);
      modeBtn.textContent = "☰ Empilhar";
    }
  });

  if (roundResponses.length > 1) {
    controls.append(modeBtn);
  }

  hHeader.append(leftGroup, controls);
  viewport.appendChild(respList);
  wrapper.append(hHeader, viewport);

  return wrapper;
}

export function buildConclusionCard(debate, turn, turnResponses, isMultiTurn) {
  const conclusionText = turn?.conclusion;
  if (!conclusionText) return null;

  const isNormal = turn?.responseMode === "normal";

  const conclusionBox = document.createElement("section");
  conclusionBox.className = "debate-conclusion-box";
  if (!isMultiTurn) {
    conclusionBox.id = "step-synthesis";
    conclusionBox.setAttribute("data-minimap-section", "step-synthesis");
  }
  conclusionBox.setAttribute("data-scroll-reveal", "");

  const header = document.createElement("div");
  header.className = "conclusion-header";

  const titleGroup = document.createElement("div");
  titleGroup.className = "conclusion-title-group";

  const eyebrow = document.createElement("span");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = isNormal ? "RESPOSTA FINAL" : "SÍNTESE FINAL (.MD)";

  const metaRow = document.createElement("div");
  metaRow.className = "conclusion-meta-row";

  const startMs = Date.parse(turn.createdAt || "");
  const endMs = Date.parse(turn.completedAt || "");
  if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs >= startMs) {
    const durBadge = document.createElement("span");
    durBadge.className = "tag-badge tag-active";
    durBadge.textContent = formatSecondsCompact((endMs - startMs) / 1000);
    metaRow.appendChild(durBadge);
  }

  const synthResp = (turnResponses || []).find((r) => r.stage === "synthesis");
  if (synthResp) {
    const relatorBadge = document.createElement("span");
    relatorBadge.className = "tag-badge tag-neutral";
    relatorBadge.textContent = PLATFORMS[synthResp.platform] || synthResp.platform;
    metaRow.appendChild(relatorBadge);

    if (synthResp.interrupted) {
      const stopBadge = document.createElement("span");
      stopBadge.className = "interrupted-badge";
      stopBadge.textContent = "Interrompido";
      metaRow.appendChild(stopBadge);
    }
  }

  titleGroup.append(eyebrow, metaRow);

  const conclusionActions = document.createElement("div");
  conclusionActions.className = "ai-response-actions";

  if (synthResp) {
    const regenSynthBtn = document.createElement("button");
    regenSynthBtn.type = "button";
    regenSynthBtn.className = "icon-btn";
    regenSynthBtn.title = "Regenerar síntese final";
    regenSynthBtn.setAttribute("aria-label", "Regenerar síntese final");
    regenSynthBtn.textContent = "↻";
    regenSynthBtn.disabled = debate.status === "running";
    regenSynthBtn.addEventListener("click", () => {
      void handleRegenerateResponse(debate.id, synthResp.id);
    });
    conclusionActions.appendChild(regenSynthBtn);
  }

  const speakConclusionBtn = createSpeakButton(conclusionText, "btn-secondary", {
    persona: "judge",
    label: "Síntese Final"
  });
  conclusionActions.appendChild(speakConclusionBtn);

  const copyConclusionBtn = createCopyMarkdownButton(
    conclusionText,
    isNormal ? "Copiar" : "Copiar .md",
    "btn-secondary"
  );
  conclusionActions.appendChild(copyConclusionBtn);

  header.append(titleGroup, conclusionActions);

  const body = buildMarkdownDom(conclusionText);
  conclusionBox.append(header, body);
  return conclusionBox;
}

export function buildWebSourcesPanel(debate, turn) {
  const sources = Array.isArray(turn?.webSources) ? turn.webSources : [];
  if (sources.length === 0) return null;

  const panelKey = `${debate.id}_${turn.id}_web`;
  const isExpanded = expandedWebSourcesTurnKeys.has(panelKey);

  const panel = document.createElement("div");
  panel.className = `web-sources-panel${isExpanded ? " is-expanded" : ""}`;
  panel.setAttribute("data-scroll-reveal", "");

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "web-sources-toggle";
  toggleBtn.setAttribute("aria-expanded", String(isExpanded));

  const left = document.createElement("div");
  left.className = "web-sources-toggle-left";

  const icon = document.createElement("span");
  icon.className = "web-sources-icon";
  icon.innerHTML = SVG_ICONS.globe;

  const label = document.createElement("span");
  label.className = "web-sources-title";
  label.textContent = `Fontes consultadas (${sources.length})`;

  const domainsWrap = document.createElement("div");
  domainsWrap.className = "web-sources-domains-preview";
  const uniqueDomains = Array.from(
    new Set(sources.map((s) => s.domain).filter(Boolean))
  ).slice(0, 3);
  for (const dom of uniqueDomains) {
    const chip = document.createElement("span");
    chip.className = "web-domain-chip";
    chip.textContent = dom;
    domainsWrap.appendChild(chip);
  }
  if (sources.length > uniqueDomains.length) {
    const more = document.createElement("span");
    more.className = "web-domain-chip is-more";
    more.textContent = `+${sources.length - uniqueDomains.length}`;
    domainsWrap.appendChild(more);
  }

  left.append(icon, label, domainsWrap);

  const chevron = document.createElement("span");
  chevron.className = "web-sources-chevron";
  chevron.innerHTML = SVG_ICONS.chevronDown;

  toggleBtn.append(left, chevron);

  const list = document.createElement("div");
  list.className = "web-sources-list";
  list.hidden = !isExpanded;

  for (const src of sources) {
    const item = document.createElement("a");
    item.className = "web-source-item";
    item.href = src.url;
    item.target = "_blank";
    item.rel = "noopener noreferrer";

    const top = document.createElement("div");
    top.className = "web-source-item-top";

    const idxBadge = document.createElement("span");
    idxBadge.className = "web-source-index";
    idxBadge.textContent = `[${src.index}]`;

    const originBadge = document.createElement("span");
    originBadge.className = `web-source-origin origin-${src.origin || "search"}`;
    originBadge.textContent =
      src.origin === "url"
        ? "LINK"
        : src.origin === "grounding"
          ? "GOOGLE"
          : "WEB";

    const titleEl = document.createElement("span");
    titleEl.className = "web-source-item-title";
    titleEl.textContent = src.title || src.domain || src.url;

    const extIcon = document.createElement("span");
    extIcon.className = "web-source-ext-icon";
    extIcon.innerHTML = SVG_ICONS.externalLink;

    top.append(idxBadge, originBadge, titleEl, extIcon);

    const domainEl = document.createElement("div");
    domainEl.className = "web-source-item-domain";
    domainEl.textContent = src.domain || src.url;

    item.append(top, domainEl);

    if (src.snippet) {
      const snippetEl = document.createElement("p");
      snippetEl.className = "web-source-item-snippet";
      snippetEl.textContent = src.snippet;
      item.appendChild(snippetEl);
    }

    list.appendChild(item);
  }

  toggleBtn.addEventListener("click", () => {
    const willExpand = list.hidden;
    list.hidden = !willExpand;
    panel.classList.toggle("is-expanded", willExpand);
    toggleBtn.setAttribute("aria-expanded", String(willExpand));
    if (willExpand) {
      expandedWebSourcesTurnKeys.add(panelKey);
    } else {
      expandedWebSourcesTurnKeys.delete(panelKey);
    }
  });

  panel.append(toggleBtn, list);
  return panel;
}

export function buildCouncilPodcastTracks(turn, turnResponses) {
  const nonSynth = (turnResponses || []).filter((r) => r.stage !== "synthesis");
  const latestByPlatform = new Map();
  for (const r of nonSynth) {
    latestByPlatform.set(r.platform, r);
  }

  const tracks = [];
  for (const resp of latestByPlatform.values()) {
    const aiName = PLATFORMS[resp.platform] || resp.platform;
    tracks.push({
      persona: resp.platform,
      label: aiName,
      text: `${aiName}. ${resp.content}`,
      cardId: `resp-card-${resp.id}`
    });
  }

  if (turn?.verdict?.practicalSummary) {
    const winName =
      turn.verdict.winner && turn.verdict.winner !== "tie"
        ? `Resposta recomendada: ${PLATFORMS[turn.verdict.winner] || turn.verdict.winner}. `
        : "";
    tracks.push({
      persona: "judge",
      label: "Veredito do Conselho",
      text: `Veredito do Conselho. ${winName}${turn.verdict.practicalSummary}`
    });
  } else if (turn?.conclusion) {
    tracks.push({
      persona: "judge",
      label: "Síntese Final",
      text: `Síntese final do Conselho. ${turn.conclusion}`
    });
  }

  return tracks;
}

export function createCouncilPodcastButton(turn, turnResponses) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "btn-secondary council-podcast-btn";
  btn.title = "Ouvir todas as IAs do turno em sequência, cada uma com sua própria voz neural";
  btn.innerHTML = `${SVG_ICONS.volume}<span>Ouvir Conselho</span>`;
  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    const tracks = buildCouncilPodcastTracks(turn, turnResponses);
    playVoiceQueue(tracks, btn);
  });
  return btn;
}

export function buildVerdictSection(debate, turn, turnResponses) {
  const nonSynth = (turnResponses || []).filter((r) => r.stage !== "synthesis");
  const distinctPlatforms = new Set(nonSynth.map((r) => r.platform));
  const verdict = turn?.verdict;
  const loadKey = `${debate.id}_${turn.id}`;
  const isLoading = verdictLoadingTurnKeys.has(loadKey);

  if (!verdict && distinctPlatforms.size < 2) {
    return null;
  }

  // Caso A: Ainda não há Veredito — barra convidativa de 1 clique (+ Ouvir Conselho)
  if (!verdict) {
    const bar = document.createElement("div");
    bar.className = "verdict-trigger-bar";
    bar.setAttribute("data-scroll-reveal", "");

    const info = document.createElement("div");
    info.className = "verdict-trigger-info";
    info.innerHTML = `<span class="verdict-trigger-icon">${SVG_ICONS.scale}</span><span>${
      isLoading
        ? "Juiz comparando consenso, divergências e escolhendo a melhor resposta..."
        : `${distinctPlatforms.size} IAs responderam — ouça o conselho ou gere o Veredito.`
    }</span>`;

    const btnGroup = document.createElement("div");
    btnGroup.className = "verdict-trigger-actions";

    const podcastBtn = createCouncilPodcastButton(turn, turnResponses);

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn-secondary verdict-trigger-btn";
    btn.disabled = isLoading || debate.status === "running";
    btn.innerHTML = `${SVG_ICONS.scale}<span>${isLoading ? "Analisando..." : "Veredito"}</span>`;
    btn.addEventListener("click", () => {
      void handleGenerateVerdict(debate.id, turn.id, "auto");
    });

    btnGroup.append(podcastBtn, btn);
    bar.append(info, btnGroup);
    return bar;
  }

  // Caso B: Veredito gerado e salvo no histórico
  const card = document.createElement("section");
  card.className = "verdict-card";
  card.setAttribute("data-scroll-reveal", "");

  const header = document.createElement("header");
  header.className = "verdict-card-header";

  const headLeft = document.createElement("div");
  headLeft.className = "verdict-header-left";

  const titleBadge = document.createElement("div");
  titleBadge.className = "verdict-eyebrow-row";
  const judgeName = PLATFORMS[verdict.judgePlatform] || verdict.judgePlatform;
  titleBadge.innerHTML = `
    <span class="verdict-scale-icon">${SVG_ICONS.scale}</span>
    <span class="eyebrow">VEREDITO DO CONSELHO</span>
    <span class="verdict-judge-tag">Juiz: ${escapeHtml(judgeName)}</span>
  `;

  const winnerPill = document.createElement("div");
  winnerPill.className = "verdict-winner-pill";
  if (verdict.winner && verdict.winner !== "tie") {
    const winName = PLATFORMS[verdict.winner] || verdict.winner;
    winnerPill.innerHTML = `
      <span class="verdict-winner-star">${SVG_ICONS.star}</span>
      <span class="verdict-winner-brand" data-brand="${escapeHtml(verdict.winner)}">${getAiBrandSvg(verdict.winner)}</span>
      <span>Recomendada: <strong>${escapeHtml(winName)}</strong></span>
    `;
  } else {
    winnerPill.innerHTML = `
      <span class="verdict-winner-star">${SVG_ICONS.scale}</span>
      <span><strong>Empate técnico</strong> entre as IAs</span>
    `;
  }

  headLeft.append(titleBadge, winnerPill);

  const headActions = document.createElement("div");
  headActions.className = "verdict-header-actions";

  const winnerRespId = getWinnerResponseIdForTurn(turn, nonSynth);
  if (winnerRespId && verdict.winner !== "tie") {
    const jumpBtn = document.createElement("button");
    jumpBtn.type = "button";
    jumpBtn.className = "btn-secondary verdict-jump-btn";
    jumpBtn.textContent = `Ir para ${PLATFORMS[verdict.winner] || verdict.winner}`;
    jumpBtn.addEventListener("click", () => {
      const targetCard = document.getElementById(`resp-card-${winnerRespId}`);
      if (targetCard) {
        collapsedResponseIds.delete(winnerRespId);
        targetCard.classList.remove("is-collapsed");
        targetCard.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      }
    });
    headActions.appendChild(jumpBtn);
  }

  if (distinctPlatforms.size >= 2) {
    headActions.appendChild(createCouncilPodcastButton(turn, turnResponses));
  }

  if (verdict.practicalSummary) {
    headActions.appendChild(
      createSpeakButton(verdict.practicalSummary, "btn-secondary", {
        persona: "judge",
        label: "Veredito do Conselho"
      })
    );
    headActions.appendChild(
      createCopyMarkdownButton(
        verdict.practicalSummary,
        "Copiar síntese",
        "btn-secondary"
      )
    );
  }

  // Dropdown "Reavaliar ▾" para trocar o Juiz em 1 clique
  const reevalWrap = document.createElement("div");
  reevalWrap.className = "review-dropdown";

  const reevalBtn = document.createElement("button");
  reevalBtn.type = "button";
  reevalBtn.className = "btn-ghost-pill verdict-reeval-btn";
  reevalBtn.disabled = isLoading || debate.status === "running";
  reevalBtn.textContent = isLoading ? "Analisando..." : "Reavaliar ▾";

  const reevalMenu = document.createElement("div");
  reevalMenu.className = "review-dropdown-menu";
  reevalMenu.hidden = true;

  const judgeOptions = [
    { id: "auto", label: "Auto (melhor cota)" },
    { id: "gemini", label: "Juiz: Gemini" },
    { id: "openrouter", label: "Juiz: OpenRouter" },
    { id: "groq", label: "Juiz: Groq" }
  ];

  for (const opt of judgeOptions) {
    const optBtn = document.createElement("button");
    optBtn.type = "button";
    optBtn.className = "review-dropdown-item";
    optBtn.textContent = opt.label;
    optBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      reevalMenu.hidden = true;
      void handleGenerateVerdict(debate.id, turn.id, opt.id);
    });
    reevalMenu.appendChild(optBtn);
  }

  reevalBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = reevalMenu.hidden;
    for (const openMenu of $$(".review-dropdown-menu, .topbar-ai-menu")) {
      openMenu.hidden = true;
    }
    reevalMenu.hidden = !willOpen;
  });

  reevalWrap.append(reevalBtn, reevalMenu);
  headActions.appendChild(reevalWrap);

  header.append(headLeft, headActions);

  // Corpo com os 4 blocos estruturados
  const grid = document.createElement("div");
  grid.className = "verdict-grid";

  const makeListBlock = (title, items, modClass) => {
    const box = document.createElement("div");
    box.className = `verdict-block ${modClass}`;
    const h = document.createElement("h4");
    h.textContent = title;
    const ul = document.createElement("ul");
    for (const txt of items || []) {
      const li = document.createElement("li");
      li.textContent = txt;
      ul.appendChild(li);
    }
    box.append(h, ul);
    return box;
  };

  grid.appendChild(
    makeListBlock("1. Consenso", verdict.consensus, "verdict-block-consensus")
  );
  grid.appendChild(
    makeListBlock(
      "2. Divergências & Alertas",
      verdict.divergences,
      "verdict-block-divergences"
    )
  );

  const reasonBox = document.createElement("div");
  reasonBox.className = "verdict-block verdict-block-winner";
  const reasonH = document.createElement("h4");
  reasonH.textContent =
    verdict.winner && verdict.winner !== "tie"
      ? `3. Por que ${PLATFORMS[verdict.winner] || verdict.winner} venceu`
      : "3. Avaliação comparativa";
  const reasonP = document.createElement("p");
  reasonP.textContent = verdict.winnerReason || "";
  reasonBox.append(reasonH, reasonP);

  const summaryBox = document.createElement("div");
  summaryBox.className = "verdict-block verdict-block-summary";
  const summaryH = document.createElement("h4");
  summaryH.textContent = "4. Síntese prática";
  const summaryP = document.createElement("p");
  summaryP.textContent = verdict.practicalSummary || "";
  summaryBox.append(summaryH, summaryP);

  grid.append(reasonBox, summaryBox);

  const footNote = document.createElement("div");
  footNote.className = "verdict-footnote";
  footNote.textContent =
    verdict.winner && verdict.winner !== "tie"
      ? "As demais respostas foram recolhidas automaticamente para limpeza visual — clique em qualquer card abaixo para expandir."
      : "Clique em qualquer card abaixo para comparar as respostas completas.";

  card.append(header, grid, footNote);
  return card;
}

export function buildProjectContextPanel(debate, turn) {
  const ctx = turn?.projectContext;
  if (!ctx || !ctx.projectName) return null;

  const chunks = Array.isArray(ctx.chunks) ? ctx.chunks : [];
  if (!ctx.instructionsApplied && chunks.length === 0) return null;

  const panelKey = `${debate.id}_${turn.id}`;
  const isExpanded = expandedProjectContextTurnKeys.has(panelKey);

  const panel = document.createElement("div");
  panel.className = `web-sources-panel project-context-panel${isExpanded ? " is-expanded" : ""}`;
  panel.setAttribute("data-scroll-reveal", "");

  const toggleBtn = document.createElement("button");
  toggleBtn.type = "button";
  toggleBtn.className = "web-sources-toggle";
  toggleBtn.setAttribute("aria-expanded", String(isExpanded));

  const left = document.createElement("div");
  left.className = "web-sources-toggle-left";

  const icon = document.createElement("span");
  icon.className = "web-sources-icon project-context-icon";
  icon.innerHTML = SVG_ICONS.brain;

  const label = document.createElement("span");
  label.className = "web-sources-label";
  const countText =
    chunks.length > 0
      ? `${chunks.length} ${chunks.length === 1 ? "trecho" : "trechos"}`
      : "regras fixas";
  label.textContent = `Contexto do Projeto · ${ctx.projectName} (${countText})`;

  const chipsWrap = document.createElement("div");
  chipsWrap.className = "web-sources-domains-preview";

  if (ctx.instructionsApplied) {
    const instrChip = document.createElement("span");
    instrChip.className = "web-domain-chip project-chip-rules";
    instrChip.textContent = "Regras fixas";
    chipsWrap.appendChild(instrChip);
  }

  if (chunks.length > 0) {
    const modeChip = document.createElement("span");
    modeChip.className = "web-domain-chip";
    modeChip.textContent = ctx.mode === "full" ? "Base completa" : "Busca BM25";
    chipsWrap.appendChild(modeChip);

    const uniqueNames = Array.from(new Set(chunks.map((c) => c.sourceName))).slice(0, 2);
    for (const fileName of uniqueNames) {
      const chip = document.createElement("span");
      chip.className = "web-domain-chip";
      chip.textContent = fileName;
      chipsWrap.appendChild(chip);
    }
  }

  left.append(icon, label, chipsWrap);

  const chevron = document.createElement("span");
  chevron.className = "web-sources-chevron";
  chevron.innerHTML = SVG_ICONS.chevronDown;

  toggleBtn.append(left, chevron);

  const list = document.createElement("div");
  list.className = "web-sources-list project-context-list";
  list.hidden = !isExpanded;

  if (ctx.instructionsApplied) {
    const instrItem = document.createElement("div");
    instrItem.className = "web-source-item project-context-item";
    instrItem.innerHTML = `
      <div class="web-source-item-top">
        <span class="web-source-origin origin-url">REGRAS</span>
        <span class="web-source-item-title">Instruções fixas do projeto "${escapeHtml(ctx.projectName)}"</span>
      </div>
      <div class="web-source-item-snippet">Diretrizes permanentes enviadas automaticamente para todas as IAs nesta conversa.</div>
    `;
    list.appendChild(instrItem);
  }

  chunks.forEach((chunk, idx) => {
    const item = document.createElement("div");
    item.className = "web-source-item project-context-item";
    const originLabel = chunk.origin === "folder" ? "PASTA PC" : "UPLOAD";
    const originClass = chunk.origin === "folder" ? "origin-grounding" : "origin-url";
    const scoreText =
      ctx.mode === "bm25" && Number(chunk.score) > 0
        ? ` · relevância ${Number(chunk.score).toFixed(1)}`
        : "";
    item.innerHTML = `
      <div class="web-source-item-top">
        <span class="web-source-index">[${idx + 1}]</span>
        <span class="web-source-origin ${originClass}">${originLabel}</span>
        <span class="web-source-item-title">${escapeHtml(chunk.sourceName)}</span>
      </div>
      <div class="web-source-item-domain">${escapeHtml(chunk.filePath || chunk.sourceName)}${escapeHtml(scoreText)}</div>
      <div class="web-source-item-snippet">${escapeHtml(chunk.snippet || "")}</div>
    `;
    list.appendChild(item);
  });

  toggleBtn.addEventListener("click", () => {
    const willExpand = list.hidden;
    list.hidden = !willExpand;
    panel.classList.toggle("is-expanded", willExpand);
    toggleBtn.setAttribute("aria-expanded", String(willExpand));
    if (willExpand) {
      expandedProjectContextTurnKeys.add(panelKey);
    } else {
      expandedProjectContextTurnKeys.delete(panelKey);
    }
  });

  panel.append(toggleBtn, list);
  return panel;
}

export function buildTurnBlock(debate, turn, isMultiTurn, isLastTurn) {
  const turnBlock = document.createElement("div");
  turnBlock.className = "chat-turn-block";
  if (isMultiTurn) {
    turnBlock.id = `step-turn-${turn.index}`;
    turnBlock.setAttribute("data-minimap-section", `step-turn-${turn.index}`);
  }

  turnBlock.appendChild(buildTurnUserMessage(debate, turn, isMultiTurn));

  const projectCtxEl = buildProjectContextPanel(debate, turn);
  if (projectCtxEl) {
    turnBlock.appendChild(projectCtxEl);
  }

  const webSourcesEl = buildWebSourcesPanel(debate, turn);
  if (webSourcesEl) {
    turnBlock.appendChild(webSourcesEl);
  }

  if (isLastTurn && debate.pauseInfo) {
    const pauseBanner = document.createElement("div");
    pauseBanner.className = "debate-pause-banner";
    pauseBanner.setAttribute("data-scroll-reveal", "");

    const pauseText = document.createElement("span");
    pauseText.textContent = formatCleanErrorText(debate.pauseInfo.message);
    pauseBanner.appendChild(pauseText);

    const resumeBtn = document.createElement("button");
    resumeBtn.type = "button";
    resumeBtn.className = "btn-primary";
    resumeBtn.innerHTML = `<span>Retomar</span><span class="cta-arrow" aria-hidden="true">→</span>`;
    resumeBtn.addEventListener("click", () => handleResumeDebate(debate.id));
    pauseBanner.appendChild(resumeBtn);

    turnBlock.appendChild(pauseBanner);
  }

  const turnTasks = getTasksForTurn(debate, turn);
  const turnResponses = getResponsesForTurn(debate, turn);

  // Aplica auto-collapse nos cards não vencedores (uma única vez por veredito gerado)
  applyVerdictAutoCollapseIfNeeded(debate, turn, turnResponses);

  // Card de Veredito (ou botão "⚖ Veredito") posicionado logo ACIMA dos cards das IAs
  const verdictEl = buildVerdictSection(debate, turn, turnResponses);
  if (verdictEl) {
    turnBlock.appendChild(verdictEl);
  }

  const isDirect = turn.interactionMode === "direct";

  if (isDirect) {
    const pendingDirect = turnTasks.filter((t) => t.status === "pending");
    const streamingDirect = getStreamingResponsesForStage(
      debate,
      turn,
      1,
      "round",
      turnResponses
    );
    const mergedDirect = [...turnResponses, ...streamingDirect];
    const showThinking = pendingDirect.length > 0 && streamingDirect.length === 0;

    if (showThinking) {
      const stageKey = `${debate.id}_${turn.id}_direct`;
      turnBlock.appendChild(
        buildReasoningBlockForStage(
          debate,
          stageKey,
          1,
          "initial_response",
          turnTasks,
          turnResponses
        )
      );
    }

    if (pendingDirect.length > 0) {
      const manualTasksEl = buildPendingManualTasksForStage(debate, turnTasks);
      if (manualTasksEl) {
        turnBlock.appendChild(manualTasksEl);
      }
    }

    if (mergedDirect.length > 0) {
      turnBlock.appendChild(
        buildRoundHorizontalResponsesTrack(debate, 1, mergedDirect, turn)
      );
    }

    return turnBlock;
  }

  // Modo Debate: rodadas 1..N + síntese
  for (let roundNum = 1; roundNum <= (turn.totalRounds || 1); roundNum++) {
    const roundTasks = turnTasks.filter(
      (t) => t.round === roundNum && t.stage !== "synthesis"
    );
    const roundResponses = turnResponses.filter(
      (r) => r.round === roundNum && r.stage !== "synthesis"
    );
    const streamingRound = getStreamingResponsesForStage(
      debate,
      turn,
      roundNum,
      "round",
      roundResponses
    );
    const mergedRound = [...roundResponses, ...streamingRound];

    if (roundTasks.length === 0 && mergedRound.length === 0) continue;

    const stageType = roundNum === 1 ? "initial_response" : "critique";
    const stageKey = `${debate.id}_${turn.id}_r${roundNum}_${stageType}`;

    const roundSection = document.createElement("section");
    roundSection.className = "chat-round-section";
    if (!isMultiTurn) {
      roundSection.id = `step-round-${roundNum}`;
      roundSection.setAttribute("data-minimap-section", `step-round-${roundNum}`);
    }

    if (roundTasks.length > 0) {
      roundSection.appendChild(
        buildReasoningBlockForStage(
          debate,
          stageKey,
          roundNum,
          stageType,
          roundTasks,
          roundResponses
        )
      );

      const manualTasksEl = buildPendingManualTasksForStage(debate, roundTasks);
      if (manualTasksEl) {
        roundSection.appendChild(manualTasksEl);
      }
    }

    if (mergedRound.length > 0) {
      roundSection.appendChild(
        buildRoundHorizontalResponsesTrack(debate, roundNum, mergedRound, turn)
      );
    }

    turnBlock.appendChild(roundSection);
  }

  const synthTasks = turnTasks.filter((t) => t.stage === "synthesis");
  const synthResponses = turnResponses.filter((r) => r.stage === "synthesis");
  const streamingSynth = getStreamingResponsesForStage(
    debate,
    turn,
    turn.totalRounds || 1,
    "synthesis",
    synthResponses
  );

  if (synthTasks.length > 0) {
    const synthStageKey = `${debate.id}_${turn.id}_synthesis`;
    const synthReasoning = buildReasoningBlockForStage(
      debate,
      synthStageKey,
      turn.totalRounds || 1,
      "synthesis",
      synthTasks,
      synthResponses
    );
    if (!isMultiTurn && !turn.conclusion && streamingSynth.length === 0) {
      synthReasoning.id = "step-synthesis";
      synthReasoning.setAttribute("data-minimap-section", "step-synthesis");
    }
    turnBlock.appendChild(synthReasoning);

    const synthManualEl = buildPendingManualTasksForStage(debate, synthTasks);
    if (synthManualEl) {
      turnBlock.appendChild(synthManualEl);
    }
  }

  const conclusionCard = buildConclusionCard(
    debate,
    turn,
    turnResponses,
    isMultiTurn
  );
  if (conclusionCard) {
    turnBlock.appendChild(conclusionCard);
  } else if (streamingSynth.length > 0) {
    const liveSynth = streamingSynth[0];
    const liveBox = document.createElement("section");
    liveBox.className = "debate-conclusion-box is-streaming is-revealed";
    if (!isMultiTurn) {
      liveBox.id = "step-synthesis";
      liveBox.setAttribute("data-minimap-section", "step-synthesis");
    }

    const header = document.createElement("div");
    header.className = "conclusion-header";

    const titleGroup = document.createElement("div");
    titleGroup.className = "conclusion-title-group";

    const eyebrow = document.createElement("span");
    eyebrow.className = "eyebrow";
    eyebrow.textContent =
      turn.responseMode === "normal" ? "RESPOSTA FINAL" : "SÍNTESE FINAL (.MD)";

    const liveBadge = document.createElement("span");
    liveBadge.className = "streaming-live-pill";
    liveBadge.textContent = `Ao vivo · ${PLATFORMS[liveSynth.platform] || liveSynth.platform}`;

    titleGroup.append(eyebrow, liveBadge);
    header.append(titleGroup);

    const body = document.createElement("div");
    body.id = `stream-body-${liveSynth.taskId}`;
    renderStreamingMarkdownInto(body, liveSynth.content);

    liveBox.append(header, body);
    turnBlock.appendChild(liveBox);
  }

  return turnBlock;
}

export function buildOptimisticTurnElements(baseDebate) {
  const existingTurns = baseDebate ? getSessionTurns(baseDebate) : [];
  const nextIndex = existingTurns.length + 1;
  const isMultiTurn = nextIndex > 1;
  const optTurn = {
    id: `optimistic_turn_${nextIndex}`,
    index: nextIndex,
    prompt: state.optimisticSubmission.topic,
    rules: state.optimisticSubmission.rules,
    participants: state.optimisticSubmission.participants,
    responseMode: state.optimisticSubmission.responseMode,
    interactionMode: state.optimisticSubmission.interactionMode,
    totalRounds: state.optimisticSubmission.totalRounds,
    focus: state.optimisticSubmission.focus,
    currentRound: 1,
    currentStage: "initial_response",
    status: "running",
    attachments: state.optimisticSubmission.attachments || [],
    createdAt: new Date(state.optimisticSubmission.startedAtMs).toISOString()
  };

  const fakeDebate = {
    id: baseDebate?.id || "optimistic",
    title: state.optimisticSubmission.title,
    status: "running",
    totalRounds: state.optimisticSubmission.totalRounds,
    updatedAt: optTurn.createdAt,
    tasks: state.optimisticSubmission.participants.map((p, idx) => ({
      id: `optimistic_${idx}_${p}`,
      turnId: optTurn.id,
      round: 1,
      stage: "initial_response",
      platform: p,
      seat: AUTO_PLATFORM_IDS.includes(p) ? "auto" : "manual",
      status: "pending",
      createdAt: optTurn.createdAt
    })),
    responses: []
  };

  return buildTurnBlock(fakeDebate, optTurn, isMultiTurn, true);
}

export function renderOptimisticChatThread(threadEl) {
  const parentDebate = state.optimisticSubmission.parentDebateId
    ? debateDetailsById.get(state.optimisticSubmission.parentDebateId) ||
      state.latestDebates.find((d) => d.id === state.optimisticSubmission.parentDebateId) ||
      null
    : null;

  threadEl.replaceChildren();
  buildChatRoundMinimap(parentDebate);

  if (parentDebate) {
    const turns = getSessionTurns(parentDebate);
    turns.forEach((turn, idx) => {
      if (idx > 0) {
        const sep = document.createElement("div");
        sep.className = "chat-turn-divider";
        threadEl.appendChild(sep);
      }
      threadEl.appendChild(buildTurnBlock(parentDebate, turn, true, false));
    });
    const sep = document.createElement("div");
    sep.className = "chat-turn-divider";
    threadEl.appendChild(sep);
  }

  threadEl.appendChild(buildOptimisticTurnElements(parentDebate));
  observeScrollRevealElements(threadEl);

  const chatScroll = $("#chat-scroll-area");
  if (chatScroll) {
    requestAnimationFrame(() => {
      chatScroll.scrollTop = chatScroll.scrollHeight;
    });
  }
}

export function renderChatStage() {
  const zeroStateEl = $("#chat-zero-state");
  const threadEl = $("#chat-thread");
  if (!zeroStateEl || !threadEl) return;

  if (state.optimisticSubmission) {
    zeroStateEl.hidden = true;
    threadEl.hidden = false;
    renderOptimisticChatThread(threadEl);
    return;
  }

  const debate = getActiveOrSelectedDebate();

  if (!debate) {
    zeroStateEl.hidden = false;
    threadEl.hidden = true;
    threadEl.replaceChildren();
    state.lastRenderedChatSignature = "";
    buildChatRoundMinimap(null);
    renderZeroStateHorizontalShowcase();
    return;
  }

  zeroStateEl.hidden = true;
  threadEl.hidden = false;

  // Se ainda temos apenas o resumo leve do /status, busca o detalhe completo em /debates/:id.
  const isFullDetail = Array.isArray(debate.tasks) && Array.isArray(debate.responses);
  if (!isFullDetail) {
    if (state.detailFetchInFlightId !== debate.id) {
      void loadDebateDetail(debate.id);
    }
  }

  const activeStreamKeys = Array.from(activeStreamsByTaskId.values())
    .filter((s) => s.debateId === debate.id)
    .map((s) => s.taskId)
    .sort()
    .join(",");

  const signature = `${JSON.stringify(debate)}::streams=${activeStreamKeys}`;
  const activeElement = document.activeElement;
  const isTypingInManualTask =
    activeElement &&
    activeElement.classList &&
    activeElement.classList.contains("task-response-input");

  if (signature === state.lastRenderedChatSignature && isTypingInManualTask) {
    return;
  }

  if (signature === state.lastRenderedChatSignature && threadEl.children.length > 0) {
    return;
  }

  saveCurrentDraftsFromDom();
  state.lastRenderedChatSignature = signature;
  threadEl.replaceChildren();

  buildChatRoundMinimap(debate);

  const turns = getSessionTurns(debate);
  const isMultiTurn = turns.length > 1;
  const savedScrollTop = $("#chat-scroll-area")?.scrollTop ?? 0;
  const wasNearBottomBeforeRender = isChatNearBottom();

  turns.forEach((turn, idx) => {
    if (idx > 0) {
      const sep = document.createElement("div");
      sep.className = "chat-turn-divider";
      threadEl.appendChild(sep);
    }
    const isLastTurn = idx === turns.length - 1;
    threadEl.appendChild(buildTurnBlock(debate, turn, isMultiTurn, isLastTurn));
  });

  observeScrollRevealElements(threadEl);

  const responseCount = Array.isArray(debate.responses) ? debate.responses.length : 0;
  const conclusionCount = turns.filter((t) => Boolean(t.conclusion)).length;
  const contentKey = `${turns.length}:${responseCount}:${conclusionCount}:${activeStreamKeys}`;

  if (state.lastAutoScrollDebateId !== debate.id) {
    state.lastAutoScrollDebateId = debate.id;
    state.lastAutoScrollContentKey = contentKey;
    state.isUserNearChatBottom = true;
    setUnreadScrollPillVisible(false);
    if (debate.status === "running" || turns.length > 1) {
      requestAnimationFrame(() => {
        scrollChatToBottom(false);
        updateChatScrollLinkedEffects();
      });
    } else {
      requestAnimationFrame(updateChatScrollLinkedEffects);
    }
  } else if (contentKey !== state.lastAutoScrollContentKey) {
    state.lastAutoScrollContentKey = contentKey;
    const label = activeStreamKeys
      ? "Respondendo ao vivo"
      : conclusionCount > 0 && debate.status === "completed"
        ? "Síntese pronta"
        : "Nova resposta";
    if (wasNearBottomBeforeRender) {
      handleSmartAutoScroll({ force: true, smooth: true, label });
    } else {
      const chatScroll = $("#chat-scroll-area");
      if (chatScroll) {
        chatScroll.scrollTop = savedScrollTop;
      }
      setUnreadScrollPillVisible(true, label);
    }
    requestAnimationFrame(updateChatScrollLinkedEffects);
  } else {
    requestAnimationFrame(updateChatScrollLinkedEffects);
  }
}

export async function handleRegenerateResponse(debateId, responseId) {
  try {
    const res = await fetchJson(`/debates/${debateId}/regenerate`, {
      method: "POST",
      body: { responseId }
    });
    if (res?.debate) {
      upsertDebateSessionLocally(res.debate);
      for (const t of res.debate.tasks || []) {
        if (t.status === "pending") {
          localTaskStartMs.set(t.id, Date.now());
        }
      }
    }
    state.lastRenderedChatSignature = "";
    updateStageTopbar();
    renderChatStage();
    updateRightAiPanel();
    void refreshDashboard();
  } catch (error) {
    const feedback = $("#debate-form-feedback");
    if (feedback) {
      feedback.textContent =
        error instanceof Error ? error.message : "Erro ao regenerar.";
    }
  }
}

export async function handleReviewResponse(debateId, responseId, reviewer) {
  try {
    const res = await fetchJson(`/debates/${debateId}/review`, {
      method: "POST",
      body: { responseId, reviewer }
    });
    if (res?.debate) {
      upsertDebateSessionLocally(res.debate);
      for (const t of res.debate.tasks || []) {
        if (t.status === "pending") {
          localTaskStartMs.set(t.id, Date.now());
        }
      }
    }
    state.lastRenderedChatSignature = "";
    updateStageTopbar();
    renderChatStage();
    updateRightAiPanel();
    void refreshDashboard();

    const chatScroll = $("#chat-scroll-area");
    if (chatScroll) {
      requestAnimationFrame(() => {
        chatScroll.scrollTop = chatScroll.scrollHeight;
      });
    }
  } catch (error) {
    const feedback = $("#debate-form-feedback");
    if (feedback) {
      feedback.textContent =
        error instanceof Error ? error.message : "Erro ao solicitar revisão.";
    }
  }
}

export async function handleSubmitTaskResponse(
  debateId,
  taskId,
  textareaElement,
  buttonElement
) {
  const content = (textareaElement?.value || "").trim();

  if (!content) {
    alert("Cole a resposta da IA antes de salvar.");
    return;
  }

  try {
    if (buttonElement) {
      buttonElement.disabled = true;
      buttonElement.textContent = "Salvando...";
    }

    const res = await fetchJson(`/debates/${debateId}/respond`, {
      method: "POST",
      body: {
        taskId,
        content
      }
    });

    if (res?.debate) {
      upsertDebateSessionLocally(res.debate);
    }

    draftResponsesByTaskId.delete(taskId);
    state.lastDebatesSignature = "";
    state.lastRenderedChatSignature = "";
    renderChatStage();
    updateRightAiPanel();
    void refreshDashboard();
  } catch (error) {
    alert(
      error instanceof Error
        ? error.message
        : "Não foi possível salvar a resposta."
    );
    if (buttonElement) {
      buttonElement.disabled = false;
      buttonElement.textContent = "Salvar Resposta";
    }
  }
}
