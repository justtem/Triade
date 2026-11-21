import type { AIPlatform } from "./debate-types.js";

export interface ProviderContextBudget {
  historyChars: number;
  attachmentChars: number;
  webContextChars: number;
  projectContextChars: number;
  userMemoryChars: number;
  memorySummaryChars: number;
  turnUserChars: number;
  turnAssistantChars: number;
  critiquePeerChars: number;
  synthesisPeerChars: number;
  maxRecentTurns: number;
  maxTokens: {
    initial_response: number;
    critique: number;
    synthesis: number;
  };
}

/** Quantos turnos recentes ficam na íntegra antes de serem compactados na Memória Compartilhada. */
export const RECENT_FULL_TURNS = 3;

const GEMINI_BUDGET: ProviderContextBudget = {
  historyChars: 32_000,
  attachmentChars: 28_000,
  webContextChars: 7_500,
  projectContextChars: 28_000,
  userMemoryChars: 1_800,
  memorySummaryChars: 3_200,
  turnUserChars: 2_800,
  turnAssistantChars: 7_500,
  critiquePeerChars: 11_000,
  synthesisPeerChars: 15_000,
  maxRecentTurns: 8,
  maxTokens: {
    initial_response: 6000,
    critique: 4000,
    synthesis: 8000
  }
};

const HIGH_CONTEXT_BUDGET: ProviderContextBudget = {
  historyChars: 24_000,
  attachmentChars: 22_000,
  webContextChars: 6_500,
  projectContextChars: 20_000,
  userMemoryChars: 1_500,
  memorySummaryChars: 2_600,
  turnUserChars: 2_200,
  turnAssistantChars: 6_000,
  critiquePeerChars: 8_500,
  synthesisPeerChars: 11_000,
  maxRecentTurns: 6,
  maxTokens: {
    initial_response: 4800,
    critique: 3600,
    synthesis: 6400
  }
};

// Groq gratuito (8.000 TPM -> 7.200 efetivo): recebe a mesma Memória Compartilhada +
// últimos turnos unificados em versão enxuta para acompanhar Gemini e OpenRouter sem estourar o TPM.
const GROQ_FREE_BUDGET: ProviderContextBudget = {
  historyChars: 7_500,
  attachmentChars: 4_500,
  webContextChars: 2_200,
  projectContextChars: 3_600,
  userMemoryChars: 650,
  memorySummaryChars: 2_000,
  turnUserChars: 750,
  turnAssistantChars: 1_500,
  critiquePeerChars: 2_400,
  synthesisPeerChars: 3_200,
  maxRecentTurns: 3,
  maxTokens: {
    initial_response: 1600,
    critique: 1500,
    synthesis: 2000
  }
};

export function budgetForPlatform(platform: AIPlatform): ProviderContextBudget {
  if (platform === "gemini") {
    return GEMINI_BUDGET;
  }

  if (platform === "groq") {
    const groqTpm = Number(process.env.GROQ_TPM);
    if (Number.isFinite(groqTpm) && groqTpm >= 30_000) {
      return HIGH_CONTEXT_BUDGET;
    }
    return GROQ_FREE_BUDGET;
  }

  return HIGH_CONTEXT_BUDGET;
}
