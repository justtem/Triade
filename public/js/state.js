export const IDLE_REFRESH_INTERVAL = 5000;
export const ACTIVE_REFRESH_INTERVAL = 2000;
export const SSE_FALLBACK_REFRESH_INTERVAL = 15000;
export const LIVE_TIMER_INTERVAL = 100;
export const RECENT_WINDOW_MS = 24 * 60 * 60 * 1000;

export const PLATFORMS = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini",
  groq: "Groq",
  openrouter: "OpenRouter"
};

export const PLATFORM_MONOGRAMS = {
  gemini: "GE",
  groq: "GQ",
  openrouter: "OR",
  chatgpt: "GPT",
  claude: "CL"
};

export const AUTO_PLATFORM_IDS = ["gemini", "groq", "openrouter"];
export const ALL_PLATFORM_IDS = ["gemini", "groq", "openrouter", "chatgpt", "claude"];

export const STAGE_LABELS = {
  initial_response: "Análise Inicial",
  critique: "Crítica Cruzada e Refinamento",
  synthesis: "Síntese e Conclusão Conjunta",
  completed: "Finalizado"
};

export const STATUS_LABELS = {
  running: "Em andamento",
  paused_limit: "Pausado (Limite Gratuito Atingido)",
  paused_error: "Pausado (Erro no Provedor)",
  paused_manual: "Pausado Manualmente",
  completed: "Concluído"
};

export const FOCUS_LABELS = {
  geral: "Geral",
  backend: "Backend / código",
  frontend: "Frontend (sem cara de IA)"
};

