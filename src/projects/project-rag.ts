import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, relative, resolve, sep } from "node:path";

import type {
  Project,
  ProjectResolvedChunk,
  ResolvedProjectContext
} from "../shared/debate-types.js";
import {
  getProjectById,
  readProjectFileText
} from "../persistence/project-store.js";
import { extractPdfTextFromBuffer } from "./pdf-extract.js";

// ============================================
// TRAVAS RÍGIDAS DE SEGURANÇA (SOMENTE LEITURA)
// ============================================

export const BLOCKED_DIR_NAMES = new Set([
  ".git",
  ".svn",
  ".hg",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "target",
  "coverage",
  ".idea",
  ".vscode",
  "out",
  "vendor",
  "bin",
  "obj",
  "tmp",
  ".parcel-cache"
]);

const ALLOWED_TEXT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".yml",
  ".yaml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".xml",
  ".csv",
  ".tsv",
  ".sql",
  ".html",
  ".htm",
  ".css",
  ".scss",
  ".less",
  ".py",
  ".java",
  ".kt",
  ".go",
  ".rs",
  ".c",
  ".cpp",
  ".h",
  ".hpp",
  ".cs",
  ".php",
  ".rb",
  ".swift",
  ".dart",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".bat",
  ".graphql",
  ".gql",
  ".prisma",
  ".vue",
  ".svelte",
  ".astro",
  ".r",
  ".lua",
  ".log"
]);

const ALLOWED_EXACT_FILENAMES = new Set([
  "readme",
  "license",
  "changelog",
  "dockerfile",
  "makefile",
  "procfile",
  "gemfile"
]);

const SECRET_EXTENSIONS = new Set([
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
  ".env",
  ".sqlite",
  ".sqlite3",
  ".db"
]);

const MAX_SCAN_DEPTH = 6;
const MAX_SCAN_FILES = 250;
const MAX_DISK_TEXT_BYTES = 512 * 1024; // 512 KB por arquivo texto em pasta vinculada
const MAX_DISK_PDF_BYTES = 10 * 1024 * 1024; // 10 MB por PDF em pasta vinculada
const MAX_DISK_PDF_FILES = 20;

const CHUNK_TARGET_CHARS = 1_100;
const CHUNK_OVERLAP_CHARS = 180;
const FULL_CONTEXT_THRESHOLD_CHARS = 14_000;
const FULL_CONTEXT_MAX_FILES = 8;
const MAX_RETURNED_CHUNKS = 12;

const STOPWORDS = new Set([
  "de", "da", "do", "das", "dos", "em", "no", "na", "nos", "nas",
  "um", "uma", "uns", "umas", "o", "a", "os", "as", "e", "ou", "para",
  "por", "com", "sem", "que", "se", "ao", "aos", "como", "mais", "menos",
  "mas", "foi", "ser", "sao", "esta", "este", "essa", "esse", "isso",
  "isto", "aqui", "ali", "la", "muito", "muita", "sobre", "entre",
  "the", "and", "for", "with", "that", "this", "from", "are", "was",
  "were", "have", "has", "had", "not", "but", "can", "will", "into",
  "qual", "quais", "onde", "quando", "porque", "como", "faca", "faça",
  "quero", "preciso", "ajude", "explique", "analise", "projeto", "arquivo"
]);

// Cache em memória de PDFs lidos da pasta local (invalidado por mtimeMs)
const diskPdfCache = new Map<string, { mtimeMs: number; text: string }>();
const MAX_DISK_PDF_CACHE = 40;

/**
 * Trava rígida de segurança: bloqueia .env, chaves privadas, credenciais e bancos locais.
 * Nunca pode ser contornada por configuração do usuário.
 */
