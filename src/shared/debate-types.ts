export type AIPlatform =
  | "chatgpt"
  | "claude"
  | "gemini"
  | "groq"
  | "openrouter"
  | "nvidia";

/** Assentos automáticos: o servidor chama a API sozinho. */
export type AutoPlatform = "gemini" | "groq" | "openrouter" | "nvidia";

/** Assentos manuais: o usuário cola a resposta da interface web. */
export type ManualPlatform = "chatgpt" | "claude";

export const ALL_PLATFORMS: readonly AIPlatform[] = [
  "chatgpt",
  "claude",
  "gemini",
  "groq",
  "openrouter",
  "nvidia"
];

export const REQUIRED_AUTO_PLATFORMS: readonly AutoPlatform[] = [
  "gemini",
  "groq",
  "openrouter"
];

export const AUTO_PLATFORMS: readonly AutoPlatform[] = [
  "gemini",
  "groq",
  "openrouter",
  "nvidia"
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
  /** Quando true, a tarefa foi interrompida manualmente pelo usuário (Stop). */
  interrupted?: boolean;
}

export type AttachmentKind = "text" | "image" | "pdf";

export interface ChatAttachment {
  name: string;
  content: string;
  size: number;
  kind?: AttachmentKind;
  mimeType?: string;
  dataBase64?: string;
}

export interface PromptTemplate {
  id: string;
  tag: string;
  title: string;
  prompt: string;
  rules?: string;
  focus: DebateFocus;
  responseMode: ResponseMode;
  interactionMode: InteractionMode;
  createdAt: string;
  updatedAt: string;
}

export type ProjectFileKind = "text" | "pdf";

export interface ProjectFileMeta {
  id: string;
  name: string;
  kind: ProjectFileKind;
  mimeType?: string;
  size: number;
  charCount: number;
  uploadedAt: string;
}

export interface Project {
  id: string;
  name: string;
  description?: string;
  color?: string;
  instructions: string;
  linkedFolderPath?: string;
  files: ProjectFileMeta[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectContextChunk {
  sourceName: string;
  origin: "upload" | "folder";
  filePath?: string;
  snippet: string;
  score: number;
}

export interface ProjectContextUsed {
  projectId: string;
  projectName: string;
  instructionsApplied: boolean;
  mode: "full" | "bm25";
  totalFilesScanned: number;
  chunks: ProjectContextChunk[];
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
  /** Quando true, representa o texto parcial preservado ao clicar em Parar. */
  interrupted?: boolean;
  /** Quando true, o modelo atingiu o teto de tokens de saída (MAX_TOKENS / length). */
  truncated?: boolean;
}

export type WebSearchMode = "auto" | "off";

export interface WebSource {
  index: number;
  title: string;
  url: string;
  domain: string;
  snippet: string;
  excerpt?: string;
  origin: "url" | "search" | "grounding";
  fetchedOk?: boolean;
}

export interface TurnVerdict {
  judgePlatform: AutoPlatform;
  judgeModel?: string;
  winner: AIPlatform | "tie";
  winnerReason: string;
  consensus: string[];
  divergences: string[];
  practicalSummary: string;
  tokens?: number;
  generatedAt: string;
}

export type AutoRouteCategory =
  | "pdf"
  | "image"
  | "long_context"
  | "complex_council"
  | "debate"
  | "quick"
  | "quota_fallback";

export interface AutoRouteDecision {
  participants: AutoPlatform[];
  reason: string;
  category: AutoRouteCategory;
  skippedForQuota?: AutoPlatform[];
}

export type BuilderFileAction = "create" | "overwrite" | "delete" | "unchanged" | "blocked";

export type BuilderRunStatus =
  | "idle"
  | "extracting"
  | "generating"
  | "ready"
  | "applying"
  | "verifying"
  | "fixing"
  | "completed"
  | "failed"
  | "stopped";

export interface BuilderFileEntry {
  path: string;
  content: string;
  action: BuilderFileAction;
  blockReason?: string;
  diffPreview?: string;
  addedLines?: number;
  removedLines?: number;
  incomplete?: boolean;
}

export interface BuilderCommandRun {
  label: string;
  command: string;
  exitCode: number;
  ok: boolean;
  timedOut?: boolean;
  durationMs: number;
  output: string;
}

export interface BuilderBackupInfo {
  batchId: string;
  backupRelDir: string;
  createdAt: string;
  filesWritten: string[];
  filesCreated: string[];
  filesOverwritten: string[];
  filesDeleted?: string[];
  undone?: boolean;
}

export interface BuilderTurnState {
  enabled: boolean;
  autoApply: boolean;
  status: BuilderRunStatus;
  projectId?: string;
  summary?: string;
  files: BuilderFileEntry[];
  missingPaths?: string[];
  lastBackup?: BuilderBackupInfo;
  checks?: BuilderCommandRun[];
  fixAttempt?: number;
  maxFixAttempts?: number;
  lastError?: string;
  updatedAt: string;
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
  webSearchMode?: WebSearchMode;
  webSources?: WebSource[];
  projectContext?: ProjectContextUsed;
  autoRoute?: AutoRouteDecision;
  autoVerdict?: boolean;
  verdict?: TurnVerdict;
  builderMode?: boolean;
  builderAutoApply?: boolean;
  builderState?: BuilderTurnState;
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
  pinned?: boolean;
  projectId?: string;
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
  pinned?: boolean;
  projectId?: string;
  turnCount: number;
  sharedMemoryTurns?: number;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  engineVersion?: number;
}

export interface ProjectResolvedChunk extends ProjectContextChunk {
  content: string;
}

export interface ResolvedProjectContext {
  meta: ProjectContextUsed;
  instructions: string;
  chunks: ProjectResolvedChunk[];
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
  webSearchMode?: WebSearchMode;
  attachments?: ChatAttachment[];
  webSources?: WebSource[];
  projectId?: string;
  resolvedProjectContext?: ResolvedProjectContext;
  autoRoute?: AutoRouteDecision;
  autoVerdict?: boolean;
  builderMode?: boolean;
  builderAutoApply?: boolean;
}

export interface ContinueDebateInput {
  message: string;
  rules?: string;
  participants: AIPlatform[];
  totalRounds?: number;
  focus?: DebateFocus;
  responseMode?: ResponseMode;
  interactionMode?: InteractionMode;
  webSearchMode?: WebSearchMode;
  attachments?: ChatAttachment[];
  webSources?: WebSource[];
  resolvedProjectContext?: ResolvedProjectContext;
  autoRoute?: AutoRouteDecision;
  autoVerdict?: boolean;
  builderMode?: boolean;
  builderAutoApply?: boolean;
}

export interface EditTurnInput {
  message: string;
  participants?: AIPlatform[];
  webSources?: WebSource[];
  resolvedProjectContext?: ResolvedProjectContext | null;
  autoRoute?: AutoRouteDecision;
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
  truncated?: boolean;
}
