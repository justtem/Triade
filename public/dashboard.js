const IDLE_REFRESH_INTERVAL = 5000;
const ACTIVE_REFRESH_INTERVAL = 2000;
const SSE_FALLBACK_REFRESH_INTERVAL = 15000;
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

// Templates rápidos para o Carrossel Horizontal do Zero State
const ZERO_STATE_BLUEPRINTS = [
  {
    tag: "BACKEND // ARQUITETURA",
    title: "Microsserviços vs. Monolito Modular",
    topic:
      "Compare arquitetura de microsserviços e monolito modular para uma fintech com 50 mil usuários ativos e equipe de 8 devs. Aponte trade-offs reais, custos e recomende a melhor decisão prática.",
    focus: "backend"
  },
  {
    tag: "FULL-STACK // CÓDIGO",
    title: "CRUD RESTful Enxuto e Seguro",
    topic:
      "Implemente um CRUD completo de cadastro, atualização e exclusão com backend enxuto, banco SQLite/H2 e frontend HTML/JS puro, priorizando segurança, validação e zero complexidade desnecessária.",
    focus: "backend"
  },
  {
    tag: "FRONTEND // DESIGN SYSTEM",
    title: "Arquitetura UI sem Aparência Genérica",
    topic:
      "Defina tokens CSS, tipografia técnica, hierarquia de componentes e animações scroll-linked para um dashboard técnico de engenharia sem visual clichê de IA.",
    focus: "frontend"
  },
  {
    tag: "SEGURANÇA // AUDITORIA",
    title: "Hardening de API Node.js + Rate Limit",
    topic:
      "Liste as 5 vulnerabilidades mais críticas em APIs Node.js/TypeScript modernas e entregue middlewares concretos de validação, proteção contra injeção, rate-limiting e tratamento de erros.",
    focus: "backend"
  }
];

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
const stackedRoundKeys = new Set(); // Permite alternar Horizontal Scroll <-> Empilhado por rodada
const localTaskStartMs = new Map();

const RESPONSE_MODE_STORAGE_KEY = "ai-council-response-mode";
const INTERACTION_MODE_STORAGE_KEY = "ai-council-interaction-mode";

const RESPONSE_MODE_LABELS = {
  normal: "Normal",
  prompt_markdown: "Prompt MD"
};

const INTERACTION_MODE_LABELS = {
  direct: "Direto",
  debate: "Debate"
};

function loadStoredOption(key, fallback, allowed) {
  try {
    const val = localStorage.getItem(key);
    if (val && allowed.includes(val)) return val;
  } catch {
    // Ignora
  }
  return fallback;
}

function saveStoredOption(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignora
  }
}

let selectedResponseMode = loadStoredOption(
  RESPONSE_MODE_STORAGE_KEY,
  "normal",
  ["normal", "prompt_markdown"]
);
let selectedInteractionMode = loadStoredOption(
  INTERACTION_MODE_STORAGE_KEY,
  "direct",
  ["direct", "debate"]
);

const debateDetailsById = new Map();
const activeStreamsByTaskId = new Map();
const pendingStreamPaintIds = new Set();
let pendingAttachments = [];
let streamPaintRafId = null;
let eventSource = null;
let isSseConnected = false;
let sseReconnectTimer = null;
let detailFetchInFlightId = null;

let currentView = "chat"; // "chat" | "dashboard" | "history"
let selectedDebateId = null;
let hasInitializedSelection = false;
let latestDebates = [];
let latestEvents = [];
let latestProviders = [];
let lastDebatesSignature = "";
let lastRenderedChatSignature = "";
let lastZeroShowcaseSignature = "";
let scrollFocusedPlatform = null;

// Estado otimista imediato enquanto a requisição POST está sendo enviada
let optimisticSubmission = null;
let refreshTimerId = null;
let isRefreshing = false;
let pendingImmediateRefresh = false;
let scrollRevealObserver = null;

function getSessionTurns(debate) {
  if (!debate) return [];
  if (Array.isArray(debate.turns) && debate.turns.length > 0) {
    return debate.turns;
  }
  return [
    {
      id: "legacy_turn_1",
      index: 1,
      prompt: debate.topic || "",
      rules: debate.rules || "",
      participants: Array.isArray(debate.participants) ? debate.participants : [],
      responseMode: debate.responseMode || "prompt_markdown",
      interactionMode: debate.interactionMode || "debate",
      totalRounds: debate.totalRounds || 1,
      focus: debate.focus || "geral",
      currentRound: debate.currentRound || 1,
      currentStage: debate.currentStage || "completed",
      status: debate.status || "completed",
      conclusion: debate.conclusion,
      createdAt: debate.createdAt,
      completedAt: debate.completedAt
    }
  ];
}

function getTasksForTurn(debate, turn) {
  const tasks = Array.isArray(debate?.tasks) ? debate.tasks : [];
  const isFirst = turn.index === 1;
  return tasks.filter(
    (t) => t.turnId === turn.id || (isFirst && !t.turnId)
  );
}

function getResponsesForTurn(debate, turn) {
  const responses = Array.isArray(debate?.responses) ? debate.responses : [];
  const isFirst = turn.index === 1;
  return responses.filter(
    (r) => r.turnId === turn.id || (isFirst && !r.turnId)
  );
}

function syncComposerModeUi() {
  for (const btn of $$("#response-mode-toggle .mode-seg-btn")) {
    const mode = btn.getAttribute("data-response-mode");
    const active = mode === selectedResponseMode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
  }

  for (const btn of $$("#interaction-mode-toggle .mode-seg-btn")) {
    const mode = btn.getAttribute("data-interaction-mode");
    const active = mode === selectedInteractionMode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
  }

  const roundsWrap = $("#rounds-control-wrap");
  const focusWrap = $("#focus-control-wrap");
  const extraDivider = $("#composer-extra-divider");

  const showRounds = selectedInteractionMode === "debate";
  const showFocus = selectedResponseMode === "prompt_markdown";

  if (roundsWrap) roundsWrap.hidden = !showRounds;
  if (focusWrap) focusWrap.hidden = !showFocus;
  if (extraDivider) extraDivider.hidden = !showRounds && !showFocus;

  const isContinuing = Boolean(getActiveOrSelectedDebate());
  const submitSpan = $("#composer-submit-btn span:first-child");
  if (submitSpan) {
    submitSpan.textContent = isContinuing
      ? "Enviar"
      : selectedInteractionMode === "debate"
        ? "Debater"
        : "Enviar";
  }

  const topicInput = $("#debate-topic");
  if (topicInput) {
    topicInput.placeholder = isContinuing
      ? "Continue a conversa... (Enter envia)"
      : selectedResponseMode === "normal"
        ? "Pergunte algo... (Enter envia, Shift + Enter quebra linha)"
        : "Descreva o problema... (Enter envia, Shift + Enter quebra linha)";
  }
}

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
// MOTOR DE ANIMAÇÕES: SCROLL-TRIGGER, SCROLL-LINKED, PARALLAX & HORIZONTAL SCROLL
// ============================================================================

function initScrollTriggerObserver() {
  if (!("IntersectionObserver" in window)) return;

  scrollRevealObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("is-revealed");
        }
      }
    },
    {
      threshold: 0.08,
      rootMargin: "0px 0px -16px 0px"
    }
  );

  observeScrollRevealElements();
}

function observeScrollRevealElements(root = document) {
  const elements = Array.from(root.querySelectorAll("[data-scroll-reveal]"));
  elements.forEach((el, idx) => {
    if (!el.style.getPropertyValue("--reveal-delay")) {
      el.style.setProperty("--reveal-delay", `${Math.min(idx * 45, 240)}ms`);
    }
    if (scrollRevealObserver) {
      scrollRevealObserver.observe(el);
    } else {
      el.classList.add("is-revealed");
    }
  });
}

// Estado de Parallax (Scroll + Mouse)
let parallaxScrollY = 0;
let parallaxScrollX = 0;
let parallaxMouseX = 0;
let parallaxMouseY = 0;
let parallaxRafPending = false;

function scheduleParallaxRender() {
  if (parallaxRafPending) return;
  parallaxRafPending = true;
  requestAnimationFrame(() => {
    parallaxRafPending = false;
    const gridLayer = $("#parallax-grid-layer");
    const nodesLayer = $("#parallax-nodes-layer");

    if (gridLayer) {
      const gx = (-parallaxScrollX * 0.18 + parallaxMouseX * 10).toFixed(1);
      const gy = (-parallaxScrollY * 0.22 + parallaxMouseY * 10).toFixed(1);
      gridLayer.style.transform = `translate3d(${gx}px, ${gy}px, 0)`;
    }

    if (nodesLayer) {
      const nx = (-parallaxScrollX * 0.35 + parallaxMouseX * -22).toFixed(1);
      const ny = (-parallaxScrollY * 0.45 + parallaxMouseY * -22).toFixed(1);
      nodesLayer.style.transform = `translate3d(${nx}px, ${ny}px, 0)`;
    }

    // Parallax em camadas nas palavras do Display Headline no Zero State
    for (const word of $$(".parallax-word")) {
      const depth = Number(word.getAttribute("data-parallax-depth")) || 1;
      const wx = (parallaxMouseX * 14 * depth).toFixed(1);
      const wy = (parallaxMouseY * 9 * depth - parallaxScrollY * 0.08 * depth).toFixed(1);
      word.style.setProperty("--px", `${wx}px`);
      word.style.setProperty("--py", `${wy}px`);
    }
  });
}

/**
 * Conecta física de Horizontal Scroll Híbrido (Wheel-to-Horizontal com inércia +
 * Pointer Drag + Setas + Progresso Scroll-Linked + Escala 3D nos cards)
 */