export function isBlockedSecretFile(fileName: string): boolean {
  const lower = basename(fileName).toLowerCase();

  if (lower === ".env" || lower.startsWith(".env.") || lower.endsWith(".env")) {
    return true;
  }

  const ext = extname(lower);
  if (SECRET_EXTENSIONS.has(ext)) {
    return true;
  }

  if (
    lower === ".npmrc" ||
    lower === ".pypirc" ||
    lower === ".netrc" ||
    lower === ".htpasswd" ||
    lower === "id_rsa" ||
    lower.startsWith("id_rsa.") ||
    lower === "id_ed25519" ||
    lower.startsWith("id_ed25519.") ||
    lower === "id_ecdsa" ||
    lower.startsWith("id_ecdsa.") ||
    lower === "id_dsa" ||
    lower.startsWith("id_dsa.") ||
    lower.includes("credentials") ||
    lower.includes("service-account") ||
    lower.includes("service_account") ||
    lower.includes("private_key") ||
    lower.includes("privatekey") ||
    (lower.includes("secret") &&
      (ext === ".json" ||
        ext === ".yml" ||
        ext === ".yaml" ||
        ext === ".toml" ||
        ext === ".ini" ||
        ext === ".txt" ||
        ext === ""))
  ) {
    return true;
  }

  return false;
}

export function isSupportedProjectFileName(fileName: string): {
  supported: boolean;
  kind: "text" | "pdf" | null;
} {
  if (isBlockedSecretFile(fileName)) {
    return { supported: false, kind: null };
  }

  const lower = basename(fileName).toLowerCase();
  const ext = extname(lower);

  if (ext === ".pdf") {
    return { supported: true, kind: "pdf" };
  }

  if (ALLOWED_TEXT_EXTENSIONS.has(ext) || ALLOWED_EXACT_FILENAMES.has(lower)) {
    return { supported: true, kind: "text" };
  }

  return { supported: false, kind: null };
}

interface LoadedDocument {
  sourceName: string;
  origin: "upload" | "folder";
  filePath?: string;
  content: string;
}

export interface FolderInspectionResult {
  valid: boolean;
  resolvedPath: string;
  error?: string;
  indexableFiles: number;
  pdfFiles: number;
  blockedSecrets: number;
  ignoredDirs: number;
  sampleFiles: string[];
}

/**
 * Inspeciona uma pasta local do PC em modo estritamente somente-leitura,
 * informando quantos arquivos serão indexados e quantos segredos foram protegidos.
 */
