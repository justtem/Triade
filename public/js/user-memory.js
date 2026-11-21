import { $, $$, state } from "./state.js";
import {
  disconnectEventStream,
  fetchJson,
  hideVaultLockOverlay,
  loadProjects,
  refreshDashboard,
  showVaultLockOverlay
} from "./api.js";
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

let privacyFeedbackTimer = null;

function setPrivacyFeedback(message, autoClearMs = 4500) {
  const feedback = $("#privacy-feedback");
  if (!feedback) return;
  if (privacyFeedbackTimer) {
    clearTimeout(privacyFeedbackTimer);
    privacyFeedbackTimer = null;
  }
  feedback.textContent = message || "";
  if (message && autoClearMs > 0) {
    privacyFeedbackTimer = setTimeout(() => {
      if (feedback.textContent === message) {
        feedback.textContent = "";
      }
      privacyFeedbackTimer = null;
    }, autoClearMs);
  }
}

export async function handleExportPrivacyData() {
  const btn = $("#privacy-export-btn");
  if (btn) btn.disabled = true;
  setPrivacyFeedback("Preparando backup...", 0);

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

    setPrivacyFeedback("Backup exportado.");
  } catch (error) {
    setPrivacyFeedback(
      error instanceof Error ? error.message : "Falha ao exportar backup.",
      6000
    );
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function handleWipeLocalData() {
  const input = $("#privacy-wipe-input");
  const confirmBtn = $("#privacy-wipe-confirm-btn");
  const box = $("#privacy-wipe-confirm-box");
  const confirmValue = (input?.value || "").trim();

  if (confirmValue !== "APAGAR TUDO") {
    setPrivacyFeedback('Digite exatamente "APAGAR TUDO" para confirmar.', 5000);
    input?.focus();
    return;
  }

  if (confirmBtn) confirmBtn.disabled = true;
  setPrivacyFeedback("Apagando dados...", 0);

  try {
    await fetchJson("/privacy/wipe", {
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

    setPrivacyFeedback("Dados locais apagados.");
  } catch (error) {
    setPrivacyFeedback(
      error instanceof Error ? error.message : "Falha ao apagar dados.",
      6000
    );
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

export function promptPrivacyShieldDecision(findings = [], imageFindings = []) {
  const modal = $("#privacy-shield-modal");
  const listEl = $("#privacy-shield-findings-list");
  const maskLabel = $("#privacy-shield-mask-label");
  if (!modal || !listEl) {
    return Promise.resolve("mask");
  }

  // Cancela eventual diálogo anterior pendente
  if (pendingShieldResolver) {
    pendingShieldResolver("cancel");
    pendingShieldResolver = null;
  }

  const hasImg = Array.isArray(imageFindings) && imageFindings.length > 0;
  if (maskLabel) {
    maskLabel.textContent = hasImg
      ? "Tarjar imagem / Mascarar e Enviar"
      : "Mascarar e Enviar";
  }

  listEl.replaceChildren();
  for (const item of Array.isArray(findings) ? findings : []) {
    const row = document.createElement("div");
    row.className = "privacy-shield-item";
    const previews = Array.isArray(item.previews) ? item.previews.join(" · ") : "";
    row.innerHTML = `<div class="privacy-shield-item-head"><strong>${escapeHtml(item.label || item.category || "Dado sensível")}</strong><span class="privacy-control-badge">${escapeHtml(String(item.count || 1))}x</span></div>${previews ? `<div class="privacy-shield-previews">${escapeHtml(previews)}</div>` : ""}`;
    listEl.appendChild(row);
  }

  if (hasImg) {
    for (const img of imageFindings) {
      const row = document.createElement("div");
      row.className = "privacy-shield-item";
      const boxCount = Array.isArray(img.sensitiveBoxes) ? img.sensitiveBoxes.length : 0;
      const cats = (img.findings || []).map((f) => f.label || f.category).join(", ");
      row.innerHTML = `<div class="privacy-shield-item-head"><strong>Print / Imagem (OCR local): ${escapeHtml(img.attachmentName || "imagem")}</strong><span class="privacy-control-badge">${escapeHtml(String(boxCount))} tarja(s)</span></div><div class="privacy-shield-previews">${escapeHtml(cats || "Texto sensível detectado na imagem")}</div>`;
      listEl.appendChild(row);
    }
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

/**
 * Aplica tarjas pretas sólidas (#080808) sobre as coordenadas detectadas pelo OCR local
 * diretamente no <canvas> do navegador, substituindo o dataBase64 antes do envio às IAs.
 */
export async function redactImageAttachmentsWithBoxes(attachments, imageFindings) {
  if (!Array.isArray(attachments) || !Array.isArray(imageFindings) || imageFindings.length === 0) {
    return attachments;
  }

  const byName = new Map();
  for (const item of imageFindings) {
    if (item?.attachmentName && Array.isArray(item.sensitiveBoxes) && item.sensitiveBoxes.length > 0) {
      byName.set(item.attachmentName, item);
    }
  }
  if (byName.size === 0) return attachments;

  const output = [];
  for (const att of attachments) {
    const match = att?.kind === "image" && att.dataBase64 ? byName.get(att.name) : null;
    if (!match) {
      output.push(att);
      continue;
    }

    try {
      const mime = att.mimeType || "image/png";
      const dataUrl = `data:${mime};base64,${att.dataBase64}`;
      const img = await new Promise((resolve, reject) => {
        const el = new Image();
        el.onload = () => resolve(el);
        el.onerror = () => reject(new Error("Imagem inválida."));
        el.src = dataUrl;
      });

      const canvas = document.createElement("canvas");
      const w = img.naturalWidth || img.width || match.imageWidth || 1;
      const h = img.naturalHeight || img.height || match.imageHeight || 1;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        output.push(att);
        continue;
      }

      ctx.drawImage(img, 0, 0, w, h);
      const scaleX = match.imageWidth > 0 ? w / match.imageWidth : 1;
      const scaleY = match.imageHeight > 0 ? h / match.imageHeight : 1;

      ctx.fillStyle = "#080808";
      for (const box of match.sensitiveBoxes) {
        const rx = Math.max(0, Math.floor(box.x * scaleX) - 4);
        const ry = Math.max(0, Math.floor(box.y * scaleY) - 4);
        const rw = Math.ceil(box.width * scaleX) + 8;
        const rh = Math.ceil(box.height * scaleY) + 8;
        ctx.fillRect(rx, ry, rw, rh);
      }

      const outMime = mime === "image/png" ? "image/png" : "image/jpeg";
      const outUrl = canvas.toDataURL(outMime, 0.9);
      const nextB64 = outUrl.split(",")[1] || att.dataBase64;
      output.push({
        ...att,
        mimeType: outMime,
        dataBase64: nextB64,
        size: Math.floor((nextB64.length * 3) / 4)
      });
    } catch {
      output.push(att);
    }
  }
  return output;
}

export function renderPrivacyProtectionPanel() {
  const p = state.privacyStatus;
  const isLocal = Boolean(state.privacyIsLocal);
  const shieldMode = p?.shieldMode || "strict";
  const vaultMode = p?.vaultMode || (p?.encryptAtRest ? "dpapi" : "off");

  for (const btn of $$("#privacy-shield-mode-toggle .mode-seg-btn")) {
    const val = btn.getAttribute("data-shield-mode");
    const active = val === shieldMode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
  }

  const ocrBadge = $("#privacy-ocr-status");
  if (ocrBadge) {
    const shieldOn = shieldMode !== "off";
    ocrBadge.textContent = shieldOn ? "Ativo" : "Desligado";
    ocrBadge.classList.toggle("is-ok", shieldOn);
  }

  const encryptRow = $("#privacy-encrypt-row");
  const encryptBadge = $("#privacy-encrypt-status");
  const dpapiSupported = p ? Boolean(p.dpapiSupported) : true;

  if (encryptRow) {
    encryptRow.hidden = !isLocal;
  }
  if (encryptBadge) {
    encryptBadge.textContent =
      vaultMode === "master_password"
        ? p?.vaultLocked
          ? "Trancado"
          : "Ativo"
        : vaultMode === "dpapi"
          ? "Ativo"
          : "Desativado";
    encryptBadge.classList.toggle("is-ok", vaultMode !== "off");
  }

  for (const btn of $$("#privacy-vault-mode-toggle .mode-seg-btn")) {
    const val = btn.getAttribute("data-vault-mode");
    const active = val === vaultMode;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
    btn.disabled = !isLocal || (val === "dpapi" && !dpapiSupported);
  }

  const activeBar = $("#privacy-master-active-bar");
  if (activeBar) {
    activeBar.hidden = !isLocal || vaultMode !== "master_password";
  }
  const autoLockSelect = $("#privacy-autolock-select");
  if (autoLockSelect && p && typeof p.vaultAutoLockMinutes === "number") {
    autoLockSelect.value = String(p.vaultAutoLockMinutes);
  }

  const sidebarVaultLockBtn = $("#btn-lock-vault");
  if (sidebarVaultLockBtn) {
    sidebarVaultLockBtn.hidden = vaultMode !== "master_password";
  }

  const sealRow = $("#privacy-seal-keys-row");
  const sealBadge = $("#privacy-seal-keys-status");
  const isSealed = Boolean(p?.apiKeysSealed);
  if (sealRow) {
    sealRow.hidden = !isLocal || vaultMode === "off";
  }
  if (sealBadge) {
    sealBadge.textContent = isSealed ? "No cofre" : "Padrão";
    sealBadge.classList.toggle("is-ok", isSealed);
  }
  for (const btn of $$("#privacy-seal-keys-toggle .mode-seg-btn")) {
    const val = btn.getAttribute("data-seal-keys") === "true";
    const active = val === isSealed;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-pressed", String(active));
    btn.disabled = !isLocal || vaultMode === "off";
  }

  const ntfsRow = $("#privacy-ntfs-row");
  const ntfsBadge = $("#privacy-ntfs-status");
  const ntfsBtn = $("#privacy-ntfs-harden-btn");
  const ntfsSupported = p ? Boolean(p.ntfsSupported) : true;

  if (ntfsRow) {
    ntfsRow.hidden = !isLocal || !ntfsSupported;
  }
  if (ntfsBadge) {
    ntfsBadge.textContent = p?.ntfsHardenedAt ? "Restrito" : "Pendente";
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
      if (res.protection.vaultLocked) {
        showVaultLockOverlay({ isLocal: Boolean(res.isLocal) });
      } else {
        hideVaultLockOverlay();
      }
    }
  } catch {
    // Silencioso antes da autenticação remota
  }
}

export async function setPrivacyShieldMode(mode) {
  try {
    const res = await fetchJson("/privacy/settings", {
      method: "PATCH",
      body: { shieldMode: mode }
    });
    if (res?.protection) {
      state.privacyStatus = res.protection;
      renderPrivacyProtectionPanel();
    }
    setPrivacyFeedback("Escudo atualizado.");
  } catch (error) {
    setPrivacyFeedback(
      error instanceof Error ? error.message : "Erro ao alterar configuração.",
      6000
    );
  }
}

export async function setVaultMode(mode) {
  const setupBox = $("#privacy-master-setup-box");

  if (mode === "master_password") {
    if (setupBox) {
      setupBox.hidden = false;
      $("#privacy-master-pass-1")?.focus();
    }
    setPrivacyFeedback("", 0);
    return;
  }

  if (setupBox) setupBox.hidden = true;
  setPrivacyFeedback("Atualizando proteção...", 0);
  for (const btn of $$("#privacy-vault-mode-toggle .mode-seg-btn")) {
    btn.disabled = true;
  }
  try {
    const res = await fetchJson("/privacy/settings", {
      method: "PATCH",
      body: { vaultMode: mode }
    });
    if (res?.protection) {
      state.privacyStatus = res.protection;
    }
    setPrivacyFeedback("Proteção atualizada.");
  } catch (error) {
    setPrivacyFeedback(
      error instanceof Error
        ? error.message
        : "Falha ao atualizar proteção.",
      6000
    );
  } finally {
    renderPrivacyProtectionPanel();
  }
}

export async function handleSetupMasterPassword() {
  const pass1 = $("#privacy-master-pass-1");
  const pass2 = $("#privacy-master-pass-2");
  const autoLockEl = $("#privacy-autolock-select");
  const saveBtn = $("#privacy-master-save-btn");
  const setupBox = $("#privacy-master-setup-box");
  const recBox = $("#privacy-recovery-box");
  const recCode = $("#privacy-recovery-code");

  const p1 = (pass1?.value || "").trim();
  const p2 = (pass2?.value || "").trim();
  if (p1.length < 10) {
    setPrivacyFeedback("A Senha Mestra precisa ter pelo menos 10 caracteres.", 5000);
    pass1?.focus();
    return;
  }
  if (p1 !== p2) {
    setPrivacyFeedback("As duas senhas não conferem.", 5000);
    pass2?.focus();
    return;
  }

  if (saveBtn) saveBtn.disabled = true;
  setPrivacyFeedback("Configurando cofre...", 0);

  try {
    const autoLockMinutes = Number(autoLockEl?.value ?? 30);
    const res = await fetchJson("/privacy/vault/setup-master", {
      method: "POST",
      body: { masterPassword: p1, autoLockMinutes }
    });
    if (pass1) pass1.value = "";
    if (pass2) pass2.value = "";
    if (setupBox) setupBox.hidden = true;
    if (res?.protection) {
      state.privacyStatus = res.protection;
    }
    if (res?.recoveryKey && recBox && recCode) {
      recCode.textContent = res.recoveryKey;
      recBox.hidden = false;
    }
    setPrivacyFeedback("Cofre ativado. Guarde sua Chave de Recuperação.", 8000);
  } catch (error) {
    setPrivacyFeedback(
      error instanceof Error ? error.message : "Erro ao ativar Senha Mestra.",
      6000
    );
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    renderPrivacyProtectionPanel();
  }
}

export async function setVaultAutoLock(minutes) {
  try {
    const res = await fetchJson("/privacy/settings", {
      method: "PATCH",
      body: { vaultAutoLockMinutes: Number(minutes) }
    });
    if (res?.protection) {
      state.privacyStatus = res.protection;
      renderPrivacyProtectionPanel();
    }
    setPrivacyFeedback("Auto-bloqueio atualizado.");
  } catch (error) {
    setPrivacyFeedback(
      error instanceof Error ? error.message : "Erro ao ajustar auto-bloqueio.",
      6000
    );
  }
}

export async function handleLockVaultNow() {
  disconnectEventStream();
  try {
    const res = await fetchJson("/privacy/vault/lock", { method: "POST" });
    if (res?.protection) {
      state.privacyStatus = res.protection;
      renderPrivacyProtectionPanel();
    }
  } catch {
    // Ignora
  }
  showVaultLockOverlay({
    isLocal: state.privacyIsLocal !== false,
    message: "Cofre trancado."
  });
}

export async function setSealApiKeysInVault(seal) {
  for (const btn of $$("#privacy-seal-keys-toggle .mode-seg-btn")) {
    btn.disabled = true;
  }
  setPrivacyFeedback("Atualizando armazenamento...", 0);
  try {
    const res = await fetchJson("/privacy/vault/seal-keys", {
      method: "POST",
      body: { seal: Boolean(seal) }
    });
    if (res?.protection) {
      state.privacyStatus = res.protection;
    }
    setPrivacyFeedback(
      seal ? "Chaves movidas para o cofre." : "Armazenamento padrão restaurado."
    );
    void refreshDashboard();
  } catch (error) {
    setPrivacyFeedback(
      error instanceof Error
        ? error.message
        : "Falha ao atualizar armazenamento das chaves.",
      6000
    );
  } finally {
    renderPrivacyProtectionPanel();
  }
}

export async function handleUnlockVaultSubmit(event) {
  event.preventDefault();
  const input = $("#vault-unlock-input");
  const errEl = $("#vault-lock-error");
  const submitBtn = $("#vault-unlock-submit-btn");
  const secret = (input?.value || "").trim();
  const isRecovery = Boolean(input?.getAttribute("data-recovery-mode") === "true");

  if (!secret) {
    if (errEl) errEl.textContent = "Digite sua Senha Mestra ou Chave de Recuperação.";
    input?.focus();
    return;
  }

  if (submitBtn) submitBtn.disabled = true;
  if (errEl) errEl.textContent = "Verificando...";

  try {
    const res = await fetchJson("/privacy/vault/unlock", {
      method: "POST",
      body: { secret, isRecovery }
    });
    if (res?.protection) {
      state.privacyStatus = res.protection;
      renderPrivacyProtectionPanel();
    }
    hideVaultLockOverlay();
    await Promise.all([loadProjects(), loadUserMemory(), refreshDashboard()]);
  } catch (error) {
    if (errEl) {
      errEl.textContent =
        error instanceof Error ? error.message : "Senha Mestra incorreta.";
    }
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
}

export async function handleReapplyNtfs() {
  const btn = $("#privacy-ntfs-harden-btn");
  if (btn) btn.disabled = true;
  setPrivacyFeedback("Aplicando permissões...", 0);
  try {
    const res = await fetchJson("/privacy/ntfs-harden", { method: "POST" });
    if (res?.protection) {
      state.privacyStatus = res.protection;
    }
    setPrivacyFeedback(
      res?.applied
        ? "Permissões reaplicadas."
        : res?.error || "Não aplicável neste ambiente."
    );
  } catch (error) {
    setPrivacyFeedback(
      error instanceof Error ? error.message : "Erro ao aplicar permissões.",
      6000
    );
  } finally {
    renderPrivacyProtectionPanel();
  }
}

// ============================================================================
// EDITOR DE TARJA MANUAL EM IMAGENS (<canvas>)
// ============================================================================

let redactEditorState = null;

export function closeImageRedactModal() {
  const modal = $("#image-redact-modal");
  if (modal) modal.hidden = true;
  redactEditorState = null;
}

export async function openImageRedactModal(attachment, onApplied) {
  const modal = $("#image-redact-modal");
  const canvas = $("#image-redact-canvas");
  if (!modal || !canvas || !attachment?.dataBase64) return;

  const mime = attachment.mimeType || "image/png";
  const dataUrl = `data:${mime};base64,${attachment.dataBase64}`;
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error("Não foi possível abrir a imagem."));
    el.src = dataUrl;
  });

  const width = img.naturalWidth || img.width || 1;
  const height = img.naturalHeight || img.height || 1;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  const boxes = [];
  let dragging = null;

  const repaint = () => {
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    ctx.fillStyle = "#080808";
    for (const b of boxes) {
      ctx.fillRect(b.x, b.y, b.w, b.h);
    }
    if (dragging) {
      const rx = Math.min(dragging.x0, dragging.x1);
      const ry = Math.min(dragging.y0, dragging.y1);
      const rw = Math.abs(dragging.x1 - dragging.x0);
      const rh = Math.abs(dragging.y1 - dragging.y0);
      ctx.fillStyle = "#080808";
      ctx.fillRect(rx, ry, rw, rh);
      ctx.strokeStyle = "#ffa3c2";
      ctx.lineWidth = Math.max(2, Math.round(width / 350));
      ctx.strokeRect(rx, ry, rw, rh);
    }
  };

  const toCanvasPoint = (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = width / Math.max(1, rect.width);
    const scaleY = height / Math.max(1, rect.height);
    return {
      x: Math.max(0, Math.min(width, (e.clientX - rect.left) * scaleX)),
      y: Math.max(0, Math.min(height, (e.clientY - rect.top) * scaleY))
    };
  };

  canvas.onpointerdown = (e) => {
    e.preventDefault();
    canvas.setPointerCapture?.(e.pointerId);
    const pt = toCanvasPoint(e);
    dragging = { x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y };
    repaint();
  };

  canvas.onpointermove = (e) => {
    if (!dragging) return;
    const pt = toCanvasPoint(e);
    dragging.x1 = pt.x;
    dragging.y1 = pt.y;
    repaint();
  };

  const commitDrag = () => {
    if (!dragging) return;
    const rx = Math.min(dragging.x0, dragging.x1);
    const ry = Math.min(dragging.y0, dragging.y1);
    const rw = Math.abs(dragging.x1 - dragging.x0);
    const rh = Math.abs(dragging.y1 - dragging.y0);
    dragging = null;
    if (rw >= 6 && rh >= 6) {
      boxes.push({ x: rx, y: ry, w: rw, h: rh });
    }
    repaint();
  };

  canvas.onpointerup = commitDrag;
  canvas.onpointercancel = commitDrag;

  const undoBtn = $("#image-redact-undo-btn");
  const clearBtn = $("#image-redact-clear-btn");
  const cancelBtn = $("#image-redact-cancel-btn");
  const closeBtn = $("#image-redact-close");
  const applyBtn = $("#image-redact-apply-btn");

  if (undoBtn) {
    undoBtn.onclick = () => {
      boxes.pop();
      repaint();
    };
  }
  if (clearBtn) {
    clearBtn.onclick = () => {
      boxes.length = 0;
      repaint();
    };
  }
  if (cancelBtn) cancelBtn.onclick = closeImageRedactModal;
  if (closeBtn) closeBtn.onclick = closeImageRedactModal;
  modal.onclick = (e) => {
    if (e.target === modal) closeImageRedactModal();
  };
  if (applyBtn) {
    applyBtn.onclick = () => {
      repaint();
      const outMime = mime === "image/png" ? "image/png" : "image/jpeg";
      const outUrl = canvas.toDataURL(outMime, 0.9);
      const nextB64 = outUrl.split(",")[1] || attachment.dataBase64;
      const updated = {
        ...attachment,
        mimeType: outMime,
        dataBase64: nextB64,
        size: Math.floor((nextB64.length * 3) / 4)
      };
      closeImageRedactModal();
      if (typeof onApplied === "function") onApplied(updated);
    };
  }

  redactEditorState = { boxes };
  repaint();
  modal.hidden = false;
}
