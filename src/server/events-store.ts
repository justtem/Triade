import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { applyLimitSignalToDebates } from "../debate/debate-engine.js";
import {
  decodeStorageText,
  encodeStorageText
} from "../security/data-protection.js";
import type { AuthManager } from "./auth.js";
import { isRecord, readRequestBody, sendJson } from "./http-utils.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_HISTORY = 200;
const SERVER_DEDUP_WINDOW_MS = 30_000;

const VALID_SOURCES = new Set<string>(["chatgpt", "claude", "gemini"]);
const VALID_SEVERITIES = new Set<string>(["warning", "blocked"]);
const VALID_SIGNALS = new Set<string>([
  "usage_limit_reached",
  "approaching_usage_limit"
]);
const VALID_CONFIDENCE = new Set<string>(["high", "medium"]);
const VALID_URLS = new Set<string>([
  "https://chatgpt.com",
  "https://claude.ai",
  "https://gemini.google.com"
]);

export interface IncomingMonitorEvent {
  source: "chatgpt" | "claude" | "gemini";
  severity: "warning" | "blocked";
  signal: "usage_limit_reached" | "approaching_usage_limit";
  confidence: "high" | "medium";
  message: string;
  matchedText: string;
  url: string;
}

export interface StoredMonitorEvent {
  source: "chatgpt" | "claude" | "gemini";
  severity: "warning" | "blocked";
  signal?: "usage_limit_reached" | "approaching_usage_limit";
  confidence?: "high" | "medium";
  message: string;
  matchedText: string;
  url: string;
  observedAt: string;
}

const EXPECTED_SIGNAL_BY_SEVERITY: Record<
  IncomingMonitorEvent["severity"],
  IncomingMonitorEvent["signal"]
> = {
  warning: "approaching_usage_limit",
  blocked: "usage_limit_reached"
};

const EXPECTED_URL_BY_SOURCE: Record<IncomingMonitorEvent["source"], string> = {
  chatgpt: "https://chatgpt.com",
  claude: "https://claude.ai",
  gemini: "https://gemini.google.com"
};

let writeQueue: Promise<void> = Promise.resolve();

function getEventsFile(): string {
  const dataDir = process.env.AI_COUNCIL_DATA_DIR
    ? resolve(process.env.AI_COUNCIL_DATA_DIR)
    : resolve(ROOT_DIR, "data");
  return resolve(dataDir, "monitor-events.json");
}

function withEventLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

function isIncomingEvent(value: unknown): value is IncomingMonitorEvent {
  if (!isRecord(value)) return false;

  const hasValidFields =
    typeof value.source === "string" &&
    VALID_SOURCES.has(value.source) &&
    typeof value.severity === "string" &&
    VALID_SEVERITIES.has(value.severity) &&
    typeof value.signal === "string" &&
    VALID_SIGNALS.has(value.signal) &&
    typeof value.confidence === "string" &&
    VALID_CONFIDENCE.has(value.confidence) &&
    typeof value.message === "string" &&
    value.message.trim().length > 0 &&
    value.message.length <= 500 &&
    typeof value.matchedText === "string" &&
    value.matchedText.trim().length > 0 &&
    value.matchedText.length <= 800 &&
    typeof value.url === "string" &&
    VALID_URLS.has(value.url);

  if (!hasValidFields) return false;

  const source = value.source as IncomingMonitorEvent["source"];
  const severity = value.severity as IncomingMonitorEvent["severity"];
  const signal = value.signal as IncomingMonitorEvent["signal"];
  const url = value.url as string;

  if (EXPECTED_SIGNAL_BY_SEVERITY[severity] !== signal) return false;
  if (EXPECTED_URL_BY_SOURCE[source] !== url) return false;

  return true;
}

function isStoredEvent(value: unknown): value is StoredMonitorEvent {
  if (!isRecord(value)) return false;

  const validSignal =
    value.signal === undefined ||
    (typeof value.signal === "string" && VALID_SIGNALS.has(value.signal));

  const validConfidence =
    value.confidence === undefined ||
    (typeof value.confidence === "string" &&
      VALID_CONFIDENCE.has(value.confidence));

  return (
    typeof value.source === "string" &&
    VALID_SOURCES.has(value.source) &&
    typeof value.severity === "string" &&
    VALID_SEVERITIES.has(value.severity) &&
    validSignal &&
    validConfidence &&
    typeof value.message === "string" &&
    typeof value.matchedText === "string" &&
    typeof value.url === "string" &&
    typeof value.observedAt === "string"
  );
}

