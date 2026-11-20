import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tempDataDir = "";
let tempLinkedFolder = "";

describe("Projetos / Pastas com Cérebro Local (Ideia #4)", () => {
  before(async () => {
    tempDataDir = await mkdtemp(join(tmpdir(), "ai-council-projects-data-"));
    tempLinkedFolder = await mkdtemp(join(tmpdir(), "ai-council-linked-repo-"));
    process.env.AI_COUNCIL_DATA_DIR = tempDataDir;

    // Monta um mini repositório local com arquivos normais + segredos que DEVEM ser bloqueados
    await mkdir(join(tempLinkedFolder, "src"), { recursive: true });
    await mkdir(join(tempLinkedFolder, "node_modules", "fake-pkg"), { recursive: true });
    await mkdir(join(tempLinkedFolder, ".git"), { recursive: true });
    await mkdir(join(tempLinkedFolder, "dist"), { recursive: true });

    await writeFile(
      join(tempLinkedFolder, "src", "auth.ts"),
      `export function verifyJwtToken(token: string) {\n  // Valida assinatura HMAC-SHA256 e expiração em segundos\n  return token.startsWith("jwt_");\n}\n`,
      "utf8"
    );
    await writeFile(
      join(tempLinkedFolder, "src", "billing.ts"),
      `export function calculatePixFee(amountCents: number) {\n  // Taxa promocional de 0.99% limitada a R$ 10,00\n  return Math.min(Math.round(amountCents * 0.0099), 1000);\n}\n`,
      "utf8"
    );
    await writeFile(
      join(tempLinkedFolder, "README.md"),
      `# Fintech Core API\nArquitetura modular em TypeScript com autenticação JWT e cobrança Pix.\n`,
      "utf8"
    );

    // Arquivos sensíveis / proibidos que NUNCA podem ser lidos
    await writeFile(
      join(tempLinkedFolder, ".env"),
      "SUPER_SECRET_API_KEY=sk-1234567890-NEVER-LEAK\n",
      "utf8"
    );
    await writeFile(
      join(tempLinkedFolder, ".env.production"),
      "DB_PASSWORD=ultra_secret_password\n",
      "utf8"
    );
    await writeFile(
      join(tempLinkedFolder, "private.pem"),
      "-----BEGIN PRIVATE KEY-----\nSECRET_KEY_MATERIAL\n-----END PRIVATE KEY-----\n",
      "utf8"
    );
    await writeFile(
      join(tempLinkedFolder, "server.key"),
      "RAW_TLS_PRIVATE_KEY\n",
      "utf8"
    );
    await writeFile(
      join(tempLinkedFolder, "node_modules", "fake-pkg", "index.js"),
      "export const SHOULD_BE_IGNORED = true;\n",
      "utf8"
    );
    await writeFile(
      join(tempLinkedFolder, ".git", "config"),
      "[core]\nrepositoryformatversion = 0\n",
      "utf8"
    );
    await writeFile(
      join(tempLinkedFolder, "dist", "bundle.js"),
      "console.log('ignored dist');\n",
      "utf8"
    );
    // Arquivo binário disfarçado de .txt (contém byte nulo)
    await writeFile(
      join(tempLinkedFolder, "src", "fake-binary.txt"),
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x14, 0x00])
    );
  });

  after(async () => {
    delete process.env.AI_COUNCIL_DATA_DIR;
    if (tempDataDir) {
      await rm(tempDataDir, { recursive: true, force: true }).catch(() => {});
    }
    if (tempLinkedFolder) {
      await rm(tempLinkedFolder, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("bloqueia rigorosamente .env, chaves (*.key, *.pem), credenciais e diretórios proibidos", async () => {
    const rag = await import("../src/projects/project-rag.js");

    assert.equal(rag.isBlockedSecretFile(".env"), true);
    assert.equal(rag.isBlockedSecretFile(".env.local"), true);
    assert.equal(rag.isBlockedSecretFile(".env.production"), true);
    assert.equal(rag.isBlockedSecretFile("cert.pem"), true);
    assert.equal(rag.isBlockedSecretFile("private.key"), true);
    assert.equal(rag.isBlockedSecretFile("id_rsa"), true);
    assert.equal(rag.isBlockedSecretFile("google-credentials.json"), true);
    assert.equal(rag.isBlockedSecretFile("app-secrets.yaml"), true);
    assert.equal(rag.isBlockedSecretFile("src/auth.ts"), false);
    assert.equal(rag.isBlockedSecretFile("docs/arquitetura.pdf"), false);

    const inspection = await rag.inspectLinkedFolder(tempLinkedFolder);
    assert.equal(inspection.valid, true);
    assert.equal(inspection.blockedSecrets, 4); // .env, .env.production, private.pem, server.key
    assert.ok(inspection.ignoredDirs >= 3); // .git, node_modules, dist
    assert.ok(inspection.sampleFiles.some((f) => f.includes("auth.ts")));
    assert.ok(!inspection.sampleFiles.some((f) => f.includes(".env")));
    assert.ok(!inspection.sampleFiles.some((f) => f.includes("node_modules")));
  });

  it("cria projeto, envia arquivo, lê pasta local sem vazar segredos e respeita orçamento Groq vs Gemini", async () => {
    const store = await import("../src/persistence/project-store.js");
    const rag = await import("../src/projects/project-rag.js");
    const budget = await import("../src/shared/context-budget.js");

    const proj = await store.createProject({
      name: "Fintech Core",
      color: "sky",
      instructions: "Sempre priorize segurança financeira e TypeScript estrito.",
      linkedFolderPath: tempLinkedFolder
    });

    assert.ok(proj.id.startsWith("proj_"));

    const uploaded = await store.addProjectFile(proj.id, {
      name: "regras-pix.md",
      kind: "text",
      content: "Regra oficial de Pix: estornos devem ser auditados em tabela imutável com idempotencyKey."
    });

    assert.equal(uploaded.file.name, "regras-pix.md");
    assert.ok(uploaded.file.charCount > 40);

    const resolved = await rag.gatherProjectContext(
      proj.id,
      "Como funciona a taxa de Pix e idempotencyKey?"
    );

    assert.ok(resolved);
    assert.equal(resolved.meta.projectName, "Fintech Core");
    assert.equal(resolved.meta.instructionsApplied, true);
    assert.ok(resolved.chunks.length >= 3);

    // Garante que NENHUM segredo vazou para o contexto
    const joinedAll = resolved.chunks.map((c) => c.content).join("\n");
    assert.ok(!joinedAll.includes("sk-1234567890-NEVER-LEAK"));
    assert.ok(!joinedAll.includes("ultra_secret_password"));
    assert.ok(!joinedAll.includes("SECRET_KEY_MATERIAL"));
    assert.ok(!joinedAll.includes("RAW_TLS_PRIVATE_KEY"));
    assert.ok(!joinedAll.includes("SHOULD_BE_IGNORED"));
    assert.ok(joinedAll.includes("calculatePixFee"));
    assert.ok(joinedAll.includes("idempotencyKey"));

    // Verifica orçamento por IA: Groq recebe bloco bem menor que Gemini
    const groqBlock = rag.buildProjectContextBlock(
      resolved,
      budget.budgetForPlatform("groq").projectContextChars
    );
    const geminiBlock = rag.buildProjectContextBlock(
      resolved,
      budget.budgetForPlatform("gemini").projectContextChars
    );

    assert.ok(groqBlock.includes("Instruções fixas do projeto"));
    assert.ok(groqBlock.length <= budget.budgetForPlatform("groq").projectContextChars + 120);
    assert.ok(geminiBlock.includes("calculatePixFee"));
    assert.ok(geminiBlock.includes("idempotencyKey"));
  });

  it("BM25 seleciona os trechos mais relevantes em bases grandes", async () => {
    const rag = await import("../src/projects/project-rag.js");

    const filler = "Texto genérico sobre infraestrutura de servidores e monitoramento diário. ".repeat(60);
    const docs = Array.from({ length: 10 }, (_, idx) => ({
      sourceName: `modulo-${idx}.md`,
      origin: "upload" as const,
      content:
        idx === 7
          ? `${filler}\n\n## Algoritmo de Conciliação Bancária\nA função reconciliarExtratoOfx usa janela deslizante de 72 horas e chave composta banco_agencia_txid.\n\n${filler}`
          : `${filler}\nSeção padrão número ${idx} sem relação com conciliação.`
    }));

    const result = rag.rankChunksBM25(
      docs,
      "Onde fica a função reconciliarExtratoOfx de conciliação bancária?"
    );

    assert.equal(result.mode, "bm25");
    assert.ok(result.chunks.length > 0);
    assert.equal(result.chunks[0]?.sourceName, "modulo-7.md");
    assert.ok(result.chunks[0]?.content.includes("reconciliarExtratoOfx"));
  });
});
