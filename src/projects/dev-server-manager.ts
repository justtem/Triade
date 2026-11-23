import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

import { inspectLinkedFolder } from "./project-rag.js";

const MAX_CONCURRENT_DEV_SERVERS = 3;
const IDLE_AUTO_STOP_MS = 30 * 60 * 1000; // 30 minutos
const PORT_WAIT_TIMEOUT_MS = 10_000;
const MAX_LOG_LINES = 40;

export interface DevServerStatus {
  projectId: string;
  running: boolean;
  canRun: boolean;
  scriptName?: "dev" | "start";
  url?: string;
  port?: number;
  startedAt?: string;
  logsTail?: string;
}

interface RunningDevEntry {
  projectId: string;
  rootReal: string;
  scriptName: "dev" | "start";
  child: ChildProcess;
  port: number | null;
  url: string | null;
  startedAt: string;
  logLines: string[];
  idleTimer: ReturnType<typeof setTimeout>;
}

const runningServers = new Map<string, RunningDevEntry>();
let cleanupRegistered = false;

function stripAnsi(raw: string): string {
  return String(raw || "").replace(
    // eslint-disable-next-line no-control-regex
    /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g,
    ""
  );
}

function killProcessTree(pid: number | undefined): Promise<void> {
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
    process.kill(pid, "SIGTERM");
  } catch {
    // Ignora
  }
  return Promise.resolve();
}

function ensureProcessCleanupRegistered(): void {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  const stopAllSync = () => {
    for (const entry of runningServers.values()) {
      clearTimeout(entry.idleTimer);
      void killProcessTree(entry.child.pid);
    }
    runningServers.clear();
  };
  process.once("exit", stopAllSync);
}

function isSafePreviewPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65535 && port !== 4317;
}

export function extractLoopbackPortFromText(text: string): number | null {
  const clean = stripAnsi(text);
  const patterns = [
    /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{4,5})/i,
    /\b(?:porta|port)\s*[:=]?\s*(\d{4,5})\b/i,
    /\blistening\s+on\s+(?:https?:\/\/)?(?:127\.0\.0\.1|localhost)?[:]?(\d{4,5})\b/i
  ];
  for (const re of patterns) {
    const m = clean.match(re);
    if (m?.[1]) {
      const p = Number.parseInt(m[1], 10);
      if (isSafePreviewPort(p)) return p;
    }
  }
  return null;
}

async function detectRunnableScript(
  rootReal: string
): Promise<{ canRun: boolean; scriptName?: "dev" | "start" }> {
  const pkgPath = join(rootReal, "package.json");
  try {
    await access(pkgPath);
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as {
      scripts?: Record<string, unknown>;
    };
    const scripts = pkg.scripts ?? {};
    if (typeof scripts.dev === "string" && scripts.dev.trim().length > 0) {
      return { canRun: true, scriptName: "dev" };
    }
    if (typeof scripts.start === "string" && scripts.start.trim().length > 0) {
      return { canRun: true, scriptName: "start" };
    }
  } catch {
    // Sem package.json ou inválido
  }
  return { canRun: false };
}

