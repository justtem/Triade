import { execFile } from "node:child_process";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  normalizePrivacyShieldMode,
  type PrivacyShieldMode
} from "./privacy-shield.js";

const execFileAsync = promisify(execFile);
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENVELOPE_PREFIX = "AIC_ENC_V1:";
const KEY_BYTES = 32; // AES-256-GCM
const IV_BYTES = 12;

export interface PrivacySettings {
  shieldMode: PrivacyShieldMode;
  encryptAtRest: boolean;
  ntfsHardenedAt?: string;
  updatedAt: string;
}

export interface NtfsHardeningResult {
  supported: boolean;
  applied: boolean;
  paths: string[];
  error?: string;
}

export interface DataProtectionStatus {
  shieldMode: PrivacyShieldMode;
  encryptAtRest: boolean;
  dpapiSupported: boolean;
  ntfsSupported: boolean;
  ntfsHardenedAt?: string;
  vaultKeyPresent: boolean;
}

type KeyCodec = {
  protect: (plainKey: Buffer) => Promise<Buffer>;
  unprotect: (protectedKey: Buffer) => Promise<Buffer>;
};

let customKeyCodecForTests: KeyCodec | null = null;
let cachedSettings: { dir: string; settings: PrivacySettings } | null = null;
let cachedVaultKey: { dir: string; key: Buffer } | null = null;
let cachedWindowsUserSid: string | null = null;

function getDataDir(): string {
  return process.env.AI_COUNCIL_DATA_DIR
    ? resolve(process.env.AI_COUNCIL_DATA_DIR)
    : resolve(ROOT_DIR, "data");
}

function getPrivacyConfigPath(dataDir = getDataDir()): string {
  return resolve(dataDir, "privacy-config.json");
}

function getVaultKeyPath(dataDir = getDataDir()): string {
  return resolve(dataDir, ".vault.key");
}

/** Permite injetar codec DPAPI determinístico em testes unitários sem abrir PowerShell. */
export function setVaultKeyCodecForTests(codec: KeyCodec | null): void {
  customKeyCodecForTests = codec;
  cachedVaultKey = null;
  cachedSettings = null;
}

export function resetDataProtectionCache(): void {
  cachedSettings = null;
  cachedVaultKey = null;
}

export function isDpapiSupported(): boolean {
  return process.platform === "win32" || customKeyCodecForTests !== null;
}

export function isNtfsSupported(): boolean {
  return process.platform === "win32";
}

function defaultPrivacySettings(): PrivacySettings {
  return {
    shieldMode: "strict",
    encryptAtRest: false,
    updatedAt: new Date().toISOString()
  };
}

export async function readPrivacySettings(): Promise<PrivacySettings> {
  const dir = getDataDir();
  if (cachedSettings && cachedSettings.dir === dir) {
    return { ...cachedSettings.settings };
  }

  const file = getPrivacyConfigPath(dir);
  try {
    const raw = await readFile(file, "utf8");
    const parsed = JSON.parse(raw) as Partial<PrivacySettings>;
    const settings: PrivacySettings = {
      shieldMode: normalizePrivacyShieldMode(parsed.shieldMode),
      encryptAtRest: Boolean(parsed.encryptAtRest),
      ...(typeof parsed.ntfsHardenedAt === "string"
        ? { ntfsHardenedAt: parsed.ntfsHardenedAt }
        : {}),
      updatedAt:
        typeof parsed.updatedAt === "string"
          ? parsed.updatedAt
          : new Date().toISOString()
    };
    cachedSettings = { dir, settings };
    return { ...settings };
  } catch {
    const defaults = defaultPrivacySettings();
    cachedSettings = { dir, settings: defaults };
    return { ...defaults };
  }
}

