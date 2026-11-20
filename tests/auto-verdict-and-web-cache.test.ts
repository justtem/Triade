import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_VERDICT_MIN_QUOTA_RATIO,
  shouldTriggerAutoVerdict
} from "../src/debate/verdict.js";
import {
  clearWebCache,
  fetchPageContent,
  getWebCacheStats,
  normalizeSearchCacheKey,
  performWebSearch,
  WEB_CACHE_TTL_MS
} from "../src/web/web-context.js";
import type { ChatTurn, DebateResponse, DebateSession } from "../src/shared/debate-types.js";

function makeSessionAndTurn(overrides: {
  sessionStatus?: DebateSession["status"];
  autoVerdict?: boolean;
  turnStatus?: ChatTurn["status"];
  interactionMode?: ChatTurn["interactionMode"];
  hasExistingVerdict?: boolean;
  responses?: Array<Partial<DebateResponse> & { platform: DebateResponse["platform"] }>;
}): { session: DebateSession; turn: ChatTurn } {
  const turn: ChatTurn = {
    id: "turn_1",
    index: 1,
    prompt: "Qual banco usar?",
    rules: "",
    participants: ["gemini", "groq"],
    responseMode: "normal",
    interactionMode: overrides.interactionMode ?? "direct",
    totalRounds: 1,
    focus: "geral",
    currentRound: 1,
    currentStage: "completed",
    status: overrides.turnStatus ?? "completed",
    ...(overrides.autoVerdict ? { autoVerdict: true } : {}),
    ...(overrides.hasExistingVerdict
      ? {
          verdict: {
            judgePlatform: "gemini",
            winner: "gemini",
            winnerReason: "ok",
            consensus: ["a"],
            divergences: ["b"],
            practicalSummary: "c",
            generatedAt: new Date().toISOString()
          }
        }
      : {}),
    createdAt: new Date().toISOString()
  };

  const responses: DebateResponse[] = (overrides.responses ?? []).map((r, i) => ({
    id: `resp_${i}`,
    turnId: "turn_1",
    taskId: `task_${i}`,
    round: 1,
    stage: r.stage ?? "initial_response",
    platform: r.platform,
    promptUsed: "p",
    content: r.content ?? "Resposta completa da IA.",
    submittedAt: new Date().toISOString(),
    ...(r.interrupted ? { interrupted: true } : {})
  }));

  const session: DebateSession = {
    id: "deb_1",
    title: "Teste",
    topic: "Qual banco usar?",
    rules: "",
    participants: ["gemini", "groq"],
    totalRounds: 1,
    currentRound: 1,
    currentStage: "completed",
    status: overrides.sessionStatus ?? "completed",
    participantStates: {} as DebateSession["participantStates"],
    tasks: [],
    responses,
    turns: [turn],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    engineVersion: 2
  };

  return { session, turn };
}

