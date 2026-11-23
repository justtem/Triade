import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";

import type {
  BuilderBackupInfo,
  BuilderFileEntry
} from "../shared/debate-types.js";
import { inspectLinkedFolder } from "./project-rag.js";

export const BACKUP_ROOT_DIR_NAME = ".ai-council-backup";
const MAX_BACKUPS_KEPT = 15;
const MAX_FILES_PER_BATCH = 40;
const MAX_DELETES_PER_BATCH = 10;
const MAX_FILE_WRITE_BYTES = 512 * 1024; // 512 KB por arquivo
const MAX_DIFF_PREVIEW_LINES = 80;

const BLOCKED_WRITE_DIRS = new Set([
  ".git",
  ".svn",
  ".hg",
  ".ssh",
  ".gnupg",
  "node_modules",
  BACKUP_ROOT_DIR_NAME,
  ".vscode",
  ".idea"
]);

const BLOCKED_WRITE_EXTENSIONS = new Set([
  ".env",
  ".key",
  ".pem",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".crt",
  ".cer",
  ".der",
  ".ppk",
  ".kdbx",
  ".exe",
  ".dll",
  ".msi",
  ".sys",
  ".com",
  ".scr",
  ".sqlite",
  ".sqlite3",
  ".db"
]);

const WINDOWS_RESERVED_BASENAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9"
]);

export interface ExtractedWorkspaceFile {
  path: string;
  content: string;
  incomplete: boolean;
}

export interface MarkdownExtractionResult {
  files: ExtractedWorkspaceFile[];
  missingPaths: string[];
  deletes: string[];
}

interface BackupManifest {
  batchId: string;
  createdAt: string;
  filesWritten: string[];
  filesCreated: string[];
  filesOverwritten: string[];
  filesDeleted?: string[];
  undone?: boolean;
  undoneAt?: string;
}

function normalizeForPrefixCompare(p: string): string {
  return process.platform === "win32" ? p.toLowerCase() : p;
}

