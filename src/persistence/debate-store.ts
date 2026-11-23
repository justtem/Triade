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

import {
  decodeStorageText,
  encodeStorageText
} from "../security/data-protection.js";
import { writeTextAtomically } from "../shared/atomic-fs.js";
import type { DebateSession, DebateSummary } from "../shared/debate-types.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SAFE_SESSION_ID = /^[0-9a-fA-F-]{8,64}$/;

let debateWriteQueue: Promise<void> = Promise.resolve();
let migrationPromise: Promise<void> | null = null;
let migratedDataDir = "";

function getDataDir(): string {
  return process.env.AI_COUNCIL_DATA_DIR
    ? resolve(process.env.AI_COUNCIL_DATA_DIR)
    : resolve(ROOT_DIR, "data");
}

function getLegacyDebatesFile(): string {
  return resolve(getDataDir(), "debates.json");
}

function getSessionsDir(): string {
  return resolve(getDataDir(), "sessions");
}

function getIndexFile(): string {
  return resolve(getSessionsDir(), "index.json");
}

export function resetDebateStorageState(): void {
  migrationPromise = null;
  migratedDataDir = "";
}

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

function sortSummaries(list: DebateSummary[]): DebateSummary[] {
  return [...list].sort((a, b) => {
    const pinDiff = (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0);
    if (pinDiff !== 0) return pinDiff;
    return Date.parse(b.createdAt) - Date.parse(a.createdAt);
  });
}

function normalizeSearchText(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
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
    ...(session.pinned ? { pinned: true } : {}),
    ...(session.projectId ? { projectId: session.projectId } : {}),
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
  const sessionsDir = getSessionsDir();
  const filePath = resolve(sessionsDir, `${id}.json`);
  if (!filePath.startsWith(sessionsDir + sep)) {
    throw new Error("Caminho de sessão inválido.");
  }
  return filePath;
}

async function writeJsonAtomically(filePath: string, data: unknown): Promise<void> {
  const serialized = await encodeStorageText(JSON.stringify(data, null, 2));
  await writeTextAtomically(filePath, serialized, { mode: 0o600 });
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
  const currentDir = getDataDir();
  if (!migrationPromise || migratedDataDir !== currentDir) {
    migratedDataDir = currentDir;
    const sessionsDir = getSessionsDir();
    const indexFile = getIndexFile();
    const legacyFile = getLegacyDebatesFile();

    migrationPromise = (async () => {
      await mkdir(sessionsDir, { recursive: true });

      if (await fileExists(indexFile)) {
        return;
      }

      const summaries: DebateSummary[] = [];

      if (await fileExists(legacyFile)) {
        try {
          const raw = await decodeStorageText(await readFile(legacyFile, "utf8"));
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
      await writeJsonAtomically(indexFile, summaries);
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
    content = await decodeStorageText(await readFile(getIndexFile(), "utf8"));
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

  return sortSummaries(parsed.filter(isStoredDebateSummary));
}

export async function readDebateSessionById(
  id: string
): Promise<DebateSession | null> {
  await ensureSessionsStorageReady();
  if (!SAFE_SESSION_ID.test(id)) return null;

  let content: string;
  try {
    content = await decodeStorageText(await readFile(sessionFilePath(id), "utf8"));
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

  await writeJsonAtomically(getIndexFile(), sortSummaries(summaries));
}

export async function deleteDebateSessionFile(id: string): Promise<boolean> {
  await ensureSessionsStorageReady();
  if (!SAFE_SESSION_ID.test(id)) return false;

  const summaries = await readDebateSummaries();
  const filtered = summaries.filter((s) => s.id !== id);
  const existedInIndex = filtered.length !== summaries.length;

  await rm(sessionFilePath(id), { force: true }).catch(() => {});

  if (existedInIndex) {
    await writeJsonAtomically(getIndexFile(), filtered);
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

/** Busca full-text nas conversas (título, tema, turnos, respostas, síntese e memória). */
export async function searchDebateSessionsByQuery(
  rawQuery: string
): Promise<string[]> {
  const needle = normalizeSearchText(rawQuery.trim());
  if (!needle) return [];

  const summaries = await readDebateSummaries();
  const matchingIds: string[] = [];

  for (const summary of summaries) {
    if (
      normalizeSearchText(summary.title).includes(needle) ||
      normalizeSearchText(summary.topic).includes(needle)
    ) {
      matchingIds.push(summary.id);
      continue;
    }

    const session = await readDebateSessionById(summary.id).catch(() => null);
    if (!session) continue;

    const haystacks: string[] = [];
    if (session.conclusion) haystacks.push(session.conclusion);
    if (session.sharedMemory?.summary) haystacks.push(session.sharedMemory.summary);
    for (const t of session.turns ?? []) {
      haystacks.push(t.prompt);
      if (t.conclusion) haystacks.push(t.conclusion);
    }
    for (const r of session.responses ?? []) {
      haystacks.push(r.content);
    }

    if (haystacks.some((h) => normalizeSearchText(h).includes(needle))) {
      matchingIds.push(summary.id);
    }
  }

  return matchingIds;
}