function isRecentDuplicate(
  events: StoredMonitorEvent[],
  incoming: IncomingMonitorEvent,
  nowMs: number
): StoredMonitorEvent | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const existing = events[i];
    if (!existing) continue;

    const observedMs = Date.parse(existing.observedAt);
    if (Number.isNaN(observedMs)) continue;

    if (nowMs - observedMs > SERVER_DEDUP_WINDOW_MS) {
      break;
    }

    if (
      existing.source === incoming.source &&
      existing.severity === incoming.severity &&
      existing.signal === incoming.signal &&
      existing.matchedText === incoming.matchedText
    ) {
      return existing;
    }
  }

  return null;
}

export async function readMonitorEvents(): Promise<StoredMonitorEvent[]> {
  let content: string;
  try {
    content = await decodeStorageText(await readFile(getEventsFile(), "utf8"));
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const cleanContent = content.replace(/^\uFEFF/, "").trim();
  if (!cleanContent) return [];

  const parsed: unknown = JSON.parse(cleanContent);
  if (!Array.isArray(parsed) || !parsed.every(isStoredEvent)) {
    throw new Error("O arquivo de histórico possui uma estrutura inválida.");
  }

  return parsed;
}

async function writeEventsAtomically(
  events: StoredMonitorEvent[]
): Promise<void> {
  const eventsFile = getEventsFile();
  await mkdir(dirname(eventsFile), { recursive: true });
  const temporaryFile = `${eventsFile}.${process.pid}.${randomUUID()}.tmp`;

  try {
    const encoded = await encodeStorageText(
      JSON.stringify(events.slice(-MAX_HISTORY), null, 2)
    );
    await writeFile(temporaryFile, encoded, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryFile, eventsFile);
  } finally {
    await rm(temporaryFile, { force: true }).catch(() => {});
  }
}

export async function handleEventsRoute(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  origin: string | undefined,
  auth: AuthManager
): Promise<boolean> {
  if (request.method !== "POST" || url.pathname !== "/events") {
    return false;
  }

  if (!auth.hasValidMonitorToken(request)) {
    sendJson(response, 401, { error: "Não autorizado." }, origin);
    return true;
  }

  let event: unknown;
  try {
    const body = await readRequestBody(request);
    event = JSON.parse(body);
  } catch {
    sendJson(response, 400, { error: "Corpo da requisição inválido." }, origin);
    return true;
  }

  if (!isIncomingEvent(event)) {
    sendJson(
      response,
      400,
      { error: "Evento inválido ou campos incompatíveis." },
      origin
    );
    return true;
  }

  try {
    const result = await withEventLock(async () => {
      const events = await readMonitorEvents();
      const now = new Date();

      const duplicate = isRecentDuplicate(events, event, now.getTime());
      if (duplicate) {
        return { deduplicated: true, event: duplicate };
      }

      const newEvent: StoredMonitorEvent = {
        ...event,
        observedAt: now.toISOString()
      };

      events.push(newEvent);
      await writeEventsAtomically(events);

      return { deduplicated: false, event: newEvent };
    });

    const debateImpact = await applyLimitSignalToDebates(
      result.event.source,
      result.event.severity,
      result.event.matchedText,
      result.event.observedAt
    );

    if (debateImpact.pausedDebateIds.length > 0) {
      console.warn(
        "[AI Council] Debates pausados automaticamente por limite atingido:",
        debateImpact.pausedDebateIds.join(", ")
      );
    }

    if (result.deduplicated) {
      sendJson(
        response,
        200,
        {
          saved: true,
          deduplicated: true,
          pausedDebates: debateImpact.pausedDebateIds,
          event: result.event
        },
        origin
      );
      return true;
    }

    sendJson(
      response,
      201,
      {
        saved: true,
        pausedDebates: debateImpact.pausedDebateIds,
        event: result.event
      },
      origin
    );
  } catch (error) {
    console.error("[AI Council] Erro ao salvar evento:", error);
    sendJson(response, 500, { error: "Não foi possível salvar o evento." }, origin);
  }

  return true;
}