export async function inspectLinkedFolder(
  rawPath: string
): Promise<FolderInspectionResult> {
  const trimmed = (rawPath ?? "").trim();
  if (!trimmed) {
    return {
      valid: false,
      resolvedPath: "",
      error: "Informe o caminho completo de uma pasta local do PC.",
      indexableFiles: 0,
      pdfFiles: 0,
      blockedSecrets: 0,
      ignoredDirs: 0,
      sampleFiles: []
    };
  }

  const resolvedPath = resolve(trimmed);

  try {
    const st = await stat(resolvedPath);
    if (!st.isDirectory()) {
      return {
        valid: false,
        resolvedPath,
        error: "O caminho informado não é uma pasta.",
        indexableFiles: 0,
        pdfFiles: 0,
        blockedSecrets: 0,
        ignoredDirs: 0,
        sampleFiles: []
      };
    }
  } catch {
    return {
      valid: false,
      resolvedPath,
      error: "Pasta não encontrada ou sem permissão de leitura.",
      indexableFiles: 0,
      pdfFiles: 0,
      blockedSecrets: 0,
      ignoredDirs: 0,
      sampleFiles: []
    };
  }

  let indexableFiles = 0;
  let pdfFiles = 0;
  let blockedSecrets = 0;
  let ignoredDirs = 0;
  const sampleFiles: string[] = [];

  async function walk(currentDir: string, depth: number): Promise<void> {
    if (depth > MAX_SCAN_DEPTH || indexableFiles >= MAX_SCAN_FILES) return;

    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (indexableFiles >= MAX_SCAN_FILES) break;
      if (entry.isSymbolicLink()) continue;

      const fullPath = resolve(currentDir, entry.name);
      if (!fullPath.startsWith(resolvedPath + sep) && fullPath !== resolvedPath) {
        continue;
      }

      if (entry.isDirectory()) {
        if (BLOCKED_DIR_NAMES.has(entry.name.toLowerCase()) || entry.name.startsWith(".")) {
          ignoredDirs++;
          continue;
        }
        await walk(fullPath, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;

      if (isBlockedSecretFile(entry.name)) {
        blockedSecrets++;
        continue;
      }

      const check = isSupportedProjectFileName(entry.name);
      if (!check.supported) continue;

      try {
        const st = await stat(fullPath);
        if (check.kind === "pdf" && st.size > MAX_DISK_PDF_BYTES) continue;
        if (check.kind === "text" && st.size > MAX_DISK_TEXT_BYTES) continue;
        if (st.size === 0) continue;

        indexableFiles++;
        if (check.kind === "pdf") pdfFiles++;
        if (sampleFiles.length < 8) {
          sampleFiles.push(relative(resolvedPath, fullPath).replace(/\\/g, "/"));
        }
      } catch {
        // Ignora arquivo ilegível
      }
    }
  }

  await walk(resolvedPath, 0);

  return {
    valid: true,
    resolvedPath,
    indexableFiles,
    pdfFiles,
    blockedSecrets,
    ignoredDirs,
    sampleFiles
  };
}

async function readLinkedFolderDocuments(
  rawPath: string
): Promise<LoadedDocument[]> {
  const trimmed = (rawPath ?? "").trim();
  if (!trimmed) return [];

  const rootDir = resolve(trimmed);
  try {
    const st = await stat(rootDir);
    if (!st.isDirectory()) return [];
  } catch {
    return [];
  }

  const docs: LoadedDocument[] = [];
  let scannedCount = 0;
  let pdfCount = 0;

  async function walk(currentDir: string, depth: number): Promise<void> {
    if (depth > MAX_SCAN_DEPTH || scannedCount >= MAX_SCAN_FILES) return;

    let entries;
    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (scannedCount >= MAX_SCAN_FILES) break;
      if (entry.isSymbolicLink()) continue;

      const fullPath = resolve(currentDir, entry.name);
      if (!fullPath.startsWith(rootDir + sep) && fullPath !== rootDir) {
        continue;
      }

      if (entry.isDirectory()) {
        if (BLOCKED_DIR_NAMES.has(entry.name.toLowerCase()) || entry.name.startsWith(".")) {
          continue;
        }
        await walk(fullPath, depth + 1);
        continue;
      }

      if (!entry.isFile()) continue;

      const check = isSupportedProjectFileName(entry.name);
      if (!check.supported) continue;

      try {
        const st = await stat(fullPath);
        if (st.size === 0) continue;

        const relPath = relative(rootDir, fullPath).replace(/\\/g, "/");

        if (check.kind === "pdf") {
          if (st.size > MAX_DISK_PDF_BYTES || pdfCount >= MAX_DISK_PDF_FILES) {
            continue;
          }
          pdfCount++;
          scannedCount++;

          const cached = diskPdfCache.get(fullPath);
          let text = "";
          if (cached && cached.mtimeMs === st.mtimeMs) {
            text = cached.text;
          } else {
            const buf = await readFile(fullPath);
            text = await extractPdfTextFromBuffer(buf).catch(() => "");
            if (diskPdfCache.size >= MAX_DISK_PDF_CACHE) {
              const firstKey = diskPdfCache.keys().next().value;
              if (firstKey) diskPdfCache.delete(firstKey);
            }
            diskPdfCache.set(fullPath, { mtimeMs: st.mtimeMs, text });
          }

          if (text.trim()) {
            docs.push({
              sourceName: relPath,
              origin: "folder",
              filePath: relPath,
              content: text.trim()
            });
          }
          continue;
        }

        if (st.size > MAX_DISK_TEXT_BYTES) continue;
        scannedCount++;

        const buf = await readFile(fullPath);
        // Bloqueia binários disfarçados com extensão de texto (presença de byte nulo)
        if (buf.subarray(0, Math.min(buf.length, 4096)).includes(0)) {
          continue;
        }

        const text = buf.toString("utf8").replace(/\r\n/g, "\n").trim();
        if (!text) continue;

        docs.push({
          sourceName: relPath,
          origin: "folder",
          filePath: relPath,
          content: text
        });
      } catch {
        // Ignora arquivo ilegível sem quebrar a busca
      }
    }
  }

  await walk(rootDir, 0);
  return docs;
}

