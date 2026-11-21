import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ChatAttachment } from "../shared/debate-types.js";
import {
  scanAndRedactText,
  type PrivacyFindingSummary,
  type PrivacyShieldMode
} from "./privacy-shield.js";

export interface OcrWordBox {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImageOcrResult {
  supported: boolean;
  text: string;
  words: OcrWordBox[];
  width: number;
  height: number;
  error?: string;
}

export interface SensitiveImageBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface ImagePrivacyScanResult {
  attachmentName: string;
  ocrSupported: boolean;
  hasFindings: boolean;
  findings: PrivacyFindingSummary[];
  sensitiveBoxes: SensitiveImageBox[];
  imageWidth: number;
  imageHeight: number;
}

type ImageOcrRunner = (
  imageBuffer: Buffer,
  mimeType: string
) => Promise<ImageOcrResult>;

let customOcrRunnerForTests: ImageOcrRunner | null = null;

export function setImageOcrRunnerForTests(runner: ImageOcrRunner | null): void {
  customOcrRunnerForTests = runner;
}

export function isLocalImageOcrSupported(): boolean {
  return process.platform === "win32" || customOcrRunnerForTests !== null;
}

const WINDOWS_WINRT_OCR_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Storage.StorageFile,Windows.Storage,ContentType=WindowsRuntime]
[void][Windows.Storage.FileAccessMode,Windows.Storage,ContentType=WindowsRuntime]
[void][Windows.Graphics.Imaging.BitmapDecoder,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
[void][Windows.Graphics.Imaging.SoftwareBitmap,Windows.Graphics.Imaging,ContentType=WindowsRuntime]
[void][Windows.Media.Ocr.OcrEngine,Windows.Media.Ocr,ContentType=WindowsRuntime]
[void][Windows.Media.Ocr.OcrResult,Windows.Media.Ocr,ContentType=WindowsRuntime]

$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
})[0]

function Await-WinRT($WinRtTask, $ResultType) {
  $netTask = $asTaskGeneric.MakeGenericMethod($ResultType).Invoke($null, @($WinRtTask))
  $netTask.Wait(10000) | Out-Null
  return $netTask.Result
}

$imgPath = $env:AIC_OCR_FILE
if (-not $imgPath -or -not (Test-Path -LiteralPath $imgPath)) {
  Write-Output '{"supported":true,"text":"","words":[],"width":0,"height":0}'
  exit 0
}

