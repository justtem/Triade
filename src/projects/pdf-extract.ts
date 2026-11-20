import { extractText } from "unpdf";

const MAX_EXTRACTED_PDF_CHARS = 350_000;

/**
 * Extrai texto plano de um buffer PDF usando unpdf (ESM puro, sem dependências nativas).
 * Normaliza espaços excessivos e protege contra PDFs gigantes ou escaneados.
 */
export async function extractPdfTextFromBuffer(
  buffer: Buffer | Uint8Array
): Promise<string> {
  const bytes =
    buffer instanceof Uint8Array
      ? new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      : new Uint8Array(buffer);

  if (bytes.byteLength === 0) {
    return "";
  }

  const result = await extractText(bytes, { mergePages: true });
  const rawText = Array.isArray(result.text)
    ? result.text.join("\n\n")
    : typeof result.text === "string"
      ? result.text
      : "";

  return rawText
    .replace(/\0/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, MAX_EXTRACTED_PDF_CHARS);
}
