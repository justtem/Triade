import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveAutoComposerStrategy,
  resolveAutoRoute
} from "../src/debate/auto-router.js";
import type { ProviderStatus } from "../src/providers/registry.js";
import type { AutoPlatform } from "../src/shared/debate-types.js";

function makeProviderStatus(
  id: AutoPlatform,
  overrides: {
    ready?: boolean;
    requestsToday?: number;
    requestsDailyCap?: number;
    tokensToday?: number;
    tokensDailyCap?: number | null;
  } = {}
): ProviderStatus {
  const ready = overrides.ready ?? true;
  return {
    id,
    name: id,
    mode: "api",
    configured: ready,
    ready,
    model: `${id}-test-model`,
    detail: "test",
    usage: {
      requestsLastMinute: 0,
      rpmLimit: 10,
      tokensLastMinute: 0,
      tpmLimit: 100_000,
      requestsToday: overrides.requestsToday ?? 0,
      requestsDailyCap: overrides.requestsDailyCap ?? 100,
      tokensToday: overrides.tokensToday ?? 0,
      tokensDailyCap: overrides.tokensDailyCap ?? null,
      safeCapRatio: 0.9,
      dailyResetAt: "2026-11-21T00:00:00Z"
    }
  };
}

function allHealthy(): ProviderStatus[] {
  return [
    makeProviderStatus("gemini", { requestsToday: 5, requestsDailyCap: 100 }),
    makeProviderStatus("groq", { requestsToday: 20, requestsDailyCap: 900 }),
    makeProviderStatus("openrouter", { requestsToday: 2, requestsDailyCap: 45 })
  ];
}

