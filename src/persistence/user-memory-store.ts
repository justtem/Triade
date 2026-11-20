import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodeStorageText,
  encodeStorageText
} from "../security/data-protection.js";

export type UserMemoryCategory =
  | "identity"
  | "preference"
  | "context"
  | "project"
  | "other";

export interface UserMemoryFact {
  id: string;
  text: string;
  category: UserMemoryCategory;
  createdAt: string;
  updatedAt: string;
  sourceDebateId?: string;
}

export interface UserMemoryState {
  enabled: boolean;
  facts: UserMemoryFact[];
  updatedAt: string;
}

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const MAX_FACTS = 40;
const MAX_FACT_CHARS = 220;

const VALID_CATEGORIES = new Set<UserMemoryCategory>([
  "identity",
  "preference",
  "context",
  "project",
  "other"
]);

function getUserMemoryFilePath(): string {
  const dataDir = process.env.AI_COUNCIL_DATA_DIR
    ? resolve(process.env.AI_COUNCIL_DATA_DIR)
    : resolve(ROOT_DIR, "data");
  return resolve(dataDir, "user-memory.json");
}

let memoryLockQueue: Promise<unknown> = Promise.resolve();
let cachedState: { path: string; data: UserMemoryState } | null = null;

function withUserMemoryLock<T>(operation: () => Promise<T>): Promise<T> {
  const next = memoryLockQueue.then(operation, operation);
  memoryLockQueue = next.then(
    () => undefined,
    () => undefined
  );
  return next;
}

/**
 * Trava rigorosa de privacidade: bloqueia automaticamente qualquer texto contendo
 * chaves de API, senhas, tokens, CPF, cartão de crédito ou credenciais bancárias.
 */
export function isSensitiveMemoryText(text: string): boolean {
  const clean = (text ?? "").trim();
  if (!clean) return true;

  // Chaves de API / tokens conhecidos
  if (
    /\b(AIza[0-9A-Za-z_-]{20,}|gsk_[0-9A-Za-z]{20,}|sk-[0-9A-Za-z_-]{16,}|ghp_[0-9A-Za-z]{20,}|xox[baprs]-[0-9A-Za-z-]{15,}|Bearer\s+[0-9A-Za-z._-]{20,})\b/.test(
      clean
    )
  ) {
    return true;
  }

  // Blocos PEM / chaves privadas
  if (/BEGIN\s+[A-Z\s]*PRIVATE\s+KEY/i.test(clean)) {
    return true;
  }

  // CPF formatado (000.000.000-00)
  if (/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/.test(clean)) {
    return true;
  }

  // Cartão de crédito (13 a 19 dígitos agrupados ou contínuos)
  if (/\b(?:\d[ -]*?){13,19}\b/.test(clean)) {
    const digitsOnly = clean.replace(/\D/g, "");
    if (digitsOnly.length >= 13 && digitsOnly.length <= 19) {
      return true;
    }
  }

  // Menção explícita a credenciais / senhas / segredos / dados bancários
  if (
    /\b(senha|password|passwd|api[ _-]?key|secret[ _-]?key|access[ _-]?token|chave\s+privada|cvv|c[oó]digo\s+de\s+seguran[cç]a|n[uú]mero\s+do\s+cart[aã]o|cpf\s*[:=]?\s*\d|chave\s+pix\s*[:=]?\s*\d{11})\b/i.test(
      clean
    )
  ) {
    return true;
  }

  return false;
}

function normalizeForDedup(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function defaultMemoryState(): UserMemoryState {
  return {
    enabled: true,
    facts: [],
    updatedAt: new Date().toISOString()
  };
}

async function readUserMemoryFromDisk(filePath: string): Promise<UserMemoryState> {
  if (cachedState && cachedState.path === filePath) {
    return {
      enabled: cachedState.data.enabled,
      facts: cachedState.data.facts.map((f) => ({ ...f })),
      updatedAt: cachedState.data.updatedAt
    };
  }

  try {
    const raw = await decodeStorageText(await readFile(filePath, "utf8"));
    const parsed = JSON.parse(raw) as Partial<UserMemoryState>;
    const facts: UserMemoryFact[] = Array.isArray(parsed.facts)
      ? parsed.facts
          .filter(
            (f): f is UserMemoryFact =>
              Boolean(f) &&
              typeof f.id === "string" &&
              typeof f.text === "string" &&
              f.text.trim().length > 0 &&
              !isSensitiveMemoryText(f.text)
          )
          .slice(0, MAX_FACTS)
          .map((f) => ({
            id: f.id,
            text: f.text.trim().slice(0, MAX_FACT_CHARS),
            category: VALID_CATEGORIES.has(f.category) ? f.category : "other",
            createdAt: typeof f.createdAt === "string" ? f.createdAt : new Date().toISOString(),
            updatedAt: typeof f.updatedAt === "string" ? f.updatedAt : new Date().toISOString(),
            ...(typeof f.sourceDebateId === "string" ? { sourceDebateId: f.sourceDebateId } : {})
          }))
      : [];

    const state: UserMemoryState = {
      enabled: parsed.enabled !== false,
      facts,
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString()
    };
    cachedState = { path: filePath, data: state };
    return {
      enabled: state.enabled,
      facts: state.facts.map((f) => ({ ...f })),
      updatedAt: state.updatedAt
    };
  } catch {
    const empty = defaultMemoryState();
    cachedState = { path: filePath, data: empty };
    return {
      enabled: empty.enabled,
      facts: [],
      updatedAt: empty.updatedAt
    };
  }
}

async function writeUserMemoryAtomically(
  filePath: string,
  state: UserMemoryState
): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const encoded = await encodeStorageText(JSON.stringify(state, null, 2));
  await writeFile(tempPath, encoded, { encoding: "utf8", mode: 0o600 });
  await rename(tempPath, filePath);
  cachedState = {
    path: filePath,
    data: {
      enabled: state.enabled,
      facts: state.facts.map((f) => ({ ...f })),
      updatedAt: state.updatedAt
    }
  };
}

