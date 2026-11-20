import {
  RECENT_WINDOW_MS,
  PLATFORMS,
  AUTO_PLATFORM_IDS,
  ALL_PLATFORM_IDS,
  STAGE_LABELS,
  STATUS_LABELS,
  RESPONSE_MODE_LABELS,
  $,
  $$,
  setText,
  state,
  getSessionTurns,
  formatDate,
  formatStopwatch,
  formatSecondsCompact,
  formatSecondsPadded,
  formatCompactNumber,
  getTaskStartMs,
  getCompletedTaskDurationSec,
  getDebateTotalDurationSec,
  getReferenceDebateForRightPanel,
  observeScrollRevealElements,
  setScrollFocusedAiInRightDock,
  uiHooks
} from "./state.js";
import { escapeHtml } from "./markdown.js";

export function getEventDate(event) {
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

export function getEventTimestampMs(event) {
  const dateValue = getEventDate(event);
  if (!dateValue) return 0;
  const parsed = Date.parse(dateValue);
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function sortEventsDescending(events) {
  if (!Array.isArray(events)) return [];
  return [...events].sort((a, b) => getEventTimestampMs(b) - getEventTimestampMs(a));
}

export function getEventMessage(event) {
  return (
    event.message ||
    event.text ||
    event.description ||
    event.notice ||
    "Aviso detectado na plataforma."
  );
}

export function getEventSeverity(event) {
  return String(event?.severity || "").toLowerCase().trim();
}

export function getEventSignal(event) {
  return String(
    event?.signal || event?.type || event?.status || event?.eventType || ""
  )
    .toLowerCase()
    .trim();
}

export function getPlatform(event) {
  return String(event?.platform || event?.source || "").toLowerCase().trim();
}

export function getAvailability(event) {
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

export function isRecent(event) {
  const timestampMs = getEventTimestampMs(event);
  if (!timestampMs) return false;
  const age = Date.now() - timestampMs;
  return age >= 0 && age <= RECENT_WINDOW_MS;
}


export function renderRightPanelTelemetryFeed(refDebate) {
  const feedEl = $("#ai-usage-telemetry-feed");
  if (!feedEl) return;

  feedEl.replaceChildren();

  // 1. Resumo Consolidado de Cotas Diárias (3 IAs Automáticas)
  let totalReqToday = 0;
  let totalReqCap = 0;
  let totalTokensToday = 0;

  for (const plat of AUTO_PLATFORM_IDS) {
    const p = state.latestProviders.find((item) => item.id === plat);
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
    const p = state.latestProviders.find((item) => item.id === plat);
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

export function updateRightAiPanel() {
  const refDebate = state.optimisticSubmission
    ? {
        title: state.optimisticSubmission.title,
        status: "running",
        currentRound: 1,
        totalRounds: state.optimisticSubmission.totalRounds,
        currentStage: "initial_response",
        participants: state.optimisticSubmission.participants,
        updatedAt: new Date(state.optimisticSubmission.startedAtMs).toISOString(),
        tasks: state.optimisticSubmission.participants.map((p, i) => ({
          id: `opt_${i}`,
          round: 1,
          stage: "initial_response",
          platform: p,
          seat: AUTO_PLATFORM_IDS.includes(p) ? "auto" : "manual",
          status: "pending",
          createdAt: new Date(state.optimisticSubmission.startedAtMs).toISOString()
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
    histChip.textContent = `Histórico (${state.latestDebates.length})`;
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

    const providerInfo = state.latestProviders.find((p) => p.id === platform);
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
export function tickLiveTimers() {
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

export function setCardsUnknownOnError() {
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

export function updatePlatformCards(sortedEvents) {
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

export function updateProviderCards(providers) {
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

export function updateHistory(sortedEvents) {
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

export function updateDashboardDebatesSummary(debates, activeDebatesCount) {
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
    row.addEventListener("click", () => uiHooks.selectDebate(debate.id));
    container.appendChild(row);
  }

  observeScrollRevealElements(container);
}


export function updateClock() {
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

