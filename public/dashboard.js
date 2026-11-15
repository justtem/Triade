const REFRESH_INTERVAL = 5000;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

const PLATFORMS = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini Argon"
};

const STAGE_LABELS = {
  initial_response: "Análise Inicial",
  critique: "Crítica Cruzada e Refinamento",
  synthesis: "Síntese e Conclusão Conjunta",
  completed: "Finalizado"
};

const STATUS_LABELS = {
  running: "Em andamento",
  paused_limit: "Pausado (Limite Gratuito Atingido)",
  paused_manual: "Pausado Manualmente",
  completed: "Concluído"
};

const $ = (selector) => document.querySelector(selector);

// Preserva rascunhos de respostas digitadas pelo usuário entre os ciclos de atualização
const draftResponsesByTaskId = new Map();
let lastDebatesSignature = "";

function formatDate(value) {
  if (!value) return "Data não informada";

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return "Data não informada";
  }

  return date.toLocaleString("pt-BR");
}

function getEventDate(event) {
  if (!event || typeof event !== "object") return null;

  return (
    event.observedAt ||
    event.timestamp ||
    event.detectedAt ||
    event.createdAt ||
    event.date ||
    event.time ||
    null
  );
}

function getEventTimestampMs(event) {
  const dateValue = getEventDate(event);
  if (!dateValue) return 0;

  const parsed = Date.parse(dateValue);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sortEventsDescending(events) {
  if (!Array.isArray(events)) return [];

  return [...events].sort(
    (a, b) => getEventTimestampMs(b) - getEventTimestampMs(a)
  );
}

function getEventMessage(event) {
  return (
    event.message ||
    event.text ||
    event.description ||
    event.notice ||
    "Aviso detectado na plataforma."
  );
}

function getEventSeverity(event) {
  return String(event?.severity || "").toLowerCase().trim();
}

function getEventSignal(event) {
  return String(
    event?.signal ||
    event?.type ||
    event?.status ||
    event?.eventType ||
    ""
  ).toLowerCase().trim();
}

function getPlatform(event) {
  return String(event?.platform || event?.source || "").toLowerCase().trim();
}

function getAvailability(event) {
  const severity = getEventSeverity(event);
  const signal = getEventSignal(event);

  if (severity === "blocked") {
    return {
      state: "BLOCKED",
      label: "Limite atingido",
      badgeClass: "blocked",
      className: "offline"
    };
  }

  if (severity === "warning") {
    return {
      state: "WARNING",
      label: "Limite próximo",
      badgeClass: "warning",
      className: "checking"
    };
  }

  if (signal === "usage_limit_reached") {
    return {
      state: "BLOCKED",
      label: "Limite atingido",
      badgeClass: "blocked",
      className: "offline"
    };
  }

  if (signal === "approaching_usage_limit") {
    return {
      state: "WARNING",
      label: "Limite próximo",
      badgeClass: "warning",
      className: "checking"
    };
  }

  return {
    state: "UNKNOWN",
    label: "Desconhecida",
    badgeClass: "unknown",
    className: "checking"
  };
}

function isRecent(event) {
  const timestampMs = getEventTimestampMs(event);
  if (!timestampMs) return false;

  const age = Date.now() - timestampMs;

  return age >= 0 && age <= RECENT_WINDOW_MS;
}

function setText(selector, value) {
  const element = $(selector);

  if (element) {
    element.textContent = value;
  }
}

function setServerStatus(online) {
  const indicator = $("#server-indicator");

  if (indicator) {
    indicator.classList.remove("online", "offline", "checking");
    indicator.classList.add(online ? "online" : "offline");
  }

  setText(
    "#server-status",
    online ? "Servidor online" : "Servidor offline"
  );
}

async function fetchJson(endpoint, options = {}) {
  const response = await fetch(endpoint, {
    method: options.method || "GET",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    cache: "no-store"
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(data.error || `Erro HTTP ${response.status}`);
  }

  return data;
}

function setCardsUnknownOnError() {
  for (const platform of Object.keys(PLATFORMS)) {
    const card = document.querySelector(
      `[data-platform="${platform}"]`
    );

    if (!card) continue;

    const availabilityElement = card.querySelector(
      '[data-field="availability"]'
    );

    const lastEventElement = card.querySelector(
      '[data-field="last-event"]'
    );

    const badge = card.querySelector(".platform-badge");

    if (availabilityElement) {
      availabilityElement.textContent = "Desconhecida";
      availabilityElement.className = "platform-availability checking";
    }

    if (lastEventElement) {
      lastEventElement.textContent = "Servidor inacessível";
    }

    if (badge) {
      badge.textContent = "Desconhecido";
      badge.className = "platform-badge unknown";
    }
  }
}

function updatePlatformCards(sortedEvents) {
  for (const platform of Object.keys(PLATFORMS)) {
    const card = document.querySelector(
      `[data-platform="${platform}"]`
    );

    if (!card) continue;

    const platformEvents = sortedEvents.filter(
      (event) => getPlatform(event) === platform
    );

    const latestEvent = platformEvents[0] || null;

    const availabilityElement = card.querySelector(
      '[data-field="availability"]'
    );

    const lastEventElement = card.querySelector(
      '[data-field="last-event"]'
    );

    const countElement = card.querySelector(
      '[data-field="event-count"]'
    );

    const badge = card.querySelector(".platform-badge");

    const recentEvent =
      latestEvent && isRecent(latestEvent)
        ? latestEvent
        : null;

    if (recentEvent) {
      const availability = getAvailability(recentEvent);

      if (availabilityElement) {
        availabilityElement.textContent = availability.label;
        availabilityElement.className =
          `platform-availability ${availability.className}`;
      }

      if (lastEventElement) {
        lastEventElement.textContent = formatDate(
          getEventDate(recentEvent)
        );
      }

      if (badge) {
        badge.textContent =
          availability.state === "BLOCKED"
            ? "Bloqueado"
            : availability.state === "WARNING"
              ? "Atenção"
              : "Monitorando";
        badge.className = `platform-badge ${availability.badgeClass}`;
      }
    } else {
      if (availabilityElement) {
        availabilityElement.textContent = "Desconhecida (sem alerta)";
        availabilityElement.className =
          "platform-availability checking";
      }

      if (lastEventElement) {
        lastEventElement.textContent = latestEvent
          ? `Último registro: ${formatDate(getEventDate(latestEvent))}`
          : "Nenhum alerta registrado";
      }

      if (badge) {
        badge.textContent = "Sem alerta recente";
        badge.className = "platform-badge unknown";
      }
    }

    if (countElement) {
      countElement.textContent = String(platformEvents.length);
    }
  }
}

function updateHistory(sortedEvents) {
  const historyList = $("#history-list");

  if (!historyList) return;

  historyList.replaceChildren();

  if (sortedEvents.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";

    const icon = document.createElement("span");
    icon.className = "empty-icon";
    icon.textContent = "◷";

    const title = document.createElement("strong");
    title.textContent = "Nenhum evento carregado";

    const desc = document.createElement("p");
    desc.textContent = "Os registros aparecerão aqui quando forem recebidos.";

    emptyState.append(icon, title, desc);
    historyList.appendChild(emptyState);
    setText("#history-counter", "0 eventos");

    return;
  }

  setText(
    "#history-counter",
    `${sortedEvents.length} eventos recentes`
  );

  for (const event of sortedEvents) {
    const platform = getPlatform(event);
    const platformName =
      PLATFORMS[platform] || platform || "Plataforma desconhecida";
    const availability = getAvailability(event);

    const row = document.createElement("div");
    row.className = "history-row";

    const platformCol = document.createElement("span");
    platformCol.className = "history-platform";
    platformCol.textContent = platformName;

    const messageCol = document.createElement("span");
    messageCol.className = "history-message";
    const matchedExcerpt =
      typeof event.matchedText === "string" && event.matchedText.trim()
        ? ` ("${event.matchedText.trim()}")`
        : "";
    messageCol.textContent = `${getEventMessage(event)}${matchedExcerpt}`;

    const dateCol = document.createElement("span");
    dateCol.className = "history-date";
    dateCol.textContent = formatDate(getEventDate(event));

    const badgeCol = document.createElement("span");
    badgeCol.className = `event-badge ${availability.badgeClass}`;
    badgeCol.textContent = availability.label;

    row.append(platformCol, messageCol, dateCol, badgeCol);
    historyList.appendChild(row);
  }
}

function saveCurrentDraftsFromDom() {
  const inputs = document.querySelectorAll(".task-response-input[data-task-id]");
  for (const input of inputs) {
    const taskId = input.getAttribute("data-task-id");
    if (taskId) {
      draftResponsesByTaskId.set(taskId, input.value);
    }
  }
}

function buildDebateCardElement(debate) {
  const card = document.createElement("article");
  card.className = "debate-session-card";

  // Cabeçalho da sessão
  const header = document.createElement("div");
  header.className = "debate-session-header";

  const titleWrap = document.createElement("div");
  titleWrap.className = "debate-session-title";

  const titleEl = document.createElement("h4");
  titleEl.textContent = debate.title;

  const metaEl = document.createElement("p");
  metaEl.className = "debate-session-meta";
  const stageText = STAGE_LABELS[debate.currentStage] || debate.currentStage;
  const participantsList = (debate.participants || [])
    .map((p) => PLATFORMS[p] || p)
    .join(", ");
  metaEl.textContent = `Rodada ${debate.currentRound}/${debate.totalRounds} • Etapa: ${stageText} • Participantes: ${participantsList}`;

  titleWrap.append(titleEl, metaEl);

  const actionsWrap = document.createElement("div");
  actionsWrap.className = "debate-header-actions";

  const statusBadge = document.createElement("span");
  statusBadge.className = `debate-status-badge ${debate.status}`;
  statusBadge.textContent = STATUS_LABELS[debate.status] || debate.status;
  actionsWrap.appendChild(statusBadge);

  if (debate.status === "running") {
    const pauseBtn = document.createElement("button");
    pauseBtn.type = "button";
    pauseBtn.className = "btn-warning";
    pauseBtn.textContent = "Pausar Debate";
    pauseBtn.addEventListener("click", () => handlePauseDebate(debate.id));
    actionsWrap.appendChild(pauseBtn);
  } else if (
    debate.status === "paused_limit" ||
    debate.status === "paused_manual"
  ) {
    const resumeBtn = document.createElement("button");
    resumeBtn.type = "button";
    resumeBtn.className = "btn-success";
    resumeBtn.textContent = "Retomar do Ponto Exato";
    resumeBtn.addEventListener("click", () => handleResumeDebate(debate.id));
    actionsWrap.appendChild(resumeBtn);
  }

  header.append(titleWrap, actionsWrap);
  card.appendChild(header);

  // Banner de Pausa / Proteção de Limite
  if (debate.pauseInfo) {
    const pauseBanner = document.createElement("div");
    pauseBanner.className = "debate-pause-banner";
    pauseBanner.textContent = `${debate.pauseInfo.message} (Pausado em: ${formatDate(debate.pauseInfo.pausedAt)})`;
    card.appendChild(pauseBanner);
  }

  // Tarefas pendentes na etapa atual
  const pendingTasks = (debate.tasks || []).filter(
    (t) => t.status === "pending"
  );

  if (pendingTasks.length > 0 && debate.status !== "completed") {
    const tasksGrid = document.createElement("div");
    tasksGrid.className = "debate-tasks-grid";

    for (const task of pendingTasks) {
      const taskBox = document.createElement("div");
      taskBox.className = "debate-task-box";

      const taskTop = document.createElement("div");
      taskTop.className = "debate-task-top";

      const taskTitle = document.createElement("strong");
      const aiName = PLATFORMS[task.platform] || task.platform;
      taskTitle.textContent = `Tarefa pendente para ${aiName} — Rodada ${task.round} (${STAGE_LABELS[task.stage] || task.stage})`;

      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "btn-secondary";
      copyBtn.textContent = "Copiar Prompt";
      copyBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(task.prompt);
          copyBtn.textContent = "Prompt Copiado!";
          setTimeout(() => {
            copyBtn.textContent = "Copiar Prompt";
          }, 2000);
        } catch {
          copyBtn.textContent = "Selecione manualmente abaixo";
        }
      });

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
          : "Debate pausado. Clique em 'Retomar do Ponto Exato' quando o acesso gratuito estiver disponível.";
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
      saveBtn.textContent = `Salvar Resposta de ${aiName}`;
      saveBtn.disabled = debate.status !== "running";
      saveBtn.addEventListener("click", () =>
        handleSubmitTaskResponse(debate.id, task.id, responseInput, saveBtn)
      );

      submitActions.appendChild(saveBtn);
      submitRow.append(responseInput, submitActions);

      taskBox.append(taskTop, promptPre, submitRow);
      tasksGrid.appendChild(taskBox);
    }

    card.appendChild(tasksGrid);
  }

  // Conclusão conjunta final (quando concluído)
  if (debate.conclusion) {
    const conclusionBox = document.createElement("div");
    conclusionBox.className = "debate-conclusion-box";

    const conclusionTitle = document.createElement("h5");
    conclusionTitle.textContent = "CONCLUSÃO CONJUNTA DO AI COUNCIL";

    const conclusionText = document.createElement("p");
    conclusionText.textContent = debate.conclusion;

    conclusionBox.append(conclusionTitle, conclusionText);
    card.appendChild(conclusionBox);
  }

  // Histórico de respostas já registradas nesta sessão
  if (Array.isArray(debate.responses) && debate.responses.length > 0) {
    const historyWrap = document.createElement("div");
    historyWrap.className = "debate-responses-history";

    for (const resp of debate.responses) {
      const respItem = document.createElement("div");
      respItem.className = "debate-response-item";

      const respHeader = document.createElement("header");
      const leftSpan = document.createElement("span");
      leftSpan.textContent = `${PLATFORMS[resp.platform] || resp.platform} • Rodada ${resp.round} (${STAGE_LABELS[resp.stage] || resp.stage})`;

      const rightSpan = document.createElement("span");
      rightSpan.textContent = formatDate(resp.submittedAt);

      respHeader.append(leftSpan, rightSpan);

      const respContent = document.createElement("p");
      respContent.textContent = resp.content;

      respItem.append(respHeader, respContent);
      historyWrap.appendChild(respItem);
    }

    card.appendChild(historyWrap);
  }

  return card;
}