async function inferFallbackPortFromSource(rootReal: string): Promise<number | null> {
  const candidates = ["src/index.ts", "src/index.js", "src/server.ts", "index.ts", "index.js"];
  for (const rel of candidates) {
    try {
      const content = await readFile(join(rootReal, rel), "utf8");
      const m = content.match(
        /(?:PORT\s*\|\|\s*|PORT\s*\?\s*[^:]+:\s*|listen\s*\(\s*)(\d{4,5})\b/
      );
      if (m?.[1]) {
        const p = Number.parseInt(m[1], 10);
        if (isSafePreviewPort(p)) return p;
      }
    } catch {
      // Próximo candidato
    }
  }
  return null;
}

async function probeLocalPortReady(port: number): Promise<boolean> {
  if (!isSafePreviewPort(port)) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 700);
  try {
    await fetch(`http://127.0.0.1:${port}/`, {
      method: "GET",
      signal: ctrl.signal
    });
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function appendLogChunk(entry: RunningDevEntry, chunk: string): void {
  const clean = stripAnsi(chunk);
  for (const line of clean.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    entry.logLines.push(trimmed);
    if (entry.logLines.length > MAX_LOG_LINES) {
      entry.logLines.shift();
    }
    if (!entry.port) {
      const detected = extractLoopbackPortFromText(trimmed);
      if (detected) {
        entry.port = detected;
        entry.url = `http://127.0.0.1:${detected}`;
      }
    }
  }
}

export async function getProjectDevServerStatus(
  projectId: string,
  folderPath?: string
): Promise<DevServerStatus> {
  const existing = runningServers.get(projectId);
  if (existing && existing.child.exitCode === null && !existing.child.killed) {
    return {
      projectId,
      running: true,
      canRun: true,
      scriptName: existing.scriptName,
      url: existing.url ?? undefined,
      port: existing.port ?? undefined,
      startedAt: existing.startedAt,
      logsTail: existing.logLines.slice(-10).join("\n")
    };
  }

  if (existing) {
    clearTimeout(existing.idleTimer);
    runningServers.delete(projectId);
  }

  if (!folderPath) {
    return { projectId, running: false, canRun: false };
  }

  const inspection = await inspectLinkedFolder(folderPath).catch(() => ({
    valid: false
  }));
  if (!inspection.valid) {
    return { projectId, running: false, canRun: false };
  }

  const rootReal = await realpath(folderPath);
  const runnable = await detectRunnableScript(rootReal);
  return {
    projectId,
    running: false,
    canRun: runnable.canRun,
    scriptName: runnable.scriptName
  };
}

export async function stopProjectDevServer(projectId: string): Promise<boolean> {
  const existing = runningServers.get(projectId);
  if (!existing) return false;
  clearTimeout(existing.idleTimer);
  runningServers.delete(projectId);
  await killProcessTree(existing.child.pid);
  return true;
}

export async function stopAllProjectDevServers(): Promise<void> {
  const ids = Array.from(runningServers.keys());
  for (const id of ids) {
    await stopProjectDevServer(id);
  }
}

/**
 * Inicia `npm run dev` (ou `npm run start`) de forma estritamente allowlisted e
 * localhost-only (HOST=127.0.0.1), aguarda a porta ficar acessível e devolve a URL loopback.
 */
export async function startProjectDevServer(
  projectId: string,
  folderPath: string
): Promise<DevServerStatus> {
  ensureProcessCleanupRegistered();

  const existing = runningServers.get(projectId);
  if (existing && existing.child.exitCode === null && !existing.child.killed) {
    return getProjectDevServerStatus(projectId, folderPath);
  }

  const inspection = await inspectLinkedFolder(folderPath);
  if (!inspection.valid) {
    throw new Error(
      inspection.error || "Pasta do projeto inválida para iniciar o servidor."
    );
  }
  const rootReal = await realpath(folderPath);
  const runnable = await detectRunnableScript(rootReal);
  if (!runnable.canRun || !runnable.scriptName) {
    throw new Error(
      'Este projeto não possui script "dev" ou "start" em package.json.'
    );
  }

  // Limite de servidores simultâneos para não consumir RAM/portas à toa
  if (runningServers.size >= MAX_CONCURRENT_DEV_SERVERS) {
    const oldestKey = runningServers.keys().next().value;
    if (oldestKey) {
      await stopProjectDevServer(oldestKey);
    }
  }

  const npmBin = process.platform === "win32" ? "npm.cmd" : "npm";
  const isWin = process.platform === "win32";
  const execBin = isWin ? process.env.ComSpec || "cmd.exe" : npmBin;
  const execArgs = isWin
    ? ["/d", "/s", "/c", npmBin, "run", runnable.scriptName]
    : ["run", runnable.scriptName];

  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    HOST: "127.0.0.1",
    NO_COLOR: "1"
  };
  delete childEnv.PORT;
  delete childEnv.NODE_TEST_CONTEXT;

  const child = spawn(execBin, execArgs, {
    cwd: rootReal,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: childEnv
  });

  const idleTimer = setTimeout(() => {
    void stopProjectDevServer(projectId);
  }, IDLE_AUTO_STOP_MS);
  idleTimer.unref?.();

  const entry: RunningDevEntry = {
    projectId,
    rootReal,
    scriptName: runnable.scriptName,
    child,
    port: null,
    url: null,
    startedAt: new Date().toISOString(),
    logLines: [],
    idleTimer
  };
  runningServers.set(projectId, entry);

  child.stdout?.on("data", (buf) => appendLogChunk(entry, String(buf)));
  child.stderr?.on("data", (buf) => appendLogChunk(entry, String(buf)));
  child.on("exit", () => {
    clearTimeout(entry.idleTimer);
    if (runningServers.get(projectId) === entry) {
      runningServers.delete(projectId);
    }
  });

  const fallbackPort = await inferFallbackPortFromSource(rootReal);
  const deadline = Date.now() + PORT_WAIT_TIMEOUT_MS;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.killed) {
      const tail = entry.logLines.slice(-8).join("\n");
      throw new Error(
        `O servidor encerrou ao iniciar (exit ${child.exitCode ?? 1}).${tail ? `\n${tail}` : ""}`
      );
    }

    const candidatePort = entry.port ?? fallbackPort;
    if (candidatePort && (await probeLocalPortReady(candidatePort))) {
      entry.port = candidatePort;
      entry.url = `http://127.0.0.1:${candidatePort}`;
      return {
        projectId,
        running: true,
        canRun: true,
        scriptName: entry.scriptName,
        url: entry.url,
        port: entry.port,
        startedAt: entry.startedAt,
        logsTail: entry.logLines.slice(-10).join("\n")
      };
    }

    await new Promise((r) => setTimeout(r, 250));
  }

  return {
    projectId,
    running: child.exitCode === null && !child.killed,
    canRun: true,
    scriptName: entry.scriptName,
    url: entry.url ?? (fallbackPort ? `http://127.0.0.1:${fallbackPort}` : undefined),
    port: entry.port ?? fallbackPort ?? undefined,
    startedAt: entry.startedAt,
    logsTail: entry.logLines.slice(-10).join("\n")
  };
}
