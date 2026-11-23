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

import type {
  Project,
  ProjectFileKind,
  ProjectFileMeta
} from "../shared/debate-types.js";
import { extractPdfTextFromBuffer } from "../projects/pdf-extract.js";
import {
  decodeStorageText,
  encodeStorageText
} from "../security/data-protection.js";
import { writeTextAtomically } from "../shared/atomic-fs.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const SAFE_ID_REGEX = /^[a-zA-Z0-9_-]{6,64}$/;
const MAX_PROJECTS = 40;
const MAX_FILES_PER_PROJECT = 30;
const MAX_TEXT_FILE_CHARS = 350_000;
const MAX_PDF_BYTES = 10 * 1024 * 1024; // 10 MB

const ALLOWED_COLORS = new Set([
  "iris",
  "sky",
  "saffron",
  "rose",
  "emerald"
]);

let projectWriteQueue: Promise<void> = Promise.resolve();

function getDataDir(): string {
  return process.env.AI_COUNCIL_DATA_DIR
    ? resolve(process.env.AI_COUNCIL_DATA_DIR)
    : resolve(ROOT_DIR, "data");
}

function getProjectsDir(): string {
  return resolve(getDataDir(), "projects");
}

function getProjectsIndexFile(): string {
  return resolve(getProjectsDir(), "index.json");
}

function getProjectDir(projectId: string): string {
  if (!SAFE_ID_REGEX.test(projectId)) {
    throw new Error("ID de projeto inválido.");
  }
  const base = getProjectsDir();
  const dir = resolve(base, projectId);
  if (!dir.startsWith(base + sep)) {
    throw new Error("Caminho de projeto inválido.");
  }
  return dir;
}

