const SERVER_BASE_URL = "http://127.0.0.1:4317";
const EVENTS_URL = `${SERVER_BASE_URL}/events`;
const STATUS_URL = `${SERVER_BASE_URL}/status`;

const REQUEST_TIMEOUT_MS = 5000;
const DEDUP_WINDOW_MS = 15000;

const VALID_SOURCES = new Set(["chatgpt", "claude", "gemini"]);
const VALID_CONFIDENCE = new Set(["high", "medium"]);

const EXPECTED_SIGNAL_BY_SEVERITY = {
  warning: "approaching_usage_limit",
  blocked: "usage_limit_reached"
};

const recentFingerprints = new Map();

function getAuthToken() {
  const token = globalThis.AI_COUNCIL_CONFIG?.token;
  return typeof token === "string" && token.trim() ? token.trim() : null;
}

function validateOutgoingEvent(event) {
  if (!event || typeof event !== "object") {
    return "Evento ausente ou malformado.";
  }

  if (!VALID_SOURCES.has(event.source)) {
    return "Plataforma (source) inválida.";
  }

  const expectedSignal = EXPECTED_SIGNAL_BY_SEVERITY[event.severity];
  if (!expectedSignal) {
    return "Severidade (severity) inválida.";
  }

  if (event.signal !== expectedSignal) {
    return `Inconsistência entre severity (${event.severity}) e signal (${event.signal}).`;
  }

  if (!VALID_CONFIDENCE.has(event.confidence)) {
    return "Nível de confiança (confidence) inválido.";
  }

  if (typeof event.message !== "string" || !event.message.trim()) {
    return "Mensagem do evento inválida.";
  }

  if (typeof event.matchedText !== "string" || !event.matchedText.trim()) {
    return "Texto capturado (matchedText) inválido.";
  }

  if (typeof event.url !== "string" || !event.url.trim()) {
    return "URL do evento inválida.";
  }

  return null;
}

function isDuplicateInShortWindow(event) {
  const now = Date.now();

  for (const [key, timestamp] of recentFingerprints.entries()) {
    if (now - timestamp > DEDUP_WINDOW_MS) {
      recentFingerprints.delete(key);
    }
  }

  const key = `${event.source}:${event.severity}:${event.signal}:${event.matchedText}`;
  const lastTime = recentFingerprints.get(key);

  if (lastTime && now - lastTime <= DEDUP_WINDOW_MS) {
    return true;
  }

  return false;
}

function markFingerprintSent(event) {
  const key = `${event.source}:${event.severity}:${event.signal}:${event.matchedText}`;
  recentFingerprints.set(key, Date.now());
}

async function parseResponseBody(response) {
  const rawText = await response.text();

  if (!rawText) {
    return {};
  }

  try {
    return JSON.parse(rawText);
  } catch {
    return { rawText };
  }
}

async function handleLimitEvent(event) {
  const token = getAuthToken();

  if (!token) {
    console.error("[AI Council] Token ausente ou inválido na configuração.");
    return { saved: false, error: "Configuração de autenticação ausente." };
  }

  const validationError = validateOutgoingEvent(event);
  if (validationError) {
    console.warn("[AI Council] Evento rejeitado no background:", validationError);
    return { saved: false, error: validationError };
  }

  if (isDuplicateInShortWindow(event)) {
    return { saved: true, deduplicated: true };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(EVENTS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AI-Council-Token": token
      },
      body: JSON.stringify(event),
      signal: controller.signal
    });

    const result = await parseResponseBody(response);

    if (!response.ok) {
      const serverError =
        typeof result?.error === "string"
          ? result.error
          : `HTTP ${response.status}`;
      throw new Error(serverError);
    }

    markFingerprintSent(event);

    console.log(
      "[AI Council] Evento registrado:",
      event.source,
      event.severity,
      event.signal
    );

    return { saved: true };
  } catch (error) {
    const errorMessage =
      error?.name === "AbortError"
        ? "Tempo limite de conexão com o servidor esgotado."
        : error instanceof Error
          ? error.message
          : String(error);

    console.error("[AI Council] Erro ao registrar evento:", errorMessage);

    return {
      saved: false,
      error: errorMessage
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function handleGetPendingTask(source) {
  const token = getAuthToken();
  if (!token || !VALID_SOURCES.has(source)) {
    return { ok: false, task: null };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(STATUS_URL, {
      method: "GET",
      headers: {
        "X-AI-Council-Token": token
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return { ok: false, task: null };
    }

    const data = await parseResponseBody(response);
    const debates = Array.isArray(data?.debates) ? data.debates : [];

    // Procura o primeiro debate ativo (running) que tenha tarefa pendente para esta IA
    for (const debate of debates) {
      if (debate.status !== "running") continue;

      const tasks = Array.isArray(debate.tasks) ? debate.tasks : [];
      const pendingTask = tasks.find(
        (t) =>
          t.platform === source &&
          t.status === "pending" &&
          t.round === debate.currentRound &&
          t.stage === debate.currentStage
      );

      if (pendingTask) {
        return {
          ok: true,
          debateId: debate.id,
          debateTitle: debate.title,
          currentRound: debate.currentRound,
          totalRounds: debate.totalRounds,
          task: pendingTask
        };
      }
    }

    return { ok: true, task: null };
  } catch {
    return { ok: false, task: null };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function handleSubmitTaskResponse(payload) {
  const token = getAuthToken();
  if (!token) {
    return { ok: false, error: "Token de configuração ausente." };
  }

  const debateId = payload?.debateId;
  const taskId = payload?.taskId;
  const content = payload?.content;

  if (
    typeof debateId !== "string" ||
    typeof taskId !== "string" ||
    typeof content !== "string" ||
    !content.trim()
  ) {
    return { ok: false, error: "Dados da resposta incompletos." };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(
      `${SERVER_BASE_URL}/debates/${debateId}/respond`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-AI-Council-Token": token
        },
        body: JSON.stringify({ taskId, content }),
        signal: controller.signal
      }
    );

    const result = await parseResponseBody(response);

    if (!response.ok) {
      return {
        ok: false,
        error: result?.error || `Erro HTTP ${response.status}`
      };
    }

    return { ok: true, debate: result.debate };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

browser.runtime.onMessage.addListener((message) => {
  if (message?.type === "AI_COUNCIL_LIMIT_EVENT") {
    return handleLimitEvent(message.event);
  }

  if (message?.type === "AI_COUNCIL_GET_PENDING_TASK") {
    return handleGetPendingTask(message.source);
  }

  if (message?.type === "AI_COUNCIL_SUBMIT_TASK_RESPONSE") {
    return handleSubmitTaskResponse(message.payload);
  }

  return false;
});