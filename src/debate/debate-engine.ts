import { randomUUID } from "node:crypto";

import type {
  AIPlatform,
  CreateDebateInput,
  DebateResponse,
  DebateSession,
  DebateStage,
  DebateTask,
  ParticipantState,
  SubmitResponseInput
} from "../shared/debate-types.js";

import {
  readDebateSessions,
  withDebateLock,
  writeDebateSessionsAtomically
} from "../persistence/debate-store.js";

const PLATFORM_NAMES: Record<AIPlatform, string> = {
  chatgpt: "ChatGPT",
  claude: "Claude",
  gemini: "Gemini Argon"
};

const DEFAULT_RULES =
  "Responda diretamente ao problema com profundidade prática, exemplos concretos, código funcional (se aplicável) e rigor técnico.";

// Usa cerca de 4 tils (~~~~markdown) para que blocos internos de código (```) NÃO quebrem o bloco único no ChatGPT/Claude/Gemini!
const MARKDOWN_FORMAT_INSTRUCTION = [
  `REGRA ABSOLUTA DE FORMATO (BLOCO MARKDOWN ÚNICO):`,
  `- Você DEVE colocar 100% da sua resposta dentro de UM ÚNICO bloco cercado por 4 tils, começando exatamente com \`~~~markdown\` (ou \`~~~~markdown\`) na primeira linha e fechando com \`~~~~\` na última linha.`,
  `- Se precisar mostrar exemplos de código (SQL, JS, Python, HTML, etc.) dentro da explicação, use 3 crases (\`\`\`) normalmente lá dentro, pois o bloco externo de 4 tils (\`~~~~markdown\`) manterá tudo dentro de uma única caixa copiável sem quebrar!`,
  `- Não escreva absolutamente NADA fora desse bloco único e, na última linha antes de fechar o bloco, escreva: [FIM_DA_RESPOSTA]`
].join("\n");

function createInitialParticipantStates(
  participants: AIPlatform[]
): Record<AIPlatform, ParticipantState> {
  const allPlatforms: AIPlatform[] = ["chatgpt", "claude", "gemini"];
  const states = {} as Record<AIPlatform, ParticipantState>;

  for (const platform of allPlatforms) {
    if (participants.includes(platform)) {
      states[platform] = {
        platform,
        availability: "unknown"
      };
    }
  }

  return states;
}

function buildInitialPrompt(
  title: string,
  topic: string,
  rules: string,
  platform: AIPlatform
): string {
  const aiName = PLATFORM_NAMES[platform];

  return [
    `Você é ${aiName} atuando no conselho técnico AI Council.`,
    `Tema: ${title}`,
    ``,
    `PEDIDO DO USUÁRIO:`,
    `"${topic}"`,
    ``,
    `DIRETRIZ TÉCNICA:`,
    `${rules}`,
    ``,
    `SUA MISSÃO NESTA RODADA 1:`,
    `Entregue uma explicação completa, didática e prática que resolva diretamente o pedido do usuário (incluindo todos os elementos, estrutura, passos e exemplos práticos/código).`,
    ``,
    MARKDOWN_FORMAT_INSTRUCTION
  ].join("\n");
}

