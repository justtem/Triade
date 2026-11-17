const IDLE_REFRESH_INTERVAL = 4500;
const ACTIVE_REFRESH_INTERVAL = 1500;
const LIVE_TIMER_INTERVAL = 100;
const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

const PLATFORMS = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  groq: "Groq",
  openrouter: "OpenRouter"
};

const PLATFORM_MONOGRAMS = {
  gemini: "GE",
  groq: "GQ",
  openrouter: "OR",
  chatgpt: "GPT",
  claude: "CL"
};

const AUTO_PLATFORM_IDS = ["gemini", "groq", "openrouter"];
const ALL_PLATFORM_IDS = ["gemini", "groq", "openrouter", "chatgpt", "claude"];

const STAGE_LABELS = {
  initial_response: "Análise Inicial",
  critique: "Crítica Cruzada e Refinamento",
  synthesis: "Síntese e Conclusão Conjunta",
  completed: "Finalizado"
};

const STATUS_LABELS = {
  running: "Em andamento",
  paused_limit: "Pausado (Limite Gratuito Atingido)",
  paused_error: "Pausado (Erro no Provedor)",
  paused_manual: "Pausado Manualmente",
  completed: "Concluído"
};

const FOCUS_LABELS = {
  geral: "Geral",
  backend: "Backend / código",
  frontend: "Frontend (sem cara de IA)"
};

// Ícones SVG Monoline
const SVG_ICONS = {
  clipboard: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
  check: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
  chevronDown: `<svg class="accordion-chevron" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`,
  pulse: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>`,
  clock: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 15"></polyline></svg>`,
  pause: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`,
  user: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

// ============================================================================
// ESTADO REATIVO DA APLICAÇÃO
// ============================================================================

const draftResponsesByTaskId = new Map();
const collapsedStageKeys = new Set();
const collapsedResponseIds = new Set();
const localTaskStartMs = new Map();

let currentView = "chat"; // "chat" | "dashboard" | "history"
let selectedDebateId = null;
let hasInitializedSelection = false;
let latestDebates = [];
let latestEvents = [];
let latestProviders = [];
let lastDebatesSignature = "";
let lastRenderedChatSignature = "";

// Estado otimista imediato enquanto a requisição POST /debates está sendo enviada
let optimisticSubmission = null;
let refreshTimerId = null;

// ============================================================================
// FORMATAÇÃO DE DATAS E CRONÔMETROS DE ALTA PRECISÃO
// ============================================================================

function formatDate(value) {
  if (!value) return "Data não informada";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Data não informada";
  return date.toLocaleString("pt-BR");
}

function formatShortTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function formatStopwatch(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(safe / 60);
  const rem = safe - mins * 60;
  const secsInt = Math.floor(rem);
  const tenths = Math.floor((rem - secsInt) * 10);
  const mm = String(mins).padStart(2, "0");
  const ss = String(secsInt).padStart(2, "0");
  return `${mm}:${ss}.${tenths}s`;
}

function formatSecondsCompact(seconds) {
  const safe = Math.max(0.1, Number(seconds) || 0.1);
  if (safe >= 60) {
    const mins = Math.floor(safe / 60);
    const rem = (safe - mins * 60).toFixed(1);
    return `${mins}m ${rem}s`;
  }
  return `${safe.toFixed(1)}s`;
}

function formatSecondsPadded(seconds) {
  const safe = Math.max(0.1, Number(seconds) || 0.1);
  if (safe < 10) {
    return `0${safe.toFixed(1)}s`;
  }
  return `${safe.toFixed(1)}s`;
}

function getTaskStartMs(task, debate) {
  if (!task) return Date.now();
  if (localTaskStartMs.has(task.id)) {
    return localTaskStartMs.get(task.id);
  }

  const createdMs = Date.parse(task.createdAt || "");
  const updatedMs = Date.parse(debate?.updatedAt || "");
  const now = Date.now();

  let startMs = !Number.isNaN(createdMs) ? createdMs : now;

  if (!Number.isNaN(updatedMs) && updatedMs > startMs + 120_000 && task.status === "pending") {
    startMs = updatedMs;
  }

  if (startMs > now) {
    startMs = now;
  }

  localTaskStartMs.set(task.id, startMs);
  return startMs;
}

function getCompletedTaskDurationSec(task, matchingResponse) {
  const startMs = Date.parse(task?.createdAt || "");
  const endMs = Date.parse(task?.completedAt || matchingResponse?.submittedAt || "");
  if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs >= startMs) {
    return Math.max(0.1, (endMs - startMs) / 1000);
  }
  return null;
}

function getDebateTotalDurationSec(debate) {
  if (!debate) return null;
  const startMs = Date.parse(debate.createdAt || "");
  const endMs = Date.parse(
    debate.completedAt ||
      (debate.responses && debate.responses.length > 0
        ? debate.responses[debate.responses.length - 1].submittedAt
        : "")
  );

  if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs >= startMs) {
    return Math.max(0.1, (endMs - startMs) / 1000);
  }
  return null;
}

// ============================================================================
// RENDERIZADOR MARKDOWN SEGURO + BLOCOS DE CÓDIGO COM BOTÃO DE COPIAR
// ============================================================================

function escapeHtml(raw) {
  return String(raw || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatInlineMarkdown(escapedLine) {
  return escapedLine
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function buildMarkdownDom(markdownText) {
  const container = document.createElement("div");
  container.className = "markdown-content";

  const raw = String(markdownText || "").replace(/\r\n/g, "\n").trim();
  if (!raw) return container;

  const segments = [];
  const fenceRegex = /```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g;
  let lastIndex = 0;
  let match;

  while ((match = fenceRegex.exec(raw)) !== null) {
    if (match.index > lastIndex) {
      segments.push({
        type: "prose",
        content: raw.slice(lastIndex, match.index)
      });
    }
    segments.push({
      type: "code",
      lang: (match[1] || "code").trim(),
      content: match[2].replace(/\n$/, "")
    });
    lastIndex = fenceRegex.lastIndex;
  }

  if (lastIndex < raw.length) {
    segments.push({
      type: "prose",
      content: raw.slice(lastIndex)
    });
  }

  for (const seg of segments) {
    if (seg.type === "code") {
      const codeWrapper = document.createElement("div");
      codeWrapper.className = "code-block-wrapper";

      const codeHeader = document.createElement("div");
      codeHeader.className = "code-block-header";

      const langSpan = document.createElement("span");
      langSpan.className = "code-lang-label";
      langSpan.textContent = seg.lang || "código";

      const copyCodeBtn = document.createElement("button");
      copyCodeBtn.type = "button";
      copyCodeBtn.className = "btn-copy-code";
      copyCodeBtn.innerHTML = `${SVG_ICONS.clipboard}<span>Copiar código</span>`;
      copyCodeBtn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(seg.content);
          copyCodeBtn.innerHTML = `${SVG_ICONS.check}<span>Copiado</span>`;
          setTimeout(() => {
            copyCodeBtn.innerHTML = `${SVG_ICONS.clipboard}<span>Copiar código</span>`;
          }, 1800);
        } catch {
          copyCodeBtn.textContent = "Erro ao copiar";
        }
      });

      codeHeader.append(langSpan, copyCodeBtn);

      const pre = document.createElement("pre");
      pre.className = "code-block-pre";
      const codeEl = document.createElement("code");
      codeEl.textContent = seg.content;
      pre.appendChild(codeEl);

      codeWrapper.append(codeHeader, pre);
      container.appendChild(codeWrapper);
      continue;
    }

    const lines = seg.content.split("\n");
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (!trimmed) {
        i++;
        continue;
      }

      if (/^---+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
        container.appendChild(document.createElement("hr"));
        i++;
        continue;
      }

      const headingMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (headingMatch) {
        const level = Math.min(4, headingMatch[1].length);
        const h = document.createElement(`h${level}`);
        h.innerHTML = formatInlineMarkdown(escapeHtml(headingMatch[2]));
        container.appendChild(h);
        i++;
        continue;
      }

      if (
        trimmed.startsWith("|") &&
        i + 1 < lines.length &&
        /^\|\s*[-:]+/.test(lines[i + 1].trim())
      ) {
        const tableWrap = document.createElement("div");
        tableWrap.className = "md-table-wrap";
        const table = document.createElement("table");
        table.className = "md-table";

        const parseRow = (rowStr) =>
          rowStr
            .trim()
            .replace(/^\|/, "")
            .replace(/\|$/, "")
            .split("|")
            .map((c) => c.trim());

        const headers = parseRow(trimmed);
        const thead = document.createElement("thead");
        const trHead = document.createElement("tr");
        for (const hText of headers) {
          const th = document.createElement("th");
          th.innerHTML = formatInlineMarkdown(escapeHtml(hText));
          trHead.appendChild(th);
        }
        thead.appendChild(trHead);
        table.appendChild(thead);

        i += 2;
        const tbody = document.createElement("tbody");
        while (i < lines.length && lines[i].trim().startsWith("|")) {
          const cells = parseRow(lines[i]);
          const tr = document.createElement("tr");
          for (const cText of cells) {
            const td = document.createElement("td");
            td.innerHTML = formatInlineMarkdown(escapeHtml(cText));
            tr.appendChild(td);
          }
          tbody.appendChild(tr);
          i++;
        }
        table.appendChild(tbody);
        tableWrap.appendChild(table);
        container.appendChild(tableWrap);
        continue;
      }

      if (/^[-*]\s+/.test(trimmed)) {
        const ul = document.createElement("ul");
        while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
          const itemText = lines[i].trim().replace(/^[-*]\s+/, "");
          const li = document.createElement("li");
          li.innerHTML = formatInlineMarkdown(escapeHtml(itemText));
          ul.appendChild(li);
          i++;
        }
        container.appendChild(ul);
        continue;
      }

      if (/^\d+\.\s+/.test(trimmed)) {
        const ol = document.createElement("ol");
        while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
          const itemText = lines[i].trim().replace(/^\d+\.\s+/, "");
          const li = document.createElement("li");
          li.innerHTML = formatInlineMarkdown(escapeHtml(itemText));
          ol.appendChild(li);
          i++;
        }
        container.appendChild(ol);
        continue;
      }

      if (trimmed.startsWith(">")) {
        const bq = document.createElement("blockquote");
        const quoteLines = [];
        while (i < lines.length && lines[i].trim().startsWith(">")) {
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ""));
          i++;
        }
        bq.innerHTML = formatInlineMarkdown(escapeHtml(quoteLines.join(" ")));
        container.appendChild(bq);
        continue;
      }

      const paraLines = [];
      while (
        i < lines.length &&
        lines[i].trim() !== "" &&
        !/^(#{1,4}\s|[-*]\s|\d+\.\s|---|\*\*\*|\||>)/.test(lines[i].trim())
      ) {
        paraLines.push(lines[i].trim());
        i++;
      }
      if (paraLines.length > 0) {
        const p = document.createElement("p");
        p.innerHTML = formatInlineMarkdown(escapeHtml(paraLines.join(" ")));
        container.appendChild(p);
      } else {
        i++;
      }
    }
  }

  return container;
}

