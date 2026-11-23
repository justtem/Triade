import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { inspectLinkedFolder } from "../src/projects/project-rag.js";
import {
  extractWorkspaceContractSummary,
  readRelevantFilesForFix,
  resolveBuilderProviderOrder
} from "../src/projects/builder-orchestrator.js";
import type { ProviderStatus } from "../src/providers/registry.js";
import {
  planWorkspaceVerification,
  verifyWorkspaceProject
} from "../src/projects/workspace-verifier.js";
import {
  applyWorkspaceChanges,
  BACKUP_ROOT_DIR_NAME,
  extractWorkspaceFilesFromMarkdown,
  listWorkspaceSourceFiles,
  previewWorkspaceChanges,
  undoWorkspaceBackup,
  validateRelativeWorkspacePath
} from "../src/projects/workspace-writer.js";
import { createMonitorServer } from "../src/server/app.js";

describe("Modo Construtor (Fase 3) — Sandbox, Diff, Backup/Undo, Verifier & Remote 403", () => {
  it("bloqueia rigorosamente path traversal, caminhos absolutos, segredos, .git, node_modules e binários", () => {
    assert.equal(validateRelativeWorkspacePath("src/index.ts").valid, true);
    assert.equal(validateRelativeWorkspacePath("package.json").valid, true);
    assert.equal(validateRelativeWorkspacePath("tests/app.test.ts").valid, true);

    const blocked = [
      "../fora.ts",
      "src/../../etc/passwd",
      "/etc/passwd",
      "C:\\Windows\\system32\\evil.ts",
      ".env",
      ".env.local",
      "config/.env.production",
      ".git/config",
      "node_modules/pkg/index.js",
      `${BACKUP_ROOT_DIR_NAME}/batch/manifest.json`,
      "certs/server.pem",
      "keys/private.key",
      "bin/dropper.exe",
      "CON.txt"
    ];

    for (const badPath of blocked) {
      const check = validateRelativeWorkspacePath(badPath);
      assert.equal(check.valid, false, `Deveria bloquear: ${badPath}`);
    }
  });

  it("extrai arquivos de Markdown (headings, info-string e comentários) e detecta faltantes/resumidos", () => {
    const md = [
      "Estrutura planejada:",
      "├── src/index.ts",
      "├── src/math.ts",
      "└── src/missing.ts",
      "",
      "### `src/index.ts`",
      "```ts",
      "export const appName = 'demo';",
      "```",
      "",
      "```ts:src/math.ts",
      "export function sum(a: number, b: number) {",
      "  // ... resto do código omitido",
      "  return a + b;",
      "}",
      "```"
    ].join("\n");

    const res = extractWorkspaceFilesFromMarkdown(md);
    assert.equal(res.files.length, 2);
    assert.equal(res.files[0]?.path, "src/index.ts");
    assert.equal(res.files[0]?.incomplete, false);
    assert.equal(res.files[1]?.path, "src/math.ts");
    assert.equal(res.files[1]?.incomplete, true);
    assert.ok(res.missingPaths.includes("src/missing.ts"));
  });

  it("gera diff, aplica arquivos com backup em .ai-council-backup/ e desfaz restaurando exatamente o estado anterior", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aic-builder-test-"));
    try {
      await writeFile(join(dir, "existing.txt"), "versao original\nlinha 2\n", "utf8");
      await writeFile(join(dir, "untouched.txt"), "nao mexer", "utf8");

      const preview = await previewWorkspaceChanges(dir, [
        { path: "existing.txt", content: "versao nova\nlinha 2\nlinha 3\n", incomplete: false },
        { path: "src/created.ts", content: "export const ok = true;\n", incomplete: false },
        { path: ".env", content: "SECRET=123", incomplete: false }
      ]);

      assert.equal(preview.find((f) => f.path === "existing.txt")?.action, "overwrite");
      assert.equal(preview.find((f) => f.path === "src/created.ts")?.action, "create");
      assert.equal(preview.find((f) => f.path === ".env")?.action, "blocked");

      const applied = await applyWorkspaceChanges(dir, [
        { path: "existing.txt", content: "versao nova\nlinha 2\nlinha 3\n" },
        { path: "src/created.ts", content: "export const ok = true;\n" },
        { path: ".env", content: "SECRET=123" }
      ]);

      assert.ok(applied.backup);
      assert.deepEqual(applied.backup.filesCreated, ["src/created.ts"]);
      assert.deepEqual(applied.backup.filesOverwritten, ["existing.txt"]);
      assert.ok(applied.backup.backupRelDir.startsWith(`${BACKUP_ROOT_DIR_NAME}/`));

      assert.equal(
        await readFile(join(dir, "existing.txt"), "utf8"),
        "versao nova\nlinha 2\nlinha 3\n"
      );
      assert.equal(
        await readFile(join(dir, "src", "created.ts"), "utf8"),
        "export const ok = true;\n"
      );
      // .env bloqueado nunca pode ter sido criado
      await assert.rejects(() => access(join(dir, ".env")));

      // Confirma que project-rag ignora .ai-council-backup/
      const ragCheck = await inspectLinkedFolder(dir);
      assert.equal(ragCheck.valid, true);
      assert.equal(ragCheck.indexableFiles, 3); // existing.txt, untouched.txt, src/created.ts

      // Desfazer restaura existing.txt, remove src/created.ts e preserva untouched.txt
      const undone = await undoWorkspaceBackup(dir, applied.backup.batchId);
      assert.equal(undone.restoredCount, 1);
      assert.equal(undone.removedCreatedCount, 1);
      assert.equal(
        await readFile(join(dir, "existing.txt"), "utf8"),
        "versao original\nlinha 2\n"
      );
      assert.equal(await readFile(join(dir, "untouched.txt"), "utf8"), "nao mexer");
      await assert.rejects(() => access(join(dir, "src", "created.ts")));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("executa apenas scripts allowlisted (build/test) e reporta sucesso e falha corretamente", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aic-verifier-test-"));
    try {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "sample-verify",
          version: "1.0.0",
          scripts: {
            build: "node -e \"process.exit(0)\"",
            test: "node -e \"console.log('tests ok')\""
          }
        }),
        "utf8"
      );

      const planned = await planWorkspaceVerification(dir);
      assert.deepEqual(
        planned.map((p) => p.action),
        ["npm_build", "npm_test"]
      );

      const okRes = await verifyWorkspaceProject(dir);
      assert.equal(okRes.allPassed, true);
      assert.equal(okRes.checks.length, 2);

      // Quebra o script de teste e verifica detecção de falha
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "sample-verify",
          version: "1.0.0",
          scripts: {
            build: "node -e \"process.exit(0)\"",
            test: "node -e \"console.error('ASSERT_FAIL'); process.exit(1)\""
          }
        }),
        "utf8"
      );

      const failRes = await verifyWorkspaceProject(dir);
      assert.equal(failRes.allPassed, false);
      assert.equal(failRes.checks.at(-1)?.ok, false);
      assert.match(failRes.checks.at(-1)?.output ?? "", /ASSERT_FAIL/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("bloqueia /debates/:id/builder/* com HTTP 403 quando acessado via proxy/remoto", async () => {
    const prevDataDir = process.env.AI_COUNCIL_DATA_DIR;
    const isolatedDataDir = await mkdtemp(join(tmpdir(), "aic-builder-srv-data-"));
    process.env.AI_COUNCIL_DATA_DIR = isolatedDataDir;

    const { server } = createMonitorServer({
      host: "127.0.0.1",
      port: 0,
      accessPassword: "StrongTestPassword!99",
      requirePasswordLocal: false
    });

    await new Promise<void>((resolveListen) => {
      server.listen(0, "127.0.0.1", () => resolveListen());
    });

    try {
      const port = (server.address() as AddressInfo).port;
      const base = `http://127.0.0.1:${port}`;

      // Simula cliente remoto passando por proxy reverso HTTPS (Tailscale Serve)
      const loginRes = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "100.64.0.12",
          "X-Forwarded-Proto": "https"
        },
        body: JSON.stringify({ password: "StrongTestPassword!99" })
      });
      assert.equal(loginRes.status, 200);
      const setCookie = loginRes.headers.get("set-cookie") ?? "";
      const cookiePair = setCookie.split(";")[0] ?? "";
      assert.ok(cookiePair.includes("="));

      const builderRes = await fetch(`${base}/debates/sample_123456/builder/apply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookiePair,
          "X-Forwarded-For": "100.64.0.12",
          "X-Forwarded-Proto": "https"
        },
        body: JSON.stringify({})
      });

      assert.equal(builderRes.status, 403);
      const body = (await builderRes.json()) as { error?: string };
      assert.match(body.error ?? "", /PC local/i);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      if (prevDataDir === undefined) {
        delete process.env.AI_COUNCIL_DATA_DIR;
      } else {
        process.env.AI_COUNCIL_DATA_DIR = prevDataDir;
      }
      await rm(isolatedDataDir, { recursive: true, force: true });
    }
  });

  it("extrai diretivas DELETE fora de blocos de código, remove com backup e restaura no Desfazer", async () => {
    const md = [
      "O arquivo compilado antigo está duplicado. Vamos removê-lo:",
      "DELETE: `tests/old.test.js`",
      "DELETE: `.env`",
      "",
      "### `tests/new.test.ts`",
      "```ts",
      "// DELETE: src/nao-deve-remover.ts",
      "export const ok = true;",
      "```"
    ].join("\n");

    const extracted = extractWorkspaceFilesFromMarkdown(md);
    assert.deepEqual(extracted.deletes, ["tests/old.test.js"]);
    assert.equal(extracted.files.length, 1);

    const dir = await mkdtemp(join(tmpdir(), "aic-delete-backup-test-"));
    try {
      await writeFile(join(dir, "keep.txt"), "keep", "utf8");
      await applyWorkspaceChanges(dir, [
        { path: "tests/old.test.js", content: "old stale test\n" },
        { path: "tests/new.test.ts", content: "new test\n" }
      ]);

      const treeBefore = await listWorkspaceSourceFiles(dir);
      assert.ok(treeBefore.includes("tests/old.test.js"));
      assert.ok(treeBefore.includes("tests/new.test.ts"));

      const delRes = await applyWorkspaceChanges(dir, [], {
        deletePaths: ["tests/old.test.js", ".env"]
      });
      assert.ok(delRes.backup);
      assert.deepEqual(delRes.backup.filesDeleted, ["tests/old.test.js"]);
      await assert.rejects(() => access(join(dir, "tests", "old.test.js")));

      const undone = await undoWorkspaceBackup(dir, delRes.backup.batchId);
      assert.equal(undone.restoredCount, 1);
      assert.equal(
        await readFile(join(dir, "tests", "old.test.js"), "utf8"),
        "old stale test\n"
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("detecta TIMEOUT em node --test com servidor aberto e recupera o stack trace oculto via --test-force-exit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aic-timeout-diag-test-"));
    try {
      await writeFile(
        join(dir, "package.json"),
        JSON.stringify({
          name: "sample-timeout-diag",
          version: "1.0.0",
          type: "module",
          scripts: {
            test: "node --test"
          }
        }),
        "utf8"
      );
      await writeFile(
        join(dir, "hang.test.mjs"),
        [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          "import http from 'node:http';",
          "test('falha e deixa servidor aberto', async () => {",
          "  const srv = http.createServer((_req, res) => res.end('ok'));",
          "  await new Promise((r) => srv.listen(0, r));",
          "  assert.equal(201, 200);",
          "});"
        ].join("\n"),
        "utf8"
      );

      const res = await verifyWorkspaceProject(dir, { checkTimeoutMs: 2_500 });
      assert.equal(res.allPassed, false);
      const testCheck = res.checks.at(-1);
      assert.ok(testCheck);
      assert.equal(testCheck.timedOut, true);
      assert.match(testCheck.output, /TIMEOUT/i);
      assert.match(testCheck.output, /DIAGNÓSTICO AUTOMÁTICO/i);
      assert.match(testCheck.output, /201 !== 200/);
      assert.match(testCheck.output, /hang\.test\.mjs/);
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 150 });
    }
  });

  it("Passo 2: resolveBuilderProviderOrder usa Gemini #1 no build/Auto-Fix (com failover NVIDIA/OpenRouter) e Groq em arquivos curtos", () => {
    const mk = (
      id: ProviderStatus["id"],
      requestsToday: number,
      requestsDailyCap: number,
      ready = true
    ): ProviderStatus => ({
      id,
      name: id,
      ready,
      reason: null,
      models: [`${id}-m`],
      usage: {
        provider: id,
        requestsLastMinute: 0,
        requestsPerMinuteCap: 30,
        requestsToday,
        requestsDailyCap,
        tokensLastMinute: 0,
        tokensToday: 0,
        tokensDailyCap: null,
        resetsAt: "2026-11-24T00:00:00Z"
      },
      contextBudget: {
        historyChars: 20_000,
        maxOutputTokens: 4800,
        synthesisOutputTokens: 6400
      }
    });

    const statuses = [
      mk("gemini", 20, 90, true),
      mk("groq", 15, 900, true),
      mk("openrouter", 5, 45, true),
      mk("nvidia", 5, 270, true)
    ];

    // 1. Auto-Fix / arquivo grande (22k chars, 6000 tokens) -> Gemini #1 (precisão TS/velocidade), NVIDIA #2, OpenRouter #3, NUNCA Groq
    const heavyOrder = resolveBuilderProviderOrder({
      promptChars: 22_000,
      maxTokens: 6_000,
      statuses
    });
    assert.equal(heavyOrder[0], "gemini");
    assert.equal(heavyOrder[1], "nvidia");
    assert.equal(heavyOrder[2], "openrouter");
    assert.equal(heavyOrder.includes("groq"), false);

    // 2. Quando Gemini está em queda 503 (todos modelos em cooldown) -> NVIDIA NIM assume #1 na hora!
    const congestedGeminiStatuses: ProviderStatus[] = [
      {
        ...mk("gemini", 20, 90, true),
        autopilot: {
          source: "live",
          lastFetchedAt: "2026-11-23T18:00:00Z",
          discoveredCount: 1,
          activeModels: ["gemini-3.5-flash-lite"],
          primaryModel: "gemini-3.5-flash-lite",
          fastBackupModel: null,
          latenciesMs: {},
          cooledDown: [
            { model: "gemini-3.5-flash-lite", reason: "congested", until: "2026-11-23T19:00:00Z" }
          ]
        }
      },
      mk("groq", 15, 900, true),
      mk("openrouter", 5, 45, true),
      mk("nvidia", 5, 270, true)
    ];
    const failoverOrder = resolveBuilderProviderOrder({
      promptChars: 22_000,
      maxTokens: 6_000,
      statuses: congestedGeminiStatuses
    });
    assert.equal(failoverOrder[0], "nvidia");

    // 3. Arquivo curto (package.json / CSS — 4k chars, 1600 tokens) -> Groq (0,5s / 900 RPD) antes do Gemini
    const lightOrder = resolveBuilderProviderOrder({
      promptChars: 4_000,
      maxTokens: 1_600,
      statuses
    });
    assert.equal(lightOrder[0], "groq");
    assert.equal(lightOrder[1], "gemini");
  });

  it("Passo 2: extractWorkspaceContractSummary extrai exports, rotas e IDs DOM ignorando arquivos incompletos", () => {
    const contract = extractWorkspaceContractSummary([
      {
        path: "package.json",
        content: JSON.stringify({
          type: "module",
          scripts: { build: "tsc", test: "node --test" }
        })
      },
      {
        path: "src/server.ts",
        content: [
          "export interface Expense { id: string; amount: number; }",
          "export function createApp() {",
          '  if (url.pathname === "/api/expenses") return [];',
          "}"
        ].join("\n")
      },
      {
        path: "public/index.html",
        content: '<header><select id="category-filter"></select><button id="export-json-btn">Exportar</button></header>'
      },
      {
        path: "src/truncated.ts",
        content: "export function shouldNeverLeak() { // ...",
        incomplete: true
      }
    ]);

    assert.match(contract, /package\.json.*type="module".*build, test/);
    assert.match(contract, /src\/server\.ts.*exports: Expense, createApp/);
    assert.match(contract, /rotas: \/api\/expenses/);
    assert.match(contract, /public\/index\.html.*#category-filter, #export-json-btn/);
    assert.equal(contract.includes("shouldNeverLeak"), false);
  });

  it("readRelevantFilesForFix lê arquivo citado completo (>10k chars) sem cortar as linhas do erro TS e pula CSS/HTML irrelevantes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aic-fix-context-test-"));
    try {
      await applyWorkspaceChanges(dir, [
        {
          path: "package.json",
          content: JSON.stringify({ name: "cine", scripts: { build: "tsc" } })
        },
        {
          path: "tsconfig.json",
          content: JSON.stringify({ compilerOptions: { strict: true } })
        },
        {
          path: "public/style.css",
          content: `body { color: #fff; }\n${"/* pad */\n".repeat(400)}`
        },
        {
          path: "src/server.ts",
          content: `${"// header line\n".repeat(450)}export function bugAtLine451(): boolean { return sendJson(); }\n`
        }
      ]);

      const tree = await listWorkspaceSourceFiles(dir);
      const loaded = await readRelevantFilesForFix(
        dir,
        "src/server.ts(451,42): error TS2322: Type 'void' is not assignable to type 'boolean'.",
        ["public/style.css", "src/server.ts"],
        tree
      );

      const serverEntry = loaded.find((f) => f.path === "src/server.ts");
      assert.ok(serverEntry);
      assert.match(serverEntry.content, /bugAtLine451/);
      assert.equal(loaded.some((f) => f.path === "public/style.css"), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