$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) {
  $langs = [Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages
  if ($langs -and $langs.Count -gt 0) {
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($langs[0])
  }
}
if ($null -eq $engine) {
  Write-Output '{"supported":false,"text":"","words":[],"width":0,"height":0,"error":"Nenhum idioma de OCR instalado no Windows."}'
  exit 0
}

$file = Await-WinRT ([Windows.Storage.StorageFile]::GetFileFromPathAsync($imgPath)) ([Windows.Storage.StorageFile])
$stream = Await-WinRT ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
try {
  $decoder = Await-WinRT ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await-WinRT ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $ocrRes = Await-WinRT ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $wordsList = New-Object System.Collections.ArrayList
  foreach ($line in $ocrRes.Lines) {
    foreach ($w in $line.Words) {
      $r = $w.BoundingRect
      [void]$wordsList.Add(@{
        text = [string]$w.Text
        x = [Math]::Round($r.X)
        y = [Math]::Round($r.Y)
        width = [Math]::Round($r.Width)
        height = [Math]::Round($r.Height)
      })
    }
  }
  $out = @{
    supported = $true
    text = [string]$ocrRes.Text
    words = @($wordsList)
    width = [int]$bitmap.PixelWidth
    height = [int]$bitmap.PixelHeight
  }
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output ($out | ConvertTo-Json -Compress -Depth 5)
} finally {
  $stream.Dispose()
}
`;

function extensionForMime(mimeType: string): string {
  const lower = (mimeType || "").toLowerCase();
  if (lower.includes("png")) return ".png";
  if (lower.includes("webp")) return ".webp";
  if (lower.includes("gif")) return ".gif";
  return ".jpg";
}

async function runWindowsNativeOcr(
  imageBuffer: Buffer,
  mimeType: string
): Promise<ImageOcrResult> {
  if (process.platform !== "win32") {
    return { supported: false, text: "", words: [], width: 0, height: 0 };
  }

  const tempPath = join(
    tmpdir(),
    `aic-ocr-${process.pid}-${randomUUID()}${extensionForMime(mimeType)}`
  );

  try {
    await writeFile(tempPath, imageBuffer, { mode: 0o600 });

    const encodedCommand = Buffer.from(WINDOWS_WINRT_OCR_SCRIPT, "utf16le").toString(
      "base64"
    );

    const stdout = await new Promise<string>((resolvePromise, rejectPromise) => {
      execFile(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
          encodedCommand
        ],
        {
          timeout: 15_000,
          maxBuffer: 2 * 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, AIC_OCR_FILE: tempPath }
        },
        (error, out, err) => {
          if (error) {
            rejectPromise(new Error(err?.trim() || error.message));
            return;
          }
          resolvePromise(String(out ?? "").trim());
        }
      );
    });

    const jsonLine = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{"))
      .pop();

    if (!jsonLine) {
      return { supported: true, text: "", words: [], width: 0, height: 0 };
    }

    const parsed = JSON.parse(jsonLine) as Partial<ImageOcrResult>;
    const rawWords = Array.isArray(parsed.words) ? parsed.words : [];
    const words: OcrWordBox[] = rawWords
      .filter(
        (w): w is OcrWordBox =>
          Boolean(w) &&
          typeof w.text === "string" &&
          typeof w.x === "number" &&
          typeof w.y === "number" &&
          typeof w.width === "number" &&
          typeof w.height === "number"
      )
      .map((w) => ({
        text: w.text,
        x: Math.max(0, Math.round(w.x)),
        y: Math.max(0, Math.round(w.y)),
        width: Math.max(1, Math.round(w.width)),
        height: Math.max(1, Math.round(w.height))
      }));

    return {
      supported: parsed.supported !== false,
      text: typeof parsed.text === "string" ? parsed.text : "",
      words,
      width: typeof parsed.width === "number" ? parsed.width : 0,
      height: typeof parsed.height === "number" ? parsed.height : 0,
      ...(typeof parsed.error === "string" ? { error: parsed.error } : {})
    };
  } catch (error) {
    return {
      supported: true,
      text: "",
      words: [],
      width: 0,
      height: 0,
      error: error instanceof Error ? error.message : "Erro no OCR local."
    };
  } finally {
    await rm(tempPath, { force: true }).catch(() => {});
  }
}

export async function extractTextFromImageBuffer(
  imageBuffer: Buffer,
  mimeType = "image/png"
): Promise<ImageOcrResult> {
  if (customOcrRunnerForTests) {
    return customOcrRunnerForTests(imageBuffer, mimeType);
  }
  return runWindowsNativeOcr(imageBuffer, mimeType);
}

/**
 * Mapeia quais palavras do OCR pertencem a trechos sensíveis detectados pelo Escudo,
 * comparando o texto original das palavras contra o texto mascarado.
 */
function findSensitiveBoxesFromWords(
  words: OcrWordBox[],
  mode: PrivacyShieldMode,
  imageWidth: number,
  imageHeight: number
): SensitiveImageBox[] {
  if (words.length === 0 || mode === "off") return [];

  const sensitiveIndices = new Set<number>();
  const joined = words.map((w) => w.text).join(" ");

  // 1. Checa cada palavra isoladamente
  for (let i = 0; i < words.length; i++) {
    const single = scanAndRedactText(words[i]!.text, mode);
    if (single.hasFindings) {
      sensitiveIndices.add(i);
    }
  }

  // 2. Checa janelas de 2 a 6 palavras adjacentes (captura cartões com espaço, telefones "(11) 98765-4321", "senha: valor")
  const maxWin = Math.min(6, words.length);
  for (let winSize = 2; winSize <= maxWin; winSize++) {
    for (let start = 0; start <= words.length - winSize; start++) {
      const sliceWords = words.slice(start, start + winSize);
      const snippet = sliceWords.map((w) => w.text).join(" ");
      const scan = scanAndRedactText(snippet, mode);
      if (!scan.hasFindings) continue;

      // Descobre exatamente quais palavras da janela foram alteradas no texto mascarado
      const redactedTokens = scan.redactedText.split(/\s+/);
      const origTokens = sliceWords.map((w) => w.text);
      let markedAny = false;
      for (let k = 0; k < origTokens.length; k++) {
        if (redactedTokens[k] !== origTokens[k]) {
          sensitiveIndices.add(start + k);
          markedAny = true;
        }
      }
      if (!markedAny) {
        for (let k = 0; k < origTokens.length; k++) {
          sensitiveIndices.add(start + k);
        }
      }
    }
  }

  // Fallback caso o texto completo tenha achado algo que não casou na janela (ex: bloco PEM longo)
  if (sensitiveIndices.size === 0 && scanAndRedactText(joined, mode).hasFindings) {
    for (let i = 0; i < words.length; i++) {
      sensitiveIndices.add(i);
    }
  }

  const pad = 6;
  const boxes: SensitiveImageBox[] = [];
  for (const idx of sensitiveIndices) {
    const w = words[idx];
    if (!w) continue;
    const x = Math.max(0, w.x - pad);
    const y = Math.max(0, w.y - pad);
    const maxW = imageWidth > 0 ? imageWidth - x : w.width + pad * 2;
    const maxH = imageHeight > 0 ? imageHeight - y : w.height + pad * 2;
    boxes.push({
      x,
      y,
      width: Math.max(12, Math.min(maxW, w.width + pad * 2)),
      height: Math.max(12, Math.min(maxH, w.height + pad * 2))
    });
  }

  return boxes;
}

/**
 * Executa OCR 100% local em um anexo de imagem e verifica dados sensíveis pelo Escudo de Privacidade.
 */
export async function scanImageAttachmentForPrivacy(
  attachment: ChatAttachment,
  mode: PrivacyShieldMode
): Promise<ImagePrivacyScanResult> {
  const baseResult: ImagePrivacyScanResult = {
    attachmentName: attachment.name || "imagem",
    ocrSupported: isLocalImageOcrSupported(),
    hasFindings: false,
    findings: [],
    sensitiveBoxes: [],
    imageWidth: 0,
    imageHeight: 0
  };

  if (
    mode === "off" ||
    attachment.kind !== "image" ||
    !attachment.dataBase64 ||
    !isLocalImageOcrSupported()
  ) {
    return baseResult;
  }

  const cleanB64 = attachment.dataBase64.replace(/^data:[^;]+;base64,/i, "").trim();
  if (!cleanB64) return baseResult;

  const buffer = Buffer.from(cleanB64, "base64");
  if (buffer.byteLength === 0) return baseResult;

  const ocr = await extractTextFromImageBuffer(
    buffer,
    attachment.mimeType || "image/png"
  );

  const combinedText =
    ocr.words.length > 0
      ? ocr.words.map((w) => w.text).join(" ")
      : ocr.text;

  if (!combinedText.trim()) {
    return {
      ...baseResult,
      ocrSupported: ocr.supported,
      imageWidth: ocr.width,
      imageHeight: ocr.height
    };
  }

  const scan = scanAndRedactText(combinedText, mode);
  if (!scan.hasFindings) {
    return {
      ...baseResult,
      ocrSupported: ocr.supported,
      imageWidth: ocr.width,
      imageHeight: ocr.height
    };
  }

  const sensitiveBoxes = findSensitiveBoxesFromWords(
    ocr.words,
    mode,
    ocr.width,
    ocr.height
  );

  return {
    attachmentName: attachment.name || "imagem",
    ocrSupported: ocr.supported,
    hasFindings: true,
    findings: scan.findings,
    sensitiveBoxes,
    imageWidth: ocr.width,
    imageHeight: ocr.height
  };
}