// ============================================
// TOKENIZAÇÃO, CHUNKING & BM25 LOCAL (0 API)
// ============================================

export function normalizeAndTokenize(text: string): string[] {
  const clean = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const rawTokens = clean.match(/[a-z0-9_]{2,}/g) ?? [];
  const tokens: string[] = [];

  for (const tok of rawTokens) {
    if (!STOPWORDS.has(tok)) {
      tokens.push(tok);
    }
    // Quebra snake_case em subtokens para melhorar match de código
    if (tok.includes("_")) {
      for (const sub of tok.split("_")) {
        if (sub.length >= 2 && !STOPWORDS.has(sub)) {
          tokens.push(sub);
        }
      }
    }
  }

  return tokens;
}

interface RawChunk {
  sourceName: string;
  origin: "upload" | "folder";
  filePath?: string;
  content: string;
  tokens: string[];
  nameTokens: Set<string>;
}

function splitIntoChunks(doc: LoadedDocument): RawChunk[] {
  const text = doc.content.trim();
  const nameTokens = new Set(normalizeAndTokenize(doc.sourceName));

  if (text.length <= CHUNK_TARGET_CHARS + 200) {
    return [
      {
        sourceName: doc.sourceName,
        origin: doc.origin,
        ...(doc.filePath ? { filePath: doc.filePath } : {}),
        content: text,
        tokens: normalizeAndTokenize(text),
        nameTokens
      }
    ];
  }

  const chunks: RawChunk[] = [];
  let start = 0;

  while (start < text.length) {
    let end = Math.min(text.length, start + CHUNK_TARGET_CHARS);
    if (end < text.length) {
      // Prefere cortar em quebra de parágrafo ou linha próxima ao final do chunk
      const paraBreak = text.lastIndexOf("\n\n", end);
      const lineBreak = text.lastIndexOf("\n", end);
      if (paraBreak > start + CHUNK_TARGET_CHARS * 0.55) {
        end = paraBreak;
      } else if (lineBreak > start + CHUNK_TARGET_CHARS * 0.65) {
        end = lineBreak;
      }
    }

    const slice = text.slice(start, end).trim();
    if (slice.length > 0) {
      chunks.push({
        sourceName: doc.sourceName,
        origin: doc.origin,
        ...(doc.filePath ? { filePath: doc.filePath } : {}),
        content: slice,
        tokens: normalizeAndTokenize(slice),
        nameTokens
      });
    }

    if (end >= text.length) break;
    start = Math.max(start + 200, end - CHUNK_OVERLAP_CHARS);
  }

  return chunks;
}

function makeSnippet(content: string, maxLen = 220): string {
  const flat = content.replace(/\s+/g, " ").trim();
  if (flat.length <= maxLen) return flat;
  return `${flat.slice(0, maxLen).trim()}...`;
}

