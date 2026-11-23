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

  it("Passo 2: prioriza NVIDIA NIM em edição na pasta, contexto longo e como reserva de debate para desafogar Gemini", () => {
    const withNvidia: ProviderStatus[] = [
      ...allHealthy(),
      makeProviderStatus("nvidia", { requestsToday: 5, requestsDailyCap: 270 })
    ];

    // 1. Edição rápida na pasta com Gemini saudável -> mantém Gemini pela velocidade/precisão TS;
    //    se Gemini cair abaixo de 20% ou 503, failover automático para NVIDIA NIM!
    const editResHealthy = resolveAutoComposerStrategy(
      {
        prompt: "Adicione um filtro por categoria no cabeçalho",
        isContinuation: true,
        hasLinkedFolder: true,
        isLocalPc: true,
        folderPolicy: "auto",
        responseMode: "normal"
      },
      withNvidia
    );
    assert.equal(editResHealthy.interactionMode, "direct");
    assert.deepEqual(editResHealthy.autoRoute.participants, ["gemini"]);

    const editResFailover = resolveAutoComposerStrategy(
      {
        prompt: "Adicione um filtro por categoria no cabeçalho",
        isContinuation: true,
        hasLinkedFolder: true,
        isLocalPc: true,
        folderPolicy: "auto",
        responseMode: "normal"
      },
      [
        makeProviderStatus("gemini", { requestsToday: 85, requestsDailyCap: 100 }),
        makeProviderStatus("groq", { requestsToday: 20, requestsDailyCap: 900 }),
        makeProviderStatus("openrouter", { requestsToday: 5, requestsDailyCap: 45 }),
        makeProviderStatus("nvidia", { requestsToday: 5, requestsDailyCap: 270 })
      ]
    );
    assert.deepEqual(editResFailover.autoRoute.participants, ["nvidia"]);

    // 2. Contexto extenso: mantém Gemini em #1 quando saudável; NVIDIA NIM assume como reserva se Gemini < 20%
    const longRes = resolveAutoRoute(
      {
        prompt: "Resuma os pontos principais desse código.",
        responseMode: "normal",
        interactionMode: "direct",
        resolvedProjectContext: {
          projectId: "proj-2",
          projectName: "FinBolso",
          instructions: "Seja claro.",
          chunks: [
            {
              source: "server.ts",
              kind: "folder",
              score: 5,
              content: "x".repeat(4500)
            }
          ]
        }
      },
      withNvidia
    );
    assert.deepEqual(longRes.participants, ["gemini"]);
    assert.equal(longRes.category, "long_context");

    const longResFailover = resolveAutoRoute(
      {
        prompt: "Resuma os pontos principais desse código.",
        responseMode: "normal",
        interactionMode: "direct",
        resolvedProjectContext: {
          projectId: "proj-2",
          projectName: "FinBolso",
          instructions: "Seja claro.",
          chunks: [
            {
              source: "server.ts",
              kind: "folder",
              score: 5,
              content: "x".repeat(4500)
            }
          ]
        }
      },
      [
        makeProviderStatus("gemini", { requestsToday: 85, requestsDailyCap: 100 }),
        makeProviderStatus("groq", { requestsToday: 20, requestsDailyCap: 900 }),
        makeProviderStatus("openrouter", { requestsToday: 5, requestsDailyCap: 45 }),
        makeProviderStatus("nvidia", { requestsToday: 5, requestsDailyCap: 270 })
      ]
    );
    assert.deepEqual(longResFailover.participants, ["nvidia"]);

    // 2b. Edição longa (>= 220 chars) em projeto JÁ existente (isContinuation=true) NÃO dispara Debate completo
    const longEditInContinuation = resolveAutoComposerStrategy(
      {
        prompt:
          "Refaça completamente public/style.css, public/index.html e crie o public/app.js que estava faltando, aplicando fielmente a estética AngelList com fundo #001d21, superfícies #002b31, texto #e0fee6, CTA pill #cdcbff e cards KPI de resumo no topo mantendo total compatibilidade com src/server.ts.",
        isContinuation: true,
        hasLinkedFolder: true,
        isLocalPc: true,
        folderPolicy: "auto",
        responseMode: "normal"
      },
      withNvidia
    );
    assert.equal(longEditInContinuation.interactionMode, "direct");
    assert.deepEqual(longEditInContinuation.autoRoute.participants, ["gemini"]);

    // 3. Reserva automática no Debate quando OpenRouter cai abaixo de 10%
    const lowOrWithNvidia: ProviderStatus[] = [
      makeProviderStatus("gemini", { requestsToday: 10, requestsDailyCap: 100 }),
      makeProviderStatus("groq", { requestsToday: 10, requestsDailyCap: 900 }),
      makeProviderStatus("openrouter", { requestsToday: 44, requestsDailyCap: 45 }),
      makeProviderStatus("nvidia", { requestsToday: 5, requestsDailyCap: 270 })
    ];
    const debateRes = resolveAutoRoute(
      {
        prompt: "Compare abordagens de cache",
        responseMode: "normal",
        interactionMode: "debate"
      },
      lowOrWithNvidia
    );
    assert.deepEqual(debateRes.participants, ["gemini", "groq", "nvidia"]);

    // 4. Sem NVIDIA: quando Gemini cai abaixo de 45% e OpenRouter tem folga, rotaciona edição para OpenRouter
    const lowGeminiNoNvidia: ProviderStatus[] = [
      makeProviderStatus("gemini", { requestsToday: 65, requestsDailyCap: 100 }),
      makeProviderStatus("groq", { requestsToday: 20, requestsDailyCap: 900 }),
      makeProviderStatus("openrouter", { requestsToday: 5, requestsDailyCap: 45 })
    ];
    const rotatedEdit = resolveAutoComposerStrategy(
      {
        prompt: "Adicione um botão de exportar JSON no cabeçalho",
        isContinuation: true,
        hasLinkedFolder: true,
        isLocalPc: true,
        folderPolicy: "auto",
        responseMode: "normal"
      },
      lowGeminiNoNvidia
    );
    assert.deepEqual(rotatedEdit.autoRoute.participants, ["openrouter"]);

    // 5. Construção completa de app novo mantém Gemini em #1 (Gemini + Groq + OpenRouter);
    //    NVIDIA NIM entra como reserva automática apenas quando Gemini/OpenRouter falhar ou cair cota!
    const majorBuildWithNvidia = resolveAutoComposerStrategy(
      {
        prompt: "Crie na pasta um app completo CineLista para organizar filmes e séries",
        isContinuation: false,
        hasLinkedFolder: true,
        isLocalPc: true,
        folderPolicy: "auto",
        responseMode: "normal"
      },
      withNvidia
    );
    assert.equal(majorBuildWithNvidia.interactionMode, "debate");
    assert.deepEqual(majorBuildWithNvidia.autoRoute.participants, [
      "gemini",
      "groq",
      "openrouter"
    ]);

    // 6. Queda global 503 no Gemini (todos modelos em cooldown) -> Auto-Router pula Gemini e chama NVIDIA!
    const geminiOutageWithNvidia: ProviderStatus[] = [
      {
        ...makeProviderStatus("gemini", { requestsToday: 2, requestsDailyCap: 90 }),
        autopilot: {
          source: "live",
          lastFetchedAt: "2026-11-23T18:00:00Z",
          discoveredCount: 2,
          activeModels: ["gemini-3.5-flash", "gemini-3.5-flash-lite"],
          primaryModel: "gemini-3.5-flash",
          fastBackupModel: "gemini-3.5-flash-lite",
          latenciesMs: {},
          cooledDown: [
            { model: "gemini-3.5-flash", reason: "congested", until: "2026-11-23T19:00:00Z" },
            { model: "gemini-3.5-flash-lite", reason: "congested", until: "2026-11-23T19:00:00Z" }
          ]
        }
      },
      makeProviderStatus("groq", { requestsToday: 10, requestsDailyCap: 900 }),
      makeProviderStatus("openrouter", { requestsToday: 2, requestsDailyCap: 45 }),
      makeProviderStatus("nvidia", { requestsToday: 2, requestsDailyCap: 270 })
    ];
    const outageDebate = resolveAutoRoute(
      {
        prompt: "Compare arquiteturas REST vs RPC",
        responseMode: "normal",
        interactionMode: "debate"
      },
      geminiOutageWithNvidia
    );
    assert.deepEqual(outageDebate.participants, ["groq", "openrouter", "nvidia"]);
  });

  it("edição simples em pasta já existente vai direto para 1 IA (Gemini) mesmo em chat novo", () => {
    const existingFolderEdit = resolveAutoComposerStrategy(
      {
        prompt: "Mude a cor do botão de salvar para verde no cabeçalho",
        isContinuation: false,
        hasLinkedFolder: true,
        hasExistingWorkspaceFiles: true,
        isLocalPc: true,
        folderPolicy: "auto",
        responseMode: "normal"
      },
      allHealthy()
    );
    assert.equal(existingFolderEdit.interactionMode, "direct");
    assert.deepEqual(existingFolderEdit.autoRoute.participants, ["gemini"]);

    // Se o usuário pedir explicitamente "crie do zero / app completo", ainda ativa Debate mesmo em pasta com arquivos
    const explicitRebuild = resolveAutoComposerStrategy(
      {
        prompt: "Crie do zero um app completo de gestão financeira",
        isContinuation: false,
        hasLinkedFolder: true,
        hasExistingWorkspaceFiles: true,
        isLocalPc: true,
        folderPolicy: "auto",
        responseMode: "normal"
      },
      allHealthy()
    );
    assert.equal(explicitRebuild.interactionMode, "debate");
  });
});
