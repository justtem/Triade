import {
  SVG_ICONS,
  $,
  $$,
  state,
  debateDetailsById,
  getActiveOrSelectedDebate,
  upsertDebateSessionLocally,
  uiHooks
} from "./state.js";
import { fetchJson, loadProjects, refreshDashboard } from "./api.js";
import { escapeHtml } from "./markdown.js";

const PROJECT_COLOR_HEX = {
  iris: "#9985ff",
  sky: "#94dbff",
  saffron: "#d6ca6f",
  rose: "#ffa3c2",
  emerald: "#e3e3e3"
};

export function getProjectColorHex(colorKey) {
  return PROJECT_COLOR_HEX[colorKey] || PROJECT_COLOR_HEX.iris;
}

export function getProjectByIdClient(projectId) {
  if (!projectId) return null;
  const list = Array.isArray(state.userProjects) ? state.userProjects : [];
  return list.find((p) => p.id === projectId) || null;
}

export function getEffectiveProjectForComposer() {
  const activeDebate = getActiveOrSelectedDebate();
  if (activeDebate) {
    return activeDebate.projectId ? getProjectByIdClient(activeDebate.projectId) : null;
  }
  const targetId = state.activeNewChatProjectId || state.selectedProjectFilterId;
  return targetId ? getProjectByIdClient(targetId) : null;
}

function formatShortChars(count) {
  const num = Number(count) || 0;
  if (num >= 1000) return `${(num / 1000).toFixed(1)}k chars`;
  return `${num} chars`;
}

