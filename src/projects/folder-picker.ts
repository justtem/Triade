import { execFile } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { inspectLinkedFolder, type FolderInspectionResult } from "./project-rag.js";

const execFileAsync = promisify(execFile);

const WINDOWS_RESERVED_NAMES = new Set([
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

const FORBIDDEN_SUBFOLDER_NAMES = new Set([
  ".git",
  ".env",
  "node_modules",
  ".ssh",
  ".gnupg"
]);

const SUBFOLDER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,63}$/;

export interface PickFolderResult {
  cancelled: boolean;
  path?: string;
  inspection?: FolderInspectionResult;
}

export interface CreateSubfolderResult {
  created: boolean;
  alreadyExisted: boolean;
  path: string;
  inspection: FolderInspectionResult;
}

export function validateSubfolderName(rawName: string): {
  valid: boolean;
  cleanName?: string;
  error?: string;
} {
  const cleanName = String(rawName || "").trim();
  if (!cleanName) {
    return { valid: false, error: "Informe um nome para a nova pasta." };
  }
  if (cleanName.length > 64) {
    return { valid: false, error: "Nome da pasta muito longo (máximo 64 caracteres)." };
  }
  if (
    cleanName.includes("/") ||
    cleanName.includes("\\") ||
    cleanName.includes("..") ||
    cleanName.endsWith(".")
  ) {
    return {
      valid: false,
      error: "Nome inválido. Use apenas letras, números, espaços, ponto, hífen ou underscore."
    };
  }
  if (!SUBFOLDER_NAME_RE.test(cleanName)) {
    return {
      valid: false,
      error: "Use apenas letras, números, espaços, ponto, hífen ou underscore (começando por letra ou número)."
    };
  }
  const lower = cleanName.toLowerCase();
  const baseBeforeDot = lower.split(".")[0] ?? lower;
  if (
    WINDOWS_RESERVED_NAMES.has(baseBeforeDot) ||
    FORBIDDEN_SUBFOLDER_NAMES.has(lower) ||
    lower.startsWith(".env")
  ) {
    return { valid: false, error: "Este nome de pasta é reservado ou bloqueado por segurança." };
  }
  return { valid: true, cleanName };
}

function buildWindowsFolderPickerScript(): string {
  return [
    "$ErrorActionPreference = 'Stop'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    "Add-Type -AssemblyName System.Windows.Forms",
    "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog",
    "$dialog.Description = 'Escolha a pasta do projeto para o AI Council'",
    "$dialog.ShowNewFolderButton = $true",
    "$initialDir = $env:AIC_PICK_INITIAL_DIR",
    "if ($initialDir -and (Test-Path -LiteralPath $initialDir -PathType Container)) {",
    "  $dialog.SelectedPath = $initialDir",
    "}",
    "$owner = New-Object System.Windows.Forms.Form",
    "$owner.TopMost = $true",
    "$owner.StartPosition = 'Manual'",
    "$owner.Location = New-Object System.Drawing.Point(-32000, -32000)",
    "$owner.Size = New-Object System.Drawing.Size(1, 1)",
    "$owner.ShowInTaskbar = $false",
    "$owner.Show()",
    "$owner.Activate()",
    "try {",
    "  $result = $dialog.ShowDialog($owner)",
    "  if ($result -eq [System.Windows.Forms.DialogResult]::OK -and $dialog.SelectedPath) {",
    "    [Console]::Out.Write($dialog.SelectedPath)",
    "  }",
    "} finally {",
    "  $owner.Close()",
    "  $owner.Dispose()",
    "  $dialog.Dispose()",
    "}"
  ].join("\n");
}

export async function pickLocalFolderDialog(
  initialPath?: string
): Promise<PickFolderResult> {
  if (process.platform !== "win32") {
    throw new Error(
      "O seletor nativo de pastas está disponível apenas no Windows. Cole o caminho manualmente."
    );
  }

  let safeInitialDir = "";
  const trimmedInitial = typeof initialPath === "string" ? initialPath.trim() : "";
  if (trimmedInitial && isAbsolute(trimmedInitial)) {
    try {
      const info = await stat(trimmedInitial);
      if (info.isDirectory()) {
        safeInitialDir = await realpath(trimmedInitial);
      }
    } catch {
      safeInitialDir = "";
    }
  }

  const encodedScript = Buffer.from(
    buildWindowsFolderPickerScript(),
    "utf16le"
  ).toString("base64");

  const { stdout } = await execFileAsync(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-EncodedCommand",
      encodedScript
    ],
    {
      timeout: 120_000,
      maxBuffer: 256 * 1024,
      windowsHide: true,
      env: {
        ...process.env,
        AIC_PICK_INITIAL_DIR: safeInitialDir
      }
    }
  );

  const selectedPath = String(stdout || "").trim();
  if (!selectedPath) {
    return { cancelled: true };
  }

  const inspection = await inspectLinkedFolder(selectedPath);
  return {
    cancelled: false,
    path: selectedPath,
    inspection
  };
}

export async function createSubfolderInParent(
  parentPath: string,
  folderName: string
): Promise<CreateSubfolderResult> {
  const cleanParent = String(parentPath || "").trim();
  if (!cleanParent || !isAbsolute(cleanParent)) {
    throw new Error("Escolha primeiro uma pasta base válida no PC.");
  }

  const nameCheck = validateSubfolderName(folderName);
  if (!nameCheck.valid || !nameCheck.cleanName) {
    throw new Error(nameCheck.error || "Nome da nova pasta inválido.");
  }

  // Reaproveita todas as travas de diretório do sistema/sensível de inspectLinkedFolder
  const parentInspection = await inspectLinkedFolder(cleanParent);
  if (!parentInspection.valid) {
    throw new Error(
      parentInspection.error || "A pasta base selecionada não pode ser usada."
    );
  }

  const realParent = await realpath(cleanParent);
  const parentPrefix = realParent.endsWith(sep) ? realParent : `${realParent}${sep}`;
  const targetPath = resolve(realParent, nameCheck.cleanName);

  const normalizedPrefix =
    process.platform === "win32" ? parentPrefix.toLowerCase() : parentPrefix;
  const normalizedTarget =
    process.platform === "win32" ? targetPath.toLowerCase() : targetPath;

  if (!normalizedTarget.startsWith(normalizedPrefix)) {
    throw new Error("Caminho de destino fora da pasta base (bloqueado por segurança).");
  }

  let alreadyExisted = false;
  try {
    const existing = await stat(targetPath);
    if (!existing.isDirectory()) {
      throw new Error("Já existe um arquivo com esse nome na pasta escolhida.");
    }
    alreadyExisted = true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      throw err;
    }
    await mkdir(targetPath, { recursive: false });
  }

  const realTarget = await realpath(targetPath);
  const inspection = await inspectLinkedFolder(realTarget);
  return {
    created: !alreadyExisted,
    alreadyExisted,
    path: realTarget,
    inspection
  };
}
