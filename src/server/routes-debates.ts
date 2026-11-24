import type { IncomingMessage, ServerResponse } from "node:http";

import {
  assignDebateToProject,
  continueDebateSession,
  createDebateSession,
  deleteDebateSession,
  editTurnAndRewind,
  enrichPdfAttachments,
  getDebateSessionById,
  listDebateSummaries,
  pauseDebateManually,
  regenerateDebateResponse,
  renameDebateSession,
  resumeDebateSession,
  reviewDebateResponseWithPlatform,
  searchDebateSessions,
  stopDebateGeneration,
  submitDebateTaskResponse,
  togglePinDebateSession,
  updateSessionSharedMemoryManually
} from "../debate/debate-engine.js";
import { abortDebateTasks, kickRunner } from "../debate/runner.js";
import { getActiveStreams } from "../debate/stream-hub.js";
import { generateTurnVerdict } from "../debate/verdict.js";
import {
  resolveAutoResponseMode,
  routeAutoComposerStrategy,
  routeAutoParticipants
} from "../debate/auto-router.js";
import {
  buildLocalCleanTitle,
  scheduleAutoTitleForDebate
} from "../debate/auto-title.js";
import { generateBriefingGrillQuestions } from "../projects/app-grill-me.js";
import { getProjectById } from "../persistence/project-store.js";
import {
  AUTO_BUILDER_HINT_RULE,
  classifyBuilderIntent,
  normalizeFolderPolicy
} from "../projects/builder-intent.js";
import { listWorkspaceSourceFiles } from "../projects/workspace-writer.js";
import {
  applyImageSlotsToWorkspace,
  isPureImageSlotSwapRequest
} from "../projects/landing-assets.js";
import { gatherProjectContext } from "../projects/project-rag.js";
import { readPrivacySettings } from "../security/data-protection.js";
import {
  scanImageAttachmentForPrivacy,
  type ImagePrivacyScanResult
} from "../security/image-ocr.js";
import {
  mergePrivacyFindings,
  normalizePrivacyAction,
  redactAttachmentsForShield,
  redactProjectContextForShield,
  scanAndRedactText
} from "../security/privacy-shield.js";
import {
  ALL_PLATFORMS,
  type AIPlatform,
  type ChatAttachment,
  type DebateSession,
  type InteractionMode,
  type WebSearchMode
} from "../shared/debate-types.js";
import { gatherWebContext } from "../web/web-context.js";
import type { AuthManager } from "./auth.js";
import {
  isRecord,
  MAX_BODY_SIZE,
  MAX_MEDIA_BODY_SIZE,
  readRequestBody,
  sendJson
} from "./http-utils.js";

const VALID_PARTICIPANTS = new Set<string>(ALL_PLATFORMS);

export function slimDebateForDashboard(
  debate: DebateSession,
  includePendingTasks: boolean
): unknown {
  return {
    ...debate,
    ...(Array.isArray(debate.turns)
      ? {
          turns: debate.turns.map((turn) => ({
            ...turn,
            ...(Array.isArray(turn.attachments) && turn.attachments.length > 0
              ? {
                  attachments: turn.attachments.map((att) => ({
                    name: att.name,
                    size: att.size,
                    ...(att.kind ? { kind: att.kind } : {}),
                    ...(att.mimeType ? { mimeType: att.mimeType } : {}),
                    ...(att.kind === "image" && att.dataBase64
                      ? { dataBase64: att.dataBase64 }
                      : {})
                  }))
                }
              : {}),
            ...(Array.isArray(turn.webSources) && turn.webSources.length > 0
              ? {
                  webSources: turn.webSources.map((src) => ({
                    index: src.index,
                    title: src.title,
                    url: src.url,
                    domain: src.domain,
                    snippet: src.snippet,
                    origin: src.origin,
                    ...(src.fetchedOk !== undefined
                      ? { fetchedOk: src.fetchedOk }
                      : {})
                  }))
                }
              : {})
          }))
        }
      : {}),
    tasks: (includePendingTasks
      ? debate.tasks
      : debate.tasks.filter((task) => task.status !== "pending")
    ).map((task) => {
      const keepPrompt =
        includePendingTasks &&
        task.status === "pending" &&
        task.seat === "manual";
      return {
        id: task.id,
        ...(task.turnId ? { turnId: task.turnId } : {}),
        round: task.round,
        stage: task.stage,
        platform: task.platform,
        status: task.status,
        createdAt: task.createdAt,
        ...(task.completedAt ? { completedAt: task.completedAt } : {}),
        ...(task.seat ? { seat: task.seat } : {}),
        ...(task.role ? { role: task.role } : {}),
        ...(task.attempts !== undefined ? { attempts: task.attempts } : {}),
        ...(task.lastError ? { lastError: task.lastError } : {}),
        prompt: keepPrompt ? task.prompt : ""
      };
    }),
    responses: debate.responses.map((resp) => ({
      id: resp.id,
      ...(resp.turnId ? { turnId: resp.turnId } : {}),
      taskId: resp.taskId,
      round: resp.round,
      stage: resp.stage,
      platform: resp.platform,
      content: resp.content,
      submittedAt: resp.submittedAt,
      ...(resp.model ? { model: resp.model } : {}),
      ...(resp.tokens !== undefined ? { tokens: resp.tokens } : {}),
      ...(resp.interrupted ? { interrupted: true } : {})
    }))
  };
}

