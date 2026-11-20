import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Gera um PDF 1.4 válido mínimo contendo texto real extraível pelo unpdf.
 */
function buildMinimalPdfBuffer(text: string): Buffer {
  const safe = text.replace(/[()\\]/g, " ");
  const stream = `BT /F1 12 Tf 72 720 Td (${safe}) Tj ET`;
  const objects = [
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj",
    `4 0 obj << /Length ${Buffer.byteLength(stream, "utf8")} >> stream\n${stream}\nendstream endobj`,
    "5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj"
  ];

  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, "utf8"));
    pdf += `${obj}\n`;
  }
  const xrefPos = Buffer.byteLength(pdf, "utf8");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let i = 1; i < offsets.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(pdf, "utf8");
}

let tempDataDir = "";
let tempFolder = "";

describe("Prioridade #3 — PDFs universais no chat (unpdf + BM25) & Cache mtimeMs nos Projetos", () => {
  before(async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "ai-council-p3-data-"));
    tempFolder = await mkdtemp(join(tmpdir(), "ai-council-p3-folder-"));
    process.env.AI_COUNCIL_DATA_DIR = tempDataDir;

    await writeFile(
      join(tempFolder, "alpha.md"),
      "# Modulo Alpha\nA chave de integracao Alpha usa protocolo OAuth2 PKCE.\n",
      "utf8"
    );
    await writeFile(
      join(tempFolder, "beta.md"),
      "# Modulo Beta\nO servico Beta processa filas assincronas em lotes de 50 eventos.\n",
      "utf8"
    );
  });

  after(async () => {
    delete process.env.AI_COUNCIL_DATA_DIR;
    if (tempDataDir) await rm(tempDataDir, { recursive: true, force: true }).catch(() => {});
    if (tempFolder) await rm(tempFolder, { recursive: true, force: true }).catch(() => {});
  });

  it("entrega PDF híbrido: Gemini recebe inline nativo enquanto Groq e OpenRouter recebem texto extraído via unpdf", async () => {
    const engine = await import("../src/debate/debate-engine.js");
    const pdfBuf = buildMinimalPdfBuffer(
      "Contrato AI Council Clausula 14 multa rescisoria fixa de 15 por cento"
    );

    const session = await engine.createDebateSession({
      title: "Análise de Contrato PDF",
      topic: "Qual o valor da multa na cláusula 14?",
      participants: ["gemini", "groq", "openrouter"],
      responseMode: "normal",
      interactionMode: "direct",
      attachments: [
        {
          name: "contrato.pdf",
          kind: "pdf",
          mimeType: "application/pdf",
          size: pdfBuf.byteLength,
          content: "",
          dataBase64: pdfBuf.toString("base64")
        }
      ]
    });

    const geminiTask = session.tasks.find((t) => t.platform === "gemini");
    const groqTask = session.tasks.find((t) => t.platform === "groq");
    const orTask = session.tasks.find((t) => t.platform === "openrouter");

    assert.ok(geminiTask && groqTask && orTask);
    assert.ok(
      geminiTask.prompt.includes("enviado inline para análise visual/documental"),
      "Gemini deve continuar recebendo PDF nativo inline"
    );
    assert.ok(
      groqTask.prompt.includes("Clausula 14") && groqTask.prompt.includes("15 por cento"),
      "Groq deve receber o texto extraído do PDF via unpdf"
    );
    assert.ok(
      orTask.prompt.includes("Clausula 14") && orTask.prompt.includes("15 por cento"),
      "OpenRouter deve receber o texto extraído do PDF via unpdf"
    );
  });

  it("envia aviso interno transparente para Groq/OpenRouter quando o PDF for escaneado (sem texto extraível)", async () => {
    const engine = await import("../src/debate/debate-engine.js");
    const emptyPdfBuf = buildMinimalPdfBuffer("");

    const session = await engine.createDebateSession({
      title: "PDF Escaneado",
      topic: "Leia este comprovante escaneado",
      participants: ["gemini", "groq"],
      responseMode: "normal",
      interactionMode: "direct",
      attachments: [
        {
          name: "scan.pdf",
          kind: "pdf",
          mimeType: "application/pdf",
          size: emptyPdfBuf.byteLength,
          content: "",
          dataBase64: emptyPdfBuf.toString("base64")
        }
      ]
    });

    const groqTask = session.tasks.find((t) => t.platform === "groq");
    assert.ok(groqTask);
    assert.ok(groqTask.prompt.includes("escaneado/somente imagem"));
    assert.ok(groqTask.prompt.includes("Gemini recebeu o arquivo visualmente"));
  });

  it("selectPdfTextForPrompt usa BM25 local em PDFs longos preservando início + cláusula relevante do meio", async () => {
    const rag = await import("../src/projects/project-rag.js");

    const filler =
      "Disposições gerais de conformidade administrativa e registro operacional padrão. ".repeat(
        80
      );
    const hugePdfText = [
      "CONTRATO DE PRESTAÇÃO DE SERVIÇOS DE NUVEM — SUMÁRIO EXECUTIVO\nObjeto: licença corporativa anual.\n",
      filler,
      "\n\nCLÁUSULA 14 — PENALIDADE DE SLA CRÍTICO\nEm caso de indisponibilidade acima de 4 horas, aplica-se crédito automático de 25% na fatura mensal via código SLA_CREDIT_25.\n\n",
      filler
    ].join("\n");

    const selected = rag.selectPdfTextForPrompt(
      "contrato-40p.pdf",
      hugePdfText,
      "Qual é o código e percentual de crédito da cláusula 14 de SLA?",
      3_500
    );

    assert.ok(selected.length <= 3_800);
    assert.ok(selected.includes("SUMÁRIO EXECUTIVO"), "Deve preservar o início do PDF");
    assert.ok(
      selected.includes("SLA_CREDIT_25"),
      "BM25 deve encontrar a cláusula no meio do PDF longo"
    );
  });

  it("cache mtimeMs + size do BM25 reaproveita índice em perguntas seguidas e invalida na hora ao editar arquivo", async () => {
    const store = await import("../src/persistence/project-store.js");
    const rag = await import("../src/projects/project-rag.js");

    rag.clearProjectRagCache();

    const proj = await store.createProject({
      name: "Cache Benchmark",
      color: "iris",
      instructions: "Responda de forma concisa.",
      linkedFolderPath: tempFolder
    });

    // 1ª consulta: constrói índice e lê os 2 arquivos da pasta
    const first = await rag.gatherProjectContext(proj.id, "Como funciona o protocolo OAuth2?");
    assert.ok(first);
    const statsAfterFirst = rag.getProjectRagCacheStats();
    assert.equal(statsAfterFirst.indexRebuilds, 1);
    assert.equal(statsAfterFirst.indexHits, 0);
    assert.equal(statsAfterFirst.fileReads, 2);

    // 2ª consulta (mesmos arquivos no disco): deve acertar o cache do índice BM25 sem ler disco!
    const second = await rag.gatherProjectContext(proj.id, "Quantos eventos o serviço Beta processa?");
    assert.ok(second);
    const statsAfterSecond = rag.getProjectRagCacheStats();
    assert.equal(statsAfterSecond.indexHits, 1, "Deve dar HIT no índice BM25 pré-calculado");
    assert.equal(statsAfterSecond.indexRebuilds, 1, "Não deve reconstruir o índice");
    assert.equal(statsAfterSecond.fileReads, 2, "Não deve reler nenhum arquivo do disco");

    // Edita APENAS beta.md (alterando conteúdo e garantindo mtimeMs distinto)
    const betaPath = join(tempFolder, "beta.md");
    await writeFile(
      betaPath,
      "# Modulo Beta v2\nO servico Beta agora processa lotes turbo de 250 eventos com backoff exponencial.\n",
      "utf8"
    );
    const futureDate = new Date(Date.now() + 5_000);
    await utimes(betaPath, futureDate, futureDate);

    // 3ª consulta: detecta mudança na hora, reconstrói índice lendo APENAS beta.md (alpha.md vem do file cache!)
    const third = await rag.gatherProjectContext(proj.id, "Qual o novo lote do serviço Beta?");
    assert.ok(third);
    const joinedThird = third.chunks.map((c) => c.content).join("\n");
    assert.ok(
      joinedThird.includes("250 eventos"),
      "Deve refletir imediatamente o conteúdo editado no disco"
    );

    const statsAfterThird = rag.getProjectRagCacheStats();
    assert.equal(statsAfterThird.indexRebuilds, 2, "Deve invalidar e reconstruir o índice");
    assert.equal(
      statsAfterThird.fileReads,
      3,
      "Deve reler apenas o 1 arquivo editado (beta.md)"
    );
    assert.ok(
      statsAfterThird.fileHits >= 1,
      "Arquivo inalterado (alpha.md) deve ser reaproveitado do cache de arquivos"
    );
  });
});
