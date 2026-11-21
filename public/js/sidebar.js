import {
  STATUS_LABELS,
  ZERO_STATE_BLUEPRINTS,
  SVG_ICONS,
  RESPONSE_MODE_LABELS,
  $,
  $$,
  state,
  localTaskStartMs,
  debateDetailsById,
  activeStreamsByTaskId,
  getActiveOrSelectedDebate,
  formatShortTime,
  observeScrollRevealElements,
  setScrollFocusedAiInRightDock,
  sortDebatesPinnedFirst,
  upsertDebateSessionLocally,
  uiHooks
} from "./state.js";
import {
  fetchJson,
  loadDebateDetail,
  searchDebatesRemote,
  refreshDashboard
} from "./api.js";
import { escapeHtml, handleExportConversationMarkdown } from "./markdown.js";
import { setUnreadScrollPillVisible } from "./motion.js";
import { updateRightAiPanel, updateDashboardDebatesSummary } from "./telemetry.js";
import {
  getProjectByIdClient,
  getProjectColorHex,
  handleAssignDebateProject,
  openProjectModal,
  syncComposerProjectPill
} from "./projects.js";
import {
  syncComposerWithDebate,
  syncComposerModeUi,
  openMemoryModal,
  applyPromptTemplate
} from "./composer.js";

export function renderZeroStateHorizontalShowcase() {
  const track = $("#zero-h-track");
  if (!track) return;

  const templatesSource =
    Array.isArray(state.promptTemplates) && state.promptTemplates.length > 0
      ? state.promptTemplates
      : ZERO_STATE_BLUEPRINTS.map((bp, idx) => ({
          id: `fallback_${idx}`,
          tag: bp.tag,
          title: bp.title,
          prompt: bp.topic,
          focus: bp.focus,
          responseMode: "prompt_markdown",
          interactionMode: "debate"
        }));

  const recentSignature = JSON.stringify(
    templatesSource.slice(0, 6).map((t) => ({
      id: t.id,
      title: t.title,
      updatedAt: t.updatedAt
    }))
  );
  if (recentSignature === state.lastZeroShowcaseSignature && track.children.length > 0) {
    return;
  }
  state.lastZeroShowcaseSignature = recentSignature;
  track.replaceChildren();

  // Floating Pill Annotations (Eraser Design System §9.4) — apenas templates rápidos sem repetir a sidebar
  for (const tpl of templatesSource.slice(0, 5)) {
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "zero-template-pill";
    pill.setAttribute("role", "listitem");
    pill.title = tpl.prompt || tpl.topic || tpl.title;
    pill.textContent = tpl.title;
    pill.addEventListener("click", () => applyPromptTemplate(tpl));
    track.appendChild(pill);
  }
}

export function switchView(targetView) {
  state.currentView = targetView;

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
    minimap.hidden = targetView !== "chat" || (!getActiveOrSelectedDebate() && !state.optimisticSubmission);
  }

  updateStageTopbar();
  closeMobileDrawers();
  observeScrollRevealElements();
}

export function selectDebate(debateId) {
  state.selectedDebateId = debateId;
  state.editingDebateId = null;
  state.confirmDeleteDebateId = null;
  state.lastRenderedChatSignature = "";
  state.isUserNearChatBottom = true;
  setUnreadScrollPillVisible(false);
  const existing = getActiveOrSelectedDebate();
  if (existing) {
    syncComposerWithDebate(existing);
  }
  if (state.currentView !== "chat") {
    switchView("chat");
  } else {
    renderSidebarDebatesList();
    uiHooks.renderChatStage();
    updateStageTopbar();
    updateRightAiPanel();
  }
  syncComposerModeUi();
  syncComposerProjectPill();
  closeMobileDrawers();
  void loadDebateDetail(debateId);
}

