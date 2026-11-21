import { execFile } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt
} from "node:crypto";
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

import { isLocalImageOcrSupported } from "./image-ocr.js";
import {
  normalizePrivacyShieldMode,
  type PrivacyShieldMode
} from "./privacy-shield.js";
import {
  isValidApiKeyValue,
  readEnvFileValues,
  removeEnvKeys,
  upsertEnvFile
} from "../server/env-config.js";

export const SEALED_API_ENV_KEYS = [
  "GEMINI_API_KEY",
  "GROQ_API_KEY",
  "OPENROUTER_API_KEY"
] as const;
export type SealedApiEnvKey = (typeof SEALED_API_ENV_KEYS)[number];

const execFileAsync = promisify(execFile);
const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const ENVELOPE_PREFIX = "AIC_ENC_V1:";
const KEY_BYTES = 32; // AES-256-GCM
const IV_BYTES = 12;

export type VaultMode = "off" | "dpapi" | "master_password";
export const VALID_AUTOLOCK_MINUTES = [0, 15, 30, 60] as const;

export interface PrivacySettings {
  shieldMode: PrivacyShieldMode;
  vaultMode: VaultMode;
  encryptAtRest: boolean;
  sealApiKeysInVault: boolean;
  vaultAutoLockMinutes: number;
  ntfsHardenedAt?: string;
  updatedAt: string;
}

interface MasterVaultMeta {
  version: 1;
  kdf: "scrypt";
  kdfParams: { N: number; r: number; p: number };
  passwordSaltB64: string;
  wrappedDekByPassword: string;
  recoverySaltB64: string;
  wrappedDekByRecovery: string;
  createdAt: string;
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
  vaultMode: VaultMode;
  encryptAtRest: boolean;
  apiKeysSealed: boolean;
  apiKeysLoadedInRam: boolean;
  vaultLocked: boolean;
  vaultAutoLockMinutes: number;
  dpapiSupported: boolean;
  ntfsSupported: boolean;
  ocrSupported: boolean;
  ntfsHardenedAt?: string;
  vaultKeyPresent: boolean;
}

type KeyCodec = {
  protect: (plainKey: Buffer) => Promise<Buffer>;
  unprotect: (protectedKey: Buffer) => Promise<Buffer>;
};

const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 32 chars sem O/0/I/1
const SCRYPT_N = 32768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

let customKeyCodecForTests: KeyCodec | null = null;
let cachedSettings: { dir: string; settings: PrivacySettings } | null = null;
let cachedVaultKey: { dir: string; key: Buffer } | null = null;
let lastVaultActivityMs = Date.now();
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

function getMasterVaultMetaPath(dataDir = getDataDir()): string {
  return resolve(dataDir, ".vault.meta.json");
}

function getSecretsVaultPath(dataDir = getDataDir()): string {
  return resolve(dataDir, ".secrets.vault");
}

/** Permite injetar codec DPAPI determinístico em testes unitários sem abrir PowerShell. */
export function setVaultKeyCodecForTests(codec: KeyCodec | null): void {
  customKeyCodecForTests = codec;
  resetDataProtectionCache();
}

export function resetDataProtectionCache(): void {
  if (cachedVaultKey) {
    cachedVaultKey.key.fill(0);
    cachedVaultKey = null;
  }
  cachedSettings = null;
  lastVaultActivityMs = Date.now();
}

export function isDpapiSupported(): boolean {
  return process.platform === "win32" || customKeyCodecForTests !== null;
}

export function isNtfsSupported(): boolean {
  return process.platform === "win32";
}

function normalizeAutoLockMinutes(value: unknown): number {
  const num = Number(value);
  if (num === 0 || num === 15 || num === 30 || num === 60) {
    return num;
  }
  return 30;
}

