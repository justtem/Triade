import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const TRANSIENT_WIN_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);
const RETRY_DELAYS_MS = [25, 60, 120, 220, 350, 500];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrnoCode(err: unknown): string {
  return typeof err === "object" && err !== null && "code" in err
    ? String((err as { code?: unknown }).code || "")
    : "";
}

/**
 * Substitui `targetPath` por `tempPath` de forma resiliente no Windows NTFS.
 * Em Windows, leituras concorrentes (polling do frontend, Windows Defender, OneDrive)
 * causam `EPERM`/`EBUSY` transitórios durante `fs.rename()`.
 * Faz retry com backoff exponencial e, se ainda persistir no Windows, faz fallback
 * seguro gravando diretamente `fallbackContent` em `targetPath`.
 */
export async function renameWithRetry(
  tempPath: string,
  targetPath: string,
  fallbackContent?: string,
  mode = 0o600
): Promise<void> {
  let lastErr: unknown = null;

  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
    try {
      await rename(tempPath, targetPath);
      return;
    } catch (err) {
      lastErr = err;
      const code = getErrnoCode(err);
      if (!TRANSIENT_WIN_RENAME_CODES.has(code)) {
        throw err;
      }
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay !== undefined) {
        await sleep(delay);
      }
    }
  }

  // Fallback seguro no Windows caso antivírus/indexador segure o lock de rename:
  // grava diretamente sobre o arquivo alvo (que já existe ou será criado) em vez de abortar a operação.
  if (typeof fallbackContent === "string") {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await writeFile(targetPath, fallbackContent, { encoding: "utf8", mode });
        return;
      } catch (writeErr) {
        lastErr = writeErr;
        const code = getErrnoCode(writeErr);
        if (!TRANSIENT_WIN_RENAME_CODES.has(code)) {
          throw writeErr;
        }
        await sleep(80 * (attempt + 1));
      }
    }
  }

  throw lastErr;
}

/**
 * Grava texto em arquivo de forma atômica (.tmp + renameWithRetry + limpeza segura).
 */
export async function writeTextAtomically(
  filePath: string,
  content: string,
  options: { mode?: number } = {}
): Promise<void> {
  const mode = options.mode ?? 0o600;
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(tempPath, content, { encoding: "utf8", mode });
    await renameWithRetry(tempPath, filePath, content, mode);
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}
