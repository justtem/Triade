import { execFile, spawn } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { join } from "node:path";

import type { BuilderCommandRun } from "../shared/debate-types.js";
import { extractLoopbackPortFromText } from "./dev-server-manager.js";
import { inspectLinkedFolder } from "./project-rag.js";
import { auditWorkspaceSecurity } from "./workspace-security-audit.js";

const INSTALL_TIMEOUT_MS = 120_000;
const CHECK_TIMEOUT_MS = 60_000;
const DIAGNOSTIC_TIMEOUT_MS = 15_000;
const SMOKE_TEST_TIMEOUT_MS = 8_500;
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

function checkJsFileSyntax(absPath: string, timeoutMs = 6_000): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolveCheck) => {
    execFile(
      process.execPath,
      ["--check", absPath],
      { windowsHide: true, shell: false, timeout: timeoutMs, maxBuffer: 512 * 1024 },
      (error, stdout, stderr) => {
        if (!error) {
          resolveCheck({ ok: true });
          return;
        }
        const detail = [stderr, stdout, error.message].filter(Boolean).join("\n").trim();
        resolveCheck({ ok: false, error: detail.slice(0, 600) });
      }
    );
  });
}

function allocateFreeLoopbackPort(): Promise<number> {
  return new Promise((resolvePort, rejectPort) => {
    const srv = createNetServer();
    srv.unref();
    srv.on("error", rejectPort);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => {
        if (port > 0) resolvePort(port);
        else rejectPort(new Error("Não foi possível alocar porta loopback livre."));
      });
    });
  });
}

async function fetchWithShortTimeout(
  url: string,
  timeoutMs = 1_500
): Promise<{ ok: boolean; status: number; contentType: string; bodyLen: number }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: "GET", signal: ctrl.signal });
    const text = await res.text();
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get("content-type") || "",
      bodyLen: text.length
    };
  } finally {
    clearTimeout(timer);
  }
}

async function auditFrontendLocalAssets(
  rootReal: string
): Promise<{ checkRun: BuilderCommandRun; assetPaths: string[] } | null> {
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

  const assetRefs: Array<{ relPath: string; urlPath: string }> = [];
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
      const urlPath = `/${cleanHref.replace(/^public\//, "")}`;
      if (!assetRefs.some((a) => a.relPath === relPath)) {
        assetRefs.push({ relPath, urlPath });
      }
    }
  }

  if (assetRefs.length === 0) return null;

  const issues: string[] = [];
  for (const asset of assetRefs) {
    const relPath = asset.relPath;
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
      } else if (/\.(?:js|mjs)$/i.test(relPath)) {
        const syntax = await checkJsFileSyntax(absPath);
        if (!syntax.ok) {
          issues.push(
            `Erro de sintaxe JavaScript em \`${relPath}\` (node --check falhou): ${syntax.error || "SyntaxError"}. Corrija \`${relPath}\` completamente.`
          );
        }
      }
    } catch {
      issues.push(`Não foi possível ler \`${relPath}\`.`);
    }
  }

  const durationMs = Math.max(1, Date.now() - startedAt);
  const urlPaths = assetRefs.map((a) => a.urlPath);
  if (issues.length === 0) {
    return {
      assetPaths: urlPaths,
      checkRun: {
        label: "Assets Frontend",
        command: "frontend-assets-check",
        exitCode: 0,
        ok: true,
        durationMs,
        output: `OK: ${assetRefs.length} asset(s) + sintaxe JS validados (${assetRefs.map((a) => a.relPath).join(", ")}).`
      }
    };
  }

  return {
    assetPaths: urlPaths,
    checkRun: {
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
    }
  };
}

/**
 * Smoke-Test HTTP real (Onda 2): sobe o app temporariamente em porta loopback livre,
 * verifica GET / (200 text/html) e todos os assets locais (/style.css, /app.js = 200 OK),
 * encerrando a árvore de processos imediatamente ao finalizar.
 */