// Templates rápidos para o Carrossel Horizontal do Zero State
export const ZERO_STATE_BLUEPRINTS = [
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
export const SVG_ICONS = {
  clipboard: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`,
  check: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
  chevronDown: `<svg class="accordion-chevron" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>`,
  pulse: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline></svg>`,
  clock: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 15"></polyline></svg>`,
  pause: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="6" y="4" width="4" height="16"></rect><rect x="14" y="4" width="4" height="16"></rect></svg>`,
  stop: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2"></rect></svg>`,
  user: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle></svg>`,
  pencil: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path></svg>`,
  trash: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"></path></svg>`,
  download: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg>`,
  pin: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"></path><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"></path></svg>`,
  pinFilled: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 17v5"></path><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"></path></svg>`,
  search: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
  template: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><line x1="3" y1="9" x2="21" y2="9"></line><line x1="9" y1="21" x2="9" y2="9"></line></svg>`,
  pdf: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="8" y1="13" x2="16" y2="13"></line><line x1="8" y1="17" x2="13" y2="17"></line></svg>`,
  image: `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>`,
  globe: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><line x1="3" y1="12" x2="21" y2="12"></line><path d="M12 3a14 14 0 0 1 0 18"></path><path d="M12 3a14 14 0 0 0 0 18"></path></svg>`,
  externalLink: `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>`,
  scale: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18"></path><path d="M5 7h14"></path><path d="M3 14l2-7 2 7a2 2 0 0 1-4 0z"></path><path d="M17 14l2-7 2 7a2 2 0 0 1-4 0z"></path><path d="M8 21h8"></path></svg>`,
  star: `<svg width="11" height="11" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon></svg>`,
  mic: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.95" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"></rect><path d="M5 10v1a7 7 0 0 0 14 0v-1"></path><line x1="12" y1="18" x2="12" y2="22"></line><line x1="8" y1="22" x2="16" y2="22"></line></svg>`,
  volume: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path><path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path></svg>`,
  volumeStop: `<svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"></rect></svg>`,
  folder: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>`,
  brain: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 2a3.5 3.5 0 0 0-3.2 4.9A3.5 3.5 0 0 0 5 13.5 3.5 3.5 0 0 0 7.5 20H11V2H9.5z"></path><path d="M14.5 2a3.5 3.5 0 0 1 3.2 4.9A3.5 3.5 0 0 1 19 13.5 3.5 3.5 0 0 1 16.5 20H13V2h1.5z"></path></svg>`
};

// Símbolos SVG oficiais das IAs + Logo do AI Council (para o Trio / Conselho)
export const AI_BRAND_SVGS = {
  gemini: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 2C12 7.52285 16.4772 12 22 12C16.4772 12 12 16.4772 12 22C12 16.4772 7.52285 12 2 12C7.52285 12 12 7.52285 12 2Z" fill="currentColor"/></svg>`,
  groq: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11.5" cy="10.5" r="6.5"></circle><path d="M18 10.5v7a4 4 0 0 1-4 4h-2.5"></path></svg>`,
  openrouter: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4.5c2.5 0 3.5-5 6.5-5h6"></path><path d="M3 12h4.5c2.5 0 3.5 5 6.5 5h6"></path><polyline points="17 4 20 7 17 10"></polyline><polyline points="17 14 20 17 17 20"></polyline></svg>`,
  chatgpt: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M22.282 9.821a5.985 5.985 0 0 0-.516-4.91 6.046 6.046 0 0 0-6.51-2.9A6.065 6.065 0 0 0 4.981 4.18a5.985 5.985 0 0 0-3.998 2.9 6.046 6.046 0 0 0 .743 7.097 5.98 5.98 0 0 0 .51 4.911 6.051 6.051 0 0 0 6.515 2.9A5.985 5.985 0 0 0 13.26 24a6.056 6.056 0 0 0 5.772-4.206 5.99 5.99 0 0 0 3.997-2.9 6.056 6.056 0 0 0-.747-7.073zM13.26 22.43a4.476 4.476 0 0 1-2.876-1.04l.141-.081 4.779-2.758a.795.795 0 0 0 .392-.681v-6.737l2.02 1.168a.071.071 0 0 1 .038.052v5.583a4.504 4.504 0 0 1-4.494 4.494zM3.6 18.304a4.47 4.47 0 0 1-.535-3.014l.142.085 4.783 2.759a.771.771 0 0 0 .78 0l5.843-3.369v2.332a.08.08 0 0 1-.033.062L9.74 19.95a4.5 4.5 0 0 1-6.14-1.646zM2.34 7.896a4.485 4.485 0 0 1 2.366-1.973V11.6a.766.766 0 0 0 .388.676l5.815 3.355-2.02 1.168a.076.076 0 0 1-.071 0l-4.83-2.786A4.504 4.504 0 0 1 2.34 7.872zm16.597 3.855l-5.833-3.387L15.119 7.2a.076.076 0 0 1 .071 0l4.83 2.791a4.494 4.494 0 0 1-.676 8.105v-5.678a.79.79 0 0 0-.407-.667zm2.01-3.023l-.141-.085-4.774-2.782a.776.776 0 0 0-.785 0L9.409 9.23V6.897a.066.066 0 0 1 .028-.061l4.83-2.787a4.5 4.5 0 0 1 6.68 4.66zm-12.64 4.135l-2.02-1.164a.08.08 0 0 1-.038-.057V6.075a4.5 4.5 0 0 1 7.375-3.453l-.142.08L8.704 5.46a.795.795 0 0 0-.393.681zm1.097-2.365l2.602-1.5 2.607 1.5v2.999l-2.597 1.5-2.607-1.5z"/></svg>`,
  claude: `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M13.827 3.52h-1.654l-.47 6.53-4.63-4.61-1.17 1.17 4.61 4.63-6.53.47v1.654l6.53.47-4.61 4.63 1.17 1.17 4.63-4.61.47 6.53h1.654l.47-6.53 4.63 4.61 1.17-1.17-4.61-4.63 6.53-.47v-1.654l-6.53-.47 4.61-4.63-1.17-1.17-4.63 4.61z"/></svg>`,
  trio: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polygon points="12 2 2 7 12 12 22 7 12 2"></polygon><polyline points="2 17 12 22 22 17"></polyline><polyline points="2 12 12 17 22 12"></polyline></svg>`,
  auto: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="5" cy="12" r="2.5"></circle><circle cx="19" cy="6" r="2.5"></circle><circle cx="19" cy="18" r="2.5"></circle><path d="M7.5 11.2L16.5 6.8"></path><path d="M7.5 12.8L16.5 17.2"></path></svg>`
};

export function getAiBrandSvg(key) {
  return AI_BRAND_SVGS[key] || AI_BRAND_SVGS.trio;
}

export const $ = (selector) => document.querySelector(selector);
export const $$ = (selector) => Array.from(document.querySelectorAll(selector));

// ============================================================================
// ESTADO REATIVO DA APLICAÇÃO
// ============================================================================

export const draftResponsesByTaskId = new Map();
export const collapsedStageKeys = new Set();
export const collapsedResponseIds = new Set();
export const expandedWebSourcesTurnKeys = new Set();
export const expandedProjectContextTurnKeys = new Set();
export const appliedVerdictCollapseKeys = new Set();
export const verdictLoadingTurnKeys = new Set();
export const stackedRoundKeys = new Set(); // Permite alternar Horizontal Scroll <-> Empilhado por rodada
export const localTaskStartMs = new Map();

export const RESPONSE_MODE_STORAGE_KEY = "ai-council-response-mode";
export const INTERACTION_MODE_STORAGE_KEY = "ai-council-interaction-mode";
export const WEB_SEARCH_STORAGE_KEY = "ai-council-web-search-mode";
export const AUTO_VERDICT_STORAGE_KEY = "ai-council-auto-verdict";

export const RESPONSE_MODE_LABELS = {
  normal: "Normal",
  prompt_markdown: "Prompt MD"
};

export const INTERACTION_MODE_LABELS = {
  direct: "Direto",
  debate: "Debate"
};

export function loadStoredOption(key, fallback, allowed) {
  try {
    const val = localStorage.getItem(key);
    if (val && allowed.includes(val)) return val;
  } catch {
    // Ignora
  }
  return fallback;
}

export function saveStoredOption(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Ignora
  }
}