function attachHorizontalScrollPhysics(viewportEl, options = {}) {
  if (!viewportEl || viewportEl.dataset.hScrollBound === "true") return;
  viewportEl.dataset.hScrollBound = "true";

  let targetScrollLeft = viewportEl.scrollLeft;
  let isAnimatingWheel = false;
  let isPointerDown = false;
  let startX = 0;
  let startScrollLeft = 0;
  let hasDragged = false;

  const updateHorizontalScrollLinkedState = () => {
    const maxScroll = Math.max(0, viewportEl.scrollWidth - viewportEl.clientWidth);
    const current = viewportEl.scrollLeft;
    const ratio = maxScroll > 0 ? Math.min(1, Math.max(0, current / maxScroll)) : 1;

    if (options.progressFillEl) {
      const pct = maxScroll > 0 ? Math.max(15, Math.round(ratio * 100)) : 100;
      options.progressFillEl.style.width = `${pct}%`;
    }

    // Parallax horizontal conectado ao scroll da trilha
    parallaxScrollX = current;
    scheduleParallaxRender();

    // Efeito Scroll-Linked de escala e foco nos cards da trilha horizontal
    const cards = Array.from(viewportEl.querySelectorAll(options.cardSelector || ".ai-response-card, .zero-h-card"));
    if (cards.length === 0) return;

    const viewportRect = viewportEl.getBoundingClientRect();
    const viewportCenter = viewportRect.left + viewportRect.width / 2;

    let closestCard = null;
    let minDistance = Infinity;

    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      const cardCenter = rect.left + rect.width / 2;
      const dist = Math.abs(viewportCenter - cardCenter);
      const normDist = Math.min(1, dist / Math.max(1, viewportRect.width * 0.65));

      const scale = (1 - normDist * 0.032).toFixed(4);
      const offsetY = (normDist * 4).toFixed(1);
      card.style.setProperty("--card-h-scale", scale);
      card.style.setProperty("--card-h-y", `${offsetY}px`);

      if (dist < minDistance) {
        minDistance = dist;
        closestCard = card;
      }
    }

    for (const card of cards) {
      card.classList.toggle("is-h-centered", card === closestCard && cards.length > 1);
    }

    if (closestCard && options.onCenteredCardChange) {
      options.onCenteredCardChange(closestCard);
    }
  };

  const animateWheelStep = () => {
    const diff = targetScrollLeft - viewportEl.scrollLeft;
    if (Math.abs(diff) < 0.8) {
      viewportEl.scrollLeft = targetScrollLeft;
      isAnimatingWheel = false;
      updateHorizontalScrollLinkedState();
      return;
    }
    viewportEl.scrollLeft += diff * 0.24;
    updateHorizontalScrollLinkedState();
    requestAnimationFrame(animateWheelStep);
  };

  // Conversão Híbrida Inteligente de Wheel Vertical -> Horizontal Scroll
  viewportEl.addEventListener(
    "wheel",
    (e) => {
      if (options.isStacked && options.isStacked()) return;

      const maxScroll = viewportEl.scrollWidth - viewportEl.clientWidth;
      if (maxScroll <= 4) return;

      // Se o cursor estiver dentro de um corpo de resposta ou código que pode rolar verticalmente, respeita a leitura interna
      const scrollableInner = e.target.closest(".ai-response-body, .code-block-pre, .prompt-preview");
      if (scrollableInner && scrollableInner.scrollHeight > scrollableInner.clientHeight + 4) {
        const atTop = scrollableInner.scrollTop <= 0;
        const atBottom =
          scrollableInner.scrollTop + scrollableInner.clientHeight >=
          scrollableInner.scrollHeight - 2;
        if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) {
          return;
        }
      }

      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (Math.abs(delta) < 1) return;

      const currentBase = isAnimatingWheel ? targetScrollLeft : viewportEl.scrollLeft;
      const goingRight = delta > 0;
      const goingLeft = delta < 0;

      const canGoRight = currentBase < maxScroll - 2;
      const canGoLeft = currentBase > 2;

      if ((goingRight && canGoRight) || (goingLeft && canGoLeft)) {
        e.preventDefault();
        targetScrollLeft = Math.max(0, Math.min(maxScroll, currentBase + delta * 1.15));
        if (!isAnimatingWheel) {
          isAnimatingWheel = true;
          requestAnimationFrame(animateWheelStep);
        }
      }
    },
    { passive: false }
  );

  // Drag com mouse / touch
  viewportEl.addEventListener("pointerdown", (e) => {
    if (options.isStacked && options.isStacked()) return;
    if (e.target.closest("button, a, input, textarea, select, code, pre")) return;

    isPointerDown = true;
    hasDragged = false;
    isAnimatingWheel = false;
    startX = e.clientX;
    startScrollLeft = viewportEl.scrollLeft;
    targetScrollLeft = startScrollLeft;
    viewportEl.classList.add("is-dragging");
  });

  window.addEventListener("pointermove", (e) => {
    if (!isPointerDown) return;
    const dx = e.clientX - startX;
    if (Math.abs(dx) > 5) {
      hasDragged = true;
    }
    viewportEl.scrollLeft = startScrollLeft - dx;
    targetScrollLeft = viewportEl.scrollLeft;
    updateHorizontalScrollLinkedState();
  });

  window.addEventListener("pointerup", () => {
    if (!isPointerDown) return;
    isPointerDown = false;
    viewportEl.classList.remove("is-dragging");
  });

  viewportEl.addEventListener(
    "click",
    (e) => {
      if (hasDragged) {
        e.preventDefault();
        e.stopPropagation();
        hasDragged = false;
      }
    },
    true
  );

  viewportEl.addEventListener("scroll", () => {
    if (!isAnimatingWheel) {
      targetScrollLeft = viewportEl.scrollLeft;
    }
    updateHorizontalScrollLinkedState();
  });

  if (options.prevBtn) {
    options.prevBtn.addEventListener("click", () => {
      const step = Math.max(280, Math.round(viewportEl.clientWidth * 0.72));
      targetScrollLeft = Math.max(0, viewportEl.scrollLeft - step);
      if (!isAnimatingWheel) {
        isAnimatingWheel = true;
        requestAnimationFrame(animateWheelStep);
      }
    });
  }

  if (options.nextBtn) {
    options.nextBtn.addEventListener("click", () => {
      const maxScroll = Math.max(0, viewportEl.scrollWidth - viewportEl.clientWidth);
      const step = Math.max(280, Math.round(viewportEl.clientWidth * 0.72));
      targetScrollLeft = Math.min(maxScroll, viewportEl.scrollLeft + step);
      if (!isAnimatingWheel) {
        isAnimatingWheel = true;
        requestAnimationFrame(animateWheelStep);
      }
    });
  }

  // Inicializa estado visual após layout
  requestAnimationFrame(updateHorizontalScrollLinkedState);
}

// ============================================================================
// MINI-MAPA DE RODADAS E TIMELINE SCROLL-LINKED DO CHAT
// ============================================================================