// ============================================================================
// UTILITÁRIOS DE EVENTOS E MONITORAMENTO
// ============================================================================

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
  return [...events].sort((a, b) => getEventTimestampMs(b) - getEventTimestampMs(a));
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
    event?.signal || event?.type || event?.status || event?.eventType || ""
  )
    .toLowerCase()
    .trim();
}

function getPlatform(event) {
  return String(event?.platform || event?.source || "").toLowerCase().trim();
}

function getAvailability(event) {
  const severity = getEventSeverity(event);
  const signal = getEventSignal(event);

  if (severity === "blocked" || signal === "usage_limit_reached") {
    return {
      state: "BLOCKED",
      label: "Limite atingido",
      badgeClass: "blocked",
      className: "offline"
    };
  }

  if (severity === "warning" || signal === "approaching_usage_limit") {
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
  setText("#server-status", online ? "Servidor online" : "Servidor offline");
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

function createCopyMarkdownButton(markdownText, defaultLabel, className = "btn-secondary") {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = className;
  btn.innerHTML = `${SVG_ICONS.clipboard}<span>${escapeHtml(defaultLabel)}</span>`;

  btn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(markdownText);
      btn.innerHTML = `${SVG_ICONS.check}<span>Markdown Copiado</span>`;
      setTimeout(() => {
        btn.innerHTML = `${SVG_ICONS.clipboard}<span>${escapeHtml(defaultLabel)}</span>`;
      }, 2000);
    } catch {
      btn.textContent = "Selecione manualmente abaixo";
    }
  });

  return btn;
}

// ============================================================================
// NAVEGAÇÃO ENTRE ABAS E PAINÉIS RETRÁTEIS
// ============================================================================

function switchView(targetView) {
  currentView = targetView;

  for (const navBtn of $$("[data-view-target]")) {
    const isMatch = navBtn.getAttribute("data-view-target") === targetView;
    navBtn.classList.toggle("active", isMatch);
  }

  for (const section of $$(".stage-view")) {
    const isMatch = section.getAttribute("data-view") === targetView;
    section.classList.toggle("active", isMatch);
    section.hidden = !isMatch;
  }

  updateStageTopbar();
  closeMobileDrawers();
}

function selectDebate(debateId) {
  selectedDebateId = debateId;
  lastRenderedChatSignature = "";
  if (currentView !== "chat") {
    switchView("chat");
  } else {
    renderSidebarDebatesList();
    renderChatStage();
    updateStageTopbar();
    updateRightAiPanel();
  }
  closeMobileDrawers();
}

function startNewDebateView() {
  selectedDebateId = null;
  optimisticSubmission = null;
  lastRenderedChatSignature = "";
  switchView("chat");
  renderSidebarDebatesList();
  renderChatStage();
  updateStageTopbar();
  updateRightAiPanel();

  const topicInput = $("#debate-topic");
  if (topicInput) {
    topicInput.focus();
  }
}

function closeMobileDrawers() {
  $("#left-sidebar")?.classList.remove("is-open");
  $("#right-ai-panel")?.classList.remove("is-open");
  $("#mobile-backdrop")?.classList.remove("is-visible");
}

// ============================================================================
// TOPBAR SIMPLIFICADA DO CHAT / VIEW ATUAL
// ============================================================================

function getActiveOrSelectedDebate() {
  if (selectedDebateId) {
    const found = latestDebates.find((d) => d.id === selectedDebateId);
    if (found) return found;
  }
  return null;
}