export function invalidateUserMemoryCache(): void {
  cachedState = null;
}

export async function readUserMemory(): Promise<UserMemoryState> {
  const filePath = getUserMemoryFilePath();
  return readUserMemoryFromDisk(filePath);
}

export async function setUserMemoryEnabled(
  enabled: boolean
): Promise<UserMemoryState> {
  return withUserMemoryLock(async () => {
    const filePath = getUserMemoryFilePath();
    const state = await readUserMemoryFromDisk(filePath);
    state.enabled = Boolean(enabled);
    state.updatedAt = new Date().toISOString();
    await writeUserMemoryAtomically(filePath, state);
    return state;
  });
}

export async function upsertUserMemoryFacts(
  additions: Array<{ text: string; category?: UserMemoryCategory }>,
  removeIds: string[] = [],
  sourceDebateId?: string
): Promise<{ state: UserMemoryState; addedCount: number; removedCount: number }> {
  return withUserMemoryLock(async () => {
    const filePath = getUserMemoryFilePath();
    const state = await readUserMemoryFromDisk(filePath);
    const now = new Date().toISOString();

    let removedCount = 0;
    if (removeIds.length > 0) {
      const removeSet = new Set(removeIds);
      const before = state.facts.length;
      state.facts = state.facts.filter((f) => !removeSet.has(f.id));
      removedCount = before - state.facts.length;
    }

    const existingNorms = new Set(state.facts.map((f) => normalizeForDedup(f.text)));
    let addedCount = 0;

    for (const item of additions) {
      const cleanText = (item.text ?? "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, MAX_FACT_CHARS);
      if (cleanText.length < 6) continue;
      if (isSensitiveMemoryText(cleanText)) continue;

      const norm = normalizeForDedup(cleanText);
      if (!norm || existingNorms.has(norm)) continue;

      // Evita duplicata por inclusão quase idêntica
      const alreadyCovered = Array.from(existingNorms).some(
        (existing) =>
          (existing.length > 15 && norm.includes(existing)) ||
          (norm.length > 15 && existing.includes(norm))
      );
      if (alreadyCovered) continue;

      const cat: UserMemoryCategory =
        item.category && VALID_CATEGORIES.has(item.category)
          ? item.category
          : "other";

      state.facts.unshift({
        id: `mem_${randomUUID().slice(0, 10)}`,
        text: cleanText,
        category: cat,
        createdAt: now,
        updatedAt: now,
        ...(sourceDebateId ? { sourceDebateId } : {})
      });
      existingNorms.add(norm);
      addedCount++;
    }

    if (state.facts.length > MAX_FACTS) {
      state.facts = state.facts.slice(0, MAX_FACTS);
    }

    if (addedCount > 0 || removedCount > 0) {
      state.updatedAt = now;
      await writeUserMemoryAtomically(filePath, state);
    }

    return { state, addedCount, removedCount };
  });
}

export async function deleteUserMemoryFact(
  factId: string
): Promise<{ deleted: boolean; state: UserMemoryState }> {
  return withUserMemoryLock(async () => {
    const filePath = getUserMemoryFilePath();
    const state = await readUserMemoryFromDisk(filePath);
    const before = state.facts.length;
    state.facts = state.facts.filter((f) => f.id !== factId);
    const deleted = state.facts.length < before;
    if (deleted) {
      state.updatedAt = new Date().toISOString();
      await writeUserMemoryAtomically(filePath, state);
    }
    return { deleted, state };
  });
}

export async function clearUserMemory(): Promise<UserMemoryState> {
  return withUserMemoryLock(async () => {
    const filePath = getUserMemoryFilePath();
    const state = await readUserMemoryFromDisk(filePath);
    state.facts = [];
    state.updatedAt = new Date().toISOString();
    await writeUserMemoryAtomically(filePath, state);
    return state;
  });
}

/**
 * Monta bloco enxuto de Memória Pessoal Automática respeitando o orçamento de cada IA.
 * Quando há contexto de Projeto ativo, deixa explícito que as regras do Projeto têm prioridade.
 */
export function buildUserMemoryPromptBlock(
  memory: UserMemoryState | undefined,
  maxChars: number,
  options: { hasProjectContext?: boolean } = {}
): string {
  if (!memory || !memory.enabled || memory.facts.length === 0 || maxChars < 120) {
    return "";
  }

  const header = options.hasProjectContext
    ? "Memória pessoal aprendida sobre o usuário (use naturalmente quando útil; em caso de conflito, priorize sempre as instruções do Projeto):"
    : "Memória pessoal aprendida sobre o usuário (use naturalmente sem anunciar que lembrou, apenas quando relevante):";

  const lines: string[] = [header];
  let used = header.length;

  for (const fact of memory.facts) {
    if (isSensitiveMemoryText(fact.text)) continue;
    const line = `- ${fact.text}`;
    if (used + line.length + 1 > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }

  return lines.length > 1 ? lines.join("\n") : "";
}