function getProjectFilePath(projectId: string, fileId: string): string {
  if (!SAFE_ID_REGEX.test(fileId)) {
    throw new Error("ID de arquivo inválido.");
  }
  const filesDir = resolve(getProjectDir(projectId), "files");
  const filePath = resolve(filesDir, `${fileId}.txt`);
  if (!filePath.startsWith(filesDir + sep)) {
    throw new Error("Caminho de arquivo inválido.");
  }
  return filePath;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withProjectLock<T>(operation: () => Promise<T>): Promise<T> {
  const result = projectWriteQueue.then(operation, operation);
  projectWriteQueue = result.then(
    () => undefined,
    () => undefined
  );
  return result;
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

function sanitizeColor(value?: string): string {
  const clean = (value ?? "").trim().toLowerCase();
  return ALLOWED_COLORS.has(clean) ? clean : "iris";
}

function isValidProject(value: unknown): value is Project {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === "string" &&
    SAFE_ID_REGEX.test(value.id) &&
    typeof value.name === "string" &&
    typeof value.instructions === "string" &&
    Array.isArray(value.files) &&
    typeof value.createdAt === "string" &&
    typeof value.updatedAt === "string"
  );
}

async function readAllProjectsUnlocked(): Promise<Project[]> {
  const indexFile = getProjectsIndexFile();
  if (!(await fileExists(indexFile))) {
    return [];
  }

  try {
    const raw = await decodeStorageText(await readFile(indexFile, "utf8"));
    const clean = raw.replace(/^\uFEFF/, "").trim();
    if (!clean) return [];
    const parsed: unknown = JSON.parse(clean);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(isValidProject)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  } catch {
    return [];
  }
}

export async function listProjects(): Promise<Project[]> {
  return readAllProjectsUnlocked();
}

export async function getProjectById(projectId: string): Promise<Project | null> {
  if (!SAFE_ID_REGEX.test(projectId)) return null;
  const projects = await readAllProjectsUnlocked();
  return projects.find((p) => p.id === projectId) ?? null;
}

export interface ProjectUpsertInput {
  name: string;
  description?: string;
  color?: string;
  instructions?: string;
  linkedFolderPath?: string;
}

export async function createProject(input: ProjectUpsertInput): Promise<Project> {
  const name = (input.name ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
  if (!name) {
    throw new Error("Informe um nome para o Projeto.");
  }

  const description = (input.description ?? "").trim().slice(0, 240);
  const instructions = (input.instructions ?? "").replace(/\0/g, "").trim().slice(0, 12_000);
  const linkedFolderPath = (input.linkedFolderPath ?? "").trim().slice(0, 500);
  const color = sanitizeColor(input.color);

  return withProjectLock(async () => {
    const projects = await readAllProjectsUnlocked();
    if (projects.length >= MAX_PROJECTS) {
      throw new Error(`Limite de ${MAX_PROJECTS} projetos atingido.`);
    }

    const now = new Date().toISOString();
    const project: Project = {
      id: `proj_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
      name,
      ...(description ? { description } : {}),
      color,
      instructions,
      ...(linkedFolderPath ? { linkedFolderPath } : {}),
      files: [],
      createdAt: now,
      updatedAt: now
    };

    projects.unshift(project);
    await writeJsonAtomically(getProjectsIndexFile(), projects);
    return project;
  });
}

export async function updateProject(
  projectId: string,
  input: Partial<ProjectUpsertInput>
): Promise<Project> {
  if (!SAFE_ID_REGEX.test(projectId)) {
    throw new Error("Projeto não encontrado.");
  }

  return withProjectLock(async () => {
    const projects = await readAllProjectsUnlocked();
    const idx = projects.findIndex((p) => p.id === projectId);
    if (idx < 0) {
      throw new Error("Projeto não encontrado.");
    }

    const current = projects[idx]!;
    const nextName =
      input.name !== undefined
        ? input.name.replace(/\s+/g, " ").trim().slice(0, 80)
        : current.name;

    if (!nextName) {
      throw new Error("O nome do Projeto não pode ficar vazio.");
    }

    const nextDesc =
      input.description !== undefined
        ? input.description.trim().slice(0, 240)
        : (current.description ?? "");
    const nextInstructions =
      input.instructions !== undefined
        ? input.instructions.replace(/\0/g, "").trim().slice(0, 12_000)
        : current.instructions;
    const nextFolder =
      input.linkedFolderPath !== undefined
        ? input.linkedFolderPath.trim().slice(0, 500)
        : (current.linkedFolderPath ?? "");
    const nextColor =
      input.color !== undefined ? sanitizeColor(input.color) : (current.color ?? "iris");

    const updated: Project = {
      ...current,
      name: nextName,
      color: nextColor,
      instructions: nextInstructions,
      updatedAt: new Date().toISOString()
    };

    if (nextDesc) {
      updated.description = nextDesc;
    } else {
      delete updated.description;
    }

    if (nextFolder) {
      updated.linkedFolderPath = nextFolder;
    } else {
      delete updated.linkedFolderPath;
    }

    projects[idx] = updated;
    await writeJsonAtomically(getProjectsIndexFile(), projects);
    return updated;
  });
}

export async function deleteProject(projectId: string): Promise<boolean> {
  if (!SAFE_ID_REGEX.test(projectId)) return false;

  return withProjectLock(async () => {
    const projects = await readAllProjectsUnlocked();
    const filtered = projects.filter((p) => p.id !== projectId);
    if (filtered.length === projects.length) {
      return false;
    }

    await writeJsonAtomically(getProjectsIndexFile(), filtered);
    await rm(getProjectDir(projectId), { recursive: true, force: true }).catch(() => {});
    return true;
  });
}

export interface AddProjectFileInput {
  name: string;
  kind?: ProjectFileKind;
  mimeType?: string;
  content?: string;
  dataBase64?: string;
  size?: number;
}

export async function addProjectFile(
  projectId: string,
  input: AddProjectFileInput
): Promise<{ project: Project; file: ProjectFileMeta }> {
  const cleanName = (input.name ?? "").replace(/[/\\]/g, "_").trim().slice(0, 140);
  if (!cleanName) {
    throw new Error("Nome do arquivo é obrigatório.");
  }

  const isPdf =
    input.kind === "pdf" ||
    input.mimeType === "application/pdf" ||
    cleanName.toLowerCase().endsWith(".pdf");

  let extractedText = "";
  let byteSize = typeof input.size === "number" && input.size >= 0 ? input.size : 0;

  if (isPdf) {
    if (typeof input.dataBase64 !== "string" || !input.dataBase64.trim()) {
      throw new Error("Arquivo PDF sem dados binários.");
    }
    const cleanBase64 = input.dataBase64
      .replace(/^data:[^;]+;base64,/i, "")
      .trim();
    const buffer = Buffer.from(cleanBase64, "base64");
    if (buffer.byteLength === 0) {
      throw new Error("PDF vazio ou corrompido.");
    }
    if (buffer.byteLength > MAX_PDF_BYTES) {
      throw new Error("PDF excede o limite de 10 MB por arquivo do projeto.");
    }
    byteSize = buffer.byteLength;
    try {
      extractedText = await extractPdfTextFromBuffer(buffer);
    } catch (error) {
      throw new Error(
        `Não foi possível extrair texto do PDF "${cleanName}": ${
          error instanceof Error ? error.message : "formato não suportado"
        }`
      );
    }

    if (!extractedText.trim()) {
      throw new Error(
        `O PDF "${cleanName}" não contém texto selecionável (pode ser uma imagem escaneada).`
      );
    }
  } else {
    if (typeof input.content !== "string") {
      throw new Error("Conteúdo de texto do arquivo é obrigatório.");
    }
    if (input.content.includes("\0")) {
      throw new Error(
        `"${cleanName}" parece ser um arquivo binário e não pode ser indexado como texto.`
      );
    }
    extractedText = input.content
      .replace(/\r\n/g, "\n")
      .trim()
      .slice(0, MAX_TEXT_FILE_CHARS);
    if (!extractedText) {
      throw new Error(`O arquivo "${cleanName}" está vazio.`);
    }
    byteSize = byteSize || Buffer.byteLength(extractedText, "utf8");
  }

  return withProjectLock(async () => {
    const projects = await readAllProjectsUnlocked();
    const idx = projects.findIndex((p) => p.id === projectId);
    if (idx < 0) {
      throw new Error("Projeto não encontrado.");
    }

    const project = projects[idx]!;
    const existingByNameIdx = project.files.findIndex(
      (f) => f.name.toLowerCase() === cleanName.toLowerCase()
    );

    if (existingByNameIdx < 0 && project.files.length >= MAX_FILES_PER_PROJECT) {
      throw new Error(
        `Limite de ${MAX_FILES_PER_PROJECT} arquivos enviados por projeto atingido.`
      );
    }

    const fileId =
      existingByNameIdx >= 0
        ? project.files[existingByNameIdx]!.id
        : `pf_${randomUUID().replace(/-/g, "").slice(0, 14)}`;

    const targetPath = getProjectFilePath(projectId, fileId);
    await mkdir(dirname(targetPath), { recursive: true });
    const encodedText = await encodeStorageText(extractedText);
    await writeFile(targetPath, encodedText, { encoding: "utf8", mode: 0o600 });

    const now = new Date().toISOString();
    const meta: ProjectFileMeta = {
      id: fileId,
      name: cleanName,
      kind: isPdf ? "pdf" : "text",
      ...(input.mimeType ? { mimeType: input.mimeType } : {}),
      size: byteSize,
      charCount: extractedText.length,
      uploadedAt: now
    };

    if (existingByNameIdx >= 0) {
      project.files[existingByNameIdx] = meta;
    } else {
      project.files.unshift(meta);
    }
    project.updatedAt = now;

    await writeJsonAtomically(getProjectsIndexFile(), projects);
    return { project, file: meta };
  });
}

export async function removeProjectFile(
  projectId: string,
  fileId: string
): Promise<Project | null> {
  if (!SAFE_ID_REGEX.test(projectId) || !SAFE_ID_REGEX.test(fileId)) {
    return null;
  }

  return withProjectLock(async () => {
    const projects = await readAllProjectsUnlocked();
    const idx = projects.findIndex((p) => p.id === projectId);
    if (idx < 0) return null;

    const project = projects[idx]!;
    const nextFiles = project.files.filter((f) => f.id !== fileId);
    if (nextFiles.length === project.files.length) {
      return null;
    }

    project.files = nextFiles;
    project.updatedAt = new Date().toISOString();

    await rm(getProjectFilePath(projectId, fileId), { force: true }).catch(() => {});
    await writeJsonAtomically(getProjectsIndexFile(), projects);
    return project;
  });
}

export async function readProjectFileText(
  projectId: string,
  fileId: string
): Promise<string | null> {
  try {
    const filePath = getProjectFilePath(projectId, fileId);
    const raw = await readFile(filePath, "utf8");
    return await decodeStorageText(raw);
  } catch {
    return null;
  }
}
