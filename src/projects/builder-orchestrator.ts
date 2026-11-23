import { readFile } from "node:fs/promises";

import {
  readDebateSessionById,
  withDebateLock,
  writeDebateSessionAtomically
} from "../persistence/debate-store.js";
import { getProjectById } from "../persistence/project-store.js";
import { getProvider } from "../providers/registry.js";
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
): { primaryMarkdown: string; allMarkdown: string; sourceLabel?: string } {
  const turnResponses = (session.responses ?? []).filter(
    (r) => r.turnId === turn.id || (turn.index === 1 && !r.turnId)
  );

  if (sourcePlatform) {
    const specific = turnResponses.filter((r) => r.platform === sourcePlatform).at(-1);
    const content = specific?.content?.trim() || "";
    return {
      primaryMarkdown: content,
      allMarkdown: content,
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

  const pieces = [
    turn.conclusion,
    synth?.content,
    winnerResp?.content,
    geminiResp?.content,
    ...turnResponses.map((r) => r.content)
  ].filter((x): x is string => typeof x === "string" && x.trim().length > 0);

  return {
    primaryMarkdown,
    allMarkdown: Array.from(new Set(pieces)).join("\n\n---\n\n")
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

async function callBuilderModel(params: {
  systemPrompt: string;
  userPrompt: string;
  maxTokens: number;
  signal?: AbortSignal;
}): Promise<{ content: string; platform: AutoPlatform; model: string }> {
  const order: AutoPlatform[] = ["gemini", "openrouter"];
  let lastError: unknown = null;

  for (const plat of order) {
    const provider = getProvider(plat);
    if (!provider) continue;
    try {
      const res = await provider.generate({
        system: params.systemPrompt,
        user: params.userPrompt,
        maxTokens: params.maxTokens,
        signal: params.signal
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
      ? `Nenhum provedor disponível para o Construtor (Gemini/OpenRouter): ${lastError.message}`
      : "Nenhum provedor configurado para o Construtor (Gemini ou OpenRouter)."
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
  const { primaryMarkdown, allMarkdown, sourceLabel } = collectTurnMarkdownSources(
    session,
    turn,
    options.sourcePlatform
  );

  let extraction = extractWorkspaceFilesFromMarkdown(primaryMarkdown);
  if (!options.sourcePlatform && extraction.files.length === 0 && allMarkdown !== primaryMarkdown) {
    extraction = extractWorkspaceFilesFromMarkdown(allMarkdown);
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

    for (let i = 0; i < queue.length; i++) {
      const targetPath = queue[i]!;
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

      await patchTurnBuilderState(debateId, turn.id, (prev) => ({
        ...(prev ?? { enabled: true, autoApply: false, files: workingFiles, status: "generating", updatedAt: "" }),
        status: "generating",
        summary: `Gerando arquivo ${i + 1}/${queue.length}: ${targetPath}...`,
        files: workingFiles,
        missingPaths: remainingMissing,
        updatedAt: new Date().toISOString()
      }));

      const knownSummary = workingFiles
        .filter((f) => !f.incomplete && f.path !== targetPath)
        .slice(0, 8)
        .map((f) => `### \`${f.path}\`\n\`\`\`\n${f.content.slice(0, 1800)}\n\`\`\``)
        .join("\n\n");

      const userPrompt = [
        `Pedido do usuário:\n${turn.prompt}`,
        `\nPlano / síntese do Conselho:\n${primaryMarkdown.slice(0, 10_000)}`,
        knownSummary ? `\nArquivos já definidos (mantenha imports e tipos 100% compatíveis):\n${knownSummary}` : "",
        `\nGere agora o arquivo completo: \`${targetPath}\``
      ]
        .filter(Boolean)
        .join("\n");

      const res = await callBuilderModel({
        systemPrompt,
        userPrompt,
        maxTokens: 6_000,
        signal
      });

      const generatedContent = extractSingleFileContentFromModelOutput(
        res.content,
        targetPath
      );

      if (generatedContent) {
        const merged = mergeExtractedFiles(workingFiles, [
          { path: targetPath, content: generatedContent, incomplete: false }
        ]);
        workingFiles = await previewWorkspaceChanges(proj.folderPath, merged);
        remainingMissing = remainingMissing.filter((p) => p !== targetPath);
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

async function readRelevantFilesForFix(
  folderPath: string,
  errorOutput: string,
  fallbackPaths: string[],
  workspaceTree: string[]
): Promise<Array<{ path: string; content: string }>> {
  const ordered: string[] = [];
  const seen = new Set<string>();
  const addCandidate = (p: string) => {
    const clean = p.replace(/\\/g, "/").replace(/^\.\//, "").trim();
    if (!clean || clean.startsWith("node_modules/") || seen.has(clean)) return;
    seen.add(clean);
    ordered.push(clean);
  };

  // 1. Arquivos citados diretamente no erro/stack trace (inclusive caminhos Windows ou file:///)
  const normalizedErr = errorOutput.replace(/\\/g, "/");
  for (const treePath of workspaceTree) {
    if (normalizedErr.includes(treePath)) {
      addCandidate(treePath);
    }
  }
  for (const m of errorOutput.matchAll(
    /([a-zA-Z0-9._-]+(?:[\\/][a-zA-Z0-9._-]+)+\.(?:ts|tsx|js|jsx|mjs|cjs|json|css|html))/g
  )) {
    addCandidate(m[1] ?? "");
  }

  // 2. Arquivos de configuração e recém-alterados
  addCandidate("package.json");
  addCandidate("tsconfig.json");
  for (const p of fallbackPaths) {
    addCandidate(p);
  }

  // 3. Demais arquivos de teste e código do projeto (para a IA nunca corrigir "no escuro")
  const extraTestFiles = workspaceTree.filter(
    (p) => isPrioritizedSourceFile(p) && /(?:^|\/)(?:tests?|__tests__|spec)\//i.test(p)
  );
  const extraSrcFiles = workspaceTree.filter(
    (p) => isPrioritizedSourceFile(p) && !extraTestFiles.includes(p)
  );
  for (const p of [...extraTestFiles, ...extraSrcFiles]) {
    addCandidate(p);
  }

  const loaded: Array<{ path: string; content: string }> = [];
  let totalChars = 0;

  for (const relPath of ordered.slice(0, 18)) {
    if (totalChars >= MAX_FIX_CONTEXT_CHARS) break;
    try {
      const safe = await resolveSafeWorkspacePath(folderPath, relPath);
      const raw = await readFile(safe.absPath, "utf8");
      const trimmed = raw.slice(0, Math.min(5_500, MAX_FIX_CONTEXT_CHARS - totalChars));
      totalChars += trimmed.length;
      loaded.push({ path: safe.relPath, content: trimmed });
    } catch {
      // Ignora arquivos não existentes ou bloqueados
    }
  }

  return loaded;
}

async function runVerificationAndAutoFixLoop(params: {
  debateId: string;
  turnId: string;
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
      const done = await patchTurnBuilderState(debateId, turnId, (prev) => ({
        ...(prev ?? { enabled: true, autoApply: false, files: [], status: "completed", updatedAt: "" }),
        status: "completed",
        summary:
          fixAttempt > 0
            ? `${verification.summary} (corrigido automaticamente em ${fixAttempt} tentativa${fixAttempt > 1 ? "s" : ""})`
            : verification.summary,
        lastBackup: latestBackup ?? prev?.lastBackup,
        checks: lastChecks,
        fixAttempt,
        maxFixAttempts: MAX_FIX_ATTEMPTS,
        lastError: undefined,
        updatedAt: new Date().toISOString()
      }));
      if (!done) throw new Error("Conversa não encontrada.");
      return done;
    }

    if (!autoFix || fixAttempt >= MAX_FIX_ATTEMPTS) {
      const failed = await patchTurnBuilderState(debateId, turnId, (prev) => ({
        ...(prev ?? { enabled: true, autoApply: false, files: [], status: "failed", updatedAt: "" }),
        status: "failed",
        summary:
          fixAttempt > 0
            ? `${verification.summary} Após ${fixAttempt} tentativa(s) de autocorreção.`
            : verification.summary,
        lastBackup: latestBackup ?? prev?.lastBackup,
        checks: lastChecks,
        fixAttempt,
        maxFixAttempts: MAX_FIX_ATTEMPTS,
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
      signal
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
