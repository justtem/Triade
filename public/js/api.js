import {
  ACTIVE_REFRESH_INTERVAL,
  IDLE_REFRESH_INTERVAL,
  SSE_FALLBACK_REFRESH_INTERVAL,
  $,
  setText,
  state,
  debateDetailsById,
  activeStreamsByTaskId,
  sortDebatesPinnedFirst,
  upsertDebateSessionLocally,
  uiHooks
} from "./state.js";

export function setServerStatus(online) {
  const indicator = $("#server-indicator");
  if (indicator) {
    indicator.classList.remove("online", "offline", "checking");
    indicator.classList.add(online ? "online" : "offline");
  }
  setText("#server-status", online ? "Servidor online" : "Servidor offline");
}

export function clearLegacyStoredSessionToken() {
  try {
    localStorage.removeItem("ai-council-session-token");
  } catch {
    // Ignora
  }
}

export function showAuthLockOverlay(message = "") {
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

export function hideAuthLockOverlay() {
  const overlay = $("#auth-lock-overlay");
  const errEl = $("#auth-lock-error");
  if (overlay) overlay.hidden = true;
  if (errEl) errEl.textContent = "";
}

export function showVaultLockOverlay(options = {}) {
  const overlay = $("#vault-lock-overlay");
  const form = $("#vault-unlock-form");
  const remoteBox = $("#vault-remote-blocked");
  const errEl = $("#vault-lock-error");
  const input = $("#vault-unlock-input");
  const isLocal = options.isLocal !== false;

  if (form) form.hidden = !isLocal;
  if (remoteBox) remoteBox.hidden = isLocal;
  if (errEl && options.message) errEl.textContent = options.message;

  if (overlay && overlay.hidden) {
    overlay.hidden = false;
    if (isLocal) {
      setTimeout(() => input?.focus(), 60);
    }
  }
}

export function hideVaultLockOverlay() {
  const overlay = $("#vault-lock-overlay");
  const errEl = $("#vault-lock-error");
  const input = $("#vault-unlock-input");
  if (overlay) overlay.hidden = true;
  if (errEl) errEl.textContent = "";
  if (input) input.value = "";
}

export async function fetchJson(endpoint, options = {}) {
  const method = options.method || "GET";
  const timeoutMs = options.timeoutMs || (method === "GET" ? 15000 : 25000);
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  try {
    response = await fetch(endpoint, {
      method,
      credentials: "same-origin",
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
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
  if (response.status === 401 && endpoint !== "/auth/login" && endpoint !== "/privacy/vault/unlock") {
    showAuthLockOverlay();
  }
  if (response.status === 423 && data?.code === "VAULT_LOCKED") {
    showVaultLockOverlay({ isLocal: data.isLocal !== false });
  }
  if (!response.ok) {
    const err = new Error(data.error || `Erro HTTP ${response.status}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}


export async function loadDebateDetail(debateId) {
  if (!debateId) return null;
  state.detailFetchInFlightId = debateId;
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

      if (res.debate.id === state.selectedDebateId) {
        uiHooks.syncComposerWithDebate(res.debate);
      }

      uiHooks.renderSidebarDebatesList();
      uiHooks.updateStageTopbar();
      uiHooks.renderChatStage();
      uiHooks.updateRightAiPanel();
      uiHooks.syncComposerModeUi();
      return res.debate;
    }
  } catch (error) {
    console.warn("[AI Council] Falha ao carregar detalhe da conversa:", error);
  } finally {
    if (state.detailFetchInFlightId === debateId) {
      state.detailFetchInFlightId = null;
    }
  }
  return null;
}

export async function refreshProvidersOnly() {
  try {
    const providersData = await fetchJson("/providers");
    if (Array.isArray(providersData?.providers)) {
      state.latestProviders = providersData.providers;
      uiHooks.updateProviderCards(state.latestProviders);
      uiHooks.updateRightAiPanel();
    }
  } catch {
    // Ignora falha transitória
  }
}

export async function loadPromptTemplates() {
  try {
    const data = await fetchJson("/templates");
    if (Array.isArray(data?.templates)) {
      state.promptTemplates = data.templates;
      state.lastZeroShowcaseSignature = "";
      uiHooks.renderZeroStateHorizontalShowcase();
      uiHooks.renderTemplatesModalList();
      return state.promptTemplates;
    }
  } catch (error) {
    console.warn("[AI Council] Falha ao carregar templates:", error);
  }
  return state.promptTemplates;
}

export async function loadProjects() {
  try {
    const data = await fetchJson("/projects");
    if (Array.isArray(data?.projects)) {
      state.userProjects = data.projects;
      uiHooks.renderProjectsSidebar();
      uiHooks.syncComposerProjectPill();
      uiHooks.updateStageTopbar();
      return state.userProjects;
    }
  } catch (error) {
    console.warn("[AI Council] Falha ao carregar projetos:", error);
  }
  return state.userProjects;
}

export async function searchDebatesRemote(rawQuery) {
  const query = String(rawQuery || "").trim();
  if (!query) {
    state.sidebarServerMatchIds = null;
    state.sidebarSearchLoading = false;
    uiHooks.renderSidebarDebatesList();
    return;
  }

  state.sidebarSearchLoading = true;
  try {
    const data = await fetchJson(`/debates/search?q=${encodeURIComponent(query)}`);
    // Ignora se o usuário já mudou a busca enquanto a requisição voava
    if (state.sidebarSearchQuery.trim() !== query) return;
    if (Array.isArray(data?.matchingIds)) {
      state.sidebarServerMatchIds = new Set(data.matchingIds);
    } else if (Array.isArray(data?.debates)) {
      state.sidebarServerMatchIds = new Set(data.debates.map((d) => d.id));
    } else {
      state.sidebarServerMatchIds = new Set();
    }
  } catch {
    // Fallback silencioso para o filtro local por título/tópico
    if (state.sidebarSearchQuery.trim() === query) {
      state.sidebarServerMatchIds = null;
    }
  } finally {
    if (state.sidebarSearchQuery.trim() === query) {
      state.sidebarSearchLoading = false;
      uiHooks.renderSidebarDebatesList();
    }
  }
}

export function disconnectEventStream() {
  if (state.sseReconnectTimer) {
    clearTimeout(state.sseReconnectTimer);
    state.sseReconnectTimer = null;
  }
  if (state.eventSource) {
    state.eventSource.close();
    state.eventSource = null;
  }
  state.isSseConnected = false;
}

export function connectEventStream() {
  if (typeof EventSource === "undefined") return;
  if (state.eventSource) return;

  try {
    // Mesmo domínio envia cookie HttpOnly automaticamente, sem expor token na URL
    const es = new EventSource("/events/stream");
    state.eventSource = es;

    es.addEventListener("open", () => {
      state.isSseConnected = true;
      scheduleNextRefresh();
    });

    es.addEventListener("ready", (ev) => {
      state.isSseConnected = true;
      try {
        const payload = JSON.parse(ev.data || "{}");
        if (Array.isArray(payload.activeStreams)) {
          activeStreamsByTaskId.clear();
          for (const st of payload.activeStreams) {
            if (st?.taskId) {
              activeStreamsByTaskId.set(st.taskId, st);
            }
          }
          if (state.selectedDebateId) {
            state.lastRenderedChatSignature = "";
            uiHooks.renderChatStage();
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
        if (data.debateId === state.selectedDebateId) {
          state.lastRenderedChatSignature = "";
          uiHooks.renderChatStage();
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
        if (entry.debateId === state.selectedDebateId) {
          uiHooks.scheduleStreamBodyPaint(data.taskId);
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
          if (entry.debateId === state.selectedDebateId) {
            uiHooks.scheduleStreamBodyPaint(data.taskId);
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
        if (data?.debateId && data.debateId === state.selectedDebateId) {
          void loadDebateDetail(data.debateId);
        }
      } catch {
        void refreshDashboard();
      }
    });

    es.addEventListener("debate_deleted", (ev) => {
      try {
        const data = JSON.parse(ev.data || "{}");
        if (data?.debateId) {
          uiHooks.removeDebateLocally(data.debateId);
        }
      } catch {
        void refreshDashboard();
      }
    });

    es.addEventListener("providers_updated", () => {
      void refreshProvidersOnly();
    });

    es.onerror = () => {
      state.isSseConnected = false;
      es.close();
      if (state.eventSource === es) {
        state.eventSource = null;
      }
      scheduleNextRefresh();
      if (!state.sseReconnectTimer) {
        state.sseReconnectTimer = setTimeout(() => {
          state.sseReconnectTimer = null;
          connectEventStream();
        }, 3000);
      }
    };
  } catch {
    state.isSseConnected = false;
  }
}


export function scheduleNextRefresh() {
  if (state.refreshTimerId) {
    clearTimeout(state.refreshTimerId);
  }
  const hasRunningDebate =
    Boolean(state.optimisticSubmission) ||
    state.latestDebates.some((d) => d.status === "running");

  const delay = state.isSseConnected
    ? SSE_FALLBACK_REFRESH_INTERVAL
    : hasRunningDebate
      ? ACTIVE_REFRESH_INTERVAL
      : IDLE_REFRESH_INTERVAL;

  state.refreshTimerId = setTimeout(() => {
    void refreshDashboard();
  }, delay);
}

export function updateDashboard(data, providers) {
  const rawEvents = Array.isArray(data.latestEvents) ? data.latestEvents : [];
  const sortedEvents = uiHooks.sortEventsDescending(rawEvents);
  const totalEvents = Number(data.totalEvents) || 0;

  state.latestEvents = sortedEvents;
  state.latestDebates = sortDebatesPinnedFirst(
    Array.isArray(data.debates) ? data.debates : []
  );
  if (Array.isArray(data.projects)) {
    state.userProjects = data.projects;
  }
  if (Array.isArray(providers)) {
    state.latestProviders = providers;
  }

  // Se um servidor legado ainda retornar sessões completas no /status, guarda no cache local.
  for (const item of state.latestDebates) {
    if (Array.isArray(item.tasks) && Array.isArray(item.responses)) {
      debateDetailsById.set(item.id, item);
    }
  }

  if (!state.hasInitializedSelection) {
    state.hasInitializedSelection = true;
    const runningDebate = state.latestDebates.find((d) => d.status === "running");
    if (runningDebate) {
      state.selectedDebateId = runningDebate.id;
    }
  } else if (
    state.selectedDebateId &&
    !state.latestDebates.some((d) => d.id === state.selectedDebateId)
  ) {
    debateDetailsById.delete(state.selectedDebateId);
    state.selectedDebateId = null;
  }

  // Garante que o detalhe completo da conversa selecionada esteja sincronizado com o updatedAt do /status.
  if (state.selectedDebateId) {
    const summary = state.latestDebates.find((d) => d.id === state.selectedDebateId);
    const cached = debateDetailsById.get(state.selectedDebateId);
    const needsDetail =
      summary &&
      (!cached ||
        cached.updatedAt !== summary.updatedAt ||
        cached.status !== summary.status);
    if (needsDetail && state.detailFetchInFlightId !== state.selectedDebateId) {
      void loadDebateDetail(state.selectedDebateId);
    }
  }

  // Se o servidor suportar SSE, garante conexão ativa em tempo real.
  if (data?.capabilities?.streaming && !state.eventSource) {
    connectEventStream();
  }

  setText("#total-events", String(totalEvents));
  setText(
    "#monitor-status",
    state.isSseConnected ? "Tempo real (SSE) ativo" : "Monitoramento local ativo"
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

  uiHooks.updatePlatformCards(sortedEvents);
  uiHooks.updateProviderCards(state.latestProviders);
  uiHooks.updateHistory(sortedEvents);
  uiHooks.updateDashboardDebatesSummary(state.latestDebates, data.activeDebatesCount);

  uiHooks.renderProjectsSidebar();
  uiHooks.renderSidebarDebatesList();
  uiHooks.updateStageTopbar();
  uiHooks.renderChatStage();
  uiHooks.updateRightAiPanel();
  uiHooks.syncComposerModeUi();
  uiHooks.syncComposerProjectPill();
  uiHooks.syncSetupUi(data?.setup);
}

export async function refreshDashboard() {
  if (state.isRefreshing) {
    state.pendingImmediateRefresh = true;
    return;
  }

  state.isRefreshing = true;
  if (state.refreshTimerId) {
    clearTimeout(state.refreshTimerId);
    state.refreshTimerId = null;
  }

  try {
    // Dispara /providers de forma independente para preencher as cotas (req) imediatamente
    const providersPromise = fetchJson("/providers")
      .then((providersData) => {
        if (Array.isArray(providersData?.providers)) {
          state.latestProviders = providersData.providers;
          uiHooks.updateProviderCards(state.latestProviders);
          uiHooks.updateRightAiPanel();
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
    uiHooks.setCardsUnknownOnError();
    setText("#monitor-status", "Estado desconhecido: sem conexão");
  } finally {
    state.isRefreshing = false;
    if (state.pendingImmediateRefresh) {
      state.pendingImmediateRefresh = false;
      setTimeout(() => {
        void refreshDashboard();
      }, 250);
    } else {
      scheduleNextRefresh();
    }
  }
}