export async function writePrivacySettings(
  patch: Partial<Pick<PrivacySettings, "shieldMode" | "encryptAtRest" | "ntfsHardenedAt">>
): Promise<PrivacySettings> {
  const dir = getDataDir();
  const current = await readPrivacySettings();
  const next: PrivacySettings = {
    ...current,
    ...(patch.shieldMode !== undefined
      ? { shieldMode: normalizePrivacyShieldMode(patch.shieldMode) }
      : {}),
    ...(patch.encryptAtRest !== undefined
      ? { encryptAtRest: Boolean(patch.encryptAtRest) }
      : {}),
    ...(patch.ntfsHardenedAt !== undefined
      ? { ntfsHardenedAt: patch.ntfsHardenedAt }
      : {}),
    updatedAt: new Date().toISOString()
  };

  const file = getPrivacyConfigPath(dir);
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(next, null, 2), {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(tmp, file);
  cachedSettings = { dir, settings: next };
  return { ...next };
}

// ============================================================================
// WINDOWS DPAPI (proteção da chave mestra amarrada ao usuário logado no Windows)
// ============================================================================

async function runPowerShellWithStdin(script: string, stdinText: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 15_000, maxBuffer: 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(new Error(stderr?.trim() || error.message));
          return;
        }
        resolvePromise(String(stdout ?? "").trim());
      }
    );

    if (child.stdin) {
      child.stdin.write(stdinText);
      child.stdin.end();
    }
  });
}

async function protectKeyWithWindowsDpapi(plainKey: Buffer): Promise<Buffer> {
  if (customKeyCodecForTests) {
    return customKeyCodecForTests.protect(plainKey);
  }
  if (process.platform !== "win32") {
    throw new Error("Windows DPAPI disponível apenas no Windows.");
  }

  const script = [
    "Add-Type -AssemblyName System.Security;",
    "$b64 = [Console]::In.ReadToEnd().Trim();",
    "$bytes = [Convert]::FromBase64String($b64);",
    "$entropy = [System.Text.Encoding]::UTF8.GetBytes('ai-council-vault-v1');",
    "$enc = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);",
    "[Console]::Out.Write([Convert]::ToBase64String($enc));"
  ].join(" ");

  const protectedB64 = await runPowerShellWithStdin(script, plainKey.toString("base64"));
  if (!protectedB64) {
    throw new Error("DPAPI retornou saída vazia ao proteger chave.");
  }
  return Buffer.from(protectedB64, "base64");
}

async function unprotectKeyWithWindowsDpapi(protectedKey: Buffer): Promise<Buffer> {
  if (customKeyCodecForTests) {
    return customKeyCodecForTests.unprotect(protectedKey);
  }
  if (process.platform !== "win32") {
    throw new Error("Windows DPAPI disponível apenas no Windows.");
  }

  const script = [
    "Add-Type -AssemblyName System.Security;",
    "$b64 = [Console]::In.ReadToEnd().Trim();",
    "$bytes = [Convert]::FromBase64String($b64);",
    "$entropy = [System.Text.Encoding]::UTF8.GetBytes('ai-council-vault-v1');",
    "$dec = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser);",
    "[Console]::Out.Write([Convert]::ToBase64String($dec));"
  ].join(" ");

  const plainB64 = await runPowerShellWithStdin(script, protectedKey.toString("base64"));
  if (!plainB64) {
    throw new Error("DPAPI não conseguiu descriptografar a chave local.");
  }
  return Buffer.from(plainB64, "base64");
}