export function rankChunksBM25(
  docs: LoadedDocument[],
  query: string,
  maxChunks = MAX_RETURNED_CHUNKS
): { mode: "full" | "bm25"; chunks: ProjectResolvedChunk[] } {
  if (docs.length === 0) {
    return { mode: "full", chunks: [] };
  }

  const totalChars = docs.reduce((acc, d) => acc + d.content.length, 0);
  const queryTerms = Array.from(new Set(normalizeAndTokenize(query)));

  // Se o projeto inteiro é pequeno, entrega todos os arquivos na íntegra (ordenados por relevância)
  if (
    totalChars <= FULL_CONTEXT_THRESHOLD_CHARS &&
    docs.length <= FULL_CONTEXT_MAX_FILES
  ) {
    const scoredDocs = docs.map((doc) => {
      const textTokens = normalizeAndTokenize(doc.content);
      const nameTokens = new Set(normalizeAndTokenize(doc.sourceName));
      let score = 0;
      for (const term of queryTerms) {
        if (nameTokens.has(term)) score += 3;
        if (textTokens.includes(term)) score += 1;
      }
      return { doc, score };
    });

    scoredDocs.sort((a, b) => b.score - a.score);

    return {
      mode: "full",
      chunks: scoredDocs.map(({ doc, score }) => ({
        sourceName: doc.sourceName,
        origin: doc.origin,
        ...(doc.filePath ? { filePath: doc.filePath } : {}),
        snippet: makeSnippet(doc.content),
        content: doc.content,
        score: Number(score.toFixed(2))
      }))
    };
  }

  // Projeto médio/grande: chunking + BM25 real
  const allChunks: RawChunk[] = [];
  for (const doc of docs) {
    allChunks.push(...splitIntoChunks(doc));
  }

  if (allChunks.length === 0) {
    return { mode: "bm25", chunks: [] };
  }

  const N = allChunks.length;
  const avgDocLen =
    allChunks.reduce((sum, c) => sum + c.tokens.length, 0) / Math.max(1, N);

  const docFreq = new Map<string, number>();
  const termFreqsPerChunk: Array<Map<string, number>> = [];

  for (const chunk of allChunks) {
    const tf = new Map<string, number>();
    for (const tok of chunk.tokens) {
      tf.set(tok, (tf.get(tok) ?? 0) + 1);
    }
    termFreqsPerChunk.push(tf);
    for (const uniqueTok of tf.keys()) {
      docFreq.set(uniqueTok, (docFreq.get(uniqueTok) ?? 0) + 1);
    }
  }

  const k1 = 1.5;
  const b = 0.75;

  const scored = allChunks.map((chunk, idx) => {
    const tfMap = termFreqsPerChunk[idx]!;
    const dl = Math.max(1, chunk.tokens.length);
    let score = 0;

    for (const term of queryTerms) {
      const tf = tfMap.get(term) ?? 0;
      if (tf > 0) {
        const df = docFreq.get(term) ?? 0;
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + b * (dl / avgDocLen))));
      }
      // Bônus forte quando o nome/caminho do arquivo corresponde a um termo da pergunta
      if (chunk.nameTokens.has(term)) {
        score += 2.2;
      }
    }

    // Leve bônus para arquivos enviados explicitamente ao projeto
    if (chunk.origin === "upload" && score > 0) {
      score += 0.35;
    }

    return { chunk, score };
  });

  scored.sort((a, b) => b.score - a.score);

  const positive = scored.filter((item) => item.score > 0);

  // Evita que um único arquivo domine todos os slots (máx 3 chunks por arquivo)
  const selected: ProjectResolvedChunk[] = [];
  const countBySource = new Map<string, number>();

  const pool = positive.length > 0 ? positive : scored;
  for (const item of pool) {
    if (selected.length >= maxChunks) break;
    const prevCount = countBySource.get(item.chunk.sourceName) ?? 0;
    if (prevCount >= 3) continue;
    countBySource.set(item.chunk.sourceName, prevCount + 1);

    selected.push({
      sourceName: item.chunk.sourceName,
      origin: item.chunk.origin,
      ...(item.chunk.filePath ? { filePath: item.chunk.filePath } : {}),
      snippet: makeSnippet(item.chunk.content),
      content: item.chunk.content,
      score: Number(item.score.toFixed(2))
    });

    // Se caiu no fallback (sem termos coincidentes), pega só uma amostra leve de 4 arquivos
    if (positive.length === 0 && selected.length >= 4) {
      break;
    }
  }

  return {
    mode: "bm25",
    chunks: selected
  };
}

/**
 * Carrega instruções + arquivos (uploads + pasta local somente leitura) do Projeto
 * e devolve o contexto pronto para ser injetado com orçamento por IA.
 */
