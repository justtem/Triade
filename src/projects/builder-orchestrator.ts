import { readFile } from "node:fs/promises";

import {
  readDebateSessionById,
  withDebateLock,
  writeDebateSessionAtomically
} from "../persistence/debate-store.js";
import { getProjectById } from "../persistence/project-store.js";
import {
  getProvider,
  getProvidersStatus,
  type ProviderStatus
} from "../providers/registry.js";
import { emitDebateUpdated } from "../debate/stream-hub.js";
import { ANTI_INJECTION_SYSTEM_RULE } from "../security/prompt-defense.js";
import type {
  AIPlatform,
  AutoPlatform,
  BuilderBackupInfo,
  BuilderCommandRun,
  BuilderFileEntry,
  BuilderTurnState,
  ChatTurn,
  DebateSession
} from "../shared/debate-types.js";
import {
  startProjectDevServer,
  stopProjectDevServer
} from "./dev-server-manager.js";
import { verifyWorkspaceProject } from "./workspace-verifier.js";
import {
  applyWorkspaceChanges,
  extractWorkspaceFilesFromMarkdown,
  listWorkspaceSourceFiles,
  previewWorkspaceChanges,
  resolveSafeWorkspacePath,
  undoWorkspaceBackup,
  type ExtractedWorkspaceFile
} from "./workspace-writer.js";

const MAX_GENERATE_FILES_PER_RUN = 6;
const MAX_FIX_ATTEMPTS = 3;
const MAX_FIX_CONTEXT_CHARS = 32_000;

const activeBuilderControllers = new Map<string, AbortController>();
const autoBuilderAttempted = new Set<string>();
const MAX_AUTO_BUILDER_HISTORY = 200;

export function isBuilderRunning(debateId: string): boolean {
  return activeBuilderControllers.has(debateId);
}

export function abortBuilderRun(debateId: string): boolean {
  const ctrl = activeBuilderControllers.get(debateId);
  if (!ctrl) return false;
  try {
    ctrl.abort();
  } catch {
    // Ignora
  }
  return true;
}

function resolveTurn(session: DebateSession, turnId?: string): ChatTurn | null {
  if (!Array.isArray(session.turns) || session.turns.length === 0) return null;
  if (turnId) {
    return session.turns.find((t) => t.id === turnId) ?? null;
  }
  return session.turns[session.turns.length - 1] ?? null;
}

async function resolveProjectFolderForSession(
  session: DebateSession
): Promise<{ projectId: string; projectName: string; folderPath: string; instructions: string }> {
  const projectId = session.projectId;
  if (!projectId) {
    throw new Error(
      "Esta conversa não está vinculada a um Projeto com pasta no PC."
    );
  }
  const project = await getProjectById(projectId);
  if (!project) {
    throw new Error("Projeto vinculado não encontrado.");
  }
  const folderPath = (project.linkedFolderPath ?? "").trim();
  if (!folderPath) {
    throw new Error(
      `O projeto "${project.name}" ainda não possui uma pasta local vinculada.`
    );
  }
  return {
    projectId: project.id,
    projectName: project.name,
    folderPath,
    instructions: project.instructions || ""
  };
}

function collectTurnMarkdownSources(
  session: DebateSession,
  turn: ChatTurn,
  sourcePlatform?: AIPlatform
): { primaryMarkdown: string; peerMarkdownPieces: string[]; sourceLabel?: string } {
  const turnResponses = (session.responses ?? []).filter(
    (r) => r.turnId === turn.id || (turn.index === 1 && !r.turnId)
  );

  if (sourcePlatform) {
    const specific = turnResponses.filter((r) => r.platform === sourcePlatform).at(-1);
    const content = specific?.content?.trim() || "";
    return {
      primaryMarkdown: content,
      peerMarkdownPieces: content ? [content] : [],
      sourceLabel: sourcePlatform
    };
  }

  const synth = turnResponses.find((r) => r.stage === "synthesis");
  const winnerPlat = turn.verdict?.winner && turn.verdict.winner !== "tie"
    ? turn.verdict.winner
    : undefined;
  const winnerResp = winnerPlat
    ? turnResponses.filter((r) => r.platform === winnerPlat).at(-1)
    : undefined;
  const geminiResp = turnResponses.filter((r) => r.platform === "gemini").at(-1);
  const longestResp = [...turnResponses].sort(
    (a, b) => (b.content?.length ?? 0) - (a.content?.length ?? 0)
  )[0];

  const primaryMarkdown =
    (turn.conclusion && turn.conclusion.trim()) ||
    (synth?.content && synth.content.trim()) ||
    (winnerResp?.content && winnerResp.content.trim()) ||
    (geminiResp?.content && geminiResp.content.trim()) ||
    (longestResp?.content && longestResp.content.trim()) ||
    "";

  // Mantém cada resposta separada (NUNCA concatena cru com "---") para impedir que um bloco
  // ``` não fechado de uma IA engula texto Markdown da IA seguinte!
  const pieces = [
    turn.conclusion,
    synth?.content,
    winnerResp?.content,
    geminiResp?.content,
    ...turnResponses.map((r) => r.content)
  ].filter((x): x is string => typeof x === "string" && x.trim().length > 0);

  return {
    primaryMarkdown,
    peerMarkdownPieces: Array.from(new Set(pieces))
  };
}

async function patchTurnBuilderState(
  debateId: string,
  turnId: string,
  updater: (prev: BuilderTurnState | undefined, turn: ChatTurn, session: DebateSession) => BuilderTurnState
): Promise<DebateSession | null> {
  return withDebateLock(async () => {
    const session = await readDebateSessionById(debateId);
    if (!session) return null;
    const turn = resolveTurn(session, turnId);
    if (!turn) return null;

    const nextState = updater(turn.builderState, turn, session);
    turn.builderState = {
      ...nextState,
      updatedAt: new Date().toISOString()
    };
    session.updatedAt = new Date().toISOString();

    await writeDebateSessionAtomically(session);
    emitDebateUpdated(session);
    return session;
  });
}

const GROQ_SAFE_BUILDER_MAX_CHARS = 11_000;
const GROQ_SAFE_BUILDER_MAX_OUTPUT_TOKENS = 1_800;

function computeRemainingQuotaRatio(status: ProviderStatus): number {
  if (!status.ready) return 0;
  const usage = status.usage;
  if (!usage) return 1;
  const reqRatio =
    usage.requestsDailyCap > 0
      ? Math.max(0, (usage.requestsDailyCap - usage.requestsToday) / usage.requestsDailyCap)
      : 1;
  const tokRatio =
    usage.tokensDailyCap && usage.tokensDailyCap > 0
      ? Math.max(0, (usage.tokensDailyCap - usage.tokensToday) / usage.tokensDailyCap)
      : 1;
  return Math.min(reqRatio, tokRatio);
}

function isProviderAutopilotCongested(status: ProviderStatus | undefined): boolean {
  const ap = status?.autopilot;
  return Boolean(
    ap &&
      Array.isArray(ap.activeModels) &&
      ap.activeModels.length > 0 &&
      Array.isArray(ap.cooledDown) &&
      ap.cooledDown.length >= ap.activeModels.length
  );
}

/**
 * Define a ordem de provedores do Construtor (Auto-Fix e geração de arquivos):
 * 1. Arquivos leves (<= 11k chars, <= 1800 tok): Groq (0,5s TTFB, 900 RPD) entra antes para poupar Gemini;
 * 2. Build / Auto-Fix / arquivos de código: Gemini em #1 quando saudável (2-3s TTFB e excelente em TypeScript estrito),
 *    com failover automático imediato para NVIDIA NIM -> OpenRouter quando Gemini estiver em 503 ou cota < 12%.
 */