describe("Prioridade #4 — Veredito Automático & Cache TTL 15 min na Busca Web", () => {
  it("shouldTriggerAutoVerdict respeita opt-in, mínimo de 2 IAs e bloqueia turnos interrompidos", () => {
    assert.equal(AUTO_VERDICT_MIN_QUOTA_RATIO, 0.15);

    // 1. Desligado por padrão
    const offCase = makeSessionAndTurn({
      autoVerdict: false,
      responses: [{ platform: "gemini" }, { platform: "groq" }]
    });
    assert.equal(shouldTriggerAutoVerdict(offCase.session, offCase.turn), false);

    // 2. Ligado, mas apenas 1 IA respondeu
    const singleCase = makeSessionAndTurn({
      autoVerdict: true,
      responses: [{ platform: "gemini" }]
    });
    assert.equal(shouldTriggerAutoVerdict(singleCase.session, singleCase.turn), false);

    // 3. Ligado, mas uma resposta foi interrompida pelo usuário (botão Parar)
    const stoppedCase = makeSessionAndTurn({
      autoVerdict: true,
      responses: [
        { platform: "gemini" },
        { platform: "groq", interrupted: true }
      ]
    });
    assert.equal(shouldTriggerAutoVerdict(stoppedCase.session, stoppedCase.turn), false);

    // 4. Já possui veredito
    const alreadyDone = makeSessionAndTurn({
      autoVerdict: true,
      hasExistingVerdict: true,
      responses: [{ platform: "gemini" }, { platform: "groq" }]
    });
    assert.equal(shouldTriggerAutoVerdict(alreadyDone.session, alreadyDone.turn), false);

    // 5. Turno Direto completo com 2+ IAs -> dispara
    const directOk = makeSessionAndTurn({
      autoVerdict: true,
      interactionMode: "direct",
      responses: [{ platform: "gemini" }, { platform: "groq" }]
    });
    assert.equal(shouldTriggerAutoVerdict(directOk.session, directOk.turn), true);

    // 6. Turno Debate completo com 2+ IAs -> também dispara
    const debateOk = makeSessionAndTurn({
      autoVerdict: true,
      interactionMode: "debate",
      responses: [{ platform: "gemini" }, { platform: "openrouter" }]
    });
    assert.equal(shouldTriggerAutoVerdict(debateOk.session, debateOk.turn), true);
  });

  it("normalizeSearchCacheKey normaliza acentos, maiúsculas e espaços extras", () => {
    assert.equal(
      normalizeSearchCacheKey("  Cotação   do  Dólar Hoje "),
      normalizeSearchCacheKey("cotacao do dolar hoje")
    );
  });

  it("cache TTL de 15 min reutiliza buscas normalizadas, não cacheia vazios e expira após 15 min", async () => {
    clearWebCache();
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;

    const ddgHtmlOk = `
      <div class="result__body">
        <a class="result__a" href="https://example.org/guia">Guia Oficial</a>
        <a class="result__snippet">Resumo atualizado do guia oficial.</a>
      </div></div>
    `;

    globalThis.fetch = (async (input: string | URL | Request) => {
      fetchCalls++;
      const urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (urlStr.includes("empty-query-test")) {
        return new Response("<html><body>Sem resultados</body></html>", {
          status: 200,
          headers: { "content-type": "text/html" }
        });
      }
      return new Response(ddgHtmlOk, {
        status: 200,
        headers: { "content-type": "text/html" }
      });
    }) as typeof fetch;

    try {
      const t0 = 1_700_000_000_000;

      // 1ª busca -> miss + cacheia
      const hits1 = await performWebSearch("Arquitetura NodeJS", { nowMs: t0 });
      assert.equal(hits1.length, 1);
      assert.equal(fetchCalls, 1);

      // 2ª busca (mesma query com acento/caixa/espaços diferentes dentro de 15 min) -> HIT sem fetch
      const hits2 = await performWebSearch("  ARQUITETURA   nodejs  ", {
        nowMs: t0 + 5 * 60 * 1000
      });
      assert.equal(hits2.length, 1);
      assert.equal(fetchCalls, 1);
      assert.equal(getWebCacheStats().searchHits, 1);

      // 3ª busca após expirar 15 min -> MISS e refaz fetch
      const hits3 = await performWebSearch("arquitetura nodejs", {
        nowMs: t0 + WEB_CACHE_TTL_MS + 1_000
      });
      assert.equal(hits3.length, 1);
      assert.equal(fetchCalls, 2);

      // Resultado vazio NÃO deve ser cacheado
      const beforeEmpty = getWebCacheStats().searchEntries;
      const emptyHits = await performWebSearch("empty-query-test", { nowMs: t0 });
      assert.equal(emptyHits.length, 0);
      assert.equal(getWebCacheStats().searchEntries, beforeEmpty);
    } finally {
      globalThis.fetch = originalFetch;
      clearWebCache();
    }
  });

  it("fetchPageContent cacheia páginas públicas por 15 min e ignora falhas HTTP", async () => {
    clearWebCache();
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;

    globalThis.fetch = (async (input: string | URL | Request) => {
      fetchCalls++;
      const urlStr = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (urlStr.includes("/fail")) {
        return new Response("Erro interno", { status: 500 });
      }
      return new Response(
        `<html><head><title>Doc Oficial</title></head><body><main>${"Conteudo tecnico detalhado sobre cache HTTP. ".repeat(15)}</main></body></html>`,
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" }
        }
      );
    }) as typeof fetch;

    try {
      const t0 = 1_700_000_000_000;
      const publicLookup = async () => [{ address: "93.184.216.34" }];
      const page1 = await fetchPageContent("https://example.org/docs", 4_000, 1_500, {
        nowMs: t0,
        lookupFn: publicLookup
      });
      assert.equal(page1.ok, true);
      assert.equal(page1.title, "Doc Oficial");
      assert.equal(fetchCalls, 1);

      // 2ª leitura dentro de 15 min com limite menor -> HIT sem novo fetch e respeita slice
      const page2 = await fetchPageContent("https://example.org/docs", 4_000, 120, {
        nowMs: t0 + 10 * 60 * 1000,
        lookupFn: publicLookup
      });
      assert.equal(page2.ok, true);
      assert.equal(fetchCalls, 1);
      assert.ok(page2.excerpt.length <= 120);
      assert.equal(getWebCacheStats().pageHits, 1);

      // Após 15 min -> expira e refaz fetch
      const page3 = await fetchPageContent("https://example.org/docs", 4_000, 1_500, {
        nowMs: t0 + WEB_CACHE_TTL_MS + 500,
        lookupFn: publicLookup
      });
      assert.equal(page3.ok, true);
      assert.equal(fetchCalls, 2);

      // Falha HTTP 500 não entra no cache
      const entriesBeforeFail = getWebCacheStats().pageEntries;
      const failPage = await fetchPageContent("https://example.org/fail", 4_000, 1_500, {
        nowMs: t0,
        lookupFn: publicLookup
      });
      assert.equal(failPage.ok, false);
      assert.equal(getWebCacheStats().pageEntries, entriesBeforeFail);
    } finally {
      globalThis.fetch = originalFetch;
      clearWebCache();
    }
  });
});
