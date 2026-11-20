import { $, state } from "./state.js";
import { fetchJson, refreshDashboard } from "./api.js";

const SETUP_PROVIDERS = ["gemini", "groq", "openrouter"];

function applyProviderBadge(plat, text, variant) {
  const el = $(`#setup-status-${plat}`);
  if (!el) return;
  el.textContent = text;
  el.classList.remove("is-ok", "is-err", "is-pending");
  if (variant) el.classList.add(variant);
}

function applyFieldMessage(plat, text, isError = false) {
  const el = $(`#setup-msg-${plat}`);
  if (!el) return;
  el.textContent = text || "";
  el.classList.toggle("is-error", Boolean(isError && text));
  el.classList.toggle("is-ok", Boolean(!isError && text));
}

function applySetupStatusToModal(statusData) {
  const providers = statusData?.providers || {};
  const isComplete = Boolean(statusData?.setupComplete);

  const eyebrow = $("#setup-wizard-eyebrow");
  const desc = $("#setup-wizard-desc");
  if (eyebrow) {
    eyebrow.textContent = isComplete
      ? "CHAVES & ACESSO // CONFIGURAÇÃO LOCAL"
      : "CONFIGURAÇÃO INICIAL // CUSTO ZERO";
  }
  if (desc) {
    desc.innerHTML = isComplete
      ? "Atualize qualquer chave abaixo ou defina uma nova senha remota. Campos deixados em branco mantêm a chave atual salva no <code>.env</code>."
      : "Cole suas 3 chaves gratuitas para ativar o conselho completo (Gemini, Groq e OpenRouter). Tudo é salvo apenas no arquivo <code>.env</code> deste PC.";
  }

  for (const plat of SETUP_PROVIDERS) {
    const info = providers[plat] || {};
    const input = $(`#setup-key-${plat}`);
    if (info.configured) {
      applyProviderBadge(
        plat,
        info.maskedKey ? `Configurada ${info.maskedKey}` : "Configurada",
        "is-ok"
      );
      if (input) {
        input.placeholder = "Deixe em branco para manter a chave atual";
      }
    } else {
      applyProviderBadge(plat, "Pendente", "is-pending");
      if (input) {
        input.placeholder =
          plat === "gemini"
            ? "Cole sua GEMINI_API_KEY (AIza...)"
            : plat === "groq"
              ? "Cole sua GROQ_API_KEY (gsk_...)"
              : "Cole sua OPENROUTER_API_KEY (sk-or-...)";
      }
    }
    applyFieldMessage(plat, "", false);
  }

  const passStatus = $("#setup-status-password");
  if (passStatus) {
    const isWeak = Boolean(statusData?.accessPassword?.isWeakDefault);
    passStatus.textContent = isWeak ? "Padrão fraco (recomendado trocar)" : "Configurada";
    passStatus.classList.remove("is-ok", "is-err", "is-pending");
    passStatus.classList.add(isWeak ? "is-pending" : "is-ok");
  }
}

export async function openSetupWizard(options = {}) {
  const overlay = $("#setup-wizard-overlay");
  if (!overlay) return;

  const locked = Boolean(options.locked);
  state.isSetupWizardLocked = locked;

  const closeBtn = $("#setup-wizard-close");
  const cancelBtn = $("#setup-cancel-btn");
  if (closeBtn) closeBtn.hidden = locked;
  if (cancelBtn) cancelBtn.hidden = locked;

  const feedback = $("#setup-wizard-feedback");
  if (feedback) feedback.textContent = "";

  for (const plat of SETUP_PROVIDERS) {
    const input = $(`#setup-key-${plat}`);
    if (input) input.value = "";
    applyFieldMessage(plat, "", false);
  }
  const passInput = $("#setup-access-password");
  if (passInput) passInput.value = "";

  overlay.hidden = false;

  try {
    const data = await fetchJson("/setup/status");
    state.setupStatus = data;
    applySetupStatusToModal(data);
    if (!data?.setupComplete) {
      state.isSetupWizardLocked = true;
      if (closeBtn) closeBtn.hidden = true;
      if (cancelBtn) cancelBtn.hidden = true;
    }
  } catch (error) {
    if (feedback) {
      feedback.textContent =
        error instanceof Error
          ? error.message
          : "Configuração disponível somente no PC local.";
    }
  }
}

export function closeSetupWizard() {
  if (state.isSetupWizardLocked) return;
  const overlay = $("#setup-wizard-overlay");
  if (overlay) overlay.hidden = true;
}

export function syncSetupUi(setupSummary) {
  if (!setupSummary || typeof setupSummary !== "object") return;
  const isLocal = Boolean(setupSummary.isLocal);
  const isComplete = Boolean(setupSummary.complete);

  const openBtn = $("#open-setup-wizard-btn");
  if (openBtn) {
    openBtn.hidden = !isLocal;
  }

  const wipeToggleBtn = $("#privacy-wipe-toggle-btn");
  if (wipeToggleBtn) {
    wipeToggleBtn.hidden = !isLocal;
  }
  const wipeBox = $("#privacy-wipe-confirm-box");
  if (!isLocal && wipeBox) {
    wipeBox.hidden = true;
  }

  const overlay = $("#setup-wizard-overlay");
  if (!isComplete && isLocal && overlay && overlay.hidden) {
    void openSetupWizard({ locked: true });
  }
}

export async function handleSaveSetupForm(event) {
  event.preventDefault();

  const saveBtn = $("#setup-save-btn");
  const saveLabel = saveBtn?.querySelector("span:first-child");
  const feedback = $("#setup-wizard-feedback");

  const payload = {
    geminiApiKey: $("#setup-key-gemini")?.value?.trim() || "",
    groqApiKey: $("#setup-key-groq")?.value?.trim() || "",
    openrouterApiKey: $("#setup-key-openrouter")?.value?.trim() || "",
    accessPassword: $("#setup-access-password")?.value?.trim() || ""
  };

  for (const plat of SETUP_PROVIDERS) {
    applyFieldMessage(plat, "", false);
  }

  if (saveBtn) saveBtn.disabled = true;
  if (saveLabel) saveLabel.textContent = "Testando chaves...";
  if (feedback) feedback.textContent = "Validando conexões (0 tokens gastos)...";

  try {
    const response = await fetch("/setup/save", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify(payload)
    });

    const data = await response.json().catch(() => ({}));

    if (data?.validation && typeof data.validation === "object") {
      for (const plat of SETUP_PROVIDERS) {
        const res = data.validation[plat];
        if (!res) continue;
        if (res.ok) {
          applyProviderBadge(plat, "Validada", "is-ok");
          applyFieldMessage(plat, "Conexão OK", false);
        } else {
          applyProviderBadge(plat, "Inválida", "is-err");
          applyFieldMessage(plat, res.error || "Chave inválida.", true);
        }
      }
    }

    if (!response.ok) {
      if (feedback) {
        feedback.textContent =
          data?.error || "Verifique as chaves destacadas e tente novamente.";
      }
      return;
    }

    state.setupStatus = data;
    state.isSetupWizardLocked = false;
    applySetupStatusToModal(data);

    if (feedback) {
      feedback.textContent = "Chaves salvas e ativadas!";
    }

    const overlay = $("#setup-wizard-overlay");
    if (overlay) {
      setTimeout(() => {
        overlay.hidden = true;
      }, 450);
    }

    void refreshDashboard();
  } catch (error) {
    if (feedback) {
      feedback.textContent =
        error instanceof Error ? error.message : "Erro ao salvar configuração.";
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
    if (saveLabel) saveLabel.textContent = "Testar e Salvar";
  }
}