function buildCritiquePrompt(
  session: DebateSession,
  round: number,
  platform: AIPlatform
): string {
  const aiName = PLATFORM_NAMES[platform];
  const previousRound = round - 1;

  const previousResponses = session.responses.filter(
    (resp) => resp.round === previousRound
  );

  const formattedResponses = previousResponses
    .map((resp) => {
      const authorLabel =
        resp.platform === platform
          ? `${PLATFORM_NAMES[resp.platform]} (Sua resposta anterior)`
          : PLATFORM_NAMES[resp.platform];

      return [
        `--- INÍCIO DA RESPOSTA DE ${authorLabel.toUpperCase()} ---`,
        resp.content.trim(),
        `--- FIM DA RESPOSTA DE ${authorLabel.toUpperCase()} ---`
      ].join("\n");
    })
    .join("\n\n");

  return [
    `Rodada ${round} do AI Council sobre o pedido: "${session.topic}"`,
    `Diretriz técnica: ${session.rules}`,
    ``,
    `Veja abaixo o que cada inteligência respondeu na Rodada ${previousRound}:`,
    ``,
    formattedResponses,
    ``,
    `SUA MISSÃO NESTA RODADA ${round} (${aiName.toUpperCase()}):`,
    `1. Avalie as respostas das outras inteligências acima: destaque os melhores pontos e corrija o que estiver faltando ou incompleto.`,
    `2. Monte uma resposta consolidada e aprimorada que una a sua explicação com as melhores partes das outras inteligências.`,
    ``,
    MARKDOWN_FORMAT_INSTRUCTION
  ].join("\n");
}

function buildSynthesisPrompt(
  session: DebateSession,
  platform: AIPlatform
): string {
  const aiName = PLATFORM_NAMES[platform];
  const lastRound = session.totalRounds;

  const latestResponses = session.responses.filter(
    (resp) => resp.round === lastRound
  );

  const formattedLatest = latestResponses
    .map(
      (resp) =>
        `--- POSIÇÃO DE ${PLATFORM_NAMES[resp.platform].toUpperCase()} ---\n${resp.content.trim()}`
    )
    .join("\n\n");

  return [
    `ETAPA FINAL DE SÍNTESE E CONCLUSÃO DO AI COUNCIL`,
    `Relator Oficial: ${aiName}`,
    `Pedido original do usuário: "${session.topic}"`,
    `Diretriz aplicada: ${session.rules}`,
    ``,
    `Respostas finais das inteligências na Rodada ${lastRound}:`,
    ``,
    formattedLatest,
    ``,
    `SUA MISSÃO FINAL COMO RELATOR (${aiName.toUpperCase()}):`,
    `Elabore o DOCUMENTO FINAL DEFINITIVO para o usuário em Markdown, contendo obrigatoriamente:`,
    `1. # SOLUÇÃO DEFINITIVA E COMPLETA (Explicação completa, todos os elementos, instruções passo a passo e códigos/exemplos prontos sobre "${session.topic}").`,
    `2. ## AVAL E CONCLUSÃO DO CONSELHO (Resumo objetivo do consenso entre ChatGPT, Claude e Gemini Argon aprovando esta solução).`,
    ``,
    MARKDOWN_FORMAT_INSTRUCTION
  ].join("\n");
}

function createTasksForStage(
  session: DebateSession,
  round: number,
  stage: Exclude<DebateStage, "completed">
): DebateTask[] {
  const now = new Date().toISOString();

  if (stage === "synthesis") {
    const leadPlatform: AIPlatform = session.participants.includes("gemini")
      ? "gemini"
      : (session.participants[0] ?? "chatgpt");

    return [
      {
        id: randomUUID(),
        round,
        stage: "synthesis",
        platform: leadPlatform,
        prompt: buildSynthesisPrompt(session, leadPlatform),
        status: "pending",
        createdAt: now
      }
    ];
  }

  return session.participants.map((platform) => ({
    id: randomUUID(),
    round,
    stage,
    platform,
    prompt:
      stage === "initial_response"
        ? buildInitialPrompt(
            session.title,
            session.topic,
            session.rules,
            platform
          )
        : buildCritiquePrompt(session, round, platform),
    status: "pending",
    createdAt: now
  }));
}

export async function listDebateSessions(): Promise<DebateSession[]> {
  const sessions = await readDebateSessions();
  return [...sessions].sort(
    (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt)
  );
}

export async function getDebateSessionById(
  debateId: string
): Promise<DebateSession | null> {
  const sessions = await readDebateSessions();
  return sessions.find((s) => s.id === debateId) ?? null;
}