export function normalizeRelativeWorkspacePath(rawPath: string): string {
  return String(rawPath || "")
    .trim()
    .replace(/^['"`(<\[]+|['"`)\]>,;:]+$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
}

export function validateRelativeWorkspacePath(rawPath: string): {
  valid: boolean;
  relPath?: string;
  reason?: string;
} {
  const relPath = normalizeRelativeWorkspacePath(rawPath);
  if (!relPath) {
    return { valid: false, reason: "Caminho vazio." };
  }
  if (relPath.length > 240) {
    return { valid: false, reason: "Caminho excede 240 caracteres." };
  }
  if (relPath.includes("\0")) {
    return { valid: false, reason: "Caractere nulo não permitido." };
  }
  if (relPath.startsWith("/") || /^[a-zA-Z]:/.test(relPath) || isAbsolute(relPath)) {
    return { valid: false, reason: "Caminho absoluto bloqueado pelo sandbox." };
  }

  const segments = relPath.split("/");
  if (segments.some((s) => !s || s === "." || s === "..")) {
    return { valid: false, reason: "Path traversal (..) bloqueado pelo sandbox." };
  }

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i] ?? "";
    const lower = seg.toLowerCase();
    const isLast = i === segments.length - 1;

    if (/[<>:"|?*]/.test(seg)) {
      return { valid: false, reason: `Caractere inválido no caminho: "${seg}".` };
    }

    const baseNoExt = lower.split(".")[0] ?? lower;
    if (WINDOWS_RESERVED_BASENAMES.has(baseNoExt)) {
      return { valid: false, reason: `Nome reservado do sistema bloqueado: "${seg}".` };
    }

    if (!isLast && BLOCKED_WRITE_DIRS.has(lower)) {
      return {
        valid: false,
        reason: `Diretório protegido bloqueado para escrita: "${seg}".`
      };
    }
  }

  const fileName = segments[segments.length - 1] ?? "";
  const lowerFile = fileName.toLowerCase();
  if (
    lowerFile === ".env" ||
    lowerFile.startsWith(".env.") ||
    lowerFile.endsWith(".env") ||
    BLOCKED_WRITE_DIRS.has(lowerFile)
  ) {
    return {
      valid: false,
      reason: `Arquivo sensível bloqueado para escrita: "${fileName}".`
    };
  }

  const ext = extname(lowerFile);
  if (ext && BLOCKED_WRITE_EXTENSIONS.has(ext)) {
    return {
      valid: false,
      reason: `Extensão bloqueada por segurança: "${ext}".`
    };
  }

  return { valid: true, relPath };
}

async function resolveTrustedRoot(rootDir: string): Promise<string> {
  const inspection = await inspectLinkedFolder(rootDir);
  if (!inspection.valid) {
    throw new Error(
      inspection.error || "Pasta do projeto inválida ou bloqueada por segurança."
    );
  }
  return realpath(rootDir);
}

/**
 * Resolve e valida um caminho relativo dentro da pasta vinculada, garantindo:
 * 1. Sem path traversal;
 * 2. Sem escrita em arquivos/pastas protegidos (.env, .git, node_modules, chaves);
 * 3. Nenhum ancestral existente ou alvo é symlink apontando para fora do rootDir.
 */
export async function resolveSafeWorkspacePath(
  rootDir: string,
  rawRelPath: string
): Promise<{ rootReal: string; relPath: string; absPath: string }> {
  const check = validateRelativeWorkspacePath(rawRelPath);
  if (!check.valid || !check.relPath) {
    throw new Error(check.reason || "Caminho de arquivo inválido.");
  }

  const rootReal = await resolveTrustedRoot(rootDir);
  const rootPrefix = rootReal.endsWith(sep) ? rootReal : `${rootReal}${sep}`;
  const normPrefix = normalizeForPrefixCompare(rootPrefix);

  const absPath = resolve(rootReal, ...check.relPath.split("/"));
  const normAbs = normalizeForPrefixCompare(absPath);
  if (!normAbs.startsWith(normPrefix)) {
    throw new Error("Tentativa de escrita fora da pasta do projeto (bloqueado).");
  }

  // Valida cada segmento já existente no disco contra symlink escaping
  const parts = check.relPath.split("/");
  let cursor = rootReal;
  for (let i = 0; i < parts.length; i++) {
    cursor = join(cursor, parts[i] ?? "");
    try {
      const lst = await lstat(cursor);
      if (lst.isSymbolicLink()) {
        throw new Error(
          `Symlink bloqueado no caminho "${check.relPath}" (proteção anti-escape).`
        );
      }
      const realCursor = await realpath(cursor);
      if (!normalizeForPrefixCompare(realCursor).startsWith(normPrefix)) {
        throw new Error(
          `Caminho resolve fora da pasta do projeto: "${check.relPath}".`
        );
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        break;
      }
      throw err;
    }
  }

  return { rootReal, relPath: check.relPath, absPath };
}

function isLikelyFilePath(candidate: string): boolean {
  const clean = normalizeRelativeWorkspacePath(candidate);
  if (!clean || clean.length > 180 || clean.includes(" ")) return false;
  if (/^https?:\/\//i.test(clean)) return false;
  const base = basename(clean);
  if (!base) return false;
  const knownNoExt = new Set(["dockerfile", "makefile", "procfile", "readme", "license"]);
  if (knownNoExt.has(base.toLowerCase())) return true;
  const ext = extname(base).toLowerCase();
  if (!ext || ext.length < 2 || ext.length > 10) return false;
  // Rejeita versões como v1.2 ou números 3.14
  if (/^\.\d+$/.test(ext)) return false;
  return /^[a-zA-Z0-9._/-]+$/.test(clean);
}

function extractPathFromContextLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 220) return null;

  // Ex: ### `src/index.ts`  ou  #### Arquivo: src/db.ts  ou  **src/app.ts**
  const backtickMatches = [...trimmed.matchAll(/`([^`\n]+)`/g)];
  for (const m of backtickMatches) {
    const candidate = normalizeRelativeWorkspacePath(m[1] ?? "");
    if (isLikelyFilePath(candidate)) return candidate;
  }

  const cleaned = trimmed
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+\.\s+/, "")
    .replace(/^(?:arquivo|file|path|caminho)\s*[:\-]\s*/i, "")
    .replace(/^\*\*|\*\*$/g, "")
    .replace(/:$/, "")
    .trim();

  if (isLikelyFilePath(cleaned)) {
    return normalizeRelativeWorkspacePath(cleaned);
  }

  const inlineToken = cleaned.match(/([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+\.[a-zA-Z0-9]+)/);
  if (inlineToken?.[1] && isLikelyFilePath(inlineToken[1])) {
    return normalizeRelativeWorkspacePath(inlineToken[1]);
  }

  return null;
}

function extractPathFromCodeFirstLine(code: string): string | null {
  const firstLine = (code.split(/\r?\n/, 1)[0] ?? "").trim();
  if (!firstLine) return null;

  const patterns = [
    /^\/\/\s*(?:file|arquivo|path)?\s*[:\-]?\s*([^\s*]+)\s*$/i,
    /^\/\*\s*(?:file|arquivo|path)?\s*[:\-]?\s*([^\s*]+)\s*\*\/$/i,
    /^#\s*(?:file|arquivo|path)?\s*[:\-]?\s*([^\s]+)\s*$/i,
    /^<!--\s*(?:file|arquivo|path)?\s*[:\-]?\s*([^\s>]+)\s*-->$/i
  ];

  for (const re of patterns) {
    const m = firstLine.match(re);
    if (m?.[1] && isLikelyFilePath(m[1])) {
      return normalizeRelativeWorkspacePath(m[1]);
    }
  }
  return null;
}

function detectIncompleteCode(content: string): boolean {
  const text = content.trim();
  if (!text) return true;
  const incompletePatterns = [
    /\/\/\s*\.\.\.\s*(?:resto|restante|demais|existing|unchanged|c[oó]digo|omitido)/i,
    /\/\*\s*\.\.\.\s*(?:resto|existing|omitido)/i,
    /#\s*\.\.\.\s*(?:resto|existing|omitido)/i,
    /\/\/\s*TODO:\s*implementar\s+(?:o\s+resto|aqui)/i
  ];
  return incompletePatterns.some((re) => re.test(text));
}

function extractReferencedPlanPaths(markdown: string, extractedSet: Set<string>): string[] {
  const found = new Set<string>();
  const lines = markdown.split(/\r?\n/);

  for (const line of lines) {
    // 1. Árvore ASCII: ├── src/index.ts ou └── package.json
    const treeMatch = line.match(/[├└│─\s]+([a-zA-Z0-9._/-]+\.[a-zA-Z0-9]{1,8})\b/);
    if (treeMatch?.[1] && isLikelyFilePath(treeMatch[1])) {
      const p = normalizeRelativeWorkspacePath(treeMatch[1]);
      if (p.includes("/") || p === "package.json" || p === "tsconfig.json") {
        found.add(p);
      }
    }

    // 2. Backticks com caminho explícito contendo "/" (ex: `src/routes/users.ts`)
    for (const m of line.matchAll(/`([a-zA-Z0-9._-]+(?:\/[a-zA-Z0-9._-]+)+\.[a-zA-Z0-9]{1,8})`/g)) {
      if (m[1] && isLikelyFilePath(m[1])) {
        found.add(normalizeRelativeWorkspacePath(m[1]));
      }
    }
  }

  return Array.from(found).filter((p) => {
    if (extractedSet.has(p)) return false;
    const check = validateRelativeWorkspacePath(p);
    return check.valid;
  });
}

const DUMMY_ROOT_FILENAMES = new Set([
  "example.ts",
  "example.js",
  "exemplo.ts",
  "exemplo.js",
  "foo.ts",
  "foo.js",
  "bar.ts",
  "bar.js",
  "baz.ts",
  "baz.js"
]);

function isDummyRootExamplePath(relPath: string): boolean {
  if (relPath.includes("/")) return false;
  return DUMMY_ROOT_FILENAMES.has(relPath.toLowerCase());
}

function extractDeleteDirectivesOutsideFences(
  markdown: string,
  extractedSet: Set<string>
): string[] {
  // Remove blocos de código cercados para evitar que comentários/exemplos disparem remoções
  const withoutFences = markdown.replace(/```[^\n`]*\r?\n[\s\S]*?```/g, "\n");
  const deletes = new Set<string>();

  for (const rawLine of withoutFences.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.length > 260) continue;
    const m = line.match(
      /^(?:[-*]\s+)?(?:#{1,6}\s+)?(?:\*\*)?(?:DELETE|REMOVE|REMOVER|APAGAR|DELETAR)(?:\*\*)?\s*[:\-]\s*(.+)$/i
    );
    if (!m?.[1]) continue;

    const rest = m[1].trim();
    const backtick = rest.match(/`([^`\n]+)`/);
    const rawCandidate = (backtick?.[1] ?? rest.split(/\s+/)[0] ?? "").trim();
    if (!rawCandidate || !isLikelyFilePath(rawCandidate)) continue;

    const check = validateRelativeWorkspacePath(rawCandidate);
    if (!check.valid || !check.relPath) continue;
    if (extractedSet.has(check.relPath)) continue;
    if (isDummyRootExamplePath(check.relPath)) continue;
    deletes.add(check.relPath);
  }

  return Array.from(deletes).slice(0, MAX_DELETES_PER_BATCH);
}

/**
 * Lista arquivos reais do projeto para dar visibilidade completa ao Auto-Fix
 * (ignorando diretórios pesados/protegidos e symlinks).
 */
export async function listWorkspaceSourceFiles(
  rootDir: string,
  maxFiles = 120
): Promise<string[]> {
  const rootReal = await resolveTrustedRoot(rootDir);
  const skipDirs = new Set([
    ...BLOCKED_WRITE_DIRS,
    "dist",
    "build",
    ".next",
    ".nuxt",
    "coverage",
    ".cache",
    ".turbo",
    "out",
    "target",
    "__pycache__",
    ".venv",
    "venv"
  ]);

  const found: string[] = [];

  async function walk(absDir: string, relPrefix: string, depth: number): Promise<void> {
    if (found.length >= maxFiles || depth > 6) return;
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (found.length >= maxFiles) break;
      if (entry.isSymbolicLink()) continue;

      const name = entry.name;
      const lower = name.toLowerCase();
      const rel = relPrefix ? `${relPrefix}/${name}` : name;

      if (entry.isDirectory()) {
        if (skipDirs.has(lower)) continue;
        await walk(join(absDir, name), rel, depth + 1);
      } else if (entry.isFile()) {
        if (lower === "package-lock.json" || lower === "yarn.lock" || lower === "pnpm-lock.yaml") {
          continue;
        }
        const check = validateRelativeWorkspacePath(rel);
        if (!check.valid || !check.relPath) continue;
        found.push(check.relPath);
      }
    }
  }

  await walk(rootReal, "", 0);
  return found;
}

/**
 * Extrai blocos de código com caminho de arquivo a partir de respostas em Markdown
 * (síntese do Conselho ou respostas do Gemini/OpenRouter).
 */
export function extractWorkspaceFilesFromMarkdown(
  markdown: string
): MarkdownExtractionResult {
  const text = String(markdown || "");
  const filesMap = new Map<string, ExtractedWorkspaceFile>();

  const fenceRe = /```([^\n`]*)\r?\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = fenceRe.exec(text)) !== null) {
    const infoRaw = (match[1] ?? "").trim();
    const bodyRaw = match[2] ?? "";
    const langLower = (infoRaw.split(/[\s:]/)[0] ?? "").toLowerCase();

    // Ignora blocos puramente de diagrama ou terminal
    if (
      langLower === "mermaid" ||
      langLower === "text" ||
      langLower === "txt" ||
      langLower === "console" ||
      langLower === "output"
    ) {
      // Só aceita se houver caminho explícito no infoRaw (ex: txt:notes.txt)
      if (!infoRaw.includes(":")) continue;
    }

    let candidatePath: string | null = null;

    // 1. Info string: ```ts:src/index.ts ou ```ts src/index.ts ou ```title="src/index.ts"
    const infoColon = infoRaw.match(/^[a-zA-Z0-9_-]+:(.+)$/);
    if (infoColon?.[1] && isLikelyFilePath(infoColon[1])) {
      candidatePath = normalizeRelativeWorkspacePath(infoColon[1]);
    } else {
      const infoParts = infoRaw.split(/\s+/).slice(1);
      for (const part of infoParts) {
        const cleanedPart = part.replace(/^(?:file|path|title)=/i, "");
        if (isLikelyFilePath(cleanedPart)) {
          candidatePath = normalizeRelativeWorkspacePath(cleanedPart);
          break;
        }
      }
    }

    // 2. Primeira linha de comentário dentro do bloco
    if (!candidatePath) {
      candidatePath = extractPathFromCodeFirstLine(bodyRaw);
    }

    // 3. Até 3 linhas não-vazias imediatamente anteriores ao bloco
    if (!candidatePath) {
      const before = text.slice(Math.max(0, match.index - 500), match.index);
      const prevLines = before
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .slice(-3)
        .reverse();
      for (const prevLine of prevLines) {
        const found = extractPathFromContextLine(prevLine);
        if (found) {
          candidatePath = found;
          break;
        }
      }
    }

    if (!candidatePath || isDummyRootExamplePath(candidatePath)) continue;

    const cleanBody = bodyRaw.replace(/\r\n/g, "\n");
    const incomplete = detectIncompleteCode(cleanBody);
    const existing = filesMap.get(candidatePath);
    // Se já existe versão completa e a nova parece incompleta, mantém a completa
    if (!existing || (existing.incomplete && !incomplete) || cleanBody.length >= existing.content.length) {
      filesMap.set(candidatePath, {
        path: candidatePath,
        content: cleanBody,
        incomplete
      });
    }
  }

  const files = Array.from(filesMap.values()).slice(0, MAX_FILES_PER_BATCH);
  const extractedSet = new Set(files.map((f) => f.path));
  const deletes = extractDeleteDirectivesOutsideFences(text, extractedSet);
  const deletedSet = new Set(deletes);
  const missingPaths = extractReferencedPlanPaths(text, extractedSet)
    .filter((p) => !deletedSet.has(p))
    .slice(0, 20);

  return { files, missingPaths, deletes };
}

export function buildCompactDiffPreview(
  beforeContent: string | null,
  afterContent: string
): { diffPreview: string; addedLines: number; removedLines: number } {
  const afterLines = afterContent.replace(/\r\n/g, "\n").split("\n");

  if (beforeContent === null) {
    const shown = afterLines.slice(0, MAX_DIFF_PREVIEW_LINES).map((l) => `+ ${l}`);
    if (afterLines.length > MAX_DIFF_PREVIEW_LINES) {
      shown.push(`... (+${afterLines.length - MAX_DIFF_PREVIEW_LINES} linhas)`);
    }
    return {
      diffPreview: shown.join("\n"),
      addedLines: afterLines.length,
      removedLines: 0
    };
  }

  const beforeLines = beforeContent.replace(/\r\n/g, "\n").split("\n");
  if (beforeContent.replace(/\r\n/g, "\n") === afterContent.replace(/\r\n/g, "\n")) {
    return { diffPreview: "", addedLines: 0, removedLines: 0 };
  }

  // Diff linha-a-linha compacto (prefixo/sufixo comum + bloco alterado)
  let prefix = 0;
  const minLen = Math.min(beforeLines.length, afterLines.length);
  while (prefix < minLen && beforeLines[prefix] === afterLines[prefix]) {
    prefix++;
  }

  let suffix = 0;
  while (
    suffix < minLen - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] ===
      afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }

  const removedSlice = beforeLines.slice(prefix, beforeLines.length - suffix);
  const addedSlice = afterLines.slice(prefix, afterLines.length - suffix);

  const out: string[] = [];
  if (prefix > 0) {
    const ctxStart = Math.max(0, prefix - 2);
    out.push(`@@ linha ${ctxStart + 1} @@`);
    for (let i = ctxStart; i < prefix; i++) {
      out.push(`  ${beforeLines[i] ?? ""}`);
    }
  }
  for (const l of removedSlice) {
    out.push(`- ${l}`);
  }
  for (const l of addedSlice) {
    out.push(`+ ${l}`);
  }
  if (suffix > 0) {
    const ctxEnd = Math.min(afterLines.length, afterLines.length - suffix + 2);
    for (let i = afterLines.length - suffix; i < ctxEnd; i++) {
      out.push(`  ${afterLines[i] ?? ""}`);
    }
  }

  const truncated = out.length > MAX_DIFF_PREVIEW_LINES;
  const shown = truncated
    ? [...out.slice(0, MAX_DIFF_PREVIEW_LINES), `... (+${out.length - MAX_DIFF_PREVIEW_LINES} linhas)`]
    : out;

  return {
    diffPreview: shown.join("\n"),
    addedLines: addedSlice.length,
    removedLines: removedSlice.length
  };
}

