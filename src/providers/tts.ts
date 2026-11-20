import { createHash } from "node:crypto";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";

export type VoicePersona =
  | "gemini"
  | "groq"
  | "openrouter"
  | "chatgpt"
  | "claude"
  | "judge";

export type VoiceKey = "thalita" | "antonio" | "francisca";

export interface VoiceCatalogEntry {
  key: VoiceKey;
  edgeVoice: string;
  label: string;
  description: string;
}

export const VOICE_CATALOG: Record<VoiceKey, VoiceCatalogEntry> = {
  thalita: {
    key: "thalita",
    edgeVoice: "pt-BR-ThalitaMultilingualNeural",
    label: "Thalita (Multilíngue)",
    description: "Feminina moderna — pronuncia termos técnicos em inglês com naturalidade"
  },
  antonio: {
    key: "antonio",
    edgeVoice: "pt-BR-AntonioNeural",
    label: "Antônio (Firme)",
    description: "Masculina clara, objetiva e articulada em português do Brasil"
  },
  francisca: {
    key: "francisca",
    edgeVoice: "pt-BR-FranciscaNeural",
    label: "Francisca (Expressiva)",
    description: "Feminina suave, natural e fluida em português do Brasil"
  }
};

export interface PersonaVoiceProfile {
  voiceKey: VoiceKey;
  rate: string;
  pitch: string;
  roleHint: string;
}

export const DEFAULT_PERSONA_PROFILES: Record<VoicePersona, PersonaVoiceProfile> = {
  gemini: {
    voiceKey: "thalita",
    rate: "+0%",
    pitch: "+0Hz",
    roleHint: "Arquiteta técnica"
  },
  groq: {
    voiceKey: "antonio",
    rate: "+6%",
    pitch: "+0Hz",
    roleHint: "Revisor ágil"
  },
  openrouter: {
    voiceKey: "francisca",
    rate: "+0%",
    pitch: "+0Hz",
    roleHint: "Voz alternativa"
  },
  chatgpt: {
    voiceKey: "francisca",
    rate: "+2%",
    pitch: "+2Hz",
    roleHint: "Autor alternativo"
  },
  claude: {
    voiceKey: "thalita",
    rate: "-2%",
    pitch: "-2Hz",
    roleHint: "Analista ponderada"
  },
  judge: {
    voiceKey: "antonio",
    rate: "-2%",
    pitch: "-4Hz",
    roleHint: "Juiz do Conselho"
  }
};

const MAX_SPEECH_CHARS = 3_500;
const MAX_CACHE_ENTRIES = 25;
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos

interface CachedAudio {
  buffer: Buffer;
  voice: string;
  expiresAt: number;
}

const audioCache = new Map<string, CachedAudio>();

function pruneCache(): void {
  const now = Date.now();
  for (const [k, entry] of audioCache.entries()) {
    if (entry.expiresAt <= now) {
      audioCache.delete(k);
    }
  }
  while (audioCache.size > MAX_CACHE_ENTRIES) {
    const oldestKey = audioCache.keys().next().value;
    if (oldestKey === undefined) break;
    audioCache.delete(oldestKey);
  }
}

export function normalizePersona(raw?: string): VoicePersona {
  const clean = (raw ?? "").toLowerCase().trim();
  if (
    clean === "gemini" ||
    clean === "groq" ||
    clean === "openrouter" ||
    clean === "chatgpt" ||
    clean === "claude" ||
    clean === "judge"
  ) {
    return clean;
  }
  return "gemini";
}

export function normalizeVoiceKey(raw?: string): VoiceKey | undefined {
  const clean = (raw ?? "").toLowerCase().trim();
  if (clean === "thalita" || clean === "antonio" || clean === "francisca") {
    return clean;
  }
  return undefined;
}

