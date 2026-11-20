import type { IncomingMessage, ServerResponse } from "node:http";

import {
  clearUserMemory,
  deleteUserMemoryFact,
  readUserMemory,
  setUserMemoryEnabled
} from "../persistence/user-memory-store.js";
import type { AuthManager } from "./auth.js";
import { isRecord, readRequestBody, sendJson } from "./http-utils.js";

/**
 * Rotas de visualização/controle da Memória Pessoal Automática (/user-memory).
 * Não há criação manual — apenas listar, pausar/retomar aprendizado e excluir fatos.
 */
export async function handleUserMemoryRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  auth: AuthManager
): Promise<boolean> {
  if (url.pathname === "/user-memory") {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    if (request.method === "GET") {
      try {
        const memory = await readUserMemory();
        sendJson(response, 200, { memory }, origin);
      } catch (error) {
        console.error("[AI Council] Erro ao ler memória pessoal:", error);
        sendJson(response, 500, { error: "Falha ao carregar memória pessoal." }, origin);
      }
      return true;
    }

    if (request.method === "PATCH") {
      let payload: unknown;
      try {
        payload = JSON.parse(await readRequestBody(request));
      } catch {
        sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
        return true;
      }

      if (!isRecord(payload) || typeof payload.enabled !== "boolean") {
        sendJson(response, 400, { error: "Informe enabled (true/false)." }, origin);
        return true;
      }

      try {
        const memory = await setUserMemoryEnabled(payload.enabled);
        sendJson(response, 200, { updated: true, memory }, origin);
      } catch (error) {
        console.error("[AI Council] Erro ao atualizar memória pessoal:", error);
        sendJson(response, 500, { error: "Falha ao atualizar memória pessoal." }, origin);
      }
      return true;
    }

    if (request.method === "DELETE") {
      try {
        const memory = await clearUserMemory();
        sendJson(response, 200, { cleared: true, memory }, origin);
      } catch (error) {
        console.error("[AI Council] Erro ao limpar memória pessoal:", error);
        sendJson(response, 500, { error: "Falha ao limpar memória pessoal." }, origin);
      }
      return true;
    }

    sendJson(response, 405, { error: "Método não permitido." }, origin);
    return true;
  }

  const factMatch = url.pathname.match(/^\/user-memory\/([a-zA-Z0-9_-]{4,64})$/);
  if (factMatch && request.method === "DELETE") {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    const factId = factMatch[1] ?? "";
    try {
      const { deleted, state } = await deleteUserMemoryFact(factId);
      sendJson(
        response,
        deleted ? 200 : 404,
        deleted
          ? { deleted: true, memory: state }
          : { error: "Fato não encontrado na memória." },
        origin
      );
    } catch (error) {
      console.error("[AI Council] Erro ao remover fato da memória:", error);
      sendJson(response, 500, { error: "Falha ao remover fato." }, origin);
    }
    return true;
  }

  return false;
}