describe("auto-router (Modo Auto 0ms)", () => {
  it("roteia pergunta direta curta para Groq quando saudável", () => {
    const decision = resolveAutoRoute(
      {
        prompt: "Qual a capital da Finlândia?",
        responseMode: "normal",
        interactionMode: "direct"
      },
      allHealthy()
    );

    assert.deepEqual(decision.participants, ["groq"]);
    assert.equal(decision.category, "quick");
  });

  it("roteia PDF simples para Gemini e PDF com pedido de análise crítica/auditoria (e texto extraível) para o Trio", () => {
    const simpleDecision = resolveAutoRoute(
      {
        prompt: "Resuma este relatório",
        responseMode: "normal",
        interactionMode: "direct",
        attachments: [
          {
            name: "relatorio.pdf",
            kind: "pdf",
            mimeType: "application/pdf",
            size: 12000,
            content: "Relatório trimestral de vendas.",
            dataBase64: "JVBERi0xLjQ="
          }
        ]
      },
      allHealthy()
    );

    assert.deepEqual(simpleDecision.participants, ["gemini"]);
    assert.equal(simpleDecision.category, "pdf");

    const criticalDecision = resolveAutoRoute(
      {
        prompt: "Faça uma auditoria de segurança e compare os riscos desse contrato",
        responseMode: "normal",
        interactionMode: "direct",
        attachments: [
          {
            name: "contrato.pdf",
            kind: "pdf",
            mimeType: "application/pdf",
            size: 18000,
            content: "Cláusula 14: multa rescisória de 15%.",
            dataBase64: "JVBERi0xLjQ="
          }
        ]
      },
      allHealthy()
    );

    assert.deepEqual(criticalDecision.participants, ["gemini", "groq", "openrouter"]);
    assert.equal(criticalDecision.category, "complex_council");

    // PDF escaneado (content vazio) mesmo com pedido crítico continua no Gemini (leitura visual nativa)
    const scannedDecision = resolveAutoRoute(
      {
        prompt: "Faça uma auditoria de segurança deste PDF",
        responseMode: "normal",
        interactionMode: "direct",
        attachments: [
          {
            name: "scan.pdf",
            kind: "pdf",
            mimeType: "application/pdf",
            size: 18000,
            content: "",
            dataBase64: "JVBERi0xLjQ="
          }
        ]
      },
      allHealthy()
    );

    assert.deepEqual(scannedDecision.participants, ["gemini"]);
    assert.equal(scannedDecision.category, "pdf");
  });

  it("roteia imagem anexada para Gemini + OpenRouter (multimodal)", () => {
    const decision = resolveAutoRoute(
      {
        prompt: "O que aparece nesse print?",
        responseMode: "normal",
        interactionMode: "direct",
        attachments: [
          {
            name: "tela.png",
            kind: "image",
            mimeType: "image/png",
            size: 5000,
            dataBase64: "iVBORw0KGgo="
          }
        ]
      },
      allHealthy()
    );

    assert.deepEqual(decision.participants, ["gemini", "openrouter"]);
    assert.equal(decision.category, "image");
  });

  it("roteia arquitetura, comparação ou bloco de código para o Trio", () => {
    const archDecision = resolveAutoRoute(
      {
        prompt: "Compare arquitetura de microsserviços vs monolito modular para fintech",
        responseMode: "normal",
        interactionMode: "direct"
      },
      allHealthy()
    );
    assert.deepEqual(archDecision.participants, ["gemini", "groq", "openrouter"]);
    assert.equal(archDecision.category, "complex_council");

    const codeDecision = resolveAutoRoute(
      {
        prompt: "Veja esse trecho:\n```ts\nconst x = 1;\n```",
        responseMode: "normal",
        interactionMode: "direct"
      },
      allHealthy()
    );
    assert.deepEqual(codeDecision.participants, ["gemini", "groq", "openrouter"]);
    assert.equal(codeDecision.category, "complex_council");
  });

  it("roteia contexto extenso (prompt longo ou projeto volumoso) para Gemini", () => {
    const decision = resolveAutoRoute(
      {
        prompt: "Explique os pontos principais.",
        responseMode: "normal",
        interactionMode: "direct",
        resolvedProjectContext: {
          projectId: "proj-1",
          projectName: "Docs",
          instructions: "Seja técnico.",
          chunks: [
            {
              source: "manual.md",
              kind: "uploaded",
              score: 5,
              content: "x".repeat(4000)
            }
          ]
        }
      },
      allHealthy()
    );

    assert.deepEqual(decision.participants, ["gemini"]);
    assert.equal(decision.category, "long_context");
  });

  it("pula provedor com menos de 10% de cota restante (requisições ou tokens)", () => {
    // Groq com apenas 5% de cota diária de tokens restante
    const statuses: ProviderStatus[] = [
      makeProviderStatus("gemini", { requestsToday: 10, requestsDailyCap: 100 }),
      makeProviderStatus("groq", {
        requestsToday: 10,
        requestsDailyCap: 900,
        tokensToday: 95_000,
        tokensDailyCap: 100_000
      }),
      makeProviderStatus("openrouter", { requestsToday: 10, requestsDailyCap: 45 })
    ];

    const decision = resolveAutoRoute(
      {
        prompt: "Me dê um sinônimo de rápido",
        responseMode: "normal",
        interactionMode: "direct"
      },
      statuses
    );

    assert.deepEqual(decision.participants, ["gemini"]);
    assert.equal(decision.category, "quota_fallback");
    assert.deepEqual(decision.skippedForQuota, ["groq"]);
  });

  it("no modo Debate sempre retorna 2 a 3 IAs saudáveis, pulando provedor quase esgotado", () => {
    const statuses: ProviderStatus[] = [
      makeProviderStatus("gemini", { requestsToday: 10, requestsDailyCap: 100 }),
      makeProviderStatus("groq", { requestsToday: 10, requestsDailyCap: 900 }),
      makeProviderStatus("openrouter", { requestsToday: 43, requestsDailyCap: 45 }) // 4.4% restante
    ];

    const decision = resolveAutoRoute(
      {
        prompt: "Oi",
        responseMode: "normal",
        interactionMode: "debate"
      },
      statuses
    );

    assert.deepEqual(decision.participants, ["gemini", "groq"]);
    assert.equal(decision.category, "debate");
    assert.deepEqual(decision.skippedForQuota, ["openrouter"]);
  });

  it("faz fallback extremo quando todos os provedores estão abaixo de 10% mas ainda utilizáveis", () => {
    const statuses: ProviderStatus[] = [
      makeProviderStatus("gemini", { requestsToday: 95, requestsDailyCap: 100 }),
      makeProviderStatus("groq", { requestsToday: 850, requestsDailyCap: 900 }),
      makeProviderStatus("openrouter", { requestsToday: 44, requestsDailyCap: 45 })
    ];

    const decision = resolveAutoRoute(
      {
        prompt: "Que horas são em Tóquio?",
        responseMode: "normal",
        interactionMode: "direct"
      },
      statuses
    );

    assert.equal(decision.participants.length, 1);
    assert.equal(decision.participants[0], "groq");
  });

  it("resolveAutoComposerStrategy ativa Debate (1 rodada + Síntese) para criação de app em pasta vinculada", () => {
    const res = resolveAutoComposerStrategy(
      {
        prompt: "Crie na pasta um app completo de controle de tarefas com testes",
        isContinuation: false,
        hasLinkedFolder: true,
        isLocalPc: true,
        folderPolicy: "auto",
        responseMode: "normal"
      },
      allHealthy()
    );

    assert.equal(res.interactionMode, "debate");
    assert.equal(res.totalRounds, 1);
    assert.deepEqual(res.autoRoute.participants, ["gemini", "groq", "openrouter"]);
  });

  it("resolveAutoComposerStrategy usa 1 IA forte de código para edição pontual em continuação de projeto", () => {
    const res = resolveAutoComposerStrategy(
      {
        prompt: "Adicione um botão Exportar JSON no cabeçalho da página",
        isContinuation: true,
        hasLinkedFolder: true,
        isLocalPc: true,
        folderPolicy: "auto",
        responseMode: "normal"
      },
      allHealthy()
    );

    assert.equal(res.interactionMode, "direct");
    assert.deepEqual(res.autoRoute.participants, ["gemini"]);
  });

  it("resolveAutoComposerStrategy mantém pergunta simples em 1 IA rápida mesmo dentro de projeto com pasta", () => {
    const res = resolveAutoComposerStrategy(
      {
        prompt: "Explique como o arquivo store.ts salva os dados",
        isContinuation: true,
        hasLinkedFolder: true,
        isLocalPc: true,
        folderPolicy: "auto",
        responseMode: "normal"
      },
      allHealthy()
    );

    assert.equal(res.interactionMode, "direct");
    assert.deepEqual(res.autoRoute.participants, ["groq"]);
  });

  it("resolveAutoComposerStrategy usa Conselho (Trio direto) para comparações arquiteturais", () => {
    const res = resolveAutoComposerStrategy(
      {
        prompt: "Compare SQLite vs PostgreSQL e os trade-offs de arquitetura",
        isContinuation: false,
        hasLinkedFolder: false,
        isLocalPc: true,
        folderPolicy: "auto",
        responseMode: "normal"
      },
      allHealthy()
    );

    assert.equal(res.interactionMode, "direct");
    assert.deepEqual(res.autoRoute.participants, ["gemini", "groq", "openrouter"]);
  });
});