function buildChatRoundMinimap(debate) {
  const minimap = $("#chat-round-minimap");
  const stepsContainer = $("#minimap-steps");
  if (!minimap || !stepsContainer) return;

  if (!debate && !optimisticSubmission) {
    minimap.hidden = true;
    stepsContainer.replaceChildren();
    return;
  }

  const turns = debate ? getSessionTurns(debate) : [];

  // Em chat direto de 1 turno, oculta o minimapa para manter o visual limpo.
  if (
    !debate &&
    optimisticSubmission &&
    optimisticSubmission.interactionMode === "direct" &&
    !optimisticSubmission.parentDebateId
  ) {
    minimap.hidden = true;
    stepsContainer.replaceChildren();
    return;
  }

  if (
    debate &&
    turns.length === 1 &&
    turns[0].interactionMode === "direct" &&
    !optimisticSubmission
  ) {
    minimap.hidden = true;
    stepsContainer.replaceChildren();
    return;
  }

  minimap.hidden = false;
  stepsContainer.replaceChildren();

  let steps = [];
  if (turns.length > 1 || (debate && optimisticSubmission?.parentDebateId)) {
    steps = turns.map((t) => ({
      id: `step-turn-${t.index}`,
      label: `Msg ${t.index}`
    }));
    if (optimisticSubmission?.parentDebateId) {
      steps.push({
        id: `step-turn-${turns.length + 1}`,
        label: `Msg ${turns.length + 1}`
      });
    }
  } else {
    const singleTurn = turns[0] || {
      totalRounds: optimisticSubmission?.totalRounds || 2
    };
    steps = [{ id: "step-user", label: "Início" }];
    for (let r = 1; r <= (singleTurn.totalRounds || 1); r++) {
      steps.push({ id: `step-round-${r}`, label: `Rodada ${r}` });
    }
    steps.push({ id: "step-synthesis", label: "Síntese" });
  }

  steps.forEach((st, idx) => {
    if (idx > 0) {
      const conn = document.createElement("span");
      conn.className = "minimap-connector";
      conn.textContent = "→";
      stepsContainer.appendChild(conn);
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `minimap-step-btn${idx === 0 ? " is-current" : ""}`;
    btn.setAttribute("data-minimap-target", st.id);
    btn.textContent = st.label;

    btn.addEventListener("click", () => {
      const sectionEl = document.getElementById(st.id);
      const chatScroll = $("#chat-scroll-area");
      if (sectionEl && chatScroll) {
        chatScroll.scrollTo({
          top: Math.max(0, sectionEl.offsetTop - 16),
          behavior: "smooth"
        });
      }
    });

    stepsContainer.appendChild(btn);
  });
}

function updateChatScrollLinkedEffects() {
  const chatScroll = $("#chat-scroll-area");
  const threadEl = $("#chat-thread");
  const composerDock = $("#composer-dock");
  if (!chatScroll) return;

  const scrollTop = chatScroll.scrollTop;
  const maxScroll = Math.max(0, chatScroll.scrollHeight - chatScroll.clientHeight);
  const ratio = maxScroll > 0 ? Math.min(1, Math.max(0, scrollTop / maxScroll)) : 0;
  const pct = Math.round(ratio * 100);

  // 0. Compactação "Floating Pill" do Composer durante o scroll das respostas/códigos
  if (composerDock) {
    const hasOpenDebate = Boolean(getActiveOrSelectedDebate() || optimisticSubmission);
    const shouldCompact = hasOpenDebate && scrollTop > 32 && maxScroll > 48;
    composerDock.classList.toggle("is-scroll-compact", shouldCompact);
  }

  // 1. Atualiza Parallax vertical
  parallaxScrollY = scrollTop;
  scheduleParallaxRender();

  // 2. Atualiza barra de progresso Scroll-Linked do Mini-Mapa e Timeline do Chat
  const progressBar = $("#chat-scroll-progress-bar");
  const pctLabel = $("#minimap-scroll-pct");
  if (progressBar) {
    progressBar.style.width = `${pct}%`;
  }
  if (pctLabel) {
    pctLabel.textContent = `${pct}%`;
  }
  if (threadEl) {
    threadEl.style.setProperty("--chat-timeline-progress", `${Math.max(8, pct)}%`);
  }

  // 3. Scroll-Spy nas seções do debate para iluminar o nó ativo no Mini-Mapa
  const sections = $$("[data-minimap-section]");
  if (sections.length > 0) {
    let activeSectionId = sections[0].id;
    const triggerLine = scrollTop + chatScroll.clientHeight * 0.28;

    for (const sec of sections) {
      if (sec.offsetTop <= triggerLine) {
        activeSectionId = sec.id;
      }
    }

    for (const btn of $$("[data-minimap-target]")) {
      const isMatch = btn.getAttribute("data-minimap-target") === activeSectionId;
      btn.classList.toggle("is-current", isMatch);
    }

    // Sincroniza a IA em foco na seção ativa com o Sticky Dock da Barra Lateral Direita
    const activeSecEl = document.getElementById(activeSectionId);
    const centeredCard = activeSecEl?.querySelector(".ai-response-card.is-h-centered, .ai-response-card");
    const focusedPlat = centeredCard?.getAttribute("data-response-platform") || null;
    setScrollFocusedAiInRightDock(focusedPlat);
  } else {
    setScrollFocusedAiInRightDock(null);
  }
}

function setScrollFocusedAiInRightDock(platformId) {
  if (scrollFocusedPlatform === platformId) return;
  scrollFocusedPlatform = platformId;

  for (const plat of AUTO_PLATFORM_IDS) {
    const card = document.querySelector(`[data-ai-card="${plat}"]`);
    if (!card) continue;
    const isFocused = plat === platformId && !card.classList.contains("is-thinking");
    card.classList.toggle("is-scroll-focused", isFocused);
  }
}

// ============================================================================
// CARROSSEL HORIZONTAL DO ZERO STATE (TEMPLATES + SESSÕES RECENTES)
// ============================================================================

function renderZeroStateHorizontalShowcase() {
  const track = $("#zero-h-track");
  const viewport = $("#zero-h-viewport");
  const progressFill = $("#zero-h-progress-fill");
  const prevBtn = $("#zero-h-prev");
  const nextBtn = $("#zero-h-next");
  if (!track || !viewport) return;

  const recentSignature = JSON.stringify(
    latestDebates.slice(0, 4).map((d) => ({ id: d.id, title: d.title, status: d.status }))
  );
  if (recentSignature === lastZeroShowcaseSignature && track.children.length > 0) {
    return;
  }
  lastZeroShowcaseSignature = recentSignature;
  track.replaceChildren();

  // 1. Cards de Debates Recentes (se existirem)
  for (const debate of latestDebates.slice(0, 3)) {
    const card = document.createElement("article");
    card.className = "zero-h-card";

    const top = document.createElement("div");
    top.className = "zero-h-card-top";

    const tag = document.createElement("span");
    tag.className = "zero-h-tag tag-recent";
    tag.textContent =
      debate.status === "running"
        ? `ATIVO • R${debate.currentRound}/${debate.totalRounds}`
        : `SESSÃO • ${debate.totalRounds} RODADAS`;

    const arrow = document.createElement("span");
    arrow.className = "cta-arrow";
    arrow.textContent = "→";

    top.append(tag, arrow);

    const h4 = document.createElement("h4");
    h4.textContent = debate.title;

    const p = document.createElement("p");
    p.textContent = debate.topic;

    card.append(top, h4, p);
    card.addEventListener("click", () => selectDebate(debate.id));
    track.appendChild(card);
  }

  // 2. Cards de Blueprints Técnicos Rápidos
  for (const bp of ZERO_STATE_BLUEPRINTS) {
    const card = document.createElement("article");
    card.className = "zero-h-card";

    const top = document.createElement("div");
    top.className = "zero-h-card-top";

    const tag = document.createElement("span");
    tag.className = "zero-h-tag";
    tag.textContent = bp.tag;

    const arrow = document.createElement("span");
    arrow.className = "cta-arrow";
    arrow.textContent = "↗";

    top.append(tag, arrow);

    const h4 = document.createElement("h4");
    h4.textContent = bp.title;

    const p = document.createElement("p");
    p.textContent = bp.topic;

    card.append(top, h4, p);
    card.addEventListener("click", () => {
      const titleInput = $("#debate-title");
      const topicInput = $("#debate-topic");
      const focusSelect = $("#debate-focus");

      selectedResponseMode = "prompt_markdown";
      selectedInteractionMode = "debate";
      saveStoredOption(RESPONSE_MODE_STORAGE_KEY, selectedResponseMode);
      saveStoredOption(INTERACTION_MODE_STORAGE_KEY, selectedInteractionMode);
      syncComposerModeUi();

      if (titleInput) titleInput.value = bp.title;
      if (focusSelect) focusSelect.value = bp.focus;
      if (topicInput) {
        topicInput.value = bp.topic;
        topicInput.style.height = "auto";
        topicInput.style.height = `${Math.min(180, topicInput.scrollHeight)}px`;
        topicInput.focus();
      }
    });
    track.appendChild(card);
  }

  attachHorizontalScrollPhysics(viewport, {
    progressFillEl: progressFill,
    prevBtn,
    nextBtn,
    cardSelector: ".zero-h-card"
  });
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

function getStoredSessionToken() {
  try {
    return localStorage.getItem("ai-council-session-token") || "";
  } catch {
    return "";
  }
}

function setStoredSessionToken(token) {
  try {
    if (token) {
      localStorage.setItem("ai-council-session-token", token);
    } else {
      localStorage.removeItem("ai-council-session-token");
    }
  } catch {
    // Ignora
  }
}

function showAuthLockOverlay(message = "") {
  const overlay = $("#auth-lock-overlay");
  const errEl = $("#auth-lock-error");
  const input = $("#auth-password-input");
  if (overlay && overlay.hidden) {
    overlay.hidden = false;
    setTimeout(() => input?.focus(), 60);
  }
  if (errEl && message) {
    errEl.textContent = message;
  }
}

function hideAuthLockOverlay() {
  const overlay = $("#auth-lock-overlay");
  const errEl = $("#auth-lock-error");
  if (overlay) overlay.hidden = true;
  if (errEl) errEl.textContent = "";
}

async function fetchJson(endpoint, options = {}) {
  const sessionToken = getStoredSessionToken();
  const method = options.method || "GET";
  const timeoutMs = options.timeoutMs || (method === "GET" ? 15000 : 25000);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(endpoint, {
      method,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(sessionToken ? { "X-AI-Council-Session": sessionToken } : {}),
        ...(options.headers || {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store",
      signal: controller.signal
    });
  } finally {
    clearTimeout(timeoutId);
  }

  const data = await response.json().catch(() => ({}));
  if (response.status === 401 && endpoint !== "/auth/login") {
    showAuthLockOverlay();
  }
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

  const minimap = $("#chat-round-minimap");
  if (minimap) {
    minimap.hidden = targetView !== "chat" || (!getActiveOrSelectedDebate() && !optimisticSubmission);
  }

  updateStageTopbar();
  closeMobileDrawers();
  observeScrollRevealElements();
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
  syncComposerModeUi();
  closeMobileDrawers();
  void loadDebateDetail(debateId);
}

function startNewDebateView() {
  selectedDebateId = null;
  optimisticSubmission = null;
  lastRenderedChatSignature = "";
  $("#composer-dock")?.classList.remove("is-scroll-compact");
  setScrollFocusedAiInRightDock(null);
  switchView("chat");
  renderSidebarDebatesList();
  renderChatStage();
  updateStageTopbar();
  updateRightAiPanel();
  syncComposerModeUi();

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
  if (!selectedDebateId) return null;
  const full = debateDetailsById.get(selectedDebateId);
  if (full) return full;
  const summary = latestDebates.find((d) => d.id === selectedDebateId);
  return summary || null;
}

function getReferenceDebateForRightPanel() {
  const selected = getActiveOrSelectedDebate();
  if (selected) return selected;
  const runningSummary = latestDebates.find((d) => d.status === "running");
  if (!runningSummary) return null;
  return debateDetailsById.get(runningSummary.id) || runningSummary;
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
    titleEl.textContent = "Nova Conversa";
    return;
  }

  titleEl.textContent = debate.title;

  const memBtn = document.createElement("button");
  memBtn.type = "button";
  memBtn.className = "btn-secondary";
  const covered = debate.sharedMemory?.coveredTurnCount || 0;
  const hasManual = Boolean(debate.sharedMemory?.summary);
  memBtn.textContent =
    covered > 0
      ? `Memória · ${covered}t`
      : hasManual
        ? "Memória · ativa"
        : "Memória";
  memBtn.title = "Ver ou editar a Memória Compartilhada desta conversa";
  memBtn.addEventListener("click", () => openMemoryModal(debate.id));
  actionsWrap.appendChild(memBtn);

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
    const turnCount =
      typeof debate.turnCount === "number"
        ? debate.turnCount
        : Array.isArray(debate.turns)
          ? debate.turns.length
          : 1;
    const isDirect = debate.interactionMode === "direct";
    statusText.textContent =
      debate.status === "running"
        ? isDirect
          ? "Respondendo..."
          : `R${debate.currentRound}/${debate.totalRounds} • Pensando`
        : debate.status === "completed"
          ? turnCount > 1
            ? `${turnCount} msgs`
            : isDirect
              ? RESPONSE_MODE_LABELS[debate.responseMode] || "Direto"
              : `${debate.totalRounds} rodadas`
          : "Pausado";

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

function formatCleanErrorText(rawMessage) {
  const str = String(rawMessage || "").trim();
  if (!str) return "Falha temporária no provedor.";

  // Detecta se a mensagem contém JSON bruto como {"error":{"code":503,"message":"..."}}
  if (str.includes("{") && str.includes("}")) {
    if (/503|high demand|UNAVAILABLE|overloaded/i.test(str)) {
      return str.replace(
        /\(\{[\s\S]*?\}\)/g,
        "(alta demanda temporária no servidor da IA — código 503)"
      );
    }
    if (/429|rate limit|quota/i.test(str)) {
      return str.replace(
        /\(\{[\s\S]*?\}\)/g,
        "(limite de requisições temporariamente atingido — código 429)"
      );
    }
    const msgMatch = str.match(/"message"\s*:\s*"([^"]+)"/);
    if (msgMatch && msgMatch[1]) {
      return str.replace(/\(\{[\s\S]*?\}\)/g, `(${msgMatch[1]})`);
    }
  }

  return str;
}

function saveCurrentDraftsFromDom() {
  const inputs = $$(".task-response-input[data-task-id]");
  for (const input of inputs) {
    const taskId = input.getAttribute("data-task-id");
    if (taskId) {
      draftResponsesByTaskId.set(taskId, input.value);
    }
  }
}

function buildTurnUserMessage(debate, turn, isMultiTurn) {
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

  if (Array.isArray(turn.attachments) && turn.attachments.length > 0) {
    for (const file of turn.attachments) {
      const tagFile = document.createElement("span");
      tagFile.className = "chat-config-tag";
      tagFile.textContent = `[${file.name}]`;
      tagsRow.appendChild(tagFile);
    }
  }

  userCard.append(header, topic, tagsRow);
  return userCard;
}

function buildReasoningBlockForStage(debate, stageKey, roundNumber, stageType, stageTasks, stageResponses) {
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

function renderStreamingMarkdownInto(containerEl, rawText) {
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

function scheduleStreamBodyPaint(taskId) {
  pendingStreamPaintIds.add(taskId);
  if (streamPaintRafId !== null) return;
  streamPaintRafId = requestAnimationFrame(() => {
    streamPaintRafId = null;
    const ids = Array.from(pendingStreamPaintIds);
    pendingStreamPaintIds.clear();

    let needsFullRerender = false;
    for (const id of ids) {
      const stream = activeStreamsByTaskId.get(id);
      if (!stream || stream.debateId !== selectedDebateId) continue;
      const bodyEl = document.getElementById(`stream-body-${id}`);
      if (!bodyEl) {
        needsFullRerender = true;
      } else {
        renderStreamingMarkdownInto(bodyEl, stream.content);
      }
    }

    if (needsFullRerender) {
      lastRenderedChatSignature = "";
      renderChatStage();
    }
  });
}

function getStreamingResponsesForStage(debate, turn, roundNum, stageMode, savedResponses) {
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

function buildResponseCard(debate, resp, turn) {
  const isStreaming = Boolean(resp.isStreaming);
  const matchingTask = (debate.tasks || []).find((t) => t.id === resp.taskId);
  const durationSec = isStreaming
    ? null
    : getCompletedTaskDurationSec(matchingTask, resp);
  const isDirect = turn?.interactionMode === "direct";
  const isNormal = turn?.responseMode === "normal";

  const card = document.createElement("article");
  card.className = `ai-response-card${isStreaming ? " is-streaming" : ""}`;
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
  monogram.textContent = PLATFORM_MONOGRAMS[resp.platform] || "AI";

  const titleWrap = document.createElement("div");
  titleWrap.className = "ai-response-title-wrap";

  const titleRow = document.createElement("div");
  titleRow.className = "ai-response-title-row";

  const nameEl = document.createElement("span");
  nameEl.className = "ai-response-name";
  nameEl.textContent = PLATFORMS[resp.platform] || resp.platform;
  titleRow.appendChild(nameEl);

  if (isStreaming) {
    const liveBadge = document.createElement("span");
    liveBadge.className = "streaming-live-pill";
    liveBadge.textContent = "Ao vivo";
    titleRow.appendChild(liveBadge);
  } else if (durationSec !== null) {
    const thoughtBadge = document.createElement("span");
    thoughtBadge.className = "thought-duration-pill";
    thoughtBadge.textContent = formatSecondsCompact(durationSec);
    titleRow.appendChild(thoughtBadge);
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

    actions.append(regenBtn, reviewWrap, copyBtn, toggleBtn);
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
function buildRoundHorizontalResponsesTrack(debate, roundNum, roundResponses, turn) {
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
        if (wrapper.classList.contains("is-stacked")) {
          cardEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } else {
          viewport.scrollTo({
            left: cardEl.offsetLeft - 4,
            behavior: "smooth"
          });
        }
      });

      jumpBtns.push({ btn: jumpBtn, card: cardEl, platform: resp.platform });
      leftGroup.appendChild(jumpBtn);
    }
  });

  const controls = document.createElement("div");
  controls.className = "h-scroll-controls";

  const progressTrack = document.createElement("div");
  progressTrack.className = "h-scroll-mini-progress";
  const progressFill = document.createElement("div");
  progressFill.className = "h-scroll-mini-fill";
  progressTrack.appendChild(progressFill);

  const prevBtn = document.createElement("button");
  prevBtn.type = "button";
  prevBtn.className = "h-scroll-arrow";
  prevBtn.textContent = "←";
  prevBtn.title = "IA anterior";

  const nextBtn = document.createElement("button");
  nextBtn.type = "button";
  nextBtn.className = "h-scroll-arrow";
  nextBtn.textContent = "→";
  nextBtn.title = "Próxima IA";

  const modeBtn = document.createElement("button");
  modeBtn.type = "button";
  modeBtn.className = "h-scroll-mode-btn";
  modeBtn.textContent = isStacked ? "⇄ Horizontal" : "☰ Empilhar";
  modeBtn.title = "Alternar layout";

  modeBtn.addEventListener("click", () => {
    const nowStacked = wrapper.classList.toggle("is-stacked");
    if (nowStacked) {
      stackedRoundKeys.add(roundKey);
      modeBtn.textContent = "⇄ Horizontal";
    } else {
      stackedRoundKeys.delete(roundKey);
      modeBtn.textContent = "☰ Empilhar";
    }
  });

  if (roundResponses.length > 1) {
    controls.append(progressTrack, prevBtn, nextBtn, modeBtn);
  }

  hHeader.append(leftGroup, controls);
  viewport.appendChild(respList);
  wrapper.append(hHeader, viewport);

  if (roundResponses.length > 1) {
    attachHorizontalScrollPhysics(viewport, {
      progressFillEl: progressFill,
      prevBtn,
      nextBtn,
      cardSelector: ".ai-response-card",
      isStacked: () => wrapper.classList.contains("is-stacked"),
      onCenteredCardChange: (centeredCard) => {
        const plat = centeredCard.getAttribute("data-response-platform");
        for (const item of jumpBtns) {
          item.btn.classList.toggle("is-active", item.card === centeredCard);
        }
        if (AUTO_PLATFORM_IDS.includes(plat)) {
          setScrollFocusedAiInRightDock(plat);
        }
      }
    });
  }

  return wrapper;
}

function buildConclusionCard(debate, turn, turnResponses, isMultiTurn) {
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

function buildTurnBlock(debate, turn, isMultiTurn, isLastTurn) {
  const turnBlock = document.createElement("div");
  turnBlock.className = "chat-turn-block";
  if (isMultiTurn) {
    turnBlock.id = `step-turn-${turn.index}`;
    turnBlock.setAttribute("data-minimap-section", `step-turn-${turn.index}`);
  }

  turnBlock.appendChild(buildTurnUserMessage(debate, turn, isMultiTurn));

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

function buildOptimisticTurnElements(baseDebate) {
  const existingTurns = baseDebate ? getSessionTurns(baseDebate) : [];
  const nextIndex = existingTurns.length + 1;
  const isMultiTurn = nextIndex > 1;
  const optTurn = {
    id: `optimistic_turn_${nextIndex}`,
    index: nextIndex,
    prompt: optimisticSubmission.topic,
    rules: optimisticSubmission.rules,
    participants: optimisticSubmission.participants,
    responseMode: optimisticSubmission.responseMode,
    interactionMode: optimisticSubmission.interactionMode,
    totalRounds: optimisticSubmission.totalRounds,
    focus: optimisticSubmission.focus,
    currentRound: 1,
    currentStage: "initial_response",
    status: "running",
    attachments: optimisticSubmission.attachments || [],
    createdAt: new Date(optimisticSubmission.startedAtMs).toISOString()
  };

  const fakeDebate = {
    id: baseDebate?.id || "optimistic",
    title: optimisticSubmission.title,
    status: "running",
    totalRounds: optimisticSubmission.totalRounds,
    updatedAt: optTurn.createdAt,
    tasks: optimisticSubmission.participants.map((p, idx) => ({
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

function renderOptimisticChatThread(threadEl) {
  const parentDebate = optimisticSubmission.parentDebateId
    ? debateDetailsById.get(optimisticSubmission.parentDebateId) ||
      latestDebates.find((d) => d.id === optimisticSubmission.parentDebateId) ||
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
    buildChatRoundMinimap(null);
    renderZeroStateHorizontalShowcase();
    return;
  }

  zeroStateEl.hidden = true;
  threadEl.hidden = false;

  // Se ainda temos apenas o resumo leve do /status, busca o detalhe completo em /debates/:id.
  const isFullDetail = Array.isArray(debate.tasks) && Array.isArray(debate.responses);
  if (!isFullDetail) {
    if (detailFetchInFlightId !== debate.id) {
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

  if (signature === lastRenderedChatSignature && isTypingInManualTask) {
    return;
  }

  if (signature === lastRenderedChatSignature && threadEl.children.length > 0) {
    return;
  }

  saveCurrentDraftsFromDom();
  lastRenderedChatSignature = signature;
  threadEl.replaceChildren();

  buildChatRoundMinimap(debate);

  const turns = getSessionTurns(debate);
  const isMultiTurn = turns.length > 1;

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
  requestAnimationFrame(updateChatScrollLinkedEffects);
}

// ============================================================================
// COLUNA 3: DOCK STICKY DAS 3 IAs AUTOMÁTICAS + FEED DE TELEMETRIA DE USO
// ============================================================================

function formatCompactNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "--";
  if (num >= 1000) {
    const k = num / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(num);
}

function renderRightPanelTelemetryFeed(refDebate) {
  const feedEl = $("#ai-usage-telemetry-feed");
  if (!feedEl) return;

  feedEl.replaceChildren();

  // 1. Resumo Consolidado de Cotas Diárias (3 IAs Automáticas)
  let totalReqToday = 0;
  let totalReqCap = 0;
  let totalTokensToday = 0;

  for (const plat of AUTO_PLATFORM_IDS) {
    const p = latestProviders.find((item) => item.id === plat);
    if (p?.usage) {
      totalReqToday += p.usage.requestsToday || 0;
      totalReqCap += p.usage.requestsDailyCap || 0;
      totalTokensToday += p.usage.tokensToday || 0;
    }
  }

  const quotaTitle = document.createElement("span");
  quotaTitle.className = "telemetry-section-title";
  quotaTitle.textContent = "TELEMETRIA DE COTA // HOJE";
  feedEl.appendChild(quotaTitle);

  const memCovered = refDebate?.sharedMemory?.coveredTurnCount || 0;
  const memLabel = memCovered > 0 ? `Turnos 1–${memCovered}` : "Compartilhada";

  const summaryBox = document.createElement("div");
  summaryBox.className = "telemetry-box";
  summaryBox.innerHTML = `
    <div class="telemetry-row">
      <span>Req. Automáticas</span>
      <strong>${totalReqToday}/${totalReqCap || "--"} req</strong>
    </div>
    <div class="telemetry-row">
      <span>Tokens Hoje</span>
      <strong>${totalTokensToday.toLocaleString("pt-BR")} tok</strong>
    </div>
    <div class="telemetry-row">
      <span>Memória</span>
      <strong>${memLabel}</strong>
    </div>
    <div class="telemetry-row">
      <span>Trava UsageGate</span>
      <strong>90% (Custo Zero)</strong>
    </div>
  `;
  feedEl.appendChild(summaryBox);

  // 2. Detalhamento Técnico por Provedor Automático (RPM / TPM / Contexto / Saída)
  for (const plat of AUTO_PLATFORM_IDS) {
    const p = latestProviders.find((item) => item.id === plat);
    const usage = p?.usage;
    if (!usage) continue;

    const pBox = document.createElement("div");
    pBox.className = "telemetry-box";
    const pct = Math.min(
      100,
      Math.round((usage.requestsToday / Math.max(1, usage.requestsDailyCap)) * 100)
    );
    const tpmText = usage.tokensPerMinuteCap
      ? ` · ${formatCompactNumber(usage.tokensPerMinuteCap)} TPM`
      : "";
    const budget = p?.contextBudget;
    const budgetRow = budget
      ? `
      <div class="telemetry-row">
        <span>Contexto / Saída</span>
        <strong>${formatCompactNumber(budget.historyChars)} ch · ${formatCompactNumber(budget.maxOutputTokens)} tok</strong>
      </div>`
      : "";

    pBox.innerHTML = `
      <div class="telemetry-row">
        <span>${PLATFORMS[plat]} (${pct}%)</span>
        <strong>${usage.requestsPerMinuteCap} RPM${tpmText}</strong>
      </div>
      <div class="telemetry-row">
        <span>Tokens dia</span>
        <strong>${(usage.tokensToday || 0).toLocaleString("pt-BR")}${usage.tokensDailyCap ? ` / ${usage.tokensDailyCap.toLocaleString("pt-BR")}` : ""}</strong>
      </div>${budgetRow}
    `;
    feedEl.appendChild(pBox);
  }

  // 3. Log Interativo de Chamadas do Debate Ativo (clicar foca a resposta no chat!)
  if (refDebate && Array.isArray(refDebate.responses) && refDebate.responses.length > 0) {
    const logTitle = document.createElement("span");
    logTitle.className = "telemetry-section-title";
    logTitle.textContent = "CHAMADAS DA SESSÃO // CLICK TO FOCUS";
    feedEl.appendChild(logTitle);

    const turns = getSessionTurns(refDebate);
    const autoResponses = refDebate.responses.filter((r) =>
      AUTO_PLATFORM_IDS.includes(r.platform)
    );

    for (const resp of autoResponses) {
      const task = (refDebate.tasks || []).find((t) => t.id === resp.taskId);
      const durSec = getCompletedTaskDurationSec(task, resp);
      const matchedTurn =
        turns.find((t) => t.id === resp.turnId) || turns[0];
      const isDirect = matchedTurn?.interactionMode === "direct";
      const turnPrefix = turns.length > 1 && matchedTurn ? `M${matchedTurn.index}` : "";
      const topTag = isDirect
        ? turnPrefix || "Direto"
        : turnPrefix
          ? `${turnPrefix} · R${resp.round}`
          : `R${resp.round}`;
      const subStageLabel = isDirect
        ? RESPONSE_MODE_LABELS[matchedTurn?.responseMode] || "Direto"
        : STAGE_LABELS[resp.stage] || "Debate";

      const logItem = document.createElement("div");
      logItem.className = "telemetry-log-item";
      logItem.innerHTML = `
        <div class="telemetry-log-top">
          <span>${PLATFORMS[resp.platform]} • ${topTag}</span>
          <span>${durSec ? formatSecondsCompact(durSec) : "OK"}</span>
        </div>
        <div class="telemetry-log-sub">
          <span>${escapeHtml(subStageLabel)}</span>
          <span>${resp.tokens ? `${resp.tokens} tok` : ""}</span>
        </div>
      `;

      logItem.addEventListener("click", () => {
        const cardEl = document.getElementById(`resp-card-${resp.id}`);
        if (cardEl) {
          cardEl.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
          setScrollFocusedAiInRightDock(resp.platform);
        } else if (resp.stage === "synthesis") {
          document.getElementById("step-synthesis")?.scrollIntoView({ behavior: "smooth" });
        }
      });

      feedEl.appendChild(logItem);
    }
  }
}

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
      roundIndicator.textContent = "Em repouso • Sticky Dock";
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

    const histChip = document.createElement("button");
    histChip.type = "button";
    histChip.className = "mobile-ai-chip mobile-history-chip";
    histChip.textContent = `Histórico (${latestDebates.length})`;
    histChip.addEventListener("click", () => {
      const debatesSec = document.querySelector('[data-sidebar-section="debates"]');
      debatesSec?.classList.remove("is-collapsed");
      $("#left-sidebar")?.classList.add("is-open");
      $("#mobile-backdrop")?.classList.add("is-visible");
    });
    mobileStrip.appendChild(histChip);
  }

  for (const platform of AUTO_PLATFORM_IDS) {
    const card = document.querySelector(`[data-ai-card="${platform}"]`);
    const badge = document.querySelector(`[data-ai-badge="${platform}"]`);
    const quotaValue = document.querySelector(`[data-ai-quota-value="${platform}"]`);
    const quotaFill = document.querySelector(`[data-ai-quota-fill="${platform}"]`);

    if (!card || !badge) continue;

    const providerInfo = latestProviders.find((p) => p.id === platform);
    const usage = providerInfo?.usage;
    const reqShort = usage
      ? `${usage.requestsToday}/${usage.requestsDailyCap} req`
      : providerInfo && !providerInfo.ready
        ? "sem chave"
        : "0/-- req";

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

    card.classList.remove("is-thinking", "is-completed");
    badge.removeAttribute("data-live-start-ms");

    let execState = "idle";
    let activeTask = null;
    let latestCompletedTask = null;
    let latestCompletedResp = null;

    if (refDebate) {
      const activeTurnId = Array.isArray(refDebate.turns) && refDebate.turns.length > 0
        ? refDebate.turns[refDebate.turns.length - 1].id
        : null;
      const pTasks = (refDebate.tasks || []).filter(
        (t) =>
          t.platform === platform &&
          (!activeTurnId || !t.turnId || t.turnId === activeTurnId)
      );
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

    const openRightDrawerOnMobile = () => {
      $("#right-ai-panel")?.classList.add("is-open");
      $("#mobile-backdrop")?.classList.add("is-visible");
    };

    if (execState === "thinking" && activeTask) {
      card.classList.add("is-thinking");
      card.classList.remove("is-scroll-focused");
      const startMs = getTaskStartMs(activeTask, refDebate);
      const elapsedSec = (Date.now() - startMs) / 1000;

      badge.className = "ai-exec-badge thinking";
      badge.textContent = formatStopwatch(elapsedSec);
      badge.setAttribute("data-live-start-ms", String(startMs));

      if (mobileStrip) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "mobile-ai-chip is-thinking";
        chip.textContent = `${PLATFORMS[platform]} ${formatSecondsPadded(elapsedSec)} (${reqShort})`;
        chip.setAttribute("data-mobile-live-start-ms", String(startMs));
        chip.setAttribute("data-mobile-monogram", PLATFORMS[platform]);
        chip.setAttribute("data-mobile-req", reqShort);
        chip.addEventListener("click", openRightDrawerOnMobile);
        mobileStrip.appendChild(chip);
      }
    } else if (execState === "completed" && latestCompletedTask) {
      card.classList.add("is-completed");
      const durSec = getCompletedTaskDurationSec(latestCompletedTask, latestCompletedResp);
      const durText = durSec ? formatSecondsCompact(durSec) : "OK";

      badge.className = "ai-exec-badge completed";
      badge.textContent = `✔ ${durText}`;

      if (mobileStrip) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "mobile-ai-chip";
        chip.textContent = `${PLATFORMS[platform]} ✔ ${durText} (${reqShort})`;
        chip.addEventListener("click", openRightDrawerOnMobile);
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
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "mobile-ai-chip";
        chip.textContent = `${PLATFORMS[platform]} • ${reqShort}`;
        chip.addEventListener("click", openRightDrawerOnMobile);
        mobileStrip.appendChild(chip);
      }
    }
  }

  renderRightPanelTelemetryFeed(refDebate);
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
    const reqShort = el.getAttribute("data-mobile-req") || "";
    if (Number.isFinite(startMs) && startMs > 0) {
      el.textContent = reqShort
        ? `${monogram} ${formatSecondsPadded((now - startMs) / 1000)} (${reqShort})`
        : `${monogram} ${formatSecondsPadded((now - startMs) / 1000)}`;
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
    row.setAttribute("data-scroll-reveal", "");

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

  observeScrollRevealElements(historyList);
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
    row.setAttribute("data-scroll-reveal", "");

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

  observeScrollRevealElements(container);
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
      feedback.textContent = "Digite sua mensagem.";
    }
    topicInput?.focus();
    return;
  }

  const checkboxes = $$('input[name="participants"]:checked');
  const participants = checkboxes.map((cb) => cb.value);

  if (selectedInteractionMode === "debate" && participants.length < 2) {
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

  const currentDebate = getActiveOrSelectedDebate();
  if (currentDebate && currentDebate.status === "running") {
    if (feedback) {
      feedback.textContent = "Aguarde a resposta atual ou pause.";
    }
    return;
  }

  const rawTitle = (titleInput?.value || "").trim();
  const finalTitle = currentDebate
    ? currentDebate.title
    : rawTitle || generateTitleFromTopic(topicValue);

  const totalRounds =
    selectedInteractionMode === "direct" ? 1 : Number(roundsSelect?.value) || 2;
  const focus =
    selectedResponseMode === "prompt_markdown"
      ? focusSelect?.value || "geral"
      : "geral";
  const rules = (rulesInput?.value || "").trim();

  const attachmentsSnapshot = pendingAttachments.map((f) => ({ ...f }));

  optimisticSubmission = {
    parentDebateId: currentDebate ? currentDebate.id : null,
    title: finalTitle,
    topic: topicValue,
    participants,
    totalRounds,
    focus,
    rules,
    responseMode: selectedResponseMode,
    interactionMode: selectedInteractionMode,
    attachments: attachmentsSnapshot.map((f) => ({ name: f.name, size: f.size })),
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
    if (feedback) feedback.textContent = "Enviando...";

    const result = currentDebate
      ? await fetchJson(`/debates/${currentDebate.id}/message`, {
          method: "POST",
          body: {
            message: topicValue,
            rules: rules || undefined,
            participants,
            totalRounds,
            focus,
            responseMode: selectedResponseMode,
            interactionMode: selectedInteractionMode,
            attachments: attachmentsSnapshot.length > 0 ? attachmentsSnapshot : undefined
          }
        })
      : await fetchJson("/debates", {
          method: "POST",
          body: {
            title: finalTitle,
            topic: topicValue,
            rules: rules || undefined,
            participants,
            totalRounds,
            focus,
            responseMode: selectedResponseMode,
            interactionMode: selectedInteractionMode,
            attachments: attachmentsSnapshot.length > 0 ? attachmentsSnapshot : undefined
          }
        });

    optimisticSubmission = null;
    pendingAttachments = [];
    renderAttachmentsBar();

    if (titleInput) titleInput.value = "";
    if (topicInput) {
      topicInput.value = "";
      topicInput.style.height = "auto";
    }

    if (result?.debate?.id) {
      selectedDebateId = result.debate.id;
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

    lastDebatesSignature = "";
    lastRenderedChatSignature = "";
    renderSidebarDebatesList();
    updateStageTopbar();
    renderChatStage();
    updateRightAiPanel();
    syncComposerModeUi();
    void refreshDashboard();
  } catch (error) {
    optimisticSubmission = null;
    renderChatStage();
    updateRightAiPanel();
    if (feedback) {
      feedback.textContent =
        error instanceof Error ? error.message : "Erro ao enviar.";
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

function renderAttachmentsBar() {
  const bar = $("#composer-attachments-bar");
  if (!bar) return;

  bar.replaceChildren();
  if (pendingAttachments.length === 0) {
    bar.hidden = true;
    return;
  }

  bar.hidden = false;
  pendingAttachments.forEach((file, idx) => {
    const pill = document.createElement("span");
    pill.className = "attachment-pill";

    const nameSpan = document.createElement("span");
    nameSpan.textContent = file.name;

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "attachment-pill-remove";
    removeBtn.setAttribute("aria-label", `Remover ${file.name}`);
    removeBtn.textContent = "×";
    removeBtn.addEventListener("click", () => {
      pendingAttachments.splice(idx, 1);
      renderAttachmentsBar();
    });

    pill.append(nameSpan, removeBtn);
    bar.appendChild(pill);
  });
}

async function addComposerFiles(fileList) {
  const feedback = $("#debate-form-feedback");
  const files = Array.from(fileList || []);
  if (files.length === 0) return;

  const MAX_FILES = 5;
  const MAX_BYTES = 60 * 1024;
  let notice = "";

  for (const file of files) {
    if (pendingAttachments.length >= MAX_FILES) {
      notice = `Máximo de ${MAX_FILES} arquivos por mensagem.`;
      break;
    }
    if (file.size > MAX_BYTES) {
      notice = `${file.name} passa de 60 KB.`;
      continue;
    }
    try {
      const content = await file.text();
      if (content.includes("\0")) {
        notice = `${file.name} não é um arquivo de texto.`;
        continue;
      }
      const existingIdx = pendingAttachments.findIndex((a) => a.name === file.name);
      const entry = { name: file.name, content, size: file.size };
      if (existingIdx >= 0) {
        pendingAttachments[existingIdx] = entry;
      } else {
        pendingAttachments.push(entry);
      }
    } catch {
      notice = `Não foi possível ler ${file.name}.`;
    }
  }

  renderAttachmentsBar();
  if (feedback && notice) {
    feedback.textContent = notice;
  }
}

async function handleRegenerateResponse(debateId, responseId) {
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
    lastRenderedChatSignature = "";
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

async function handleReviewResponse(debateId, responseId, reviewer) {
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
    lastRenderedChatSignature = "";
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

let memoryModalDebateId = null;

function openMemoryModal(debateId) {
  const modal = $("#memory-modal");
  const textarea = $("#memory-editor-input");
  const fb = $("#memory-modal-feedback");
  if (!modal || !textarea) return;

  const debate = debateDetailsById.get(debateId) || getActiveOrSelectedDebate();
  memoryModalDebateId = debateId;
  textarea.value = debate?.sharedMemory?.summary || "";
  if (fb) fb.textContent = "";
  modal.hidden = false;
  textarea.focus();
}

function closeMemoryModal() {
  const modal = $("#memory-modal");
  if (modal) modal.hidden = true;
  memoryModalDebateId = null;
}

async function saveMemoryModal(summaryText) {
  if (!memoryModalDebateId) return;
  const fb = $("#memory-modal-feedback");
  const saveBtn = $("#memory-save-btn");
  const clearBtn = $("#memory-clear-btn");

  try {
    if (saveBtn) saveBtn.disabled = true;
    if (clearBtn) clearBtn.disabled = true;
    if (fb) fb.textContent = "Salvando...";

    const res = await fetchJson(`/debates/${memoryModalDebateId}/memory`, {
      method: "POST",
      body: { summary: summaryText }
    });

    if (res?.debate) {
      upsertDebateSessionLocally(res.debate);
    }

    lastRenderedChatSignature = "";
    updateStageTopbar();
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

function summarizeSessionClient(session) {
  return {
    id: session.id,
    title: session.title,
    topic: session.topic,
    participants: Array.isArray(session.participants) ? session.participants : [],
    totalRounds: session.totalRounds,
    currentRound: session.currentRound,
    currentStage: session.currentStage,
    status: session.status,
    focus: session.focus,
    responseMode: session.responseMode,
    interactionMode: session.interactionMode,
    turnCount:
      typeof session.turnCount === "number"
        ? session.turnCount
        : Array.isArray(session.turns) && session.turns.length > 0
          ? session.turns.length
          : 1,
    sharedMemoryTurns: session.sharedMemory?.coveredTurnCount,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    completedAt: session.completedAt,
    engineVersion: session.engineVersion
  };
}

function upsertDebateSessionLocally(debateSession) {
  if (!debateSession || !debateSession.id) return;
  if (Array.isArray(debateSession.tasks) && Array.isArray(debateSession.responses)) {
    debateDetailsById.set(debateSession.id, debateSession);
  }
  const summary = summarizeSessionClient(debateSession);
  const existingIdx = latestDebates.findIndex((d) => d.id === debateSession.id);
  if (existingIdx >= 0) {
    latestDebates[existingIdx] = summary;
  } else {
    latestDebates = [summary, ...latestDebates];
  }
}

async function loadDebateDetail(debateId) {
  if (!debateId) return null;
  detailFetchInFlightId = debateId;
  try {
    const res = await fetchJson(`/debates/${debateId}`);
    if (res?.debate?.id) {
      upsertDebateSessionLocally(res.debate);

      // Limpa streams que já viraram respostas salvas
      const savedTaskIds = new Set(
        (res.debate.responses || []).map((r) => r.taskId)
      );
      for (const [tId, st] of activeStreamsByTaskId.entries()) {
        if (st.debateId === debateId && savedTaskIds.has(tId)) {
          activeStreamsByTaskId.delete(tId);
        }
      }

      if (Array.isArray(res.activeStreams)) {
        for (const stream of res.activeStreams) {
          if (stream?.taskId && !savedTaskIds.has(stream.taskId)) {
            activeStreamsByTaskId.set(stream.taskId, stream);
          }
        }
      }

      renderSidebarDebatesList();
      updateStageTopbar();
      renderChatStage();
      updateRightAiPanel();
      syncComposerModeUi();
      return res.debate;
    }
  } catch (error) {
    console.warn("[AI Council] Falha ao carregar detalhe da conversa:", error);
  } finally {
    if (detailFetchInFlightId === debateId) {
      detailFetchInFlightId = null;
    }
  }
  return null;
}

async function refreshProvidersOnly() {
  try {
    const providersData = await fetchJson("/providers");
    if (Array.isArray(providersData?.providers)) {
      latestProviders = providersData.providers;
      updateProviderCards(latestProviders);
      updateRightAiPanel();
    }
  } catch {
    // Ignora falha transitória
  }
}

function disconnectEventStream() {
  if (sseReconnectTimer) {
    clearTimeout(sseReconnectTimer);
    sseReconnectTimer = null;
  }
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
  isSseConnected = false;
}

function connectEventStream() {
  if (typeof EventSource === "undefined") return;
  if (eventSource) return;

  const token = getStoredSessionToken();
  const streamUrl = token
    ? `/events/stream?session=${encodeURIComponent(token)}`
    : "/events/stream";

  try {
    const es = new EventSource(streamUrl);
    eventSource = es;

    es.addEventListener("open", () => {
      isSseConnected = true;
      scheduleNextRefresh();
    });

    es.addEventListener("ready", (ev) => {
      isSseConnected = true;
      try {
        const payload = JSON.parse(ev.data || "{}");
        if (Array.isArray(payload.activeStreams)) {
          activeStreamsByTaskId.clear();
          for (const st of payload.activeStreams) {
            if (st?.taskId) {
              activeStreamsByTaskId.set(st.taskId, st);
            }
          }
          if (selectedDebateId) {
            lastRenderedChatSignature = "";
            renderChatStage();
          }
        }
      } catch {
        // Ignora
      }
      scheduleNextRefresh();
    });

    es.addEventListener("stream_start", (ev) => {
      try {
        const data = JSON.parse(ev.data || "{}");
        if (!data?.taskId) return;
        activeStreamsByTaskId.set(data.taskId, {
          ...data,
          content: ""
        });
        if (data.debateId === selectedDebateId) {
          lastRenderedChatSignature = "";
          renderChatStage();
        }
      } catch {
        // Ignora
      }
    });

    es.addEventListener("stream_delta", (ev) => {
      try {
        const data = JSON.parse(ev.data || "{}");
        if (!data?.taskId || !data.delta) return;
        let entry = activeStreamsByTaskId.get(data.taskId);
        if (!entry) {
          entry = {
            debateId: data.debateId,
            taskId: data.taskId,
            round: 1,
            stage: "initial_response",
            platform: "gemini",
            content: "",
            startedAt: new Date().toISOString()
          };
          activeStreamsByTaskId.set(data.taskId, entry);
        }
        entry.content += data.delta;
        if (entry.debateId === selectedDebateId) {
          scheduleStreamBodyPaint(data.taskId);
        }
      } catch {
        // Ignora
      }
    });

    es.addEventListener("stream_reset", (ev) => {
      try {
        const data = JSON.parse(ev.data || "{}");
        const entry = activeStreamsByTaskId.get(data?.taskId);
        if (entry) {
          entry.content = "";
          if (entry.debateId === selectedDebateId) {
            scheduleStreamBodyPaint(data.taskId);
          }
        }
      } catch {
        // Ignora
      }
    });

    es.addEventListener("stream_end", (ev) => {
      try {
        const data = JSON.parse(ev.data || "{}");
        if (data?.taskId) {
          activeStreamsByTaskId.delete(data.taskId);
        }
      } catch {
        // Ignora
      }
    });

    es.addEventListener("debate_updated", (ev) => {
      try {
        const data = JSON.parse(ev.data || "{}");
        void refreshDashboard();
        if (data?.debateId && data.debateId === selectedDebateId) {
          void loadDebateDetail(data.debateId);
        }
      } catch {
        void refreshDashboard();
      }
    });

    es.addEventListener("providers_updated", () => {
      void refreshProvidersOnly();
    });

    es.onerror = () => {
      isSseConnected = false;
      es.close();
      if (eventSource === es) {
        eventSource = null;
      }
      scheduleNextRefresh();
      if (!sseReconnectTimer) {
        sseReconnectTimer = setTimeout(() => {
          sseReconnectTimer = null;
          connectEventStream();
        }, 3000);
      }
    };
  } catch {
    isSseConnected = false;
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
    lastDebatesSignature = "";
    lastRenderedChatSignature = "";
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

async function handlePauseDebate(debateId) {
  try {
    const res = await fetchJson(`/debates/${debateId}/pause`, {
      method: "POST",
      body: {
        reason: "Debate pausado manualmente pelo painel. Estado integralmente preservado."
      }
    });

    if (res?.debate) {
      upsertDebateSessionLocally(res.debate);
    }

    lastDebatesSignature = "";
    lastRenderedChatSignature = "";
    updateStageTopbar();
    renderChatStage();
    updateRightAiPanel();
    void refreshDashboard();
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

    if (res?.debate) {
      upsertDebateSessionLocally(res.debate);
      if (res.debate.tasks) {
        const now = Date.now();
        for (const t of res.debate.tasks) {
          if (t.status === "pending") {
            localTaskStartMs.set(t.id, now);
          }
        }
      }
    }

    lastDebatesSignature = "";
    lastRenderedChatSignature = "";
    updateStageTopbar();
    renderChatStage();
    updateRightAiPanel();
    void refreshDashboard();
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

  const delay = isSseConnected
    ? SSE_FALLBACK_REFRESH_INTERVAL
    : hasRunningDebate
      ? ACTIVE_REFRESH_INTERVAL
      : IDLE_REFRESH_INTERVAL;

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

  // Se um servidor legado ainda retornar sessões completas no /status, guarda no cache local.
  for (const item of latestDebates) {
    if (Array.isArray(item.tasks) && Array.isArray(item.responses)) {
      debateDetailsById.set(item.id, item);
    }
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
    debateDetailsById.delete(selectedDebateId);
    selectedDebateId = null;
  }

  // Garante que o detalhe completo da conversa selecionada esteja sincronizado com o updatedAt do /status.
  if (selectedDebateId) {
    const summary = latestDebates.find((d) => d.id === selectedDebateId);
    const cached = debateDetailsById.get(selectedDebateId);
    const needsDetail =
      summary &&
      (!cached ||
        cached.updatedAt !== summary.updatedAt ||
        cached.status !== summary.status);
    if (needsDetail && detailFetchInFlightId !== selectedDebateId) {
      void loadDebateDetail(selectedDebateId);
    }
  }

  // Se o servidor suportar SSE, garante conexão ativa em tempo real.
  if (data?.capabilities?.streaming && !eventSource) {
    connectEventStream();
  }

  setText("#total-events", String(totalEvents));
  setText(
    "#monitor-status",
    isSseConnected ? "Tempo real (SSE) ativo" : "Monitoramento local ativo"
  );

  const feedbackEl = $("#debate-form-feedback");
  const serverSupportsModes = Boolean(data?.capabilities?.responseModes);
  if (feedbackEl) {
    if (!serverSupportsModes) {
      feedbackEl.textContent = "Reinicie o servidor (Ctrl+C e npm run monitor) para ativar os novos modos.";
    } else if (feedbackEl.textContent.includes("Reinicie o servidor")) {
      feedbackEl.textContent = "";
    }
  }

  updatePlatformCards(sortedEvents);
  updateProviderCards(latestProviders);
  updateHistory(sortedEvents);
  updateDashboardDebatesSummary(latestDebates, data.activeDebatesCount);

  renderSidebarDebatesList();
  updateStageTopbar();
  renderChatStage();
  updateRightAiPanel();
  syncComposerModeUi();
}

async function refreshDashboard() {
  if (isRefreshing) {
    pendingImmediateRefresh = true;
    return;
  }

  isRefreshing = true;
  if (refreshTimerId) {
    clearTimeout(refreshTimerId);
    refreshTimerId = null;
  }

  try {
    // Dispara /providers de forma independente para preencher as cotas (req) imediatamente
    const providersPromise = fetchJson("/providers")
      .then((providersData) => {
        if (Array.isArray(providersData?.providers)) {
          latestProviders = providersData.providers;
          updateProviderCards(latestProviders);
          updateRightAiPanel();
        }
        return providersData;
      })
      .catch(() => null);

    const status = await fetchJson("/status");
    const providersData = await providersPromise;

    setServerStatus(true);
    updateDashboard(status, providersData?.providers);
  } catch (error) {
    console.error("[AI Council] Erro ao atualizar painel:", error);
    setServerStatus(false);
    setCardsUnknownOnError();
    setText("#monitor-status", "Estado desconhecido: sem conexão");
  } finally {
    isRefreshing = false;
    if (pendingImmediateRefresh) {
      pendingImmediateRefresh = false;
      setTimeout(() => {
        void refreshDashboard();
      }, 250);
    } else {
      scheduleNextRefresh();
    }
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
// INICIALIZAÇÃO DE EVENTOS DE UI, STICKY DOCK & PARALLAX
// ============================================================================

function initializeCollapsibleLayout() {
  const appShell = $("#app-shell");

  try {
    if (localStorage.getItem("ai-council-left-collapsed") === "true") {
      appShell?.classList.add("is-left-collapsed");
    }
    if (localStorage.getItem("ai-council-right-collapsed") === "true") {
      appShell?.classList.add("is-right-collapsed");
    }
  } catch {
    // Ignora
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

function initializeParallaxAndStickyAnimations() {
  const mainStage = $("#main-stage");
  const chatScroll = $("#chat-scroll-area");
  const dashScroll = $("#dashboard-scroll-area");
  const histScroll = $("#history-scroll-area");
  const rightScroll = $("#right-panel-scroll");

  // 1. Parallax por movimento do cursor no Palco Central
  mainStage?.addEventListener("pointermove", (e) => {
    const rect = mainStage.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    parallaxMouseX = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
    parallaxMouseY = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
    scheduleParallaxRender();
  });

  // 2. Scroll-Linked e Parallax no Chat e nas Abas
  chatScroll?.addEventListener("scroll", updateChatScrollLinkedEffects, { passive: true });

  dashScroll?.addEventListener(
    "scroll",
    () => {
      parallaxScrollY = dashScroll.scrollTop;
      scheduleParallaxRender();
    },
    { passive: true }
  );

  histScroll?.addEventListener(
    "scroll",
    () => {
      parallaxScrollY = histScroll.scrollTop;
      scheduleParallaxRender();
    },
    { passive: true }
  );

  // 3. Animação de Sticky Stack ao rolar a Barra Lateral Direita (#right-panel-scroll)
  rightScroll?.addEventListener(
    "scroll",
    () => {
      rightScroll.classList.toggle("is-scrolled", rightScroll.scrollTop > 8);
    },
    { passive: true }
  );

  // 4. Física Magnética (Sticky Cursor) nos 3 Cards de IAs Automáticas da Barra Lateral
  for (const plat of AUTO_PLATFORM_IDS) {
    const card = document.querySelector(`[data-ai-card="${plat}"]`);
    if (!card) continue;

    card.addEventListener("pointermove", (e) => {
      const rect = card.getBoundingClientRect();
      const relY = (e.clientY - rect.top) / Math.max(1, rect.height) - 0.5;
      card.style.setProperty("--mag-y", `${(relY * 2.5).toFixed(1)}px`);
    });

    card.addEventListener("pointerleave", () => {
      card.style.setProperty("--mag-y", "0px");
    });

    // Clicar no card da IA na barra lateral desliza para a resposta mais recente dela no chat
    card.addEventListener("click", () => {
      const cardsInChat = $$(`.ai-response-card[data-response-platform="${plat}"]`);
      if (cardsInChat.length > 0) {
        const latestCard = cardsInChat[cardsInChat.length - 1];
        latestCard.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
        setScrollFocusedAiInRightDock(plat);
      }
    });
  }
}

function initializeUiBindings() {
  initializeCollapsibleLayout();
  initScrollTriggerObserver();
  initializeParallaxAndStickyAnimations();

  const createForm = $("#create-debate-form");
  if (createForm) {
    createForm.addEventListener("submit", handleCreateDebate);

    createForm.addEventListener("dragover", (e) => {
      e.preventDefault();
      createForm.classList.add("is-dragover");
    });

    createForm.addEventListener("dragleave", (e) => {
      if (!createForm.contains(e.relatedTarget)) {
        createForm.classList.remove("is-dragover");
      }
    });

    createForm.addEventListener("drop", (e) => {
      e.preventDefault();
      createForm.classList.remove("is-dragover");
      if (e.dataTransfer?.files?.length) {
        void addComposerFiles(e.dataTransfer.files);
      }
    });
  }

  const fileInput = $("#composer-file-input");
  $("#composer-attach-btn")?.addEventListener("click", () => {
    fileInput?.click();
  });
  fileInput?.addEventListener("change", () => {
    if (fileInput.files?.length) {
      void addComposerFiles(fileInput.files);
      fileInput.value = "";
    }
  });

  // Modal de Memória Compartilhada
  $("#memory-modal-close")?.addEventListener("click", closeMemoryModal);
  $("#memory-cancel-btn")?.addEventListener("click", closeMemoryModal);
  $("#memory-modal")?.addEventListener("click", (e) => {
    if (e.target === $("#memory-modal")) closeMemoryModal();
  });
  $("#memory-save-btn")?.addEventListener("click", () => {
    const val = $("#memory-editor-input")?.value || "";
    void saveMemoryModal(val);
  });
  $("#memory-clear-btn")?.addEventListener("click", () => {
    const textarea = $("#memory-editor-input");
    if (textarea) textarea.value = "";
    void saveMemoryModal("");
  });

  document.addEventListener("click", () => {
    for (const openMenu of $$(".review-dropdown-menu")) {
      openMenu.hidden = true;
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeMemoryModal();
      for (const openMenu of $$(".review-dropdown-menu")) {
        openMenu.hidden = true;
      }
    }
  });

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

  for (const btn of $$("#response-mode-toggle .mode-seg-btn")) {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-response-mode");
      if (mode === "normal" || mode === "prompt_markdown") {
        selectedResponseMode = mode;
        saveStoredOption(RESPONSE_MODE_STORAGE_KEY, mode);
        syncComposerModeUi();
      }
    });
  }

  for (const btn of $$("#interaction-mode-toggle .mode-seg-btn")) {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-interaction-mode");
      if (mode === "direct" || mode === "debate") {
        selectedInteractionMode = mode;
        saveStoredOption(INTERACTION_MODE_STORAGE_KEY, mode);
        syncComposerModeUi();
      }
    });
  }

  syncComposerModeUi();

  const advBtn = $("#toggle-advanced-btn");
  const advPanel = $("#composer-advanced");
  if (advBtn && advPanel) {
    advBtn.addEventListener("click", () => {
      const isHidden = advPanel.hidden;
      advPanel.hidden = !isHidden;
      advBtn.setAttribute("aria-expanded", String(isHidden));
      const span = advBtn.querySelector("span");
      if (span) {
        span.textContent = isHidden ? "− Opções" : "+ Opções";
      }
    });
  }

  $("#btn-new-debate")?.addEventListener("click", startNewDebateView);

  for (const navBtn of $$("[data-view-target]")) {
    navBtn.addEventListener("click", () => {
      const target = navBtn.getAttribute("data-view-target") || "chat";
      switchView(target);
    });
  }

  const leftSidebar = $("#left-sidebar");
  const rightPanel = $("#right-ai-panel");
  const backdrop = $("#mobile-backdrop");

  $("#open-left-drawer")?.addEventListener("click", () => {
    document.querySelector('[data-sidebar-section="debates"]')?.classList.remove("is-collapsed");
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

  // Autenticação por senha para celular / acesso remoto HTTPS
  const authForm = $("#auth-login-form");
  const authInput = $("#auth-password-input");
  const authError = $("#auth-lock-error");
  const authSubmit = $("#auth-submit-btn");
  const lockBtn = $("#btn-lock-session");

  if (lockBtn) {
    const isLocalHost =
      window.location.hostname === "127.0.0.1" ||
      window.location.hostname === "localhost";
    lockBtn.hidden = isLocalHost && !getStoredSessionToken();
  }

  authForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = (authInput?.value || "").trim();
    if (!password) {
      if (authError) authError.textContent = "Digite a senha de acesso.";
      authInput?.focus();
      return;
    }

    try {
      if (authSubmit) authSubmit.disabled = true;
      if (authError) authError.textContent = "Verificando...";

      const res = await fetchJson("/auth/login", {
        method: "POST",
        body: { password }
      });

      if (res?.sessionToken) {
        setStoredSessionToken(res.sessionToken);
      }

      if (authInput) authInput.value = "";
      if (lockBtn) lockBtn.hidden = false;
      hideAuthLockOverlay();
      disconnectEventStream();
      connectEventStream();
      await refreshDashboard();
    } catch (err) {
      if (authError) {
        authError.textContent =
          err instanceof Error ? err.message : "Senha inválida.";
      }
    } finally {
      if (authSubmit) authSubmit.disabled = false;
    }
  });

  lockBtn?.addEventListener("click", async () => {
    disconnectEventStream();
    setStoredSessionToken("");
    await fetchJson("/auth/logout", { method: "POST" }).catch(() => {});
    showAuthLockOverlay("Sessão bloqueada neste dispositivo.");
  });
}

function initializeDashboard() {
  console.log("[AI Council] Intelligence Hub (Eraser + Advanced Scroll/Parallax Motion) iniciado.");

  initializeUiBindings();
  renderZeroStateHorizontalShowcase();
  updateClock();
  void refreshDashboard();

  setInterval(updateClock, 1000);
  setInterval(tickLiveTimers, LIVE_TIMER_INTERVAL);
}

document.addEventListener("DOMContentLoaded", initializeDashboard);
