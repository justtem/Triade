import { $, PLATFORMS, SVG_ICONS, getAiBrandSvg } from "./state.js";
import { fetchJson, getStoredSessionToken } from "./api.js";

const MAX_RECORD_SECONDS = 120;
const MIN_RECORD_MS = 380;
const CANCEL_DRAG_LEFT_PX = 75;

const VOICE_CAST_STORAGE_KEY = "ai-council-voice-cast";
const VOICE_SPEED_STORAGE_KEY = "ai-council-voice-speed";
const SPEED_OPTIONS = [1, 1.25, 1.5];

export const DEFAULT_VOICE_CAST = {
  gemini: "thalita",
  groq: "antonio",
  openrouter: "francisca",
  chatgpt: "francisca",
  claude: "thalita",
  judge: "antonio"
};

export const VOICE_LABELS = {
  thalita: "Thalita (Multilíngue)",
  antonio: "Antônio (Firme)",
  francisca: "Francisca (Expressiva)"
};

// ============================================================================
// PREFERÊNCIAS DE ELENCO DE VOZES & VELOCIDADE
// ============================================================================

export function loadVoiceCast() {
  try {
    const raw = localStorage.getItem(VOICE_CAST_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_VOICE_CAST };
    const parsed = JSON.parse(raw);
    const out = { ...DEFAULT_VOICE_CAST };
    for (const key of Object.keys(DEFAULT_VOICE_CAST)) {
      const val = parsed?.[key];
      if (val === "thalita" || val === "antonio" || val === "francisca") {
        out[key] = val;
      }
    }
    return out;
  } catch {
    return { ...DEFAULT_VOICE_CAST };
  }
}

export function saveVoiceCast(cast) {
  try {
    localStorage.setItem(VOICE_CAST_STORAGE_KEY, JSON.stringify(cast));
  } catch {
    // Ignora
  }
}

function loadVoiceSpeed() {
  try {
    const val = Number(localStorage.getItem(VOICE_SPEED_STORAGE_KEY));
    if (SPEED_OPTIONS.includes(val)) return val;
  } catch {
    // Ignora
  }
  return 1;
}

function saveVoiceSpeed(speed) {
  try {
    localStorage.setItem(VOICE_SPEED_STORAGE_KEY, String(speed));
  } catch {
    // Ignora
  }
}

// ============================================================================
// LIMPEZA DE MARKDOWN PARA FALA NATURAL
// ============================================================================

