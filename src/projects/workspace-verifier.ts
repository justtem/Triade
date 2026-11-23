import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import type { BuilderCommandRun } from "../shared/debate-types.js";
import { inspectLinkedFolder } from "./project-rag.js";
import { auditWorkspaceSecurity } from "./workspace-security-audit.js";

const INSTALL_TIMEOUT_MS = 120_000;
const CHECK_TIMEOUT_MS = 60_000;
const DIAGNOSTIC_TIMEOUT_MS = 15_000;
const MAX_OUTPUT_CHARS = 12_000;

export type AllowedVerificationAction =
  | "npm_install"
  | "npm_build"
  | "tsc_noemit"
  | "npm_test";

interface PlannedCheck {
  action: AllowedVerificationAction;
  label: string;
  displayCommand: string;
  bin: string;
  args: string[];
  timeoutMs: number;
  nodeTestScript?: string;
}

export interface WorkspaceVerificationResult {
  allPassed: boolean;
  ranAny: boolean;
  checks: BuilderCommandRun[];
  summary: string;
}

function stripAnsi(input: string): string {
  return String(input || "").replace(
    // eslint-disable-next-line no-control-regex
    /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
    ""
  );
}

function trimCommandOutput(raw: string): string {
  const clean = stripAnsi(raw).trim();
  if (clean.length <= MAX_OUTPUT_CHARS) return clean;
  const head = clean.slice(0, 3_500);
  const tail = clean.slice(-(MAX_OUTPUT_CHARS - 3_600));
  return `${head}\n\n[... saída intermediária omitida ...]\n\n${tail}`;
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function npmExecutable(): string {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function npxExecutable(): string {
  return process.platform === "win32" ? "npx.cmd" : "npx";
}

function isPlaceholderTestScript(script: string): boolean {
  const s = script.trim().toLowerCase();
  return !s || s.includes("no test specified");
}

function isNodeTestScript(script: string): boolean {
  const s = script.trim().toLowerCase();
  return /^node\s+/.test(s) && /(?:^|\s)--test(?:\s|$|=)/.test(s);
}

/**
 * Monta argumentos seguros (sem shell) para re-executar um script `node --test ...`
 * inserindo `--test-force-exit` logo após `node` (antes de eventuais arquivos posicionais).
 * Rejeita qualquer metacaractere de shell por segurança.
 */
function buildSafeNodeTestForceExitArgs(script: string): string[] | null {
  const trimmed = script.trim();
  if (!trimmed || /[&|;<>`$\r\n]/.test(trimmed)) return null;
  const tokens = trimmed.split(/\s+/).filter(Boolean);
  if (tokens.length < 2 || tokens[0]?.toLowerCase() !== "node") return null;
  const rest = tokens.slice(1).map((t) => t.replace(/^["']|["']$/g, ""));
  if (!rest.some((t) => t === "--test" || t.startsWith("--test="))) return null;
  if (rest.some((t) => t === "--test-force-exit")) return rest;
  return ["--test-force-exit", ...rest];
}

function killChildProcessTree(pid: number | undefined): Promise<void> {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return Promise.resolve();
  if (process.platform === "win32") {
    return new Promise((resolveKill) => {
      try {
        execFile(
          "taskkill.exe",
          ["/PID", String(pid), "/T", "/F"],
          { windowsHide: true, shell: false, timeout: 4_000 },
          () => resolveKill()
        );
      } catch {
        resolveKill();
      }
    });
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Ignora
  }
  return Promise.resolve();
}

/**
 * Monta a fila estritamente allowlisted de verificação para a pasta do projeto.
 * NUNCA aceita comandos arbitrários vindos de prompts ou respostas da IA.
 */
export async function planWorkspaceVerification(
  rootDir: string,
  options: { packageJsonChanged?: boolean; checkTimeoutMs?: number } = {}
): Promise<PlannedCheck[]> {
  const inspection = await inspectLinkedFolder(rootDir);
  if (!inspection.valid) {
    throw new Error(
      inspection.error || "Pasta do projeto inválida para verificação."
    );
  }

  const rootReal = await realpath(rootDir);
  const pkgPath = join(rootReal, "package.json");
  if (!(await pathExists(pkgPath))) {
    return [];
  }

  let pkg: {
    scripts?: Record<string, unknown>;
    dependencies?: Record<string, unknown>;
    devDependencies?: Record<string, unknown>;
  } = {};

  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8")) as typeof pkg;
  } catch {
    throw new Error("O arquivo package.json do projeto contém JSON inválido.");
  }

  const effectiveCheckTimeout =
    typeof options.checkTimeoutMs === "number" && Number.isFinite(options.checkTimeoutMs)
      ? Math.min(120_000, Math.max(2_000, Math.floor(options.checkTimeoutMs)))
      : CHECK_TIMEOUT_MS;

  const checks: PlannedCheck[] = [];
  const hasDeps =
    Object.keys(pkg.dependencies ?? {}).length > 0 ||
    Object.keys(pkg.devDependencies ?? {}).length > 0;
  const hasNodeModules = await pathExists(join(rootReal, "node_modules"));

  if (hasDeps && (!hasNodeModules || options.packageJsonChanged)) {
    checks.push({
      action: "npm_install",
      label: "Instalar dependências",
      displayCommand: "npm install",
      bin: npmExecutable(),
      args: ["install", "--no-audit", "--no-fund"],
      timeoutMs: INSTALL_TIMEOUT_MS
    });
  }

  const scripts = pkg.scripts ?? {};
  const hasBuild =
    typeof scripts.build === "string" && scripts.build.trim().length > 0;
  const hasTsConfig = await pathExists(join(rootReal, "tsconfig.json"));

  if (hasBuild) {
    checks.push({
      action: "npm_build",
      label: "Build",
      displayCommand: "npm run build",
      bin: npmExecutable(),
      args: ["run", "build"],
      timeoutMs: effectiveCheckTimeout
    });
  } else if (hasTsConfig) {
    checks.push({
      action: "tsc_noemit",
      label: "TypeScript Check",
      displayCommand: "npx tsc --noEmit",
      bin: npxExecutable(),
      args: ["tsc", "--noEmit"],
      timeoutMs: effectiveCheckTimeout
    });
  }

  const testScript = typeof scripts.test === "string" ? scripts.test : "";
  if (!isPlaceholderTestScript(testScript)) {
    checks.push({
      action: "npm_test",
      label: "Testes",
      displayCommand: "npm test",
      bin: npmExecutable(),
      args: ["test"],
      timeoutMs: effectiveCheckTimeout,
      nodeTestScript: isNodeTestScript(testScript) ? testScript.trim() : undefined
    });
  }

  return checks;
}

function runSinglePlannedCheck(
  cwd: string,
  check: PlannedCheck,
  signal?: AbortSignal
): Promise<BuilderCommandRun> {
  return new Promise((resolveRun) => {
    const startedAt = Date.now();
    const isWinCmd = process.platform === "win32" && check.bin.endsWith(".cmd");
    const execBin = isWinCmd ? process.env.ComSpec || "cmd.exe" : check.bin;
    const execArgs = isWinCmd
      ? ["/d", "/s", "/c", check.bin, ...check.args]
      : check.args;

    let settled = false;
    let manualTimedOut = false;

    const childEnv: NodeJS.ProcessEnv = {
      ...process.env,
      CI: "true",
      NO_COLOR: "1"
    };
    // Evita que testes aninhados herdem o contexto do runner pai (ex.: `node --test`)
    delete childEnv.NODE_TEST_CONTEXT;

    const child = execFile(
      execBin,
      execArgs,
      {
        cwd,
        timeout: check.timeoutMs + 3_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        shell: false,
        signal,
        env: childEnv
      },
      async (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        clearTimeout(treeKillTimer);

        const durationMs = Math.max(1, Date.now() - startedAt);
        const combined = [stdout, stderr].filter(Boolean).join("\n");
        const errObj = error as { code?: unknown; killed?: boolean; signal?: string } | null;
        const timedOut =
          !signal?.aborted &&
          Boolean(
            manualTimedOut ||
              (errObj &&
                (errObj.killed ||
                  errObj.signal === "SIGTERM" ||
                  errObj.signal === "SIGKILL" ||
                  durationMs >= check.timeoutMs - 300))
          );

        if (timedOut || signal?.aborted) {
          await killChildProcessTree(child.pid);
        }

        const exitCode =
          errObj && typeof errObj.code === "number"
            ? Number(errObj.code)
            : error
              ? timedOut
                ? 124
                : 1
              : 0;
        const ok = !error && !timedOut;
        const extraErr =
          !ok && !combined.trim() && error instanceof Error ? error.message : "";

        let outputText = combined || extraErr || (ok ? "OK" : "Falha na execução.");
        if (timedOut) {
          const secs = (check.timeoutMs / 1000).toFixed(0);
          outputText = [
            outputText,
            "",
            `[TIMEOUT após ${secs}s] O comando "${check.displayCommand}" não finalizou no limite de tempo e foi encerrado.`,
            "Causa comum: servidor HTTP sem server.close()/server.closeAllConnections(), sockets keep-alive, timers abertos ou arquivo de teste antigo (.js compilado) rodando junto com .ts."
          ]
            .filter(Boolean)
            .join("\n");
        }

        resolveRun({
          label: check.label,
          command: check.displayCommand,
          exitCode,
          ok,
          timedOut: timedOut || undefined,
          durationMs,
          output: trimCommandOutput(outputText)
        });
      }
    );

    const treeKillTimer = setTimeout(() => {
      if (settled) return;
      manualTimedOut = true;
      void killChildProcessTree(child.pid);
    }, check.timeoutMs);
    treeKillTimer.unref?.();

    const onAbort = () => {
      void killChildProcessTree(child.pid);
    };
    if (signal) {
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }
  });
}

async function runNodeTestTimeoutDiagnostic(
  cwd: string,
  nodeTestScript: string,
  signal?: AbortSignal
): Promise<string | null> {
  if (signal?.aborted) return null;
  const directArgs = buildSafeNodeTestForceExitArgs(nodeTestScript);
  const diagCheck: PlannedCheck = directArgs
    ? {
        action: "npm_test",
        label: "Diagnóstico force-exit",
        displayCommand: `node ${directArgs.join(" ")}`,
        bin: process.execPath,
        args: directArgs,
        timeoutMs: DIAGNOSTIC_TIMEOUT_MS
      }
    : {
        action: "npm_test",
        label: "Diagnóstico force-exit",
        displayCommand: "npm test -- --test-force-exit",
        bin: npmExecutable(),
        args: ["test", "--", "--test-force-exit"],
        timeoutMs: DIAGNOSTIC_TIMEOUT_MS
      };
  const diagRun = await runSinglePlannedCheck(cwd, diagCheck, signal);
  const out = (diagRun.output || "").trim();
  if (!out) return null;
  return out;
}

async function auditFrontendLocalAssets(
  rootReal: string
): Promise<BuilderCommandRun | null> {
  const startedAt = Date.now();
  const htmlPath = join(rootReal, "public", "index.html");
  if (!(await pathExists(htmlPath))) {
    return null;
  }

  let html = "";
  try {
    html = await readFile(htmlPath, "utf8");
  } catch {
    return null;
  }

  const assetRefs: string[] = [];
  const patterns = [
    /<link\b[^>]*\bhref=["']([^"']+\.css)(?:\?[^"']*)?["'][^>]*>/gi,
    /<script\b[^>]*\bsrc=["']([^"']+\.(?:js|mjs))(?:\?[^"']*)?["'][^>]*>/gi
  ];

  for (const re of patterns) {
    for (const m of html.matchAll(re)) {
      const rawHref = (m[1] ?? "").trim();
      if (!rawHref || /^(?:https?:|\/\/|data:)/i.test(rawHref)) continue;
      const cleanHref = rawHref.replace(/^\/+/, "").replace(/^\.\//, "");
      if (!cleanHref || cleanHref.includes("..")) continue;
      const relPath = cleanHref.startsWith("public/") ? cleanHref : `public/${cleanHref}`;
      if (!assetRefs.includes(relPath)) assetRefs.push(relPath);
    }
  }

  if (assetRefs.length === 0) return null;

  const issues: string[] = [];
  for (const relPath of assetRefs) {
    const absPath = join(rootReal, ...relPath.split("/"));
    if (!(await pathExists(absPath))) {
      issues.push(
        `Asset obrigatório ausente: \`${relPath}\` (referenciado em \`public/index.html\`). Crie o arquivo \`${relPath}\` 100% completo e compatível com os IDs de \`public/index.html\` e as rotas reais de \`src/server.ts\`.`
      );
      continue;
    }

    try {
      const content = await readFile(absPath, "utf8");
      if (content.trim().length < 20) {
        issues.push(
          `Asset vazio ou incompleto: \`${relPath}\` (${content.trim().length} bytes). Entregue o arquivo completo.`
        );
        continue;
      }
      if (relPath.toLowerCase().endsWith(".css")) {
        const noComments = content.replace(/\/\*[\s\S]*?\*\//g, "");
        const openBraces = (noComments.match(/\{/g) ?? []).length;
        const closeBraces = (noComments.match(/\}/g) ?? []).length;
        if (openBraces === 0 || openBraces !== closeBraces || /\n---\s*\n\s*#{1,3}\s+/.test(content)) {
          issues.push(
            `CSS inválido ou truncado em \`${relPath}\` (chaves {=${openBraces}, }=${closeBraces}). Entregue \`${relPath}\` completo e válido.`
          );
        }
      }
    } catch {
      issues.push(`Não foi possível ler \`${relPath}\`.`);
    }
  }

  const durationMs = Math.max(1, Date.now() - startedAt);
  if (issues.length === 0) {
    return {
      label: "Assets Frontend",
      command: "frontend-assets-check",
      exitCode: 0,
      ok: true,
      durationMs,
      output: `OK: ${assetRefs.length} asset(s) verificado(s) (${assetRefs.join(", ")}).`
    };
  }

  return {
    label: "Assets Frontend",
    command: "frontend-assets-check",
    exitCode: 1,
    ok: false,
    durationMs,
    output: [
      `Falha na integridade de assets frontend (${issues.length} problema(s)):`,
      ...issues.map((i) => `- ${i}`),
      "",
      "Referências relevantes: public/index.html, src/server.ts"
    ].join("\n")
  };
}

export async function verifyWorkspaceProject(
  rootDir: string,
  options: {
    packageJsonChanged?: boolean;
    signal?: AbortSignal;
    checkTimeoutMs?: number;
  } = {}
): Promise<WorkspaceVerificationResult> {
  const rootReal = await realpath(rootDir);
  const planned = await planWorkspaceVerification(rootReal, {
    packageJsonChanged: options.packageJsonChanged,
    checkTimeoutMs: options.checkTimeoutMs
  });

  if (planned.length === 0) {
    return {
      allPassed: true,
      ranAny: false,
      checks: [],
      summary: "Nenhum script build/test detectado em package.json."
    };
  }

  const checks: BuilderCommandRun[] = [];
  for (const step of planned) {
    if (options.signal?.aborted) {
      throw new Error("Verificação interrompida pelo usuário.");
    }
    const run = await runSinglePlannedCheck(rootReal, step, options.signal);

    // Se `npm test` usando `node --test` travou por timeout (handles abertos),
    // faz uma passada rápida allowlisted com `--test-force-exit` APENAS para revelar
    // o stack trace e o caminho exato do arquivo que falhou (mantendo o check como falha!).
    if (!run.ok && run.timedOut && step.action === "npm_test" && step.nodeTestScript) {
      const diagOut = await runNodeTestTimeoutDiagnostic(
        rootReal,
        step.nodeTestScript,
        options.signal
      );
      if (diagOut) {
        run.output = trimCommandOutput(
          `${run.output}\n\n[DIAGNÓSTICO AUTOMÁTICO (--test-force-exit) — stack trace real recuperado]:\n${diagOut}`
        );
      }
    }

    checks.push(run);
    // Se install ou build falhar, já interrompe para corrigir antes de rodar testes
    if (!run.ok) {
      return {
        allPassed: false,
        ranAny: true,
        checks,
        summary: run.timedOut
          ? `Timeout em "${run.command}" após ${(run.durationMs / 1000).toFixed(1)}s (processo travado — provável servidor/handle aberto).`
          : `Falha em "${run.command}" (exit ${run.exitCode}).`
      };
    }
  }

  // Checa integridade de assets locais citados em public/index.html (ex.: /app.js, /style.css):
  // impede "falso verde" quando o app compila mas public/app.js está faltando ou style.css foi truncado!
  const frontendAudit = await auditFrontendLocalAssets(rootReal);
  if (frontendAudit) {
    checks.push(frontendAudit);
    if (!frontendAudit.ok) {
      return {
        allPassed: false,
        ranAny: true,
        checks,
        summary: `Assets frontend ausentes ou quebrados (verifique public/app.js / public/style.css).`
      };
    }
  }

  // Após build/test passarem, roda Mini-Auditor estático de segurança (0ms):
  // falhas críticas (XSS innerHTML, 0.0.0.0, hash fraco de senha, log de PII, eval)
  // reprovam o check para o Auto-Fix corrigir automaticamente.
  const secAudit = await auditWorkspaceSecurity(rootReal);
  if (secAudit.auditedFilesCount > 0) {
    checks.push(secAudit.checkRun);
    if (!secAudit.passed) {
      return {
        allPassed: false,
        ranAny: true,
        checks,
        summary: `Auditoria de segurança encontrou ${secAudit.criticalCount} falha(s) crítica(s) para corrigir.`
      };
    }
  }

  return {
    allPassed: true,
    ranAny: true,
    checks,
    summary: `Verificação aprovada (${checks.map((c) => c.command).join(" + ")}).`
  };
}
