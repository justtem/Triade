import { $, state, uiHooks } from "./state.js";
import { fetchJson } from "./api.js";

const BRIEFING_BASE_DIR_KEY = "ai-council-briefing-base-dir";

const BRIEFING_NEG_GUARD_RE =
  /\b(nao\s+(?:mexa|altere|modifique|escreva|crie|grave|mude|aplique|edite|faca\s+nada)|so\s+(?:explique|compare|analise|mostre|responda|converse|planeje|diga|ideias?)|apenas\s+(?:explique|compare|analise|mostre|responda|planeje|diga|ideias?)|somente\s+(?:explique|leitura|compare|analise)|antes\s+de\s+(?:implementar|alterar|mexer|codar|escrever)|sem\s+(?:modificar|alterar|criar\s+arquivos|escrever\s+na\s+pasta|mexer\s+no\s+codigo))\b/;

const BRIEFING_EXPLAIN_START_RE =
  /^(?:me\s+)?(explique|explica|o\s+que\s+e|o\s+que\s+faz|como\s+funciona|por\s+que|porque|qual\s+(?:e\s+)?a\s+diferenca|compare|vale\s+a\s+pena|analise|resuma|me\s+diga|me\s+fale|liste|descreva|quais\s+sao)\b/;

const BRIEFING_VERB_RE =
  /\b(crie|cria|criar|faca|faz|fazer|monte|monta|montar|construa|constroi|construir|desenvolva|desenvolve|desenvolver|gere|gera|gerar|quero\s+(?:criar|fazer|montar|construir|um|uma)|preciso\s+de\s+(?:um|uma)|vamos\s+(?:criar|fazer|montar|construir))\b/;

const BRIEFING_TARGET_RE =
  /\b(app|aplicativo|aplicacao|site|web\s*app|webapp|sistema|painel|dashboard|pagina|landing\s*page|landing|portal|loja|ecommerce|e-commerce|calculadora|rastreador|gerenciador|controlador|controle\s+de|contador\s+de|agenda|agendamento|kanban|pomodoro|crm|pdv|estoque|catalogo|blog|portfolio|portifolio|api|backend|crud|ferramenta|plataforma|saas|projeto)\b/;

export function looksLikeNewAppIdeaClient(rawText) {
  const norm = String(rawText || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!norm || norm.length < 8) return false;
  if (BRIEFING_NEG_GUARD_RE.test(norm)) return false;
  if (BRIEFING_EXPLAIN_START_RE.test(norm)) return false;
  return BRIEFING_VERB_RE.test(norm) && BRIEFING_TARGET_RE.test(norm);
}

function getStoredBaseDir() {
  try {
    return localStorage.getItem(BRIEFING_BASE_DIR_KEY) || "";
  } catch {
    return "";
  }
}

function saveStoredBaseDir(dir) {
  try {
    if (dir) localStorage.setItem(BRIEFING_BASE_DIR_KEY, dir);
  } catch {
    // Ignora
  }
}

function joinDisplayPath(baseDir, folderName) {
  const cleanBase = String(baseDir || "").replace(/[\\/]+$/, "");
  const cleanName = String(folderName || "").trim() || "MeuApp";
  const sep = cleanBase.includes("\\") ? "\\" : "/";
  return cleanBase ? `${cleanBase}${sep}${cleanName}` : cleanName;
}

export function closeAppBriefingCard() {
  const card = $("#composer-briefing-card");
  if (!card) return;
  card.hidden = true;
  card.replaceChildren();
}