export async function previewWorkspaceChanges(
  rootDir: string,
  extractedFiles: ExtractedWorkspaceFile[]
): Promise<BuilderFileEntry[]> {
  const results: BuilderFileEntry[] = [];

  for (const file of extractedFiles.slice(0, MAX_FILES_PER_BATCH)) {
    const byteLen = Buffer.byteLength(file.content, "utf8");
    if (byteLen > MAX_FILE_WRITE_BYTES) {
      results.push({
        path: file.path,
        content: file.content,
        action: "blocked",
        blockReason: `Arquivo excede o limite seguro de ${Math.round(MAX_FILE_WRITE_BYTES / 1024)} KB.`,
        incomplete: file.incomplete
      });
      continue;
    }

    let safe;
    try {
      safe = await resolveSafeWorkspacePath(rootDir, file.path);
    } catch (err) {
      results.push({
        path: file.path,
        content: file.content,
        action: "blocked",
        blockReason: err instanceof Error ? err.message : "Bloqueado pelo sandbox.",
        incomplete: file.incomplete
      });
      continue;
    }

    let currentContent: string | null = null;
    try {
      const st = await stat(safe.absPath);
      if (st.isDirectory()) {
        results.push({
          path: safe.relPath,
          content: file.content,
          action: "blocked",
          blockReason: "Já existe uma pasta com este nome.",
          incomplete: file.incomplete
        });
        continue;
      }
      currentContent = await readFile(safe.absPath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") {
        results.push({
          path: safe.relPath,
          content: file.content,
          action: "blocked",
          blockReason: "Não foi possível ler o arquivo atual.",
          incomplete: file.incomplete
        });
        continue;
      }
    }

    const normalizedNew = file.content.replace(/\r\n/g, "\n");
    const normalizedOld = currentContent !== null ? currentContent.replace(/\r\n/g, "\n") : null;
    const isSame = normalizedOld !== null && normalizedOld === normalizedNew;
    const diff = buildCompactDiffPreview(currentContent, file.content);

    results.push({
      path: safe.relPath,
      content: file.content,
      action: isSame ? "unchanged" : currentContent === null ? "create" : "overwrite",
      diffPreview: diff.diffPreview,
      addedLines: diff.addedLines,
      removedLines: diff.removedLines,
      incomplete: file.incomplete
    });
  }

  return results;
}

