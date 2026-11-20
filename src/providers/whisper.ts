const GROQ_TRANSCRIPTION_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions";

const DEFAULT_WHISPER_MODELS = [
  "whisper-large-v3-turbo",
  "whisper-large-v3"
] as const;

const MAX_AUDIO_BYTES = 8 * 1024 * 1024; // 8 MB (~2+ min de Opus/MP4)

const MIME_TO_EXT: Record<string, string> = {
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/flac": "flac"
};

export interface TranscribeAudioInput {
  audioBase64: string;
  mimeType?: string;
  language?: string;
}

export interface TranscribeAudioResult {
  text: string;
  model: string;
}

export function normalizeAudioMimeType(raw?: string): {
  mimeType: string;
  extension: string;
} {
  const base = (raw ?? "audio/webm").split(";")[0]?.trim().toLowerCase() ?? "audio/webm";
  const ext = MIME_TO_EXT[base];
  if (ext) {
    return { mimeType: base, extension: ext };
  }
  return { mimeType: "audio/webm", extension: "webm" };
}

/**
 * Transcreve áudio gratuitamente via Groq Whisper (`whisper-large-v3-turbo`
 * com fallback automático para `whisper-large-v3`).
 */
export async function transcribeAudioWithGroq(
  input: TranscribeAudioInput
): Promise<TranscribeAudioResult> {
  const apiKey = process.env.GROQ_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "GROQ_API_KEY não configurada no .env — necessária para transcrição por voz."
    );
  }

  const rawBase64 = String(input.audioBase64 ?? "")
    .replace(/^data:[^;]+;base64,/i, "")
    .trim();

  if (!rawBase64) {
    throw new Error("Áudio vazio.");
  }

  const audioBuffer = Buffer.from(rawBase64, "base64");
  if (audioBuffer.byteLength < 400) {
    throw new Error("Gravação curta demais. Segure o botão enquanto fala.");
  }
  if (audioBuffer.byteLength > MAX_AUDIO_BYTES) {
    throw new Error("Áudio muito grande (máximo 8 MB / 2 minutos).");
  }

  const { mimeType, extension } = normalizeAudioMimeType(input.mimeType);
  const language = (input.language ?? "pt").trim().slice(0, 8) || "pt";

  const models = process.env.GROQ_WHISPER_MODEL?.trim()
    ? [process.env.GROQ_WHISPER_MODEL.trim(), ...DEFAULT_WHISPER_MODELS]
    : [...DEFAULT_WHISPER_MODELS];

  const uniqueModels = Array.from(new Set(models));
  let lastError = "Falha ao transcrever áudio no Groq Whisper.";

  for (const model of uniqueModels) {
    try {
      const form = new FormData();
      const blob = new Blob([audioBuffer], { type: mimeType });
      form.append("file", blob, `voice.${extension}`);
      form.append("model", model);
      form.append("language", language);
      form.append("response_format", "json");
      form.append("temperature", "0");

      const response = await fetch(GROQ_TRANSCRIPTION_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`
        },
        body: form,
        signal: AbortSignal.timeout(25_000)
      });

      const rawBody = await response.text();
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error("GROQ_API_KEY inválida ou sem permissão para Whisper.");
        }
        if (response.status === 429) {
          lastError = "Limite temporário do Groq Whisper atingido (429). Tente em alguns segundos.";
          continue;
        }
        lastError = `Groq Whisper retornou HTTP ${response.status}: ${rawBody.slice(0, 140)}`;
        continue;
      }

      let parsedText = "";
      try {
        const json = JSON.parse(rawBody) as { text?: unknown };
        parsedText = typeof json.text === "string" ? json.text : "";
      } catch {
        parsedText = rawBody;
      }

      const cleanText = parsedText.replace(/\s+/g, " ").trim();
      return { text: cleanText, model };
    } catch (error) {
      if (
        error instanceof Error &&
        /GROQ_API_KEY inválida/i.test(error.message)
      ) {
        throw error;
      }
      lastError =
        error instanceof Error ? error.message : "Erro de rede ao contatar Groq Whisper.";
    }
  }

  throw new Error(lastError);
}
