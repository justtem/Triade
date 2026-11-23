import type { IncomingMessage, ServerResponse } from "node:http";

import { clearDeletedProjectFromDebates } from "../debate/debate-engine.js";
import {
  addProjectFile,
  createProject,
  deleteProject,
  getProjectById,
  listProjects,
  removeProjectFile,
  updateProject
} from "../persistence/project-store.js";
import {
  analyzeAppBriefing,
  expandAppBriefingToSpec,
  type AppBriefingKind,
  type AppBriefingTheme
} from "../projects/app-briefing.js";
import {
  getProjectDevServerStatus,
  startProjectDevServer,
  stopProjectDevServer
} from "../projects/dev-server-manager.js";
import {
  createSubfolderInParent,
  pickLocalFolderDialog
} from "../projects/folder-picker.js";
import { inspectLinkedFolder } from "../projects/project-rag.js";
import type { AuthManager } from "./auth.js";
import {
  isRecord,
  MAX_MEDIA_BODY_SIZE,
  readRequestBody,
  sendJson
} from "./http-utils.js";

export async function handleProjectRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  auth: AuthManager
): Promise<boolean> {
  if (url.pathname === "/projects") {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    if (request.method === "GET") {
      try {
        const projects = await listProjects();
        sendJson(response, 200, { projects }, origin);
      } catch (error) {
        console.error("[AI Council] Erro ao listar projetos:", error);
        sendJson(response, 500, { error: "Falha ao listar projetos." }, origin);
      }
      return true;
    }

    if (request.method === "POST") {
      let payload: unknown;
      try {
        payload = JSON.parse(await readRequestBody(request));
      } catch {
        sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
        return true;
      }

      if (!isRecord(payload)) {
        sendJson(response, 400, { error: "Dados do projeto inválidos." }, origin);
        return true;
      }

      const requestedFolder =
        typeof payload.linkedFolderPath === "string"
          ? payload.linkedFolderPath.trim()
          : "";
      if (requestedFolder && !auth.isDirectLocalPCRequest(request)) {
        sendJson(
          response,
          403,
          {
            error:
              "Vincular pastas locais do PC é permitido apenas diretamente no computador local."
          },
          origin
        );
        return true;
      }

      try {
        const created = await createProject({
          name: typeof payload.name === "string" ? payload.name : "",
          description:
            typeof payload.description === "string"
              ? payload.description
              : undefined,
          color: typeof payload.color === "string" ? payload.color : undefined,
          instructions:
            typeof payload.instructions === "string" ? payload.instructions : "",
          linkedFolderPath: requestedFolder || undefined
        });
        const projects = await listProjects();
        sendJson(
          response,
          201,
          { created: true, project: created, projects },
          origin
        );
      } catch (error) {
        sendJson(
          response,
          400,
          {
            error:
              error instanceof Error
                ? error.message
                : "Não foi possível criar o projeto."
          },
          origin
        );
      }
      return true;
    }
  }

  if (request.method === "POST" && url.pathname === "/projects/inspect-folder") {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    if (!auth.isDirectLocalPCRequest(request)) {
      sendJson(
        response,
        403,
        {
          error:
            "Inspeção de pastas do PC é permitida apenas diretamente no computador local."
        },
        origin
      );
      return true;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await readRequestBody(request));
    } catch {
      sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
      return true;
    }

    const folderPath =
      isRecord(payload) && typeof payload.path === "string" ? payload.path : "";

    try {
      const inspection = await inspectLinkedFolder(folderPath);
      sendJson(response, 200, { inspection }, origin);
    } catch (error) {
      sendJson(
        response,
        400,
        {
          error:
            error instanceof Error
              ? error.message
              : "Falha ao inspecionar pasta."
        },
        origin
      );
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/projects/pick-folder") {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    if (!auth.isDirectLocalPCRequest(request)) {
      sendJson(
        response,
        403,
        {
          error:
            "Escolher pastas locais do PC é permitido apenas diretamente no computador local."
        },
        origin
      );
      return true;
    }

    let payload: unknown = {};
    try {
      const raw = await readRequestBody(request);
      if (raw.trim()) {
        payload = JSON.parse(raw);
      }
    } catch {
      sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
      return true;
    }

    const initialPath =
      isRecord(payload) && typeof payload.initialPath === "string"
        ? payload.initialPath
        : undefined;

    try {
      const result = await pickLocalFolderDialog(initialPath);
      sendJson(response, 200, result, origin);
    } catch (error) {
      sendJson(
        response,
        400,
        {
          error:
            error instanceof Error
              ? error.message
              : "Não foi possível abrir o seletor de pastas."
        },
        origin
      );
    }
    return true;
  }

  if (request.method === "POST" && url.pathname === "/projects/create-subfolder") {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    if (!auth.isDirectLocalPCRequest(request)) {
      sendJson(
        response,
        403,
        {
          error:
            "Criar subpastas no PC é permitido apenas diretamente no computador local."
        },
        origin
      );
      return true;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await readRequestBody(request));
    } catch {
      sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
      return true;
    }

    if (!isRecord(payload)) {
      sendJson(response, 400, { error: "Dados da subpasta inválidos." }, origin);
      return true;
    }

    const parentPath =
      typeof payload.parentPath === "string" ? payload.parentPath : "";
    const folderName =
      typeof payload.folderName === "string" ? payload.folderName : "";

    try {
      const result = await createSubfolderInParent(parentPath, folderName);
      sendJson(response, result.created ? 201 : 200, result, origin);
    } catch (error) {
      sendJson(
        response,
        400,
        {
          error:
            error instanceof Error
              ? error.message
              : "Não foi possível criar a subpasta."
        },
        origin
      );
    }
    return true;
  }

  // Briefing 1-frase: analisa ideia em 0ms e sugere pasta + perfis de segurança (PC local apenas)
  if (request.method === "POST" && url.pathname === "/projects/briefing/analyze") {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    if (!auth.isDirectLocalPCRequest(request)) {
      sendJson(
        response,
        403,
        {
          error:
            "Briefing com criação de pasta local está disponível apenas diretamente no computador local."
        },
        origin
      );
      return true;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await readRequestBody(request));
    } catch {
      sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
      return true;
    }

    const prompt =
      isRecord(payload) && typeof payload.prompt === "string" ? payload.prompt : "";
    const baseDir =
      isRecord(payload) && typeof payload.baseDir === "string"
        ? payload.baseDir
        : undefined;

    try {
      const analysis = await analyzeAppBriefing(prompt, { baseDir });
      sendJson(response, 200, { analysis }, origin);
    } catch (error) {
      sendJson(
        response,
        400,
        {
          error:
            error instanceof Error
              ? error.message
              : "Não foi possível analisar o briefing."
        },
        origin
      );
    }
    return true;
  }

  // Briefing 1-frase: cria subpasta + Projeto com regras OWASP/LGPD e devolve prompt expandido (PC local apenas)
  if (request.method === "POST" && url.pathname === "/projects/briefing/prepare") {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    if (!auth.isDirectLocalPCRequest(request)) {
      sendJson(
        response,
        403,
        {
          error:
            "Criação automática de projetos na pasta está disponível apenas diretamente no computador local."
        },
        origin
      );
      return true;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await readRequestBody(request));
    } catch {
      sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
      return true;
    }

    if (!isRecord(payload)) {
      sendJson(response, 400, { error: "Dados do briefing inválidos." }, origin);
      return true;
    }

    const rawIdea = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
    const appName = typeof payload.appName === "string" ? payload.appName.trim() : "";
    const baseDir = typeof payload.baseDir === "string" ? payload.baseDir.trim() : "";
    const appKind: AppBriefingKind =
      payload.appKind === "api" || payload.appKind === "landing"
        ? payload.appKind
        : "web_app";
    const theme: AppBriefingTheme = payload.theme === "light" ? "light" : "dark";
    const secRaw = isRecord(payload.security) ? payload.security : {};
    const financial = secRaw.financial === true;
    const lgpd = secRaw.lgpd === true;

    if (!rawIdea) {
      sendJson(response, 400, { error: "Descreva a ideia do aplicativo." }, origin);
      return true;
    }

    try {
      const analysis = await analyzeAppBriefing(rawIdea, {
        baseDir: baseDir || undefined
      });
      const finalName = appName || analysis.suggestedName;
      const finalBaseDir = baseDir || analysis.baseDir;

      const folderRes = await createSubfolderInParent(finalBaseDir, finalName);
      const spec = expandAppBriefingToSpec({
        rawIdea,
        appName: finalName,
        appKind,
        theme,
        port: analysis.port,
        security: { financial, lgpd }
      });

      const createdProject = await createProject({
        name: finalName,
        description: spec.description,
        color: spec.color,
        instructions: spec.projectInstructions,
        linkedFolderPath: folderRes.path
      });
      const projects = await listProjects();

      sendJson(
        response,
        201,
        {
          prepared: true,
          project: createdProject,
          projects,
          folderPath: folderRes.path,
          expandedPrompt: spec.expandedPrompt,
          port: spec.port
        },
        origin
      );
    } catch (error) {
      sendJson(
        response,
        400,
        {
          error:
            error instanceof Error
              ? error.message
              : "Não foi possível preparar o projeto."
        },
        origin
      );
    }
    return true;
  }

  // Preview App ao vivo (npm run dev / start — 100% localhost-only)
  const devServerMatch = url.pathname.match(
    /^\/projects\/([a-zA-Z0-9_-]{6,64})\/dev-server\/(status|start|stop)$/
  );

  if (devServerMatch) {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    if (!auth.isDirectLocalPCRequest(request)) {
      sendJson(
        response,
        403,
        {
          error:
            "Rodar projetos localmente (npm run dev) é permitido apenas diretamente no PC local."
        },
        origin
      );
      return true;
    }

    const projectId = devServerMatch[1] ?? "";
    const devAction = devServerMatch[2] ?? "";
    const project = await getProjectById(projectId);
    if (!project) {
      sendJson(response, 404, { error: "Projeto não encontrado." }, origin);
      return true;
    }
    const folderPath = (project.linkedFolderPath ?? "").trim();

    if (devAction === "status" && request.method === "GET") {
      const status = await getProjectDevServerStatus(projectId, folderPath);
      sendJson(response, 200, { status }, origin);
      return true;
    }

    if (devAction === "stop" && request.method === "POST") {
      const stopped = await stopProjectDevServer(projectId);
      const status = await getProjectDevServerStatus(projectId, folderPath);
      sendJson(response, 200, { stopped, status }, origin);
      return true;
    }

    if (devAction === "start" && request.method === "POST") {
      if (!folderPath) {
        sendJson(
          response,
          400,
          { error: "Este projeto não possui pasta local vinculada." },
          origin
        );
        return true;
      }
      try {
        const status = await startProjectDevServer(projectId, folderPath);
        sendJson(response, 200, { started: true, status }, origin);
      } catch (error) {
        sendJson(
          response,
          400,
          {
            error:
              error instanceof Error
                ? error.message
                : "Não foi possível iniciar o servidor do app."
          },
          origin
        );
      }
      return true;
    }
  }

  const projectFileMatch = url.pathname.match(
    /^\/projects\/([a-zA-Z0-9_-]{6,64})\/files(?:\/([a-zA-Z0-9_-]{6,64})(?:\/(delete))?)?$/
  );

  if (projectFileMatch) {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    const projectId = projectFileMatch[1] ?? "";
    const fileId = projectFileMatch[2] ?? "";
    const fileAction = projectFileMatch[3] ?? "";

    if (!fileId && request.method === "POST") {
      let payload: unknown;
      try {
        payload = JSON.parse(await readRequestBody(request, MAX_MEDIA_BODY_SIZE));
      } catch {
        sendJson(
          response,
          400,
          { error: "Arquivo inválido ou grande demais (máx. 10 MB)." },
          origin
        );
        return true;
      }

      if (!isRecord(payload)) {
        sendJson(response, 400, { error: "Dados do arquivo inválidos." }, origin);
        return true;
      }

      try {
        const { project, file } = await addProjectFile(projectId, {
          name: typeof payload.name === "string" ? payload.name : "",
          kind: payload.kind === "pdf" ? "pdf" : "text",
          mimeType:
            typeof payload.mimeType === "string" ? payload.mimeType : undefined,
          content:
            typeof payload.content === "string" ? payload.content : undefined,
          dataBase64:
            typeof payload.dataBase64 === "string"
              ? payload.dataBase64
              : undefined,
          size: typeof payload.size === "number" ? payload.size : undefined
        });
        const projects = await listProjects();
        sendJson(
          response,
          201,
          { uploaded: true, file, project, projects },
          origin
        );
      } catch (error) {
        sendJson(
          response,
          400,
          {
            error:
              error instanceof Error
                ? error.message
                : "Falha ao adicionar arquivo ao projeto."
          },
          origin
        );
      }
      return true;
    }

    if (
      fileId &&
      (request.method === "DELETE" ||
        (request.method === "POST" && fileAction === "delete"))
    ) {
      try {
        const project = await removeProjectFile(projectId, fileId);
        if (!project) {
          sendJson(response, 404, { error: "Arquivo não encontrado." }, origin);
          return true;
        }
        const projects = await listProjects();
        sendJson(response, 200, { deleted: true, project, projects }, origin);
      } catch {
        sendJson(
          response,
          500,
          { error: "Falha ao remover arquivo do projeto." },
          origin
        );
      }
      return true;
    }
  }

  const projectItemMatch = url.pathname.match(
    /^\/projects\/([a-zA-Z0-9_-]{6,64})(?:\/(update|delete))?$/
  );

  if (projectItemMatch) {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    const projectId = projectItemMatch[1] ?? "";
    const subAction = projectItemMatch[2] ?? "";

    if (!subAction && request.method === "GET") {
      const project = await getProjectById(projectId);
      if (!project) {
        sendJson(response, 404, { error: "Projeto não encontrado." }, origin);
        return true;
      }
      sendJson(response, 200, { project }, origin);
      return true;
    }

    if (
      request.method === "DELETE" ||
      (request.method === "POST" && subAction === "delete")
    ) {
      try {
        const deleted = await deleteProject(projectId);
        if (!deleted) {
          sendJson(response, 404, { error: "Projeto não encontrado." }, origin);
          return true;
        }
        await clearDeletedProjectFromDebates(projectId);
        const projects = await listProjects();
        sendJson(response, 200, { deleted: true, id: projectId, projects }, origin);
      } catch {
        sendJson(response, 500, { error: "Falha ao excluir projeto." }, origin);
      }
      return true;
    }

    if (
      request.method === "PATCH" ||
      (request.method === "POST" && subAction === "update")
    ) {
      let payload: unknown;
      try {
        payload = JSON.parse(await readRequestBody(request));
      } catch {
        sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
        return true;
      }
      if (!isRecord(payload)) {
        sendJson(response, 400, { error: "Dados do projeto inválidos." }, origin);
        return true;
      }

      const hasFolderUpdate = typeof payload.linkedFolderPath === "string";
      if (hasFolderUpdate && !auth.isDirectLocalPCRequest(request)) {
        const existingProj = await getProjectById(projectId).catch(() => null);
        const currentFolder = (existingProj?.linkedFolderPath ?? "").trim();
        const incomingFolder = (payload.linkedFolderPath as string).trim();
        if (incomingFolder !== currentFolder) {
          sendJson(
            response,
            403,
            {
              error:
                "Vincular ou alterar pastas locais do PC é permitido apenas diretamente no computador local."
            },
            origin
          );
          return true;
        }
      }

      try {
        const updated = await updateProject(projectId, {
          ...(typeof payload.name === "string" ? { name: payload.name } : {}),
          ...(typeof payload.description === "string"
            ? { description: payload.description }
            : {}),
          ...(typeof payload.color === "string" ? { color: payload.color } : {}),
          ...(typeof payload.instructions === "string"
            ? { instructions: payload.instructions }
            : {}),
          ...(hasFolderUpdate && auth.isDirectLocalPCRequest(request)
            ? { linkedFolderPath: payload.linkedFolderPath as string }
            : {})
        });
        const projects = await listProjects();
        sendJson(
          response,
          200,
          { updated: true, project: updated, projects },
          origin
        );
      } catch (error) {
        const msg =
          error instanceof Error ? error.message : "Erro ao atualizar projeto.";
        sendJson(
          response,
          msg.includes("não encontrado") ? 404 : 400,
          { error: msg },
          origin
        );
      }
      return true;
    }
  }

  return false;
}
