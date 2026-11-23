import {
  AUTO_PLATFORM_IDS,
  INTERACTION_MODE_LABELS,
  RESPONSE_MODE_LABELS,
  RESPONSE_MODE_STORAGE_KEY,
  WEB_SEARCH_STORAGE_KEY,
  ZERO_STATE_BLUEPRINTS,
  $,
  saveStoredOption,
  state
} from "./state.js";
import {
  applyComposerMode,
  applyPromptTemplate,
  openTemplatesModal,
  setAutoRouteMode,
  setSelectedParticipants,
  syncComposerModeUi
} from "./composer.js";
import {
  closeMobileDrawers,
  selectDebate,
  startNewDebateView,
  switchView
} from "./sidebar.js";
import {
  openProjectModal,
  renderProjectsSidebar,
  syncComposerProjectPill
} from "./projects.js";
import { handleRefreshOpenRouterFreeModels } from "./telemetry.js";
import { openSetupWizard } from "./setup.js";
import {
  handleLockVaultNow,
  loadPrivacyStatus,
  loadUserMemory
} from "./user-memory.js";

// ============================================================================
// UTILITÁRIOS DE BUSCA & TRAVAS DE SEGURANÇA
// ============================================================================

function normalizeSearchText(raw) {
  return String(raw || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function isSecurityLockVisible() {
  const authOverlay = $("#auth-lock-overlay");
  const vaultOverlay = $("#vault-lock-overlay");
  const setupOverlay = $("#setup-wizard-overlay");
  if (authOverlay && !authOverlay.hidden) return true;
  if (vaultOverlay && !vaultOverlay.hidden) return true;
  if (setupOverlay && !setupOverlay.hidden && setupOverlay.dataset.locked === "true") {
    return true;
  }
  return false;
}

function getAvailableTemplates() {
  if (Array.isArray(state.promptTemplates) && state.promptTemplates.length > 0) {
    return state.promptTemplates;
  }
  return ZERO_STATE_BLUEPRINTS.map((bp, idx) => ({
    id: `builtin_${idx}`,
    tag: bp.tag,
    title: bp.title,
    prompt: bp.topic,
    focus: bp.focus,
    responseMode: "prompt_markdown",
    interactionMode: "debate"
  }));
}

// ============================================================================
// PALETA DE COMANDOS (CTRL+K / CMD+K)
// ============================================================================

let paletteItems = [];
let paletteActiveIndex = 0;

function buildPaletteItems(rawQuery) {
  const query = normalizeSearchText(rawQuery);
  const terms = query ? query.split(/\s+/).filter(Boolean) : [];
  const matches = (...fields) => {
    if (terms.length === 0) return true;
    const hay = normalizeSearchText(fields.filter(Boolean).join(" "));
    return terms.every((term) => hay.includes(term));
  };

  const groups = [];

  // 1. Ações rápidas
  const actions = [
    {
      id: "act:new-chat",
      section: "AÇÕES RÁPIDAS",
      title: "Nova conversa",
      subtitle: "Abrir chat limpo no palco central",
      shortcut: "Alt+N",
      keywords: "novo chat conversa debate limpar inicio",
      run: () => {
        closeMobileDrawers();
        startNewDebateView();
        $("#debate-topic")?.focus();
      }
    },
    {
      id: "act:mode-quick",
      section: "AÇÕES RÁPIDAS",
      title: "Modo: Chat Rápido (1 IA)",
      subtitle: "Resposta direta com 1 IA (padrão Gemini, troca em 1 clique)",
      badge: state.activeComposerMode === "quick" ? "Ativo" : "",
      keywords: "modo chat rapido 1 ia direto gemini groq",
      run: () => {
        applyComposerMode("quick");
        switchView("chat");
        $("#debate-topic")?.focus();
      }
    },
    {
      id: "act:mode-council",
      section: "AÇÕES RÁPIDAS",
      title: "Modo: Conselho (Trio em paralelo)",
      subtitle: "Gemini + Groq + OpenRouter respondem juntos (veredito sob demanda)",
      badge: state.activeComposerMode === "council" ? "Ativo" : "",
      keywords: "modo conselho trio paralelo opinioes",
      run: () => {
        applyComposerMode("council");
        switchView("chat");
        $("#debate-topic")?.focus();
      }
    },
    {
      id: "act:mode-debate",
      section: "AÇÕES RÁPIDAS",
      title: "Modo: Debate (Crítica cruzada + Síntese)",
      subtitle: "As IAs debatem entre si e fecham uma conclusão unificada",
      badge: state.activeComposerMode === "debate" ? "Ativo" : "",
      keywords: "modo debate rodadas critica sintese",
      run: () => {
        applyComposerMode("debate");
        switchView("chat");
        $("#debate-topic")?.focus();
      }
    },
    {
      id: "act:ai-auto",
      section: "AÇÕES RÁPIDAS",
      title: "Usar Roteador Inteligente (Auto)",
      subtitle: "Escolhe Groq, Gemini ou Trio automaticamente",
      badge: state.isAutoRouteMode ? "Ativo" : "",
      keywords: "ia auto roteador inteligente automatico",
      run: () => {
        setAutoRouteMode(true);
        switchView("chat");
        $("#debate-topic")?.focus();
      }
    },
    {
      id: "act:ai-gemini",
      section: "AÇÕES RÁPIDAS",
      title: "Falar só com Gemini",
      subtitle: "Chat Rápido com Google Gemini",
      keywords: "ia gemini google",
      run: () => {
        setSelectedParticipants(["gemini"], { singleMode: true });
        switchView("chat");
        $("#debate-topic")?.focus();
      }
    },
    {
      id: "act:ai-groq",
      section: "AÇÕES RÁPIDAS",
      title: "Falar só com Groq",
      subtitle: "Chat Rápido com Groq (baixa latência)",
      keywords: "ia groq rapido",
      run: () => {
        setSelectedParticipants(["groq"], { singleMode: true });
        switchView("chat");
        $("#debate-topic")?.focus();
      }
    },
    {
      id: "act:ai-openrouter",
      section: "AÇÕES RÁPIDAS",
      title: "Falar só com OpenRouter (:free)",
      subtitle: "Chat Rápido com auto-fallback gratuito",
      keywords: "ia openrouter free gratis",
      run: () => {
        setSelectedParticipants(["openrouter"], { singleMode: true });
        switchView("chat");
        $("#debate-topic")?.focus();
      }
    },
    {
      id: "act:ai-nvidia",
      section: "AÇÕES RÁPIDAS",
      title: "Falar só com NVIDIA NIM",
      subtitle: "Chat Rápido com catálogo gratuito NVIDIA (Qwen, Nemotron, Llama, DeepSeek)",
      keywords: "ia nvidia nim qwen nemotron deepseek codigo",
      run: () => {
        setSelectedParticipants(["nvidia"], { singleMode: true });
        switchView("chat");
        $("#debate-topic")?.focus();
      }
    },
    {
      id: "act:toggle-response-mode",
      section: "AÇÕES RÁPIDAS",
      title:
        state.selectedResponseMode === "prompt_markdown"
          ? "Formato de resposta: Normal"
          : "Formato de resposta: Prompt MD",
      subtitle: "Alternar entre resposta natural e entrega técnica estruturada",
      keywords: "formato normal prompt markdown tecnico",
      run: () => {
        const next =
          state.selectedResponseMode === "prompt_markdown" ? "normal" : "prompt_markdown";
        state.selectedResponseMode = next;
        saveStoredOption(RESPONSE_MODE_STORAGE_KEY, next);
        syncComposerModeUi();
        switchView("chat");
      }
    },
    {
      id: "act:toggle-web",
      section: "AÇÕES RÁPIDAS",
      title:
        state.selectedWebSearchMode === "off"
          ? "Ativar Busca na Web (Auto)"
          : "Desativar Busca na Web",
      subtitle:
        state.selectedWebSearchMode === "off"
          ? "Pesquisa automática quando o assunto pedir dados atuais"
          : "Responder apenas com conhecimento interno e anexos",
      badge: state.selectedWebSearchMode === "off" ? "Off" : "Auto",
      keywords: "web busca internet pesquisa",
      run: () => {
        state.selectedWebSearchMode =
          state.selectedWebSearchMode === "off" ? "auto" : "off";
        saveStoredOption(WEB_SEARCH_STORAGE_KEY, state.selectedWebSearchMode);
        syncComposerModeUi();
      }
    },
    {
      id: "act:open-templates",
      section: "AÇÕES RÁPIDAS",
      title: "Biblioteca de Templates",
      subtitle: "Criar, editar ou aplicar prompts salvos (ou digite / no chat)",
      shortcut: "/",
      keywords: "templates prompts biblioteca atalhos barra",
      run: () => {
        openTemplatesModal();
      }
    },
    {
      id: "act:new-project",
      section: "AÇÕES RÁPIDAS",
      title: "Criar Novo Projeto",
      subtitle: "Pasta com instruções fixas e base local de arquivos",
      keywords: "projeto pasta novo criar",
      run: () => {
        openProjectModal(null);
      }
    },
    {
      id: "act:refresh-openrouter",
      section: "AÇÕES RÁPIDAS",
      title: "Atualizar modelos :free do OpenRouter",
      subtitle: "Consultar catálogo gratuito ao vivo (0 tokens) e atualizar fallback",
      keywords: "openrouter free modelos atualizar descobrir fallback",
      run: () => {
        switchView("dashboard");
        void handleRefreshOpenRouterFreeModels();
      }
    },
    {
      id: "act:view-chat",
      section: "AÇÕES RÁPIDAS",
      title: "Ir para Chat Central",
      subtitle: "Voltar à conversa ativa",
      keywords: "ir abrir chat conversa",
      run: () => {
        switchView("chat");
        $("#debate-topic")?.focus();
      }
    },
    {
      id: "act:view-monitor",
      section: "AÇÕES RÁPIDAS",
      title: "Ir para Monitor, Memória & Privacidade",
      subtitle: "Provedores, cotas, memória pessoal, cofre e LGPD",
      keywords: "monitor dashboard privacidade cofre memoria provedores lgpd",
      run: () => {
        switchView("dashboard");
        void loadUserMemory();
        void loadPrivacyStatus();
      }
    },
    {
      id: "act:view-history",
      section: "AÇÕES RÁPIDAS",
      title: "Ir para Histórico de Eventos",
      subtitle: "Registros e avisos recentes do sistema",
      keywords: "historico eventos logs atividade",
      run: () => {
        switchView("history");
      }
    }
  ];

  const lockVaultBtn = $("#btn-lock-vault");
  if (lockVaultBtn && !lockVaultBtn.hidden) {
    actions.push({
      id: "act:lock-vault",
      section: "AÇÕES RÁPIDAS",
      title: "Trancar Cofre Local agora",
      subtitle: "Limpa a chave da RAM imediatamente (exige Senha Mestra)",
      keywords: "trancar cofre bloquear senha mestra seguranca",
      run: () => {
        void handleLockVaultNow();
      }
    });
  }

  const setupBtn = $("#open-setup-wizard-btn");
  if (setupBtn && !setupBtn.hidden) {
    actions.push({
      id: "act:open-setup",
      section: "AÇÕES RÁPIDAS",
      title: "Chaves & Acesso (Setup Local)",
      subtitle: "Atualizar chaves das APIs ou senha de acesso remoto",
      keywords: "chaves setup api key senha configuracao",
      run: () => {
        void openSetupWizard({ locked: false });
      }
    });
  }

  const matchedActions = actions.filter((a) =>
    matches(a.title, a.subtitle, a.keywords)
  );

  // 2. Conversas
  const debates = Array.isArray(state.latestDebates) ? state.latestDebates : [];
  const matchedDebates = debates
    .filter((d) => matches(d.title, d.topic, d.status))
    .slice(0, query ? 12 : 6)
    .map((d) => ({
      id: `debate:${d.id}`,
      section: "CONVERSAS",
      title: d.title || "Conversa sem título",
      subtitle: d.topic ? String(d.topic).slice(0, 88) : "Abrir conversa",
      badge: d.pinned ? "Fixada" : d.status === "running" ? "Ao vivo" : "",
      run: () => {
        closeMobileDrawers();
        switchView("chat");
        selectDebate(d.id);
      }
    }));

  // 3. Projetos
  const projects = Array.isArray(state.userProjects) ? state.userProjects : [];
  const matchedProjects = projects
    .filter((p) => matches(p.name, p.description, p.instructions))
    .slice(0, 6)
    .map((p) => ({
      id: `proj:${p.id}`,
      section: "PROJETOS",
      title: p.name,
      subtitle: p.description || "Filtrar conversas e ativar contexto do projeto",
      badge: state.selectedProjectFilterId === p.id ? "Ativo" : "Projeto",
      run: () => {
        state.selectedProjectFilterId = p.id;
        state.activeNewChatProjectId = p.id;
        renderProjectsSidebar();
        syncComposerProjectPill();
        switchView("chat");
        $("#debate-topic")?.focus();
      }
    }));

  // 4. Templates de Prompt
  const templates = getAvailableTemplates();
  const matchedTemplates = templates
    .filter((t) => matches(t.title, t.tag, t.prompt, t.topic))
    .slice(0, 6)
    .map((t) => ({
      id: `tpl:${t.id}`,
      section: "TEMPLATES DE PROMPT",
      title: t.title,
      subtitle: String(t.prompt || t.topic || "").slice(0, 88),
      badge: t.tag || "Template",
      run: () => {
        switchView("chat");
        applyPromptTemplate(t);
      }
    }));

  // Se o usuário digitou algo, prioriza conversas/projetos/templates junto com ações;
  // sem busca, mostra ações principais + conversas recentes primeiro.
  if (query) {
    if (matchedDebates.length) groups.push(...matchedDebates);
    if (matchedProjects.length) groups.push(...matchedProjects);
    if (matchedTemplates.length) groups.push(...matchedTemplates);
    if (matchedActions.length) groups.push(...matchedActions);
  } else {
    groups.push(...matchedActions.slice(0, 8));
    if (matchedDebates.length) groups.push(...matchedDebates);
    if (matchedProjects.length) groups.push(...matchedProjects.slice(0, 3));
    if (matchedTemplates.length) groups.push(...matchedTemplates.slice(0, 3));
  }

  return groups;
}

function renderCommandPaletteList(query = "") {
  const listEl = $("#command-palette-list");
  if (!listEl) return;

  paletteItems = buildPaletteItems(query);
  if (paletteActiveIndex >= paletteItems.length) {
    paletteActiveIndex = 0;
  }

  listEl.replaceChildren();

  if (paletteItems.length === 0) {
    const empty = document.createElement("div");
    empty.className = "cmd-palette-empty";
    empty.textContent = "Nenhum comando, conversa, projeto ou template encontrado.";
    listEl.appendChild(empty);
    return;
  }

  let currentSection = "";

  paletteItems.forEach((item, index) => {
    if (item.section !== currentSection) {
      currentSection = item.section;
      const heading = document.createElement("div");
      heading.className = "cmd-palette-section-title";
      heading.textContent = currentSection;
      listEl.appendChild(heading);
    }

    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `cmd-palette-item${index === paletteActiveIndex ? " is-active" : ""}`;
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", String(index === paletteActiveIndex));
    btn.dataset.cmdIndex = String(index);

    const textWrap = document.createElement("div");
    textWrap.className = "cmd-palette-item-text";

    const titleEl = document.createElement("strong");
    titleEl.className = "cmd-palette-item-title";
    titleEl.textContent = item.title;

    textWrap.appendChild(titleEl);

    if (item.subtitle) {
      const subEl = document.createElement("span");
      subEl.className = "cmd-palette-item-sub";
      subEl.textContent = item.subtitle;
      textWrap.appendChild(subEl);
    }

    btn.appendChild(textWrap);

    if (item.badge || item.shortcut) {
      const metaEl = document.createElement("span");
      metaEl.className = item.shortcut ? "cmd-palette-kbd" : "cmd-palette-badge";
      metaEl.textContent = item.shortcut || item.badge;
      btn.appendChild(metaEl);
    }

    btn.addEventListener("mouseenter", () => {
      if (paletteActiveIndex !== index) {
        paletteActiveIndex = index;
        syncPaletteActiveVisual();
      }
    });

    btn.addEventListener("click", () => {
      executePaletteItem(index);
    });

    listEl.appendChild(btn);
  });
}

function syncPaletteActiveVisual() {
  const listEl = $("#command-palette-list");
  if (!listEl) return;
  const buttons = listEl.querySelectorAll(".cmd-palette-item");
  buttons.forEach((btn) => {
    const idx = Number(btn.dataset.cmdIndex);
    const active = idx === paletteActiveIndex;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
    if (active) {
      btn.scrollIntoView({ block: "nearest" });
    }
  });
}

function executePaletteItem(index) {
  const item = paletteItems[index];
  if (!item) return;
  closeCommandPalette();
  item.run();
}

export function openCommandPalette() {
  if (isSecurityLockVisible()) return;
  const modal = $("#command-palette-modal");
  const input = $("#command-palette-input");
  if (!modal || !input) return;

  closeSlashMenu();
  paletteActiveIndex = 0;
  input.value = "";
  modal.hidden = false;
  renderCommandPaletteList("");
  requestAnimationFrame(() => input.focus());
}

export function closeCommandPalette() {
  const modal = $("#command-palette-modal");
  if (modal && !modal.hidden) {
    modal.hidden = true;
  }
}

export function isCommandPaletteOpen() {
  const modal = $("#command-palette-modal");
  return Boolean(modal && !modal.hidden);
}

// ============================================================================
// MENU SLASH "/" PARA TEMPLATES DE PROMPT NO COMPOSER
// ============================================================================

let slashEntries = [];
let slashActiveIndex = 0;
let slashDismissedForValue = null;

export function isSlashMenuOpen() {
  const menu = $("#slash-templates-menu");
  return Boolean(menu && !menu.hidden);
}

export function closeSlashMenu(rememberCurrentValue = false) {
  const menu = $("#slash-templates-menu");
  const topicInput = $("#debate-topic");
  if (rememberCurrentValue && topicInput) {
    slashDismissedForValue = topicInput.value;
  }
  if (menu && !menu.hidden) {
    menu.hidden = true;
  }
  slashEntries = [];
  slashActiveIndex = 0;
}

function syncSlashActiveVisual() {
  const listEl = $("#slash-templates-list");
  if (!listEl) return;
  const buttons = listEl.querySelectorAll(".slash-menu-item");
  buttons.forEach((btn) => {
    const idx = Number(btn.dataset.slashIndex);
    const active = idx === slashActiveIndex;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", String(active));
    if (active) {
      btn.scrollIntoView({ block: "nearest" });
    }
  });
}

function applySlashEntry(index) {
  const entry = slashEntries[index];
  if (!entry) return;
  closeSlashMenu(false);
  if (entry.kind === "manage") {
    const topicInput = $("#debate-topic");
    if (topicInput && topicInput.value.startsWith("/")) {
      topicInput.value = "";
      topicInput.style.height = "auto";
    }
    openTemplatesModal();
    return;
  }
  applyPromptTemplate(entry.template);
}

function updateSlashMenuFromInput() {
  const topicInput = $("#debate-topic");
  const menu = $("#slash-templates-menu");
  const listEl = $("#slash-templates-list");
  const hintEl = $("#slash-templates-query");
  if (!topicInput || !menu || !listEl) return;

  const value = topicInput.value || "";
  if (slashDismissedForValue !== null && value === slashDismissedForValue) {
    return;
  }
  slashDismissedForValue = null;

  // Abre apenas quando o campo começa com "/" na primeira linha (sem quebra de linha)
  const match = value.match(/^\/([^\n]{0,60})$/);
  if (!match) {
    closeSlashMenu(false);
    return;
  }

  const rawQuery = match[1] || "";
  const query = normalizeSearchText(rawQuery);
  const templates = getAvailableTemplates();
  const filtered = templates.filter((tpl) => {
    if (!query) return true;
    const hay = normalizeSearchText(
      `${tpl.title || ""} ${tpl.tag || ""} ${tpl.prompt || tpl.topic || ""}`
    );
    return hay.includes(query);
  });

  slashEntries = [
    ...filtered.slice(0, 8).map((template) => ({
      kind: "template",
      template
    })),
    {
      kind: "manage"
    }
  ];

  if (slashActiveIndex >= slashEntries.length) {
    slashActiveIndex = 0;
  }

  if (hintEl) {
    hintEl.textContent = rawQuery ? `/${rawQuery}` : "TEMPLATES DE PROMPT";
  }

  listEl.replaceChildren();

  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "slash-menu-empty";
    empty.textContent = `Nenhum template para "/${rawQuery}".`;
    listEl.appendChild(empty);
  }

  slashEntries.forEach((entry, idx) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `slash-menu-item${entry.kind === "manage" ? " is-manage-row" : ""}${idx === slashActiveIndex ? " is-active" : ""}`;
    btn.setAttribute("role", "option");
    btn.setAttribute("aria-selected", String(idx === slashActiveIndex));
    btn.dataset.slashIndex = String(idx);

    if (entry.kind === "manage") {
      const label = document.createElement("span");
      label.className = "slash-manage-label";
      label.textContent = "+ Gerenciar templates";
      const sub = document.createElement("span");
      sub.className = "slash-menu-meta";
      sub.textContent = "Criar ou editar";
      btn.append(label, sub);
    } else {
      const tpl = entry.template;
      const top = document.createElement("div");
      top.className = "slash-menu-item-top";

      const title = document.createElement("strong");
      title.className = "slash-menu-title";
      title.textContent = tpl.title || "Template";

      const meta = document.createElement("span");
      meta.className = "slash-menu-meta";
      const respLabel = RESPONSE_MODE_LABELS[tpl.responseMode] || "Normal";
      const interLabel = INTERACTION_MODE_LABELS[tpl.interactionMode] || "Direto";
      meta.textContent = `${tpl.tag ? `${tpl.tag} · ` : ""}${respLabel} · ${interLabel}`;

      top.append(title, meta);

      const preview = document.createElement("p");
      preview.className = "slash-menu-preview";
      preview.textContent = String(tpl.prompt || tpl.topic || "").slice(0, 120);

      btn.append(top, preview);
    }

    btn.addEventListener("mouseenter", () => {
      if (slashActiveIndex !== idx) {
        slashActiveIndex = idx;
        syncSlashActiveVisual();
      }
    });

    btn.addEventListener("mousedown", (e) => {
      // Evita perder o foco do textarea antes de aplicar o template
      e.preventDefault();
    });

    btn.addEventListener("click", () => {
      applySlashEntry(idx);
    });

    listEl.appendChild(btn);
  });

  menu.hidden = false;
}