export async function handleDebateRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  auth: AuthManager
): Promise<boolean> {
  // Busca full-text (/debates/search)
  if (request.method === "GET" && url.pathname === "/debates/search") {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    const q = (url.searchParams.get("q") ?? "").trim().slice(0, 120);
    try {
      const matchingIds = q ? await searchDebateSessions(q) : [];
      sendJson(response, 200, { query: q, matchingIds }, origin);
    } catch (error) {
      console.error("[AI Council] Erro ao buscar conversas:", error);
      sendJson(response, 500, { error: "Falha ao buscar conversas." }, origin);
    }
    return true;
  }

  // Detalhe / renomear / pin / projeto / excluir (/debates/:id)
  const debateDetailMatch = url.pathname.match(
    /^\/debates\/([0-9a-fA-F-]{8,64})$/
  );

  if (debateDetailMatch) {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    const debateId = debateDetailMatch[1] ?? "";

    if (request.method === "GET") {
      try {
        const session = await getDebateSessionById(debateId);
        if (!session) {
          sendJson(response, 404, { error: "Conversa não encontrada." }, origin);
          return true;
        }

        const includePending = auth.isDashboardRequest(request);
        sendJson(
          response,
          200,
          {
            debate: slimDebateForDashboard(session, includePending),
            activeStreams: getActiveStreams(debateId)
          },
          origin
        );
      } catch (error) {
        console.error("[AI Council] Erro ao ler conversa:", error);
        sendJson(response, 500, { error: "Falha ao carregar a conversa." }, origin);
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

      const pinnedValue =
        isRecord(payload) && typeof payload.pinned === "boolean"
          ? payload.pinned
          : undefined;
      const hasProjectField =
        isRecord(payload) &&
        Object.prototype.hasOwnProperty.call(payload, "projectId");
      const projectIdValue =
        hasProjectField && isRecord(payload) && typeof payload.projectId === "string"
          ? payload.projectId
          : null;
      const title =
        isRecord(payload) && typeof payload.title === "string"
          ? payload.title
          : "";

      try {
        const updated =
          hasProjectField && !title
            ? await assignDebateToProject(debateId, projectIdValue)
            : typeof pinnedValue === "boolean" && !title
              ? await togglePinDebateSession(debateId, pinnedValue)
              : await renameDebateSession(debateId, title);
        sendJson(
          response,
          200,
          {
            updated: true,
            debate: slimDebateForDashboard(updated, auth.isDashboardRequest(request))
          },
          origin
        );
      } catch (error) {
        const msg =
          error instanceof Error ? error.message : "Erro ao atualizar conversa.";
        sendJson(
          response,
          msg.includes("não encontrada") ? 404 : 400,
          { error: msg },
          origin
        );
      }
      return true;
    }

    if (request.method === "DELETE") {
      try {
        const deleted = await deleteDebateSession(debateId);
        if (!deleted) {
          sendJson(response, 404, { error: "Conversa não encontrada." }, origin);
          return true;
        }
        sendJson(response, 200, { deleted: true, id: debateId }, origin);
      } catch (error) {
        console.error("[AI Council] Erro ao excluir conversa:", error);
        sendJson(response, 500, { error: "Falha ao excluir a conversa." }, origin);
      }
      return true;
    }
  }

  // Listar ou criar conversas (/debates)
  if (url.pathname === "/debates/grill-me" && request.method === "POST") {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(await readRequestBody(request));
    } catch {
      sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
      return true;
    }

    const rawPrompt =
      isRecord(payload) && typeof payload.prompt === "string" ? payload.prompt.trim() : "";
    if (!rawPrompt) {
      sendJson(response, 400, { error: "Envie uma ideia ou pergunta para o Grill-me." }, origin);
      return true;
    }

    try {
      const privacySettings = await readPrivacySettings();
      const safePrompt =
        privacySettings.shieldMode !== "off"
          ? scanAndRedactText(rawPrompt, privacySettings.shieldMode).redactedText
          : rawPrompt;

      const generated = await generateBriefingGrillQuestions({
        prompt: safePrompt,
        mode: "general"
      });
      sendJson(response, 200, generated, origin);
    } catch (error) {
      sendJson(
        response,
        500,
        {
          error:
            error instanceof Error
              ? error.message
              : "Não foi possível gerar perguntas do Grill-me."
        },
        origin
      );
    }
    return true;
  }

  if (url.pathname === "/debates") {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    if (request.method === "GET") {
      try {
        const summaries = await listDebateSummaries();
        sendJson(response, 200, { debates: summaries }, origin);
      } catch (error) {
        console.error("[AI Council] Erro ao listar debates:", error);
        sendJson(response, 500, { error: "Falha ao listar debates." }, origin);
      }
      return true;
    }

    if (request.method === "POST") {
      let payload: unknown;
      try {
        const body = await readRequestBody(request, MAX_MEDIA_BODY_SIZE);
        payload = JSON.parse(body);
      } catch {
        sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
        return true;
      }

      if (!isRecord(payload)) {
        sendJson(response, 400, { error: "Dados do debate inválidos." }, origin);
        return true;
      }

      const rawParticipants = Array.isArray(payload.participants)
        ? payload.participants.filter(
            (p): p is AIPlatform =>
              typeof p === "string" && VALID_PARTICIPANTS.has(p)
          )
        : [];
      const rawAttachments = Array.isArray(payload.attachments)
        ? (payload.attachments as ChatAttachment[])
        : undefined;
      const webSearchMode: WebSearchMode =
        payload.webSearchMode === "off" ? "off" : "auto";
      const rawTopicStr = typeof payload.topic === "string" ? payload.topic : "";
      const rawRulesStr = typeof payload.rules === "string" ? payload.rules : undefined;
      const rawTitleStr = typeof payload.title === "string" ? payload.title : "";
      const privacyAction = normalizePrivacyAction(payload.privacyAction);
      const projectId =
        typeof payload.projectId === "string" && payload.projectId.trim()
          ? payload.projectId.trim()
          : undefined;

      try {
        const privacySettings = await readPrivacySettings();
        const shieldMode = privacySettings.shieldMode;

        let topicStr = rawTopicStr;
        let rulesStr = rawRulesStr;
        let titleStr = rawTitleStr;
        let promptMasked = false;
        let workingAttachments = rawAttachments;
        let flaggedImagesCount = 0;

        if (shieldMode !== "off") {
          const topicScan = scanAndRedactText(rawTopicStr, shieldMode);
          const rulesScan = rawRulesStr
            ? scanAndRedactText(rawRulesStr, shieldMode)
            : null;

          // OCR 100% local em imagens anexadas (Windows WinRT OCR)
          const imageAttachments = (rawAttachments ?? []).filter(
            (a) => a.kind === "image" && Boolean(a.dataBase64)
          );
          const imageScans: ImagePrivacyScanResult[] =
            imageAttachments.length > 0
              ? await Promise.all(
                  imageAttachments.map((att) =>
                    scanImageAttachmentForPrivacy(att, shieldMode)
                  )
                )
              : [];
          const flaggedImages = imageScans.filter((s) => s.hasFindings);
          flaggedImagesCount = flaggedImages.length;

          const combinedFindings = mergePrivacyFindings([
            topicScan.findings,
            ...(rulesScan ? [rulesScan.findings] : []),
            ...flaggedImages.map((img) => img.findings)
          ]);

          if (combinedFindings.length > 0 && !privacyAction) {
            sendJson(
              response,
              409,
              {
                code: "PRIVACY_SHIELD_WARNING",
                mode: shieldMode,
                error:
                  flaggedImages.length > 0
                    ? "Escudo de Privacidade: dados sensíveis detectados na mensagem ou em imagem anexada (OCR local)."
                    : "Escudo de Privacidade: dados sensíveis detectados na mensagem antes do envio às IAs.",
                findings: combinedFindings,
                ...(flaggedImages.length > 0
                  ? {
                      imageFindings: flaggedImages.map((img) => ({
                        attachmentName: img.attachmentName,
                        findings: img.findings,
                        sensitiveBoxes: img.sensitiveBoxes,
                        imageWidth: img.imageWidth,
                        imageHeight: img.imageHeight
                      }))
                    }
                  : {})
              },
              origin
            );
            return true;
          }

          if (combinedFindings.length > 0 && privacyAction === "mask") {
            if (topicScan.hasFindings) {
              topicStr = topicScan.redactedText;
              promptMasked = true;
            }
            if (rulesScan && rulesScan.hasFindings) {
              rulesStr = rulesScan.redactedText;
              promptMasked = true;
            }
            if (titleStr) {
              titleStr = scanAndRedactText(titleStr, shieldMode).redactedText;
            }
            // Defesa em profundidade: se um chamador externo mandou mask sem tarjar a imagem, remove a imagem sinalizada
            if (flaggedImages.length > 0 && workingAttachments) {
              const flaggedNames = new Set(flaggedImages.map((i) => i.attachmentName));
              workingAttachments = workingAttachments.filter(
                (att) => !(att.kind === "image" && flaggedNames.has(att.name))
              );
            }
          }
        }

        const requestedInteractionMode: InteractionMode =
          payload.interactionMode === "direct" ? "direct" : "debate";
        const useAutoRoute = payload.routingMode === "auto";
        const autoSelectInteraction = payload.autoSelectInteraction === true;

        const linkedProjectObj = projectId
          ? await getProjectById(projectId).catch(() => null)
          : null;
        const hasLinkedFolder = Boolean(linkedProjectObj?.linkedFolderPath?.trim());
        const isLocalPcReq = auth.isDirectLocalPCRequest(request);
        const folderPolicy = normalizeFolderPolicy(payload.folderPolicy);

        const isLocalCodeTask =
          hasLinkedFolder &&
          classifyBuilderIntent({
            prompt: topicStr,
            hasLinkedFolder,
            isLocalPc: isLocalPcReq,
            folderPolicy,
            interactionMode: "direct",
            participantCount: 1
          }).level === "write_explicit";

        const [webSources, rawProjectContext, rawEnrichedAttachments] =
          await Promise.all([
            gatherWebContext(topicStr, {
              mode: webSearchMode,
              hasAttachments: Boolean(workingAttachments && workingAttachments.length > 0),
              isLocalCodeTask
            }).catch(() => []),
            gatherProjectContext(projectId, topicStr).catch(() => null),
            enrichPdfAttachments(workingAttachments).catch(() => workingAttachments)
          ]);

        // Modo Híbrido: anexos, PDFs e arquivos de Projeto são mascarados automaticamente
        const shieldedAttachments = redactAttachmentsForShield(
          rawEnrichedAttachments,
          shieldMode
        );
        const shieldedProject = redactProjectContextForShield(
          rawProjectContext,
          shieldMode
        );
        const enrichedAttachments = shieldedAttachments.attachments;
        const resolvedProjectContext = shieldedProject.context;

        const responseMode =
          payload.responseMode === "auto"
            ? resolveAutoResponseMode({
                prompt: topicStr,
                hasLinkedFolder,
                attachments: enrichedAttachments
              })
            : payload.responseMode === "normal"
              ? "normal"
              : "prompt_markdown";

        let interactionMode: InteractionMode = requestedInteractionMode;
        let resolvedTotalRounds = Number(payload.totalRounds) || 2;
        let autoRoute;

        if (useAutoRoute && autoSelectInteraction) {
          const linkedFolderPath = linkedProjectObj?.linkedFolderPath?.trim();
          const hasExistingWorkspaceFiles = linkedFolderPath
            ? (await listWorkspaceSourceFiles(linkedFolderPath, 4).catch(() => [])).length > 0
            : false;
          const strategy = await routeAutoComposerStrategy({
            prompt: topicStr,
            isContinuation: false,
            hasLinkedFolder,
            hasExistingWorkspaceFiles,
            isLocalPc: isLocalPcReq,
            folderPolicy,
            responseMode,
            attachments: enrichedAttachments,
            webSources,
            resolvedProjectContext
          });
          interactionMode = strategy.interactionMode;
          resolvedTotalRounds = strategy.totalRounds;
          autoRoute = strategy.autoRoute;
        } else if (useAutoRoute) {
          autoRoute = await routeAutoParticipants({
            prompt: topicStr,
            responseMode,
            interactionMode,
            attachments: enrichedAttachments,
            webSources,
            resolvedProjectContext
          });
        }

        const finalParticipants = autoRoute
          ? autoRoute.participants
          : rawParticipants;

        const intentDecision = classifyBuilderIntent({
          prompt: topicStr,
          hasLinkedFolder,
          isLocalPc: isLocalPcReq,
          folderPolicy,
          interactionMode,
          participantCount: finalParticipants.length
        });

        const effectiveBuilderMode =
          payload.builderMode === true || intentDecision.shouldActivateBuilder;
        const effectiveBuilderAutoApply =
          isLocalPcReq &&
          (payload.builderMode === true
            ? payload.builderAutoApply === true
            : intentDecision.shouldAutoApply);
        // Onda 4: salva imagens anexadas diretamente em public/assets/slot-N.<ext> quando houver pasta local vinculada
        const linkedFolderPathForAssets = linkedProjectObj?.linkedFolderPath?.trim();
        let slotAssetHint = "";
        let instantSlotSummary: string | null = null;
        if (
          isLocalPcReq &&
          linkedFolderPathForAssets &&
          folderPolicy !== "readonly" &&
          enrichedAttachments?.some((a) => a.kind === "image")
        ) {
          const slotRes = await applyImageSlotsToWorkspace(
            linkedFolderPathForAssets,
            topicStr,
            enrichedAttachments
          ).catch(() => null);
          if (slotRes && slotRes.savedAssets.length > 0) {
            const mappedList = slotRes.savedAssets
              .map((s) => `Imagem ${s.slot} → \`${s.publicUrl}\` (${s.relPath})`)
              .join("; ");
            slotAssetHint = `Fotos reais anexadas já salvas na pasta do projeto: ${mappedList}. Use EXATAMENTE esses caminhos src="/assets/..." nos atributos data-image-slot correspondentes.`;
            if (slotRes.updatedHtml && isPureImageSlotSwapRequest(topicStr)) {
              instantSlotSummary = [
                `### Imagens aplicadas automaticamente na Landing Page`,
                "",
                ...slotRes.savedAssets.map(
                  (s) => `- **Espaço Imagem ${s.slot}:** salvo em \`${s.relPath}\` e conectado em \`public/index.html\` (\`${s.publicUrl}\`).`
                ),
                "",
                `Backup criado em \`.ai-council-backup/\`. Recarregue o preview do site para ver as fotos aplicadas!`
              ].join("\n");
            }
          }
        }

        const effectiveRulesBase =
          intentDecision.injectBuilderHint &&
          !(rulesStr ?? "").toLowerCase().includes("modo construtor")
            ? [rulesStr, AUTO_BUILDER_HINT_RULE].filter(Boolean).join(" | ")
            : rulesStr;
        const effectiveRules = slotAssetHint
          ? [effectiveRulesBase, slotAssetHint].filter(Boolean).join(" | ")
          : effectiveRulesBase;

        const hasManualTitle =
          payload.titleAutoGenerated === false ||
          (payload.titleAutoGenerated !== true && Boolean(rawTitleStr.trim()));
        const effectiveTitle = hasManualTitle
          ? titleStr.trim()
          : buildLocalCleanTitle(topicStr);

        const effectiveAutoVerdict =
          payload.autoVerdict === false
            ? false
            : interactionMode === "direct" && finalParticipants.length >= 2;

        let session = await createDebateSession({
          title: effectiveTitle,
          topic: topicStr,
          rules: effectiveRules,
          participants: instantSlotSummary ? ["gemini"] : finalParticipants,
          totalRounds: instantSlotSummary ? 1 : resolvedTotalRounds,
          focus:
            payload.focus === "backend" || payload.focus === "frontend"
              ? payload.focus
              : "geral",
          responseMode,
          interactionMode: instantSlotSummary ? "direct" : interactionMode,
          webSearchMode,
          attachments: enrichedAttachments,
          webSources,
          ...(projectId && resolvedProjectContext ? { projectId } : {}),
          ...(resolvedProjectContext ? { resolvedProjectContext } : {}),
          ...(autoRoute ? { autoRoute } : {}),
          ...(!instantSlotSummary && effectiveAutoVerdict ? { autoVerdict: true } : {}),
          ...(!instantSlotSummary && effectiveBuilderMode ? { builderMode: true } : {}),
          ...(!instantSlotSummary && effectiveBuilderMode && effectiveBuilderAutoApply
            ? { builderAutoApply: true }
            : {})
        });

        if (instantSlotSummary) {
          const firstTask = session.tasks.find((t) => t.status === "pending");
          if (firstTask) {
            session = await submitDebateTaskResponse(
              session.id,
              { taskId: firstTask.id, content: instantSlotSummary },
              { model: "landing-image-slots" }
            );
          }
        } else {
          kickRunner();
        }

        console.log(
          "[AI Council] Sessão criada:",
          session.id,
          `(${session.responseMode}/${session.interactionMode})`
        );

        // Auto-título silencioso via Groq (~0,4s) em background quando não houver título manual
        if (!hasManualTitle) {
          void scheduleAutoTitleForDebate(session.id, topicStr, session.title);
        }

        sendJson(
          response,
          201,
          {
            created: true,
            debate: slimDebateForDashboard(session, true),
            privacyShield: {
              mode: shieldMode,
              promptMasked,
              attachmentsMaskedCount: shieldedAttachments.redactedCount,
              projectMaskedCount: shieldedProject.redactedCount,
              imagesScannedFlaggedCount: flaggedImagesCount
            }
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
                : "Não foi possível criar a conversa."
          },
          origin
        );
      }
      return true;
    }
  }

  // Ações de conversa (/debates/:id/:action)
  const debateActionMatch = url.pathname.match(
    /^\/debates\/([0-9a-fA-F-]{8,64})\/(respond|pause|stop|resume|message|edit|regenerate|review|verdict|memory|rename|delete|pin|project)$/
  );

  if (debateActionMatch && request.method === "POST") {
    if (!auth.isAuthorizedLocalClient(request)) {
      sendJson(response, 401, { error: "Não autorizado." }, origin);
      return true;
    }

    const debateId = debateActionMatch[1] ?? "";
    const action = debateActionMatch[2] ?? "";

    let payload: Record<string, unknown> = {};
    try {
      const body = await readRequestBody(
        request,
        action === "message" ? MAX_MEDIA_BODY_SIZE : MAX_BODY_SIZE
      );
      if (body.trim()) {
        const parsed: unknown = JSON.parse(body);
        if (isRecord(parsed)) {
          payload = parsed;
        }
      }
    } catch {
      sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
      return true;
    }

    try {
      if (action === "message") {
        const rawParticipants = Array.isArray(payload.participants)
          ? payload.participants.filter(
              (p): p is AIPlatform =>
                typeof p === "string" && VALID_PARTICIPANTS.has(p)
            )
          : [];
        const rawAttachments = Array.isArray(payload.attachments)
          ? (payload.attachments as ChatAttachment[])
          : undefined;
        const webSearchMode: WebSearchMode =
          payload.webSearchMode === "off" ? "off" : "auto";
        const rawMessageStr =
          typeof payload.message === "string" ? payload.message : "";
        const rawRulesStr =
          typeof payload.rules === "string" ? payload.rules : undefined;
        const privacyAction = normalizePrivacyAction(payload.privacyAction);

        const privacySettings = await readPrivacySettings();
        const shieldMode = privacySettings.shieldMode;

        let messageStr = rawMessageStr;
        let rulesStr = rawRulesStr;
        let promptMasked = false;
        let workingAttachments = rawAttachments;
        let flaggedImagesCount = 0;

        if (shieldMode !== "off") {
          const msgScan = scanAndRedactText(rawMessageStr, shieldMode);
          const rulesScan = rawRulesStr
            ? scanAndRedactText(rawRulesStr, shieldMode)
            : null;

          const imageAttachments = (rawAttachments ?? []).filter(
            (a) => a.kind === "image" && Boolean(a.dataBase64)
          );
          const imageScans: ImagePrivacyScanResult[] =
            imageAttachments.length > 0
              ? await Promise.all(
                  imageAttachments.map((att) =>
                    scanImageAttachmentForPrivacy(att, shieldMode)
                  )
                )
              : [];
          const flaggedImages = imageScans.filter((s) => s.hasFindings);
          flaggedImagesCount = flaggedImages.length;

          const combinedFindings = mergePrivacyFindings([
            msgScan.findings,
            ...(rulesScan ? [rulesScan.findings] : []),
            ...flaggedImages.map((img) => img.findings)
          ]);

          if (combinedFindings.length > 0 && !privacyAction) {
            sendJson(
              response,
              409,
              {
                code: "PRIVACY_SHIELD_WARNING",
                mode: shieldMode,
                error:
                  flaggedImages.length > 0
                    ? "Escudo de Privacidade: dados sensíveis detectados na mensagem ou em imagem anexada (OCR local)."
                    : "Escudo de Privacidade: dados sensíveis detectados na mensagem antes do envio às IAs.",
                findings: combinedFindings,
                ...(flaggedImages.length > 0
                  ? {
                      imageFindings: flaggedImages.map((img) => ({
                        attachmentName: img.attachmentName,
                        findings: img.findings,
                        sensitiveBoxes: img.sensitiveBoxes,
                        imageWidth: img.imageWidth,
                        imageHeight: img.imageHeight
                      }))
                    }
                  : {})
              },
              origin
            );
            return true;
          }

          if (combinedFindings.length > 0 && privacyAction === "mask") {
            if (msgScan.hasFindings) {
              messageStr = msgScan.redactedText;
              promptMasked = true;
            }
            if (rulesScan && rulesScan.hasFindings) {
              rulesStr = rulesScan.redactedText;
              promptMasked = true;
            }
            if (flaggedImages.length > 0 && workingAttachments) {
              const flaggedNames = new Set(flaggedImages.map((i) => i.attachmentName));
              workingAttachments = workingAttachments.filter(
                (att) => !(att.kind === "image" && flaggedNames.has(att.name))
              );
            }
          }
        }

        const existingSession = await getDebateSessionById(debateId).catch(() => null);
        const activeProjectId = existingSession?.projectId;
        const requestedInteractionMode: InteractionMode =
          payload.interactionMode === "direct" ? "direct" : "debate";
        const useAutoRoute = payload.routingMode === "auto";
        const autoSelectInteraction = payload.autoSelectInteraction === true;

        const linkedProjectObj = activeProjectId
          ? await getProjectById(activeProjectId).catch(() => null)
          : null;
        const hasLinkedFolder = Boolean(linkedProjectObj?.linkedFolderPath?.trim());
        const isLocalPcReq = auth.isDirectLocalPCRequest(request);
        const folderPolicy = normalizeFolderPolicy(payload.folderPolicy);

        const isLocalCodeTask =
          hasLinkedFolder &&
          classifyBuilderIntent({
            prompt: messageStr,
            hasLinkedFolder,
            isLocalPc: isLocalPcReq,
            folderPolicy,
            interactionMode: "direct",
            participantCount: 1
          }).level === "write_explicit";

        const [webSources, rawProjectContext, rawEnrichedAttachments] =
          await Promise.all([
            gatherWebContext(messageStr, {
              mode: webSearchMode,
              hasAttachments: Boolean(workingAttachments && workingAttachments.length > 0),
              isLocalCodeTask
            }).catch(() => []),
            gatherProjectContext(activeProjectId, messageStr).catch(() => null),
            enrichPdfAttachments(workingAttachments).catch(() => workingAttachments)
          ]);

        const shieldedAttachments = redactAttachmentsForShield(
          rawEnrichedAttachments,
          shieldMode
        );
        const shieldedProject = redactProjectContextForShield(
          rawProjectContext,
          shieldMode
        );
        const enrichedAttachments = shieldedAttachments.attachments;
        const resolvedProjectContext = shieldedProject.context;

        const responseMode =
          payload.responseMode === "auto"
            ? resolveAutoResponseMode({
                prompt: messageStr,
                hasLinkedFolder,
                attachments: enrichedAttachments
              })
            : payload.responseMode === "normal"
              ? "normal"
              : "prompt_markdown";

        let interactionMode: InteractionMode = requestedInteractionMode;
        let resolvedTotalRounds = Number(payload.totalRounds) || 2;
        let autoRoute;

        if (useAutoRoute && autoSelectInteraction) {
          const strategy = await routeAutoComposerStrategy({
            prompt: messageStr,
            isContinuation: true,
            hasLinkedFolder,
            isLocalPc: isLocalPcReq,
            folderPolicy,
            responseMode,
            attachments: enrichedAttachments,
            webSources,
            resolvedProjectContext
          });
          interactionMode = strategy.interactionMode;
          resolvedTotalRounds = strategy.totalRounds;
          autoRoute = strategy.autoRoute;
        } else if (useAutoRoute) {
          autoRoute = await routeAutoParticipants({
            prompt: messageStr,
            responseMode,
            interactionMode,
            attachments: enrichedAttachments,
            webSources,
            resolvedProjectContext
          });
        }

        const finalParticipants = autoRoute
          ? autoRoute.participants
          : rawParticipants;

        const intentDecision = classifyBuilderIntent({
          prompt: messageStr,
          hasLinkedFolder,
          isLocalPc: isLocalPcReq,
          folderPolicy,
          interactionMode,
          participantCount: finalParticipants.length
        });

        const effectiveBuilderMode =
          payload.builderMode === true || intentDecision.shouldActivateBuilder;
        const effectiveBuilderAutoApply =
          isLocalPcReq &&
          (payload.builderMode === true
            ? payload.builderAutoApply === true
            : intentDecision.shouldAutoApply);
        // Onda 4: salva imagens anexadas diretamente em public/assets/slot-N.<ext> quando houver pasta local vinculada
        const linkedFolderPathForAssets = linkedProjectObj?.linkedFolderPath?.trim();
        let slotAssetHint = "";
        let instantSlotSummary: string | null = null;
        if (
          isLocalPcReq &&
          linkedFolderPathForAssets &&
          folderPolicy !== "readonly" &&
          enrichedAttachments?.some((a) => a.kind === "image")
        ) {
          const slotRes = await applyImageSlotsToWorkspace(
            linkedFolderPathForAssets,
            messageStr,
            enrichedAttachments
          ).catch(() => null);
          if (slotRes && slotRes.savedAssets.length > 0) {
            const mappedList = slotRes.savedAssets
              .map((s) => `Imagem ${s.slot} → \`${s.publicUrl}\` (${s.relPath})`)
              .join("; ");
            slotAssetHint = `Fotos reais anexadas já salvas na pasta do projeto: ${mappedList}. Use EXATAMENTE esses caminhos src="/assets/..." nos atributos data-image-slot correspondentes.`;
            if (slotRes.updatedHtml && isPureImageSlotSwapRequest(messageStr)) {
              instantSlotSummary = [
                `### Imagens aplicadas automaticamente na Landing Page`,
                "",
                ...slotRes.savedAssets.map(
                  (s) => `- **Espaço Imagem ${s.slot}:** salvo em \`${s.relPath}\` e conectado em \`public/index.html\` (\`${s.publicUrl}\`).`
                ),
                "",
                `Backup criado em \`.ai-council-backup/\`. Recarregue o preview do site para ver as fotos aplicadas!`
              ].join("\n");
            }
          }
        }

        const effectiveRulesBase =
          intentDecision.injectBuilderHint &&
          !(rulesStr ?? "").toLowerCase().includes("modo construtor")
            ? [rulesStr, AUTO_BUILDER_HINT_RULE].filter(Boolean).join(" | ")
            : rulesStr;
        const effectiveRules = slotAssetHint
          ? [effectiveRulesBase, slotAssetHint].filter(Boolean).join(" | ")
          : effectiveRulesBase;

        const effectiveAutoVerdict =
          payload.autoVerdict === false
            ? false
            : interactionMode === "direct" && finalParticipants.length >= 2;

        let updated = await continueDebateSession(debateId, {
          message: messageStr,
          rules: effectiveRules,
          participants: instantSlotSummary ? ["gemini"] : finalParticipants,
          totalRounds: instantSlotSummary ? 1 : resolvedTotalRounds,
          focus:
            payload.focus === "backend" || payload.focus === "frontend"
              ? payload.focus
              : "geral",
          responseMode,
          interactionMode: instantSlotSummary ? "direct" : interactionMode,
          webSearchMode,
          attachments: enrichedAttachments,
          webSources,
          ...(resolvedProjectContext ? { resolvedProjectContext } : {}),
          ...(autoRoute ? { autoRoute } : {}),
          ...(!instantSlotSummary && effectiveAutoVerdict ? { autoVerdict: true } : {}),
          ...(!instantSlotSummary && effectiveBuilderMode ? { builderMode: true } : {}),
          ...(!instantSlotSummary && effectiveBuilderMode && effectiveBuilderAutoApply
            ? { builderAutoApply: true }
            : {})
        });

        if (instantSlotSummary) {
          const pendingTask = updated.tasks.filter((t) => t.status === "pending").at(-1);
          if (pendingTask) {
            updated = await submitDebateTaskResponse(
              updated.id,
              { taskId: pendingTask.id, content: instantSlotSummary },
              { model: "landing-image-slots" }
            );
          }
        } else {
          kickRunner();
        }
        sendJson(
          response,
          200,
          {
            updated: true,
            debate: slimDebateForDashboard(updated, true),
            privacyShield: {
              mode: shieldMode,
              promptMasked,
              attachmentsMaskedCount: shieldedAttachments.redactedCount,
              projectMaskedCount: shieldedProject.redactedCount,
              imagesScannedFlaggedCount: flaggedImagesCount
            }
          },
          origin
        );
        return true;
      }

      if (action === "edit") {
        const turnId = typeof payload.turnId === "string" ? payload.turnId.trim() : "";
        const rawEditedMessage =
          typeof payload.message === "string" ? payload.message.trim() : "";
        const privacyAction = normalizePrivacyAction(payload.privacyAction);

        if (!turnId || !rawEditedMessage) {
          sendJson(
            response,
            400,
            { error: "Informe turnId e o novo texto da mensagem." },
            origin
          );
          return true;
        }

        const privacySettings = await readPrivacySettings();
        const shieldMode = privacySettings.shieldMode;
        let editedMessage = rawEditedMessage;
        let promptMasked = false;

        if (shieldMode !== "off") {
          const editScan = scanAndRedactText(rawEditedMessage, shieldMode);
          if (editScan.hasFindings && !privacyAction) {
            sendJson(
              response,
              409,
              {
                code: "PRIVACY_SHIELD_WARNING",
                mode: shieldMode,
                error:
                  "Escudo de Privacidade: dados sensíveis detectados na mensagem editada.",
                findings: editScan.findings
              },
              origin
            );
            return true;
          }
          if (editScan.hasFindings && privacyAction === "mask") {
            editedMessage = editScan.redactedText;
            promptMasked = true;
          }
        }

        const existingSession = await getDebateSessionById(debateId);
        if (!existingSession) {
          sendJson(response, 404, { error: "Conversa não encontrada." }, origin);
          return true;
        }

        const targetTurn = existingSession.turns?.find((t) => t.id === turnId);
        if (!targetTurn) {
          sendJson(response, 404, { error: "Turno não encontrado." }, origin);
          return true;
        }

        const webSearchMode: WebSearchMode =
          targetTurn.webSearchMode === "off" ? "off" : "auto";
        const preservedAttachments = targetTurn.attachments;

        const [webSources, rawProjectContext] = await Promise.all([
          gatherWebContext(editedMessage, {
            mode: webSearchMode,
            hasAttachments: Boolean(preservedAttachments && preservedAttachments.length > 0)
          }).catch(() => []),
          gatherProjectContext(existingSession.projectId, editedMessage).catch(() => null)
        ]);

        const shieldedProject = redactProjectContextForShield(
          rawProjectContext,
          shieldMode
        );
        const resolvedProjectContext = shieldedProject.context;

        const reAutoRoute = targetTurn.autoRoute
          ? await routeAutoParticipants({
              prompt: editedMessage,
              responseMode: targetTurn.responseMode,
              interactionMode: targetTurn.interactionMode,
              attachments: preservedAttachments,
              webSources,
              resolvedProjectContext
            })
          : undefined;

        abortDebateTasks(debateId);
        const updated = await editTurnAndRewind(debateId, turnId, {
          message: editedMessage,
          ...(reAutoRoute ? { participants: reAutoRoute.participants, autoRoute: reAutoRoute } : {}),
          webSources,
          resolvedProjectContext
        });

        kickRunner();
        sendJson(
          response,
          200,
          {
            updated: true,
            debate: slimDebateForDashboard(updated, true),
            privacyShield: {
              mode: shieldMode,
              promptMasked,
              attachmentsMaskedCount: 0,
              projectMaskedCount: shieldedProject.redactedCount
            }
          },
          origin
        );
        return true;
      }

      if (action === "regenerate") {
        const responseId =
          typeof payload.responseId === "string" ? payload.responseId : "";
        const updated = await regenerateDebateResponse(debateId, responseId);
        kickRunner();
        sendJson(
          response,
          200,
          { updated: true, debate: slimDebateForDashboard(updated, true) },
          origin
        );
        return true;
      }

      if (action === "review") {
        const responseId =
          typeof payload.responseId === "string" ? payload.responseId : "";
        const reviewer =
          typeof payload.reviewer === "string" &&
          VALID_PARTICIPANTS.has(payload.reviewer)
            ? (payload.reviewer as AIPlatform)
            : null;

        if (!reviewer) {
          sendJson(
            response,
            400,
            { error: "Selecione uma IA válida para revisar." },
            origin
          );
          return true;
        }

        const updated = await reviewDebateResponseWithPlatform(
          debateId,
          responseId,
          reviewer
        );
        kickRunner();
        sendJson(
          response,
          200,
          { updated: true, debate: slimDebateForDashboard(updated, true) },
          origin
        );
        return true;
      }

      if (action === "verdict") {
        const turnId =
          typeof payload.turnId === "string" && payload.turnId.trim()
            ? payload.turnId.trim()
            : undefined;
        const judge =
          payload.judge === "gemini" ||
          payload.judge === "groq" ||
          payload.judge === "openrouter" ||
          payload.judge === "nvidia"
            ? payload.judge
            : undefined;

        const { debate: updated, verdict } = await generateTurnVerdict(
          debateId,
          { turnId, judge }
        );
        sendJson(
          response,
          200,
          {
            updated: true,
            verdict,
            debate: slimDebateForDashboard(updated, true)
          },
          origin
        );
        return true;
      }

      if (action === "memory") {
        const summary =
          typeof payload.summary === "string" ? payload.summary : "";
        const updated = await updateSessionSharedMemoryManually(debateId, summary);
        sendJson(
          response,
          200,
          { updated: true, debate: slimDebateForDashboard(updated, true) },
          origin
        );
        return true;
      }

      if (action === "respond") {
        const taskId = typeof payload.taskId === "string" ? payload.taskId : "";
        const content = typeof payload.content === "string" ? payload.content : "";
        const updated = await submitDebateTaskResponse(debateId, {
          taskId,
          content
        });
        kickRunner();
        sendJson(
          response,
          200,
          { updated: true, debate: slimDebateForDashboard(updated, true) },
          origin
        );
        return true;
      }

      if (action === "stop") {
        const partials = abortDebateTasks(debateId);
        const updated = await stopDebateGeneration(debateId, partials);
        sendJson(
          response,
          200,
          { stopped: true, debate: slimDebateForDashboard(updated, true) },
          origin
        );
        return true;
      }

      if (action === "pause") {
        abortDebateTasks(debateId);
        const reason =
          typeof payload.reason === "string" ? payload.reason : undefined;
        const updated = await pauseDebateManually(debateId, reason);
        sendJson(
          response,
          200,
          { updated: true, debate: slimDebateForDashboard(updated, true) },
          origin
        );
        return true;
      }

      if (action === "resume") {
        const updated = await resumeDebateSession(debateId);
        kickRunner();
        sendJson(
          response,
          200,
          { updated: true, debate: slimDebateForDashboard(updated, true) },
          origin
        );
        return true;
      }

      if (action === "rename") {
        const title = typeof payload.title === "string" ? payload.title : "";
        const updated = await renameDebateSession(debateId, title);
        sendJson(
          response,
          200,
          { updated: true, debate: slimDebateForDashboard(updated, true) },
          origin
        );
        return true;
      }

      if (action === "pin") {
        const pinned =
          typeof payload.pinned === "boolean" ? payload.pinned : undefined;
        const updated = await togglePinDebateSession(debateId, pinned);
        sendJson(
          response,
          200,
          { updated: true, debate: slimDebateForDashboard(updated, true) },
          origin
        );
        return true;
      }

      if (action === "project") {
        const nextProjectId =
          typeof payload.projectId === "string" && payload.projectId.trim()
            ? payload.projectId.trim()
            : null;
        const updated = await assignDebateToProject(debateId, nextProjectId);
        sendJson(
          response,
          200,
          { updated: true, debate: slimDebateForDashboard(updated, true) },
          origin
        );
        return true;
      }

      if (action === "delete") {
        const deleted = await deleteDebateSession(debateId);
        if (!deleted) {
          sendJson(response, 404, { error: "Conversa não encontrada." }, origin);
          return true;
        }
        sendJson(response, 200, { deleted: true, id: debateId }, origin);
        return true;
      }
    } catch (error) {
      sendJson(
        response,
        400,
        {
          error:
            error instanceof Error
              ? error.message
              : "Erro ao atualizar o debate."
        },
        origin
      );
      return true;
    }
  }

  return false;
}