export async function deleteDebateSession(
  debateId: string
): Promise<boolean> {
  return withDebateLock(async () => {
    const sessions = await readDebateSessions();
    const filtered = sessions.filter((s) => s.id !== debateId);

    if (filtered.length === sessions.length) {
      return false;
    }

    await writeDebateSessionsAtomically(filtered);
    return true;
  });
}

export async function createDebateSession(
  input: CreateDebateInput
): Promise<DebateSession> {
  const uniqueParticipants = Array.from(new Set(input.participants));

  if (uniqueParticipants.length < 2) {
    throw new Error(
      "O debate precisa ter pelo menos 2 inteligências participantes."
    );
  }

  const totalRounds = Math.min(Math.max(Number(input.totalRounds) || 2, 1), 5);
  const now = new Date().toISOString();
  const title = input.title.trim();
  const topic = input.topic.trim();
  const rules = (input.rules || DEFAULT_RULES).trim();

  if (!title || !topic) {
    throw new Error("Título e tema do debate são obrigatórios.");
  }

  return withDebateLock(async () => {
    const sessions = await readDebateSessions();

    // Pausa debates antigos que tenham ficado abertos para que o novo debate seja o único ativo (running)
    for (const old of sessions) {
      if (old.status === "running") {
        old.status = "paused_manual";
        old.pauseInfo = {
          reason: "manual_pause",
          message: "Pausado automaticamente ao iniciar um novo debate.",
          pausedAt: now
        };
      }
    }

    const newSession: DebateSession = {
      id: randomUUID(),
      title,
      topic,
      rules,
      participants: uniqueParticipants,
      totalRounds,
      currentRound: 1,
      currentStage: "initial_response",
      status: "running",
      participantStates: createInitialParticipantStates(uniqueParticipants),
      tasks: [],
      responses: [],
      createdAt: now,
      updatedAt: now
    };

    newSession.tasks = createTasksForStage(
      newSession,
      1,
      "initial_response"
    );

    sessions.push(newSession);
    await writeDebateSessionsAtomically(sessions);

    return newSession;
  });
}

