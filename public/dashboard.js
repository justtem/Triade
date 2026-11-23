import {
  LIVE_TIMER_INTERVAL,
  AUTO_PLATFORM_IDS,
  RESPONSE_MODE_STORAGE_KEY,
  WEB_SEARCH_STORAGE_KEY,
  AUTO_VERDICT_STORAGE_KEY,
  AUTO_ROUTE_STORAGE_KEY,
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
  clearLegacyStoredSessionToken,
  showAuthLockOverlay,
  hideAuthLockOverlay,
  disconnectEventStream,
  connectEventStream,
  loadPromptTemplates,
  loadProjects,
  refreshDashboard
} from "./js/api.js";
import {
  getEffectiveProjectForComposer,
  renderProjectsSidebar,
  syncComposerProjectPill,
  openProjectModal,
  closeProjectModal,
  handleSaveProjectForm,
  handlePickProjectFolder,
  handleCreateProjectSubfolder,
  handleInspectProjectFolder,
  handleUploadProjectFiles,
  handleDeleteProject
} from "./js/projects.js";
import {
  sortEventsDescending,
  setCardsUnknownOnError,
  updatePlatformCards,
  updateProviderCards,
  handleRefreshOpenRouterFreeModels,
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
import { closeDiagramLightbox } from "./js/rich-render.js";
import {
  initShortcutsUi,
  closeCommandPalette,
  closeSlashMenu,
  handleComposerSlashKeydown
} from "./js/shortcuts.js";
import {
  closeAppBriefingCard
} from "./js/briefing.js";
import {
  syncAiSelectionUi,
  applyComposerMode,
  setAutoRouteMode,
  setSelectedParticipants,
  syncComposerWithDebate,
  syncComposerModeUi,
  syncComposerSubmitIntentUi,
  handleCreateDebate,
  addComposerFiles,
  closeMemoryModal,
  saveMemoryModal,
  openTemplatesModal,
  closeTemplatesModal,
  showTemplatesListView,
  openTemplateEditorView,
  syncTemplatePresetFields,
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
import {
  openSetupWizard,
  closeSetupWizard,
  handleSaveSetupForm,
  syncSetupUi
} from "./js/setup.js";
import {
  loadUserMemory,
  renderUserMemoryPanel,
  toggleUserMemoryEnabled,
  handleClearUserMemory,
  handleExportPrivacyData,
  handleWipeLocalData,
  closePrivacyShieldModal,
  closeImageRedactModal,
  loadPrivacyStatus,
  setPrivacyShieldMode,
  setVaultMode,
  handleSetupMasterPassword,
  setVaultAutoLock,
  handleLockVaultNow,
  handleUnlockVaultSubmit,
  setSealApiKeysInVault,
  handleReapplyNtfs
} from "./js/user-memory.js";

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
  getEffectiveProjectForComposer,
  syncComposerProjectPill,
  syncSetupUi,
  renderUserMemoryPanel,
  sortEventsDescending
});