export function resolveBuilderProviderOrder(params: {
  promptChars: number;
  maxTokens: number;
  statuses: ProviderStatus[];
}): AutoPlatform[] {
  const statusMap = new Map<AutoPlatform, ProviderStatus>();
  const ratioMap = new Map<AutoPlatform, number>();
  for (const st of params.statuses) {
    statusMap.set(st.id, st);
    ratioMap.set(st.id, computeRemainingQuotaRatio(st));
  }

  const isHealthy = (id: AutoPlatform, minRatio = 0.08): boolean => {
    const st = statusMap.get(id);
    if (!st?.ready) return false;
    if (isProviderAutopilotCongested(st)) return false;
    return (ratioMap.get(id) ?? 0) >= minRatio;
  };

  const groqFitsSafely =
    params.promptChars <= GROQ_SAFE_BUILDER_MAX_CHARS &&
    params.maxTokens <= GROQ_SAFE_BUILDER_MAX_OUTPUT_TOKENS;

  const ordered: AutoPlatform[] = [];
  const push = (id: AutoPlatform) => {
    if (!ordered.includes(id)) ordered.push(id);
  };

  // Arquivos curtos (package.json, tsconfig.json, README, CSS pequeno): Groq resolve em < 1s poupando Gemini.
  if (groqFitsSafely && isHealthy("groq", 0.15)) {
    push("groq");
  }

  // Build / testes / Auto-Fix: Gemini em #1 pela velocidade (Flash-Lite ~2s) e precisão em TypeScript;
  // se Gemini estiver em 503/cooldown ou cota baixa (< 12%), NVIDIA NIM assume antes do OpenRouter
  // (que exige >= 25% de cota livre para não drenar os 45/dia gratuitos em loops de correção).
  if (isHealthy("gemini", 0.12)) push("gemini");
  if (isHealthy("nvidia", 0.08)) push("nvidia");
  if (isHealthy("openrouter", 0.25)) push("openrouter");

  // Fallback final para qualquer provedor ainda ready com cota > 0
  const fallbackPool: AutoPlatform[] = groqFitsSafely
    ? ["gemini", "nvidia", "openrouter", "groq"]
    : ["gemini", "nvidia", "openrouter"];
  for (const id of fallbackPool) {
    if (statusMap.get(id)?.ready && (ratioMap.get(id) ?? 0) > 0) {
      push(id);
    }
  }

  if (ordered.length === 0) {
    return ["gemini", "nvidia", "openrouter"];
  }
  return ordered;
}

/**
 * Extrai o contrato real (exports, rotas HTTP, IDs HTML e scripts) dos arquivos
 * já completos para garantir handoff limpo entre IAs (ex.: Groq -> NVIDIA/OpenRouter/Gemini)
 * sem divergência de nomes de funções, variáveis, tipos ou rotas.
 */
