export type AIPlatform =
  | "chatgpt"
  | "claude"
  | "gemini"
  | "groq"
  | "openrouter";

/** Assentos automáticos: o servidor chama a API sozinho. */
export type AutoPlatform = "gemini" | "groq" | "openrouter";

/** Assentos manuais: o usuário cola a resposta da interface web. */
export type ManualPlatform = "chatgpt" | "claude";

export const ALL_PLATFORMS: readonly AIPlatform[] = [
  "chatgpt",
  "claude",
  "gemini",
  "groq",
  "openrouter"
];

export const AUTO_PLATFORMS: readonly AutoPlatform[] = [
  "gemini",
  "groq",
  "openrouter"
];

export function isAutoPlatform(
  platform: string
): platform is AutoPlatform {
  return (AUTO_PLATFORMS as readonly string[]).includes(platform);
}

export type DebateFocus = "geral" | "backend" | "frontend";

export type ResponseMode = "normal" | "prompt_markdown";

export type InteractionMode = "direct" | "debate";

export type DebateStatus =
  | "running"
  | "paused_limit"
  | "paused_error"
  | "paused_manual"
  | "completed";

export type DebateStage =
  | "initial_response"
  | "critique"
  | "synthesis"
  | "completed";

export type ParticipantAvailability =
  | "unknown"
  | "warning"
  | "blocked";

export interface ParticipantState {
  platform: AIPlatform;
  availability: ParticipantAvailability;
  lastSignalAt?: string;
  lastLimitMessage?: string;
}

export interface DebateTask {
  id: string;
  turnId?: string;
  round: number;
  stage: Exclude<DebateStage, "completed">;
  platform: AIPlatform;

  /** Prompt completo (sistema + usuário), usado para copiar nos assentos manuais. */
  prompt: string;

  status: "pending" | "completed";
  createdAt: string;
  completedAt?: string;

  // Campos da engine v2 (ausentes em debates antigos)
  seat?: "auto" | "manual";
  role?: string;
  systemPrompt?: string;
  userPrompt?: string;
  maxTokens?: number;
  attempts?: number;
  lastError?: string;
  /** Quando true, concluir esta tarefa finaliza o turno sem gerar novas rodadas/síntese. */
  singleTaskOnly?: boolean;
}

export interface ChatAttachment {
  name: string;
  content: string;
  size: number;
}

export interface DebateResponse {
  id: string;
  turnId?: string;
  taskId: string;
  round: number;
  stage: Exclude<DebateStage, "completed">;
  platform: AIPlatform;
  promptUsed: string;
  content: string;
  submittedAt: string;
  model?: string;
  tokens?: number;
}

export interface ChatTurn {
  id: string;
  index: number;
  prompt: string;
  rules: string;
  participants: AIPlatform[];
  responseMode: ResponseMode;
  interactionMode: InteractionMode;
  totalRounds: number;
  focus: DebateFocus;
  currentRound: number;
  currentStage: DebateStage;
  status: DebateStatus;
  attachments?: ChatAttachment[];
  conclusion?: string;
  createdAt: string;
  completedAt?: string;
}

export interface SharedMemoryState {
  summary: string;
  coveredTurnCount: number;
  updatedAt: string;
  model?: string;
}

export interface DebatePauseInfo {
  reason: "usage_limit_reached" | "manual_pause" | "provider_error";
  blockedBy?: AIPlatform;
  message: string;
  pausedAt: string;
}

export interface DebateSession {
  id: string;
  title: string;
  topic: string;
  rules: string;
  participants: AIPlatform[];
  totalRounds: number;
  currentRound: number;
  currentStage: DebateStage;
  status: DebateStatus;
  participantStates: Record<AIPlatform, ParticipantState>;
  tasks: DebateTask[];
  responses: DebateResponse[];
  pauseInfo?: DebatePauseInfo;
  conclusion?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;

  focus?: DebateFocus;
  responseMode?: ResponseMode;
  interactionMode?: InteractionMode;
  turns?: ChatTurn[];
  sharedMemory?: SharedMemoryState;

  /** 2 = debates criados pela engine nova (o runner só automatiza estes). */
  engineVersion?: number;
}

export interface DebateSummary {
  id: string;
  title: string;
  topic: string;
  participants: AIPlatform[];
  totalRounds: number;
  currentRound: number;
  currentStage: DebateStage;
  status: DebateStatus;
  focus?: DebateFocus;
  responseMode?: ResponseMode;
  interactionMode?: InteractionMode;
  turnCount: number;
  sharedMemoryTurns?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  engineVersion?: number;
}

export interface CreateDebateInput {
  title: string;
  topic: string;
  rules?: string;
  participants: AIPlatform[];
  totalRounds: number;
  focus?: DebateFocus;
  responseMode?: ResponseMode;
  interactionMode?: InteractionMode;
  attachments?: ChatAttachment[];
}

export interface ContinueDebateInput {
  message: string;
  rules?: string;
  participants: AIPlatform[];
  totalRounds?: number;
  focus?: DebateFocus;
  responseMode?: ResponseMode;
  interactionMode?: InteractionMode;
  attachments?: ChatAttachment[];
}

export interface SubmitResponseInput {
  taskId: string;
  content: string;
}

export interface SubmitResponseMeta {
  /** Permite registrar uma resposta de API já paga mesmo se o debate foi pausado no meio. */
  allowWhilePaused?: boolean;
  model?: string;
  tokens?: number;
}
