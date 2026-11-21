import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  decodeStorageText,
  encodeStorageText
} from "../security/data-protection.js";
import type {
  DebateFocus,
  InteractionMode,
  PromptTemplate,
  ResponseMode
} from "../shared/debate-types.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function getDataDir(): string {
  return process.env.AI_COUNCIL_DATA_DIR
    ? resolve(process.env.AI_COUNCIL_DATA_DIR)
    : resolve(ROOT_DIR, "data");
}

function getTemplatesFile(): string {
  return resolve(getDataDir(), "templates.json");
}

const DEFAULT_TEMPLATES_SEED: Omit<PromptTemplate, "createdAt" | "updatedAt">[] = [
  {
    id: "tpl-arch-monolith",
    tag: "BACKEND // ARQUITETURA",
    title: "Microsserviços vs. Monolito Modular",
    prompt:
      "Compare arquitetura de microsserviços e monolito modular para uma fintech com 50 mil usuários ativos e equipe de 8 devs. Aponte trade-offs reais, custos e recomende a melhor decisão prática.",
    focus: "backend",
    responseMode: "prompt_markdown",
    interactionMode: "debate"
  },
  {
    id: "tpl-fullstack-crud",
    tag: "FULL-STACK // CÓDIGO",
    title: "CRUD RESTful Enxuto e Seguro",
    prompt:
      "Implemente um CRUD completo de cadastro, atualização e exclusão com backend enxuto, banco SQLite/H2 e frontend HTML/JS puro, priorizando segurança, validação e zero complexidade desnecessária.",
    focus: "backend",
    responseMode: "prompt_markdown",
    interactionMode: "debate"
  },
  {
    id: "tpl-frontend-ui",
    tag: "FRONTEND // DESIGN SYSTEM",
    title: "Arquitetura UI sem Aparência Genérica",
    prompt:
      "Defina tokens CSS, tipografia técnica, hierarquia de componentes e animações scroll-linked para um dashboard técnico de engenharia sem visual clichê de IA.",
    focus: "frontend",
    responseMode: "prompt_markdown",
    interactionMode: "debate"
  },
  {
    id: "tpl-security-audit",
    tag: "SEGURANÇA // AUDITORIA",
    title: "Hardening de API Node.js + Rate Limit",
    prompt:
      "Liste as 5 vulnerabilidades mais críticas em APIs Node.js/TypeScript modernas e entregue middlewares concretos de validação, proteção contra injeção, rate-limiting e tratamento de erros.",
    focus: "backend",
    responseMode: "prompt_markdown",
    interactionMode: "debate"
  }
];

let templateWriteQueue: Promise<void> = Promise.resolve();

function withTemplateLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = templateWriteQueue.then(operation, operation);
  templateWriteQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

async function writeTemplatesAtomically(templates: PromptTemplate[]): Promise<void> {
  const file = getTemplatesFile();
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const encoded = await encodeStorageText(JSON.stringify(templates, null, 2));
    await writeFile(tmp, encoded, { encoding: "utf8", mode: 0o600 });
    await rename(tmp, file);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

function normalizeFocus(value: unknown): DebateFocus {
  return value === "backend" || value === "frontend" ? value : "geral";
}

function normalizeResponseMode(value: unknown): ResponseMode {
  return value === "prompt_markdown" ? "prompt_markdown" : "normal";
}

function normalizeInteractionMode(value: unknown): InteractionMode {
  return value === "debate" ? "debate" : "direct";
}

export interface UpsertPromptTemplateInput {
  tag?: string;
  title: string;
  prompt: string;
  rules?: string;
  focus?: DebateFocus;
  responseMode?: ResponseMode;
  interactionMode?: InteractionMode;
}

export async function listPromptTemplates(): Promise<PromptTemplate[]> {
  try {
    const raw = await decodeStorageText(await readFile(getTemplatesFile(), "utf8"));
    const clean = raw.replace(/^\uFEFF/, "").trim();
    if (clean) {
      const parsed: unknown = JSON.parse(clean);
      if (Array.isArray(parsed)) {
        return parsed.filter(
          (item): item is PromptTemplate =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as PromptTemplate).id === "string" &&
            typeof (item as PromptTemplate).title === "string" &&
            typeof (item as PromptTemplate).prompt === "string"
        );
      }
    }
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code !== "ENOENT") {
      throw error;
    }
  }

  const now = new Date().toISOString();
  const seeded: PromptTemplate[] = DEFAULT_TEMPLATES_SEED.map((item) => ({
    ...item,
    createdAt: now,
    updatedAt: now
  }));
  await writeTemplatesAtomically(seeded);
  return seeded;
}

export async function createPromptTemplate(
  input: UpsertPromptTemplateInput
): Promise<PromptTemplate> {
  const title = input.title.trim().slice(0, 100);
  const prompt = input.prompt.trim().slice(0, 12_000);
  const tag = (input.tag?.trim() || "TEMPLATE").toUpperCase().slice(0, 48);
  const rules = input.rules?.trim().slice(0, 1000) || undefined;

  if (!title || !prompt) {
    throw new Error("Título e texto do prompt são obrigatórios.");
  }

  return withTemplateLock(async () => {
    const list = await listPromptTemplates();
    const now = new Date().toISOString();
    const created: PromptTemplate = {
      id: randomUUID(),
      tag,
      title,
      prompt,
      ...(rules ? { rules } : {}),
      focus: normalizeFocus(input.focus),
      responseMode: normalizeResponseMode(input.responseMode),
      interactionMode: normalizeInteractionMode(input.interactionMode),
      createdAt: now,
      updatedAt: now
    };
    list.unshift(created);
    await writeTemplatesAtomically(list);
    return created;
  });
}

export async function updatePromptTemplate(
  id: string,
  input: UpsertPromptTemplateInput
): Promise<PromptTemplate> {
  const title = input.title.trim().slice(0, 100);
  const prompt = input.prompt.trim().slice(0, 12_000);
  const tag = (input.tag?.trim() || "TEMPLATE").toUpperCase().slice(0, 48);
  const rules = input.rules?.trim().slice(0, 1000) || undefined;

  if (!title || !prompt) {
    throw new Error("Título e texto do prompt são obrigatórios.");
  }

  return withTemplateLock(async () => {
    const list = await listPromptTemplates();
    const existing = list.find((t) => t.id === id);
    if (!existing) {
      throw new Error("Template não encontrado.");
    }

    existing.tag = tag;
    existing.title = title;
    existing.prompt = prompt;
    if (rules) {
      existing.rules = rules;
    } else {
      delete existing.rules;
    }
    existing.focus = normalizeFocus(input.focus);
    existing.responseMode = normalizeResponseMode(input.responseMode);
    existing.interactionMode = normalizeInteractionMode(input.interactionMode);
    existing.updatedAt = new Date().toISOString();

    await writeTemplatesAtomically(list);
    return existing;
  });
}

export async function deletePromptTemplate(id: string): Promise<boolean> {
  return withTemplateLock(async () => {
    const list = await listPromptTemplates();
    const next = list.filter((t) => t.id !== id);
    if (next.length === list.length) {
      return false;
    }
    await writeTemplatesAtomically(next);
    return true;
  });
}