async function runRuntimeHttpSmokeTest(
  rootReal: string,
  assetUrlPaths: string[],
  signal?: AbortSignal
): Promise<BuilderCommandRun | null> {
  const pkgPath = join(rootReal, "package.json");
  if (!(await pathExists(pkgPath))) return null;

  let pkg: { scripts?: Record<string, unknown> } = {};
  try {
    pkg = JSON.parse(await readFile(pkgPath, "utf8")) as typeof pkg;
  } catch {
    return null;
  }

  const scripts = pkg.scripts ?? {};
  const scriptName =
    typeof scripts.dev === "string" && scripts.dev.trim()
      ? "dev"
      : typeof scripts.start === "string" && scripts.start.trim()
        ? "start"
        : null;
  if (!scriptName) return null;

  const startedAt = Date.now();
  let freePort: number;
  try {
    freePort = await allocateFreeLoopbackPort();
  } catch {
    return null;
  }

  const npmBin = npmExecutable();
  const isWin = process.platform === "win32";
  const execBin = isWin ? process.env.ComSpec || "cmd.exe" : npmBin;
  const execArgs = isWin
    ? ["/d", "/s", "/c", npmBin, "run", scriptName]
    : ["run", scriptName];

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: String(freePort),
    NO_COLOR: "1"
  };
  delete childEnv.NODE_TEST_CONTEXT;

  const child = spawn(execBin, execArgs, {
    cwd: rootReal,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv
  });

  const logs: string[] = [];
  let detectedPort: number | null = null;
  let exitedEarly = false;
  let earlyExitCode: number | null = null;

  const collect = (buf: Buffer) => {
    const clean = stripAnsi(buf.toString("utf8"));
    for (const line of clean.split(/\r?\n/)) {
      const t = line.trim();
      if (!t) continue;
      logs.push(t);
      if (logs.length > 30) logs.shift();
      if (!detectedPort) {
        const found = extractLoopbackPortFromText(t);
        if (found) detectedPort = found;
      }
    }
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  child.once("exit", (code) => {
    exitedEarly = true;
    earlyExitCode = code;
  });

  const onAbort = () => {
    void killChildProcessTree(child.pid);
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  try {
    const deadline = Date.now() + SMOKE_TEST_TIMEOUT_MS;
    let activePort: number | null = null;
    let rootRes: { ok: boolean; status: number; contentType: string; bodyLen: number } | null = null;

    while (Date.now() < deadline && !signal?.aborted && !exitedEarly) {
      const portsToTry = Array.from(
        new Set([detectedPort, freePort].filter((p): p is number => Boolean(p)))
      );
      for (const p of portsToTry) {
        try {
          rootRes = await fetchWithShortTimeout(`http://127.0.0.1:${p}/`, 800);
          activePort = p;
          break;
        } catch {
          // Servidor ainda iniciando
        }
      }
      if (activePort && rootRes) break;
      await new Promise((r) => setTimeout(r, 250));
    }

    if (signal?.aborted) {
      throw new Error("Verificação interrompida pelo usuário.");
    }

    const durationMs = Math.max(1, Date.now() - startedAt);
    if (!activePort || !rootRes) {
      const reason = exitedEarly
        ? `O servidor encerrou inesperadamente ao iniciar (exit ${earlyExitCode ?? 1}).`
        : `O servidor não respondeu em 127.0.0.1:${freePort} dentro de ${(SMOKE_TEST_TIMEOUT_MS / 1000).toFixed(1)}s.`;
      return {
        label: "Smoke-Test HTTP",
        command: "runtime-http-smoke",
        exitCode: 1,
        ok: false,
        durationMs,
        output: trimCommandOutput(
          [
            reason,
            "Verifique src/index.ts e src/server.ts (use process.env.PORT e bind em 127.0.0.1).",
            logs.length > 0 ? `\nLogs do servidor:\n${logs.join("\n")}` : ""
          ]
            .filter(Boolean)
            .join("\n")
        )
      };
    }

    const failures: string[] = [];
    if (rootRes.status !== 200 || !/text\/html/i.test(rootRes.contentType) || rootRes.bodyLen < 30) {
      failures.push(
        `GET / retornou HTTP ${rootRes.status} (${rootRes.contentType || "sem content-type"}, ${rootRes.bodyLen} bytes) — esperado HTTP 200 text/html servindo public/index.html via resolve(process.cwd(), "public").`
      );
    }

    const checkedPaths: string[] = ["/"];
    for (const urlPath of assetUrlPaths.slice(0, 8)) {
      checkedPaths.push(urlPath);
      try {
        const assetRes = await fetchWithShortTimeout(`http://127.0.0.1:${activePort}${urlPath}`, 1_500);
        if (assetRes.status !== 200 || assetRes.bodyLen < 10) {
          failures.push(
            `GET ${urlPath} retornou HTTP ${assetRes.status} (${assetRes.bodyLen} bytes) — esperado HTTP 200 com conteúdo válido.`
          );
        }
      } catch (err) {
        failures.push(
          `GET ${urlPath} falhou: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    if (failures.length > 0) {
      return {
        label: "Smoke-Test HTTP",
        command: "runtime-http-smoke",
        exitCode: 1,
        ok: false,
        durationMs,
        output: trimCommandOutput(
          [
            `Smoke-Test HTTP em 127.0.0.1:${activePort} encontrou ${failures.length} falha(s):`,
            ...failures.map((f) => `- ${f}`),
            "",
            "Referências relevantes: src/server.ts, public/index.html",
            logs.length > 0 ? `\nLogs:\n${logs.slice(-10).join("\n")}` : ""
          ]
            .filter(Boolean)
            .join("\n")
        )
      };
    }

    return {
      label: "Smoke-Test HTTP",
      command: "runtime-http-smoke",
      exitCode: 0,
      ok: true,
      durationMs,
      output: `OK: ${checkedPaths.join(", ")} responderam HTTP 200 em 127.0.0.1:${activePort}.`
    };
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await killChildProcessTree(child.pid);
  }
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

  // Checa integridade de assets locais citados em public/index.html (ex.: /app.js, /style.css) + sintaxe JS (`node --check`):
  // impede "falso verde" quando o app compila mas public/app.js está faltando, tem SyntaxError ou style.css foi truncado!
  const frontendAudit = await auditFrontendLocalAssets(rootReal);
  if (frontendAudit) {
    checks.push(frontendAudit.checkRun);
    if (!frontendAudit.checkRun.ok) {
      return {
        allPassed: false,
        ranAny: true,
        checks,
        summary: `Assets frontend ausentes ou quebrados (verifique public/app.js / public/style.css).`
      };
    }

    // Smoke-Test HTTP real em porta isolada (GET /, /style.css, /app.js = HTTP 200)
    const smokeRun = await runRuntimeHttpSmokeTest(
      rootReal,
      frontendAudit.assetPaths,
      options.signal
    );
    if (smokeRun) {
      checks.push(smokeRun);
      if (!smokeRun.ok) {
        return {
          allPassed: false,
          ranAny: true,
          checks,
          summary: `Smoke-Test HTTP falhou (${smokeRun.output.split("\n")[0] || "verifique src/server.ts"}).`
        };
      }
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