export function startNewDebateView() {
  state.selectedDebateId = null;
  state.activeNewChatProjectId = state.selectedProjectFilterId || null;
  state.optimisticSubmission = null;
  state.editingDebateId = null;
  state.confirmDeleteDebateId = null;
  state.lastSyncedComposerDebateId = null;
  state.lastRenderedChatSignature = "";
  state.lastAutoScrollDebateId = null;
  state.lastAutoScrollContentKey = "";
  state.isUserNearChatBottom = true;
  setUnreadScrollPillVisible(false);
  $("#composer-dock")?.classList.remove("is-scroll-compact");
  setScrollFocusedAiInRightDock(null);
  switchView("chat");
  renderSidebarDebatesList();
  uiHooks.renderChatStage();
  updateStageTopbar();
  updateRightAiPanel();
  syncComposerModeUi();
  syncComposerProjectPill();

  const topicInput = $("#debate-topic");
  if (topicInput) {
    topicInput.focus();
  }
}

export function closeMobileDrawers() {
  $("#left-sidebar")?.classList.remove("is-open");
  $("#right-ai-panel")?.classList.remove("is-open");
  $("#mobile-backdrop")?.classList.remove("is-visible");
}

export function updateStageTopbar() {
  const titleEl = $("#topbar-title");
  const actionsWrap = $("#topbar-debate-actions");

  if (!titleEl || !actionsWrap) return;

  actionsWrap.replaceChildren();

  if (state.currentView === "dashboard") {
    titleEl.textContent = "Resumo & Monitoramento";
    return;
  }

  if (state.currentView === "history") {
    titleEl.textContent = "Atividade & Histórico";
    return;
  }

  if (state.optimisticSubmission) {
    titleEl.textContent = state.optimisticSubmission.title;
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

  // Seletor de Projeto da conversa ativa (mover conversa para dentro/fora de um Projeto em 1 clique)
  const currentProject = debate.projectId ? getProjectByIdClient(debate.projectId) : null;
  const projWrap = document.createElement("div");
  projWrap.className = "topbar-ai-switcher topbar-project-switcher";

  const projBtn = document.createElement("button");
  projBtn.type = "button";
  projBtn.className = `btn-secondary topbar-project-btn${currentProject ? " has-project" : ""}`;
  projBtn.title = "Vincular ou mover esta conversa para um Projeto";
  projBtn.innerHTML = currentProject
    ? `<span class="project-dot" style="background:${getProjectColorHex(currentProject.color)}"></span><span class="topbar-proj-label">${escapeHtml(currentProject.name)}</span><span class="topbar-ai-caret" aria-hidden="true">▾</span>`
    : `${SVG_ICONS.folder}<span class="topbar-proj-label">Projeto</span><span class="topbar-ai-caret" aria-hidden="true">▾</span>`;

  const projMenu = document.createElement("div");
  projMenu.className = "topbar-ai-menu topbar-project-menu";
  projMenu.hidden = true;

  const projHeader = document.createElement("div");
  projHeader.className = "topbar-ai-menu-heading";
  projHeader.textContent = "MOVER PARA PROJETO";
  projMenu.appendChild(projHeader);

  const noneOpt = document.createElement("button");
  noneOpt.type = "button";
  noneOpt.className = `topbar-ai-option${!currentProject ? " is-active" : ""}`;
  noneOpt.innerHTML = `
    <span class="topbar-ai-opt-left">
      <span class="project-dot project-dot-all"></span>
      <span>Sem projeto (Avulsa)</span>
    </span>
    <span class="topbar-ai-opt-check" aria-hidden="true">✔</span>
  `;
  noneOpt.addEventListener("click", (e) => {
    e.stopPropagation();
    projMenu.hidden = true;
    void handleAssignDebateProject(debate.id, null);
  });
  projMenu.appendChild(noneOpt);

  for (const p of state.userProjects || []) {
    const opt = document.createElement("button");
    opt.type = "button";
    opt.className = `topbar-ai-option${currentProject?.id === p.id ? " is-active" : ""}`;
    opt.innerHTML = `
      <span class="topbar-ai-opt-left">
        <span class="project-dot" style="background:${getProjectColorHex(p.color)}"></span>
        <span>${escapeHtml(p.name)}</span>
      </span>
      <span class="topbar-ai-opt-check" aria-hidden="true">✔</span>
    `;
    opt.addEventListener("click", (e) => {
      e.stopPropagation();
      projMenu.hidden = true;
      void handleAssignDebateProject(debate.id, p.id);
    });
    projMenu.appendChild(opt);
  }

  const projDiv = document.createElement("div");
  projDiv.className = "topbar-ai-menu-divider";
  projMenu.appendChild(projDiv);

  const newProjOpt = document.createElement("button");
  newProjOpt.type = "button";
  newProjOpt.className = "topbar-ai-option";
  newProjOpt.innerHTML = `
    <span class="topbar-ai-opt-left">
      <span>+ Criar / Gerenciar Projetos</span>
    </span>
  `;
  newProjOpt.addEventListener("click", (e) => {
    e.stopPropagation();
    projMenu.hidden = true;
    openProjectModal(currentProject?.id || null);
  });
  projMenu.appendChild(newProjOpt);

  projBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const willOpen = projMenu.hidden;
    for (const openMenu of $$(".review-dropdown-menu, .topbar-ai-menu")) {
      openMenu.hidden = true;
    }
    projMenu.hidden = !willOpen;
  });

  projWrap.append(projBtn, projMenu);
  actionsWrap.appendChild(projWrap);

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

  const exportBtn = document.createElement("button");
  exportBtn.type = "button";
  exportBtn.className = "btn-secondary btn-export-md";
  exportBtn.innerHTML = `${SVG_ICONS.download}<span>Exportar .md</span>`;
  exportBtn.title = "Baixar conversa completa em arquivo Markdown (.md)";
  exportBtn.addEventListener("click", () => {
    void handleExportConversationMarkdown(debate.id, exportBtn);
  });
  actionsWrap.appendChild(exportBtn);

  const statusBadge = document.createElement("span");
  statusBadge.className = `debate-status-badge ${debate.status}`;
  statusBadge.textContent = STATUS_LABELS[debate.status] || debate.status;
  actionsWrap.appendChild(statusBadge);

  if (debate.status === "running") {
    const stopBtn = document.createElement("button");
    stopBtn.type = "button";
    stopBtn.className = "btn-secondary btn-stop-generation";
    stopBtn.title = "Interromper geração agora mantendo o texto já escrito";
    stopBtn.innerHTML = `${SVG_ICONS.stop}<span>Parar</span>`;
    stopBtn.addEventListener("click", () => {
      stopBtn.disabled = true;
      void handleStopDebate(debate.id);
    });
    actionsWrap.appendChild(stopBtn);
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
// SIDEBAR ESQUERDA: LISTA DE CONVERSAS / DEBATES (COM RENOMEAR & EXCLUIR INLINE)
// ============================================================================

export async function handleRenameDebate(debateId, newTitle) {
  const cleanTitle = String(newTitle || "").replace(/\s+/g, " ").trim().slice(0, 120);
  state.editingDebateId = null;

  if (!cleanTitle) {
    renderSidebarDebatesList();
    return;
  }

  const existingSummary = state.latestDebates.find((d) => d.id === debateId);
  if (existingSummary && existingSummary.title === cleanTitle) {
    renderSidebarDebatesList();
    return;
  }

  try {
    let res;
    try {
      res = await fetchJson(`/debates/${debateId}`, {
        method: "PATCH",
        body: { title: cleanTitle }
      });
    } catch {
      res = await fetchJson(`/debates/${debateId}/rename`, {
        method: "POST",
        body: { title: cleanTitle }
      });
    }

    if (res?.debate) {
      upsertDebateSessionLocally(res.debate);
    } else {
      if (existingSummary) existingSummary.title = cleanTitle;
      const cached = debateDetailsById.get(debateId);
      if (cached) cached.title = cleanTitle;
    }

    state.lastDebatesSignature = "";
    state.lastZeroShowcaseSignature = "";
    renderSidebarDebatesList();
    updateStageTopbar();
    if (!state.selectedDebateId) {
      renderZeroStateHorizontalShowcase();
    }
    void refreshDashboard();
  } catch (error) {
    renderSidebarDebatesList();
    console.error("[AI Council] Erro ao renomear conversa:", error);
  }
}

export function removeDebateLocally(debateId) {
  state.latestDebates = state.latestDebates.filter((d) => d.id !== debateId);
  debateDetailsById.delete(debateId);
  if (state.confirmDeleteDebateId === debateId) state.confirmDeleteDebateId = null;
  if (state.editingDebateId === debateId) state.editingDebateId = null;

  for (const [taskId, st] of activeStreamsByTaskId.entries()) {
    if (st.debateId === debateId) {
      activeStreamsByTaskId.delete(taskId);
    }
  }

  state.lastDebatesSignature = "";
  state.lastZeroShowcaseSignature = "";

  if (state.selectedDebateId === debateId) {
    startNewDebateView();
  } else {
    renderSidebarDebatesList();
    updateDashboardDebatesSummary(
      state.latestDebates,
      state.latestDebates.filter((d) => d.status === "running").length
    );
    if (!state.selectedDebateId) {
      renderZeroStateHorizontalShowcase();
    }
    updateRightAiPanel();
  }
}

export async function handleDeleteDebate(debateId) {
  try {
    try {
      await fetchJson(`/debates/${debateId}`, { method: "DELETE" });
    } catch {
      await fetchJson(`/debates/${debateId}/delete`, { method: "POST", body: {} });
    }

    removeDebateLocally(debateId);
    void refreshDashboard();
  } catch (error) {
    state.confirmDeleteDebateId = null;
    renderSidebarDebatesList();
    console.error("[AI Council] Erro ao excluir conversa:", error);
  }
}

export function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

export function handleSidebarSearchInput(rawValue) {
  const value = String(rawValue || "");
  state.sidebarSearchQuery = value;

  const clearBtn = $("#sidebar-search-clear");
  if (clearBtn) {
    clearBtn.hidden = value.length === 0;
  }

  if (state.sidebarSearchTimerId) {
    clearTimeout(state.sidebarSearchTimerId);
    state.sidebarSearchTimerId = null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    state.sidebarServerMatchIds = null;
    state.sidebarSearchLoading = false;
    renderSidebarDebatesList();
    return;
  }

  // Filtro instantâneo local por título/tópico enquanto agenda a busca full-text no servidor
  renderSidebarDebatesList();
  state.sidebarSearchTimerId = setTimeout(() => {
    state.sidebarSearchTimerId = null;
    void searchDebatesRemote(trimmed);
  }, 280);
}

export async function handleTogglePinDebate(debateId) {
  const existingSummary = state.latestDebates.find((d) => d.id === debateId);
  const nextPinned = !Boolean(existingSummary?.pinned);

  // Atualização otimista imediata na sidebar
  if (existingSummary) {
    existingSummary.pinned = nextPinned;
    state.latestDebates = sortDebatesPinnedFirst(state.latestDebates);
  }
  const cached = debateDetailsById.get(debateId);
  if (cached) {
    cached.pinned = nextPinned;
  }
  state.lastDebatesSignature = "";
  state.lastZeroShowcaseSignature = "";
  renderSidebarDebatesList();
  if (!state.selectedDebateId) {
    renderZeroStateHorizontalShowcase();
  }

  try {
    let res;
    try {
      res = await fetchJson(`/debates/${debateId}/pin`, {
        method: "POST",
        body: { pinned: nextPinned }
      });
    } catch {
      res = await fetchJson(`/debates/${debateId}`, {
        method: "PATCH",
        body: { pinned: nextPinned }
      });
    }

    if (res?.debate) {
      upsertDebateSessionLocally(res.debate);
      state.lastDebatesSignature = "";
      state.lastZeroShowcaseSignature = "";
      renderSidebarDebatesList();
      if (!state.selectedDebateId) {
        renderZeroStateHorizontalShowcase();
      }
    }
    void refreshDashboard();
  } catch (error) {
    // Reverte se falhar
    if (existingSummary) {
      existingSummary.pinned = !nextPinned;
      state.latestDebates = sortDebatesPinnedFirst(state.latestDebates);
    }
    if (cached) {
      cached.pinned = !nextPinned;
    }
    renderSidebarDebatesList();
    console.error("[AI Council] Erro ao fixar/desafixar conversa:", error);
  }
}

export function renderSidebarDebatesList() {
  const listEl = $("#sidebar-debate-list");
  const countEl = $("#sidebar-debates-count");
  if (!listEl) return;

  const queryRaw = state.sidebarSearchQuery.trim();
  const queryNorm = normalizeSearchText(queryRaw);
  const projectFilterId = state.selectedProjectFilterId;
  const activeFilterProject = projectFilterId
    ? getProjectByIdClient(projectFilterId)
    : null;

  const sortedAll = sortDebatesPinnedFirst(state.latestDebates);
  const projectScoped = projectFilterId
    ? sortedAll.filter((debate) => debate.projectId === projectFilterId)
    : sortedAll;

  const filteredDebates = queryNorm
    ? projectScoped.filter((debate) => {
        if (state.sidebarServerMatchIds && state.sidebarServerMatchIds.has(debate.id)) {
          return true;
        }
        return (
          normalizeSearchText(debate.title).includes(queryNorm) ||
          normalizeSearchText(debate.topic).includes(queryNorm)
        );
      })
    : projectScoped;

  if (countEl) {
    countEl.textContent =
      queryNorm || projectFilterId
        ? `${filteredDebates.length}/${state.latestDebates.length}`
        : String(state.latestDebates.length);
  }

  // Não interrompe digitação se o usuário já estiver renomeando inline na sidebar
  const activeRenameInput = listEl.querySelector(".conv-rename-input");
  if (
    state.editingDebateId &&
    activeRenameInput &&
    document.activeElement === activeRenameInput &&
    activeRenameInput.getAttribute("data-rename-id") === state.editingDebateId
  ) {
    return;
  }

  listEl.replaceChildren();

  if (state.latestDebates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = "Nenhum debate registrado";
    listEl.appendChild(empty);
    return;
  }

  if (filteredDebates.length === 0) {
    const empty = document.createElement("div");
    empty.className = "sidebar-empty";
    empty.textContent = state.sidebarSearchLoading
      ? "Buscando no conteúdo das conversas..."
      : queryNorm
        ? `Nenhuma conversa encontrada para "${queryRaw}".`
        : activeFilterProject
          ? `Nenhuma conversa no projeto "${activeFilterProject.name}" ainda. Clique em "+ Nova Conversa"!`
          : "Nenhuma conversa encontrada.";
    listEl.appendChild(empty);
    return;
  }

  for (const debate of filteredDebates) {
    const item = document.createElement("div");
    item.className = "conversation-item";
    item.setAttribute("role", "listitem");
    item.tabIndex = 0;

    const isSelected = debate.id === state.selectedDebateId && state.currentView === "chat";
    const isEditing = state.editingDebateId === debate.id;
    const isConfirmingDelete = state.confirmDeleteDebateId === debate.id;
    const isPinned = Boolean(debate.pinned);

    if (isSelected) item.classList.add("active");
    if (isEditing) item.classList.add("is-editing");
    if (isConfirmingDelete) item.classList.add("is-confirming-delete");
    if (isPinned) item.classList.add("is-pinned");

    if (isEditing) {
      const editRow = document.createElement("div");
      editRow.className = "conv-inline-edit-row";

      const input = document.createElement("input");
      input.type = "text";
      input.className = "conv-rename-input";
      input.setAttribute("data-rename-id", debate.id);
      input.maxLength = 120;
      input.value = debate.title || "";
      input.setAttribute("aria-label", "Novo título da conversa");

      let settled = false;
      const commit = () => {
        if (settled) return;
        settled = true;
        void handleRenameDebate(debate.id, input.value);
      };
      const cancel = () => {
        if (settled) return;
        settled = true;
        state.editingDebateId = null;
        renderSidebarDebatesList();
      };

      input.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      });
      input.addEventListener("blur", () => {
        commit();
      });
      input.addEventListener("click", (e) => e.stopPropagation());

      editRow.appendChild(input);
      item.appendChild(editRow);
      listEl.appendChild(item);

      requestAnimationFrame(() => {
        input.focus();
        input.select();
      });
      continue;
    }

    const topRow = document.createElement("div");
    topRow.className = "conversation-item-top";

    const titleWrap = document.createElement("div");
    titleWrap.className = "conversation-title-wrap";

    if (isPinned) {
      const pinIndicator = document.createElement("span");
      pinIndicator.className = "conv-pin-indicator";
      pinIndicator.title = "Conversa fixada";
      pinIndicator.innerHTML = SVG_ICONS.pinFilled;
      titleWrap.appendChild(pinIndicator);
    }

    const titleSpan = document.createElement("span");
    titleSpan.className = "conversation-title";
    titleSpan.textContent = debate.title;
    titleWrap.appendChild(titleSpan);

    const rightSlot = document.createElement("div");
    rightSlot.className = "conv-top-right";

    const isRunning = debate.status === "running";
    const isPaused =
      debate.status === "paused_limit" ||
      debate.status === "paused_error" ||
      debate.status === "paused_manual";

    if (isRunning || isPaused) {
      const statePill = document.createElement("span");
      statePill.className = `conv-state-pill${isRunning ? " running" : ""}`;
      statePill.textContent = isRunning ? "Ativo" : "Pausa";
      rightSlot.appendChild(statePill);
    }

    const actions = document.createElement("div");
    actions.className = "conv-actions";

    const pinBtn = document.createElement("button");
    pinBtn.type = "button";
    pinBtn.className = `conv-action-btn${isPinned ? " is-pinned-active" : ""}`;
    pinBtn.title = isPinned ? "Desafixar conversa" : "Fixar conversa no topo";
    pinBtn.setAttribute(
      "aria-label",
      isPinned ? `Desafixar ${debate.title}` : `Fixar ${debate.title}`
    );
    pinBtn.innerHTML = isPinned ? SVG_ICONS.pinFilled : SVG_ICONS.pin;
    pinBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.confirmDeleteDebateId = null;
      state.editingDebateId = null;
      void handleTogglePinDebate(debate.id);
    });

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "conv-action-btn";
    renameBtn.title = "Renomear conversa";
    renameBtn.setAttribute("aria-label", `Renomear ${debate.title}`);
    renameBtn.innerHTML = SVG_ICONS.pencil;
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.confirmDeleteDebateId = null;
      state.editingDebateId = debate.id;
      renderSidebarDebatesList();
    });

    const deleteBtn = document.createElement("button");
    deleteBtn.type = "button";
    deleteBtn.className = "conv-action-btn conv-action-danger";
    deleteBtn.title = "Excluir conversa";
    deleteBtn.setAttribute("aria-label", `Excluir ${debate.title}`);
    deleteBtn.innerHTML = SVG_ICONS.trash;
    deleteBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      state.editingDebateId = null;
      state.confirmDeleteDebateId = debate.id;
      renderSidebarDebatesList();
    });

    actions.append(pinBtn, renameBtn, deleteBtn);
    rightSlot.append(actions);
    topRow.append(titleWrap, rightSlot);

    if (isConfirmingDelete) {
      const confirmRow = document.createElement("div");
      confirmRow.className = "conv-delete-confirm-row";
      confirmRow.addEventListener("click", (e) => e.stopPropagation());

      const label = document.createElement("span");
      label.className = "conv-delete-confirm-label";
      label.textContent = "Excluir conversa?";

      const confirmBtns = document.createElement("div");
      confirmBtns.className = "conv-delete-confirm-btns";

      const yesBtn = document.createElement("button");
      yesBtn.type = "button";
      yesBtn.className = "conv-confirm-btn is-danger";
      yesBtn.textContent = "Sim";
      yesBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        yesBtn.disabled = true;
        yesBtn.textContent = "...";
        void handleDeleteDebate(debate.id);
      });

      const noBtn = document.createElement("button");
      noBtn.type = "button";
      noBtn.className = "conv-confirm-btn";
      noBtn.textContent = "Não";
      noBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.confirmDeleteDebateId = null;
        renderSidebarDebatesList();
      });

      confirmBtns.append(yesBtn, noBtn);
      confirmRow.append(label, confirmBtns);
      item.append(topRow, confirmRow);
    } else {
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

      if (!projectFilterId && debate.projectId) {
        const debateProj = getProjectByIdClient(debate.projectId);
        if (debateProj) {
          const projTag = document.createElement("span");
          projTag.className = "conv-project-tag";
          projTag.innerHTML = `<span class="project-dot" style="background:${getProjectColorHex(debateProj.color)}"></span><span>${escapeHtml(debateProj.name)}</span>`;
          metaRow.append(projTag);
        }
      }

      metaRow.append(statusText, dateText);
      item.append(topRow, metaRow);
    }

    item.addEventListener("click", () => {
      if (isConfirmingDelete || isEditing) return;
      selectDebate(debate.id);
    });
    item.addEventListener("keydown", (e) => {
      if (isConfirmingDelete || isEditing) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        selectDebate(debate.id);
      }
    });

    listEl.appendChild(item);
  }
}