export async function gatherProjectContext(
  projectId: string | undefined,
  query: string
): Promise<ResolvedProjectContext | null> {
  if (!projectId) return null;

  const project: Project | null = await getProjectById(projectId);
  if (!project) return null;

  const docs: LoadedDocument[] = [];

  // 1. Arquivos enviados ao projeto (acessíveis no PC e no celular)
  for (const fileMeta of project.files) {
    const text = await readProjectFileText(project.id, fileMeta.id);
    if (text && text.trim()) {
      docs.push({
        sourceName: fileMeta.name,
        origin: "upload",
        content: text.trim()
      });
    }
  }

  // 2. Pasta local do PC vinculada (somente leitura, segredos/binários bloqueados)
  if (project.linkedFolderPath?.trim()) {
    const folderDocs = await readLinkedFolderDocuments(project.linkedFolderPath);
    docs.push(...folderDocs);
  }

  const instructions = project.instructions.trim();
  const ranked = rankChunksBM25(docs, query);

  return {
    meta: {
      projectId: project.id,
      projectName: project.name,
      instructionsApplied: instructions.length > 0,
      mode: ranked.mode,
      totalFilesScanned: docs.length,
      chunks: ranked.chunks.map((c) => ({
        sourceName: c.sourceName,
        origin: c.origin,
        ...(c.filePath ? { filePath: c.filePath } : {}),
        snippet: c.snippet,
        score: c.score
      }))
    },
    instructions,
    chunks: ranked.chunks
  };
}

/**
 * Monta o bloco de texto do Projeto respeitando rigorosamente o orçamento de caracteres da IA
 * (Gemini recebe mais contexto; Groq gratuito recebe versão enxuta sem estourar 8k TPM).
 */
export function buildProjectContextBlock(
  resolved: ResolvedProjectContext | undefined,
  maxChars: number,
  options: { instructionsOnly?: boolean } = {}
): string {
  if (!resolved) return "";
  const safeMax = Math.max(600, maxChars);
  const parts: string[] = [];
  let used = 0;

  const header = `Contexto do Projeto "${resolved.meta.projectName}":`;
  parts.push(header);
  used += header.length + 2;

  if (resolved.instructions) {
    const instrLimit = options.instructionsOnly
      ? Math.min(safeMax - used, 2_200)
      : Math.min(Math.floor(safeMax * 0.35), 3_500);
    const instrText =
      resolved.instructions.length > instrLimit
        ? `${resolved.instructions.slice(0, instrLimit).trim()}...`
        : resolved.instructions;
    const instrBlock = `Instruções fixas do projeto:\n${instrText}`;
    parts.push("", instrBlock);
    used += instrBlock.length + 2;
  }

  if (options.instructionsOnly || resolved.chunks.length === 0) {
    return resolved.instructions ? parts.join("\n") : "";
  }

  const modeNote =
    resolved.meta.mode === "full"
      ? "Base completa de arquivos do projeto:"
      : "Trechos mais relevantes encontrados nos arquivos do projeto (busca local):";
  parts.push("", modeNote);
  used += modeNote.length + 2;

  let addedChunks = 0;
  for (const chunk of resolved.chunks) {
    const remaining = safeMax - used;
    if (remaining < 240) break;

    const originTag = chunk.origin === "folder" ? "pasta local" : "upload";
    const heading = `### [${originTag}] ${chunk.sourceName}`;
    const bodyLimit = remaining - heading.length - 16;
    if (bodyLimit < 150) break;

    const body =
      chunk.content.length > bodyLimit
        ? `${chunk.content.slice(0, bodyLimit).trim()}\n[... trecho reduzido para caber no orçamento da IA ...]`
        : chunk.content;

    const block = `${heading}\n${body}`;
    parts.push("", block);
    used += block.length + 2;
    addedChunks++;
  }

  if (!resolved.instructions && addedChunks === 0) {
    return "";
  }

  return parts.join("\n");
}