/** Limpa Markdown/código e trunca de forma natural em fim de frase até maxChars. */
export function sanitizeTextForNeuralSpeech(
  rawText: string,
  maxChars = MAX_SPEECH_CHARS
): string {
  let text = String(rawText ?? "");
  if (!text.trim()) return "";

  text = text
    .replace(/```[\s\S]*?```/g, ". Bloco de código omitido. ")
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|\/)[^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\[\d+\]/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\|/g, ", ")
    .replace(/[-=]{3,}/g, " ")
    // Evita caracteres que quebram SSML interno do Edge TTS
    .replace(/[<>&]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (text.length <= maxChars) return text;

  const sliced = text.slice(0, maxChars);
  const lastSentenceEnd = Math.max(
    sliced.lastIndexOf(". "),
    sliced.lastIndexOf("! "),
    sliced.lastIndexOf("? ")
  );
  if (lastSentenceEnd > maxChars * 0.65) {
    return `${sliced.slice(0, lastSentenceEnd + 1).trim()} Continuação resumida no texto.`;
  }
  return `${sliced.trim()}...`;
}

export function resolvePersonaVoiceConfig(
  personaRaw?: string,
  overrideVoiceKeyRaw?: string
): {
  persona: VoicePersona;
  voiceKey: VoiceKey;
  edgeVoice: string;
  rate: string;
  pitch: string;
} {
  const persona = normalizePersona(personaRaw);
  const profile = DEFAULT_PERSONA_PROFILES[persona];
  const overrideKey = normalizeVoiceKey(overrideVoiceKeyRaw);
  const voiceKey = overrideKey ?? profile.voiceKey;
  const edgeVoice = VOICE_CATALOG[voiceKey].edgeVoice;

  return {
    persona,
    voiceKey,
    edgeVoice,
    rate: profile.rate,
    pitch: profile.pitch
  };
}

export interface SynthesizeSpeechResult {
  audioBuffer: Buffer;
  contentType: "audio/mpeg";
  voice: string;
  persona: VoicePersona;
  cached: boolean;
}

/**
 * Gera MP3 neural gratuito via Microsoft Edge Neural TTS,
 * respeitando a personalidade vocal de cada IA e usando cache LRU em memória.
 */
export async function synthesizeSpeechWithEdge(input: {
  text: string;
  persona?: string;
  voiceKey?: string;
}): Promise<SynthesizeSpeechResult> {
  const cleanText = sanitizeTextForNeuralSpeech(input.text);
  if (!cleanText) {
    throw new Error("Texto vazio para leitura em voz alta.");
  }

  const cfg = resolvePersonaVoiceConfig(input.persona, input.voiceKey);
  const cacheKey = createHash("sha256")
    .update(`${cfg.edgeVoice}|${cfg.rate}|${cfg.pitch}|${cleanText}`)
    .digest("hex");

  pruneCache();
  const hit = audioCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) {
    // Atualiza ordem LRU
    audioCache.delete(cacheKey);
    audioCache.set(cacheKey, hit);
    return {
      audioBuffer: hit.buffer,
      contentType: "audio/mpeg",
      voice: hit.voice,
      persona: cfg.persona,
      cached: true
    };
  }

  const tts = new MsEdgeTTS();
  let timeoutId: NodeJS.Timeout | undefined;

  try {
    const synthesisPromise = (async () => {
      await tts.setMetadata(
        cfg.edgeVoice,
        OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
      );
      const { audioStream } = tts.toStream(cleanText, {
        rate: cfg.rate,
        pitch: cfg.pitch
      });
      const chunks: Buffer[] = [];
      for await (const chunk of audioStream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks);
    })();

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeoutId = setTimeout(() => {
        try {
          tts.close();
        } catch {
          // Ignora
        }
        reject(new Error("Tempo limite excedido ao gerar voz neural."));
      }, 22_000);
    });

    const audioBuffer = await Promise.race([synthesisPromise, timeoutPromise]);
    if (audioBuffer.byteLength < 100) {
      throw new Error("Áudio neural retornou vazio.");
    }

    audioCache.set(cacheKey, {
      buffer: audioBuffer,
      voice: cfg.edgeVoice,
      expiresAt: Date.now() + CACHE_TTL_MS
    });
    pruneCache();

    return {
      audioBuffer,
      contentType: "audio/mpeg",
      voice: cfg.edgeVoice,
      persona: cfg.persona,
      cached: false
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    try {
      tts.close();
    } catch {
      // Ignora
    }
  }
}