async function getOrCreateVaultKey(createIfMissing: boolean): Promise<Buffer> {
  const dir = getDataDir();
  if (cachedVaultKey && cachedVaultKey.dir === dir) {
    return cachedVaultKey.key;
  }

  const keyFile = getVaultKeyPath(dir);
  try {
    const raw = (await readFile(keyFile, "utf8")).trim();
    const protectedBuf = Buffer.from(raw, "base64");
    const plainKey = await unprotectKeyWithWindowsDpapi(protectedBuf);
    if (plainKey.byteLength !== KEY_BYTES) {
      throw new Error("Chave do cofre com tamanho inválido.");
    }
    cachedVaultKey = { dir, key: plainKey };
    return plainKey;
  } catch (error) {
    const isMissing =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "ENOENT";

    if (!isMissing || !createIfMissing) {
      throw new Error(
        "Não foi possível abrir a chave de criptografia local (.vault.key). Ela só pode ser aberta na mesma conta de usuário Windows que a criou."
      );
    }

    const freshKey = randomBytes(KEY_BYTES);
    const wrapped = await protectKeyWithWindowsDpapi(freshKey);
    await mkdir(dirname(keyFile), { recursive: true });
    const tmp = `${keyFile}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, wrapped.toString("base64"), {
      encoding: "utf8",
      mode: 0o600
    });
    await rename(tmp, keyFile);
    if (process.platform === "win32" && !customKeyCodecForTests) {
      await applyNtfsOwnerOnlyPermissions([keyFile]).catch(() => {});
    }
    cachedVaultKey = { dir, key: freshKey };
    return freshKey;
  }
}

// ============================================================================
// CRIPTOGRAFIA AES-256-GCM EM REPOUSO (TRANSPARENTE E RETROCOMPATÍVEL)
// ============================================================================

export function isEncryptedEnvelope(raw: string): boolean {
  return raw.startsWith(ENVELOPE_PREFIX);
}

export function encryptTextWithKey(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final()
  ]);
  const tag = cipher.getAuthTag();
  return `${ENVELOPE_PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptTextWithKey(envelope: string, key: Buffer): string {
  if (!isEncryptedEnvelope(envelope)) {
    return envelope;
  }
  const rest = envelope.slice(ENVELOPE_PREFIX.length).trim();
  const parts = rest.split(":");
  if (parts.length !== 3) {
    throw new Error("Envelope criptografado corrompido.");
  }
  const iv = Buffer.from(parts[0]!, "base64");
  const tag = Buffer.from(parts[1]!, "base64");
  const ciphertext = Buffer.from(parts[2]!, "base64");

  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final()
  ]);
  return decrypted.toString("utf8");
}

/** Codifica texto para gravação em disco (cifra se `encryptAtRest` estiver ativo). */
export async function encodeStorageText(plaintext: string): Promise<string> {
  const settings = await readPrivacySettings();
  if (!settings.encryptAtRest) {
    return plaintext;
  }
  const key = await getOrCreateVaultKey(true);
  return encryptTextWithKey(plaintext, key);
}

/** Decodifica texto lido do disco (descriptografa se começar com `AIC_ENC_V1:`, senão devolve texto normal). */
export async function decodeStorageText(raw: string): Promise<string> {
  if (!isEncryptedEnvelope(raw)) {
    return raw;
  }
  const key = await getOrCreateVaultKey(false);
  return decryptTextWithKey(raw, key);
}

async function listMigratableDataFiles(dataDir: string): Promise<string[]> {
  const files: string[] = [];

  const maybeAdd = async (filePath: string) => {
    try {
      await access(filePath);
      files.push(filePath);
    } catch {
      // Não existe
    }
  };

  await maybeAdd(resolve(dataDir, "user-memory.json"));

  // data/sessions/*.json
  const sessionsDir = resolve(dataDir, "sessions");
  try {
    const entries = await readdir(sessionsDir);
    for (const name of entries) {
      if (name.endsWith(".json")) {
        files.push(resolve(sessionsDir, name));
      }
    }
  } catch {
    // Ainda não existe
  }

  // data/projects/index.json e data/projects/*/files/*.txt
  const projectsDir = resolve(dataDir, "projects");
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(resolve(projectsDir, entry.name));
      } else if (entry.isDirectory()) {
        const subFilesDir = resolve(projectsDir, entry.name, "files");
        try {
          const subEntries = await readdir(subFilesDir);
          for (const f of subEntries) {
            if (f.endsWith(".txt")) {
              files.push(resolve(subFilesDir, f));
            }
          }
        } catch {
          // Sem arquivos
        }
      }
    }
  } catch {
    // Ainda não existe
  }

  return files;
}

/**
 * Ativa ou desativa a criptografia em repouso (`AES-256-GCM` + Windows DPAPI),
 * migrando todos os arquivos locais existentes de forma atômica e sem perda de dados.
 */