function updateDebatesSection(debates, activeDebatesCount) {
  const listDebates = Array.isArray(debates) ? debates : [];
  const activeCount = Number(activeDebatesCount) || 0;
  const pausedCount = listDebates.filter(
    (d) => d.status === "paused_limit" || d.status === "paused_manual"
  ).length;

  setText("#active-debates", String(activeCount));

  if (activeCount > 0) {
    setText(
      "#debate-summary",
      `${activeCount} em andamento (${listDebates.length} total)`
    );
  } else if (pausedCount > 0) {
    setText(
      "#debate-summary",
      `${pausedCount} pausado(s) aguardando retomada`
    );
  } else if (listDebates.length > 0) {
    setText(
      "#debate-summary",
      `${listDebates.length} sessão(ões) concluída(s)`
    );
  } else {
    setText("#debate-summary", "Nenhum debate ativo no momento.");
  }

  const container = $("#debates-list-container");
  if (!container) return;

  // Evita recriar o DOM dos debates se nada mudou e o usuário estiver digitando
  const newSignature = JSON.stringify(listDebates);
  const activeElement = document.activeElement;
  const isTypingInDebate =
    activeElement &&
    activeElement.classList &&
    activeElement.classList.contains("task-response-input");

  if (newSignature === lastDebatesSignature && isTypingInDebate) {
    return;
  }

  saveCurrentDraftsFromDom();
  lastDebatesSignature = newSignature;
  container.replaceChildren();

  if (listDebates.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";

    const icon = document.createElement("span");
    icon.className = "empty-icon";
    icon.textContent = "⚖";

    const title = document.createElement("strong");
    title.textContent = "Nenhuma sessão de debate registrada";

    const desc = document.createElement("p");
    desc.textContent =
      "Crie um debate acima para gerar os prompts contextuais de cada IA e acompanhar as rodadas.";

    emptyState.append(icon, title, desc);
    container.appendChild(emptyState);
    return;
  }

  for (const debate of listDebates) {
    container.appendChild(buildDebateCardElement(debate));
  }
}

