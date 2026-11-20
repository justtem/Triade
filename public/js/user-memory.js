import { $, $$, state } from "./state.js";
import { fetchJson, loadProjects, refreshDashboard } from "./api.js";
import { escapeHtml } from "./markdown.js";

const MEMORY_CATEGORY_LABELS = {
  identity: "Perfil",
  preference: "Preferência",
  context: "Contexto",
  project: "Projeto",
  other: "Nota"
};

export function renderUserMemoryPanel() {
  const listEl = $("#user-memory-facts-list");
  const clearBtn = $("#user-memory-clear-btn");
  const mem = state.userMemoryState;
  if (!listEl) return;

  const isEnabled = mem ? mem.enabled !== false : true;
  for (const btn of $$("#user-memory-toggle .mode-seg-btn")) {
    const val = btn.getAttribute("data-user-memory-enabled") === "true";
    const active = val === isEnabled;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
  }

  const facts = Array.isArray(mem?.facts) ? mem.facts : [];
  if (clearBtn) {
    clearBtn.hidden = facts.length === 0;
  }

  listEl.replaceChildren();
  if (facts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "user-memory-empty";
    empty.textContent = isEnabled
      ? "Nenhum fato memorizado ainda — converse normalmente e o AI Council aprenderá suas preferências automaticamente."
      : "Aprendizado automático pausado. Nenhum fato armazenado.";
    listEl.appendChild(empty);
    return;
  }

  for (const fact of facts) {
    const row = document.createElement("div");
    row.className = "user-memory-fact-row";
    const catLabel = MEMORY_CATEGORY_LABELS[fact.category] || "Nota";

    const left = document.createElement("div");
    left.className = "user-memory-fact-main";
    left.innerHTML = `<span class="user-memory-cat-tag">${escapeHtml(catLabel)}</span><span class="user-memory-fact-text">${escapeHtml(fact.text)}</span>`;

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "icon-btn user-memory-fact-remove";
    delBtn.title = "Remover este fato da memória";
    delBtn.setAttribute("aria-label", "Remover fato");
    delBtn.textContent = "×";
    delBtn.addEventListener("click", async () => {
      delBtn.disabled = true;
      try {
        const res = await fetchJson(`/user-memory/${encodeURIComponent(fact.id)}`, {
          method: "DELETE"
        });
        if (res?.memory) {
          state.userMemoryState = res.memory;
          renderUserMemoryPanel();
        }
      } catch {
        delBtn.disabled = false;
      }
    });

    row.append(left, delBtn);
    listEl.appendChild(row);
  }
}

export async function loadUserMemory() {
  try {
    const res = await fetchJson("/user-memory");
    if (res?.memory) {
      state.userMemoryState = res.memory;
      renderUserMemoryPanel();
    }
  } catch {
    // Silencioso quando não autenticado remotamente ainda
  }
}

export async function toggleUserMemoryEnabled(enabled) {
  try {
    const res = await fetchJson("/user-memory", {
      method: "PATCH",
      body: { enabled: Boolean(enabled) }
    });
    if (res?.memory) {
      state.userMemoryState = res.memory;
      renderUserMemoryPanel();
    }
  } catch {
    // Ignora falha temporária
  }
}

export async function handleClearUserMemory() {
  try {
    const res = await fetchJson("/user-memory", { method: "DELETE" });
    if (res?.memory) {
      state.userMemoryState = res.memory;
      renderUserMemoryPanel();
    }
  } catch {
    // Ignora falha temporária
  }
}