export const SINGLE_AI_STORAGE_KEY = "ai-council-single-ai";
export const AUTO_ROUTE_STORAGE_KEY = "ai-council-auto-route";

export const debateDetailsById = new Map();
export const activeStreamsByTaskId = new Map();
export const pendingStreamPaintIds = new Set();

export const state = {
  selectedResponseMode: loadStoredOption(RESPONSE_MODE_STORAGE_KEY, "normal", ["normal", "prompt_markdown"]),
  selectedInteractionMode: loadStoredOption(INTERACTION_MODE_STORAGE_KEY, "direct", ["direct", "debate"]),
  selectedWebSearchMode: loadStoredOption(WEB_SEARCH_STORAGE_KEY, "auto", ["auto", "off"]),
  selectedAutoVerdict: loadStoredOption(AUTO_VERDICT_STORAGE_KEY, "off", ["off", "on"]),
  pendingAttachments: [],
  streamPaintRafId: null,
  eventSource: null,
  isSseConnected: false,
  sseReconnectTimer: null,
  detailFetchInFlightId: null,
  currentView: "chat",
  selectedDebateId: null,
  hasInitializedSelection: false,
  latestDebates: [],
  latestEvents: [],
  latestProviders: [],
  lastDebatesSignature: "",
  lastRenderedChatSignature: "",
  lastZeroShowcaseSignature: "",
  scrollFocusedPlatform: null,
  optimisticSubmission: null,
  refreshTimerId: null,
  isRefreshing: false,
  pendingImmediateRefresh: false,
  scrollRevealObserver: null,
  editingDebateId: null,
  confirmDeleteDebateId: null,
  sidebarSearchQuery: "",
  sidebarServerMatchIds: null,
  sidebarSearchTimerId: null,
  sidebarSearchLoading: false,
  promptTemplates: [],
  editingTemplateId: null,
  userProjects: [],
  selectedProjectFilterId: null,
  activeNewChatProjectId: null,
  editingProjectId: null,
  isUserNearChatBottom: true,
  lastAutoScrollDebateId: null,
  lastAutoScrollContentKey: "",
  hasUnreadBelow: false,
  isSingleAiMode: false,
  isAutoRouteMode: loadStoredOption(AUTO_ROUTE_STORAGE_KEY, "off", ["on", "off"]) === "on",
  preferredSingleAi: loadStoredOption(SINGLE_AI_STORAGE_KEY, "gemini", ALL_PLATFORM_IDS),
  lastSyncedComposerDebateId: null,
  memoryModalDebateId: null,
  editingTurnKey: null,
  userMemoryState: null,
  privacyStatus: null,
  privacyIsLocal: false,
  setupStatus: null,
  isSetupWizardLocked: false,
  parallaxScrollY: 0,
  parallaxScrollX: 0,
  parallaxMouseX: 0,
  parallaxMouseY: 0,
  parallaxRafPending: false
};

