import type { IncomingMessage, ServerResponse } from "node:http";

import {
  createPromptTemplate,
  deletePromptTemplate,
  listPromptTemplates,
  updatePromptTemplate
} from "../persistence/template-store.js";
import type { AuthManager } from "./auth.js";
import { isRecord, readRequestBody, sendJson } from "./http-utils.js";

export async function handleTemplateRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  auth: AuthManager
): Promise<boolean> {
  if (url.pathname === "/templates") {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    if (request.method === "GET") {
      try {
        const templates = await listPromptTemplates();
        sendJson(response, 200, { templates }, origin);
      } catch (error) {
        console.error("[AI Council] Erro ao listar templates:", error);
        sendJson(response, 500, { error: "Falha ao listar templates." }, origin);
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
        sendJson(response, 400, { error: "Dados do template inválidos." }, origin);
        return true;
      }

      try {
        const created = await createPromptTemplate({
          tag: typeof payload.tag === "string" ? payload.tag : undefined,
          title: typeof payload.title === "string" ? payload.title : "",
          prompt: typeof payload.prompt === "string" ? payload.prompt : "",
          rules: typeof payload.rules === "string" ? payload.rules : undefined,
          focus:
            payload.focus === "backend" || payload.focus === "frontend"
              ? payload.focus
              : "geral",
          responseMode:
            payload.responseMode === "prompt_markdown"
              ? "prompt_markdown"
              : "normal",
          interactionMode:
            payload.interactionMode === "debate" ? "debate" : "direct"
        });
        sendJson(response, 201, { created: true, template: created }, origin);
      } catch (error) {
        sendJson(
          response,
          400,
          {
            error:
              error instanceof Error
                ? error.message
                : "Não foi possível salvar o template."
          },
          origin
        );
      }
      return true;
    }
  }

  const templateItemMatch = url.pathname.match(
    /^\/templates\/([a-zA-Z0-9_-]{4,64})(?:\/(update|delete))?$/
  );

  if (templateItemMatch) {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    const tplId = templateItemMatch[1] ?? "";
    const subAction = templateItemMatch[2] ?? "";

    if (
      request.method === "DELETE" ||
      (request.method === "POST" && subAction === "delete")
    ) {
      try {
        const deleted = await deletePromptTemplate(tplId);
        if (!deleted) {
          sendJson(response, 404, { error: "Template não encontrado." }, origin);
          return true;
        }
        sendJson(response, 200, { deleted: true, id: tplId }, origin);
      } catch {
        sendJson(response, 500, { error: "Falha ao excluir template." }, origin);
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
        sendJson(response, 400, { error: "Dados do template inválidos." }, origin);
        return true;
      }

      try {
        const updated = await updatePromptTemplate(tplId, {
          tag: typeof payload.tag === "string" ? payload.tag : undefined,
          title: typeof payload.title === "string" ? payload.title : "",
          prompt: typeof payload.prompt === "string" ? payload.prompt : "",
          rules: typeof payload.rules === "string" ? payload.rules : undefined,
          focus:
            payload.focus === "backend" || payload.focus === "frontend"
              ? payload.focus
              : "geral",
          responseMode:
            payload.responseMode === "prompt_markdown"
              ? "prompt_markdown"
              : "normal",
          interactionMode:
            payload.interactionMode === "debate" ? "debate" : "direct"
        });
        sendJson(response, 200, { updated: true, template: updated }, origin);
      } catch (error) {
        const msg =
          error instanceof Error ? error.message : "Erro ao atualizar template.";
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