function readFileAsBase64(file) {
  return new Promise((resolvePromise, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || "");
      const idx = result.indexOf("base64,");
      resolvePromise(idx >= 0 ? result.slice(idx + 7) : result);
    };
    reader.onerror = () => reject(new Error(`Falha ao ler ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

export function selectProjectFilter(projectId) {
  const nextId = projectId || null;
  state.selectedProjectFilterId = nextId;

  // Se não há conversa aberta (Nova Conversa), o projeto clicado já vira o projeto da próxima conversa
  if (!state.selectedDebateId) {
    state.activeNewChatProjectId = nextId;
  }

  renderProjectsSidebar();
  uiHooks.renderSidebarDebatesList();
  syncComposerProjectPill();
  uiHooks.syncComposerModeUi();
}

export function renderProjectsSidebar() {
  const listEl = $("#sidebar-projects-list");
  const countEl = $("#sidebar-projects-count");
  if (!listEl) return;

  const projectsList = Array.isArray(state.userProjects) ? state.userProjects : [];
  if (countEl) {
    countEl.textContent = String(projectsList.length);
  }

  // Se o filtro apontar para um projeto que não existe mais, limpa o filtro
  if (
    state.selectedProjectFilterId &&
    !projectsList.some((p) => p.id === state.selectedProjectFilterId)
  ) {
    state.selectedProjectFilterId = null;
  }
  if (
    state.activeNewChatProjectId &&
    !projectsList.some((p) => p.id === state.activeNewChatProjectId)
  ) {
    state.activeNewChatProjectId = null;
  }

  listEl.replaceChildren();

  // Item fixo: "Todos os chats"
  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = `project-nav-item${!state.selectedProjectFilterId ? " active" : ""}`;
  allBtn.innerHTML = `
    <span class="project-nav-left">
      <span class="project-dot project-dot-all" aria-hidden="true"></span>
      <span class="project-nav-name">Todos os chats</span>
    </span>
    <span class="project-nav-count">${state.latestDebates.length}</span>
  `;
  allBtn.addEventListener("click", () => selectProjectFilter(null));
  listEl.appendChild(allBtn);

  if (projectsList.length === 0) {
    const hint = document.createElement("div");
    hint.className = "projects-empty-hint";
    hint.textContent = "Crie um projeto com regras fixas e arquivos locais.";
    listEl.appendChild(hint);
    return;
  }

  const chatCountByProject = new Map();
  for (const debate of state.latestDebates) {
    if (debate.projectId) {
      chatCountByProject.set(
        debate.projectId,
        (chatCountByProject.get(debate.projectId) || 0) + 1
      );
    }
  }

  for (const proj of projectsList) {
    const row = document.createElement("div");
    row.className = `project-nav-row${state.selectedProjectFilterId === proj.id ? " active" : ""}`;
    row.setAttribute("role", "listitem");

    const selectBtn = document.createElement("button");
    selectBtn.type = "button";
    selectBtn.className = "project-nav-main";
    selectBtn.title = proj.description || proj.name;

    const dot = document.createElement("span");
    dot.className = "project-dot";
    dot.style.background = getProjectColorHex(proj.color);
    dot.setAttribute("aria-hidden", "true");

    const nameSpan = document.createElement("span");
    nameSpan.className = "project-nav-name";
    nameSpan.textContent = proj.name;

    const chatCount = document.createElement("span");
    chatCount.className = "project-nav-count";
    chatCount.textContent = String(chatCountByProject.get(proj.id) || 0);

    selectBtn.append(dot, nameSpan, chatCount);
    selectBtn.addEventListener("click", () => selectProjectFilter(proj.id));

    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "project-nav-edit-btn";
    editBtn.title = `Configurar projeto ${proj.name}`;
    editBtn.setAttribute("aria-label", `Configurar projeto ${proj.name}`);
    editBtn.innerHTML = SVG_ICONS.pencil;
    editBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      openProjectModal(proj.id);
    });

    row.append(selectBtn, editBtn);
    listEl.appendChild(row);
  }
}

export function syncComposerProjectPill() {
  const bar = $("#composer-project-bar");
  if (!bar) return;

  const activeDebate = getActiveOrSelectedDebate();
  const project = getEffectiveProjectForComposer();

  if (!project) {
    bar.hidden = true;
    bar.replaceChildren();
    return;
  }

  bar.hidden = false;
  bar.replaceChildren();

  const pill = document.createElement("div");
  pill.className = "composer-project-pill";

  const dot = document.createElement("span");
  dot.className = "project-dot";
  dot.style.background = getProjectColorHex(project.color);

  const labelBtn = document.createElement("button");
  labelBtn.type = "button";
  labelBtn.className = "composer-project-pill-btn";
  labelBtn.title = "Abrir configurações e arquivos deste Projeto";

  const fileCount = Array.isArray(project.files) ? project.files.length : 0;
  const badges = [];
  if (project.instructions?.trim()) badges.push("regras");
  if (fileCount > 0) badges.push(`${fileCount} ${fileCount === 1 ? "arquivo" : "arquivos"}`);
  if (project.linkedFolderPath) badges.push("pasta PC");

  labelBtn.innerHTML = `
    <span class="composer-project-prefix">Projeto:</span>
    <strong>${escapeHtml(project.name)}</strong>
    ${badges.length > 0 ? `<span class="composer-project-meta">(${escapeHtml(badges.join(" + "))})</span>` : ""}
  `;
  labelBtn.addEventListener("click", () => openProjectModal(project.id));

  pill.append(dot, labelBtn);

  // Em Nova Conversa permite desvincular o projeto em 1 clique antes de enviar
  if (!activeDebate) {
    const clearBtn = document.createElement("button");
    clearBtn.type = "button";
    clearBtn.className = "composer-project-clear";
    clearBtn.title = "Criar conversa avulsa (sem projeto)";
    clearBtn.setAttribute("aria-label", "Desvincular projeto da nova conversa");
    clearBtn.textContent = "×";
    clearBtn.addEventListener("click", () => {
      state.activeNewChatProjectId = null;
      if (state.selectedProjectFilterId === project.id) {
        state.selectedProjectFilterId = null;
      }
      renderProjectsSidebar();
      uiHooks.renderSidebarDebatesList();
      syncComposerProjectPill();
    });
    pill.appendChild(clearBtn);
  }

  bar.appendChild(pill);
}

export async function handleAssignDebateProject(debateId, projectId) {
  if (!debateId) return;
  const nextId = projectId || null;

  try {
    let res;
    try {
      res = await fetchJson(`/debates/${debateId}/project`, {
        method: "POST",
        body: { projectId: nextId }
      });
    } catch {
      res = await fetchJson(`/debates/${debateId}`, {
        method: "PATCH",
        body: { projectId: nextId }
      });
    }

    if (res?.debate) {
      upsertDebateSessionLocally(res.debate);
    } else {
      const summary = state.latestDebates.find((d) => d.id === debateId);
      if (summary) summary.projectId = nextId || undefined;
      const detail = debateDetailsById.get(debateId);
      if (detail) detail.projectId = nextId || undefined;
    }

    state.lastDebatesSignature = "";
    renderProjectsSidebar();
    uiHooks.renderSidebarDebatesList();
    uiHooks.updateStageTopbar();
    syncComposerProjectPill();
    void refreshDashboard();
  } catch (error) {
    console.error("[AI Council] Erro ao mover conversa de projeto:", error);
  }
}

// ============================================================================
// MODAL DE CRIAÇÃO / EDIÇÃO DE PROJETO E CÉREBRO LOCAL
// ============================================================================

function renderProjectFilesList(project) {
  const listEl = $("#project-files-list");
  const uploadSection = $("#project-files-section");
  if (!listEl) return;

  listEl.replaceChildren();

  if (!project) {
    if (uploadSection) uploadSection.classList.add("is-new-project");
    const note = document.createElement("div");
    note.className = "project-files-empty";
    note.textContent = "Salve o projeto primeiro para enviar PDFs, documentos ou código.";
    listEl.appendChild(note);
    return;
  }

  if (uploadSection) uploadSection.classList.remove("is-new-project");
  const files = Array.isArray(project.files) ? project.files : [];

  if (files.length === 0) {
    const empty = document.createElement("div");
    empty.className = "project-files-empty";
    empty.textContent = "Nenhum arquivo enviado ainda. Envie PDFs, .md, .txt ou código do PC ou celular.";
    listEl.appendChild(empty);
    return;
  }

  for (const file of files) {
    const row = document.createElement("div");
    row.className = "project-file-row";

    const info = document.createElement("div");
    info.className = "project-file-info";

    const badge = document.createElement("span");
    badge.className = `project-file-badge${file.kind === "pdf" ? " is-pdf" : ""}`;
    badge.textContent = file.kind === "pdf" ? "PDF" : "TXT";

    const name = document.createElement("span");
    name.className = "project-file-name";
    name.textContent = file.name;

    const meta = document.createElement("span");
    meta.className = "project-file-meta";
    meta.textContent = formatShortChars(file.charCount);

    info.append(badge, name, meta);

    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "icon-btn project-file-del-btn";
    delBtn.title = `Remover ${file.name}`;
    delBtn.setAttribute("aria-label", `Remover ${file.name}`);
    delBtn.innerHTML = SVG_ICONS.trash;
    delBtn.addEventListener("click", () => {
      void handleRemoveProjectFile(project.id, file.id);
    });

    row.append(info, delBtn);
    listEl.appendChild(row);
  }
}

function isLocalPcBrowser() {
  const host = window.location?.hostname || "";
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function renderFolderInspectionFeedback(info) {
  const folderFb = $("#proj-folder-feedback");
  if (!folderFb) return;
  if (!info || !info.valid) {
    folderFb.className = "project-folder-feedback is-error";
    folderFb.textContent = info?.error || "Não foi possível ler a pasta.";
    return;
  }

  folderFb.className = "project-folder-feedback is-ok";
  const pdfNote = info.pdfFiles > 0 ? ` (${info.pdfFiles} PDF)` : "";
  const secNote =
    info.blockedSecrets > 0
      ? ` · ${info.blockedSecrets} sensível(is) bloqueado(s)`
      : " · trava ativa (.env/chaves/.git bloqueados)";
  folderFb.textContent = `OK: ${info.indexableFiles} arquivo(s) legível(is)${pdfNote}${secNote}.`;
}

function updateProjectMoreSummary(project) {
  const summaryEl = $("#project-more-summary");
  if (!summaryEl) return;
  const count = Array.isArray(project?.files) ? project.files.length : 0;
  summaryEl.textContent =
    count > 0
      ? `Mais opções (descrição, cor e ${count} ${count === 1 ? "arquivo avulso" : "arquivos avulsos"})`
      : "Mais opções (descrição, cor e arquivos avulsos)";
}

export function openProjectModal(projectId = null) {
  const modal = $("#project-modal");
  if (!modal) return;

  const project = projectId ? getProjectByIdClient(projectId) : null;
  state.editingProjectId = project ? project.id : null;

  const titleEl = $("#project-modal-title");
  const nameInput = $("#proj-name");
  const descInput = $("#proj-description");
  const instrInput = $("#proj-instructions");
  const folderInput = $("#proj-folder-path");
  const colorSelect = $("#proj-color");
  const deleteBtn = $("#proj-delete-btn");
  const saveBtnSpan = $("#proj-save-btn span");
  const fb = $("#project-modal-feedback");
  const folderFb = $("#proj-folder-feedback");
  const pickBtn = $("#proj-pick-folder-btn");
  const subfolderStrip = $("#proj-subfolder-strip");
  const subfolderBox = $("#proj-subfolder-box");
  const subfolderToggle = $("#proj-subfolder-toggle");
  const subfolderInput = $("#proj-subfolder-name");
  const moreDetails = $("#project-more-details");

  const localPc = isLocalPcBrowser();
  if (pickBtn) pickBtn.hidden = !localPc;
  if (subfolderStrip) subfolderStrip.hidden = !localPc;
  if (subfolderBox) subfolderBox.hidden = true;
  if (subfolderToggle) subfolderToggle.hidden = false;
  if (subfolderInput) subfolderInput.value = "";
  if (moreDetails) moreDetails.open = false;

  if (titleEl) {
    titleEl.textContent = project ? `Projeto: ${project.name}` : "Novo Projeto";
  }
  if (nameInput) nameInput.value = project?.name || "";
  if (descInput) descInput.value = project?.description || "";
  if (instrInput) instrInput.value = project?.instructions || "";
  if (folderInput) folderInput.value = project?.linkedFolderPath || "";
  if (colorSelect) colorSelect.value = project?.color || "iris";
  if (deleteBtn) deleteBtn.hidden = !project;
  if (saveBtnSpan) saveBtnSpan.textContent = project ? "Salvar Alterações" : "Criar Projeto";
  if (fb) fb.textContent = "";
  if (folderFb) {
    folderFb.textContent = "";
    folderFb.className = "project-folder-feedback";
  }

  for (const swatch of $$(".project-color-swatch")) {
    const c = swatch.getAttribute("data-proj-color");
    swatch.classList.toggle("is-selected", c === (project?.color || "iris"));
  }

  updateProjectMoreSummary(project);
  renderProjectFilesList(project);
  modal.hidden = false;
  nameInput?.focus();
}

export function closeProjectModal() {
  const modal = $("#project-modal");
  if (modal) modal.hidden = true;
  state.editingProjectId = null;
}

export async function handleSaveProjectForm(event) {
  event.preventDefault();

  const name = ($("#proj-name")?.value || "").trim();
  const description = ($("#proj-description")?.value || "").trim();
  const instructions = ($("#proj-instructions")?.value || "").trim();
  const linkedFolderPath = ($("#proj-folder-path")?.value || "").trim();
  const color = $("#proj-color")?.value || "iris";
  const fb = $("#project-modal-feedback");
  const saveBtn = $("#proj-save-btn");

  if (!name) {
    if (fb) fb.textContent = "Informe um nome para o projeto.";
    $("#proj-name")?.focus();
    return;
  }

  const payload = {
    name,
    description,
    instructions,
    linkedFolderPath,
    color
  };

  try {
    if (saveBtn) saveBtn.disabled = true;
    if (fb) fb.textContent = "Salvando...";

    const isEdit = Boolean(state.editingProjectId);
    let res;

    if (isEdit) {
      try {
        res = await fetchJson(`/projects/${state.editingProjectId}`, {
          method: "PATCH",
          body: payload
        });
      } catch {
        res = await fetchJson(`/projects/${state.editingProjectId}/update`, {
          method: "POST",
          body: payload
        });
      }
    } else {
      res = await fetchJson("/projects", {
        method: "POST",
        body: payload
      });
    }

    if (Array.isArray(res?.projects)) {
      state.userProjects = res.projects;
    } else {
      await loadProjects();
    }

    const savedProject = res?.project || getProjectByIdClient(state.editingProjectId);
    if (savedProject) {
      state.editingProjectId = savedProject.id;
      if (!isEdit) {
        state.selectedProjectFilterId = savedProject.id;
        if (!state.selectedDebateId) {
          state.activeNewChatProjectId = savedProject.id;
        }
      }
      renderProjectFilesList(savedProject);
      const titleEl = $("#project-modal-title");
      const deleteBtn = $("#proj-delete-btn");
      const saveBtnSpan = $("#proj-save-btn span");
      if (titleEl) titleEl.textContent = `Projeto: ${savedProject.name}`;
      if (deleteBtn) deleteBtn.hidden = false;
      if (saveBtnSpan) saveBtnSpan.textContent = "Salvar Alterações";
    }

    renderProjectsSidebar();
    uiHooks.renderSidebarDebatesList();
    uiHooks.updateStageTopbar();
    syncComposerProjectPill();
    uiHooks.syncComposerModeUi();
    updateProjectMoreSummary(savedProject);

    if (fb) {
      fb.textContent = isEdit
        ? "Projeto atualizado!"
        : "Projeto criado e ativado!";
    }
  } catch (error) {
    if (fb) {
      fb.textContent =
        error instanceof Error ? error.message : "Erro ao salvar projeto.";
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

export async function handlePickProjectFolder() {
  const folderInput = $("#proj-folder-path");
  const nameInput = $("#proj-name");
  const folderFb = $("#proj-folder-feedback");
  const pickBtn = $("#proj-pick-folder-btn");

  try {
    if (pickBtn) pickBtn.disabled = true;
    if (folderFb) {
      folderFb.className = "project-folder-feedback";
      folderFb.textContent = "Abrindo seletor de pastas do Windows...";
    }

    const res = await fetchJson("/projects/pick-folder", {
      method: "POST",
      timeoutMs: 125000,
      body: { initialPath: (folderInput?.value || "").trim() || undefined }
    });

    if (res?.cancelled || !res?.path) {
      if (folderFb) folderFb.textContent = "";
      return;
    }

    if (folderInput) folderInput.value = res.path;
    if (nameInput && !nameInput.value.trim()) {
      const folderLeaf = String(res.path).split(/[\\/]/).filter(Boolean).pop();
      if (folderLeaf) nameInput.value = folderLeaf;
    }

    if (res.inspection) {
      renderFolderInspectionFeedback(res.inspection);
    } else {
      await handleInspectProjectFolder();
    }
  } catch (error) {
    if (folderFb) {
      folderFb.className = "project-folder-feedback is-error";
      folderFb.textContent =
        error instanceof Error ? error.message : "Não foi possível abrir o seletor de pastas.";
    }
  } finally {
    if (pickBtn) pickBtn.disabled = false;
  }
}

export async function handleCreateProjectSubfolder() {
  const folderInput = $("#proj-folder-path");
  const nameInput = $("#proj-name");
  const subInput = $("#proj-subfolder-name");
  const subBox = $("#proj-subfolder-box");
  const subToggle = $("#proj-subfolder-toggle");
  const createBtn = $("#proj-subfolder-create-btn");
  const folderFb = $("#proj-folder-feedback");

  const parentPath = (folderInput?.value || "").trim();
  const folderName = (subInput?.value || "").trim();

  if (!parentPath) {
    if (folderFb) {
      folderFb.className = "project-folder-feedback is-error";
      folderFb.textContent = "Escolha primeiro a pasta base (onde a nova pasta será criada).";
    }
    return;
  }
  if (!folderName) {
    if (folderFb) {
      folderFb.className = "project-folder-feedback is-error";
      folderFb.textContent = "Digite o nome da nova pasta.";
    }
    subInput?.focus();
    return;
  }

  try {
    if (createBtn) createBtn.disabled = true;
    if (folderFb) {
      folderFb.className = "project-folder-feedback";
      folderFb.textContent = "Criando pasta e verificando...";
    }

    const res = await fetchJson("/projects/create-subfolder", {
      method: "POST",
      body: { parentPath, folderName }
    });

    if (res?.path && folderInput) {
      folderInput.value = res.path;
    }
    if (nameInput && !nameInput.value.trim()) {
      nameInput.value = folderName;
    }
    if (subInput) subInput.value = "";
    if (subBox) subBox.hidden = true;
    if (subToggle) subToggle.hidden = false;

    if (res?.inspection) {
      renderFolderInspectionFeedback(res.inspection);
      if (folderFb && res.created) {
        folderFb.textContent = `Pasta criada! ${folderFb.textContent}`;
      }
    }
  } catch (error) {
    if (folderFb) {
      folderFb.className = "project-folder-feedback is-error";
      folderFb.textContent =
        error instanceof Error ? error.message : "Erro ao criar subpasta.";
    }
  } finally {
    if (createBtn) createBtn.disabled = false;
  }
}

export async function handleInspectProjectFolder() {
  const folderPath = ($("#proj-folder-path")?.value || "").trim();
  const folderFb = $("#proj-folder-feedback");
  const testBtn = $("#proj-test-folder-btn");

  if (!folderFb) return;
  if (!folderPath) {
    folderFb.className = "project-folder-feedback is-error";
    folderFb.textContent = "Escolha uma pasta ou cole o caminho (ex.: C:\\Users\\...\\meu-projeto).";
    return;
  }

  try {
    if (testBtn) testBtn.disabled = true;
    folderFb.className = "project-folder-feedback";
    folderFb.textContent = "Verificando pasta...";

    const res = await fetchJson("/projects/inspect-folder", {
      method: "POST",
      body: { path: folderPath }
    });
    renderFolderInspectionFeedback(res?.inspection);
  } catch (error) {
    folderFb.className = "project-folder-feedback is-error";
    folderFb.textContent =
      error instanceof Error ? error.message : "Erro ao testar pasta.";
  } finally {
    if (testBtn) testBtn.disabled = false;
  }
}

export async function handleUploadProjectFiles(fileList) {
  const projectId = state.editingProjectId;
  const fb = $("#project-modal-feedback");
  if (!projectId) {
    if (fb) fb.textContent = "Crie/salve o projeto primeiro antes de enviar arquivos.";
    return;
  }

  const files = Array.from(fileList || []);
  if (files.length === 0) return;

  let uploadedCount = 0;
  let lastError = "";

  for (const file of files) {
    const lower = (file.name || "").toLowerCase();
    const isPdf = file.type === "application/pdf" || lower.endsWith(".pdf");

    try {
      if (fb) fb.textContent = `Indexando ${file.name}...`;
      let payload;

      if (isPdf) {
        if (file.size > 10 * 1024 * 1024) {
          throw new Error(`${file.name} passa de 10 MB.`);
        }
        const dataBase64 = await readFileAsBase64(file);
        payload = {
          name: file.name,
          kind: "pdf",
          mimeType: "application/pdf",
          dataBase64,
          size: file.size
        };
      } else {
        if (file.size > 1024 * 1024) {
          throw new Error(`${file.name} passa de 1 MB.`);
        }
        const content = await file.text();
        payload = {
          name: file.name,
          kind: "text",
          mimeType: file.type || "text/plain",
          content,
          size: file.size
        };
      }

      const res = await fetchJson(`/projects/${projectId}/files`, {
        method: "POST",
        timeoutMs: 35000,
        body: payload
      });

      if (Array.isArray(res?.projects)) {
        state.userProjects = res.projects;
      }
      if (res?.project) {
        renderProjectFilesList(res.project);
        updateProjectMoreSummary(res.project);
      }
      uploadedCount++;
    } catch (err) {
      lastError =
        err instanceof Error ? err.message : `Falha ao enviar ${file.name}.`;
    }
  }

  renderProjectsSidebar();
  syncComposerProjectPill();

  if (fb) {
    fb.textContent = lastError
      ? lastError
      : `${uploadedCount} arquivo(s) indexado(s) no Cérebro Local do projeto!`;
  }
}

export async function handleRemoveProjectFile(projectId, fileId) {
  const fb = $("#project-modal-feedback");
  try {
    let res;
    try {
      res = await fetchJson(`/projects/${projectId}/files/${fileId}`, {
        method: "DELETE"
      });
    } catch {
      res = await fetchJson(`/projects/${projectId}/files/${fileId}/delete`, {
        method: "POST",
        body: {}
      });
    }

    if (Array.isArray(res?.projects)) {
      state.userProjects = res.projects;
    }
    if (res?.project) {
      renderProjectFilesList(res.project);
      updateProjectMoreSummary(res.project);
    }
    renderProjectsSidebar();
    syncComposerProjectPill();
    if (fb) fb.textContent = "Arquivo removido.";
  } catch (error) {
    if (fb) {
      fb.textContent =
        error instanceof Error ? error.message : "Erro ao remover arquivo.";
    }
  }
}

export async function handleDeleteProject() {
  const projectId = state.editingProjectId;
  if (!projectId) return;

  const proj = getProjectByIdClient(projectId);
  const confirmed = window.confirm(
    `Excluir o projeto "${proj?.name || ""}"? As conversas dele NÃO serão apagadas (ficarão em Todos os chats).`
  );
  if (!confirmed) return;

  const fb = $("#project-modal-feedback");
  try {
    let res;
    try {
      res = await fetchJson(`/projects/${projectId}`, { method: "DELETE" });
    } catch {
      res = await fetchJson(`/projects/${projectId}/delete`, {
        method: "POST",
        body: {}
      });
    }

    if (Array.isArray(res?.projects)) {
      state.userProjects = res.projects;
    } else {
      state.userProjects = state.userProjects.filter((p) => p.id !== projectId);
    }

    if (state.selectedProjectFilterId === projectId) {
      state.selectedProjectFilterId = null;
    }
    if (state.activeNewChatProjectId === projectId) {
      state.activeNewChatProjectId = null;
    }

    // Limpa referência local nas conversas
    for (const d of state.latestDebates) {
      if (d.projectId === projectId) delete d.projectId;
    }
    for (const d of debateDetailsById.values()) {
      if (d.projectId === projectId) delete d.projectId;
    }

    closeProjectModal();
    renderProjectsSidebar();
    uiHooks.renderSidebarDebatesList();
    uiHooks.updateStageTopbar();
    syncComposerProjectPill();
    void refreshDashboard();
  } catch (error) {
    if (fb) {
      fb.textContent =
        error instanceof Error ? error.message : "Erro ao excluir projeto.";
    }
  }
}