/**
 * Intercepta teclas no textarea enquanto o menu "/" estiver aberto.
 * Retorna true se o evento foi consumido (evita enviar o formulário com Enter).
 */
export function handleComposerSlashKeydown(event) {
  if (!isSlashMenuOpen() || slashEntries.length === 0) {
    return false;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    slashActiveIndex = (slashActiveIndex + 1) % slashEntries.length;
    syncSlashActiveVisual();
    return true;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    slashActiveIndex =
      (slashActiveIndex - 1 + slashEntries.length) % slashEntries.length;
    syncSlashActiveVisual();
    return true;
  }

  if (event.key === "Enter" || event.key === "Tab") {
    event.preventDefault();
    applySlashEntry(slashActiveIndex);
    return true;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    closeSlashMenu(true);
    return true;
  }

  return false;
}

// ============================================================================
// INICIALIZAÇÃO DE EVENTOS
// ============================================================================

export function initShortcutsUi() {
  const paletteModal = $("#command-palette-modal");
  const paletteInput = $("#command-palette-input");
  const paletteCloseBtn = $("#command-palette-close");
  const paletteTriggerBtn = $("#sidebar-cmd-k-btn");
  const topicTextarea = $("#debate-topic");
  const slashMenu = $("#slash-templates-menu");

  paletteTriggerBtn?.addEventListener("click", () => {
    openCommandPalette();
  });

  paletteCloseBtn?.addEventListener("click", () => {
    closeCommandPalette();
  });

  paletteModal?.addEventListener("click", (e) => {
    if (e.target === paletteModal) {
      closeCommandPalette();
    }
  });

  paletteInput?.addEventListener("input", () => {
    paletteActiveIndex = 0;
    renderCommandPaletteList(paletteInput.value);
  });

  paletteInput?.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (paletteItems.length > 0) {
        paletteActiveIndex = (paletteActiveIndex + 1) % paletteItems.length;
        syncPaletteActiveVisual();
      }
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      if (paletteItems.length > 0) {
        paletteActiveIndex =
          (paletteActiveIndex - 1 + paletteItems.length) % paletteItems.length;
        syncPaletteActiveVisual();
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (paletteItems.length > 0) {
        executePaletteItem(paletteActiveIndex);
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      closeCommandPalette();
    }
  });

  topicTextarea?.addEventListener("input", () => {
    updateSlashMenuFromInput();
  });

  slashMenu?.addEventListener("click", (e) => {
    e.stopPropagation();
  });

  document.addEventListener("keydown", (e) => {
    const mod = e.ctrlKey || e.metaKey;
    const key = (e.key || "").toLowerCase();

    // Ctrl+K / Cmd+K -> Paleta de Comandos
    if (mod && !e.altKey && !e.shiftKey && key === "k") {
      e.preventDefault();
      if (isCommandPaletteOpen()) {
        closeCommandPalette();
      } else {
        openCommandPalette();
      }
      return;
    }

    // Alt+N -> Nova Conversa rápida (não conflita com Ctrl+N do navegador)
    if (e.altKey && !mod && !e.shiftKey && key === "n") {
      if (isSecurityLockVisible()) return;
      e.preventDefault();
      closeCommandPalette();
      closeSlashMenu(false);
      closeMobileDrawers();
      startNewDebateView();
      $("#debate-topic")?.focus();
    }
  });
}
