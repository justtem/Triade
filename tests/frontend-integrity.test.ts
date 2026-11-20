import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const PUBLIC_DIR = resolve("public");
const JS_DIR = resolve(PUBLIC_DIR, "js");

function getFrontendModulePaths(): string[] {
  const jsFiles = readdirSync(JS_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort()
    .map((f) => resolve(JS_DIR, f));
  return [resolve(PUBLIC_DIR, "dashboard.js"), ...jsFiles];
}

describe("Frontend ESM Integrity — Zero Quebras de Modularização", () => {
  it("todos os módulos JS do frontend passam em node --check (sintaxe válida)", () => {
    for (const filePath of getFrontendModulePaths()) {
      execFileSync(process.execPath, ["--check", filePath], { stdio: "pipe" });
    }
  });

  it("o grafo de imports entre módulos do frontend é 100% acíclico", () => {
    const modules = getFrontendModulePaths();
    const graph = new Map<string, string[]>();

    for (const filePath of modules) {
      const src = readFileSync(filePath, "utf8");
      const deps: string[] = [];
      for (const match of src.matchAll(
        /import\s+[\s\S]*?\s+from\s+["'](\.[^"']+)["']/g
      )) {
        const rel = match[1];
        if (rel) {
          deps.push(resolve(dirname(filePath), rel));
        }
      }
      graph.set(filePath, deps);
    }

    const visiting = new Set<string>();
    const visited = new Set<string>();

    function dfs(node: string, stack: string[]): void {
      if (visiting.has(node)) {
        assert.fail(
          `Ciclo de import detectado: ${[...stack, node].join(" -> ")}`
        );
      }
      if (visited.has(node)) return;
      visiting.add(node);
      for (const dep of graph.get(node) ?? []) {
        dfs(dep, [...stack, node]);
      }
      visiting.delete(node);
      visited.add(node);
    }

    for (const node of modules) {
      dfs(node, []);
    }
  });

  it("nenhum módulo usa um símbolo exportado por outro módulo sem importá-lo", () => {
    const modules = getFrontendModulePaths();
    const allExports = new Map<string, string>();

    for (const filePath of modules) {
      const src = readFileSync(filePath, "utf8");
      for (const m of src.matchAll(
        /^export\s+(?:async\s+)?(?:function|const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm
      )) {
        if (m[1]) allExports.set(m[1], filePath);
      }
    }

    const missing: string[] = [];
    for (const filePath of modules) {
      const src = readFileSync(filePath, "utf8");
      const declared = new Set<string>();

      for (const m of src.matchAll(
        /(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)/g
      )) {
        if (m[1]) declared.add(m[1]);
      }
      for (const m of src.matchAll(
        /(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/g
      )) {
        if (m[1]) declared.add(m[1]);
      }
      for (const m of src.matchAll(
        /import\s*\{([\s\S]*?)\}\s*from\s*["'][^"']+["']/g
      )) {
        for (const part of (m[1] ?? "").split(",")) {
          const clean = part.trim().split(/\s+as\s+/).pop()?.trim();
          if (clean) declared.add(clean);
        }
      }

      const lines = src.split(/\r?\n/);
      for (const [sym, owner] of allExports.entries()) {
        if (owner === filePath || declared.has(sym)) continue;
        if (sym === "$" || sym === "$$" || sym === "state") continue;
        const re = new RegExp(`(?<![.\\w"'\`])\\b${sym}\\b(?!\\s*:)`);
        lines.forEach((line, idx) => {
          const trimmed = line.trim();
          if (
            trimmed.startsWith("//") ||
            trimmed.startsWith("*") ||
            trimmed.startsWith("import ")
          ) {
            return;
          }
          if (re.test(line)) {
            missing.push(`${filePath}:${idx + 1} usa '${sym}' sem importar`);
          }
        });
      }
    }

    assert.deepEqual(missing, []);
  });

  it("nenhum módulo referencia propriedades de state sem o prefixo state.", () => {
    const stateSrc = readFileSync(resolve(JS_DIR, "state.js"), "utf8");
    const block = stateSrc.match(/export const state = \{([\s\S]*?)\n\};/)?.[1] ?? "";
    const stateKeys = [...block.matchAll(/^\s+([a-zA-Z0-9_]+)\s*:/gm)]
      .map((m) => m[1])
      .filter((k): k is string => Boolean(k));

    assert.ok(stateKeys.length > 10);

    const issues: string[] = [];
    const stateLines = stateSrc.split(/\r?\n/);
    const stateStartIdx = stateLines.findIndex((l) => l.startsWith("export const state = {"));
    const stateEndIdx =
      stateStartIdx >= 0
        ? stateLines.findIndex((l, i) => i > stateStartIdx && l.trim() === "};")
        : -1;

    for (const filePath of getFrontendModulePaths()) {
      const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
      const isStateFile = filePath.endsWith("state.js");
      lines.forEach((line, idx) => {
        if (isStateFile && stateStartIdx >= 0 && idx >= stateStartIdx && idx <= stateEndIdx) return;
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        for (const key of stateKeys) {
          const re = new RegExp(`(?<![.\\w"'\`])\\b${key}\\b(?!\\s*:)`, "g");
          if (re.test(line)) {
            if (new RegExp(`(const|let|var)\\s+${key}\\b`).test(line)) continue;
            issues.push(`${filePath}:${idx + 1} usa '${key}' sem 'state.'`);
          }
        }
      });
    }

    assert.deepEqual(issues, []);
  });

  it("dashboard.js inicializa e renderiza sessões Direto e Debate (com síntese e anexos) sem erros", async () => {
    const noop = () => {};
    const makeEl = (tag = "div") => ({
      tagName: tag.toUpperCase(),
      hidden: false,
      value: "",
      textContent: "",
      innerHTML: "",
      className: "",
      id: "",
      style: { setProperty: noop },
      dataset: {},
      children: [] as unknown[],
      classList: {
        add: noop,
        remove: noop,
        toggle: () => false,
        contains: () => false
      },
      setAttribute: noop,
      getAttribute: () => null,
      removeAttribute: noop,
      addEventListener: noop,
      querySelector: () => null,
      querySelectorAll: () => [],
      replaceChildren(...args: unknown[]) {
        this.children = args;
      },
      append(...args: unknown[]) {
        this.children.push(...args);
      },
      appendChild(a: unknown) {
        this.children.push(a);
        return a;
      },
      focus: noop,
      select: noop,
      closest: () => null,
      getBoundingClientRect: () => ({ width: 800, height: 600, left: 0, top: 0 })
    });

    const els = new Map<string, ReturnType<typeof makeEl>>();
    const g = globalThis as Record<string, unknown>;
    const origSetInterval = globalThis.setInterval;
    const origSetTimeout = globalThis.setTimeout;
    const timers: ReturnType<typeof setTimeout>[] = [];

    g.setInterval = (() => ({ unref: noop })) as unknown as typeof setInterval;
    g.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number) => {
      const t = origSetTimeout(fn, ms);
      t.unref?.();
      timers.push(t);
      return t;
    }) as unknown as typeof setTimeout;

    g.window = { location: { hostname: "127.0.0.1" }, addEventListener: noop };
    g.localStorage = { getItem: () => null, setItem: noop, removeItem: noop };
    g.requestAnimationFrame = () => 1;
    g.document = {
      readyState: "complete",
      activeElement: null,
      querySelector: (sel: string) => {
        if (!els.has(sel)) els.set(sel, makeEl());
        return els.get(sel);
      },
      querySelectorAll: () => [],
      createElement: (tag: string) => makeEl(tag),
      createTextNode: (t: string) => ({ nodeType: 3, textContent: t }),
      addEventListener: noop
    };
    g.fetch = async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        debates: [],
        templates: [],
        projects: [
          {
            id: "proj_sample123456",
            name: "Fintech Core",
            color: "sky",
            instructions: "Sempre use TypeScript estrito.",
            files: [],
            createdAt: "2026-11-19T12:00:00.000Z",
            updatedAt: "2026-11-19T12:00:00.000Z"
          }
        ],
        providers: [],
        latestEvents: [],
        totalEvents: 0,
        capabilities: { responseModes: true }
      })
    });

    try {
      await import(pathToFileURL(resolve(PUBLIC_DIR, "dashboard.js")).href);
      const stateMod = await import(
        pathToFileURL(resolve(JS_DIR, "state.js")).href
      );
      const chatMod = await import(
        pathToFileURL(resolve(JS_DIR, "chat.js")).href
      );
      const sidebarMod = await import(
        pathToFileURL(resolve(JS_DIR, "sidebar.js")).href
      );

      const sampleDebate = {
        id: "11111111-1111-1111-1111-111111111111",
        title: "Debate Completo com Anexos",
        topic: "Compare estruturas de dados",
        rules: "",
        pinned: true,
        participants: ["gemini", "groq"],
        totalRounds: 1,
        currentRound: 1,
        currentStage: "completed",
        status: "completed",
        responseMode: "prompt_markdown",
        interactionMode: "debate",
        createdAt: "2026-11-19T12:00:00.000Z",
        updatedAt: "2026-11-19T12:00:10.000Z",
        completedAt: "2026-11-19T12:00:10.000Z",
        conclusion: "## Síntese Final\n```js\nconst arr = [1, 2, 3];\n```",
        tasks: [
          {
            id: "t1",
            round: 1,
            stage: "initial_response",
            platform: "gemini",
            seat: "auto",
            status: "completed",
            createdAt: "2026-11-19T12:00:00.000Z",
            completedAt: "2026-11-19T12:00:04.000Z"
          },
          {
            id: "t2",
            round: 1,
            stage: "synthesis",
            platform: "gemini",
            seat: "auto",
            status: "completed",
            createdAt: "2026-11-19T12:00:05.000Z",
            completedAt: "2026-11-19T12:00:10.000Z"
          }
        ],
        responses: [
          {
            id: "r1",
            taskId: "t1",
            round: 1,
            stage: "initial_response",
            platform: "gemini",
            content: "Resposta do **Gemini** com `codigo`.",
            tokens: 120,
            submittedAt: "2026-11-19T12:00:04.000Z"
          },
          {
            id: "r1_groq",
            taskId: "t1_groq",
            round: 1,
            stage: "initial_response",
            platform: "groq",
            content: "Resposta do **Groq** com validação extra.",
            tokens: 95,
            submittedAt: "2026-11-19T12:00:03.000Z"
          },
          {
            id: "r2",
            taskId: "t2",
            round: 1,
            stage: "synthesis",
            platform: "gemini",
            content: "## Síntese Final\n```js\nconst arr = [1, 2, 3];\n```",
            tokens: 180,
            submittedAt: "2026-11-19T12:00:10.000Z"
          }
        ],
        turns: [
          {
            id: "turn_1",
            index: 1,
            prompt: "Compare estruturas de dados",
            rules: "",
            participants: ["gemini", "groq"],
            responseMode: "prompt_markdown",
            interactionMode: "debate",
            totalRounds: 1,
            focus: "backend",
            currentRound: 1,
            currentStage: "completed",
            status: "completed",
            projectContext: {
              projectId: "proj_sample123456",
              projectName: "Fintech Core",
              instructionsApplied: true,
              mode: "bm25",
              totalFilesScanned: 4,
              chunks: [
                {
                  sourceName: "src/billing.ts",
                  origin: "folder",
                  filePath: "src/billing.ts",
                  snippet: "export function calculatePixFee(amountCents: number) { ... }",
                  score: 4.2
                }
              ]
            },
            verdict: {
              judgePlatform: "openrouter",
              winner: "groq",
              winnerReason: "Groq incluiu validação de borda essencial.",
              consensus: ["Usar array tipado"],
              divergences: ["Groq alertou sobre overflow"],
              practicalSummary: "Use a solução do Groq com o exemplo do Gemini.",
              generatedAt: "2026-11-19T12:00:12.000Z"
            },
            conclusion: "## Síntese Final\n```js\nconst arr = [1, 2, 3];\n```",
            attachments: [
              {
                name: "print.png",
                kind: "image",
                mimeType: "image/png",
                dataBase64: "iVBORw0KGgo=",
                size: 1200
              },
              {
                name: "doc.pdf",
                kind: "pdf",
                mimeType: "application/pdf",
                size: 4096
              }
            ],
            createdAt: "2026-11-19T12:00:00.000Z",
            completedAt: "2026-11-19T12:00:10.000Z"
          }
        ]
      };

      stateMod.upsertDebateSessionLocally(sampleDebate);
      stateMod.state.selectedDebateId = sampleDebate.id;
      stateMod.state.lastRenderedChatSignature = "";

      sidebarMod.renderSidebarDebatesList();
      sidebarMod.updateStageTopbar();
      chatMod.renderChatStage();

      const thread = els.get("#chat-thread");
      assert.ok(thread && thread.children.length > 0);
      // Confirma auto-collapse: vencedora (r1_groq) aberta, perdedora (r1) recolhida automaticamente
      assert.equal(stateMod.collapsedResponseIds.has("r1_groq"), false);
      assert.equal(stateMod.collapsedResponseIds.has("r1"), true);
    } finally {
      for (const t of timers) clearTimeout(t);
      g.setInterval = origSetInterval;
      g.setTimeout = origSetTimeout;
    }
  });
});