export function extractWorkspaceContractSummary(
  files: Array<{ path: string; content: string; incomplete?: boolean }>
): string {
  const lines: string[] = [];

  for (const file of files) {
    if (file.incomplete || !file.content.trim()) continue;
    const lower = file.path.toLowerCase();
    const details: string[] = [];

    if (lower.endsWith("package.json")) {
      try {
        const pkg = JSON.parse(file.content) as {
          type?: string;
          scripts?: Record<string, string>;
        };
        if (pkg.type) details.push(`type="${pkg.type}"`);
        if (pkg.scripts && typeof pkg.scripts === "object") {
          const scriptKeys = Object.keys(pkg.scripts).slice(0, 6);
          if (scriptKeys.length > 0) details.push(`scripts: ${scriptKeys.join(", ")}`);
        }
      } catch {
        // Ignora JSON inválido
      }
    } else if (/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(lower)) {
      const exportsSet = new Set<string>();
      for (const m of file.content.matchAll(
        /\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+([A-Za-z_][A-Za-z0-9_]*)/g
      )) {
        if (m[1]) exportsSet.add(m[1]);
      }
      if (exportsSet.size > 0) {
        details.push(`exports: ${Array.from(exportsSet).slice(0, 12).join(", ")}`);
      }

      const routesSet = new Set<string>();
      for (const m of file.content.matchAll(
        /(?:\.(?:get|post|put|patch|delete)\(\s*["'`](\/[A-Za-z0-9_/:.-]+)["'`]|pathname\s*===?\s*["'`](\/[A-Za-z0-9_/:.-]+)["'`])/gi
      )) {
        const route = m[1] || m[2];
        if (route) routesSet.add(route);
      }
      if (routesSet.size > 0) {
        details.push(`rotas: ${Array.from(routesSet).slice(0, 10).join(", ")}`);
      }
    } else if (lower.endsWith(".html")) {
      const idsSet = new Set<string>();
      for (const m of file.content.matchAll(/\bid=["']([A-Za-z][A-Za-z0-9_-]{1,48})["']/g)) {
        if (m[1]) idsSet.add(`#${m[1]}`);
      }
      if (idsSet.size > 0) {
        details.push(`IDs DOM: ${Array.from(idsSet).slice(0, 18).join(", ")}`);
      }
      const classesSet = new Set<string>();
      for (const m of file.content.matchAll(/\bclass=["']([^"']{1,120})["']/g)) {
        for (const cls of (m[1] ?? "").split(/\s+/)) {
          if (/^[A-Za-z][A-Za-z0-9_-]{1,40}$/.test(cls)) classesSet.add(`.${cls}`);
        }
      }
      if (classesSet.size > 0) {
        details.push(`Classes CSS: ${Array.from(classesSet).slice(0, 24).join(", ")}`);
      }
    }

    if (details.length > 0) {
      lines.push(`- \`${file.path}\`: ${details.join(" | ")}`);
    }
  }

  return lines.join("\n").slice(0, 3_200);
}

function isLightweightConfigOrDocFile(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  // NOTA: .css NÃO é arquivo leve — Design Systems ricos precisam de 3.000-5.500 tokens
  // para estilizar todos os componentes, formulários, cards e estados responsivos sem truncar.
  return /(?:^|\/)(?:package\.json|tsconfig\.json|readme\.md|\.gitignore|\.env\.example)$/.test(
    lower
  );
}

/**
 * Divide os arquivos faltantes em 2 ondas paralelas respeitando dependências de contrato:
 * - Onda 1 (paralela): configs, backend/source e HTML base (fornecem rotas, exports e IDs DOM);
 * - Onda 2 (paralela): CSS/JS do frontend e testes (recebem o contrato exato gerado na Onda 1).
 */
export function partitionBuilderFileWaves(queue: string[]): [string[], string[]] {
  const wave1: string[] = [];
  const wave2: string[] = [];

  for (const relPath of queue) {
    const norm = relPath.replace(/\\/g, "/").toLowerCase();
    const isFrontendAsset = /^public\/.+\.(?:css|js|mjs)$/i.test(norm) || norm.endsWith(".css");
    const isTestFile =
      /(?:^|\/)(?:tests?|__tests__|spec)\//i.test(norm) ||
      /\.(?:test|spec)\.[a-z0-9]+$/i.test(norm);

    if (isFrontendAsset || isTestFile) {
      wave2.push(relPath);
    } else {
      wave1.push(relPath);
    }
  }

  return [wave1, wave2];
}

async function callBuilderModel(params: {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  signal?: AbortSignal;
  excludePlatforms?: AutoPlatform[];
  allowGroqFallback?: boolean;
  onAttempt?: (platform: AutoPlatform) => void;
}): Promise<{ content: string; platform: AutoPlatform; model: string }> {
  const statuses = await getProvidersStatus();
  const baseOrder = resolveBuilderProviderOrder({
    promptChars: params.systemPrompt.length + params.userPrompt.length,
    maxTokens: params.maxTokens,
    statuses
  });
  const order: AutoPlatform[] = [...baseOrder];
  if (params.allowGroqFallback && !order.includes("groq")) {
    const groqSt = statuses.find((s) => s.id === "groq");
    if (groqSt?.ready) order.push("groq");
  }
  const excluded = new Set(params.excludePlatforms ?? []);
  const filteredOrder = order.filter((p) => !excluded.has(p));
  let lastError: unknown = null;

  for (const plat of filteredOrder) {
    const provider = getProvider(plat);
    if (!provider) continue;
    params.onAttempt?.(plat);
    try {
      // Para Groq no fallback de arquivo único, respeita o teto de 8k TPM com maxTokens enxuto
      const effectiveMaxTokens =
        plat === "groq" ? Math.min(params.maxTokens, 3_000) : params.maxTokens;
      // Usa streaming interno (onDelta no-op) para ativar a trava TTFB (18-25s)
      // e impedir que um modelo lento/congestionado trave o Auto-Fix por 60-90s.
      const res = await provider.generate({
        system: params.systemPrompt,
        user: params.userPrompt,
        maxTokens: effectiveMaxTokens,
        signal: params.signal,
        onDelta: () => {}
      });
      if (res.text && res.text.trim().length > 0) {
        return {
          content: res.text,
          platform: plat,
          model: res.model
        };
      }
    } catch (err) {
      if (params.signal?.aborted) throw err;
      lastError = err;
    }
  }

  throw new Error(
    lastError instanceof Error
      ? `Nenhum provedor disponível para o Construtor (${filteredOrder.join("/")}): ${lastError.message}`
      : `Nenhum provedor configurado para o Construtor (${filteredOrder.join("/")}).`
  );
}

function extractSingleFileContentFromModelOutput(
  output: string,
  expectedPath: string
): string {
  const extracted = extractWorkspaceFilesFromMarkdown(output);
  const exact = extracted.files.find(
    (f) => f.path.toLowerCase() === expectedPath.toLowerCase()
  );
  if (exact && exact.content.trim().length > 0) {
    return exact.content;
  }
  if (extracted.files.length === 1 && extracted.files[0]?.content.trim()) {
    return extracted.files[0].content;
  }

  const fenceMatch = output.match(/```[^\n`]*\r?\n([\s\S]*?)```/);
  if (fenceMatch?.[1] && fenceMatch[1].trim().length > 0) {
    return fenceMatch[1].replace(/\r\n/g, "\n");
  }
  return "";
}

function mergeExtractedFiles(
  current: BuilderFileEntry[],
  incoming: ExtractedWorkspaceFile[]
): ExtractedWorkspaceFile[] {
  const map = new Map<string, ExtractedWorkspaceFile>();
  for (const f of current) {
    map.set(f.path, {
      path: f.path,
      content: f.content,
      incomplete: Boolean(f.incomplete)
    });
  }
  for (const f of incoming) {
    map.set(f.path, f);
  }
  return Array.from(map.values());
}

/**
 * 1. Extrai os blocos de código do turno e gera o preview/diff real contra a pasta do projeto.
 */
export async function extractBuilderFilesForTurn(
  debateId: string,
  turnId?: string,
  options: { sourcePlatform?: AIPlatform } = {}
): Promise<DebateSession> {
  const session = await readDebateSessionById(debateId);
  if (!session) throw new Error("Conversa não encontrada.");
  const turn = resolveTurn(session, turnId);
  if (!turn) throw new Error("Turno não encontrado.");

  const proj = await resolveProjectFolderForSession(session);
  const { primaryMarkdown, peerMarkdownPieces, sourceLabel } = collectTurnMarkdownSources(
    session,
    turn,
    options.sourcePlatform
  );

  let extraction = extractWorkspaceFilesFromMarkdown(primaryMarkdown);
  if (!options.sourcePlatform && peerMarkdownPieces.length > 1) {
    // Extrai cada resposta de IA separadamente para impedir que um fence não fechado
    // de uma IA contamine o código com o Markdown da IA seguinte!
    const completePeerByPath = new Map<string, ExtractedWorkspaceFile>();
    const allPeerMissing = new Set<string>();
    for (const piece of peerMarkdownPieces) {
      if (piece === primaryMarkdown) continue;
      const peerRes = extractWorkspaceFilesFromMarkdown(piece);
      for (const f of peerRes.files) {
        if (!f.incomplete && f.content.trim().length > 0) {
          const key = f.path.toLowerCase();
          const prev = completePeerByPath.get(key);
          if (!prev || f.content.length > prev.content.length) {
            completePeerByPath.set(key, f);
          }
        }
      }
      for (const mp of peerRes.missingPaths) {
        allPeerMissing.add(mp);
      }
    }

    if (extraction.files.length === 0 && completePeerByPath.size > 0) {
      const peerFiles = Array.from(completePeerByPath.values());
      const peerSet = new Set(peerFiles.map((f) => f.path.toLowerCase()));
      extraction = {
        files: peerFiles,
        missingPaths: Array.from(allPeerMissing).filter((p) => !peerSet.has(p.toLowerCase())),
        deletes: extraction.deletes
      };
    } else if (
      extraction.missingPaths.length > 0 ||
      extraction.files.some((f) => f.incomplete)
    ) {
      // Handoff limpo por fronteira de arquivo: se a resposta principal truncou/omitiu
      // algum arquivo, aproveita versões 100% completas entregues por colegas no mesmo turno.
      const mergedFiles: ExtractedWorkspaceFile[] = extraction.files.map((f) => {
        if (!f.incomplete) return f;
        const peerComplete = completePeerByPath.get(f.path.toLowerCase());
        return peerComplete ?? f;
      });
      const existingLower = new Set(mergedFiles.map((f) => f.path.toLowerCase()));
      const remainingMissing: string[] = [];
      for (const mp of extraction.missingPaths) {
        const peerComplete = completePeerByPath.get(mp.toLowerCase());
        if (peerComplete && !existingLower.has(mp.toLowerCase())) {
          mergedFiles.push(peerComplete);
          existingLower.add(mp.toLowerCase());
        } else {
          remainingMissing.push(mp);
        }
      }
      extraction = {
        ...extraction,
        files: mergedFiles,
        missingPaths: remainingMissing
      };
    }
  }

  const preview = await previewWorkspaceChanges(proj.folderPath, extraction.files);
  const actionableCount = preview.filter(
    (f) => f.action === "create" || f.action === "overwrite"
  ).length;
  const incompleteCount = preview.filter((f) => f.incomplete).length;
  const sourceSuffix = sourceLabel ? ` (fonte: ${sourceLabel})` : "";

  const summary =
    preview.length === 0
      ? extraction.missingPaths.length > 0
        ? `Plano cita ${extraction.missingPaths.length} arquivo(s) ainda sem código completo. Clique em "Gerar arquivos restantes".`
        : `Nenhum bloco de arquivo com caminho relativo foi detectado nesta resposta${sourceSuffix}.`
      : `${preview.length} arquivo(s) detectado(s)${sourceSuffix} (${actionableCount} pronto(s) para gravar${
          incompleteCount > 0 ? `, ${incompleteCount} resumido(s)` : ""
        }${
          extraction.missingPaths.length > 0
            ? `, ${extraction.missingPaths.length} faltando no plano`
            : ""
        }).`;

  const updated = await patchTurnBuilderState(debateId, turn.id, (prev) => ({
    enabled: true,
    autoApply: prev?.autoApply ?? Boolean(turn.builderAutoApply),
    status: "ready",
    projectId: proj.projectId,
    summary,
    files: preview,
    missingPaths: extraction.missingPaths,
    lastBackup: prev?.lastBackup,
    checks: prev?.checks,
    fixAttempt: prev?.fixAttempt,
    maxFixAttempts: MAX_FIX_ATTEMPTS,
    updatedAt: new Date().toISOString()
  }));

  if (!updated) throw new Error("Falha ao atualizar estado do Construtor.");
  return updated;
}

/**
 * 2. Gera arquivo por arquivo os caminhos faltantes do plano ou blocos marcados como resumidos.
 */
export async function generateRemainingBuilderFiles(
  debateId: string,
  turnId?: string,
  options: { signal?: AbortSignal } = {}
): Promise<DebateSession> {
  const ownController = options.signal ? null : new AbortController();
  const signal = options.signal ?? ownController!.signal;

  if (ownController) {
    if (activeBuilderControllers.has(debateId)) {
      throw new Error("Já existe uma tarefa do Construtor em andamento nesta conversa.");
    }
    activeBuilderControllers.set(debateId, ownController);
  }

  try {
    let session = await readDebateSessionById(debateId);
    if (!session) throw new Error("Conversa não encontrada.");
    let turn = resolveTurn(session, turnId);
    if (!turn) throw new Error("Turno não encontrado.");

    if (!turn.builderState) {
      session = await extractBuilderFilesForTurn(debateId, turn.id);
      turn = resolveTurn(session, turn.id)!;
    }

    const proj = await resolveProjectFolderForSession(session);
    const { primaryMarkdown } = collectTurnMarkdownSources(session, turn);
    const currentFiles = turn.builderState?.files ?? [];
    const incompletePaths = currentFiles
      .filter((f) => f.incomplete && f.action !== "blocked")
      .map((f) => f.path);
    const missingPaths = turn.builderState?.missingPaths ?? [];

    const queue = Array.from(new Set([...incompletePaths, ...missingPaths])).slice(
      0,
      MAX_GENERATE_FILES_PER_RUN
    );

    if (queue.length === 0) {
      return session;
    }

    const systemPrompt = [
      "Você é o engenheiro de geração de arquivos do AI Council (Modo Construtor).",
      "Gere APENAS o código 100% completo e funcional do arquivo solicitado, sem abreviações, sem '// ... resto do código' e sem explicações extras.",
      "Devolva um único bloco de código Markdown precedido pelo caminho relativo exato (ex.: ### `src/index.ts`).",
      proj.instructions ? `Instruções do Projeto: ${proj.instructions.slice(0, 1200)}` : "",
      ANTI_INJECTION_SYSTEM_RULE
    ]
      .filter(Boolean)
      .join(" ");

    let workingFiles: BuilderFileEntry[] = [...currentFiles];
    let remainingMissing = [...missingPaths];

    const [wave1, wave2] = partitionBuilderFileWaves(queue);
    const waves = [wave1, wave2].filter((w) => w.length > 0);

    const generateSingleTargetFile = async (
      targetPath: string,
      snapshotFiles: BuilderFileEntry[],
      contractSummary: string
    ): Promise<ExtractedWorkspaceFile | null> => {
      if (signal.aborted) return null;

      const isFrontendTarget =
        /\.(?:css|html|js|mjs)$/i.test(targetPath) &&
        targetPath.toLowerCase().startsWith("public/");
      const knownSummary = snapshotFiles
        .filter((f) => !f.incomplete && f.path !== targetPath)
        .slice(0, 8)
        .map((f) => {
          const isImportantFrontendRef =
            isFrontendTarget && /\.(?:html|css|js|ts)$/i.test(f.path);
          const cap = isImportantFrontendRef ? 5_500 : 1_800;
          return `### \`${f.path}\`\n\`\`\`\n${f.content.slice(0, cap)}\n\`\`\``;
        })
        .join("\n\n");

      const frontendQualityRule = targetPath.toLowerCase().endsWith(".css")
        ? "\nREGRA DE QUALIDADE CSS (OBRIGATÓRIA): estilize 100% das classes, tags, inputs, selects, textareas, botões, abas (inclua `.view { display: none; } .view.active { display: block; } .hidden { display: none !important; }`), cards, KPIs e layout responsivo presentes no `public/index.html`, seguindo fielmente o Design System do projeto. PROIBIDO deixar qualquer input/select/button com aparência branca/cinza padrão do navegador. Feche TODAS as chaves CSS corretamente."
        : targetPath.toLowerCase().endsWith(".js") && targetPath.toLowerCase().startsWith("public/")
          ? "\nREGRA DE QUALIDADE FRONTEND JS: conecte TODOS os botões, abas (`data-view` / `.view.active`), filtros, formulários e chamadas `fetch('/api/...')` aos IDs exatos de `public/index.html` e rotas de `src/server.ts`. Nunca use `innerHTML` com dados do usuário (use `textContent` / `createElement`)."
          : "";

      const userPrompt = [
        `Pedido do usuário:\n${turn.prompt}`,
        `\nPlano / síntese do Conselho:\n${primaryMarkdown.slice(0, 8_000)}`,
        contractSummary
          ? `\nCONTRATO REAL DOS ARQUIVOS JÁ PRONTOS (OBRIGATÓRIO: não renomeie funções, tipos, rotas nem IDs DOM abaixo — importe e reutilize exatamente estes nomes):\n${contractSummary}`
          : "",
        knownSummary
          ? `\nArquivos já definidos (somente completos, mantenha 100% de compatibilidade):\n${knownSummary}`
          : "",
        frontendQualityRule,
        `\nGere agora o arquivo 100% completo e fechado: \`${targetPath}\``
      ]
        .filter(Boolean)
        .join("\n");

      const maxTokensForTarget = isLightweightConfigOrDocFile(targetPath)
        ? 1_600
        : 6_000;

      // Nunca silencia falha de extração: tenta até 2 provedores distintos se o 1º devolver
      // saída vazia, sem bloco de código ou truncada (ex.: modelo reasoning que cortou public/app.js).
      let generatedContent = "";
      const triedPlatforms: AutoPlatform[] = [];
      for (let genAttempt = 0; genAttempt < 2 && !generatedContent; genAttempt++) {
        if (signal.aborted) break;
        try {
          const res = await callBuilderModel({
            systemPrompt,
            userPrompt,
            maxTokens: maxTokensForTarget,
            signal,
            excludePlatforms: triedPlatforms,
            allowGroqFallback: true
          });
          triedPlatforms.push(res.platform);
          const candidate = extractSingleFileContentFromModelOutput(
            res.content,
            targetPath
          );
          if (candidate && candidate.trim().length > 0) {
            generatedContent = candidate;
          }
        } catch (genErr) {
          if (signal.aborted) throw genErr;
          break;
        }
      }

      return generatedContent
        ? { path: targetPath, content: generatedContent, incomplete: false }
        : null;
    };

    for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
      const wave = waves[waveIdx]!;
      if (signal.aborted) {
        await patchTurnBuilderState(debateId, turn.id, (prev) => ({
          ...(prev ?? { enabled: true, autoApply: false, files: workingFiles, status: "stopped", updatedAt: "" }),
          status: "stopped",
          summary: "Geração interrompida pelo usuário.",
          files: workingFiles,
          missingPaths: remainingMissing,
          updatedAt: new Date().toISOString()
        }));
        break;
      }

      const waveLabel =
        waves.length > 1 ? `onda ${waveIdx + 1}/${waves.length} em paralelo` : "em paralelo";
      await patchTurnBuilderState(debateId, turn.id, (prev) => ({
        ...(prev ?? { enabled: true, autoApply: false, files: workingFiles, status: "generating", updatedAt: "" }),
        status: "generating",
        summary:
          wave.length > 1
            ? `Gerando ${wave.length} arquivos (${waveLabel}): ${wave.join(", ")}...`
            : `Gerando arquivo ${wave[0]}...`,
        files: workingFiles,
        missingPaths: remainingMissing,
        updatedAt: new Date().toISOString()
      }));

      const snapshotFiles = [...workingFiles];
      const contractSummary = extractWorkspaceContractSummary(snapshotFiles);

      // Dispara todos os arquivos da onda simultaneamente (Onda 1: base/HTML/API; Onda 2: CSS/JS/testes com contrato real)
      const generatedResults = await Promise.all(
        wave.map((targetPath) =>
          generateSingleTargetFile(targetPath, snapshotFiles, contractSummary)
        )
      );

      const produced = generatedResults.filter(
        (item): item is ExtractedWorkspaceFile => item !== null
      );
      if (produced.length > 0) {
        const merged = mergeExtractedFiles(workingFiles, produced);
        workingFiles = await previewWorkspaceChanges(proj.folderPath, merged);
        const producedSet = new Set(produced.map((p) => p.path));
        remainingMissing = remainingMissing.filter((p) => !producedSet.has(p));
      }
    }

    const updated = await patchTurnBuilderState(debateId, turn.id, (prev) => ({
      ...(prev ?? { enabled: true, autoApply: false, files: workingFiles, status: "ready", updatedAt: "" }),
      status: signal.aborted ? "stopped" : "ready",
      summary: signal.aborted
        ? "Geração interrompida pelo usuário."
        : `${workingFiles.length} arquivo(s) prontos para aplicar na pasta.`,
      files: workingFiles,
      missingPaths: remainingMissing,
      updatedAt: new Date().toISOString()
    }));

    if (!updated) throw new Error("Falha ao salvar arquivos gerados.");
    return updated;
  } finally {
    if (ownController) {
      activeBuilderControllers.delete(debateId);
    }
  }
}

