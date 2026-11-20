import {
  LIVE_TIMER_INTERVAL,
  AUTO_PLATFORM_IDS,
  RESPONSE_MODE_STORAGE_KEY,
  INTERACTION_MODE_STORAGE_KEY,
  WEB_SEARCH_STORAGE_KEY,
  $,
  $$,
  saveStoredOption,
  state,
  initScrollTriggerObserver,
  scheduleParallaxRender,
  setScrollFocusedAiInRightDock,
  registerUiHooks
} from "./js/state.js";
import {
  fetchJson,
  getStoredSessionToken,
  setStoredSessionToken,
  showAuthLockOverlay,
  hideAuthLockOverlay,
  disconnectEventStream,
  connectEventStream,
  loadPromptTemplates,
  loadProjects,
  refreshDashboard
} from "./js/api.js";
import {
  renderProjectsSidebar,
  syncComposerProjectPill,
  openProjectModal,
  closeProjectModal,
  handleSaveProjectForm,
  handleInspectProjectFolder,
  handleUploadProjectFiles,
  handleDeleteProject
} from "./js/projects.js";
import {
  sortEventsDescending,
  setCardsUnknownOnError,
  updatePlatformCards,
  updateProviderCards,
  updateHistory,
  updateDashboardDebatesSummary,
  updateRightAiPanel,
  tickLiveTimers,
  updateClock
} from "./js/telemetry.js";
import {
  scrollChatToBottom,
  updateChatScrollLinkedEffects,
  closeImageLightbox
} from "./js/motion.js";
import {
  getSelectedParticipants,
  syncAiSelectionUi,
  setSelectedParticipants,
  syncComposerWithDebate,
  syncComposerModeUi,
  handleCreateDebate,
  addComposerFiles,
  closeMemoryModal,
  saveMemoryModal,
  openTemplatesModal,
  closeTemplatesModal,
  resetTemplateEditorForm,
  renderTemplatesModalList,
  handleSaveTemplateForm
} from "./js/composer.js";
import {
  renderZeroStateHorizontalShowcase,
  switchView,
  selectDebate,
  startNewDebateView,
  closeMobileDrawers,
  updateStageTopbar,
  removeDebateLocally,
  handleSidebarSearchInput,
  renderSidebarDebatesList,
  handleStopDebate
} from "./js/sidebar.js";
import {
  scheduleStreamBodyPaint,
  renderChatStage
} from "./js/chat.js";
import { initVoicePlayerUi, initVoiceRecorder, stopSpeech } from "./js/voice.js";

