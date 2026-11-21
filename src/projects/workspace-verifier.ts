import { execFile } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import type { BuilderCommandRun } from "../shared/debate-types.js";
import { inspectLinkedFolder } from "./project-rag.js";

const INSTALL_TIMEOUT_MS = 120_000;
const CHECK_TIMEOUT_MS = 60_000;
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

/**
 * Monta a fila estritamente allowlisted de verificação para a pasta do projeto.
 * NUNCA aceita comandos arbitrários vindos de prompts ou respostas da IA.
 */
export async function planWorkspaceVerification(
  rootDir: string,
  options: { packageJsonChanged?: boolean } = {}
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
      timeoutMs: CHECK_TIMEOUT_MS
    });
  } else if (hasTsConfig) {
    checks.push({
      action: "tsc_noemit",
      label: "TypeScript Check",
      displayCommand: "npx tsc --noEmit",
      bin: npxExecutable(),
      args: ["tsc", "--noEmit"],
      timeoutMs: CHECK_TIMEOUT_MS
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
      timeoutMs: CHECK_TIMEOUT_MS
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

    const child = execFile(
      execBin,
      execArgs,
      {
        cwd,
        timeout: check.timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        shell: false,
        signal,
        env: {
          ...process.env,
          CI: "true",
          NO_COLOR: "1"
        }
      },
      (error, stdout, stderr) => {
        const durationMs = Math.max(1, Date.now() - startedAt);
        const combined = [stdout, stderr].filter(Boolean).join("\n");
        const exitCode =
          error && typeof (error as { code?: unknown }).code === "number"
            ? Number((error as { code: number }).code)
            : error
              ? 1
              : 0;
        const ok = !error;
        const extraErr =
          !ok && !combined.trim() && error instanceof Error ? error.message : "";
        resolveRun({
          label: check.label,
          command: check.displayCommand,
          exitCode,
          ok,
          durationMs,
          output: trimCommandOutput(combined || extraErr || (ok ? "OK" : "Falha na execução."))
        });
      }
    );

    if (signal?.aborted) {
      child.kill();
    }
  });
}

export async function verifyWorkspaceProject(
  rootDir: string,
  options: { packageJsonChanged?: boolean; signal?: AbortSignal } = {}
): Promise<WorkspaceVerificationResult> {
  const rootReal = await realpath(rootDir);
  const planned = await planWorkspaceVerification(rootReal, {
    packageJsonChanged: options.packageJsonChanged
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
    checks.push(run);
    // Se install ou build falhar, já interrompe para corrigir antes de rodar testes
    if (!run.ok) {
      return {
        allPassed: false,
        ranAny: true,
        checks,
        summary: `Falha em "${run.command}" (exit ${run.exitCode}).`
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