function getReferenceDebateForRightPanel() {
  const selected = getActiveOrSelectedDebate();
  if (selected) return selected;
  return latestDebates.find((d) => d.status === "running") || null;
}

function updateStageTopbar() {
  const titleEl = $("#topbar-title");
  const actionsWrap = $("#topbar-debate-actions");

  if (!titleEl || !actionsWrap) return;

  actionsWrap.replaceChildren();

  if (currentView === "dashboard") {
    titleEl.textContent = "Resumo & Monitoramento";
    return;
  }

  if (currentView === "history") {
    titleEl.textContent = "Atividade & Histórico";
    return;
  }

  // View === "chat"
  if (optimisticSubmission) {
    titleEl.textContent = optimisticSubmission.title;
    const runningBadge = document.createElement("span");
    runningBadge.className = "debate-status-badge running";
    runningBadge.textContent = "Pensando...";
    actionsWrap.appendChild(runningBadge);
    return;
  }

  const debate = getActiveOrSelectedDebate();

  if (!debate) {
    titleEl.textContent = "Novo Debate";
    return;
  }

  titleEl.textContent = debate.title;

  const statusBadge = document.createElement("span");
  statusBadge.className = `debate-status-badge ${debate.status}`;
  statusBadge.textContent = STATUS_LABELS[debate.status] || debate.status;
  actionsWrap.appendChild(statusBadge);

  if (debate.status === "running") {
    const pauseBtn = document.createElement("button");
    pauseBtn.type = "button";
    pauseBtn.className = "btn-secondary";
    pauseBtn.innerHTML = `${SVG_ICONS.pause}<span>Pausar</span>`;
    pauseBtn.addEventListener("click", () => handlePauseDebate(debate.id));
    actionsWrap.appendChild(pauseBtn);
  } else if (
    debate.status === "paused_limit" ||
    debate.status === "paused_error" ||
    debate.status === "paused_manual"
  ) {
    const resumeBtn = document.createElement("button");
    resumeBtn.type = "button";
    resumeBtn.className = "btn-primary";
    resumeBtn.innerHTML = `<span>Retomar</span><span class="cta-arrow" aria-hidden="true">→</span>`;
    resumeBtn.addEventListener("click", () => handleResumeDebate(debate.id));
    actionsWrap.appendChild(resumeBtn);
  }
}

// ============================================================================
// SIDEBAR ESQUERDA: LISTA DE CONVERSAS / DEBATES
// ============================================================================

function renderSidebarDebatesList() {
  const listEl = $("#sidebar-debate-list");
  const countEl = $("#sidebar-debates-count");
  if (!listEl) return;

  if (countEl) {
    countEl.textContent = String(latestDebates.length);
  }

  listEl.replaceChildren();

  if (latestDebates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "Nenhum debate registrado";
    listEl.appendChild(empty);
    return;
  }

  for (const debate of latestDebates) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "conversation-item";
    if (debate.id === selectedDebateId && currentView === "chat") {
      btn.classList.add("active");
    }

    const topRow = document.createElement("div");
    topRow.className = "conversation-item-top";

    const titleSpan = document.createElement("span");
    titleSpan.className = "conversation-title";
    titleSpan.textContent = debate.title;

    const statePill = document.createElement("span");
    const isRunning = debate.status === "running";
    statePill.className = `conv-state-pill${isRunning ? " running" : ""}`;
    statePill.textContent = isRunning
      ? "Ativo"
      : debate.status === "completed"
        ? "OK"
        : "Pausa";

    topRow.append(titleSpan, statePill);

    const metaRow = document.createElement("div");
    metaRow.className = "conversation-meta";

    const statusText = document.createElement("span");
    statusText.textContent =
      debate.status === "running"
        ? `R${debate.currentRound}/${debate.totalRounds} • Pensando`
        : debate.status === "completed"
          ? `${debate.totalRounds} rodadas`
          : `R${debate.currentRound}/${debate.totalRounds} • Pausado`;

    const dateText = document.createElement("span");
    dateText.textContent = formatShortTime(debate.updatedAt || debate.createdAt);

    metaRow.append(statusText, dateText);
    btn.append(topRow, metaRow);

    btn.addEventListener("click", () => {
      selectDebate(debate.id);
    });

    listEl.appendChild(btn);
  }
}

// ============================================================================
// PALCO CENTRAL: CONSTRUÇÃO DO FLUXO DE MENSAGENS DO CHAT DE DEBATE
// ============================================================================

function saveCurrentDraftsFromDom() {
  const inputs = $$(".task-response-input[data-task-id]");
  for (const input of inputs) {
    const taskId = input.getAttribute("data-task-id");
    if (taskId) {
      draftResponsesByTaskId.set(taskId, input.value);
    }
  }
}

function buildUserPromptMessage(debate) {
  const userCard = document.createElement("article");
  userCard.className = "chat-user-message";

  const header = document.createElement("div");
  header.className = "chat-user-header";

  const author = document.createElement("span");
  author.className = "chat-user-author";
  author.innerHTML = `${SVG_ICONS.user}<span>Problema Enviado</span>`;

  const time = document.createElement("span");
  time.className = "chat-user-time";
  time.textContent = formatDate(debate.createdAt);

  header.append(author, time);

  const title = document.createElement("h3");
  title.className = "chat-user-title";
  title.textContent = debate.title;

  const topic = document.createElement("div");
  topic.className = "chat-user-topic";
  topic.textContent = debate.topic;

  const tagsRow = document.createElement("div");
  tagsRow.className = "chat-user-tags";

  const participantsNames = (debate.participants || [])
    .map((p) => PLATFORMS[p] || p)
    .join(", ");

  const tagParticipants = document.createElement("span");
  tagParticipants.className = "chat-config-tag";
  tagParticipants.textContent = `IAs: ${participantsNames}`;

  const tagRounds = document.createElement("span");
  tagRounds.className = "chat-config-tag";
  tagRounds.textContent = `${debate.totalRounds} rodada(s) + Síntese`;

  const tagFocus = document.createElement("span");
  tagFocus.className = "chat-config-tag";
  tagFocus.textContent = `Foco: ${FOCUS_LABELS[debate.focus] || "Geral"}`;

  tagsRow.append(tagParticipants, tagRounds, tagFocus);

  userCard.append(header, title, topic, tagsRow);
  return userCard;
}

function buildReasoningBlockForStage(debate, stageKey, roundNumber, stageType, stageTasks, stageResponses) {
  const pendingTasks = stageTasks.filter((t) => t.status === "pending");
  const isStageRunning = pendingTasks.length > 0 && debate.status === "running";
  const isStagePaused = pendingTasks.length > 0 && debate.status !== "running";

  const block = document.createElement("div");
  block.className = "thinking-reasoning-block";
  if (isStageRunning) {
    block.classList.add("is-active");
  }

  // Rodadas concluídas recolhem por padrão; rodadas ativas abrem por padrão
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
    const baseName = PLATFORMS[task.platform] || task.platform;
    const modelSuffix = resp?.model
      ? ` (${resp.model})`
      : task.seat === "auto"
        ? " (auto)"
        : " (manual)";
    nameEl.textContent = `${baseName}${modelSuffix}`;

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
      stepStatus.textContent = `Falha: ${task.lastError}`;
    } else {
      stepStatus.textContent = "Pausado";
    }

    stepItem.append(stepLeft, stepStatus);
    stepsBody.appendChild(stepItem);
  }

  block.append(headerBtn, stepsBody);
  return block;
}