export const uiHooks = {
  renderSidebarDebatesList: () => {},
  updateStageTopbar: () => {},
  renderChatStage: () => {},
  updateRightAiPanel: () => {},
  syncComposerModeUi: () => {},
  syncComposerWithDebate: () => {},
  removeDebateLocally: () => {},
  scheduleStreamBodyPaint: () => {},
  updatePlatformCards: () => {},
  updateProviderCards: () => {},
  updateHistory: () => {},
  updateDashboardDebatesSummary: () => {},
  setCardsUnknownOnError: () => {},
  selectDebate: () => {},
  switchView: () => {},
  handleStopDebate: () => {},
  renderZeroStateHorizontalShowcase: () => {},
  renderTemplatesModalList: () => {},
  renderProjectsSidebar: () => {},
  openProjectModal: () => {},
  syncComposerProjectPill: () => {},
  syncSetupUi: () => {},
  renderUserMemoryPanel: () => {},
  sortEventsDescending: (events) => (Array.isArray(events) ? events : [])
};

export function registerUiHooks(hooks) {
  Object.assign(uiHooks, hooks);
}

export function getSessionTurns(debate) {
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

export function getTasksForTurn(debate, turn) {
  const tasks = Array.isArray(debate?.tasks) ? debate.tasks : [];
  const isFirst = turn.index === 1;
  return tasks.filter(
    (t) => t.turnId === turn.id || (isFirst && !t.turnId)
  );
}

export function getResponsesForTurn(debate, turn) {
  const responses = Array.isArray(debate?.responses) ? debate.responses : [];
  const isFirst = turn.index === 1;
  return responses.filter(
    (r) => r.turnId === turn.id || (isFirst && !r.turnId)
  );
}


// ============================================================================
// FORMATAÇÃO DE DATAS E CRONÔMETROS DE ALTA PRECISÃO
// ============================================================================

export function formatDate(value) {
  if (!value) return "Data não informada";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Data não informada";
  return date.toLocaleString("pt-BR");
}

export function formatShortTime(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

export function formatStopwatch(seconds) {
  const safe = Math.max(0, Number(seconds) || 0);
  const mins = Math.floor(safe / 60);
  const rem = safe - mins * 60;
  const secsInt = Math.floor(rem);
  const tenths = Math.floor((rem - secsInt) * 10);
  const mm = String(mins).padStart(2, "0");
  const ss = String(secsInt).padStart(2, "0");
  return `${mm}:${ss}.${tenths}s`;
}

export function formatSecondsCompact(seconds) {
  const safe = Math.max(0.1, Number(seconds) || 0.1);
  if (safe >= 60) {
    const mins = Math.floor(safe / 60);
    const rem = (safe - mins * 60).toFixed(1);
    return `${mins}m ${rem}s`;
  }
  return `${safe.toFixed(1)}s`;
}

export function formatSecondsPadded(seconds) {
  const safe = Math.max(0.1, Number(seconds) || 0.1);
  if (safe < 10) {
    return `0${safe.toFixed(1)}s`;
  }
  return `${safe.toFixed(1)}s`;
}

export function getTaskStartMs(task, debate) {
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

export function getCompletedTaskDurationSec(task, matchingResponse) {
  const startMs = Date.parse(task?.createdAt || "");
  const endMs = Date.parse(task?.completedAt || matchingResponse?.submittedAt || "");
  if (!Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs >= startMs) {
    return Math.max(0.1, (endMs - startMs) / 1000);
  }
  return null;
}

export function getDebateTotalDurationSec(debate) {
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

export function initScrollTriggerObserver() {
  if (!("IntersectionObserver" in window)) return;

  state.scrollRevealObserver = new IntersectionObserver(
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

export function observeScrollRevealElements(root = document) {
  const elements = Array.from(root.querySelectorAll("[data-scroll-reveal]"));
  elements.forEach((el, idx) => {
    if (!el.style.getPropertyValue("--reveal-delay")) {
      el.style.setProperty("--reveal-delay", `${Math.min(idx * 45, 240)}ms`);
    }
    if (state.scrollRevealObserver) {
      state.scrollRevealObserver.observe(el);
    } else {
      el.classList.add("is-revealed");
    }
  });
}


export function scheduleParallaxRender() {
  if (state.parallaxRafPending) return;
  state.parallaxRafPending = true;
  requestAnimationFrame(() => {
    state.parallaxRafPending = false;
    const gridLayer = $("#parallax-grid-layer");
    const nodesLayer = $("#parallax-nodes-layer");

    if (gridLayer) {
      const gx = (-state.parallaxScrollX * 0.18 + state.parallaxMouseX * 10).toFixed(1);
      const gy = (-state.parallaxScrollY * 0.22 + state.parallaxMouseY * 10).toFixed(1);
      gridLayer.style.transform = `translate3d(${gx}px, ${gy}px, 0)`;
    }

    if (nodesLayer) {
      const nx = (-state.parallaxScrollX * 0.35 + state.parallaxMouseX * -22).toFixed(1);
      const ny = (-state.parallaxScrollY * 0.45 + state.parallaxMouseY * -22).toFixed(1);
      nodesLayer.style.transform = `translate3d(${nx}px, ${ny}px, 0)`;
    }

    // Parallax em camadas nas palavras do Display Headline no Zero State
    for (const word of $$(".parallax-word")) {
      const depth = Number(word.getAttribute("data-parallax-depth")) || 1;
      const wx = (state.parallaxMouseX * 14 * depth).toFixed(1);
      const wy = (state.parallaxMouseY * 9 * depth - state.parallaxScrollY * 0.08 * depth).toFixed(1);
      word.style.setProperty("--px", `${wx}px`);
      word.style.setProperty("--py", `${wy}px`);
    }
  });
}


export function setScrollFocusedAiInRightDock(platformId) {
  if (state.scrollFocusedPlatform === platformId) return;
  state.scrollFocusedPlatform = platformId;

  for (const plat of AUTO_PLATFORM_IDS) {
    const card = document.querySelector(`[data-ai-card="${plat}"]`);
    if (!card) continue;
    const isFocused = plat === platformId && !card.classList.contains("is-thinking");
    card.classList.toggle("is-scroll-focused", isFocused);
  }
}


export function setText(selector, value) {
  const element = $(selector);
  if (element) {
    element.textContent = value;
  }
}


export function getActiveOrSelectedDebate() {
  if (!state.selectedDebateId) return null;
  const full = debateDetailsById.get(state.selectedDebateId);
  if (full) return full;
  const summary = state.latestDebates.find((d) => d.id === state.selectedDebateId);
  return summary || null;
}

export function getReferenceDebateForRightPanel() {
  const selected = getActiveOrSelectedDebate();
  if (selected) return selected;
  const runningSummary = state.latestDebates.find((d) => d.status === "running");
  if (!runningSummary) return null;
  return debateDetailsById.get(runningSummary.id) || runningSummary;
}


export function formatCompactNumber(value) {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return "--";
  if (num >= 1000) {
    const k = num / 1000;
    return `${Number.isInteger(k) ? k : k.toFixed(1)}k`;
  }
  return String(num);
}


export function sortDebatesPinnedFirst(list) {
  return [...list].sort((a, b) => {
    const aPin = a?.pinned ? 1 : 0;
    const bPin = b?.pinned ? 1 : 0;
    if (aPin !== bPin) return bPin - aPin;
    const aTime = Date.parse(a?.createdAt || "") || 0;
    const bTime = Date.parse(b?.createdAt || "") || 0;
    return bTime - aTime;
  });
}

export function summarizeSessionClient(session) {
  return {
    id: session.id,
    title: session.title,
    topic: session.topic,
    pinned: Boolean(session.pinned),
    projectId: session.projectId || undefined,
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

export function upsertDebateSessionLocally(debateSession) {
  if (!debateSession || !debateSession.id) return;
  if (Array.isArray(debateSession.tasks) && Array.isArray(debateSession.responses)) {
    debateDetailsById.set(debateSession.id, debateSession);
  }
  const summary = summarizeSessionClient(debateSession);
  const existingIdx = state.latestDebates.findIndex((d) => d.id === debateSession.id);
  if (existingIdx >= 0) {
    state.latestDebates[existingIdx] = summary;
  } else {
    state.latestDebates = [summary, ...state.latestDebates];
  }
  state.latestDebates = sortDebatesPinnedFirst(state.latestDebates);
}

