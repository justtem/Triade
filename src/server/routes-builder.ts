import type { IncomingMessage, ServerResponse } from "node:http";

import { getDebateSessionById } from "../debate/debate-engine.js";
import {
  abortBuilderRun,
  applyBuilderTurnToDisk,
  extractBuilderFilesForTurn,
  generateRemainingBuilderFiles,
  isBuilderRunning,
  undoBuilderTurnBackup,
  verifyAndAutoFixBuilderTurn
} from "../projects/builder-orchestrator.js";
import type { AuthManager } from "./auth.js";
import { isRecord, readRequestBody, sendJson } from "./http-utils.js";
import { slimDebateForDashboard } from "./routes-debates.js";

export async function handleBuilderRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  auth: AuthManager
): Promise<boolean> {
  const match = url.pathname.match(
    /^\/debates\/([a-zA-Z0-9_-]{6,64})\/builder\/(extract|generate-missing|apply|verify|undo|stop)$/
  );
  if (!match || request.method !== "POST") {
    return false;
  }

  if (!auth.isAuthorizedLocalClient(request)) {
    sendJson(response, 401, { error: "Não autorizado." }, origin);
    return true;
  }

  // Trava rigorosa: escrita na pasta do PC e execução de build/test são 100% localhost-only
  if (!auth.isDirectLocalPCRequest(request)) {
    sendJson(
      response,
      403,
      {
        error:
          "O Modo Construtor (escrita na pasta e build/test) é permitido apenas diretamente no PC local."
      },
      origin
    );
    return true;
  }

  const debateId = match[1] ?? "";
  const action = match[2] ?? "";

  let payload: Record<string, unknown> = {};
  try {
    const raw = await readRequestBody(request);
    if (raw.trim()) {
      const parsed = JSON.parse(raw);
      if (isRecord(parsed)) payload = parsed;
    }
  } catch {
    sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
    return true;
  }

  const turnId = typeof payload.turnId === "string" ? payload.turnId.trim() || undefined : undefined;

  if (action === "stop") {
    const stopped = abortBuilderRun(debateId);
    const debate = await getDebateSessionById(debateId);
    sendJson(
      response,
      200,
      {
        stopped,
        ...(debate ? { debate: slimDebateForDashboard(debate, true) } : {})
      },
      origin
    );
    return true;
  }

  if (action === "extract") {
    try {
      const debate = await extractBuilderFilesForTurn(debateId, turnId);
      sendJson(
        response,
        200,
        { ok: true, debate: slimDebateForDashboard(debate, true) },
        origin
      );
    } catch (err) {
      sendJson(
        response,
        400,
        { error: err instanceof Error ? err.message : "Erro ao extrair arquivos." },
        origin
      );
    }
    return true;
  }

  if (action === "undo") {
    try {
      const batchId =
        typeof payload.batchId === "string" ? payload.batchId.trim() || undefined : undefined;
      const debate = await undoBuilderTurnBackup(debateId, turnId, batchId);
      sendJson(
        response,
        200,
        { ok: true, debate: slimDebateForDashboard(debate, true) },
        origin
      );
    } catch (err) {
      sendJson(
        response,
        400,
        { error: err instanceof Error ? err.message : "Erro ao desfazer alterações." },
        origin
      );
    }
    return true;
  }

  // Ações potencialmente longas (geração arquivo-a-arquivo, npm install/build/test, auto-fix loop)
  // rodam em background com progresso ao vivo via SSE para nunca bater no requestTimeout HTTP.
  if (isBuilderRunning(debateId)) {
    sendJson(
      response,
      409,
      { error: "O Construtor já está em execução nesta conversa." },
      origin
    );
    return true;
  }

  const current = await getDebateSessionById(debateId);
  if (!current) {
    sendJson(response, 404, { error: "Conversa não encontrada." }, origin);
    return true;
  }

  if (action === "generate-missing") {
    void generateRemainingBuilderFiles(debateId, turnId).catch((err) => {
      console.warn(
        "[AI Council] Falha em builder/generate-missing:",
        err instanceof Error ? err.message : err
      );
    });
    sendJson(
      response,
      202,
      { started: true, action, debate: slimDebateForDashboard(current, true) },
      origin
    );
    return true;
  }

  if (action === "apply") {
    const selectedPaths = Array.isArray(payload.selectedPaths)
      ? payload.selectedPaths.filter((p): p is string => typeof p === "string")
      : undefined;
    const runVerification = payload.runVerification !== false;
    const autoFix = payload.autoFix !== false;

    void applyBuilderTurnToDisk(debateId, turnId, {
      selectedPaths,
      runVerification,
      autoFix
    }).catch((err) => {
      console.warn(
        "[AI Council] Falha em builder/apply:",
        err instanceof Error ? err.message : err
      );
    });

    sendJson(
      response,
      202,
      { started: true, action, debate: slimDebateForDashboard(current, true) },
      origin
    );
    return true;
  }

  if (action === "verify") {
    const autoFix = payload.autoFix !== false;
    void verifyAndAutoFixBuilderTurn(debateId, turnId, { autoFix }).catch((err) => {
      console.warn(
        "[AI Council] Falha em builder/verify:",
        err instanceof Error ? err.message : err
      );
    });
    sendJson(
      response,
      202,
      { started: true, action, debate: slimDebateForDashboard(current, true) },
      origin
    );
    return true;
  }

  return false;
}