function normalizeVaultMode(
  rawMode: unknown,
  legacyEncryptAtRest: unknown
): VaultMode {
  if (rawMode === "off" || rawMode === "dpapi" || rawMode === "master_password") {
    return rawMode;
  }
  return legacyEncryptAtRest === true ? "dpapi" : "off";
}

function defaultPrivacySettings(): PrivacySettings {
  return {
    shieldMode: "strict",
    vaultMode: "off",
    encryptAtRest: false,
    sealApiKeysInVault: false,
    vaultAutoLockMinutes: 30,
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
    const vaultMode = normalizeVaultMode(parsed.vaultMode, parsed.encryptAtRest);
    const settings: PrivacySettings = {
      shieldMode: normalizePrivacyShieldMode(parsed.shieldMode),
      vaultMode,
      encryptAtRest: vaultMode !== "off",
      sealApiKeysInVault: vaultMode !== "off" && Boolean(parsed.sealApiKeysInVault),
      vaultAutoLockMinutes: normalizeAutoLockMinutes(parsed.vaultAutoLockMinutes),
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
  patch: Partial<
    Pick<
      PrivacySettings,
      | "shieldMode"
      | "vaultMode"
      | "encryptAtRest"
      | "sealApiKeysInVault"
      | "vaultAutoLockMinutes"
      | "ntfsHardenedAt"
    >
  >
): Promise<PrivacySettings> {
  const dir = getDataDir();
  const current = await readPrivacySettings();
  const nextVaultMode: VaultMode =
    patch.vaultMode !== undefined
      ? normalizeVaultMode(patch.vaultMode, false)
      : patch.encryptAtRest !== undefined
        ? patch.encryptAtRest
          ? current.vaultMode === "master_password"
            ? "master_password"
            : "dpapi"
          : "off"
        : current.vaultMode;

  const next: PrivacySettings = {
    ...current,
    ...(patch.shieldMode !== undefined
      ? { shieldMode: normalizePrivacyShieldMode(patch.shieldMode) }
      : {}),
    vaultMode: nextVaultMode,
    encryptAtRest: nextVaultMode !== "off",
    sealApiKeysInVault:
      nextVaultMode === "off"
        ? false
        : patch.sealApiKeysInVault !== undefined
          ? Boolean(patch.sealApiKeysInVault)
          : current.sealApiKeysInVault,
    ...(patch.vaultAutoLockMinutes !== undefined
      ? { vaultAutoLockMinutes: normalizeAutoLockMinutes(patch.vaultAutoLockMinutes) }
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
// DERIVACAO DE CHAVE (scrypt) + CHAVE DE RECUPERACAO + AUTO-LOCK EM RAM
// ============================================================================

async function deriveKekWithScrypt(
  secret: string,
  salt: Buffer,
  params = { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }
): Promise<Buffer> {
  const secretBuf = Buffer.from(secret, "utf8");
  try {
    return await new Promise<Buffer>((resolvePromise, rejectPromise) => {
      scrypt(
        secretBuf,
        salt,
        KEY_BYTES,
        {
          N: params.N,
          r: params.r,
          p: params.p,
          maxmem: 128 * 1024 * 1024
        },
        (err, derived) => {
          if (err) {
            rejectPromise(err);
            return;
          }
          resolvePromise(derived);
        }
      );
    });
  } finally {
    secretBuf.fill(0);
  }
}

export function generateRecoveryKey(): string {
  const bytes = randomBytes(24);
  let chars = "";
  for (let i = 0; i < 24; i++) {
    chars += RECOVERY_ALPHABET[bytes[i]! % RECOVERY_ALPHABET.length];
  }
  return chars.match(/.{1,4}/g)!.join("-");
}

function normalizeRecoveryKeyInput(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .trim();
}

export function clearSealedApiKeysFromRam(): void {
  if (cachedSettings?.settings.sealApiKeysInVault) {
    for (const envKey of SEALED_API_ENV_KEYS) {
      delete process.env[envKey];
    }
  }
}

export function lockMasterVault(): void {
  if (cachedVaultKey) {
    cachedVaultKey.key.fill(0);
    cachedVaultKey = null;
  }
  clearSealedApiKeysFromRam();
}

export function touchVaultActivity(nowMs = Date.now()): void {
  lastVaultActivityMs = nowMs;
}

/**
 * Verifica se o cofre de Senha Mestra está trancado (também aplica auto-lock por inatividade).
 */
export async function isVaultLocked(nowMs = Date.now()): Promise<boolean> {
  const settings = await readPrivacySettings();
  if (settings.vaultMode !== "master_password") {
    return false;
  }
  const dir = getDataDir();
  if (!cachedVaultKey || cachedVaultKey.dir !== dir) {
    return true;
  }
  if (
    settings.vaultAutoLockMinutes > 0 &&
    nowMs - lastVaultActivityMs >= settings.vaultAutoLockMinutes * 60_000
  ) {
    lockMasterVault();
    return true;
  }
  return false;
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

async function saveDpapiVaultKey(plainKey: Buffer): Promise<void> {
  const dir = getDataDir();
  const keyFile = getVaultKeyPath(dir);
  const wrapped = await protectKeyWithWindowsDpapi(plainKey);
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
}

async function getOrCreateVaultKey(createIfMissing: boolean): Promise<Buffer> {
  const dir = getDataDir();
  const settings = await readPrivacySettings();

  if (settings.vaultMode === "master_password") {
    if (await isVaultLocked()) {
      throw new Error(
        "Cofre local trancado. Digite sua Senha Mestra para acessar os dados locais."
      );
    }
    touchVaultActivity();
    return cachedVaultKey!.key;
  }

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
    await saveDpapiVaultKey(freshKey);
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
  await maybeAdd(resolve(dataDir, "templates.json"));
  await maybeAdd(resolve(dataDir, "monitor-events.json"));

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

async function migrateDataFiles(
  dataDir: string,
  encrypt: boolean,
  key: Buffer | null
): Promise<number> {
  const targets = await listMigratableDataFiles(dataDir);
  let migratedFiles = 0;

  for (const filePath of targets) {
    const raw = await readFile(filePath, "utf8");
    const alreadyEncrypted = isEncryptedEnvelope(raw);

    if (encrypt && !alreadyEncrypted && key) {
      const next = encryptTextWithKey(raw, key);
      const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
      try {
        await writeFile(tmp, next, { encoding: "utf8", mode: 0o600 });
        await rename(tmp, filePath);
        migratedFiles++;
      } finally {
        await rm(tmp, { force: true }).catch(() => {});
      }
    } else if (!encrypt && alreadyEncrypted) {
      if (!key) {
        throw new Error(
          "Chave local ausente ou cofre trancado; destranque o cofre antes de desativar a criptografia."
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

  return migratedFiles;
}

/**
 * Configura (ou atualiza) o modo Cofre com Senha Mestra (`scrypt` + `AES-256-GCM` Envelope Encryption).
 * - Gera uma Chave de Recuperação única (24 chars) exibida uma única vez.
 * - Remove `.vault.key` (DPAPI) para que nenhum processo da sessão consiga abrir os dados sem a senha.
 * - Migra todos os arquivos existentes em `data/` sem perder nada.
 */
export async function setupMasterPasswordVault(
  rawMasterPassword: string,
  autoLockMinutes?: number
): Promise<{
  recoveryKey: string;
  migratedFiles: number;
  settings: PrivacySettings;
}> {
  const masterPassword = rawMasterPassword.trim();
  if (masterPassword.length < 10) {
    throw new Error("A Senha Mestra deve ter pelo menos 10 caracteres.");
  }

  const dataDir = getDataDir();
  const current = await readPrivacySettings();

  if (current.vaultMode === "master_password" && (await isVaultLocked())) {
    throw new Error("Destranque o cofre atual antes de alterar a Senha Mestra.");
  }

  // Reutiliza a DEK atual (se já estava cifrado com DPAPI ou Senha Mestra) ou cria uma nova de 256 bits
  let dek: Buffer;
  if (current.vaultMode === "master_password" && cachedVaultKey?.dir === dataDir) {
    dek = Buffer.from(cachedVaultKey.key);
  } else if (current.vaultMode === "dpapi") {
    dek = Buffer.from(await getOrCreateVaultKey(true));
  } else {
    dek = randomBytes(KEY_BYTES);
  }

  const recoveryKey = generateRecoveryKey();
  const passwordSalt = randomBytes(32);
  const recoverySalt = randomBytes(32);
  const dekHex = dek.toString("hex");

  const passKek = await deriveKekWithScrypt(masterPassword, passwordSalt);
  const wrappedDekByPassword = encryptTextWithKey(dekHex, passKek);
  passKek.fill(0);

  const recKek = await deriveKekWithScrypt(
    normalizeRecoveryKeyInput(recoveryKey),
    recoverySalt
  );
  const wrappedDekByRecovery = encryptTextWithKey(dekHex, recKek);
  recKek.fill(0);

  const now = new Date().toISOString();
  const meta: MasterVaultMeta = {
    version: 1,
    kdf: "scrypt",
    kdfParams: { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P },
    passwordSaltB64: passwordSalt.toString("base64"),
    wrappedDekByPassword,
    recoverySaltB64: recoverySalt.toString("base64"),
    wrappedDekByRecovery,
    createdAt: now,
    updatedAt: now
  };

  const metaPath = getMasterVaultMetaPath(dataDir);
  await mkdir(dirname(metaPath), { recursive: true });
  const tmp = `${metaPath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(meta, null, 2), {
    encoding: "utf8",
    mode: 0o600
  });
  await rename(tmp, metaPath);

  if (process.platform === "win32" && !customKeyCodecForTests) {
    await applyNtfsOwnerOnlyPermissions([metaPath]).catch(() => {});
  }

  // Remove a cópia DPAPI antiga para impedir que malware na sessão abra o cofre sem a Senha Mestra
  await rm(getVaultKeyPath(dataDir), { force: true }).catch(() => {});

  // Mantém a DEK ativa em RAM na sessão atual e migra arquivos não cifrados
  if (cachedVaultKey) cachedVaultKey.key.fill(0);
  cachedVaultKey = { dir: dataDir, key: dek };
  touchVaultActivity();

  const migratedFiles = await migrateDataFiles(dataDir, true, dek);
  const settings = await writePrivacySettings({
    vaultMode: "master_password",
    encryptAtRest: true,
    ...(autoLockMinutes !== undefined
      ? { vaultAutoLockMinutes: normalizeAutoLockMinutes(autoLockMinutes) }
      : {})
  });

  return { recoveryKey, migratedFiles, settings };
}

/**
 * Destranca o Cofre de Senha Mestra em memória RAM usando a Senha Mestra ou a Chave de Recuperação.
 */
export async function unlockMasterVault(
  rawSecret: string,
  options: { isRecovery?: boolean } = {}
): Promise<{ unlocked: boolean; usedRecovery: boolean }> {
  const secret = (rawSecret ?? "").trim();
  if (!secret) {
    throw new Error("Informe a Senha Mestra ou Chave de Recuperação.");
  }

  const dataDir = getDataDir();
  const metaPath = getMasterVaultMetaPath(dataDir);
  let meta: MasterVaultMeta;
  try {
    meta = JSON.parse(await readFile(metaPath, "utf8")) as MasterVaultMeta;
  } catch {
    throw new Error("Metadados do cofre (.vault.meta.json) não encontrados.");
  }

  const params = meta.kdfParams ?? { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P };

  const tryDecryptDek = async (
    candidate: string,
    saltB64: string,
    wrappedEnvelope: string
  ): Promise<Buffer | null> => {
    const salt = Buffer.from(saltB64, "base64");
    const kek = await deriveKekWithScrypt(candidate, salt, params);
    try {
      const dekHex = decryptTextWithKey(wrappedEnvelope, kek);
      const dek = Buffer.from(dekHex, "hex");
      return dek.byteLength === KEY_BYTES ? dek : null;
    } catch {
      return null;
    } finally {
      kek.fill(0);
    }
  };

  let dek: Buffer | null = null;
  let usedRecovery = false;

  if (!options.isRecovery) {
    dek = await tryDecryptDek(secret, meta.passwordSaltB64, meta.wrappedDekByPassword);
  }

  if (!dek) {
    const normRec = normalizeRecoveryKeyInput(secret);
    if (normRec.length >= 16) {
      dek = await tryDecryptDek(
        normRec,
        meta.recoverySaltB64,
        meta.wrappedDekByRecovery
      );
      if (dek) usedRecovery = true;
    }
  }

  if (!dek) {
    throw new Error("Senha Mestra ou Chave de Recuperação incorreta.");
  }

  if (cachedVaultKey) cachedVaultKey.key.fill(0);
  cachedVaultKey = { dir: dataDir, key: dek };
  touchVaultActivity();
  // Garante migração silenciosa de novos arquivos suportados (ex.: templates.json / monitor-events.json)
  await migrateDataFiles(dataDir, true, dek).catch(() => {});
  return { unlocked: true, usedRecovery };
}

/**
 * Alterna para o modo "off" (JSON legível) ou "dpapi" (1-clique Windows).
 * Se estiver em `master_password`, exige que o cofre esteja destrancado antes da migração.
 * Ao desativar (`off`), se as chaves de API estiverem seladas em `.secrets.vault`,
 * restaura automaticamente essas chaves de volta para o `.env` para nunca perdê-las.
 */
export async function setVaultModeOffOrDpapi(
  targetMode: "off" | "dpapi",
  options: { envPath?: string } = {}
): Promise<{ settings: PrivacySettings; migratedFiles: number }> {
  if (targetMode === "dpapi" && !isDpapiSupported()) {
    throw new Error(
      "Criptografia automática via DPAPI está disponível apenas no Windows. Em Linux/macOS, use o modo Senha Mestra ou criptografia de disco (LUKS / FileVault)."
    );
  }

  const dataDir = getDataDir();
  const current = await readPrivacySettings();

  if (current.vaultMode === "master_password" && (await isVaultLocked())) {
    throw new Error(
      "Destranque o cofre com sua Senha Mestra antes de alterar o modo de proteção."
    );
  }

  let migratedFiles = 0;

  if (targetMode === "dpapi") {
    let key: Buffer;
    if (current.vaultMode === "master_password" && cachedVaultKey?.dir === dataDir) {
      key = Buffer.from(cachedVaultKey.key);
      await saveDpapiVaultKey(key);
      await rm(getMasterVaultMetaPath(dataDir), { force: true }).catch(() => {});
    } else {
      key = await getOrCreateVaultKey(true);
    }
    if (cachedVaultKey) cachedVaultKey.key.fill(0);
    cachedVaultKey = { dir: dataDir, key };
    migratedFiles = await migrateDataFiles(dataDir, true, key);
  } else {
    // targetMode === "off": restaura chaves de API seladas para o .env antes de desligar o cofre
    if (current.sealApiKeysInVault && options.envPath) {
      await unsealApiKeysToEnv(options.envPath);
    }
    const key =
      current.vaultMode === "master_password"
        ? cachedVaultKey?.dir === dataDir
          ? cachedVaultKey.key
          : null
        : await getOrCreateVaultKey(false).catch(() => null);
    migratedFiles = await migrateDataFiles(dataDir, false, key);
    await rm(getMasterVaultMetaPath(dataDir), { force: true }).catch(() => {});
    lockMasterVault();
  }

  const settings = await writePrivacySettings({
    vaultMode: targetMode,
    encryptAtRest: targetMode !== "off"
  });
  return { settings, migratedFiles };
}

// ============================================================================
// COFRE DE CHAVES DE API (.secrets.vault) — NÃO ALTERA ACCESS_PASSWORD / MONITOR_TOKEN
// ============================================================================

interface SealedSecretsBundle {
  version: 1;
  keys: Partial<Record<SealedApiEnvKey, string>>;
  sealedAt: string;
}

/**
 * Sela GEMINI_API_KEY, GROQ_API_KEY e OPENROUTER_API_KEY dentro de `data/.secrets.vault`
 * (cifrado com AES-256-GCM pela mesma DEK do cofre) e remove apenas essas 3 chaves do `.env`.
 */
export async function sealApiKeysIntoVault(
  envPath: string,
  overrideKeys?: Partial<Record<SealedApiEnvKey, string>>
): Promise<{ sealed: true; keysCount: number; settings: PrivacySettings }> {
  const settings = await readPrivacySettings();
  if (settings.vaultMode === "off") {
    throw new Error(
      "Ative primeiro o Cofre em repouso (DPAPI ou Senha Mestra) antes de selar as chaves de API."
    );
  }
  if (await isVaultLocked()) {
    throw new Error("Destranque o cofre antes de selar as chaves de API.");
  }

  const envFileVals = await readEnvFileValues(envPath);
  const collected: Partial<Record<SealedApiEnvKey, string>> = {};

  for (const keyName of SEALED_API_ENV_KEYS) {
    const candidate =
      overrideKeys?.[keyName] ?? process.env[keyName] ?? envFileVals[keyName];
    if (isValidApiKeyValue(candidate)) {
      collected[keyName] = candidate.trim();
    }
  }

  const keysCount = Object.keys(collected).length;
  if (keysCount === 0) {
    throw new Error(
      "Nenhuma chave de API válida encontrada para selar no cofre."
    );
  }

  const dek = await getOrCreateVaultKey(true);
  const bundle: SealedSecretsBundle = {
    version: 1,
    keys: collected,
    sealedAt: new Date().toISOString()
  };

  const vaultFile = getSecretsVaultPath();
  await mkdir(dirname(vaultFile), { recursive: true });
  const encrypted = encryptTextWithKey(JSON.stringify(bundle), dek);
  const tmp = `${vaultFile}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, encrypted, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, vaultFile);

  if (process.platform === "win32" && !customKeyCodecForTests) {
    await applyNtfsOwnerOnlyPermissions([vaultFile]).catch(() => {});
  }

  // Remove SOMENTE as 3 chaves de IA do .env (preserva ACCESS_PASSWORD, MONITOR_TOKEN e comentários)
  await removeEnvKeys(envPath, [...SEALED_API_ENV_KEYS]);

  // Mantém em memória RAM na sessão destrancada atual
  for (const [k, v] of Object.entries(collected)) {
    if (v) process.env[k] = v;
  }

  const nextSettings = await writePrivacySettings({ sealApiKeysInVault: true });
  return { sealed: true, keysCount, settings: nextSettings };
}

/**
 * Descriptografa `data/.secrets.vault` (se existir) e carrega as chaves de API apenas na RAM (`process.env`).
 */
export async function loadSealedApiKeysIntoRam(): Promise<{ loadedCount: number }> {
  const settings = await readPrivacySettings();
  if (!settings.sealApiKeysInVault || settings.vaultMode === "off") {
    return { loadedCount: 0 };
  }
  if (await isVaultLocked()) {
    return { loadedCount: 0 };
  }

  const vaultFile = getSecretsVaultPath();
  let raw: string;
  try {
    raw = await readFile(vaultFile, "utf8");
  } catch {
    return { loadedCount: 0 };
  }

  const dek = await getOrCreateVaultKey(false);
  const plain = decryptTextWithKey(raw, dek);
  const parsed = JSON.parse(plain) as Partial<SealedSecretsBundle>;
  let loadedCount = 0;

  if (parsed.keys && typeof parsed.keys === "object") {
    for (const keyName of SEALED_API_ENV_KEYS) {
      const val = parsed.keys[keyName];
      if (isValidApiKeyValue(val)) {
        process.env[keyName] = val.trim();
        loadedCount++;
      }
    }
  }
  return { loadedCount };
}

/**
 * Restaura as chaves de API seladas de `data/.secrets.vault` de volta para o `.env`
 * e remove o arquivo `.secrets.vault`, sem tocar em ACCESS_PASSWORD nem MONITOR_TOKEN.
 */
export async function unsealApiKeysToEnv(
  envPath: string
): Promise<{ sealed: false; keysCount: number; settings: PrivacySettings }> {
  const current = await readPrivacySettings();
  if (current.vaultMode === "master_password" && (await isVaultLocked())) {
    throw new Error("Destranque o cofre antes de restaurar as chaves para o .env.");
  }

  const vaultFile = getSecretsVaultPath();
  const keysToRestore: Record<string, string> = {};

  try {
    const raw = await readFile(vaultFile, "utf8");
    const dek = await getOrCreateVaultKey(false);
    const plain = decryptTextWithKey(raw, dek);
    const parsed = JSON.parse(plain) as Partial<SealedSecretsBundle>;
    if (parsed.keys && typeof parsed.keys === "object") {
      for (const keyName of SEALED_API_ENV_KEYS) {
        const val = parsed.keys[keyName];
        if (isValidApiKeyValue(val)) {
          keysToRestore[keyName] = val.trim();
        }
      }
    }
  } catch {
    // Fallback para as chaves atualmente carregadas em RAM
    for (const keyName of SEALED_API_ENV_KEYS) {
      const val = process.env[keyName];
      if (isValidApiKeyValue(val)) {
        keysToRestore[keyName] = val.trim();
      }
    }
  }

  const keysCount = Object.keys(keysToRestore).length;
  if (keysCount > 0) {
    await upsertEnvFile(envPath, keysToRestore);
    for (const [k, v] of Object.entries(keysToRestore)) {
      process.env[k] = v;
    }
  }

  await rm(vaultFile, { force: true }).catch(() => {});
  const nextSettings = await writePrivacySettings({ sealApiKeysInVault: false });
  return { sealed: false, keysCount, settings: nextSettings };
}

/** Compatibilidade com chamadas legadas (`true` -> `dpapi`, `false` -> `off`). */
export async function setEncryptAtRestEnabled(
  enabled: boolean
): Promise<{ settings: PrivacySettings; migratedFiles: number }> {
  return setVaultModeOffOrDpapi(enabled ? "dpapi" : "off");
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
  const dir = getDataDir();
  let vaultKeyPresent = false;
  for (const candidate of [getVaultKeyPath(dir), getMasterVaultMetaPath(dir)]) {
    try {
      await access(candidate);
      vaultKeyPresent = true;
      break;
    } catch {
      // Continua
    }
  }

  const apiKeysLoadedInRam = SEALED_API_ENV_KEYS.some((k) =>
    isValidApiKeyValue(process.env[k])
  );

  return {
    shieldMode: settings.shieldMode,
    vaultMode: settings.vaultMode,
    encryptAtRest: settings.encryptAtRest,
    apiKeysSealed: settings.sealApiKeysInVault,
    apiKeysLoadedInRam,
    vaultLocked: await isVaultLocked(),
    vaultAutoLockMinutes: settings.vaultAutoLockMinutes,
    dpapiSupported: isDpapiSupported(),
    ntfsSupported: isNtfsSupported(),
    ocrSupported: isLocalImageOcrSupported(),
    ...(settings.ntfsHardenedAt ? { ntfsHardenedAt: settings.ntfsHardenedAt } : {}),
    vaultKeyPresent
  };
}