async function pruneOldBackups(backupRoot: string): Promise<void> {
  try {
    const entries = await readdir(backupRoot, { withFileTypes: true });
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    if (dirs.length <= MAX_BACKUPS_KEPT) return;
    const toRemove = dirs.slice(0, dirs.length - MAX_BACKUPS_KEPT);
    for (const dirName of toRemove) {
      await rm(join(backupRoot, dirName), { recursive: true, force: true }).catch(() => {});
    }
  } catch {
    // Ignora erro de limpeza
  }
}

export async function applyWorkspaceChanges(
  rootDir: string,
  files: Array<{ path: string; content: string }>,
  options: { deletePaths?: string[] } = {}
): Promise<{
  applied: BuilderFileEntry[];
  backup: BuilderBackupInfo | null;
}> {
  const safeFiles = Array.isArray(files) ? files : [];
  const rawDeletes = Array.isArray(options.deletePaths)
    ? options.deletePaths.slice(0, MAX_DELETES_PER_BATCH)
    : [];

  if (safeFiles.length === 0 && rawDeletes.length === 0) {
    return { applied: [], backup: null };
  }

  const rootReal = await resolveTrustedRoot(rootDir);
  const preview =
    safeFiles.length > 0
      ? await previewWorkspaceChanges(
          rootReal,
          safeFiles.map((f) => ({ path: f.path, content: f.content, incomplete: false }))
        )
      : [];

  const writable = preview.filter(
    (entry) => entry.action === "create" || entry.action === "overwrite"
  );

  // Valida remoções (apenas arquivos regulares existentes dentro do sandbox)
  const deletable: Array<{ relPath: string; absPath: string; sizeLines: number }> = [];
  const deletePreviewEntries: BuilderFileEntry[] = [];
  const writtenPathSet = new Set(writable.map((w) => w.path));

  for (const rawDel of rawDeletes) {
    let safe;
    try {
      safe = await resolveSafeWorkspacePath(rootReal, rawDel);
    } catch (err) {
      deletePreviewEntries.push({
        path: rawDel,
        content: "",
        action: "blocked",
        blockReason: err instanceof Error ? err.message : "Remoção bloqueada pelo sandbox."
      });
      continue;
    }

    if (writtenPathSet.has(safe.relPath)) continue;
    if (deletable.some((d) => d.relPath === safe.relPath)) continue;

    try {
      const st = await stat(safe.absPath);
      if (!st.isFile()) continue;
      const oldText = await readFile(safe.absPath, "utf8").catch(() => "");
      const sizeLines = oldText ? oldText.replace(/\r\n/g, "\n").split("\n").length : 0;
      deletable.push({ relPath: safe.relPath, absPath: safe.absPath, sizeLines });
      deletePreviewEntries.push({
        path: safe.relPath,
        content: "",
        action: "delete",
        removedLines: sizeLines
      });
    } catch {
      // Arquivo já não existe — ignora silenciosamente
    }
  }

  const combinedApplied = [...preview, ...deletePreviewEntries];
  if (writable.length === 0 && deletable.length === 0) {
    return { applied: combinedApplied, backup: null };
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const batchId = `${stamp}_${randomBytes(3).toString("hex")}`;
  const backupRoot = join(rootReal, BACKUP_ROOT_DIR_NAME);
  const batchDir = join(backupRoot, batchId);
  const backupFilesDir = join(batchDir, "files");

  await mkdir(backupFilesDir, { recursive: true });

  const filesCreated: string[] = [];
  const filesOverwritten: string[] = [];
  const filesDeleted: string[] = [];
  const filesWritten: string[] = [];

  for (const entry of writable) {
    const safe = await resolveSafeWorkspacePath(rootReal, entry.path);

    if (entry.action === "overwrite") {
      const backupFilePath = resolve(backupFilesDir, ...safe.relPath.split("/"));
      await mkdir(dirname(backupFilePath), { recursive: true });
      const prevBytes = await readFile(safe.absPath);
      await writeFile(backupFilePath, prevBytes);
      filesOverwritten.push(safe.relPath);
    } else {
      filesCreated.push(safe.relPath);
    }

    await mkdir(dirname(safe.absPath), { recursive: true });
    // Revalida após mkdir para garantir que o destino continua 100% dentro do root
    await resolveSafeWorkspacePath(rootReal, safe.relPath);
    await writeFile(safe.absPath, entry.content, "utf8");
    filesWritten.push(safe.relPath);
  }

  for (const del of deletable) {
    const safe = await resolveSafeWorkspacePath(rootReal, del.relPath);
    const backupFilePath = resolve(backupFilesDir, ...safe.relPath.split("/"));
    await mkdir(dirname(backupFilePath), { recursive: true });
    const prevBytes = await readFile(safe.absPath);
    await writeFile(backupFilePath, prevBytes);
    await unlink(safe.absPath);
    filesDeleted.push(safe.relPath);
  }

  const createdAt = new Date().toISOString();
  const manifest: BackupManifest = {
    batchId,
    createdAt,
    filesWritten,
    filesCreated,
    filesOverwritten,
    filesDeleted: filesDeleted.length > 0 ? filesDeleted : undefined,
    undone: false
  };
  await writeFile(
    join(batchDir, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8"
  );

  await pruneOldBackups(backupRoot);

  return {
    applied: combinedApplied,
    backup: {
      batchId,
      backupRelDir: `${BACKUP_ROOT_DIR_NAME}/${batchId}`,
      createdAt,
      filesWritten,
      filesCreated,
      filesOverwritten,
      filesDeleted: filesDeleted.length > 0 ? filesDeleted : undefined,
      undone: false
    }
  };
}

export async function undoWorkspaceBackup(
  rootDir: string,
  batchId?: string
): Promise<{
  batchId: string;
  restoredCount: number;
  removedCreatedCount: number;
  backup: BuilderBackupInfo;
}> {
  const rootReal = await resolveTrustedRoot(rootDir);
  const backupRoot = join(rootReal, BACKUP_ROOT_DIR_NAME);

  let targetBatchId = batchId?.trim() || "";
  if (targetBatchId) {
    if (!/^[a-zA-Z0-9._-]+$/.test(targetBatchId) || targetBatchId.includes("..")) {
      throw new Error("Identificador de backup inválido.");
    }
  } else {
    const entries = await readdir(backupRoot, { withFileTypes: true }).catch(() => []);
    const dirs = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse();

    for (const dirName of dirs) {
      try {
        const raw = await readFile(join(backupRoot, dirName, "manifest.json"), "utf8");
        const m = JSON.parse(raw) as BackupManifest;
        if (!m.undone) {
          targetBatchId = dirName;
          break;
        }
      } catch {
        // Continua procurando manifesto válido
      }
    }
  }

  if (!targetBatchId) {
    throw new Error("Nenhum backup disponível para desfazer nesta pasta.");
  }

  const batchDir = join(backupRoot, targetBatchId);
  const manifestPath = join(batchDir, "manifest.json");
  const rawManifest = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(rawManifest) as BackupManifest;

  if (manifest.undone) {
    throw new Error("Este lote de alterações já foi desfeito anteriormente.");
  }

  let restoredCount = 0;
  let removedCreatedCount = 0;

  for (const relPath of manifest.filesOverwritten || []) {
    const safe = await resolveSafeWorkspacePath(rootReal, relPath);
    const savedCopy = resolve(batchDir, "files", ...safe.relPath.split("/"));
    const prevBytes = await readFile(savedCopy);
    await mkdir(dirname(safe.absPath), { recursive: true });
    await writeFile(safe.absPath, prevBytes);
    restoredCount++;
  }

  for (const relPath of manifest.filesDeleted || []) {
    const safe = await resolveSafeWorkspacePath(rootReal, relPath);
    const savedCopy = resolve(batchDir, "files", ...safe.relPath.split("/"));
    const prevBytes = await readFile(savedCopy);
    await mkdir(dirname(safe.absPath), { recursive: true });
    await writeFile(safe.absPath, prevBytes);
    restoredCount++;
  }

  for (const relPath of manifest.filesCreated || []) {
    const safe = await resolveSafeWorkspacePath(rootReal, relPath);
    try {
      await unlink(safe.absPath);
      removedCreatedCount++;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "ENOENT") throw err;
    }
  }

  manifest.undone = true;
  manifest.undoneAt = new Date().toISOString();
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  return {
    batchId: manifest.batchId,
    restoredCount,
    removedCreatedCount,
    backup: {
      batchId: manifest.batchId,
      backupRelDir: relative(rootReal, batchDir).replace(/\\/g, "/"),
      createdAt: manifest.createdAt,
      filesWritten: manifest.filesWritten,
      filesCreated: manifest.filesCreated,
      filesOverwritten: manifest.filesOverwritten,
      filesDeleted: manifest.filesDeleted,
      undone: true
    }
  };
}
