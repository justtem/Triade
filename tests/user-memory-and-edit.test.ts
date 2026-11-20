import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildUserMemoryPromptBlock,
  clearUserMemory,
  deleteUserMemoryFact,
  invalidateUserMemoryCache,
  isSensitiveMemoryText,
  readUserMemory,
  setUserMemoryEnabled,
  upsertUserMemoryFacts
} from "../src/persistence/user-memory-store.js";
import {
  mightContainPersonalMemory,
  parseMemoryExtractionJson
} from "../src/debate/user-memory-extractor.js";
import {
  continueDebateSession,
  createDebateSession,
  editTurnAndRewind,
  submitDebateTaskResponse
} from "../src/debate/debate-engine.js";

let tempDataDir = "";
let prevDataDir: string | undefined;

describe("Ganho #2 — Memória Pessoal Automática & Editar/Reenviar Mensagem", () => {
  before(async () => {
    prevDataDir = process.env.AI_COUNCIL_DATA_DIR;
    tempDataDir = await mkdtemp(join(tmpdir(), "ai-council-g2-"));
    process.env.AI_COUNCIL_DATA_DIR = tempDataDir;
    invalidateUserMemoryCache();
  });

  after(async () => {
    if (prevDataDir === undefined) delete process.env.AI_COUNCIL_DATA_DIR;
    else process.env.AI_COUNCIL_DATA_DIR = prevDataDir;
    invalidateUserMemoryCache();
    if (tempDataDir) await rm(tempDataDir, { recursive: true, force: true }).catch(() => {});
  });

  it("bloqueia rigorosamente dados sensíveis (chaves API, senhas, CPF, cartão) na Memória Pessoal", () => {
    assert.equal(isSensitiveMemoryText("Minha chave é AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz12"), true);
    assert.equal(isSensitiveMemoryText("Token gsk_1234567890abcdef1234567890"), true);
    assert.equal(isSensitiveMemoryText("Meu CPF é 123.456.789-00"), true);
    assert.equal(isSensitiveMemoryText("Cartão 4532 1111 2222 3333"), true);
    assert.equal(isSensitiveMemoryText("Minha senha do servidor é abc12345"), true);

    assert.equal(isSensitiveMemoryText("Usa Windows 11 e programa em TypeScript e Node.js"), false);
    assert.equal(isSensitiveMemoryText("Prefere respostas curtas e diretas em português"), false);
  });

  it("pré-filtro 0ms detecta sinais pessoais/preferências e ignora perguntas genéricas ou segredos", () => {
    assert.equal(mightContainPersonalMemory("Qual a capital da França?"), false);
    assert.equal(mightContainPersonalMemory("Oi"), false);
    assert.equal(
      mightContainPersonalMemory("Minha senha do Wi-Fi é 99887766, lembre disso"),
      false
    );
    assert.equal(
      mightContainPersonalMemory("Eu trabalho com TypeScript e prefiro exemplos práticos sem teoria longa"),
      true
    );
    assert.equal(
      mightContainPersonalMemory("Lembre que uso Windows e prefiro comandos PowerShell"),
      true
    );
  });

  it("parseia JSON do extrator filtrando segredos e persiste fatos deduplicados com orçamento por IA", async () => {
    const parsed = parseMemoryExtractionJson(
      '```json\n{"add":[{"text":"Usa Windows e TypeScript","category":"context"},{"text":"Minha senha é supersecreta123","category":"other"},{"text":"Prefere respostas objetivas","category":"preference"}],"removeIds":[]}\n```'
    );
    assert.equal(parsed.add.length, 2);

    const saved = await upsertUserMemoryFacts(parsed.add);
    assert.equal(saved.addedCount, 2);

    // Duplicata não deve ser adicionada novamente
    const dup = await upsertUserMemoryFacts([
      { text: "usa windows e typescript", category: "context" }
    ]);
    assert.equal(dup.addedCount, 0);

    const mem = await readUserMemory();
    assert.equal(mem.facts.length, 2);

    const groqBlock = buildUserMemoryPromptBlock(mem, 650, { hasProjectContext: true });
    assert.ok(groqBlock.includes("priorize sempre as instruções do Projeto"));
    assert.ok(groqBlock.includes("Usa Windows e TypeScript"));
    assert.ok(groqBlock.length <= 650);

    // Pausar memória desliga injeção no prompt
    const paused = await setUserMemoryEnabled(false);
    assert.equal(buildUserMemoryPromptBlock(paused, 1800), "");

    // Reativa e testa remoção individual + limpeza
    await setUserMemoryEnabled(true);
    const firstId = mem.facts[0]!.id;
    const delRes = await deleteUserMemoryFact(firstId);
    assert.equal(delRes.deleted, true);
    assert.equal(delRes.state.facts.length, 1);

    // Garante que uma nova sessão injeta a memória pessoal automaticamente nos prompts
    const session = await createDebateSession({
      title: "Teste Memória Injetada",
      topic: "Me ajude a configurar lint",
      participants: ["gemini", "groq"],
      totalRounds: 1,
      responseMode: "normal",
      interactionMode: "direct"
    });
    const geminiTask = session.tasks.find((t) => t.platform === "gemini");
    assert.ok(geminiTask);
    assert.ok(geminiTask.prompt.includes("Memória pessoal aprendida"));

    await clearUserMemory();
    assert.equal((await readUserMemory()).facts.length, 0);
  });

  it("editTurnAndRewind edita qualquer turno, descarta turnos posteriores, preserva anexos e recalcula contexto", async () => {
    const s1 = await createDebateSession({
      title: "Rewind Test",
      topic: "Pergunta original do turno 1",
      participants: ["gemini", "groq"],
      totalRounds: 1,
      responseMode: "normal",
      interactionMode: "direct",
      attachments: [
        {
          name: "notas.txt",
          kind: "text",
          size: 32,
          content: "Conteudo preservado do anexo original"
        }
      ]
    });

    const turn1Id = s1.turns![0]!.id;
    for (const task of s1.tasks) {
      await submitDebateTaskResponse(s1.id, {
        taskId: task.id,
        content: `Resposta antiga da ${task.platform} no turno 1`
      });
    }

    // Cria turno 2 e conclui
    const s2 = await continueDebateSession(s1.id, {
      message: "Pergunta do turno 2 que deve ser descartada no rewind",
      participants: ["gemini"],
      totalRounds: 1,
      responseMode: "normal",
      interactionMode: "direct"
    });
    const turn2Task = s2.tasks.find((t) => t.status === "pending")!;
    await submitDebateTaskResponse(s1.id, {
      taskId: turn2Task.id,
      content: "Resposta do turno 2"
    });

    // Edita o Turno 1 -> deve fazer rewind descartando Turno 2 e respostas antigas, preservando notas.txt!
    const rewound = await editTurnAndRewind(s1.id, turn1Id, {
      message: "Pergunta editada do turno 1",
      participants: ["groq"],
      autoRoute: {
        participants: ["groq"],
        reason: "pergunta direta",
        category: "quick"
      }
    });

    assert.equal(rewound.status, "running");
    assert.equal(rewound.turns?.length, 1, "Turno 2 deve ter sido descartado no rewind");
    assert.equal(rewound.turns?.[0]?.prompt, "Pergunta editada do turno 1");
    assert.equal(rewound.topic, "Pergunta editada do turno 1");
    assert.equal(rewound.responses.length, 0, "Respostas antigas devem ter sido limpas");
    assert.equal(rewound.turns?.[0]?.attachments?.[0]?.name, "notas.txt", "Anexo original deve ser preservado");
    assert.equal(rewound.tasks.length, 1);
    assert.equal(rewound.tasks[0]?.platform, "groq");
    assert.ok(rewound.tasks[0]?.prompt.includes("Pergunta editada do turno 1"));
    assert.ok(rewound.tasks[0]?.prompt.includes("Conteudo preservado do anexo original"));
  });
});