function initializeCollapsibleLayout() {
  const appShell = $("#app-shell");

  try {
    if (localStorage.getItem("ai-council-left-collapsed") === "true") {
      appShell?.classList.add("is-left-collapsed");
    }
    // Dock direito recolhido por padrão no desktop para priorizar o palco do chat
    const rightPref = localStorage.getItem("ai-council-right-collapsed");
    if (rightPref !== "false") {
      appShell?.classList.add("is-right-collapsed");
    }
  } catch {
    appShell?.classList.add("is-right-collapsed");
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

  const composerPopover = $("#composer-config-popover");
  const composerConfigBtn = $("#composer-config-btn");
  const arrowAdvBtn = document.querySelector('#composer-arrow-shortcuts [data-arrow-action="advanced"]');
  const closeComposerPopover = () => {
    if (composerPopover && !composerPopover.hidden) {
      composerPopover.hidden = true;
      composerConfigBtn?.setAttribute("aria-expanded", "false");
      arrowAdvBtn?.setAttribute("aria-expanded", "false");
      arrowAdvBtn?.classList.remove("is-active");
    }
  };
  const toggleComposerPopover = (e) => {
    e?.stopPropagation?.();
    if (!composerPopover) return;
    const willOpen = composerPopover.hidden;
    composerPopover.hidden = !willOpen;
    composerConfigBtn?.setAttribute("aria-expanded", String(willOpen));
    arrowAdvBtn?.setAttribute("aria-expanded", String(willOpen));
    arrowAdvBtn?.classList.toggle("is-active", willOpen);
  };

  composerConfigBtn?.addEventListener("click", toggleComposerPopover);

  // Botão × interno da pílula para limpar o campo de texto rapidamente
  $("#composer-clear-btn")?.addEventListener("click", () => {
    const topicEl = $("#debate-topic");
    if (!topicEl) return;
    topicEl.value = "";
    topicEl.style.height = "auto";
    syncComposerSubmitIntentUi();
    topicEl.focus();
  });

  // Badge [Auto] no topo do Hero editorial volta imediatamente para Modo Automático
  $("#zero-hero-mode-badge")?.addEventListener("click", () => {
    applyComposerMode("auto");
    $("#debate-topic")?.focus();
  });

  // Atalhos em setas (↳) abaixo da pílula conectando 100% das funcionalidades existentes
  for (const arrowBtn of $$("#composer-arrow-shortcuts .arrow-shortcut-btn")) {
    arrowBtn.addEventListener("click", (e) => {
      const action = arrowBtn.getAttribute("data-arrow-action");
      const topicEl = $("#debate-topic");
      if (action === "new-app") {
        applyComposerMode("auto");
        if (topicEl) {
          if (!topicEl.value.trim()) {
            topicEl.value = "Cria um app de ";
          }
          topicEl.style.height = "auto";
          topicEl.style.height = `${Math.min(160, topicEl.scrollHeight)}px`;
          syncComposerSubmitIntentUi();
          topicEl.focus();
          topicEl.setSelectionRange(topicEl.value.length, topicEl.value.length);
        }
      } else if (action === "attach") {
        $("#composer-attach-btn")?.click();
      } else if (action === "web") {
        $("#composer-web-btn")?.click();
      } else if (action === "templates") {
        openTemplatesModal();
      } else if (action === "mode-quick") {
        applyComposerMode(state.activeComposerMode === "quick" ? "auto" : "quick");
        topicEl?.focus();
      } else if (action === "mode-council") {
        applyComposerMode(state.activeComposerMode === "council" ? "auto" : "council");
        topicEl?.focus();
      } else if (action === "mode-debate") {
        applyComposerMode(state.activeComposerMode === "debate" ? "auto" : "debate");
        topicEl?.focus();
      } else if (action === "advanced") {
        toggleComposerPopover(e);
      }
    });
  }

  composerPopover?.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  $("#composer-config-done")?.addEventListener("click", closeComposerPopover);
  $("#debate-rounds")?.addEventListener("change", syncComposerModeUi);
  $("#debate-focus")?.addEventListener("change", syncComposerModeUi);

  // Modal de Biblioteca de Templates (visão lista -> editor sob demanda)
  $("#composer-templates-btn")?.addEventListener("click", () => {
    closeComposerPopover();
    openTemplatesModal();
  });
  $("#composer-templates-quick-btn")?.addEventListener("click", openTemplatesModal);
  $("#zero-manage-templates-btn")?.addEventListener("click", openTemplatesModal);
  $("#templates-modal-close")?.addEventListener("click", closeTemplatesModal);
  $("#templates-modal")?.addEventListener("click", (e) => {
    if (e.target === $("#templates-modal")) closeTemplatesModal();
  });
  $("#templates-new-btn")?.addEventListener("click", () => {
    openTemplateEditorView(null);
  });
  $("#tpl-back-btn")?.addEventListener("click", showTemplatesListView);
  $("#tpl-cancel-btn")?.addEventListener("click", showTemplatesListView);
  $("#tpl-reset-btn")?.addEventListener("click", showTemplatesListView);
  $("#templates-search-input")?.addEventListener("input", (e) => {
    state.templatesSearchQuery = e.target.value || "";
    renderTemplatesModalList();
  });
  $("#tpl-preset-mode")?.addEventListener("change", (e) => {
    syncTemplatePresetFields(e.target.value);
  });
  $("#template-editor-form")?.addEventListener("submit", handleSaveTemplateForm);

  // Lightbox de imagens anexadas e diagramas Mermaid
  $("#image-lightbox-close")?.addEventListener("click", closeImageLightbox);
  $("#image-lightbox-modal")?.addEventListener("click", (e) => {
    if (e.target === $("#image-lightbox-modal")) closeImageLightbox();
  });
  $("#diagram-lightbox-close")?.addEventListener("click", closeDiagramLightbox);
  $("#diagram-lightbox-modal")?.addEventListener("click", (e) => {
    if (e.target === $("#diagram-lightbox-modal")) closeDiagramLightbox();
  });

  // Modal de Projetos / Pastas com Cérebro Local (seletor nativo + subpasta)
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
  $("#proj-pick-folder-btn")?.addEventListener("click", () => {
    void handlePickProjectFolder();
  });
  $("#proj-test-folder-btn")?.addEventListener("click", () => {
    void handleInspectProjectFolder();
  });
  $("#proj-subfolder-toggle")?.addEventListener("click", () => {
    const subBox = $("#proj-subfolder-box");
    const subToggle = $("#proj-subfolder-toggle");
    if (subBox) subBox.hidden = false;
    if (subToggle) subToggle.hidden = true;
    $("#proj-subfolder-name")?.focus();
  });
  $("#proj-subfolder-cancel-btn")?.addEventListener("click", () => {
    const subBox = $("#proj-subfolder-box");
    const subToggle = $("#proj-subfolder-toggle");
    const subInput = $("#proj-subfolder-name");
    if (subBox) subBox.hidden = true;
    if (subToggle) subToggle.hidden = false;
    if (subInput) subInput.value = "";
  });
  $("#proj-subfolder-create-btn")?.addEventListener("click", () => {
    void handleCreateProjectSubfolder();
  });
  $("#proj-subfolder-name")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleCreateProjectSubfolder();
    }
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

  // Assistente de Configuração Inicial / Chaves & Acesso (somente PC local)
  $("#open-setup-wizard-btn")?.addEventListener("click", () => {
    void openSetupWizard({ locked: false });
  });
  $("#setup-wizard-close")?.addEventListener("click", closeSetupWizard);
  $("#setup-cancel-btn")?.addEventListener("click", closeSetupWizard);
  $("#setup-wizard-overlay")?.addEventListener("click", (e) => {
    if (e.target === $("#setup-wizard-overlay")) closeSetupWizard();
  });
  $("#setup-wizard-form")?.addEventListener("submit", handleSaveSetupForm);

  // Memória Pessoal Automática (visualização / pausa / exclusão no Monitor)
  for (const btn of $$("#user-memory-toggle .mode-seg-btn")) {
    btn.addEventListener("click", () => {
      const enabled = btn.getAttribute("data-user-memory-enabled") === "true";
      void toggleUserMemoryEnabled(enabled);
    });
  }
  $("#user-memory-clear-btn")?.addEventListener("click", () => {
    void handleClearUserMemory();
  });

  // Privacidade & Dados Locais (LGPD: Escudo DLP, Cofre DPAPI/Senha Mestra, NTFS, Exportação e Eliminação)
  for (const btn of $$("#privacy-shield-mode-toggle .mode-seg-btn")) {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-shield-mode");
      if (mode === "strict" || mode === "standard" || mode === "off") {
        void setPrivacyShieldMode(mode);
      }
    });
  }
  for (const btn of $$("#privacy-vault-mode-toggle .mode-seg-btn")) {
    btn.addEventListener("click", () => {
      const mode = btn.getAttribute("data-vault-mode");
      if (mode === "off" || mode === "dpapi" || mode === "master_password") {
        void setVaultMode(mode);
      }
    });
  }
  $("#privacy-master-change-btn")?.addEventListener("click", () => {
    const box = $("#privacy-master-setup-box");
    if (box) {
      box.hidden = false;
      $("#privacy-master-pass-1")?.focus();
    }
  });
  $("#privacy-master-cancel-btn")?.addEventListener("click", () => {
    const box = $("#privacy-master-setup-box");
    if (box) box.hidden = true;
    const p1 = $("#privacy-master-pass-1");
    const p2 = $("#privacy-master-pass-2");
    if (p1) p1.value = "";
    if (p2) p2.value = "";
  });
  $("#privacy-master-save-btn")?.addEventListener("click", () => {
    void handleSetupMasterPassword();
  });
  $("#privacy-autolock-select")?.addEventListener("change", (e) => {
    void setVaultAutoLock(e.target.value);
  });
  $("#privacy-vault-lock-btn")?.addEventListener("click", () => {
    void handleLockVaultNow();
  });
  $("#btn-lock-vault")?.addEventListener("click", () => {
    void handleLockVaultNow();
  });
  $("#privacy-recovery-copy-btn")?.addEventListener("click", async () => {
    const code = $("#privacy-recovery-code")?.textContent?.trim() || "";
    const fb = $("#privacy-feedback");
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      if (fb) fb.textContent = "Chave de Recuperação copiada! Guarde fora deste PC.";
    } catch {
      if (fb) fb.textContent = "Selecione e copie a Chave de Recuperação manualmente.";
    }
  });
  $("#privacy-recovery-dismiss-btn")?.addEventListener("click", () => {
    const recBox = $("#privacy-recovery-box");
    const recCode = $("#privacy-recovery-code");
    if (recBox) recBox.hidden = true;
    if (recCode) recCode.textContent = "";
  });
  $("#vault-unlock-form")?.addEventListener("submit", handleUnlockVaultSubmit);
  $("#vault-recovery-toggle")?.addEventListener("click", () => {
    const input = $("#vault-unlock-input");
    const label = $("#vault-unlock-label");
    const btn = $("#vault-recovery-toggle");
    if (!input) return;
    const nextRec = input.getAttribute("data-recovery-mode") !== "true";
    input.setAttribute("data-recovery-mode", String(nextRec));
    input.type = nextRec ? "text" : "password";
    input.placeholder = nextRec
      ? "Cole a Chave de Recuperação (XXXX-XXXX-...)"
      : "Digite sua Senha Mestra...";
    if (label) label.textContent = nextRec ? "Chave de Recuperação" : "Senha Mestra";
    if (btn) btn.textContent = nextRec ? "Voltar para Senha Mestra" : "Usar Chave de Recuperação";
    input.value = "";
    input.focus();
  });
  $("#vault-remote-retry-btn")?.addEventListener("click", () => {
    void loadPrivacyStatus();
    void refreshDashboard();
  });
  for (const btn of $$("#privacy-seal-keys-toggle .mode-seg-btn")) {
    btn.addEventListener("click", () => {
      const wantSeal = btn.getAttribute("data-seal-keys") === "true";
      void setSealApiKeysInVault(wantSeal);
    });
  }
  $("#privacy-ntfs-harden-btn")?.addEventListener("click", () => {
    void handleReapplyNtfs();
  });
  $("#privacy-export-btn")?.addEventListener("click", () => {
    void handleExportPrivacyData();
  });
  $("#privacy-wipe-toggle-btn")?.addEventListener("click", () => {
    const box = $("#privacy-wipe-confirm-box");
    const input = $("#privacy-wipe-input");
    const feedback = $("#privacy-feedback");
    if (!box) return;
    box.hidden = !box.hidden;
    if (feedback) feedback.textContent = "";
    if (!box.hidden) {
      if (input) input.value = "";
      input?.focus();
    }
  });
  $("#privacy-wipe-cancel-btn")?.addEventListener("click", () => {
    const box = $("#privacy-wipe-confirm-box");
    const input = $("#privacy-wipe-input");
    const feedback = $("#privacy-feedback");
    if (box) box.hidden = true;
    if (input) input.value = "";
    if (feedback) feedback.textContent = "";
  });
  $("#privacy-wipe-confirm-btn")?.addEventListener("click", () => {
    void handleWipeLocalData();
  });
  $("#privacy-wipe-input")?.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void handleWipeLocalData();
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

  // Atualização manual de modelos :free no card do OpenRouter (Monitor)
  $("#openrouter-refresh-free-btn")?.addEventListener("click", () => {
    void handleRefreshOpenRouterFreeModels();
  });

  // Atalhos globais (Ctrl+K Paleta de Comandos, Alt+N Nova Conversa, / Templates)
  initShortcutsUi();

  document.addEventListener("click", () => {
    closeComposerPopover();
    closeSlashMenu(false);
    for (const openMenu of $$(".review-dropdown-menu, .topbar-ai-menu, .folder-info-popover")) {
      openMenu.hidden = true;
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      stopSpeech();
      closeCommandPalette();
      closeSlashMenu(true);
      closeComposerPopover();
      closeImageLightbox();
      closeDiagramLightbox();
      closeTemplatesModal();
      closeProjectModal();
      closeMemoryModal();
      closeSetupWizard();
      closePrivacyShieldModal();
      closeImageRedactModal();
      closeAppBriefingCard();
      if (state.editingTurnKey) {
        state.editingTurnKey = null;
        state.lastRenderedChatSignature = "";
        renderChatStage();
      }
      if (state.confirmDeleteDebateId) {
        state.confirmDeleteDebateId = null;
        renderSidebarDebatesList();
      }
      for (const openMenu of $$(".review-dropdown-menu, .topbar-ai-menu, .folder-info-popover")) {
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
      if (handleComposerSlashKeydown(e)) {
        return;
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        createForm?.requestSubmit();
      }
    });

    topicTextarea.addEventListener("input", () => {
      topicTextarea.style.height = "auto";
      topicTextarea.style.height = `${Math.min(180, topicTextarea.scrollHeight)}px`;
      syncComposerSubmitIntentUi();
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

  // Barra fixa de 4 modos em 1 clique (Chat Rápido · Conselho · Debate · Construtor)
  for (const btn of $$("#composer-mode-pills .composer-mode-btn")) {
    btn.addEventListener("click", () => {
      const modeKey = btn.getAttribute("data-composer-mode");
      if (modeKey) {
        applyComposerMode(modeKey);
        $("#debate-topic")?.focus();
      }
    });
  }

  // Chips inline de 1 IA no Chat Rápido (Gemini · Groq · OpenRouter)
  for (const chip of $$("#composer-quick-ai-picker .quick-ai-chip")) {
    chip.addEventListener("click", () => {
      const aiKey = chip.getAttribute("data-quick-ai");
      if (aiKey) {
        applyComposerMode("quick", { singleAi: aiKey });
        $("#debate-topic")?.focus();
      }
    });
  }

  for (const checkbox of $$('input[name="participants"]')) {
    checkbox.addEventListener("change", () => {
      if (state.isAutoRouteMode) {
        state.isAutoRouteMode = false;
        saveStoredOption(AUTO_ROUTE_STORAGE_KEY, "off");
      }
      if (state.isSingleAiMode) {
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
      if (preset === "auto") {
        setAutoRouteMode(!state.isAutoRouteMode);
      }
    });
  }

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

  for (const btn of $$("#auto-verdict-toggle .mode-seg-btn")) {
    btn.addEventListener("click", () => {
      const val = btn.getAttribute("data-auto-verdict");
      if (val === "off" || val === "on") {
        state.selectedAutoVerdict = val;
        saveStoredOption(AUTO_VERDICT_STORAGE_KEY, val);
        syncComposerModeUi();
      }
    });
  }

  $("#composer-web-btn")?.addEventListener("click", () => {
    state.selectedWebSearchMode =
      state.selectedWebSearchMode === "off" ? "auto" : "off";
    saveStoredOption(WEB_SEARCH_STORAGE_KEY, state.selectedWebSearchMode);
    syncComposerModeUi();
  });

  // Inicializa o compositor no modo salvo (padrão: Auto)
  applyComposerMode(state.activeComposerMode || "auto");

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
      if (target === "dashboard") {
        void loadUserMemory();
        void loadPrivacyStatus();
      }
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

  // Limpa eventual token legado do localStorage (autenticação agora via cookie HttpOnly)
  clearLegacyStoredSessionToken();

  if (lockBtn) {
    const isLocalHost =
      window.location.hostname === "127.0.0.1" ||
      window.location.hostname === "localhost";
    lockBtn.hidden = isLocalHost;
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

      await fetchJson("/auth/login", {
        method: "POST",
        body: { password }
      });

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
    clearLegacyStoredSessionToken();
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
  void loadPrivacyStatus();
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