export async function openAppBriefingForPrompt(
  rawPrompt,
  { onBuildReady, onSendPlainChat }
) {
  const card = $("#composer-briefing-card");
  if (!card) {
    onSendPlainChat?.();
    return;
  }

  let analysis;
  try {
    const res = await fetchJson("/projects/briefing/analyze", {
      method: "POST",
      body: {
        prompt: rawPrompt,
        baseDir: getStoredBaseDir() || undefined
      }
    });
    analysis = res?.analysis;
  } catch {
    onSendPlainChat?.();
    return;
  }

  if (!analysis || !analysis.isNewAppIdea) {
    onSendPlainChat?.();
    return;
  }

  const draft = {
    rawPrompt,
    appName: analysis.suggestedName || "MeuApp",
    baseDir: analysis.baseDir || "",
    appKind: analysis.appKind || "web_app",
    theme: analysis.theme || "dark",
    financial: Boolean(analysis.security?.financial),
    lgpd: Boolean(analysis.security?.lgpd),
    suppressedAsGame: Boolean(analysis.security?.suppressedAsGame),
    financialMatches: Array.isArray(analysis.security?.financialMatches)
      ? analysis.security.financialMatches
      : [],
    lgpdMatches: Array.isArray(analysis.security?.lgpdMatches)
      ? analysis.security.lgpdMatches
      : []
  };

  card.hidden = false;
  card.replaceChildren();

  // Header
  const header = document.createElement("div");
  header.className = "briefing-card-header";

  const titleGroup = document.createElement("div");
  titleGroup.className = "briefing-title-group";
  const eyebrow = document.createElement("span");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "BRIEFING RÁPIDO // NOVO APP NA PASTA";
  const subtitle = document.createElement("span");
  subtitle.className = "briefing-subtitle";
  subtitle.textContent = "Confirme em 1 clique — eu crio a pasta, expando a arquitetura e construo tudo.";
  titleGroup.append(eyebrow, subtitle);

  const headActions = document.createElement("div");
  headActions.className = "briefing-head-actions";

  const plainBtn = document.createElement("button");
  plainBtn.type = "button";
  plainBtn.className = "btn-ghost-pill briefing-plain-btn";
  plainBtn.textContent = "Só conversar (sem pasta)";
  plainBtn.addEventListener("click", () => {
    closeAppBriefingCard();
    onSendPlainChat?.();
  });

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "icon-btn";
  closeBtn.setAttribute("aria-label", "Fechar briefing");
  closeBtn.textContent = "×";
  closeBtn.addEventListener("click", () => {
    closeAppBriefingCard();
    $("#debate-topic")?.focus();
  });

  headActions.append(plainBtn, closeBtn);
  header.append(titleGroup, headActions);

  // Linha 1: Nome do App + Pasta destino + Trocar pasta
  const folderRow = document.createElement("div");
  folderRow.className = "briefing-folder-row";

  const nameField = document.createElement("div");
  nameField.className = "briefing-field briefing-name-field";
  const nameLabel = document.createElement("label");
  nameLabel.setAttribute("for", "briefing-app-name");
  nameLabel.textContent = "Nome do projeto / subpasta";
  const nameInput = document.createElement("input");
  nameInput.type = "text";
  nameInput.id = "briefing-app-name";
  nameInput.value = draft.appName;
  nameInput.maxLength = 64;
  nameInput.placeholder = "Ex.: FinPulse";
  nameField.append(nameLabel, nameInput);

  const pathField = document.createElement("div");
  pathField.className = "briefing-field briefing-path-field";
  const pathLabel = document.createElement("span");
  pathLabel.className = "briefing-field-label";
  pathLabel.textContent = "Pasta que será criada";
  const pathBox = document.createElement("div");
  pathBox.className = "briefing-path-box";
  const pathCode = document.createElement("code");
  pathCode.className = "briefing-path-code";
  pathCode.textContent = joinDisplayPath(draft.baseDir, draft.appName);

  const pickBtn = document.createElement("button");
  pickBtn.type = "button";
  pickBtn.className = "btn-secondary briefing-pick-btn";
  pickBtn.textContent = "Trocar pasta...";
  pathBox.append(pathCode, pickBtn);
  pathField.append(pathLabel, pathBox);

  nameInput.addEventListener("input", () => {
    draft.appName = nameInput.value.trim();
    pathCode.textContent = joinDisplayPath(draft.baseDir, draft.appName);
  });

  pickBtn.addEventListener("click", async () => {
    pickBtn.disabled = true;
    pickBtn.textContent = "Abrindo...";
    try {
      const picked = await fetchJson("/projects/pick-folder", {
        method: "POST",
        timeoutMs: 125000,
        body: { initialPath: draft.baseDir || undefined }
      });
      if (!picked?.cancelled && picked?.path) {
        draft.baseDir = picked.path;
        saveStoredBaseDir(picked.path);
        pathCode.textContent = joinDisplayPath(draft.baseDir, draft.appName);
      }
    } catch (err) {
      feedbackEl.textContent =
        err instanceof Error ? err.message : "Não foi possível abrir o seletor de pastas.";
    } finally {
      pickBtn.disabled = false;
      pickBtn.textContent = "Trocar pasta...";
    }
  });

  folderRow.append(nameField, pathField);

  // Linha 2: Tipo de Projeto + Visual
  const optionsRow = document.createElement("div");
  optionsRow.className = "briefing-options-row";

  const makeChipGroup = (labelText, items, currentValue, onSelect) => {
    const group = document.createElement("div");
    group.className = "briefing-chip-group";
    const lbl = document.createElement("span");
    lbl.className = "briefing-field-label";
    lbl.textContent = labelText;
    const chipsWrap = document.createElement("div");
    chipsWrap.className = "briefing-chips";

    const buttons = [];
    for (const item of items) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `briefing-chip${item.value === currentValue ? " is-active" : ""}`;
      btn.textContent = item.label;
      btn.setAttribute("aria-pressed", String(item.value === currentValue));
      btn.addEventListener("click", () => {
        for (const other of buttons) {
          const isMatch = other === btn;
          other.classList.toggle("is-active", isMatch);
          other.setAttribute("aria-pressed", String(isMatch));
        }
        onSelect(item.value);
      });
      buttons.push(btn);
      chipsWrap.appendChild(btn);
    }

    group.append(lbl, chipsWrap);
    return group;
  };

  optionsRow.append(
    makeChipGroup(
      "Tipo",
      [
        { value: "web_app", label: "App Web (navegador)" },
        { value: "api", label: "API Backend" },
        { value: "landing", label: "Landing Page" }
      ],
      draft.appKind,
      (val) => {
        draft.appKind = val;
      }
    ),
    makeChipGroup(
      "Visual",
      [
        { value: "dark", label: "Escuro moderno" },
        { value: "light", label: "Claro minimalista" }
      ],
      draft.theme,
      (val) => {
        draft.theme = val;
      }
    )
  );

  // Linha 3: Boas práticas de Segurança & Privacidade (OWASP / Financeiro / LGPD)
  const securitySection = document.createElement("div");
  securitySection.className = "briefing-security-section";

  const secTop = document.createElement("div");
  secTop.className = "briefing-security-top";
  const secLabel = document.createElement("span");
  secLabel.className = "briefing-field-label";
  secLabel.textContent = "Boas práticas automáticas (Security & Privacy by Design)";
  const secHint = document.createElement("span");
  secHint.className = "briefing-security-hint";
  secTop.append(secLabel, secHint);

  const secChips = document.createElement("div");
  secChips.className = "briefing-chips";

  const owaspPill = document.createElement("span");
  owaspPill.className = "briefing-sec-pill is-locked";
  owaspPill.title = "Sempre ativo: validação 400, anti-XSS, anti-path-traversal, headers seguros e bind 127.0.0.1";
  owaspPill.textContent = "✓ Base OWASP";

  const finBtn = document.createElement("button");
  finBtn.type = "button";
  finBtn.className = `briefing-sec-pill is-financial${draft.financial ? " is-active" : ""}`;
  finBtn.setAttribute("aria-pressed", String(draft.financial));
  finBtn.title = "Centavos inteiros, validação de valor > 0, Idempotency-Key (409) e testes financeiros";

  const lgpdBtn = document.createElement("button");
  lgpdBtn.type = "button";
  lgpdBtn.className = `briefing-sec-pill is-lgpd${draft.lgpd ? " is-active" : ""}`;
  lgpdBtn.setAttribute("aria-pressed", String(draft.lgpd));
  lgpdBtn.title = "Minimização, mascaramento em logs, scrypt se houver login, Exportar JSON e Excluir registro";

  const secNote = document.createElement("p");
  secNote.className = "briefing-security-note";

  const syncSecurityUi = () => {
    finBtn.classList.toggle("is-active", draft.financial);
    finBtn.setAttribute("aria-pressed", String(draft.financial));
    finBtn.textContent = draft.financial ? "✓ Boas práticas: Financeiro" : "+ Financeiro";

    lgpdBtn.classList.toggle("is-active", draft.lgpd);
    lgpdBtn.setAttribute("aria-pressed", String(draft.lgpd));
    lgpdBtn.textContent = draft.lgpd
      ? "✓ Boas práticas: Privacidade (LGPD)"
      : "+ Privacidade (LGPD)";

    const reasons = [
      ...(draft.financial && draft.financialMatches.length > 0
        ? [`financeiro: ${draft.financialMatches.slice(0, 2).join(", ")}`]
        : []),
      ...(draft.lgpd && draft.lgpdMatches.length > 0
        ? [`dados pessoais: ${draft.lgpdMatches.slice(0, 2).join(", ")}`]
        : [])
    ];
    if (reasons.length > 0) {
      secHint.textContent = `Detectado (${reasons.join(" · ")})`;
    } else if (draft.suppressedAsGame && !draft.financial && !draft.lgpd) {
      secHint.textContent = "Contexto de jogo/simulação — perfis extras desativados";
    } else {
      secHint.textContent = "Clique para ativar se lidar com dinheiro ou dados de clientes";
    }

    if (draft.financial || draft.lgpd) {
      secNote.hidden = false;
      secNote.textContent =
        "Aplica proteções técnicas desde o protótipo local e gera checklist honesto no README (não substitui auditoria nem avaliação jurídica em produção).";
    } else {
      secNote.hidden = true;
    }
  };

  finBtn.addEventListener("click", () => {
    draft.financial = !draft.financial;
    syncSecurityUi();
  });
  lgpdBtn.addEventListener("click", () => {
    draft.lgpd = !draft.lgpd;
    syncSecurityUi();
  });

  syncSecurityUi();
  secChips.append(owaspPill, finBtn, lgpdBtn);
  securitySection.append(secTop, secChips, secNote);

  // Footer
  const footer = document.createElement("div");
  footer.className = "briefing-card-footer";
  const feedbackEl = document.createElement("span");
  feedbackEl.className = "form-feedback";
  feedbackEl.setAttribute("role", "status");

  const confirmBtn = document.createElement("button");
  confirmBtn.type = "button";
  confirmBtn.className = "btn-primary briefing-confirm-btn";
  confirmBtn.innerHTML = `<span>Construir Projeto Agora</span><span class="cta-arrow" aria-hidden="true">→</span>`;

  confirmBtn.addEventListener("click", async () => {
    const cleanName = nameInput.value.trim();
    if (!cleanName) {
      feedbackEl.textContent = "Informe um nome para o projeto.";
      nameInput.focus();
      return;
    }

    confirmBtn.disabled = true;
    plainBtn.disabled = true;
    pickBtn.disabled = true;
    feedbackEl.textContent = "Criando pasta e preparando especificação técnica...";

    try {
      const prepared = await fetchJson("/projects/briefing/prepare", {
        method: "POST",
        body: {
          prompt: draft.rawPrompt,
          appName: cleanName,
          baseDir: draft.baseDir,
          appKind: draft.appKind,
          theme: draft.theme,
          security: {
            financial: draft.financial,
            lgpd: draft.lgpd
          }
        }
      });

      if (Array.isArray(prepared?.projects)) {
        state.userProjects = prepared.projects;
      }
      if (prepared?.project?.id) {
        state.activeNewChatProjectId = prepared.project.id;
        state.selectedProjectFilterId = prepared.project.id;
      }
      if (draft.baseDir) {
        saveStoredBaseDir(draft.baseDir);
      }

      uiHooks.renderProjectsSidebar();
      uiHooks.syncComposerProjectPill();
      closeAppBriefingCard();

      onBuildReady?.({
        project: prepared.project,
        expandedPrompt: prepared.expandedPrompt,
        title: prepared.project?.name || cleanName
      });
    } catch (err) {
      feedbackEl.textContent =
        err instanceof Error ? err.message : "Não foi possível preparar o projeto.";
      confirmBtn.disabled = false;
      plainBtn.disabled = false;
      pickBtn.disabled = false;
    }
  });

  footer.append(feedbackEl, confirmBtn);
  card.append(header, folderRow, optionsRow, securitySection, footer);
  nameInput.focus();
  nameInput.select();
}