function isPrioritizedSourceFile(relPath: string): boolean {
  const lower = relPath.toLowerCase();
  return (
    /\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|html|py|go|rs|sql|yml|yaml)$/.test(lower) &&
    !lower.endsWith(".d.ts")
  );
}

export async function readRelevantFilesForFix(
  folderPath: string,
  errorOutput: string,
  fallbackPaths: string[],
  workspaceTree: string[]
): Promise<Array<{ path: string; content: string }>> {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const citedSet = new Set<string>();
  const addCandidate = (p: string, isCited = false) => {
    const clean = p.replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (!clean || clean.startsWith("node_modules/")) return;
    if (isCited) citedSet.add(clean.toLowerCase());
    if (seen.has(clean)) return;
    seen.add(clean);
    ordered.push(clean);
  };

  // 1. Arquivos citados diretamente no erro/stack trace (inclusive caminhos Windows ou file:///)
  const normalizedErr = errorOutput.replace(/\\/g, "/");
  for (const treePath of workspaceTree) {
    if (normalizedErr.includes(treePath)) {
      addCandidate(treePath, true);
    }
  }
  for (const m of errorOutput.matchAll(
    /([a-zA-Z0-9._-]+(?:[\\/][a-zA-Z0-9._-]+)+\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|html))/g
  )) {
    addCandidate(m[1] ?? "", true);
  }

  // Se o erro for puramente de compilação TypeScript (tsc / TSxxxx) com arquivos citados,
  // evita poluir o prompt com HTML/CSS irrelevantes — acelera drasticamente o Auto-Fix.
  const isPureTsCompileError =
    citedSet.size > 0 && /\berror\s+TS\d{4}\b/i.test(errorOutput);

  // 2. Arquivos de configuração e recém-alterados
  addCandidate("package.json");
  addCandidate("tsconfig.json");
  for (const p of fallbackPaths) {
    if (isPureTsCompileError && /\.(?:css|html|md)$/i.test(p)) continue;
    addCandidate(p);
  }

  // 3. Demais arquivos de teste e código do projeto (para a IA nunca corrigir "no escuro")
  const extraTestFiles = workspaceTree.filter(
    (p) => isPrioritizedSourceFile(p) && /(?:^|\/)(?:tests?|__tests__|spec)\//i.test(p)
  );
  const extraSrcFiles = workspaceTree.filter(
    (p) =>
      isPrioritizedSourceFile(p) &&
      !extraTestFiles.includes(p) &&
      !(isPureTsCompileError && /\.(?:css|html)$/i.test(p))
  );
  for (const p of [...extraSrcFiles, ...extraTestFiles]) {
    if (isPureTsCompileError && extraTestFiles.includes(p) && !citedSet.has(p.toLowerCase())) {
      continue;
    }
    addCandidate(p);
  }

  const loaded: Array<{ path: string; content: string }> = [];
  let totalChars = 0;

  for (const relPath of ordered.slice(0, 18)) {
    if (totalChars >= MAX_FIX_CONTEXT_CHARS) break;
    try {
      const safe = await resolveSafeWorkspacePath(folderPath, relPath);
      const raw = await readFile(safe.absPath, "utf8");
      const isCited = citedSet.has(safe.relPath.toLowerCase());
      // Arquivos citados no erro recebem até 18k chars (sem truncar linhas finais onde o erro ocorre!)
      const perFileCap = isCited ? 18_000 : 3_800;
      const budgetLeft = MAX_FIX_CONTEXT_CHARS - totalChars;
      const limit = Math.min(perFileCap, budgetLeft);
      let trimmed: string;
      if (raw.length <= limit) {
        trimmed = raw;
      } else if (isCited && limit > 2_000) {
        // Preserva imports/topo + fim do arquivo (onde geralmente ficam rotas/handlers)
        const headLen = Math.floor(limit * 0.45);
        const tailLen = limit - headLen - 40;
        trimmed = `${raw.slice(0, headLen)}\n/* ... trecho omitido ... */\n${raw.slice(-tailLen)}`;
      } else {
        trimmed = raw.slice(0, limit);
      }
      totalChars += trimmed.length;
      loaded.push({ path: safe.relPath, content: trimmed });
    } catch {
      // Ignora arquivos não existentes ou bloqueados
    }
  }

  return loaded;
}

