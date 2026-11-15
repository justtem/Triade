export type AIPlatform = "chatgpt" | "claude" | "gemini";

export type DebateStatus =
  | "running"
  | "paused_limit"
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
  round: number;
  stage: Exclude<DebateStage, "completed">;
  platform: AIPlatform;
  prompt: string;
  status: "pending" | "completed";
  createdAt: string;
  completedAt?: string;
}

export interface DebateResponse {
  id: string;
  taskId: string;
  round: number;
  stage: Exclude<DebateStage, "completed">;
  platform: AIPlatform;
  promptUsed: string;
  content: string;
  submittedAt: string;
}

export interface DebatePauseInfo {
  reason: "usage_limit_reached" | "manual_pause";
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
}

export interface CreateDebateInput {
  title: string;
  topic: string;
  rules?: string;
  participants: AIPlatform[];
  totalRounds: number;
}

export interface SubmitResponseInput {
  taskId: string;
  content: string;
}