export async function submitDebateTaskResponse(
  debateId: string,
  input: SubmitResponseInput
): Promise<DebateSession> {
  const content = input.content
    .replace(/^~~~~+markdown\s*/i, "")
    .replace(/^~~~+markdown\s*/i, "")
    .replace(/^```+markdown\s*/i, "")
    .replace(/~~~~+\s*$/i, "")
    .replace(/\[FIM_DA_RESPOSTA\]/gi, "")
    .trim();

  if (!content) {
    throw new Error("O conteúdo da resposta não pode estar vazio.");
  }

  return withDebateLock(async () => {
    const sessions = await readDebateSessions();
    const session = sessions.find((s) => s.id === debateId);

    if (!session) {
      throw new Error("Sessão de debate não encontrada.");
    }

    if (session.status !== "running") {
      throw new Error(
        "Não é possível registrar respostas enquanto o debate estiver pausado ou concluído."
      );
    }

    const task = session.tasks.find((t) => t.id === input.taskId);

    if (!task) {
      throw new Error("Tarefa não encontrada neste debate.");
    }

    if (task.status === "completed") {
      return session;
    }

    if (
      content === task.prompt.trim() ||
      content.includes("REGRA ABSOLUTA DE FORMATO (BLOCO MARKDOWN ÚNICO):") ||
      content.includes("SUA MISSÃO NESTA RODADA 1:") ||
      content.includes("SUA MISSÃO FINAL COMO RELATOR")
    ) {
      throw new Error(
        "O texto capturado era o próprio prompt da pergunta. Aguardando a resposta real da IA."
      );
    }

    const now = new Date().toISOString();

    task.status = "completed";
    task.completedAt = now;

    const responseRecord: DebateResponse = {
      id: randomUUID(),
      taskId: task.id,
      round: task.round,
      stage: task.stage,
      platform: task.platform,
      promptUsed: task.prompt,
      content,
      submittedAt: now
    };

    session.responses.push(responseRecord);
    session.updatedAt = now;

    const pendingInCurrentStage = session.tasks.some(
      (t) =>
        t.round === session.currentRound &&
        t.stage === session.currentStage &&
        t.status === "pending"
    );

    if (!pendingInCurrentStage) {
      if (session.currentStage === "synthesis") {
        session.currentStage = "completed";
        session.status = "completed";
        session.conclusion = content;
        session.completedAt = now;
      } else if (session.currentRound < session.totalRounds) {
        session.currentRound += 1;
        session.currentStage = "critique";
        const nextTasks = createTasksForStage(
          session,
          session.currentRound,
          "critique"
        );
        session.tasks.push(...nextTasks);
      } else {
        session.currentStage = "synthesis";
        const synthesisTasks = createTasksForStage(
          session,
          session.currentRound,
          "synthesis"
        );
        session.tasks.push(...synthesisTasks);
      }
    }

    await writeDebateSessionsAtomically(sessions);
    return session;
  });
}

export async function pauseDebateManually(
  debateId: string,
  reasonMessage?: string
): Promise<DebateSession> {
  return withDebateLock(async () => {
    const sessions = await readDebateSessions();
    const session = sessions.find((s) => s.id === debateId);

    if (!session) {
      throw new Error("Sessão de debate não encontrada.");
    }

    if (session.status === "completed") {
      throw new Error("O debate já foi concluído.");
    }

    const now = new Date().toISOString();

    session.status = "paused_manual";
    session.pauseInfo = {
      reason: "manual_pause",
      message:
        reasonMessage?.trim() ||
        "Debate pausado manualmente pelo usuário. Todo o progresso foi salvo.",
      pausedAt: now
    };
    session.updatedAt = now;

    await writeDebateSessionsAtomically(sessions);
    return session;
  });
}

export async function resumeDebateSession(
  debateId: string
): Promise<DebateSession> {
  return withDebateLock(async () => {
    const sessions = await readDebateSessions();
    const session = sessions.find((s) => s.id === debateId);

    if (!session) {
      throw new Error("Sessão de debate não encontrada.");
    }

    if (session.status === "completed") {
      throw new Error("O debate já está concluído.");
    }

    const now = new Date().toISOString();

    if (session.pauseInfo?.blockedBy) {
      const blockedPlatform = session.pauseInfo.blockedBy;
      if (session.participantStates[blockedPlatform]) {
        session.participantStates[blockedPlatform] = {
          ...session.participantStates[blockedPlatform],
          availability: "unknown"
        };
      }
    }

    session.status = "running";
    delete session.pauseInfo;
    session.updatedAt = now;

    await writeDebateSessionsAtomically(sessions);
    return session;
  });
}

export async function applyLimitSignalToDebates(
  platform: AIPlatform,
  severity: "warning" | "blocked",
  matchedText: string,
  observedAt: string
): Promise<{ pausedDebateIds: string[] }> {
  return withDebateLock(async () => {
    const sessions = await readDebateSessions();
    const pausedDebateIds: string[] = [];
    let modified = false;

    for (const session of sessions) {
      if (!session.participants.includes(platform)) {
        continue;
      }

      if (session.status === "completed") {
        continue;
      }

      session.participantStates[platform] = {
        platform,
        availability: severity,
        lastSignalAt: observedAt,
        lastLimitMessage: matchedText
      };
      session.updatedAt = observedAt;
      modified = true;

      if (severity === "blocked" && session.status === "running") {
        session.status = "paused_limit";
        session.pauseInfo = {
          reason: "usage_limit_reached",
          blockedBy: platform,
          message: `Debate pausado automaticamente: ${PLATFORM_NAMES[platform]} atingiu o limite gratuito ("${matchedText}"). Estado preservado.`,
          pausedAt: observedAt
        };
        pausedDebateIds.push(session.id);
      }
    }

    if (modified) {
      await writeDebateSessionsAtomically(sessions);
    }

    return { pausedDebateIds };
  });
}