function isRunningUnderTest(): boolean {
  return (
    process.env.NODE_ENV === "test" ||
    process.argv.some((arg) => arg === "--test" || arg.includes(".test."))
  );
}

async function runVerificationAndAutoFixLoop(params: {
  debateId: string;
  turnId: string;
  projectId?: string;
  folderPath: string;
  projectInstructions: string;
  userGoal: string;
  initialWrittenPaths: string[];
  initialBackup: BuilderBackupInfo | undefined;
  autoFix: boolean;
  signal: AbortSignal;
}): Promise<DebateSession> {
  const {
    debateId,
    turnId,
    projectId,
    folderPath,
    projectInstructions,
    userGoal,
    autoFix,
    signal
  } = params;

  let currentWrittenPaths = [...params.initialWrittenPaths];
  let latestBackup = params.initialBackup;
  let packageJsonChanged = currentWrittenPaths.some(
    (p) => p.toLowerCase() === "package.json"
  );
  let lastChecks: BuilderCommandRun[] = [];
  let fixAttempt = 0;
  const attemptHistory: string[] = [];
  const deletedPathsRun = new Set<string>();

  while (true) {
    if (signal.aborted) {
      const stopped = await patchTurnBuilderState(debateId, turnId, (prev) => ({
        ...(prev ?? { enabled: true, autoApply: false, files: [], status: "stopped", updatedAt: "" }),
        status: "stopped",
        summary: "Execução interrompida pelo usuário.",
        lastBackup: latestBackup ?? prev?.lastBackup,
        checks: lastChecks,
        fixAttempt,
        maxFixAttempts: MAX_FIX_ATTEMPTS,
        updatedAt: new Date().toISOString()
      }));
      if (!stopped) throw new Error("Conversa não encontrada.");
      return stopped;
    }

    await patchTurnBuilderState(debateId, turnId, (prev) => ({
      ...(prev ?? { enabled: true, autoApply: false, files: [], status: "verifying", updatedAt: "" }),
      status: "verifying",
      summary:
        fixAttempt > 0
          ? `Re-testando após correção ${fixAttempt}/${MAX_FIX_ATTEMPTS}...`
          : "Executando verificação segura na pasta (install / build / test)...",
      lastBackup: latestBackup ?? prev?.lastBackup,
      checks: lastChecks,
      fixAttempt,
      maxFixAttempts: MAX_FIX_ATTEMPTS,
      lastError: undefined,
      updatedAt: new Date().toISOString()
    }));

    const verification = await verifyWorkspaceProject(folderPath, {
      packageJsonChanged,
      signal
    });
    lastChecks = verification.checks;
    packageJsonChanged = false;

    if (verification.allPassed) {
      // Onda 2: Auto-Start automático do servidor local assim que build/test/smoke-test passarem 100%!
      let autoStartedUrl: string | undefined;
      if (projectId && !isRunningUnderTest() && !signal.aborted) {
        try {
          await stopProjectDevServer(projectId).catch(() => {});
          const devStatus = await startProjectDevServer(projectId, folderPath);
          if (devStatus.running && devStatus.url) {
            autoStartedUrl = devStatus.url;
          }
        } catch {
          // Projeto sem script dev/start (ex.: biblioteca pura) — ignora silenciosamente
        }
      }

      const baseDoneSummary =
        fixAttempt > 0
          ? `${verification.summary} (corrigido automaticamente em ${fixAttempt} tentativa${fixAttempt > 1 ? "s" : ""})`
          : verification.summary;
      const done = await patchTurnBuilderState(debateId, turnId, (prev) => ({
        ...(prev ?? { enabled: true, autoApply: false, files: [], status: "completed", updatedAt: "" }),
        status: "completed",
        summary: autoStartedUrl
          ? `${baseDoneSummary} · App rodando em ${autoStartedUrl}`
          : baseDoneSummary,
        lastBackup: latestBackup ?? prev?.lastBackup,
        checks: lastChecks,
        fixAttempt,
        maxFixAttempts: MAX_FIX_ATTEMPTS,
        autoStartedUrl,
        autoRolledBack: false,
        lastError: undefined,
        updatedAt: new Date().toISOString()
      }));
      if (!done) throw new Error("Conversa não encontrada.");
      return done;
    }

    if (!autoFix || fixAttempt >= MAX_FIX_ATTEMPTS) {
      // Onda 2: Rollback automático seguro em edição de projeto existente após 3ª falha do Auto-Fix
      // (só restaura quando havia arquivos existentes sobrescritos; preserva pasta nova do zero).
      let autoRolledBack = false;
      let restoredBackup = latestBackup;
      const rollbackCandidate = params.initialBackup;
      if (
        autoFix &&
        fixAttempt >= MAX_FIX_ATTEMPTS &&
        rollbackCandidate &&
        !rollbackCandidate.undone &&
        (rollbackCandidate.filesOverwritten?.length ?? 0) > 0
      ) {
        try {
          const undone = await undoWorkspaceBackup(folderPath, rollbackCandidate.batchId);
          autoRolledBack = true;
          restoredBackup = undone.backup;
        } catch {
          // Se backup falhar, mantém estado normal de falha
        }
      }

      const failed = await patchTurnBuilderState(debateId, turnId, (prev) => ({
        ...(prev ?? { enabled: true, autoApply: false, files: [], status: "failed", updatedAt: "" }),
        status: "failed",
        summary: autoRolledBack
          ? `Auto-Fix falhou após ${fixAttempt} tentativas — a versão anterior que funcionava foi restaurada automaticamente pelo backup.`
          : fixAttempt > 0
            ? `${verification.summary} Após ${fixAttempt} tentativa(s) de autocorreção.`
            : verification.summary,
        lastBackup: restoredBackup ?? prev?.lastBackup,
        checks: lastChecks,
        fixAttempt,
        maxFixAttempts: MAX_FIX_ATTEMPTS,
        autoRolledBack,
        lastError: verification.summary,
        updatedAt: new Date().toISOString()
      }));
      if (!failed) throw new Error("Conversa não encontrada.");
      return failed;
    }

    fixAttempt++;
    const failedCheck = lastChecks.find((c) => !c.ok) ?? lastChecks.at(-1);
    const errorLog = failedCheck
      ? `Comando: ${failedCheck.command} (exit ${failedCheck.exitCode}${failedCheck.timedOut ? " — TIMEOUT" : ""})\n\n${failedCheck.output}`
      : verification.summary;

    await patchTurnBuilderState(debateId, turnId, (prev) => ({
      ...(prev ?? { enabled: true, autoApply: false, files: [], status: "fixing", updatedAt: "" }),
      status: "fixing",
      summary: `Erro em "${failedCheck?.command || "verificação"}". Gerando correção automática (${fixAttempt}/${MAX_FIX_ATTEMPTS})...`,
      lastBackup: latestBackup ?? prev?.lastBackup,
      checks: lastChecks,
      fixAttempt,
      maxFixAttempts: MAX_FIX_ATTEMPTS,
      updatedAt: new Date().toISOString()
    }));

    const workspaceTree = await listWorkspaceSourceFiles(folderPath, 120);
    const relevantFiles = await readRelevantFilesForFix(
      folderPath,
      errorLog,
      currentWrittenPaths,
      workspaceTree
    );

    const fixSystemPrompt = [
      "Você é o engenheiro de autocorreção do AI Council.",
      "Analise o erro real de compilação/teste, o diagnóstico de timeout (se houver) e a árvore real de arquivos da pasta; corrija APENAS os arquivos necessários.",
      "Para criar ou alterar um arquivo, entregue o caminho relativo exato (### `caminho/do/arquivo`) seguido do arquivo 100% COMPLETO em um bloco Markdown (sem abreviações).",
      "Se encontrar arquivo compilado antigo/duplicado/obsoleto atrapalhando os testes (ex.: `tests/foo.test.js` sobrando ao lado de `tests/foo.test.ts`), você pode removê-lo com segurança escrevendo uma linha fora de blocos de código no formato: DELETE: `caminho/do/arquivo`.",
      "Em projetos Node.js com testes HTTP (`node --test` + `fetch`), sempre encerre o servidor no `finally` com `server.closeAllConnections?.()` e `server.close()` (ou aguarde fechar) para evitar travamento por keep-alive/handles abertos, e prefira glob explícito no script `test` (ex.: `tests/*.test.ts`) quando houver TypeScript.",
      "Não invente comandos de shell; corrija apenas o código/configuração ou use `DELETE:` para limpar arquivos duplicados.",
      projectInstructions ? `Instruções do Projeto: ${projectInstructions.slice(0, 1000)}` : "",
      ANTI_INJECTION_SYSTEM_RULE
    ]
      .filter(Boolean)
      .join(" ");

    const historySection =
      attemptHistory.length > 0
        ? `\nHistórico de tentativas anteriores nesta execução (NÃO repita a mesma alteração que já falhou; investigue outra causa raiz):\n${attemptHistory.map((h) => `- ${h}`).join("\n")}`
        : "";

    const treeSection =
      workspaceTree.length > 0
        ? `\nÁrvore real de arquivos na pasta (${workspaceTree.length} arquivo(s)):\n\`\`\`\n${workspaceTree.join("\n")}\n\`\`\``
        : "";

    const fixUserPrompt = [
      `Objetivo original:\n${userGoal.slice(0, 2000)}`,
      treeSection,
      historySection,
      `\nErro do terminal (tentativa ${fixAttempt}/${MAX_FIX_ATTEMPTS}):\n\`\`\`\n${errorLog.slice(0, 9000)}\n\`\`\``,
      `\nArquivos atuais da pasta:\n${relevantFiles
        .map((f) => `### \`${f.path}\`\n\`\`\`\n${f.content}\n\`\`\``)
        .join("\n\n")}`
    ]
      .filter(Boolean)
      .join("\n");

    const fixRes = await callBuilderModel({
      systemPrompt: fixSystemPrompt,
      userPrompt: fixUserPrompt,
      maxTokens: 6_500,
      signal,
      onAttempt: (plat) => {
        const label =
          plat === "nvidia"
            ? "NVIDIA NIM"
            : plat === "openrouter"
              ? "OpenRouter"
              : plat === "groq"
                ? "Groq"
                : "Gemini";
        void patchTurnBuilderState(debateId, turnId, (prev) => ({
          ...(prev ?? { enabled: true, autoApply: false, files: [], status: "fixing", updatedAt: "" }),
          status: "fixing",
          summary: `Erro em "${failedCheck?.command || "verificação"}". Corrigindo (${fixAttempt}/${MAX_FIX_ATTEMPTS}) via ${label}...`,
          lastBackup: latestBackup ?? prev?.lastBackup,
          checks: lastChecks,
          fixAttempt,
          maxFixAttempts: MAX_FIX_ATTEMPTS,
          updatedAt: new Date().toISOString()
        })).catch(() => {});
      }
    });

    const patchExtraction = extractWorkspaceFilesFromMarkdown(fixRes.content);
    if (patchExtraction.files.length === 0 && patchExtraction.deletes.length === 0) {
      const noPatch = await patchTurnBuilderState(debateId, turnId, (prev) => ({
        ...(prev ?? { enabled: true, autoApply: false, files: [], status: "failed", updatedAt: "" }),
        status: "failed",
        summary: `A tentativa ${fixAttempt}/${MAX_FIX_ATTEMPTS} não produziu arquivos corrigidos.`,
        lastBackup: latestBackup ?? prev?.lastBackup,
        checks: lastChecks,
        fixAttempt,
        maxFixAttempts: MAX_FIX_ATTEMPTS,
        lastError: verification.summary,
        updatedAt: new Date().toISOString()
      }));
      if (!noPatch) throw new Error("Conversa não encontrada.");
      return noPatch;
    }

    const applyPatch = await applyWorkspaceChanges(folderPath, patchExtraction.files, {
      deletePaths: patchExtraction.deletes
    });

    const writtenList = applyPatch.backup?.filesWritten ?? [];
    const deletedList = applyPatch.backup?.filesDeleted ?? [];
    if (applyPatch.backup) {
      latestBackup = applyPatch.backup;
      currentWrittenPaths = Array.from(
        new Set([
          ...currentWrittenPaths.filter((p) => !deletedList.includes(p)),
          ...writtenList
        ])
      );
      for (const delPath of deletedList) {
        deletedPathsRun.add(delPath);
      }
      if (writtenList.some((p) => p.toLowerCase() === "package.json")) {
        packageJsonChanged = true;
      }
    }

    const compactErrHint = (failedCheck?.output || verification.summary)
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /timeout|assertionerror|error|✖|fail|ts\d{4}/i.test(l))
      .slice(0, 3)
      .join(" | ")
      .slice(0, 260);
    attemptHistory.push(
      `Tentativa ${fixAttempt}: erro "${failedCheck?.command || "check"}" (${compactErrHint || verification.summary}) → gravou [${writtenList.join(", ") || "nenhum"}]${deletedList.length > 0 ? `, removeu [${deletedList.join(", ")}]` : ""}.`
    );

    // Recalcula preview consolidado contra o disco para preservar todos os arquivos do turno
    // sem deixar arquivos já gravados marcados erroneamente como pendentes.
    const latestSession = await readDebateSessionById(debateId);
    const prevTurnFiles = latestSession
      ? (resolveTurn(latestSession, turnId)?.builderState?.files ?? [])
      : [];
    const nonDeletedPrev = prevTurnFiles.filter(
      (f) => f.action !== "delete" && !deletedPathsRun.has(f.path)
    );
    const mergedForPreview = mergeExtractedFiles(nonDeletedPrev, patchExtraction.files).filter(
      (f) => !deletedPathsRun.has(f.path)
    );
    const refreshedPreview = await previewWorkspaceChanges(folderPath, mergedForPreview);
    const deletedEntries: BuilderFileEntry[] = Array.from(deletedPathsRun).map((delPath) => ({
      path: delPath,
      content: "",
      action: "delete"
    }));
    const consolidatedFiles = [...refreshedPreview, ...deletedEntries];

    const changedParts: string[] = [];
    if (writtenList.length > 0) changedParts.push(`${writtenList.length} gravado(s)`);
    if (deletedList.length > 0) changedParts.push(`${deletedList.length} removido(s)`);

    await patchTurnBuilderState(debateId, turnId, (prev) => ({
      ...(prev ?? { enabled: true, autoApply: false, files: [], status: "verifying", updatedAt: "" }),
      status: "verifying",
      summary: `Correção ${fixAttempt}/${MAX_FIX_ATTEMPTS} aplicada (${changedParts.join(", ") || "sem alterações"}). Re-testando...`,
      files: consolidatedFiles,
      lastBackup: latestBackup ?? prev?.lastBackup,
      checks: lastChecks,
      fixAttempt,
      maxFixAttempts: MAX_FIX_ATTEMPTS,
      updatedAt: new Date().toISOString()
    }));
  }
}

/**
 * 3. Aplica os arquivos na pasta vinculada com backup em `.ai-council-backup/`
 *    e opcionalmente roda verificação segura + loop de autocorreção (até 3x).
 */
export async function applyBuilderTurnToDisk(
  debateId: string,
  turnId?: string,
  options: {
    selectedPaths?: string[];
    runVerification?: boolean;
    autoFix?: boolean;
    signal?: AbortSignal;
  } = {}
): Promise<DebateSession> {
  const ownController = options.signal ? null : new AbortController();
  const signal = options.signal ?? ownController!.signal;

  if (ownController) {
    if (activeBuilderControllers.has(debateId)) {
      throw new Error("Já existe uma tarefa do Construtor em andamento nesta conversa.");
    }
    activeBuilderControllers.set(debateId, ownController);
  }

  try {
    let session = await readDebateSessionById(debateId);
    if (!session) throw new Error("Conversa não encontrada.");
    let turn = resolveTurn(session, turnId);
    if (!turn) throw new Error("Turno não encontrado.");

    if (!turn.builderState) {
      session = await extractBuilderFilesForTurn(debateId, turn.id);
      turn = resolveTurn(session, turn.id)!;
    }

    const proj = await resolveProjectFolderForSession(session);
    const allFiles = turn.builderState?.files ?? [];
    const selectedSet =
      Array.isArray(options.selectedPaths) && options.selectedPaths.length > 0
        ? new Set(options.selectedPaths)
        : null;

    const toApply = allFiles.filter(
      (f) =>
        (f.action === "create" || f.action === "overwrite") &&
        (!selectedSet || selectedSet.has(f.path))
    );

    if (toApply.length === 0) {
      const refreshed = await patchTurnBuilderState(debateId, turn.id, (prev) => ({
        ...(prev ?? { enabled: true, autoApply: false, files: allFiles, status: "ready", updatedAt: "" }),
        status: "ready",
        summary: "Nenhuma alteração pendente para gravar na pasta.",
        updatedAt: new Date().toISOString()
      }));
      return refreshed ?? session;
    }

    await patchTurnBuilderState(debateId, turn.id, (prev) => ({
      ...(prev ?? { enabled: true, autoApply: false, files: allFiles, status: "applying", updatedAt: "" }),
      status: "applying",
      summary: `Criando backup em .ai-council-backup/ e gravando ${toApply.length} arquivo(s)...`,
      lastError: undefined,
      updatedAt: new Date().toISOString()
    }));

    const appliedRes = await applyWorkspaceChanges(
      proj.folderPath,
      toApply.map((f) => ({ path: f.path, content: f.content }))
    );

    const postPreview = await previewWorkspaceChanges(
      proj.folderPath,
      allFiles.map((f) => ({ path: f.path, content: f.content, incomplete: Boolean(f.incomplete) }))
    );

    const afterWrite = await patchTurnBuilderState(debateId, turn.id, (prev) => ({
      ...(prev ?? { enabled: true, autoApply: false, files: postPreview, status: "completed", updatedAt: "" }),
      status: options.runVerification === false ? "completed" : "verifying",
      summary: `${appliedRes.backup?.filesWritten.length ?? 0} arquivo(s) gravado(s) em ${proj.projectName} (backup pronto para Desfazer).`,
      files: postPreview,
      lastBackup: appliedRes.backup ?? prev?.lastBackup,
      updatedAt: new Date().toISOString()
    }));

    if (options.runVerification === false) {
      return afterWrite ?? session;
    }

    return await runVerificationAndAutoFixLoop({
      debateId,
      turnId: turn.id,
      projectId: proj.projectId,
      folderPath: proj.folderPath,
      projectInstructions: proj.instructions,
      userGoal: turn.prompt,
      initialWrittenPaths: appliedRes.backup?.filesWritten ?? [],
      initialBackup: appliedRes.backup ?? turn.builderState?.lastBackup,
      autoFix: options.autoFix !== false,
      signal
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro ao aplicar arquivos.";
    const turnRef = resolveTurn((await readDebateSessionById(debateId))!, turnId);
    if (turnRef) {
      await patchTurnBuilderState(debateId, turnRef.id, (prev) => ({
        ...(prev ?? { enabled: true, autoApply: false, files: [], status: "failed", updatedAt: "" }),
        status: signal.aborted ? "stopped" : "failed",
        summary: signal.aborted ? "Interrompido pelo usuário." : msg,
        lastError: signal.aborted ? undefined : msg,
        updatedAt: new Date().toISOString()
      }));
    }
    throw err;
  } finally {
    if (ownController) {
      activeBuilderControllers.delete(debateId);
    }
  }
}

/**
 * 4. Executa verificação (install/build/test) + loop de autocorreção sob demanda.
 */
export async function verifyAndAutoFixBuilderTurn(
  debateId: string,
  turnId?: string,
  options: { autoFix?: boolean } = {}
): Promise<DebateSession> {
  if (activeBuilderControllers.has(debateId)) {
    throw new Error("Já existe uma tarefa do Construtor em andamento nesta conversa.");
  }
  const controller = new AbortController();
  activeBuilderControllers.set(debateId, controller);

  try {
    const session = await readDebateSessionById(debateId);
    if (!session) throw new Error("Conversa não encontrada.");
    const turn = resolveTurn(session, turnId);
    if (!turn) throw new Error("Turno não encontrado.");
    const proj = await resolveProjectFolderForSession(session);

    return await runVerificationAndAutoFixLoop({
      debateId,
      turnId: turn.id,
      projectId: proj.projectId,
      folderPath: proj.folderPath,
      projectInstructions: proj.instructions,
      userGoal: turn.prompt,
      initialWrittenPaths: turn.builderState?.lastBackup?.filesWritten ?? [],
      initialBackup: turn.builderState?.lastBackup,
      autoFix: options.autoFix !== false,
      signal: controller.signal
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro na verificação.";
    const session = await readDebateSessionById(debateId);
    const turn = session ? resolveTurn(session, turnId) : null;
    if (turn) {
      await patchTurnBuilderState(debateId, turn.id, (prev) => ({
        ...(prev ?? { enabled: true, autoApply: false, files: [], status: "failed", updatedAt: "" }),
        status: controller.signal.aborted ? "stopped" : "failed",
        summary: controller.signal.aborted ? "Interrompido pelo usuário." : msg,
        lastError: controller.signal.aborted ? undefined : msg,
        updatedAt: new Date().toISOString()
      }));
    }
    throw err;
  } finally {
    activeBuilderControllers.delete(debateId);
  }
}

/**
 * 5. Desfaz o último lote gravado na pasta restaurando `.ai-council-backup/<batchId>`.
 */
export async function undoBuilderTurnBackup(
  debateId: string,
  turnId?: string,
  batchId?: string
): Promise<DebateSession> {
  if (activeBuilderControllers.has(debateId)) {
    throw new Error("Aguarde ou clique em Parar antes de desfazer.");
  }
  const session = await readDebateSessionById(debateId);
  if (!session) throw new Error("Conversa não encontrada.");
  const turn = resolveTurn(session, turnId);
  if (!turn) throw new Error("Turno não encontrado.");
  const proj = await resolveProjectFolderForSession(session);

  const undone = await undoWorkspaceBackup(
    proj.folderPath,
    batchId || turn.builderState?.lastBackup?.batchId
  );

  const refreshedPreview = await previewWorkspaceChanges(
    proj.folderPath,
    (turn.builderState?.files ?? []).map((f) => ({
      path: f.path,
      content: f.content,
      incomplete: Boolean(f.incomplete)
    }))
  );

  const updated = await patchTurnBuilderState(debateId, turn.id, (prev) => ({
    ...(prev ?? { enabled: true, autoApply: false, files: refreshedPreview, status: "ready", updatedAt: "" }),
    status: "ready",
    summary: `Alterações desfeitas (${undone.restoredCount} restaurado(s), ${undone.removedCreatedCount} criado(s) removido(s)).`,
    files: refreshedPreview,
    lastBackup: undone.backup,
    lastError: undefined,
    updatedAt: new Date().toISOString()
  }));

  if (!updated) throw new Error("Falha ao atualizar estado após desfazer.");
  return updated;
}

/**
 * 6. Gancho automático disparado pelo Runner quando um turno em Modo Construtor conclui a síntese.
 */
export async function runAutoBuilderAfterTurnCompleted(
  debateId: string,
  turnId: string
): Promise<void> {
  const key = `${debateId}:${turnId}`;
  if (autoBuilderAttempted.has(key) || activeBuilderControllers.has(debateId)) {
    return;
  }
  if (autoBuilderAttempted.size >= MAX_AUTO_BUILDER_HISTORY) {
    const oldest = autoBuilderAttempted.values().next().value;
    if (oldest) autoBuilderAttempted.delete(oldest);
  }
  autoBuilderAttempted.add(key);

  const controller = new AbortController();
  activeBuilderControllers.set(debateId, controller);

  try {
    const initial = await readDebateSessionById(debateId);
    if (!initial) return;
    const turn = resolveTurn(initial, turnId);
    if (!turn || !turn.builderMode || turn.status !== "completed") return;
    if (turn.builderState && turn.builderState.status !== "idle") return;

    await patchTurnBuilderState(debateId, turn.id, () => ({
      enabled: true,
      autoApply: Boolean(turn.builderAutoApply),
      status: "extracting",
      projectId: initial.projectId,
      summary: "Extraindo estrutura de pastas e arquivos da síntese do Conselho...",
      files: [],
      maxFixAttempts: MAX_FIX_ATTEMPTS,
      updatedAt: new Date().toISOString()
    }));

    let updated = await extractBuilderFilesForTurn(debateId, turn.id);
    if (!turn.builderAutoApply || controller.signal.aborted) {
      return;
    }

    const st = resolveTurn(updated, turn.id)?.builderState;
    const needsGen =
      (st?.missingPaths?.length ?? 0) > 0 ||
      (st?.files ?? []).some((f) => f.incomplete && f.action !== "blocked");

    if (needsGen && !controller.signal.aborted) {
      updated = await generateRemainingBuilderFiles(debateId, turn.id, {
        signal: controller.signal
      });
    }

    if (controller.signal.aborted) return;

    const afterGen = resolveTurn(updated, turn.id)?.builderState;
    const hasWritable = (afterGen?.files ?? []).some(
      (f) => f.action === "create" || f.action === "overwrite"
    );

    if (hasWritable) {
      await applyBuilderTurnToDisk(debateId, turn.id, {
        runVerification: true,
        autoFix: true,
        signal: controller.signal
      });
    }
  } catch (err) {
    console.warn(
      "[AI Council] Erro no Modo Construtor automático:",
      err instanceof Error ? err.message : err
    );
    const msg = err instanceof Error ? err.message : "Erro no Modo Construtor.";
    await patchTurnBuilderState(debateId, turnId, (prev) => ({
      ...(prev ?? { enabled: true, autoApply: true, files: [], status: "failed", updatedAt: "" }),
      status: controller.signal.aborted ? "stopped" : "failed",
      summary: controller.signal.aborted ? "Interrompido pelo usuário." : msg,
      lastError: controller.signal.aborted ? undefined : msg,
      updatedAt: new Date().toISOString()
    })).catch(() => {});
  } finally {
    activeBuilderControllers.delete(debateId);
  }
}