export async function setEncryptAtRestEnabled(
  enabled: boolean
): Promise<{ settings: PrivacySettings; migratedFiles: number }> {
  if (enabled && !isDpapiSupported()) {
    throw new Error(
      "Criptografia automática via DPAPI está disponível apenas no Windows. Em Linux/macOS, utilize criptografia de disco do sistema (LUKS / FileVault)."
    );
  }

  const dataDir = getDataDir();
  const key = enabled
    ? await getOrCreateVaultKey(true)
    : await getOrCreateVaultKey(false).catch(() => null);

  const targets = await listMigratableDataFiles(dataDir);
  let migratedFiles = 0;

  for (const filePath of targets) {
    const raw = await readFile(filePath, "utf8");
    const alreadyEncrypted = isEncryptedEnvelope(raw);

    if (enabled && !alreadyEncrypted && key) {
      const next = encryptTextWithKey(raw, key);
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(tmp, next, { encoding: "utf8", mode: 0o600 });
        await rename(tmp, filePath);
        migratedFiles++;
      } finally {
        await rm(tmp, { force: true }).catch(() => {});
      }
    } else if (!enabled && alreadyEncrypted) {
      if (!key) {
        throw new Error(
          "Chave local (.vault.key) ausente; não foi possível descriptografar os arquivos existentes."
        );
      }
      const next = decryptTextWithKey(raw, key);
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(tmp, next, { encoding: "utf8", mode: 0o600 });
        await rename(tmp, filePath);
        migratedFiles++;
      } finally {
        await rm(tmp, { force: true }).catch(() => {});
      }
    }
  }

  const settings = await writePrivacySettings({ encryptAtRest: enabled });
  return { settings, migratedFiles };
}

// ============================================================================
// PERMISSÕES NTFS NO WINDOWS (icacls com SID do usuário atual — 100% independente de idioma)
// ============================================================================

async function resolveCurrentWindowsUserSid(): Promise<string> {
  if (cachedWindowsUserSid) return cachedWindowsUserSid;
  const { stdout } = await execFileAsync(
    "whoami.exe",
    ["/user", "/fo", "csv", "/nh"],
    { timeout: 8_000, windowsHide: true }
  );
  // Formato CSV: "DESKTOP\usuario","S-1-5-21-..."
  const match = stdout.match(/(S-1-5-[0-9-]+)/);
  if (!match?.[1]) {
    throw new Error("Não foi possível identificar o SID do usuário Windows.");
  }
  cachedWindowsUserSid = match[1];
  return cachedWindowsUserSid;
}

/**
 * Restringe permissões NTFS de arquivos/pastas sensíveis (.env e data/)
 * exclusivamente ao usuário Windows atual + SYSTEM (*S-1-5-18), removendo herança de Users/Everyone.
 */
export async function applyNtfsOwnerOnlyPermissions(
  rawPaths: string[]
): Promise<NtfsHardeningResult> {
  if (process.platform !== "win32") {
    return { supported: false, applied: false, paths: [] };
  }

  const appliedPaths: string[] = [];
  try {
    const userSid = await resolveCurrentWindowsUserSid();

    for (const target of rawPaths) {
      const absPath = resolve(target);
      let info;
      try {
        info = await stat(absPath);
      } catch {
        continue;
      }

      const grantUser = info.isDirectory()
        ? `*${userSid}:(OI)(CI)F`
        : `*${userSid}:F`;
      const grantSystem = info.isDirectory()
        ? "*S-1-5-18:(OI)(CI)F"
        : "*S-1-5-18:F";

      await execFileAsync(
        "icacls.exe",
        [
          absPath,
          "/inheritance:r",
          "/grant:r",
          grantUser,
          "/grant:r",
          grantSystem
        ],
        { timeout: 10_000, windowsHide: true }
      );
      appliedPaths.push(absPath);
    }

    if (appliedPaths.length > 0) {
      await writePrivacySettings({
        ntfsHardenedAt: new Date().toISOString()
      }).catch(() => {});
    }

    return {
      supported: true,
      applied: appliedPaths.length > 0,
      paths: appliedPaths
    };
  } catch (error) {
    return {
      supported: true,
      applied: false,
      paths: appliedPaths,
      error:
        error instanceof Error
          ? error.message
          : "Falha ao aplicar permissões NTFS."
    };
  }
}

export async function getDataProtectionStatus(): Promise<DataProtectionStatus> {
  const settings = await readPrivacySettings();
  const keyFile = getVaultKeyPath();
  let vaultKeyPresent = false;
  try {
    await access(keyFile);
    vaultKeyPresent = true;
  } catch {
    vaultKeyPresent = false;
  }

  return {
    shieldMode: settings.shieldMode,
    encryptAtRest: settings.encryptAtRest,
    dpapiSupported: isDpapiSupported(),
    ntfsSupported: isNtfsSupported(),
    ...(settings.ntfsHardenedAt ? { ntfsHardenedAt: settings.ntfsHardenedAt } : {}),
    vaultKeyPresent
  };
}
