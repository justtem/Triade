import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm,
  access
} from "node:fs/promises";

import { randomUUID } from "node:crypto";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { DebateSession, DebateSummary } from "../shared/debate-types.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA_DIR = resolve(ROOT_DIR, "data");
const LEGACY_DEBATES_FILE = resolve(DATA_DIR, "debates.json");
const SESSIONS_DIR = resolve(DATA_DIR, "sessions");
const INDEX_FILE = resolve(SESSIONS_DIR, "index.json");

const SAFE_SESSION_ID = /^[0-9a-fA-F-]{8,64}$/;

let debateWriteQueue: Promise<void> = Promise.resolve();
let migrationPromise: Promise<void> | null = null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function isStoredDebateSession(value: unknown): value is DebateSession {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.topic === "string" &&
    typeof value.rules === "string" &&
    Array.isArray(value.participants) &&
    typeof value.totalRounds === "number" &&
    typeof value.currentRound === "number" &&
    typeof value.currentStage === "string" &&
    typeof value.status === "string" &&
    isRecord(value.participantStates) &&
    Array.isArray(value.tasks) &&
    Array.isArray(value.responses) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

function isStoredDebateSummary(value: unknown): value is DebateSummary {
  if (!isRecord(value)) return false;

  return (
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.topic === "string" &&
    Array.isArray(value.participants) &&
    typeof value.totalRounds === "number" &&
    typeof value.currentRound === "number" &&
    typeof value.currentStage === "string" &&
    typeof value.status === "string" &&
    typeof value.turnCount === "number" &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

export function summarizeDebateSession(session: DebateSession): DebateSummary {
  const topicClean = session.topic.trim();
  const topicPreview =
    topicClean.length > 240 ? `${topicClean.slice(0, 240)}...` : topicClean;

  return {
    id: session.id,
    title: session.title,
    topic: topicPreview,
    participants: [...session.participants],
    totalRounds: session.totalRounds,
    currentRound: session.currentRound,
    currentStage: session.currentStage,
    status: session.status,
    ...(session.focus ? { focus: session.focus } : {}),
    ...(session.responseMode ? { responseMode: session.responseMode } : {}),
    ...(session.interactionMode
      ? { interactionMode: session.interactionMode }
      : {}),
    turnCount: Array.isArray(session.turns) && session.turns.length > 0
      ? session.turns.length
      : 1,
    ...(session.sharedMemory?.coveredTurnCount
      ? { sharedMemoryTurns: session.sharedMemory.coveredTurnCount }
      : {}),
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    ...(session.completedAt ? { completedAt: session.completedAt } : {}),
    ...(session.engineVersion !== undefined
      ? { engineVersion: session.engineVersion }
      : {})
  };
}

function sessionFilePath(id: string): string {
  if (!SAFE_SESSION_ID.test(id)) {
    throw new Error("ID de sessão inválido.");
  }
  const filePath = resolve(SESSIONS_DIR, `${id}.json`);
  if (!filePath.startsWith(SESSIONS_DIR + sep)) {
    throw new Error("Caminho de sessão inválido.");
  }
  return filePath;
}

async function writeJsonAtomically(filePath: string, data: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const temporaryFile = `${filePath}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(temporaryFile, JSON.stringify(data, null, 2), "utf8");
    await rename(temporaryFile, filePath);
  } finally {
    await rm(temporaryFile, { force: true }).catch(() => {});
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureSessionsStorageReady(): Promise<void> {
  if (!migrationPromise) {
    migrationPromise = (async () => {
      await mkdir(SESSIONS_DIR, { recursive: true });

      if (await fileExists(INDEX_FILE)) {
        return;
      }

      const summaries: DebateSummary[] = [];

      if (await fileExists(LEGACY_DEBATES_FILE)) {
        try {
          const raw = await readFile(LEGACY_DEBATES_FILE, "utf8");
          const clean = raw.replace(/^\uFEFF/, "").trim();
          if (clean) {
            const parsed: unknown = JSON.parse(clean);
            if (Array.isArray(parsed)) {
              for (const item of parsed) {
                if (!isStoredDebateSession(item)) continue;
                if (!SAFE_SESSION_ID.test(item.id)) continue;
                const target = sessionFilePath(item.id);
                if (!(await fileExists(target))) {
                  await writeJsonAtomically(target, item);
                }
                summaries.push(summarizeDebateSession(item));
              }
            }
          }
          if (summaries.length > 0) {
            console.log(
              `[AI Council] Migração automática: ${summaries.length} conversa(s) movidas para data/sessions/ (debates.json mantido como backup).`
            );
          }
        } catch (error) {
          console.error(
            "[AI Council] Aviso ao migrar debates.json legado:",
            error instanceof Error ? error.message : error
          );
        }
      }

      summaries.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
      await writeJsonAtomically(INDEX_FILE, summaries);
    })();
  }

  return migrationPromise;
}

export function withDebateLock<T>(
  operation: () => Promise<T>
): Promise<T> {
  const result = debateWriteQueue.then(operation, operation);

  debateWriteQueue = result.then(
    () => undefined,
    () => undefined
  );

  return result;
}

export async function readDebateSummaries(): Promise<DebateSummary[]> {
  await ensureSessionsStorageReady();

  let content: string;
  try {
    content = await readFile(INDEX_FILE, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const clean = content.replace(/^\uFEFF/, "").trim();
  if (!clean) return [];

  const parsed: unknown = JSON.parse(clean);
  if (!Array.isArray(parsed)) {
    throw new Error("O arquivo data/sessions/index.json possui uma estrutura inválida.");
  }

  return parsed
    .filter(isStoredDebateSummary)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
}

export async function readDebateSessionById(
  id: string
): Promise<DebateSession | null> {
  await ensureSessionsStorageReady();
  if (!SAFE_SESSION_ID.test(id)) return null;

  let content: string;
  try {
    content = await readFile(sessionFilePath(id), "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const clean = content.replace(/^\uFEFF/, "").trim();
  if (!clean) return null;

  const parsed: unknown = JSON.parse(clean);
  if (!isStoredDebateSession(parsed)) {
    throw new Error(`Sessão ${id} possui estrutura inválida.`);
  }

  return parsed;
}

export async function writeDebateSessionAtomically(
  session: DebateSession
): Promise<void> {
  await ensureSessionsStorageReady();
  await writeJsonAtomically(sessionFilePath(session.id), session);

  const summaries = await readDebateSummaries();
  const nextSummary = summarizeDebateSession(session);
  const idx = summaries.findIndex((s) => s.id === session.id);

  if (idx >= 0) {
    summaries[idx] = nextSummary;
  } else {
    summaries.unshift(nextSummary);
  }

  summaries.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  await writeJsonAtomically(INDEX_FILE, summaries);
}

export async function deleteDebateSessionFile(id: string): Promise<boolean> {
  await ensureSessionsStorageReady();
  if (!SAFE_SESSION_ID.test(id)) return false;

  const summaries = await readDebateSummaries();
  const filtered = summaries.filter((s) => s.id !== id);
  const existedInIndex = filtered.length !== summaries.length;

  await rm(sessionFilePath(id), { force: true }).catch(() => {});

  if (existedInIndex) {
    await writeJsonAtomically(INDEX_FILE, filtered);
  }

  return existedInIndex;
}

/** Lê todas as sessões completas (usado apenas em rotinas de compatibilidade). */
export async function readDebateSessions(): Promise<DebateSession[]> {
  const summaries = await readDebateSummaries();
  const loaded = await Promise.all(
    summaries.map((s) => readDebateSessionById(s.id).catch(() => null))
  );
  return loaded.filter((s): s is DebateSession => s !== null);
}
