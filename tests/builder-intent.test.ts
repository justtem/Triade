import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyBuilderIntent } from "../src/projects/builder-intent.js";
import { extractWorkspaceFilesFromMarkdown } from "../src/projects/workspace-writer.js";

describe("Construtor 100% Automático — Classificador de Intenção (4 Camadas)", () => {
  it("ativa auto-aplicação em pedidos explícitos de código no Chat Rápido (1 IA) e no Debate", () => {
    const debateCase = classifyBuilderIntent({
      prompt: "Crie a API REST de pedidos em src/orders.ts e escreva os testes",
      hasLinkedFolder: true,
      isLocalPc: true,
      folderPolicy: "auto",
      interactionMode: "debate",
      participantCount: 3
    });
    assert.equal(debateCase.level, "write_explicit");
    assert.equal(debateCase.shouldActivateBuilder, true);
    assert.equal(debateCase.shouldAutoApply, true);
    assert.equal(debateCase.injectBuilderHint, true);

    const quickCase = classifyBuilderIntent({
      prompt: "Corrija esse erro no build do projeto",
      hasLinkedFolder: true,
      isLocalPc: true,
      folderPolicy: "auto",
      interactionMode: "direct",
      participantCount: 1
    });
    assert.equal(quickCase.level, "write_explicit");
    assert.equal(quickCase.shouldActivateBuilder, true);
    assert.equal(quickCase.shouldAutoApply, true);
  });

  it("bloqueia escrita automática em perguntas explicativas e travas negativas (Risco 1)", () => {
    const explain = classifyBuilderIntent({
      prompt: "Explique como funciona JWT com um exemplo de código em TypeScript",
      hasLinkedFolder: true,
      isLocalPc: true,
      folderPolicy: "auto",
      interactionMode: "debate",
      participantCount: 3
    });
    assert.equal(explain.level, "read_or_explore");
    assert.equal(explain.shouldActivateBuilder, false);
    assert.equal(explain.shouldAutoApply, false);

    const guard = classifyBuilderIntent({
      prompt: "Crie um plano para refatorar a API, mas não altere nada ainda na pasta",
      hasLinkedFolder: true,
      isLocalPc: true,
      folderPolicy: "auto",
      interactionMode: "debate",
      participantCount: 3
    });
    assert.equal(guard.level, "read_or_explore");
    assert.equal(guard.shouldActivateBuilder, false);
    assert.equal(guard.shouldAutoApply, false);
  });

  it("no modo Conselho (várias IAs paralelas) ou zona cinzenta nunca auto-aplica sem escolha (Risco 2)", () => {
    const council = classifyBuilderIntent({
      prompt: "Crie a rota de login em src/auth.ts",
      hasLinkedFolder: true,
      isLocalPc: true,
      folderPolicy: "auto",
      interactionMode: "direct",
      participantCount: 3
    });
    assert.equal(council.level, "write_explicit");
    assert.equal(council.shouldActivateBuilder, true);
    assert.equal(council.shouldAutoApply, false);

    const ambiguous = classifyBuilderIntent({
      prompt: "Precisamos de autenticação JWT nesse projeto",
      hasLinkedFolder: true,
      isLocalPc: true,
      folderPolicy: "auto",
      interactionMode: "debate",
      participantCount: 3
    });
    assert.equal(ambiguous.level, "ambiguous");
    assert.equal(ambiguous.shouldActivateBuilder, true);
    assert.equal(ambiguous.shouldAutoApply, false);
  });

  it("respeita política da pasta (confirm / readonly) e bloqueia acesso remoto", () => {
    const confirmMode = classifyBuilderIntent({
      prompt: "Implemente o serviço de faturas em src/billing.ts",
      hasLinkedFolder: true,
      isLocalPc: true,
      folderPolicy: "confirm",
      interactionMode: "debate",
      participantCount: 3
    });
    assert.equal(confirmMode.shouldActivateBuilder, true);
    assert.equal(confirmMode.shouldAutoApply, false);

    const readonlyMode = classifyBuilderIntent({
      prompt: "Implemente o serviço de faturas em src/billing.ts",
      hasLinkedFolder: true,
      isLocalPc: true,
      folderPolicy: "readonly",
      interactionMode: "debate",
      participantCount: 3
    });
    assert.equal(readonlyMode.shouldActivateBuilder, false);
    assert.equal(readonlyMode.shouldAutoApply, false);

    const remoteMode = classifyBuilderIntent({
      prompt: "Implemente o serviço de faturas em src/billing.ts",
      hasLinkedFolder: true,
      isLocalPc: false,
      folderPolicy: "auto",
      interactionMode: "debate",
      participantCount: 3
    });
    assert.equal(remoteMode.shouldActivateBuilder, false);
    assert.equal(remoteMode.shouldAutoApply, false);
  });

  it("ignora arquivos genéricos de exemplo soltos na raiz (example.ts / foo.ts) na extração", () => {
    const md = [
      "### `example.ts`",
      "```ts",
      "console.log('exemplo');",
      "```",
      "### `src/orders.ts`",
      "```ts",
      "export const ok = true;",
      "```"
    ].join("\n");

    const res = extractWorkspaceFilesFromMarkdown(md);
    assert.deepEqual(
      res.files.map((f) => f.path),
      ["src/orders.ts"]
    );
  });

  it("reconhece pedidos naturais de interface e funcionalidades (filtro, botão, tema, cabeçalho) sem exigir jargão técnico", () => {
    const prompts = [
      "Adicione no HabitPulse um filtro de busca por texto para filtrar os hábitos pelo nome em tempo real na interface e atualize apenas o necessário.",
      "Coloque um botão de exportar JSON no cabeçalho",
      "Mude a cor do tema e ajuste o layout dos cards"
    ];

    for (const prompt of prompts) {
      const res = classifyBuilderIntent({
        prompt,
        hasLinkedFolder: true,
        isLocalPc: true,
        folderPolicy: "auto",
        interactionMode: "direct",
        participantCount: 1
      });
      assert.equal(res.level, "write_explicit", `Deveria classificar como write_explicit: ${prompt}`);
      assert.equal(res.shouldAutoApply, true, `Deveria auto-aplicar: ${prompt}`);
    }

    const explainUi = classifyBuilderIntent({
      prompt: "Explique como o filtro de busca funciona na interface",
      hasLinkedFolder: true,
      isLocalPc: true,
      folderPolicy: "auto",
      interactionMode: "direct",
      participantCount: 1
    });
    assert.equal(explainUi.level, "read_or_explore");
    assert.equal(explainUi.shouldActivateBuilder, false);
  });
});