export async function handleStopDebate(debateId) {
  if (!debateId) return;
  const feedback = $("#debate-form-feedback");
  if (feedback) feedback.textContent = "Interrompendo...";

  try {
    let res;
    try {
      res = await fetchJson(`/debates/${debateId}/stop`, {
        method: "POST",
        body: {}
      });
    } catch {
      res = await fetchJson(`/debates/${debateId}/pause`, {
        method: "POST",
        body: {
          reason: "Geração interrompida pelo usuário."
        }
      });
    }

    for (const [taskId, st] of activeStreamsByTaskId.entries()) {
      if (st.debateId === debateId) {
        activeStreamsByTaskId.delete(taskId);
      }
    }

    if (res?.debate) {
      upsertDebateSessionLocally(res.debate);
    }

    if (feedback) feedback.textContent = "";
    state.lastDebatesSignature = "";
    state.lastRenderedChatSignature = "";
    renderSidebarDebatesList();
    updateStageTopbar();
    uiHooks.renderChatStage();
    updateRightAiPanel();
    syncComposerModeUi();
    void refreshDashboard();
  } catch (error) {
    if (feedback) {
      feedback.textContent =
        error instanceof Error ? error.message : "Falha ao interromper geração.";
    }
  }
}

export async function handlePauseDebate(debateId) {
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

    state.lastDebatesSignature = "";
    state.lastRenderedChatSignature = "";
    updateStageTopbar();
    uiHooks.renderChatStage();
    updateRightAiPanel();
    void refreshDashboard();
  } catch (error) {
    alert(error instanceof Error ? error.message : "Falha ao pausar o debate.");
  }
}

export async function handleResumeDebate(debateId) {
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

    state.lastDebatesSignature = "";
    state.lastRenderedChatSignature = "";
    updateStageTopbar();
    uiHooks.renderChatStage();
    updateRightAiPanel();
    void refreshDashboard();
  } catch (error) {
    alert(error instanceof Error ? error.message : "Falha ao retomar o debate.");
  }
}