// Registra hooks de UI para manter o grafo de módulos 100% acíclico
registerUiHooks({
  renderSidebarDebatesList,
  updateStageTopbar,
  renderChatStage,
  updateRightAiPanel,
  syncComposerModeUi,
  syncComposerWithDebate,
  removeDebateLocally,
  scheduleStreamBodyPaint,
  updatePlatformCards,
  updateProviderCards,
  updateHistory,
  updateDashboardDebatesSummary,
  setCardsUnknownOnError,
  selectDebate,
  switchView,
  handleStopDebate,
  renderZeroStateHorizontalShowcase,
  renderTemplatesModalList,
  renderProjectsSidebar,
  openProjectModal,
  syncComposerProjectPill,
  sortEventsDescending
});

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
    state.parallaxMouseX = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
    state.parallaxMouseY = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
    scheduleParallaxRender();
  });

  // 2. Scroll-Linked e Parallax no Chat e nas Abas
  chatScroll?.addEventListener("scroll", updateChatScrollLinkedEffects, { passive: true });

  dashScroll?.addEventListener(
    "scroll",
    () => {
      state.parallaxScrollY = dashScroll.scrollTop;
      scheduleParallaxRender();
    },
    { passive: true }
  );

  histScroll?.addEventListener(
    "scroll",
    () => {
      state.parallaxScrollY = histScroll.scrollTop;
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

  // Busca instantânea na Sidebar (título + conteúdo)
  const sidebarSearchInput = $("#sidebar-search-input");
  const sidebarSearchClear = $("#sidebar-search-clear");
  sidebarSearchInput?.addEventListener("input", () => {
    handleSidebarSearchInput(sidebarSearchInput.value);
  });
  sidebarSearchInput?.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && sidebarSearchInput.value) {
      e.preventDefault();
      sidebarSearchInput.value = "";
      handleSidebarSearchInput("");
    }
  });
  sidebarSearchClear?.addEventListener("click", () => {
    if (sidebarSearchInput) {
      sidebarSearchInput.value = "";
      sidebarSearchInput.focus();
    }
    handleSidebarSearchInput("");
  });

  // Modal de Biblioteca de Templates
  $("#composer-templates-btn")?.addEventListener("click", openTemplatesModal);
  $("#zero-manage-templates-btn")?.addEventListener("click", openTemplatesModal);
  $("#templates-modal-close")?.addEventListener("click", closeTemplatesModal);
  $("#templates-modal")?.addEventListener("click", (e) => {
    if (e.target === $("#templates-modal")) closeTemplatesModal();
  });
  $("#templates-new-btn")?.addEventListener("click", () => {
    resetTemplateEditorForm();
    $("#tpl-title")?.focus();
  });
  $("#tpl-reset-btn")?.addEventListener("click", resetTemplateEditorForm);
  $("#template-editor-form")?.addEventListener("submit", handleSaveTemplateForm);

  // Lightbox de imagens anexadas
  $("#image-lightbox-close")?.addEventListener("click", closeImageLightbox);
  $("#image-lightbox-modal")?.addEventListener("click", (e) => {
    if (e.target === $("#image-lightbox-modal")) closeImageLightbox();
  });

  // Modal de Projetos / Pastas com Cérebro Local
  $("#sidebar-new-project-btn")?.addEventListener("click", (e) => {
    e.stopPropagation();
    openProjectModal(null);
  });
  $("#project-modal-close")?.addEventListener("click", closeProjectModal);
  $("#proj-cancel-btn")?.addEventListener("click", closeProjectModal);
  $("#project-modal")?.addEventListener("click", (e) => {
    if (e.target === $("#project-modal")) closeProjectModal();
  });
  $("#project-editor-form")?.addEventListener("submit", handleSaveProjectForm);
  $("#proj-test-folder-btn")?.addEventListener("click", () => {
    void handleInspectProjectFolder();
  });
  $("#proj-delete-btn")?.addEventListener("click", () => {
    void handleDeleteProject();
  });
  const projFileInput = $("#proj-file-input");
  $("#proj-upload-btn")?.addEventListener("click", () => {
    projFileInput?.click();
  });
  projFileInput?.addEventListener("change", () => {
    if (projFileInput.files?.length) {
      void handleUploadProjectFiles(projFileInput.files);
      projFileInput.value = "";
    }
  });
  for (const swatch of $$(".project-color-swatch")) {
    swatch.addEventListener("click", () => {
      const c = swatch.getAttribute("data-proj-color") || "iris";
      const hiddenColor = $("#proj-color");
      if (hiddenColor) hiddenColor.value = c;
      for (const s of $$(".project-color-swatch")) {
        s.classList.toggle("is-selected", s === swatch);
      }
    });
  }

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
    for (const openMenu of $$(".review-dropdown-menu, .topbar-ai-menu")) {
      openMenu.hidden = true;
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      stopSpeech();
      closeImageLightbox();
      closeTemplatesModal();
      closeProjectModal();
      closeMemoryModal();
      if (state.confirmDeleteDebateId) {
        state.confirmDeleteDebateId = null;
        renderSidebarDebatesList();
      }
      for (const openMenu of $$(".review-dropdown-menu, .topbar-ai-menu")) {
        openMenu.hidden = true;
      }
    }
  });

  // Botão flutuante de Auto-Scroll Inteligente ("↓ Nova resposta")
  $("#scroll-to-latest-btn")?.addEventListener("click", () => {
    scrollChatToBottom(true);
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

    // Colar prints/imagens direto com Ctrl + V no campo do composer
    topicTextarea.addEventListener("paste", (e) => {
      const items = Array.from(e.clipboardData?.items || []);
      const mediaFiles = [];
      for (const item of items) {
        if (item.kind === "file" && (item.type.startsWith("image/") || item.type === "application/pdf")) {
          const f = item.getAsFile();
          if (f) mediaFiles.push(f);
        }
      }
      if (mediaFiles.length > 0) {
        e.preventDefault();
        void addComposerFiles(mediaFiles);
      }
    });
  }

  // Mini player flutuante de vozes neurais por IA + seletor de elenco
  initVoicePlayerUi();

  // Gravação por voz (Segurar para gravar -> Groq Whisper -> envio automático)
  initVoiceRecorder({
    micBtn: $("#composer-voice-btn"),
    bannerEl: $("#voice-recording-banner"),
    timerEl: $("#voice-record-timer"),
    hintEl: $("#voice-record-hint"),
    feedbackEl: $("#debate-form-feedback"),
    onTranscribed: (transcribedText) => {
      if (!topicTextarea) return;
      const existing = topicTextarea.value.trim();
      topicTextarea.value = existing
        ? `${existing} ${transcribedText}`
        : transcribedText;
      topicTextarea.style.height = "auto";
      topicTextarea.style.height = `${Math.min(180, topicTextarea.scrollHeight)}px`;
      createForm?.requestSubmit();
    }
  });

  for (const checkbox of $$('input[name="participants"]')) {
    checkbox.addEventListener("change", () => {
      if (state.isSingleAiMode) {
        // No modo "1 IA", clicar em qualquer IA troca diretamente para ela (estilo rádio, 1 clique)
        setSelectedParticipants([checkbox.value], { singleMode: true });
        return;
      }
      syncAiSelectionUi();
      syncComposerModeUi();
    });
  }

  for (const btn of $$("#ai-preset-toggle .mode-seg-btn")) {
    btn.addEventListener("click", () => {
      const preset = btn.getAttribute("data-ai-preset");
      if (preset === "single") {
        const current = getSelectedParticipants();
        const chosen =
          current.length === 1
            ? current[0]
            : current.includes(state.preferredSingleAi)
              ? state.preferredSingleAi
              : current[0] || state.preferredSingleAi || "gemini";
        setSelectedParticipants([chosen], { singleMode: true });
      } else if (preset === "trio") {
        setSelectedParticipants(AUTO_PLATFORM_IDS, { singleMode: false });
      }
    });
  }
  syncAiSelectionUi();

  for (const btn of $$("#response-mode-toggle .mode-seg-btn")) {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-response-mode");
      if (mode === "normal" || mode === "prompt_markdown") {
        state.selectedResponseMode = mode;
        saveStoredOption(RESPONSE_MODE_STORAGE_KEY, mode);
        syncComposerModeUi();
      }
    });
  }

  for (const btn of $$("#interaction-mode-toggle .mode-seg-btn")) {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-interaction-mode");
      if (mode === "direct" || mode === "debate") {
        state.selectedInteractionMode = mode;
        saveStoredOption(INTERACTION_MODE_STORAGE_KEY, mode);
        // Debate exige 2+ IAs: sai automaticamente do modo 1 IA e ativa o Trio
        if (mode === "debate" && (state.isSingleAiMode || getSelectedParticipants().length < 2)) {
          setSelectedParticipants(AUTO_PLATFORM_IDS, { singleMode: false });
        } else {
          syncComposerModeUi();
        }
      }
    });
  }

  $("#composer-web-btn")?.addEventListener("click", () => {
    state.selectedWebSearchMode =
      state.selectedWebSearchMode === "off" ? "auto" : "off";
    saveStoredOption(WEB_SEARCH_STORAGE_KEY, state.selectedWebSearchMode);
    syncComposerModeUi();
  });

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
      void loadPromptTemplates();
      void loadProjects();
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
  void loadPromptTemplates();
  void loadProjects();
  void refreshDashboard();

  setInterval(updateClock, 1000);
  setInterval(tickLiveTimers, LIVE_TIMER_INTERVAL);

  if (typeof navigator !== "undefined" && "serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Ignora em contextos sem HTTPS/localhost
    });
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeDashboard);
} else {
  initializeDashboard();
}