export async function handleExportPrivacyData() {
  const btn = $("#privacy-export-btn");
  const feedback = $("#privacy-feedback");
  if (btn) btn.disabled = true;
  if (feedback) feedback.textContent = "Preparando exportação...";

  try {
    const response = await fetch("/privacy/export", {
      method: "GET",
      credentials: "same-origin",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data?.error || `Erro HTTP ${response.status}`);
    }

    const blob = await response.blob();
    const dateStamp = new Date().toISOString().slice(0, 10);
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = `ai-council-dados-${dateStamp}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);

    if (feedback) {
      feedback.textContent = `Backup exportado (ai-council-dados-${dateStamp}.json).`;
    }
  } catch (error) {
    if (feedback) {
      feedback.textContent =
        error instanceof Error ? error.message : "Falha ao exportar dados.";
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function handleWipeLocalData() {
  const input = $("#privacy-wipe-input");
  const confirmBtn = $("#privacy-wipe-confirm-btn");
  const box = $("#privacy-wipe-confirm-box");
  const feedback = $("#privacy-feedback");
  const confirmValue = (input?.value || "").trim();

  if (confirmValue !== "APAGAR TUDO") {
    if (feedback) {
      feedback.textContent = 'Digite exatamente "APAGAR TUDO" para confirmar.';
    }
    input?.focus();
    return;
  }

  if (confirmBtn) confirmBtn.disabled = true;
  if (feedback) feedback.textContent = "Apagando dados locais...";

  try {
    const res = await fetchJson("/privacy/wipe", {
      method: "POST",
      body: { confirm: confirmValue }
    });

    if (input) input.value = "";
    if (box) box.hidden = true;

    state.selectedDebateId = null;
    state.latestDebates = [];
    state.userProjects = [];
    state.selectedProjectFilterId = null;
    state.activeNewChatProjectId = null;
    state.userMemoryState = { enabled: true, facts: [] };
    state.lastDebatesSignature = "";
    state.lastRenderedChatSignature = "";
    renderUserMemoryPanel();

    await Promise.all([loadProjects(), refreshDashboard()]);

    if (feedback) {
      feedback.textContent =
        res?.message || "Dados locais apagados com sucesso.";
    }
  } catch (error) {
    if (feedback) {
      feedback.textContent =
        error instanceof Error ? error.message : "Falha ao apagar dados locais.";
    }
  } finally {
    if (confirmBtn) confirmBtn.disabled = false;
  }
}

// ============================================================================
// ESCUDO DE PRIVACIDADE (MODAL DE CONFIRMAÇÃO) & PROTEÇÃO EM REPOUSO / NTFS
// ============================================================================

let pendingShieldResolver = null;

function resolvePrivacyShield(decision) {
  const modal = $("#privacy-shield-modal");
  if (modal) modal.hidden = true;
  if (pendingShieldResolver) {
    const fn = pendingShieldResolver;
    pendingShieldResolver = null;
    fn(decision);
  }
}

export function closePrivacyShieldModal() {
  if (pendingShieldResolver) {
    resolvePrivacyShield("cancel");
  } else {
    const modal = $("#privacy-shield-modal");
    if (modal) modal.hidden = true;
  }
}

export function promptPrivacyShieldDecision(findings = []) {
  const modal = $("#privacy-shield-modal");
  const listEl = $("#privacy-shield-findings-list");
  if (!modal || !listEl) {
    return Promise.resolve("mask");
  }

  // Cancela eventual diálogo anterior pendente
  if (pendingShieldResolver) {
    pendingShieldResolver("cancel");
    pendingShieldResolver = null;
  }

  listEl.replaceChildren();
  for (const item of Array.isArray(findings) ? findings : []) {
    const row = document.createElement("div");
    row.className = "privacy-shield-item";
    const previews = Array.isArray(item.previews) ? item.previews.join(" · ") : "";
    row.innerHTML = `<div class="privacy-shield-item-head"><strong>${escapeHtml(item.label || item.category || "Dado sensível")}</strong><span class="privacy-control-badge">${escapeHtml(String(item.count || 1))}x</span></div>${previews ? `<div class="privacy-shield-previews">${escapeHtml(previews)}</div>` : ""}`;
    listEl.appendChild(row);
  }

  modal.hidden = false;

  return new Promise((resolve) => {
    pendingShieldResolver = resolve;

    const maskBtn = $("#privacy-shield-mask-btn");
    const allowBtn = $("#privacy-shield-allow-btn");
    const cancelBtn = $("#privacy-shield-cancel-btn");
    const closeBtn = $("#privacy-shield-close");

    if (maskBtn) maskBtn.onclick = () => resolvePrivacyShield("mask");
    if (allowBtn) allowBtn.onclick = () => resolvePrivacyShield("allow");
    if (cancelBtn) cancelBtn.onclick = () => resolvePrivacyShield("cancel");
    if (closeBtn) closeBtn.onclick = () => resolvePrivacyShield("cancel");
    modal.onclick = (e) => {
      if (e.target === modal) resolvePrivacyShield("cancel");
    };
    setTimeout(() => maskBtn?.focus(), 30);
  });
}

export function renderPrivacyProtectionPanel() {
  const p = state.privacyStatus;
  const isLocal = Boolean(state.privacyIsLocal);
  const shieldMode = p?.shieldMode || "strict";

  for (const btn of $$("#privacy-shield-mode-toggle .mode-seg-btn")) {
    const val = btn.getAttribute("data-shield-mode");
    const active = val === shieldMode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
  }

  const encryptRow = $("#privacy-encrypt-row");
  const encryptBadge = $("#privacy-encrypt-status");
  const encryptActive = Boolean(p?.encryptAtRest);
  const dpapiSupported = p ? Boolean(p.dpapiSupported) : true;

  if (encryptRow) {
    encryptRow.hidden = !isLocal;
  }
  if (encryptBadge) {
    encryptBadge.textContent = !dpapiSupported
      ? "Somente Windows"
      : encryptActive
        ? "Ativa (DPAPI)"
        : "Desativada";
    encryptBadge.classList.toggle("is-ok", encryptActive && dpapiSupported);
  }
  for (const btn of $$("#privacy-encrypt-toggle .mode-seg-btn")) {
    const val = btn.getAttribute("data-encrypt-rest") === "true";
    const active = val === encryptActive;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
    btn.disabled = !dpapiSupported || !isLocal;
  }

  const ntfsRow = $("#privacy-ntfs-row");
  const ntfsBadge = $("#privacy-ntfs-status");
  const ntfsBtn = $("#privacy-ntfs-harden-btn");
  const ntfsSupported = p ? Boolean(p.ntfsSupported) : true;

  if (ntfsRow) {
    ntfsRow.hidden = !isLocal || !ntfsSupported;
  }
  if (ntfsBadge) {
    ntfsBadge.textContent = p?.ntfsHardenedAt
      ? "Restrito ao seu usuário"
      : "Pronto para aplicar";
    ntfsBadge.classList.toggle("is-ok", Boolean(p?.ntfsHardenedAt));
  }
  if (ntfsBtn) {
    ntfsBtn.disabled = !isLocal || !ntfsSupported;
  }
}

export async function loadPrivacyStatus() {
  try {
    const res = await fetchJson("/privacy/status");
    if (res?.protection) {
      state.privacyStatus = res.protection;
      state.privacyIsLocal = Boolean(res.isLocal);
      renderPrivacyProtectionPanel();
    }
  } catch {
    // Silencioso antes da autenticação remota
  }
}

export async function setPrivacyShieldMode(mode) {
  const feedback = $("#privacy-feedback");
  try {
    const res = await fetchJson("/privacy/settings", {
      method: "PATCH",
      body: { shieldMode: mode }
    });
    if (res?.protection) {
      state.privacyStatus = res.protection;
      renderPrivacyProtectionPanel();
    }
    if (feedback) {
      const label =
        mode === "strict"
          ? "Estrito"
          : mode === "standard"
            ? "Padrão"
            : "Desligado";
      feedback.textContent = `Escudo de Privacidade definido para: ${label}.`;
    }
  } catch (error) {
    if (feedback) {
      feedback.textContent =
        error instanceof Error ? error.message : "Erro ao alterar Escudo.";
    }
  }
}

export async function setEncryptAtRest(enabled) {
  const feedback = $("#privacy-feedback");
  if (feedback) {
    feedback.textContent = enabled
      ? "Criptografando arquivos locais com AES-256-GCM + DPAPI..."
      : "Descriptografando arquivos locais para JSON padrão...";
  }
  for (const btn of $$("#privacy-encrypt-toggle .mode-seg-btn")) {
    btn.disabled = true;
  }
  try {
    const res = await fetchJson("/privacy/settings", {
      method: "PATCH",
      body: { encryptAtRest: Boolean(enabled) }
    });
    if (res?.protection) {
      state.privacyStatus = res.protection;
    }
    if (feedback) {
      const count = Number(res?.migratedFiles) || 0;
      feedback.textContent = enabled
        ? `Criptografia em repouso ativada (${count} arquivo(s) migrado(s)).`
        : `Criptografia em repouso desativada (${count} arquivo(s) restaurado(s)).`;
    }
  } catch (error) {
    if (feedback) {
      feedback.textContent =
        error instanceof Error
          ? error.message
          : "Falha ao alterar criptografia em repouso.";
    }
  } finally {
    renderPrivacyProtectionPanel();
  }
}

export async function handleReapplyNtfs() {
  const btn = $("#privacy-ntfs-harden-btn");
  const feedback = $("#privacy-feedback");
  if (btn) btn.disabled = true;
  if (feedback) feedback.textContent = "Aplicando permissões NTFS exclusivas ao seu usuário...";
  try {
    const res = await fetchJson("/privacy/ntfs-harden", { method: "POST" });
    if (res?.protection) {
      state.privacyStatus = res.protection;
    }
    if (feedback) {
      feedback.textContent = res?.applied
        ? "Permissões NTFS aplicadas em .env e data/."
        : res?.error || "Permissões NTFS não aplicáveis neste ambiente.";
    }
  } catch (error) {
    if (feedback) {
      feedback.textContent =
        error instanceof Error ? error.message : "Erro ao aplicar NTFS.";
    }
  } finally {
    renderPrivacyProtectionPanel();
  }
}