function buildPendingManualTasksForStage(debate, stageTasks) {
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

    const taskTop = document.createElement("div");
    taskTop.className = "debate-task-top";

    const taskTitle = document.createElement("strong");
    const aiName = PLATFORMS[task.platform] || task.platform;
    taskTitle.textContent = `Tarefa pendente para ${aiName} — Rodada ${task.round} (${STAGE_LABELS[task.stage] || task.stage})`;

    if (task.seat === "auto") {
      const autoNote = document.createElement("div");
      autoNote.className = "task-auto-note";
      autoNote.textContent = `Automático (API) — última falha: ${task.lastError}`;
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

function buildResponseCard(debate, resp) {
  const matchingTask = (debate.tasks || []).find((t) => t.id === resp.taskId);
  const durationSec = getCompletedTaskDurationSec(matchingTask, resp);

  const card = document.createElement("article");
  card.className = "ai-response-card";
  if (collapsedResponseIds.has(resp.id)) {
    card.classList.add("is-collapsed");
  }

  const header = document.createElement("header");
  header.className = "ai-response-header";

  const metaLeft = document.createElement("div");
  metaLeft.className = "ai-response-meta-left";

  const monogram = document.createElement("div");
  monogram.className = "ai-monogram";
  monogram.textContent = PLATFORM_MONOGRAMS[resp.platform] || "AI";

  const titleWrap = document.createElement("div");
  titleWrap.className = "ai-response-title-wrap";

  const titleRow = document.createElement("div");
  titleRow.className = "ai-response-title-row";

  const nameEl = document.createElement("span");
  nameEl.className = "ai-response-name";
  nameEl.textContent = PLATFORMS[resp.platform] || resp.platform;
  titleRow.appendChild(nameEl);

  if (resp.model) {
    const modelBadge = document.createElement("span");
    modelBadge.className = "ai-response-model";
    modelBadge.textContent = resp.model;
    titleRow.appendChild(modelBadge);
  }

  if (durationSec !== null) {
    const thoughtBadge = document.createElement("span");
    thoughtBadge.className = "thought-duration-pill";
    thoughtBadge.textContent = `Pensou por ${formatSecondsCompact(durationSec)}`;
    titleRow.appendChild(thoughtBadge);
  }

  const subMeta = document.createElement("div");
  subMeta.className = "ai-response-submeta";

  const roundLabel = document.createElement("span");
  roundLabel.textContent = `Rodada ${resp.round} (${STAGE_LABELS[resp.stage] || resp.stage}) • ${formatDate(resp.submittedAt)}`;
  subMeta.appendChild(roundLabel);

  if (resp.tokens) {
    const tokensSpan = document.createElement("span");
    tokensSpan.textContent = `• ${resp.tokens} tokens`;
    subMeta.appendChild(tokensSpan);
  }

  titleWrap.append(titleRow, subMeta);
  metaLeft.append(monogram, titleWrap);

  const actions = document.createElement("div");
  actions.className = "ai-response-actions";

  const copyBtn = createCopyMarkdownButton(
    resp.content,
    "Copiar Markdown",
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

  actions.append(copyBtn, toggleBtn);
  header.append(metaLeft, actions);

  const body = document.createElement("div");
  body.className = "ai-response-body";
  body.appendChild(buildMarkdownDom(resp.content));

  card.append(header, body);
  return card;
}

function buildConclusionCard(debate) {
  if (!debate.conclusion) return null;

  const conclusionBox = document.createElement("section");
  conclusionBox.className = "debate-conclusion-box";

  const header = document.createElement("div");
  header.className = "conclusion-header";

  const titleGroup = document.createElement("div");
  titleGroup.className = "conclusion-title-group";

  const eyebrow = document.createElement("span");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "SÍNTESE E CONCLUSÃO CONJUNTA DO AI COUNCIL (MARKDOWN)";

  const title = document.createElement("h4");
  title.textContent = `Consenso Final — ${debate.title}`;

  const metaRow = document.createElement("div");
  metaRow.className = "conclusion-meta-row";

  const totalDur = getDebateTotalDurationSec(debate);
  if (totalDur !== null) {
    const durBadge = document.createElement("span");
    durBadge.className = "tag-badge tag-active";
    durBadge.textContent = `Concluído em ${formatSecondsCompact(totalDur)}`;
    metaRow.appendChild(durBadge);
  }

  const synthResp = (debate.responses || []).find((r) => r.stage === "synthesis");
  if (synthResp) {
    const relatorBadge = document.createElement("span");
    relatorBadge.className = "tag-badge tag-neutral";
    relatorBadge.textContent = `Relator: ${PLATFORMS[synthResp.platform] || synthResp.platform}${synthResp.model ? ` (${synthResp.model})` : ""}`;
    metaRow.appendChild(relatorBadge);
  }

  titleGroup.append(eyebrow, title, metaRow);

  const copyConclusionBtn = createCopyMarkdownButton(
    debate.conclusion,
    "Copiar Síntese (.md)",
    "btn-secondary"
  );

  header.append(titleGroup, copyConclusionBtn);

  const body = buildMarkdownDom(debate.conclusion);
  conclusionBox.append(header, body);
  return conclusionBox;
}

function renderOptimisticChatThread(threadEl) {
  threadEl.replaceChildren();

  const fakeDebate = {
    title: optimisticSubmission.title,
    topic: optimisticSubmission.topic,
    participants: optimisticSubmission.participants,
    totalRounds: optimisticSubmission.totalRounds,
    focus: optimisticSubmission.focus,
    rules: optimisticSubmission.rules,
    createdAt: new Date(optimisticSubmission.startedAtMs).toISOString(),
    updatedAt: new Date(optimisticSubmission.startedAtMs).toISOString(),
    status: "running",
    tasks: optimisticSubmission.participants.map((p, idx) => ({
      id: `optimistic_${idx}_${p}`,
      round: 1,
      stage: "initial_response",
      platform: p,
      seat: AUTO_PLATFORM_IDS.includes(p) ? "auto" : "manual",
      status: "pending",
      createdAt: new Date(optimisticSubmission.startedAtMs).toISOString()
    })),
    responses: []
  };

  threadEl.appendChild(buildUserPromptMessage(fakeDebate));
  threadEl.appendChild(
    buildReasoningBlockForStage(
      fakeDebate,
      "optimistic_r1",
      1,
      "initial_response",
      fakeDebate.tasks,
      []
    )
  );
}

function renderChatStage() {
  const zeroStateEl = $("#chat-zero-state");
  const threadEl = $("#chat-thread");
  if (!zeroStateEl || !threadEl) return;

  if (optimisticSubmission) {
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
    lastRenderedChatSignature = "";
    return;
  }

  zeroStateEl.hidden = true;
  threadEl.hidden = false;

  const signature = JSON.stringify(debate);
  const activeElement = document.activeElement;
  const isTypingInManualTask =
    activeElement &&
    activeElement.classList &&
    activeElement.classList.contains("task-response-input");

  if (signature === lastRenderedChatSignature && isTypingInManualTask) {
    return;
  }

  if (signature === lastRenderedChatSignature && threadEl.children.length > 0) {
    return;
  }

  saveCurrentDraftsFromDom();
  lastRenderedChatSignature = signature;
  threadEl.replaceChildren();

  // 1. Mensagem do Usuário
  threadEl.appendChild(buildUserPromptMessage(debate));

  // 2. Banner de Pausa (se houver)
  if (debate.pauseInfo) {
    const pauseBanner = document.createElement("div");
    pauseBanner.className = "debate-pause-banner";

    const pauseText = document.createElement("span");
    pauseText.textContent = `${debate.pauseInfo.message} (${formatDate(debate.pauseInfo.pausedAt)})`;
    pauseBanner.appendChild(pauseText);

    const resumeBtn = document.createElement("button");
    resumeBtn.type = "button";
    resumeBtn.className = "btn-primary";
    resumeBtn.innerHTML = `<span>Retomar do Ponto Exato</span><span class="cta-arrow" aria-hidden="true">→</span>`;
    resumeBtn.addEventListener("click", () => handleResumeDebate(debate.id));
    pauseBanner.appendChild(resumeBtn);

    threadEl.appendChild(pauseBanner);
  }

  // 3. Rodadas 1 .. N
  const tasks = Array.isArray(debate.tasks) ? debate.tasks : [];
  const responses = Array.isArray(debate.responses) ? debate.responses : [];

  for (let roundNum = 1; roundNum <= debate.totalRounds; roundNum++) {
    const roundTasks = tasks.filter(
      (t) => t.round === roundNum && t.stage !== "synthesis"
    );
    const roundResponses = responses.filter(
      (r) => r.round === roundNum && r.stage !== "synthesis"
    );

    if (roundTasks.length === 0 && roundResponses.length === 0) continue;

    const stageType = roundNum === 1 ? "initial_response" : "critique";
    const stageKey = `${debate.id}_r${roundNum}_${stageType}`;

    const roundSection = document.createElement("section");
    roundSection.className = "chat-round-section";

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

    if (roundResponses.length > 0) {
      const respList = document.createElement("div");
      respList.className = "round-responses-list";
      for (const resp of roundResponses) {
        respList.appendChild(buildResponseCard(debate, resp));
      }
      roundSection.appendChild(respList);
    }

    threadEl.appendChild(roundSection);
  }

  // 4. Etapa de Síntese + Conclusão Final
  const synthTasks = tasks.filter((t) => t.stage === "synthesis");
  const synthResponses = responses.filter((r) => r.stage === "synthesis");

  if (synthTasks.length > 0) {
    const synthStageKey = `${debate.id}_synthesis`;
    threadEl.appendChild(
      buildReasoningBlockForStage(
        debate,
        synthStageKey,
        debate.totalRounds,
        "synthesis",
        synthTasks,
        synthResponses
      )
    );

    const synthManualEl = buildPendingManualTasksForStage(debate, synthTasks);
    if (synthManualEl) {
      threadEl.appendChild(synthManualEl);
    }
  }

  const conclusionCard = buildConclusionCard(debate);
  if (conclusionCard) {
    threadEl.appendChild(conclusionCard);
  }
}

// ============================================================================
// COLUNA 3: DOCK COMPACTO DAS 3 IAs AUTOMÁTICAS (GEMINI, GROQ, OPENROUTER)
// ============================================================================

function updateRightAiPanel() {
  const refDebate = optimisticSubmission
    ? {
        title: optimisticSubmission.title,
        status: "running",
        currentRound: 1,
        totalRounds: optimisticSubmission.totalRounds,
        currentStage: "initial_response",
        participants: optimisticSubmission.participants,
        updatedAt: new Date(optimisticSubmission.startedAtMs).toISOString(),
        tasks: optimisticSubmission.participants.map((p, i) => ({
          id: `opt_${i}`,
          round: 1,
          stage: "initial_response",
          platform: p,
          seat: AUTO_PLATFORM_IDS.includes(p) ? "auto" : "manual",
          status: "pending",
          createdAt: new Date(optimisticSubmission.startedAtMs).toISOString()
        })),
        responses: []
      }
    : getReferenceDebateForRightPanel();

  const roundIndicator = $("#ai-panel-round-indicator");
  if (roundIndicator) {
    if (!refDebate) {
      roundIndicator.textContent = "Em repouso";
    } else if (refDebate.status === "running") {
      roundIndicator.textContent = `Ativo • R${refDebate.currentRound}/${refDebate.totalRounds}`;
    } else if (refDebate.status === "completed") {
      const totalSec = getDebateTotalDurationSec(refDebate);
      roundIndicator.textContent = totalSec
        ? `Concluído (${formatSecondsCompact(totalSec)})`
        : "Concluído";
    } else {
      roundIndicator.textContent = "Pausado";
    }
  }

  const mobileStrip = $("#mobile-ai-strip");
  if (mobileStrip) {
    mobileStrip.replaceChildren();
  }

  // Itera apenas sobre as 3 IAs automáticas presentes no dock lateral direito
  for (const platform of AUTO_PLATFORM_IDS) {
    const card = document.querySelector(`[data-ai-card="${platform}"]`);
    const badge = document.querySelector(`[data-ai-badge="${platform}"]`);
    const quotaValue = document.querySelector(`[data-ai-quota-value="${platform}"]`);
    const quotaFill = document.querySelector(`[data-ai-quota-fill="${platform}"]`);

    if (!card || !badge) continue;

    // 1. Limite compacto (Linha 2): apenas reqHoje/reqMax req + micro-barra 2px
    const providerInfo = latestProviders.find((p) => p.id === platform);
    const usage = providerInfo?.usage;

    if (usage) {
      if (quotaValue) {
        quotaValue.textContent = `${usage.requestsToday}/${usage.requestsDailyCap} req`;
      }
      if (quotaFill) {
        const pct = Math.min(
          100,
          Math.round((usage.requestsToday / Math.max(1, usage.requestsDailyCap)) * 100)
        );
        quotaFill.style.width = `${pct}%`;
      }
    } else if (providerInfo && !providerInfo.ready) {
      if (quotaValue) quotaValue.textContent = "sem chave";
      if (quotaFill) quotaFill.style.width = "0%";
    } else {
      if (quotaValue) quotaValue.textContent = "0/-- req";
      if (quotaFill) quotaFill.style.width = "0%";
    }

    // 2. Estado de Execução na Linha 1 (Pronto | Pensando 00:00.0s | ✔ Concluído • Xs)
    card.classList.remove("is-thinking", "is-completed");
    badge.removeAttribute("data-live-start-ms");

    let execState = "idle";
    let activeTask = null;
    let latestCompletedTask = null;
    let latestCompletedResp = null;

    if (refDebate) {
      const pTasks = (refDebate.tasks || []).filter((t) => t.platform === platform);
      activeTask = pTasks.find(
        (t) =>
          t.status === "pending" &&
          t.round === refDebate.currentRound &&
          t.stage === refDebate.currentStage
      );

      const completedTasks = pTasks.filter((t) => t.status === "completed");
      if (completedTasks.length > 0) {
        latestCompletedTask = completedTasks[completedTasks.length - 1];
        latestCompletedResp = (refDebate.responses || []).find(
          (r) => r.taskId === latestCompletedTask.id
        );
      }

      if (activeTask && refDebate.status === "running") {
        execState = "thinking";
      } else if (latestCompletedTask) {
        execState = "completed";
      }
    }

    if (execState === "thinking" && activeTask) {
      card.classList.add("is-thinking");
      const startMs = getTaskStartMs(activeTask, refDebate);
      const elapsedSec = (Date.now() - startMs) / 1000;

      badge.className = "ai-exec-badge thinking";
      badge.textContent = formatStopwatch(elapsedSec);
      badge.setAttribute("data-live-start-ms", String(startMs));

      if (mobileStrip) {
        const chip = document.createElement("span");
        chip.className = "mobile-ai-chip is-thinking";
        chip.textContent = `${PLATFORMS[platform]} ${formatSecondsPadded(elapsedSec)}`;
        chip.setAttribute("data-mobile-live-start-ms", String(startMs));
        chip.setAttribute("data-mobile-monogram", PLATFORMS[platform]);
        mobileStrip.appendChild(chip);
      }
    } else if (execState === "completed" && latestCompletedTask) {
      card.classList.add("is-completed");
      const durSec = getCompletedTaskDurationSec(latestCompletedTask, latestCompletedResp);
      const durText = durSec ? formatSecondsCompact(durSec) : "OK";

      badge.className = "ai-exec-badge completed";
      badge.textContent = `✔ Concluído • ${durText}`;

      if (mobileStrip) {
        const chip = document.createElement("span");
        chip.className = "mobile-ai-chip";
        chip.textContent = `${PLATFORMS[platform]} ✔ ${durText}`;
        mobileStrip.appendChild(chip);
      }
    } else {
      badge.className = "ai-exec-badge neutral";
      if (providerInfo && !providerInfo.ready) {
        badge.textContent = "Sem chave";
      } else if (usage && usage.requestsToday >= usage.requestsDailyCap) {
        badge.textContent = "Limite";
      } else {
        badge.textContent = "Pronto";
      }

      if (mobileStrip) {
        const chip = document.createElement("span");
        chip.className = "mobile-ai-chip";
        chip.textContent = `${PLATFORMS[platform]} • ${badge.textContent}`;
        mobileStrip.appendChild(chip);
      }
    }
  }
}

// Loop de 100ms para atualizar todos os cronômetros ao vivo sem reconstruir o DOM
function tickLiveTimers() {
  const now = Date.now();

  for (const el of $$("[data-live-start-ms]")) {
    const startMs = Number(el.getAttribute("data-live-start-ms"));
    if (Number.isFinite(startMs) && startMs > 0) {
      el.textContent = formatStopwatch((now - startMs) / 1000);
    }
  }

  for (const el of $$("[data-live-stage-start]")) {
    const startMs = Number(el.getAttribute("data-live-stage-start"));
    if (Number.isFinite(startMs) && startMs > 0) {
      el.textContent = formatStopwatch((now - startMs) / 1000);
    }
  }

  for (const el of $$("[data-live-task-start]")) {
    const startMs = Number(el.getAttribute("data-live-task-start"));
    const prefix = el.getAttribute("data-live-task-prefix") || "Pensando há ";
    if (Number.isFinite(startMs) && startMs > 0) {
      el.textContent = `${prefix}${formatSecondsCompact((now - startMs) / 1000)}...`;
    }
  }

  for (const el of $$("[data-mobile-live-start-ms]")) {
    const startMs = Number(el.getAttribute("data-mobile-live-start-ms"));
    const monogram = el.getAttribute("data-mobile-monogram") || "AI";
    if (Number.isFinite(startMs) && startMs > 0) {
      el.textContent = `${monogram} ${formatSecondsPadded((now - startMs) / 1000)}`;
    }
  }
}

// ============================================================================
// ATUALIZAÇÃO DAS VIEWS DE DASHBOARD E HISTÓRICO (MANTÉM OS 5 PROVEDORES)
// ============================================================================

function setCardsUnknownOnError() {
  for (const platform of ALL_PLATFORM_IDS) {
    const card = document.querySelector(`[data-platform="${platform}"]`);
    if (!card) continue;

    const availabilityElement = card.querySelector('[data-field="availability"]');
    const lastEventElement = card.querySelector('[data-field="last-event"]');
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
  for (const platform of ALL_PLATFORM_IDS) {
    const card = document.querySelector(`[data-platform="${platform}"]`);
    if (!card) continue;

    const platformEvents = sortedEvents.filter((event) => getPlatform(event) === platform);
    const latestEvent = platformEvents[0] || null;

    const availabilityElement = card.querySelector('[data-field="availability"]');
    const lastEventElement = card.querySelector('[data-field="last-event"]');
    const countElement = card.querySelector('[data-field="event-count"]');
    const badge = card.querySelector(".platform-badge");

    const recentEvent = latestEvent && isRecent(latestEvent) ? latestEvent : null;

    if (recentEvent) {
      const availability = getAvailability(recentEvent);
      if (availabilityElement) {
        availabilityElement.textContent = availability.label;
        availabilityElement.className = `platform-availability ${availability.className}`;
      }
      if (lastEventElement) {
        lastEventElement.textContent = formatDate(getEventDate(recentEvent));
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
        availabilityElement.textContent = "Sem alerta recente";
        availabilityElement.className = "platform-availability checking";
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

function updateProviderCards(providers) {
  if (!Array.isArray(providers)) return;

  for (const provider of providers) {
    if (!AUTO_PLATFORM_IDS.includes(provider.id)) continue;

    const card = document.querySelector(`[data-platform="${provider.id}"]`);
    if (!card) continue;

    const availabilityElement = card.querySelector('[data-field="availability"]');
    const usageElement = card.querySelector('[data-field="last-event"]');
    const badge = card.querySelector(".platform-badge");
    const usage = provider.usage;

    const exhausted = usage && usage.requestsToday >= usage.requestsDailyCap;

    let label = "Pronto (API automática)";
    let badgeText = "Pronto";
    let badgeClass = "ready";
    let stateClass = "online";

    if (!provider.ready) {
      label = provider.reason || "Não configurado";
      badgeText = "Sem chave";
      badgeClass = "blocked";
      stateClass = "offline";
    } else if (exhausted) {
      label = "Limite diário local atingido";
      badgeText = "Limite diário";
      badgeClass = "warning";
      stateClass = "checking";
    }

    if (availabilityElement) {
      availabilityElement.textContent = label;
      availabilityElement.className = `platform-availability ${stateClass}`;
    }

    if (usageElement) {
      const labelSpan = usageElement.previousElementSibling;
      if (labelSpan) labelSpan.textContent = "Uso hoje";

      usageElement.textContent = usage
        ? `${usage.requestsToday}/${usage.requestsDailyCap} req` +
          (usage.tokensDailyCap
            ? ` • ${usage.tokensToday}/${usage.tokensDailyCap} tokens`
            : "")
        : "Sem dados";
    }

    if (badge) {
      badge.textContent = badgeText;
      badge.className = `platform-badge ${badgeClass}`;
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

    const title = document.createElement("strong");
    title.textContent = "Nenhum evento carregado";

    const desc = document.createElement("p");
    desc.textContent = "Os registros aparecerão aqui quando forem recebidos.";

    emptyState.append(title, desc);
    historyList.appendChild(emptyState);
    setText("#history-counter", "0 eventos");
    return;
  }

  setText("#history-counter", `${sortedEvents.length} eventos recentes`);

  for (const event of sortedEvents) {
    const platform = getPlatform(event);
    const platformName = PLATFORMS[platform] || platform || "Plataforma desconhecida";
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

function updateDashboardDebatesSummary(debates, activeDebatesCount) {
  const listDebates = Array.isArray(debates) ? debates : [];
  const activeCount = Number(activeDebatesCount) || 0;
  const pausedCount = listDebates.filter(
    (d) =>
      d.status === "paused_limit" ||
      d.status === "paused_error" ||
      d.status === "paused_manual"
  ).length;

  setText("#active-debates", String(activeCount));

  if (activeCount > 0) {
    setText("#debate-summary", `${activeCount} em andamento (${listDebates.length} total)`);
  } else if (pausedCount > 0) {
    setText("#debate-summary", `${pausedCount} pausado(s) aguardando retomada`);
  } else if (listDebates.length > 0) {
    setText("#debate-summary", `${listDebates.length} sessão(ões) concluída(s)`);
  } else {
    setText("#debate-summary", "Nenhum debate ativo no momento.");
  }

  const container = $("#debates-list-container");
  if (!container) return;

  container.replaceChildren();

  if (listDebates.length === 0) {
    const emptyState = document.createElement("div");
    emptyState.className = "empty-state";
    const title = document.createElement("strong");
    title.textContent = "Nenhuma sessão de debate registrada";
    const desc = document.createElement("p");
    desc.textContent = "Inicie um novo debate no Chat Central para acompanhar as rodadas.";
    emptyState.append(title, desc);
    container.appendChild(emptyState);
    return;
  }

  for (const debate of listDebates) {
    const row = document.createElement("article");
    row.className = "dashboard-debate-row";

    const info = document.createElement("div");
    info.className = "dashboard-debate-info";

    const h4 = document.createElement("h4");
    h4.textContent = debate.title;

    const p = document.createElement("p");
    const stageText = STAGE_LABELS[debate.currentStage] || debate.currentStage;
    const partNames = (debate.participants || []).map((id) => PLATFORMS[id] || id).join(", ");
    p.textContent = `Rodada ${debate.currentRound}/${debate.totalRounds} • ${stageText} • Participantes: ${partNames}`;

    info.append(h4, p);

    const badge = document.createElement("span");
    badge.className = `debate-status-badge ${debate.status}`;
    badge.textContent = STATUS_LABELS[debate.status] || debate.status;

    row.append(info, badge);
    row.addEventListener("click", () => selectDebate(debate.id));
    container.appendChild(row);
  }
}

// ============================================================================
// AÇÕES DO USUÁRIO: CRIAR DEBATE, ENVIAR RESPOSTA MANUAL, PAUSAR E RETOMAR
// ============================================================================

function generateTitleFromTopic(topicText) {
  const clean = String(topicText || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "Debate em Consenso";
  if (clean.length <= 64) return clean;
  const sliced = clean.slice(0, 64);
  const lastSpace = sliced.lastIndexOf(" ");
  return `${(lastSpace > 24 ? sliced.slice(0, lastSpace) : sliced).trim()}...`;
}

async function handleCreateDebate(event) {
  event.preventDefault();

  const titleInput = $("#debate-title");
  const topicInput = $("#debate-topic");
  const rulesInput = $("#debate-rules");
  const roundsSelect = $("#debate-rounds");
  const focusSelect = $("#debate-focus");
  const feedback = $("#debate-form-feedback");
  const submitBtn = $("#composer-submit-btn");

  const topicValue = (topicInput?.value || "").trim();
  if (!topicValue) {
    if (feedback) {
      feedback.textContent = "Digite o problema para iniciar.";
    }
    topicInput?.focus();
    return;
  }

  const rawTitle = (titleInput?.value || "").trim();
  const finalTitle = rawTitle || generateTitleFromTopic(topicValue);

  const checkboxes = $$('input[name="participants"]:checked');
  const participants = checkboxes.map((cb) => cb.value);

  if (participants.length < 2) {
    if (feedback) {
      feedback.textContent = "Selecione ao menos 2 IAs.";
    }
    return;
  }

  const totalRounds = Number(roundsSelect?.value) || 2;
  const focus = focusSelect?.value || "geral";
  const rules = (rulesInput?.value || "").trim();

  optimisticSubmission = {
    title: finalTitle,
    topic: topicValue,
    participants,
    totalRounds,
    focus,
    rules,
    startedAtMs: Date.now()
  };

  if (currentView !== "chat") {
    switchView("chat");
  }
  updateStageTopbar();
  renderChatStage();
  updateRightAiPanel();

  try {
    if (submitBtn) submitBtn.disabled = true;
    if (feedback) feedback.textContent = "Iniciando...";

    const result = await fetchJson("/debates", {
      method: "POST",
      body: {
        title: finalTitle,
        topic: topicValue,
        rules: rules || undefined,
        participants,
        totalRounds,
        focus
      }
    });

    optimisticSubmission = null;

    if (titleInput) titleInput.value = "";
    if (topicInput) {
      topicInput.value = "";
      topicInput.style.height = "auto";
    }

    if (result?.debate?.id) {
      selectedDebateId = result.debate.id;
      for (const t of result.debate.tasks || []) {
        localTaskStartMs.set(t.id, Date.now());
      }
    }

    if (feedback) {
      feedback.textContent = "";
    }

    lastDebatesSignature = "";
    lastRenderedChatSignature = "";
    await refreshDashboard();
  } catch (error) {
    optimisticSubmission = null;
    renderChatStage();
    updateRightAiPanel();
    if (feedback) {
      feedback.textContent =
        error instanceof Error ? error.message : "Erro ao criar debate.";
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
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
    lastRenderedChatSignature = "";
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
    lastRenderedChatSignature = "";
    await refreshDashboard();
  } catch (error) {
    alert(error instanceof Error ? error.message : "Falha ao pausar o debate.");
  }
}

async function handleResumeDebate(debateId) {
  try {
    const res = await fetchJson(`/debates/${debateId}/resume`, {
      method: "POST",
      body: {}
    });

    if (res?.debate?.tasks) {
      const now = Date.now();
      for (const t of res.debate.tasks) {
        if (t.status === "pending") {
          localTaskStartMs.set(t.id, now);
        }
      }
    }

    lastDebatesSignature = "";
    lastRenderedChatSignature = "";
    await refreshDashboard();
  } catch (error) {
    alert(error instanceof Error ? error.message : "Falha ao retomar o debate.");
  }
}

// ============================================================================
// CICLO DE ATUALIZAÇÃO E SINCRONIZAÇÃO COM O BACKEND
// ============================================================================

function scheduleNextRefresh() {
  if (refreshTimerId) {
    clearTimeout(refreshTimerId);
  }
  const hasRunningDebate =
    Boolean(optimisticSubmission) ||
    latestDebates.some((d) => d.status === "running");

  const delay = hasRunningDebate ? ACTIVE_REFRESH_INTERVAL : IDLE_REFRESH_INTERVAL;
  refreshTimerId = setTimeout(() => {
    void refreshDashboard();
  }, delay);
}

function updateDashboard(data, providers) {
  const rawEvents = Array.isArray(data.latestEvents) ? data.latestEvents : [];
  const sortedEvents = sortEventsDescending(rawEvents);
  const totalEvents = Number(data.totalEvents) || 0;

  latestEvents = sortedEvents;
  latestDebates = Array.isArray(data.debates) ? data.debates : [];
  if (Array.isArray(providers)) {
    latestProviders = providers;
  }

  if (!hasInitializedSelection) {
    hasInitializedSelection = true;
    const runningDebate = latestDebates.find((d) => d.status === "running");
    if (runningDebate) {
      selectedDebateId = runningDebate.id;
    }
  } else if (
    selectedDebateId &&
    !latestDebates.some((d) => d.id === selectedDebateId)
  ) {
    selectedDebateId = null;
  }

  setText("#total-events", String(totalEvents));
  setText("#monitor-status", "Monitoramento local ativo");

  updatePlatformCards(sortedEvents);
  updateProviderCards(latestProviders);
  updateHistory(sortedEvents);
  updateDashboardDebatesSummary(latestDebates, data.activeDebatesCount);

  renderSidebarDebatesList();
  updateStageTopbar();
  renderChatStage();
  updateRightAiPanel();
}

async function refreshDashboard() {
  try {
    const [health, status, providersData] = await Promise.all([
      fetchJson("/health"),
      fetchJson("/status"),
      fetchJson("/providers").catch(() => null)
    ]);

    if (health.status && String(health.status).toLowerCase() !== "online") {
      throw new Error("Servidor não está online.");
    }

    setServerStatus(true);
    updateDashboard(status, providersData?.providers);
  } catch (error) {
    console.error("[AI Council] Erro ao atualizar painel:", error);
    setServerStatus(false);
    setCardsUnknownOnError();
    setText("#monitor-status", "Estado desconhecido: sem conexão");
  } finally {
    scheduleNextRefresh();
  }
}

function updateClock() {
  const now = new Date();
  setText(
    "#system-clock",
    now.toLocaleTimeString("pt-BR", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit"
    })
  );
}

// ============================================================================
// INICIALIZAÇÃO DE EVENTOS DE UI E PERSISTÊNCIA DE PAINÉIS RETRÁTEIS
// ============================================================================

function initializeCollapsibleLayout() {
  const appShell = $("#app-shell");

  // Restaura preferências salvas de colapso das barras laterais
  try {
    if (localStorage.getItem("ai-council-left-collapsed") === "true") {
      appShell?.classList.add("is-left-collapsed");
    }
    if (localStorage.getItem("ai-council-right-collapsed") === "true") {
      appShell?.classList.add("is-right-collapsed");
    }
  } catch {
    // Ignora caso localStorage esteja bloqueado
  }

  $("#toggle-left-sidebar")?.addEventListener("click", () => {
    if (!appShell) return;
    const isCollapsed = appShell.classList.toggle("is-left-collapsed");
    try {
      localStorage.setItem("ai-council-left-collapsed", String(isCollapsed));
    } catch {
      // Ignora
    }
  });

  $("#toggle-right-panel")?.addEventListener("click", () => {
    if (!appShell) return;
    const isCollapsed = appShell.classList.toggle("is-right-collapsed");
    try {
      localStorage.setItem("ai-council-right-collapsed", String(isCollapsed));
    } catch {
      // Ignora
    }
  });

  // Seções colapsáveis dentro da Sidebar Esquerda
  for (const toggleBtn of $$("[data-toggle-section]")) {
    const sectionKey = toggleBtn.getAttribute("data-toggle-section");
    const sectionEl = document.querySelector(`[data-sidebar-section="${sectionKey}"]`);
    if (!sectionEl || !sectionKey) continue;

    try {
      if (localStorage.getItem(`ai-council-sec-${sectionKey}`) === "collapsed") {
        sectionEl.classList.add("is-collapsed");
        toggleBtn.setAttribute("aria-expanded", "false");
      }
    } catch {
      // Ignora
    }

    toggleBtn.addEventListener("click", () => {
      const collapsed = sectionEl.classList.toggle("is-collapsed");
      toggleBtn.setAttribute("aria-expanded", String(!collapsed));
      try {
        localStorage.setItem(
          `ai-council-sec-${sectionKey}`,
          collapsed ? "collapsed" : "open"
        );
      } catch {
        // Ignora
      }
    });
  }
}

function initializeUiBindings() {
  initializeCollapsibleLayout();

  // 1. Formulário do Composer
  const createForm = $("#create-debate-form");
  if (createForm) {
    createForm.addEventListener("submit", handleCreateDebate);
  }

  // 2. Textarea do Composer: Enter envia, Shift+Enter quebra linha + auto-resize
  const topicTextarea = $("#debate-topic");
  if (topicTextarea) {
    topicTextarea.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        createForm?.requestSubmit();
      }
    });

    topicTextarea.addEventListener("input", () => {
      topicTextarea.style.height = "auto";
      topicTextarea.style.height = `${Math.min(180, topicTextarea.scrollHeight)}px`;
    });
  }

  // 3. Pills de seleção de IAs participantes no Composer
  for (const checkbox of $$('input[name="participants"]')) {
    const syncPill = () => {
      const label = checkbox.closest(".participant-pill");
      if (label) {
        label.classList.toggle("is-selected", checkbox.checked);
      }
    };
    checkbox.addEventListener("change", syncPill);
    syncPill();
  }

  // 4. Botão + Opções avançadas no Composer
  const advBtn = $("#toggle-advanced-btn");
  const advPanel = $("#composer-advanced");
  if (advBtn && advPanel) {
    advBtn.addEventListener("click", () => {
      const isHidden = advPanel.hidden;
      advPanel.hidden = !isHidden;
      advBtn.setAttribute("aria-expanded", String(isHidden));
      const span = advBtn.querySelector("span");
      if (span) {
        span.textContent = isHidden ? "− Ocultar opções" : "+ Opções avançadas";
      }
    });
  }

  // 5. Botão + Novo Debate na Sidebar
  $("#btn-new-debate")?.addEventListener("click", startNewDebateView);

  // 6. Abas de Navegação do Sistema na Sidebar
  for (const navBtn of $$("[data-view-target]")) {
    navBtn.addEventListener("click", () => {
      const target = navBtn.getAttribute("data-view-target") || "chat";
      switchView(target);
    });
  }

  // 7. Drawers Mobile / Tablet
  const leftSidebar = $("#left-sidebar");
  const rightPanel = $("#right-ai-panel");
  const backdrop = $("#mobile-backdrop");

  $("#open-left-drawer")?.addEventListener("click", () => {
    leftSidebar?.classList.add("is-open");
    backdrop?.classList.add("is-visible");
  });

  $("#close-left-drawer")?.addEventListener("click", closeMobileDrawers);

  $("#open-right-drawer")?.addEventListener("click", () => {
    rightPanel?.classList.add("is-open");
    backdrop?.classList.add("is-visible");
  });

  $("#close-right-drawer")?.addEventListener("click", closeMobileDrawers);
  backdrop?.addEventListener("click", closeMobileDrawers);
}

function initializeDashboard() {
  console.log("[AI Council] Intelligence Hub (Eraser Design System) iniciado.");

  initializeUiBindings();
  updateClock();
  void refreshDashboard();

  setInterval(updateClock, 1000);
  setInterval(tickLiveTimers, LIVE_TIMER_INTERVAL);
}

document.addEventListener("DOMContentLoaded", initializeDashboard);
