import type { IncomingMessage, ServerResponse } from "node:http";

import { synthesizeSpeechWithEdge } from "../providers/tts.js";
import { transcribeAudioWithGroq } from "../providers/whisper.js";
import type { AuthManager } from "./auth.js";
import {
  getTransportSecurityHeaders,
  isMozExtensionOrigin,
  isRecord,
  MAX_BODY_SIZE,
  MAX_MEDIA_BODY_SIZE,
  readRequestBody,
  SECURITY_HEADERS,
  sendJson
} from "./http-utils.js";

export async function handleAudioRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  auth: AuthManager
): Promise<boolean> {
  if (request.method === "POST" && url.pathname === "/audio/transcribe") {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    let payload: unknown;
    try {
      const body = await readRequestBody(request, MAX_MEDIA_BODY_SIZE);
      payload = JSON.parse(body);
    } catch {
      sendJson(
        response,
        400,
        { error: "Áudio inválido ou grande demais (máx. 10 MB)." },
        origin
      );
      return true;
    }

    if (!isRecord(payload) || typeof payload.audioBase64 !== "string") {
      sendJson(response, 400, { error: "Campo audioBase64 obrigatório." }, origin);
      return true;
    }

    try {
      const result = await transcribeAudioWithGroq({
        audioBase64: payload.audioBase64,
        mimeType:
          typeof payload.mimeType === "string" ? payload.mimeType : undefined,
        language: typeof payload.language === "string" ? payload.language : "pt"
      });

      console.log(
        `[AI Council] Voz transcrita (${result.model}, ${result.text.length} chars).`
      );

      sendJson(
        response,
        200,
        { text: result.text, model: result.model },
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
              : "Falha ao transcrever o áudio."
        },
        origin
      );
    }

    return true;
  }

  if (request.method === "POST" && url.pathname === "/audio/speak") {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    let payload: unknown;
    try {
      const body = await readRequestBody(request, MAX_BODY_SIZE);
      payload = JSON.parse(body);
    } catch {
      sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
      return true;
    }

    if (!isRecord(payload) || typeof payload.text !== "string") {
      sendJson(response, 400, { error: "Campo text obrigatório." }, origin);
      return true;
    }

    try {
      const result = await synthesizeSpeechWithEdge({
        text: payload.text,
        persona: typeof payload.persona === "string" ? payload.persona : undefined,
        voiceKey:
          typeof payload.voiceKey === "string" ? payload.voiceKey : undefined
      });

      const headers: Record<string, string> = {
        ...SECURITY_HEADERS,
        ...getTransportSecurityHeaders(request),
        "Content-Type": result.contentType,
        "Content-Length": String(result.audioBuffer.byteLength),
        "Cache-Control": "no-store",
        "X-TTS-Voice": result.voice,
        "X-TTS-Cached": result.cached ? "1" : "0"
      };
      if (isMozExtensionOrigin(origin)) {
        headers["Access-Control-Allow-Origin"] = origin;
        headers["Vary"] = "Origin";
      }

      response.writeHead(200, headers);
      response.end(result.audioBuffer);
    } catch (error) {
      console.warn(
        "[AI Council] Edge Neural TTS falhou:",
        error instanceof Error ? error.message : error
      );
      sendJson(
        response,
        502,
        {
          error:
            error instanceof Error
              ? error.message
              : "Falha ao gerar áudio neural."
        },
        origin
      );
    }

    return true;
  }

  return false;
}