export function cleanMarkdownForSpeech(rawText) {
  let text = String(rawText || "");
  if (!text.trim()) return "";

  text = text.replace(/```[\s\S]*?```/g, ". Bloco de código omitido. ");
  text = text.replace(/\[([^\]]+)\]\((?:https?:\/\/|\/)[^)]+\)/g, "$1");
  text = text.replace(/https?:\/\/\S+/gi, "");
  text = text.replace(/\[\d+\]/g, "");
  text = text
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/^[-*+]\s+/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\|/g, ", ")
    .replace(/[-=]{3,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return text;
}

export function splitSpeechChunks(text, maxLen = 220) {
  const clean = String(text || "").trim();
  if (!clean) return [];

  const sentences = clean.match(/[^.!?\n]+[.!?\n]*/g) || [clean];
  const chunks = [];
  let current = "";

  for (const rawSentence of sentences) {
    const s = rawSentence.trim();
    if (!s) continue;

    if (current.length + s.length + 1 <= maxLen) {
      current = current ? `${current} ${s}` : s;
      continue;
    }

    if (current) {
      chunks.push(current);
      current = "";
    }

    if (s.length <= maxLen) {
      current = s;
    } else {
      const words = s.split(/\s+/);
      for (const w of words) {
        if (current.length + w.length + 1 <= maxLen) {
          current = current ? `${current} ${w}` : w;
        } else {
          if (current) chunks.push(current);
          current = w;
        }
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

// ============================================================================
// MOTOR DE REPRODUÇÃO NEURAL (EDGE TTS + FILA "OUVIR CONSELHO" + MINI PLAYER)
// ============================================================================

let voiceCast = loadVoiceCast();
let playbackSpeed = loadVoiceSpeed();

let activeButton = null;
let activeSessionId = 0;
let activeAudio = null;
let activeObjectUrl = null;
let activeFetchController = null;
let activeQueue = [];
let activeQueueIndex = 0;
let prefetchedAudioByIndex = new Map();
let isUsingNativeFallback = false;

function formatAudioClock(sec) {
  const safe = Math.max(0, Math.floor(Number(sec) || 0));
  const mm = Math.floor(safe / 60);
  const ss = String(safe % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function setSpeakButtonVisual(btn, stateMode) {
  if (!btn) return;
  const isCouncilBtn = btn.classList.contains("council-podcast-btn");
  const isActive = stateMode === "playing" || stateMode === "loading";
  btn.classList.toggle("is-speaking", isActive);
  btn.setAttribute("aria-pressed", String(isActive));

  if (stateMode === "loading") {
    btn.innerHTML = `${SVG_ICONS.volume}<span>Gerando voz...</span>`;
  } else if (stateMode === "playing") {
    btn.innerHTML = `${SVG_ICONS.volumeStop}<span>Parar</span>`;
  } else {
    btn.innerHTML = isCouncilBtn
      ? `${SVG_ICONS.volume}<span>Ouvir Conselho</span>`
      : `${SVG_ICONS.volume}<span>Ouvir</span>`;
  }
}

function updateMiniPlayerUi(statusText = "") {
  const dock = $("#voice-player-dock");
  if (!dock) return;

  const track = activeQueue[activeQueueIndex];
  if (!track) {
    dock.hidden = true;
    const popover = $("#voice-cast-popover");
    if (popover) popover.hidden = true;
    return;
  }

  dock.hidden = false;
  const iconEl = $("#voice-player-icon");
  const speakerEl = $("#voice-player-speaker");
  const metaEl = $("#voice-player-meta");
  const playPauseBtn = $("#voice-player-playpause");
  const nextBtn = $("#voice-player-next");
  const speedBtn = $("#voice-player-speed");

  const personaKey = track.persona || "gemini";
  const chosenVoiceKey = voiceCast[personaKey] || DEFAULT_VOICE_CAST[personaKey] || "thalita";
  const voiceShort = VOICE_LABELS[chosenVoiceKey]?.split(" ")[0] || chosenVoiceKey;
  const queueTag =
    activeQueue.length > 1
      ? `Conselho ${activeQueueIndex + 1}/${activeQueue.length} · `
      : "";

  if (iconEl) {
    iconEl.setAttribute("data-brand", personaKey === "judge" ? "trio" : personaKey);
    iconEl.innerHTML = getAiBrandSvg(personaKey === "judge" ? "trio" : personaKey);
  }
  if (speakerEl) {
    speakerEl.textContent = track.label || PLATFORMS[personaKey] || "AI Council";
  }
  if (metaEl) {
    metaEl.textContent =
      statusText ||
      `${queueTag}Voz: ${voiceShort}${isUsingNativeFallback ? " (nativa)" : ""}`;
  }
  if (playPauseBtn) {
    const isPaused = activeAudio ? activeAudio.paused : false;
    playPauseBtn.textContent = isPaused ? "▶" : "❚❚";
    playPauseBtn.title = isPaused ? "Continuar" : "Pausar";
  }
  if (nextBtn) {
    nextBtn.hidden = activeQueue.length <= 1 || activeQueueIndex >= activeQueue.length - 1;
  }
  if (speedBtn) {
    speedBtn.textContent = `${playbackSpeed}x`;
  }
}

function updateMiniPlayerProgress() {
  const fillEl = $("#voice-player-progress-fill");
  const timeEl = $("#voice-player-time");
  if (!activeAudio) {
    if (fillEl) fillEl.style.width = "0%";
    if (timeEl) timeEl.textContent = "0:00";
    return;
  }
  const cur = Number.isFinite(activeAudio.currentTime) ? activeAudio.currentTime : 0;
  const dur = Number.isFinite(activeAudio.duration) && activeAudio.duration > 0 ? activeAudio.duration : 0;
  const pct = dur > 0 ? Math.min(100, (cur / dur) * 100) : 0;
  if (fillEl) fillEl.style.width = `${pct.toFixed(1)}%`;
  if (timeEl) {
    timeEl.textContent = dur > 0 ? `${formatAudioClock(cur)} / ${formatAudioClock(dur)}` : formatAudioClock(cur);
  }
}

function cleanupActiveAudioOnly() {
  if (activeFetchController) {
    try {
      activeFetchController.abort();
    } catch {
      // Ignora
    }
    activeFetchController = null;
  }
  if (activeAudio) {
    try {
      activeAudio.pause();
      activeAudio.removeAttribute("src");
      activeAudio.load();
    } catch {
      // Ignora
    }
    activeAudio = null;
  }
  if (activeObjectUrl) {
    try {
      URL.revokeObjectURL(activeObjectUrl);
    } catch {
      // Ignora
    }
    activeObjectUrl = null;
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // Ignora
    }
  }
}

export function stopSpeech() {
  activeSessionId += 1;
  cleanupActiveAudioOnly();
  isUsingNativeFallback = false;
  activeQueue = [];
  activeQueueIndex = 0;
  prefetchedAudioByIndex.clear();

  if (activeButton) {
    setSpeakButtonVisual(activeButton, "idle");
    activeButton = null;
  }
  updateMiniPlayerProgress();
  updateMiniPlayerUi();
}

async function fetchNeuralAudioBlob(track, signal) {
  const persona = track.persona || "gemini";
  const voiceKey = voiceCast[persona] || DEFAULT_VOICE_CAST[persona] || "thalita";
  const sessionToken = getStoredSessionToken();

  const response = await fetch("/audio/speak", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(sessionToken ? { "X-AI-Council-Session": sessionToken } : {})
    },
    body: JSON.stringify({
      text: track.text,
      persona,
      voiceKey
    }),
    signal
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return await response.blob();
}

function prefetchNextTrackInQueue(sessionId, nextIndex) {
  if (sessionId !== activeSessionId) return;
  if (nextIndex >= activeQueue.length) return;
  if (prefetchedAudioByIndex.has(nextIndex)) return;

  const nextTrack = activeQueue[nextIndex];
  if (!nextTrack) return;

  const promise = fetchNeuralAudioBlob(nextTrack).catch(() => null);
  prefetchedAudioByIndex.set(nextIndex, promise);
}

function speakWithNativeFallback(track, sessionId, onDone) {
  const supported =
    typeof window !== "undefined" &&
    "speechSynthesis" in window &&
    typeof SpeechSynthesisUtterance !== "undefined";

  if (!supported) {
    onDone();
    return;
  }

  isUsingNativeFallback = true;
  updateMiniPlayerUi();

  const spokenText = cleanMarkdownForSpeech(track.text);
  const chunks = splitSpeechChunks(spokenText);
  if (chunks.length === 0) {
    onDone();
    return;
  }

  const synth = window.speechSynthesis;
  const voices = typeof synth.getVoices === "function" ? synth.getVoices() : [];
  const ptVoice =
    voices.find((v) => /^pt[-_]BR$/i.test(v.lang)) ||
    voices.find((v) => /^pt\b/i.test(v.lang)) ||
    null;

  let idx = 0;
  const nextChunk = () => {
    if (sessionId !== activeSessionId) return;
    if (idx >= chunks.length) {
      onDone();
      return;
    }
    const utt = new SpeechSynthesisUtterance(chunks[idx]);
    utt.lang = "pt-BR";
    utt.rate = playbackSpeed;
    if (ptVoice) utt.voice = ptVoice;
    utt.onend = () => {
      if (sessionId !== activeSessionId) return;
      idx += 1;
      nextChunk();
    };
    utt.onerror = () => {
      if (sessionId !== activeSessionId) return;
      onDone();
    };
    try {
      synth.speak(utt);
    } catch {
      onDone();
    }
  };
  nextChunk();
}

async function playQueueItemAt(index, sessionId) {
  if (sessionId !== activeSessionId) return;
  if (index >= activeQueue.length) {
    stopSpeech();
    return;
  }

  cleanupActiveAudioOnly();
  isUsingNativeFallback = false;
  activeQueueIndex = index;
  const track = activeQueue[index];

  if (activeButton) {
    setSpeakButtonVisual(activeButton, "loading");
  }
  updateMiniPlayerProgress();
  updateMiniPlayerUi("Gerando voz neural...");

  // Destaca/rola suavemente para o card falante quando em modo Conselho
  if (track.cardId && activeQueue.length > 1) {
    const cardEl = document.getElementById(track.cardId);
    cardEl?.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
  }

  const advance = () => {
    if (sessionId !== activeSessionId) return;
    void playQueueItemAt(index + 1, sessionId);
  };

  try {
    let blob = null;
    if (prefetchedAudioByIndex.has(index)) {
      blob = await prefetchedAudioByIndex.get(index);
      prefetchedAudioByIndex.delete(index);
    }
    if (!blob) {
      const controller = new AbortController();
      activeFetchController = controller;
      blob = await fetchNeuralAudioBlob(track, controller.signal);
      if (activeFetchController === controller) {
        activeFetchController = null;
      }
    }

    if (sessionId !== activeSessionId) return;

    const url = URL.createObjectURL(blob);
    activeObjectUrl = url;
    const audio = new Audio(url);
    audio.playbackRate = playbackSpeed;
    activeAudio = audio;

    audio.addEventListener("timeupdate", () => {
      if (sessionId === activeSessionId) updateMiniPlayerProgress();
    });
    audio.addEventListener("loadedmetadata", () => {
      if (sessionId === activeSessionId) updateMiniPlayerProgress();
    });
    audio.addEventListener("play", () => {
      if (sessionId !== activeSessionId) return;
      if (activeButton) setSpeakButtonVisual(activeButton, "playing");
      updateMiniPlayerUi();
    });
    audio.addEventListener("pause", () => {
      if (sessionId === activeSessionId) updateMiniPlayerUi();
    });
    audio.addEventListener("ended", advance);
    audio.addEventListener("error", () => {
      if (sessionId !== activeSessionId) return;
      speakWithNativeFallback(track, sessionId, advance);
    });

    // Pré-carrega a próxima IA em segundo plano para transição sem pausa!
    prefetchNextTrackInQueue(sessionId, index + 1);

    await audio.play();
    if (activeButton && sessionId === activeSessionId) {
      setSpeakButtonVisual(activeButton, "playing");
    }
    updateMiniPlayerUi();
  } catch (err) {
    if (sessionId !== activeSessionId) return;
    if (err && err.name === "AbortError") return;
    // Fallback automático para a voz nativa do dispositivo se Edge TTS estiver indisponível
    if (activeButton) setSpeakButtonVisual(activeButton, "playing");
    speakWithNativeFallback(track, sessionId, advance);
  }
}

export function playVoiceQueue(tracks, triggerBtn = null) {
  const validTracks = (tracks || []).filter((t) => t && String(t.text || "").trim().length > 0);
  if (validTracks.length === 0) return;

  if (triggerBtn && activeButton === triggerBtn) {
    stopSpeech();
    return;
  }

  stopSpeech();
  const sessionId = activeSessionId;
  activeButton = triggerBtn;
  activeQueue = validTracks;
  activeQueueIndex = 0;

  void playQueueItemAt(0, sessionId);
}

export function createSpeakButton(rawText, extraClass = "btn-secondary", options = {}) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `${extraClass} speak-response-btn`.trim();
  const persona = options.persona || "gemini";
  const label = options.label || PLATFORMS[persona] || "AI Council";
  btn.title = `Ouvir ${label} com voz neural própria`;
  setSpeakButtonVisual(btn, "idle");

  btn.addEventListener("click", (e) => {
    e.stopPropagation();
    playVoiceQueue(
      [
        {
          persona,
          label,
          text: rawText,
          cardId: options.cardId
        }
      ],
      btn
    );
  });

  return btn;
}

export function initVoicePlayerUi() {
  const playPauseBtn = $("#voice-player-playpause");
  const nextBtn = $("#voice-player-next");
  const speedBtn = $("#voice-player-speed");
  const settingsBtn = $("#voice-player-settings");
  const closeBtn = $("#voice-player-close");
  const progressBar = $("#voice-player-progress");
  const popover = $("#voice-cast-popover");

  playPauseBtn?.addEventListener("click", () => {
    if (!activeAudio) return;
    if (activeAudio.paused) {
      void activeAudio.play();
    } else {
      activeAudio.pause();
    }
    updateMiniPlayerUi();
  });

  nextBtn?.addEventListener("click", () => {
    if (activeQueue.length > 1 && activeQueueIndex + 1 < activeQueue.length) {
      void playQueueItemAt(activeQueueIndex + 1, activeSessionId);
    }
  });

  speedBtn?.addEventListener("click", () => {
    const curIdx = SPEED_OPTIONS.indexOf(playbackSpeed);
    playbackSpeed = SPEED_OPTIONS[(curIdx + 1) % SPEED_OPTIONS.length];
    saveVoiceSpeed(playbackSpeed);
    if (activeAudio) {
      activeAudio.playbackRate = playbackSpeed;
    }
    updateMiniPlayerUi();
  });

  progressBar?.addEventListener("click", (e) => {
    if (!activeAudio || !Number.isFinite(activeAudio.duration) || activeAudio.duration <= 0) {
      return;
    }
    const rect = progressBar.getBoundingClientRect();
    if (rect.width <= 0) return;
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    activeAudio.currentTime = ratio * activeAudio.duration;
    updateMiniPlayerProgress();
  });

  closeBtn?.addEventListener("click", () => {
    stopSpeech();
  });

  // Popover de personalização das vozes de cada IA
  const syncCastSelects = () => {
    for (const key of ["gemini", "groq", "openrouter", "judge"]) {
      const sel = $(`#voice-cast-${key}`);
      if (sel) {
        sel.value = voiceCast[key] || DEFAULT_VOICE_CAST[key];
      }
    }
  };
  syncCastSelects();

  settingsBtn?.addEventListener("click", (e) => {
    e.stopPropagation();
    if (!popover) return;
    syncCastSelects();
    popover.hidden = !popover.hidden;
  });

  popover?.addEventListener("click", (e) => e.stopPropagation());

  for (const key of ["gemini", "groq", "openrouter", "judge"]) {
    const sel = $(`#voice-cast-${key}`);
    sel?.addEventListener("change", () => {
      voiceCast[key] = sel.value;
      saveVoiceCast(voiceCast);
      prefetchedAudioByIndex.clear();
      updateMiniPlayerUi();
    });
  }

  document.addEventListener("click", () => {
    if (popover && !popover.hidden) {
      popover.hidden = true;
    }
  });
}

// ============================================================================
// GRAVAÇÃO POR VOZ — SEGURAR PARA GRAVAR + GROQ WHISPER (ENVIO AUTOMÁTICO)
// ============================================================================

function pickSupportedAudioMime() {
  if (typeof MediaRecorder === "undefined" || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus"
  ];
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) {
      return mime;
    }
  }
  return "";
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const str = String(reader.result || "");
      const idx = str.indexOf(",");
      resolve(idx >= 0 ? str.slice(idx + 1) : str);
    };
    reader.onerror = () => reject(new Error("Falha ao ler áudio gravado."));
    reader.readAsDataURL(blob);
  });
}