async function handleCreateDebate(event) {
  event.preventDefault();

  const titleInput = $("#debate-title");
  const topicInput = $("#debate-topic");
  const rulesInput = $("#debate-rules");
  const roundsSelect = $("#debate-rounds");
  const feedback = $("#debate-form-feedback");

  const checkboxes = document.querySelectorAll(
    'input[name="participants"]:checked'
  );
  const participants = Array.from(checkboxes).map((cb) => cb.value);

  if (participants.length < 2) {
    if (feedback) {
      feedback.textContent = "Selecione pelo menos 2 inteligências participantes.";
    }
    return;
  }

  try {
    if (feedback) {
      feedback.textContent = "Criando sessão de debate...";
    }

    await fetchJson("/debates", {
      method: "POST",
      body: {
        title: titleInput?.value || "",
        topic: topicInput?.value || "",
        rules: rulesInput?.value || "",
        participants,
        totalRounds: Number(roundsSelect?.value) || 2
      }
    });

    if (titleInput) titleInput.value = "";
    if (topicInput) topicInput.value = "";
    if (feedback) {
      feedback.textContent = "Debate criado com sucesso!";
      setTimeout(() => {
        feedback.textContent = "";
      }, 3000);
    }

    lastDebatesSignature = "";
    await refreshDashboard();
  } catch (error) {
    if (feedback) {
      feedback.textContent =
        error instanceof Error ? error.message : "Erro ao criar debate.";
    }
  }
}

