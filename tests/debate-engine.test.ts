import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tempDir = mkdtempSync(join(tmpdir(), "ai-council-engine-test-"));
process.env.AI_COUNCIL_DATA_DIR = tempDir;

const {
  createDebateSession,
  continueDebateSession,
  submitDebateTaskResponse,
  renameDebateSession,
  togglePinDebateSession,
  searchDebateSessions,
  stopDebateGeneration,
  skipStragglerTaskAndAdvanceStage,
  detectRoundDivergence,
  pickRelator,
  deleteDebateSession,
  listDebateSummaries,
  getDebateSessionById,
  compactForPrompt
} = await import("../src/debate/debate-engine.js");

const {
  listPromptTemplates,
  createPromptTemplate,
  updatePromptTemplate,
  deletePromptTemplate
} = await import("../src/persistence/template-store.js");

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("debate-engine — Fluxo Completo, Anexos, Busca & Pin", () => {
  it("compactForPrompt preserva início e fim de textos grandes e fecha blocos de código", () => {
    const big = `\`\`\`js\n${"A".repeat(400)}\n${"B".repeat(400)}\n${"C".repeat(400)}`;
    const compact = compactForPrompt(big, 300);
    assert.ok(compact.length < big.length);
    assert.ok(compact.startsWith("```js"));
    assert.ok(compact.includes("trecho omitido"));
    assert.ok(compact.endsWith("```"));
  });

  it("cria sessão em modo Direto, registra resposta, conclui e continua em turno 2", async () => {
    const session = await createDebateSession({
      title: "Teste Direto",
      topic: "Explique recursão em 3 linhas",
      participants: ["gemini"],
      interactionMode: "direct",
      responseMode: "normal"
    });

    assert.equal(session.status, "running");
    assert.equal(session.tasks.length, 1);
    assert.equal(session.turns?.length, 1);

    const firstTask = session.tasks[0]!;
    const completed = await submitDebateTaskResponse(session.id, {
      taskId: firstTask.id,
      content: "Recursão é quando uma função chama a si mesma até atingir um caso base."
    });

    assert.equal(completed.status, "completed");
    assert.equal(completed.responses.length, 1);

    const continued = await continueDebateSession(session.id, {
      message: "Agora dê um exemplo em JavaScript",
      participants: ["gemini", "groq"],
      interactionMode: "direct",
      responseMode: "normal"
    });

    assert.equal(continued.status, "running");
    assert.equal(continued.turns?.length, 2);
    assert.equal(continued.tasks.filter((t) => t.status === "pending").length, 2);
  });

  it("sanitiza anexos de texto, imagem e PDF corretamente", async () => {
    const tinyPngBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
    const fakePdfBase64 = Buffer.from("%PDF-1.4\n%%EOF").toString("base64");

    const session = await createDebateSession({
      title: "Teste Multimodal",
      topic: "Analise os anexos enviados",
      participants: ["gemini"],
      interactionMode: "direct",
      responseMode: "normal",
      attachments: [
        { name: "app.ts", content: "export const x = 42;", size: 20 },
        {
          name: "print.png",
          kind: "image",
          mimeType: "image/png",
          dataBase64: tinyPngBase64,
          content: "",
          size: 68
        },
        {
          name: "especificacao.pdf",
          kind: "pdf",
          mimeType: "application/pdf",
          dataBase64: fakePdfBase64,
          content: "",
          size: 16
        }
      ]
    });

    const turnAttachments = session.turns?.[0]?.attachments ?? [];
    assert.equal(turnAttachments.length, 3);
    assert.equal(turnAttachments[0]?.kind, "text");
    assert.equal(turnAttachments[1]?.kind, "image");
    assert.equal(turnAttachments[1]?.mimeType, "image/png");
    assert.equal(turnAttachments[2]?.kind, "pdf");
    assert.equal(turnAttachments[2]?.mimeType, "application/pdf");
  });

  it("suporta renomear, fixar no topo (Pin), buscar no conteúdo sem acento e excluir", async () => {
    const older = await createDebateSession({
      title: "Conversa Antiga",
      topic: "Algoritmo de ordenação quicksort em Java",
      participants: ["gemini"],
      interactionMode: "direct",
      responseMode: "normal"
    });
    await submitDebateTaskResponse(older.id, {
      taskId: older.tasks[0]!.id,
      content: "O Quicksort usa divisão e conquista com pivô para ordenar vetores."
    });

    const newer = await createDebateSession({
      title: "Conversa Recente",
      topic: "Receita de café gelado",
      participants: ["gemini"],
      interactionMode: "direct",
      responseMode: "normal"
    });

    // Renomeia
    const renamed = await renameDebateSession(older.id, "Quicksort em Java");
    assert.equal(renamed.title, "Quicksort em Java");

    // Fixa a mais antiga -> deve subir para o 1º lugar na lista de resumos
    const pinned = await togglePinDebateSession(older.id, true);
    assert.equal(pinned.pinned, true);

    const summaries = await listDebateSummaries();
    assert.equal(summaries[0]?.id, older.id);

    // Busca sem acento no conteúdo da resposta ("pivo" -> casa com "pivô")
    const matches = await searchDebateSessions("pivo");
    assert.ok(matches.includes(older.id));
    assert.ok(!matches.includes(newer.id));

    // Exclui e confirma remoção
    const deleted = await deleteDebateSession(newer.id);
    assert.equal(deleted, true);
    assert.equal(await getDebateSessionById(newer.id), null);
  });

  it("stopDebateGeneration mantém texto parcial com interrupted=true e libera o chat", async () => {
    const session = await createDebateSession({
      title: "Teste Stop Parcial",
      topic: "Explique arquitetura hexagonal em detalhes",
      participants: ["gemini", "groq"],
      interactionMode: "direct",
      responseMode: "normal"
    });

    const geminiTask = session.tasks.find((t) => t.platform === "gemini")!;
    const partials = new Map<string, string>([
      [geminiTask.id, "Arquitetura hexagonal separa o domínio das portas e adaptadores..."]
    ]);

    const stopped = await stopDebateGeneration(session.id, partials);
    assert.equal(stopped.status, "completed");
    assert.equal(stopped.currentStage, "completed");
    assert.equal(stopped.responses.length, 1);
    assert.equal(stopped.responses[0]?.interrupted, true);
    assert.ok(stopped.responses[0]?.content.includes("Arquitetura hexagonal"));

    // Chat já está liberado para enviar a próxima mensagem imediatamente
    const nextTurn = await continueDebateSession(session.id, {
      message: "Continue com um exemplo curto.",
      participants: ["gemini"],
      interactionMode: "direct",
      responseMode: "normal"
    });
    assert.equal(nextTurn.status, "running");
    assert.equal(nextTurn.turns?.length, 2);
  });

  it("pickRelator sempre escolhe Gemini e skipStragglerTaskAndAdvanceStage libera síntese no Gemini sem esperar IA lenta", async () => {
    assert.equal(pickRelator(["groq", "openrouter"]), "gemini");
    assert.equal(pickRelator(["groq", "nvidia"]), "gemini");

    const session = await createDebateSession({
      title: "Teste Quórum + Relator Gemini",
      topic: "Crie um módulo de cache LRU",
      participants: ["groq", "openrouter", "nvidia"],
      interactionMode: "debate",
      totalRounds: 1,
      responseMode: "prompt_markdown"
    });

    const groqTask = session.tasks.find((t) => t.platform === "groq")!;
    const openRouterTask = session.tasks.find((t) => t.platform === "openrouter")!;
    const slowNvidiaTask = session.tasks.find((t) => t.platform === "nvidia")!;

    await submitDebateTaskResponse(session.id, {
      taskId: groqTask.id,
      content: "Proposta Groq: Map nativo com O(1) para get/set."
    });
    await submitDebateTaskResponse(session.id, {
      taskId: openRouterTask.id,
      content: "Proposta OpenRouter: LRU com limite máximo e evicção segura."
    });

    // Dispensa a 3ª IA lenta após quórum -> deve avançar imediatamente para síntese no Gemini!
    const advanced = await skipStragglerTaskAndAdvanceStage(
      session.id,
      slowNvidiaTask.id,
      "Dispensada por prazo da rodada."
    );
    assert.ok(advanced);
    assert.equal(advanced.currentStage, "synthesis");
    const synthTask = advanced.tasks.find(
      (t) => t.stage === "synthesis" && t.status === "pending"
    );
    assert.ok(synthTask);
    assert.equal(synthTask.platform, "gemini");
  });

  it("Onda 3 — Debate Adaptativo pula Rodada 2 quando há consenso na Rodada 1 e mantém Crítica quando há divergência real", async () => {
    // Caso 1: Consenso claro -> pula Rodada 2 e vai direto para Síntese no Gemini
    const consensusSession = await createDebateSession({
      title: "Debate Consenso",
      topic: "Como estruturar autenticação segura em Node.js?",
      participants: ["gemini", "groq"],
      interactionMode: "debate",
      totalRounds: 2,
      responseMode: "prompt_markdown"
    });

    const gTask1 = consensusSession.tasks.find((t) => t.platform === "gemini")!;
    const qTask1 = consensusSession.tasks.find((t) => t.platform === "groq")!;

    await submitDebateTaskResponse(consensusSession.id, {
      taskId: gTask1.id,
      content:
        "Use scryptSync com salt aleatorio, timingSafeEqual, cookies HttpOnly SameSite Strict e rate limit em rotas de login."
    });
    const afterConsensus = await submitDebateTaskResponse(consensusSession.id, {
      taskId: qTask1.id,
      content:
        "Recomendo scryptSync com salt aleatorio, timingSafeEqual, cookies HttpOnly SameSite Strict e rate limit nas rotas de login."
    });

    assert.equal(afterConsensus.currentStage, "synthesis");
    assert.equal(afterConsensus.totalRounds, 1);
    const consensusSynth = afterConsensus.tasks.find(
      (t) => t.stage === "synthesis" && t.status === "pending"
    );
    assert.equal(consensusSynth?.platform, "gemini");

    // Caso 2: Divergência real (SQLite vs PostgreSQL) -> avança para Rodada 2 (critique)
    const divCheck = detectRoundDivergence([
      {
        id: "r1",
        taskId: "t1",
        round: 1,
        stage: "initial_response",
        platform: "gemini",
        promptUsed: "",
        content: "Use SQLite embarcado para simplicidade local e zero configuracao.",
        submittedAt: new Date().toISOString()
      },
      {
        id: "r2",
        taskId: "t2",
        round: 1,
        stage: "initial_response",
        platform: "groq",
        promptUsed: "",
        content: "Use PostgreSQL dedicado para concorrencia pesada e particionamento.",
        submittedAt: new Date().toISOString()
      }
    ]);
    assert.equal(divCheck.hasDivergence, true);
    assert.match(divCheck.reason, /SQLite vs PostgreSQL/);
  });
});

describe("template-store — Biblioteca de Prompts Editáveis", () => {
  it("semeia os 4 templates padrão e permite criar, editar e excluir", async () => {
    const initial = await listPromptTemplates();
    assert.equal(initial.length, 4);

    const created = await createPromptTemplate({
      tag: "TESTE // QA",
      title: "Revisar Pull Request",
      prompt: "Revise o diff buscando bugs de concorrência e segurança.",
      rules: "Seja direto e objetivo.",
      focus: "backend",
      responseMode: "normal",
      interactionMode: "direct"
    });

    assert.ok(created.id);
    assert.equal((await listPromptTemplates()).length, 5);

    const updated = await updatePromptTemplate(created.id, {
      title: "Revisar PR Crítico",
      prompt: "Revise o diff com foco em segurança e performance."
    });
    assert.equal(updated.title, "Revisar PR Crítico");

    const removed = await deletePromptTemplate(created.id);
    assert.equal(removed, true);
    assert.equal((await listPromptTemplates()).length, 4);
  });
});