function formatRecordClock(seconds) {
  const safe = Math.max(0, Math.floor(seconds));
  const mm = String(Math.floor(safe / 60)).padStart(2, "0");
  const ss = String(safe % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

export function initVoiceRecorder(options) {
  const { micBtn, bannerEl, timerEl, hintEl, feedbackEl, onTranscribed } = options;
  if (!micBtn) return;

  const canRecord =
    typeof navigator !== "undefined" &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    typeof MediaRecorder !== "undefined";

  if (!canRecord) {
    micBtn.title = "Gravação de voz requer navegador compatível em HTTPS ou localhost.";
    micBtn.disabled = true;
    return;
  }

  let mediaRecorder = null;
  let activeStream = null;
  let chunks = [];
  let isHolding = false;
  let isRecording = false;
  let isCancelling = false;
  let isTranscribing = false;
  let activePointerId = null;
  let startX = 0;
  let startedAtMs = 0;
  let timerInterval = null;

  const stopTracks = () => {
    if (activeStream) {
      for (const track of activeStream.getTracks()) {
        try {
          track.stop();
        } catch {
          // Ignora
        }
      }
      activeStream = null;
    }
  };

  const resetUi = () => {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
    micBtn.classList.remove("is-recording", "is-cancelling");
    micBtn.setAttribute("aria-pressed", "false");
    if (bannerEl) {
      bannerEl.hidden = true;
      bannerEl.classList.remove("is-cancelling", "is-warning");
    }
    if (timerEl) timerEl.textContent = "00:00";
    if (hintEl) hintEl.textContent = "← Arraste p/ esquerda p/ cancelar";
  };

  const setCancelVisual = (cancelling) => {
    isCancelling = cancelling;
    micBtn.classList.toggle("is-cancelling", cancelling);
    if (bannerEl) bannerEl.classList.toggle("is-cancelling", cancelling);
    if (hintEl) {
      hintEl.textContent = cancelling
        ? "Solte para cancelar"
        : "← Arraste p/ esquerda p/ cancelar";
    }
  };

  const finishRecording = (cancelled) => {
    isHolding = false;
    activePointerId = null;
    if (!isRecording || !mediaRecorder) {
      stopTracks();
      resetUi();
      return;
    }

    const elapsedMs = Date.now() - startedAtMs;
    const tooShort = !cancelled && elapsedMs < MIN_RECORD_MS;
    const finalCancelled = cancelled || tooShort;
    const recorderRef = mediaRecorder;
    const recordedMime = recorderRef.mimeType || "audio/webm";

    isRecording = false;
    mediaRecorder = null;
    resetUi();

    recorderRef.onstop = async () => {
      stopTracks();
      const recordedChunks = chunks;
      chunks = [];

      if (finalCancelled) {
        if (feedbackEl) {
          feedbackEl.textContent = tooShort
            ? "Segure o botão do microfone enquanto fala."
            : "Gravação cancelada.";
        }
        return;
      }

      const blob = new Blob(recordedChunks, { type: recordedMime });
      if (blob.size < 400) {
        if (feedbackEl) {
          feedbackEl.textContent = "Áudio muito curto. Tente novamente.";
        }
        return;
      }

      try {
        isTranscribing = true;
        micBtn.disabled = true;
        micBtn.classList.add("is-transcribing");
        if (feedbackEl) feedbackEl.textContent = "Transcrevendo voz (Groq Whisper)...";

        const audioBase64 = await blobToBase64(blob);
        const res = await fetchJson("/audio/transcribe", {
          method: "POST",
          timeoutMs: 30000,
          body: {
            audioBase64,
            mimeType: recordedMime,
            language: "pt"
          }
        });

        const text = String(res?.text || "").trim();
        if (!text) {
          if (feedbackEl) {
            feedbackEl.textContent = "Não ouvi fala clara — tente novamente.";
          }
          return;
        }

        if (feedbackEl) feedbackEl.textContent = "";
        if (typeof onTranscribed === "function") {
          onTranscribed(text);
        }
      } catch (error) {
        if (feedbackEl) {
          feedbackEl.textContent =
            error instanceof Error ? error.message : "Erro ao transcrever voz.";
        }
      } finally {
        isTranscribing = false;
        micBtn.disabled = false;
        micBtn.classList.remove("is-transcribing");
      }
    };

    try {
      if (recorderRef.state !== "inactive") {
        recorderRef.stop();
      }
    } catch {
      stopTracks();
    }
  };

  micBtn.addEventListener("contextmenu", (e) => e.preventDefault());
  micBtn.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });

  micBtn.addEventListener("pointerdown", async (e) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    if (isRecording || isTranscribing) return;

    e.preventDefault();
    stopSpeech();

    isHolding = true;
    isCancelling = false;
    activePointerId = e.pointerId;
    startX = e.clientX;

    try {
      micBtn.setPointerCapture(e.pointerId);
    } catch {
      // Ignora
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      if (!isHolding) {
        for (const t of stream.getTracks()) t.stop();
        if (feedbackEl) {
          feedbackEl.textContent = "Microfone liberado! Agora segure o botão para falar.";
        }
        return;
      }

      activeStream = stream;
      chunks = [];
      const preferredMime = pickSupportedAudioMime();
      const recorder = preferredMime
        ? new MediaRecorder(stream, { mimeType: preferredMime, audioBitsPerSecond: 48000 })
        : new MediaRecorder(stream);

      recorder.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) {
          chunks.push(ev.data);
        }
      };

      mediaRecorder = recorder;
      isRecording = true;
      startedAtMs = Date.now();

      micBtn.classList.add("is-recording");
      micBtn.setAttribute("aria-pressed", "true");
      if (bannerEl) bannerEl.hidden = false;
      if (timerEl) timerEl.textContent = "00:00";
      if (hintEl) hintEl.textContent = "← Arraste p/ esquerda p/ cancelar";
      if (feedbackEl) feedbackEl.textContent = "";

      recorder.start(250);

      timerInterval = setInterval(() => {
        const sec = (Date.now() - startedAtMs) / 1000;
        if (timerEl) timerEl.textContent = formatRecordClock(sec);
        if (bannerEl) {
          bannerEl.classList.toggle("is-warning", sec >= MAX_RECORD_SECONDS - 15);
        }
        if (sec >= MAX_RECORD_SECONDS) {
          finishRecording(false);
        }
      }, 250);
    } catch (error) {
      isHolding = false;
      activePointerId = null;
      stopTracks();
      resetUi();
      if (feedbackEl) {
        const denied =
          error && (error.name === "NotAllowedError" || error.name === "PermissionDeniedError");
        feedbackEl.textContent = denied
          ? "Permissão de microfone negada no navegador."
          : "Não foi possível acessar o microfone.";
      }
    }
  });

  micBtn.addEventListener("pointermove", (e) => {
    if (!isRecording || activePointerId !== e.pointerId) return;
    const dxLeft = startX - e.clientX;
    const shouldCancel = dxLeft > CANCEL_DRAG_LEFT_PX;
    if (shouldCancel !== isCancelling) {
      setCancelVisual(shouldCancel);
    }
  });

  micBtn.addEventListener("pointerup", (e) => {
    if (activePointerId !== null && activePointerId !== e.pointerId) return;
    finishRecording(isCancelling);
  });

  micBtn.addEventListener("pointercancel", () => {
    finishRecording(isCancelling);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isRecording) {
      finishRecording(true);
    }
  });
}
