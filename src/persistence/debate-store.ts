import {
  mkdir,
  readFile,
  writeFile,
  rename,
  rm
} from "node:fs/promises";

import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { DebateSession } from "../shared/debate-types.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DATA_DIR = resolve(ROOT_DIR, "data");
const DEBATES_FILE = resolve(DATA_DIR, "debates.json");

let debateWriteQueue: Promise<void> = Promise.resolve();

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

export async function readDebateSessions(): Promise<DebateSession[]> {
  await mkdir(DATA_DIR, { recursive: true });

  let content: string;

  try {
    content = await readFile(DEBATES_FILE, "utf8");
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

 const cleanContent = content.replace(/^\uFEFF/, "").trim();

  if (!cleanContent) {
    return [];
  }

  const parsed: unknown = JSON.parse(cleanContent);

  if (
    !Array.isArray(parsed) ||
    !parsed.every(isStoredDebateSession)
  ) {
    throw new Error(
      "O arquivo data/debates.json possui uma estrutura inválida."
    );
  }

  return parsed;
}

export async function writeDebateSessionsAtomically(
  sessions: DebateSession[]
): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });

  const temporaryFile =
    `${DEBATES_FILE}.${process.pid}.${randomUUID()}.tmp`;

  try {
    await writeFile(
      temporaryFile,
      JSON.stringify(sessions, null, 2),
      "utf8"
    );

    await rename(temporaryFile, DEBATES_FILE);
  } finally {
    await rm(temporaryFile, { force: true }).catch(() => {});
  }
}