async function handleSubmitTaskResponse(
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

    await fetchJson(`/debates/${debateId}/respond`, {
      method: "POST",
      body: {
        taskId,
        content
      }
    });

    draftResponsesByTaskId.delete(taskId);
    lastDebatesSignature = "";
    await refreshDashboard();
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

async function handlePauseDebate(debateId) {
  try {
    await fetchJson(`/debates/${debateId}/pause`, {
      method: "POST",
      body: {
        reason: "Debate pausado manualmente pelo painel. Estado integralmente preservado."
      }
    });

    lastDebatesSignature = "";
    await refreshDashboard();
  } catch (error) {
    alert(
      error instanceof Error ? error.message : "Falha ao pausar o debate."
    );
  }
}

async function handleResumeDebate(debateId) {
  try {
    await fetchJson(`/debates/${debateId}/resume`, {
      method: "POST",
      body: {}
    });

    lastDebatesSignature = "";
    await refreshDashboard();
  } catch (error) {
    alert(
      error instanceof Error ? error.message : "Falha ao retomar o debate."
    );
  }
}

function updateDashboard(data) {
  const rawEvents = Array.isArray(data.latestEvents)
    ? data.latestEvents
    : [];

  const sortedEvents = sortEventsDescending(rawEvents);
  const totalEvents = Number(data.totalEvents) || 0;

  setText("#total-events", String(totalEvents));
  setText("#monitor-status", "Monitoramento local ativo");

  updatePlatformCards(sortedEvents);
  updateHistory(sortedEvents);
  updateDebatesSection(data.debates, data.activeDebatesCount);
}

async function refreshDashboard() {
  try {
    const [health, status] = await Promise.all([
      fetchJson("/health"),
      fetchJson("/status")
    ]);

    if (
      health.status &&
      String(health.status).toLowerCase() !== "online"
    ) {
      throw new Error("Servidor não está online.");
    }

    setServerStatus(true);
    updateDashboard(status);
  } catch (error) {
    console.error("[AI Council] Erro ao atualizar painel:", error);

    setServerStatus(false);
    setCardsUnknownOnError();

    setText(
      "#monitor-status",
      "Estado desconhecido: sem conexão"
    );
  }
}

function updateClock() {
  setText(
    "#system-clock",
    new Date().toLocaleString("pt-BR")
  );
}

function initializeDashboard() {
  console.log("[AI Council] Painel iniciado.");

  const createForm = $("#create-debate-form");
  if (createForm) {
    createForm.addEventListener("submit", handleCreateDebate);
  }

  updateClock();
  refreshDashboard();

  setInterval(updateClock, 1000);
  setInterval(refreshDashboard, REFRESH_INTERVAL);
}

document.addEventListener("DOMContentLoaded", initializeDashboard);