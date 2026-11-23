import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expandAppBriefingToSpec } from "../src/projects/app-briefing.js";
import {
  buildFallbackGrillQuestions,
  parseGrillQuestionsJson,
  shouldAutoTriggerGeneralGrillMe
} from "../src/projects/app-grill-me.js";
import {
  buildLocalCleanTitle,
  sanitizeAutoTitleText,
  scheduleAutoTitleForDebate
} from "../src/debate/auto-title.js";
import {
  createDebateSession,
  getDebateSessionById,
  renameDebateSession
} from "../src/debate/debate-engine.js";
import {
  listDesignSystems,
  parseDesignSystemMarkdown,
  resetDesignSystemsCacheForTests,
  sanitizeMalformedHexes,
  selectDesignSystem,
  toPublicDesignSystemMeta
} from "../src/projects/design-systems.js";
import { createMonitorServer } from "../src/server/app.js";
import { verifyWorkspaceProject } from "../src/projects/workspace-verifier.js";
import { extractWorkspaceFilesFromMarkdown } from "../src/projects/workspace-writer.js";

describe("Design Systems (.md) + Grill-me Adaptativo", () => {
  it("corrige hexes malformados de 5 dígitos sem afetar hexes válidos", () => {
    assert.equal(
      sanitizeMalformedHexes("--bg: #1e1e1; --ok: #1a2b3c; --short: #fff;"),
      "--bg: #1e1e1e; --ok: #1a2b3c; --short: #fff;"
    );
  });

  it("carrega e compacta todos os 8 arquivos .md em design-systems/ em <= 3800 chars com :root, superfícies e componentes", async () => {
    resetDesignSystemsCacheForTests();
    const catalog = await listDesignSystems();

    assert.equal(catalog.length, 8, "Espera 8 arquivos .md no catálogo design-systems/");

    for (const entry of catalog) {
      assert.ok(entry.id.length >= 3);
      assert.ok(entry.name.length >= 2);
      assert.ok(entry.swatches.length > 0, `${entry.id} deve ter swatches`);
      assert.match(entry.accentHex, /^#[0-9a-f]{3,6}$/i);
      assert.match(entry.backgroundHex, /^#[0-9a-f]{3,6}$/i);
      assert.ok(entry.tags.length > 0);
      assert.ok(
        entry.compactPromptBlock.length <= 3_800,
        `${entry.id} compactPromptBlock (${entry.compactPromptBlock.length}) excedeu 3800 chars`
      );
      assert.match(entry.compactPromptBlock, /:root\s*\{/, `${entry.id} deve preservar bloco :root`);
      assert.match(
        entry.compactPromptBlock,
        /Hierarquia de superfícies:/,
        `${entry.id} deve incluir hierarquia de superfícies`
      );
      assert.match(
        entry.compactPromptBlock,
        /Receitas de componentes desta referência:/,
        `${entry.id} deve incluir receitas de componentes`
      );
      assert.match(
        entry.compactPromptBlock,
        /ACABAMENTO VISUAL OBRIGATÓRIO/,
        `${entry.id} deve incluir checklist de acabamento visual`
      );
      assert.doesNotMatch(
        entry.compactPromptBlock,
        /@theme\s*\{/i,
        `${entry.id} não deve duplicar bloco Tailwind @theme`
      );
      assert.doesNotMatch(
        entry.compactPromptBlock,
        /#1e1e1(?![0-9a-f])/i,
        `${entry.id} não deve manter hex typo #1e1e1`
      );
      assert.match(entry.compactPromptBlock, /NUNCA copie nomes de marcas/i);
    }
  });

  it("detecta CSS truncado/contaminado por Markdown e assets HTML faltantes (public/app.js)", () => {
    const truncatedMd = [
      "### `public/index.html`",
      "```html",
      "<!DOCTYPE html>",
      "<html><head><link rel=\"stylesheet\" href=\"/style.css\"></head>",
      "<body><main></main><script type=\"module\" src=\"/app.js\"></script></body></html>",
      "```",
      "",
      "### `public/style.css`",
      "```css",
      ":root { --bg: #001d21; }",
      ".nav-btn {",
      "  color: #e0fee6;",
      "  font-family"
    ].join("\n");

    const res = extractWorkspaceFilesFromMarkdown(truncatedMd);
    const htmlFile = res.files.find((f) => f.path === "public/index.html");
    const cssFile = res.files.find((f) => f.path === "public/style.css");

    assert.equal(htmlFile?.incomplete, false);
    assert.ok(cssFile, "Bloco CSS truncado no fim da resposta deve ser capturado");
    assert.equal(cssFile?.incomplete, true, "CSS sem fechar chave/fence deve ser marcado incomplete=true");
    assert.ok(
      res.missingPaths.includes("public/app.js"),
      "public/app.js citado em <script src='/app.js'> deve entrar automaticamente em missingPaths"
    );

    const leakedCssMd = [
      "### `public/style.css`",
      "```css",
      ".header { color: #fff; }",
      "---",
      "## Visão geral",
      "Texto Markdown vazado dentro do CSS.",
      "```"
    ].join("\n");
    const leakedRes = extractWorkspaceFilesFromMarkdown(leakedCssMd);
    assert.equal(leakedRes.files[0]?.incomplete, true, "CSS com Markdown vazado deve ser marcado incomplete=true");
  });

  it("verifyWorkspaceProject reprova frontend-assets-check quando public/app.js referenciado no HTML não existe", async () => {
    const tmpProj = await mkdtemp(join(tmpdir(), "aic-front-assets-"));
    try {
      await writeFile(
        join(tmpProj, "package.json"),
        JSON.stringify({
          name: "front-check-demo",
          version: "1.0.0",
          scripts: { test: "node -e \"process.exit(0)\"" }
        }),
        "utf8"
      );
      await mkdir(join(tmpProj, "public"), { recursive: true });
      await writeFile(
        join(tmpProj, "public", "index.html"),
        "<!DOCTYPE html><html><head><link rel=\"stylesheet\" href=\"/style.css\"></head><body><script type=\"module\" src=\"/app.js\"></script></body></html>",
        "utf8"
      );
      await writeFile(
        join(tmpProj, "public", "style.css"),
        "body { background: #001d21; color: #e0fee6; }\n",
        "utf8"
      );

      // Falha porque public/app.js não existe
      const failed = await verifyWorkspaceProject(tmpProj);
      assert.equal(failed.allPassed, false);
      const assetCheck = failed.checks.find((c) => c.command === "frontend-assets-check");
      assert.ok(assetCheck, "Deve incluir check frontend-assets-check");
      assert.equal(assetCheck.ok, false);
      assert.match(assetCheck.output, /public\/app\.js/);

      // Agora cria public/app.js válido -> deve aprovar!
      await writeFile(
        join(tmpProj, "public", "app.js"),
        "document.addEventListener('DOMContentLoaded', () => { console.info('ready'); });\n",
        "utf8"
      );
      const passed = await verifyWorkspaceProject(tmpProj);
      assert.equal(passed.allPassed, true);
    } finally {
      await rm(tmpProj, { recursive: true, force: true });
    }
  });

  it("seleciona Design System por ID explícito, matching de cor/vibe, anti-repetição e light_fallback honesto", async () => {
    resetDesignSystemsCacheForTests();
    const catalog = await listDesignSystems();

    // 1. Explícito por ID
    const explicit = selectDesignSystem(catalog, {
      modeOrId: "dovetail-dark-command-center"
    });
    assert.equal(explicit.reason, "explicit");
    assert.equal(explicit.entry?.id, "dovetail-dark-command-center");

    // 2. Desativado ("none")
    const noneRes = selectDesignSystem(catalog, { modeOrId: "none" });
    assert.equal(noneRes.reason, "explicit");
    assert.equal(noneRes.entry, null);

    // 3. Matching por cor/vibe
    const greenMatch = selectDesignSystem(catalog, {
      modeOrId: "auto",
      theme: "dark",
      queryText: "Quero um app de jardinagem com verde esmeralda botânico",
      randomFn: () => 0
    });
    assert.equal(greenMatch.reason, "matched");
    assert.ok(greenMatch.entry?.tags.includes("verde"));

    const violetMatch = selectDesignSystem(catalog, {
      modeOrId: "auto",
      theme: "dark",
      queryText: "Painel moderno em roxo violeta tech",
      randomFn: () => 0
    });
    assert.equal(violetMatch.reason, "matched");
    assert.ok(
      violetMatch.entry?.tags.includes("roxo") ||
        violetMatch.entry?.tags.includes("violeta")
    );

    const terminalMatch = selectDesignSystem(catalog, {
      modeOrId: "auto",
      theme: "dark",
      queryText: "Terminal financeiro estilo bloomberg para ações",
      randomFn: () => 0
    });
    assert.equal(terminalMatch.reason, "matched");
    assert.equal(terminalMatch.entry?.id, "fey-bloomberg-terminal");

    // 4. Random anti-repetição (mesmo com randomFn determinístico = 0)
    resetDesignSystemsCacheForTests();
    const firstRandom = selectDesignSystem(catalog, {
      modeOrId: "random",
      theme: "dark",
      randomFn: () => 0
    });
    const secondRandom = selectDesignSystem(catalog, {
      modeOrId: "random",
      theme: "dark",
      randomFn: () => 0
    });
    assert.equal(firstRandom.reason, "random");
    assert.equal(secondRandom.reason, "random");
    assert.notEqual(
      firstRandom.entry?.id,
      secondRandom.entry?.id,
      "Modo aleatório não deve repetir o último estilo consecutivo"
    );

    // 5. Tema claro no catálogo real escolhe um estilo light (stocketa-neon-aurora)
    const lightReal = selectDesignSystem(catalog, {
      modeOrId: "auto",
      theme: "light",
      queryText: "App simples de lista de tarefas"
    });
    assert.equal(lightReal.entry?.theme, "light");
    assert.equal(lightReal.entry?.id, "stocketa-neon-aurora");

    // 5b. Tema claro quando o catálogo só tem estilos dark -> light_fallback honesto
    const darkOnlyCatalog = catalog.filter((e) => e.theme === "dark");
    const lightFallback = selectDesignSystem(darkOnlyCatalog, {
      modeOrId: "auto",
      theme: "light",
      queryText: "App simples de lista de tarefas"
    });
    assert.equal(lightFallback.reason, "light_fallback");
    assert.equal(lightFallback.entry, null);

    // 6. Quando existe um .md light em uma pasta customizada, seleciona o light!
    const tmpDir = await mkdtemp(join(tmpdir(), "aic-ds-light-"));
    const prevDir = process.env.AI_COUNCIL_DESIGN_SYSTEMS_DIR;
    try {
      await writeFile(
        join(tmpDir, "clean-paper-light.md"),
        [
          "# Clean Paper — Style Reference",
          "> Editorial daylight canvas with crisp ink typography.",
          "**Theme:** light",
          "",
          "## Tokens — Colors",
          "| Name | Hex | Token |",
          "| --- | --- | --- |",
          "| Paper | #ffffff | --color-bg |",
          "| Ink | #111827 | --color-ink |",
          "| Cobalt | #2563eb | --color-accent |",
          "",
          "## Quick Start",
          "```css",
          ":root {",
          "  --color-bg: #ffffff;",
          "  --color-accent: #2563eb;",
          "}",
          "```"
        ].join("\n"),
        "utf8"
      );

      process.env.AI_COUNCIL_DESIGN_SYSTEMS_DIR = tmpDir;
      resetDesignSystemsCacheForTests();
      const lightCatalog = await listDesignSystems();
      assert.equal(lightCatalog.length, 1);

      const pickedLight = selectDesignSystem(lightCatalog, {
        modeOrId: "auto",
        theme: "light",
        queryText: "App de notas minimalista"
      });
      assert.equal(pickedLight.entry?.id, "clean-paper-light");
    } finally {
      if (prevDir === undefined) {
        delete process.env.AI_COUNCIL_DESIGN_SYSTEMS_DIR;
      } else {
        process.env.AI_COUNCIL_DESIGN_SYSTEMS_DIR = prevDir;
      }
      resetDesignSystemsCacheForTests();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("impõe teto de 10 perguntas no Grill-me, garante pergunta visual para web_app e omite em API", () => {
    const fake15 = {
      questions: Array.from({ length: 15 }, (_, idx) => ({
        id: `q${idx + 1}`,
        category: "product",
        question: `Qual decisão de produto número ${idx + 1} você prefere adotar?`,
        options: ["Opção A", "Opção B"]
      }))
    };

    const parsedWeb = parseGrillQuestionsJson(JSON.stringify(fake15), {
      prompt: "Cria um app de finanças pessoais",
      appKind: "web_app",
      theme: "dark"
    });
    assert.equal(parsedWeb.length, 10, "Nunca deve ultrapassar 10 perguntas");
    assert.ok(
      parsedWeb.some((q) => q.category === "visual"),
      "Deve garantir 1 pergunta visual quando não for API pura"
    );

    const parsedApi = parseGrillQuestionsJson("resposta quebrada sem json", {
      prompt: "Cria uma API REST de tarefas",
      appKind: "api",
      theme: "dark"
    });
    assert.ok(parsedApi.length >= 3 && parsedApi.length <= 10);
    assert.equal(
      parsedApi.some((q) => q.category === "visual"),
      false,
      "API pura não precisa de pergunta visual"
    );

    const fallbackWeb = buildFallbackGrillQuestions({
      prompt: "Landing page de portfólio",
      appKind: "landing"
    });
    assert.equal(fallbackWeb.length, 4);
    assert.ok(fallbackWeb.some((q) => q.category === "visual"));

    // Modo geral: classifica ideias amplas, ignora perguntas curtas/factuais e coloca recomendada em options[0]
    assert.equal(shouldAutoTriggerGeneralGrillMe("Me ajuda a planejar um SaaS de agendamentos"), true);
    assert.equal(shouldAutoTriggerGeneralGrillMe("Quero estruturar um plano de estudos de TypeScript"), true);
    assert.equal(shouldAutoTriggerGeneralGrillMe("O que é REST?"), false);
    assert.equal(
      shouldAutoTriggerGeneralGrillMe("Me ajuda a planejar um SaaS, responda rápido sem perguntas"),
      false
    );

    const parsedGeneral = parseGrillQuestionsJson(
      JSON.stringify({
        questions: [
          {
            id: "q1",
            category: "visual",
            question: "Qual foco principal você prefere priorizar?",
            options: ["Opção B", "Opção A ideal"],
            recommended: "Opção A ideal"
          },
          {
            id: "q2",
            category: "product",
            question: "Qual horizonte de prazo você tem em mente?",
            options: ["30 dias", "90 dias"],
            recommended: "30 dias"
          }
        ]
      }),
      { prompt: "Me ajuda a planejar um SaaS", mode: "general" }
    );
    assert.equal(parsedGeneral[0]?.options[0], "Opção A ideal", "Opção recomendada deve vir em 1º lugar");
    assert.equal(
      parsedGeneral.some((q) => q.category === "visual"),
      false,
      "Modo general nunca mantém categoria visual"
    );
  });

  it("Auto-título limpa prefixos locais em 0ms, atualiza via gerador assíncrono e nunca sobrescreve edição manual", async () => {
    assert.equal(
      sanitizeAutoTitleText('Título: "Arquitetura de Microsserviços."'),
      "Arquitetura de Microsserviços"
    );
    const cleanedBlueprint = buildLocalCleanTitle(
      'Crie na pasta o projeto completo e funcional "LivroFluxo" pronto para rodar.\n\nIdeia solicitada pelo usuário:\n"Cria um app de controle de leituras"'
    );
    assert.match(cleanedBlueprint, /LivroFluxo/);
    assert.doesNotMatch(cleanedBlueprint, /Crie na pasta/i);

    const cleanedStack = buildLocalCleanTitle(
      "Stack obrigatória: Node 20\nRefaça completamente o painel financeiro com gráficos"
    );
    assert.doesNotMatch(cleanedStack, /Stack obrigatória/i);
    assert.match(cleanedStack, /painel financeiro/i);

    const prevDataDir = process.env.AI_COUNCIL_DATA_DIR;
    const isolatedDir = await mkdtemp(join(tmpdir(), "aic-autotitle-"));
    process.env.AI_COUNCIL_DATA_DIR = isolatedDir;

    try {
      // Caso 1: conversa sem edição manual -> título atualizado automaticamente
      const s1 = await createDebateSession({
        title: "Ideia inicial crua",
        topic: "Me ajuda a planejar um sistema de gestão de biblioteca",
        participants: ["groq"],
        totalRounds: 1,
        interactionMode: "direct"
      });
      const updated1 = await scheduleAutoTitleForDebate(s1.id, s1.topic, s1.title, {
        forceInTest: true,
        generator: async () => "Gestão de Biblioteca Digital"
      });
      assert.equal(updated1, true);
      const after1 = await getDebateSessionById(s1.id);
      assert.equal(after1?.title, "Gestão de Biblioteca Digital");

      // Caso 2: usuário renomeou manualmente antes do gerador terminar -> NÃO sobrescreve!
      const s2 = await createDebateSession({
        title: "Título provisório",
        topic: "Planejamento de carreira em engenharia",
        participants: ["groq"],
        totalRounds: 1,
        interactionMode: "direct"
      });
      await renameDebateSession(s2.id, "Meu Título Manual");
      const updated2 = await scheduleAutoTitleForDebate(s2.id, s2.topic, "Título provisório", {
        forceInTest: true,
        generator: async () => "Carreira em Engenharia"
      });
      assert.equal(updated2, false);
      const after2 = await getDebateSessionById(s2.id);
      assert.equal(after2?.title, "Meu Título Manual");
    } finally {
      if (prevDataDir === undefined) {
        delete process.env.AI_COUNCIL_DATA_DIR;
      } else {
        process.env.AI_COUNCIL_DATA_DIR = prevDataDir;
      }
      await rm(isolatedDir, { recursive: true, force: true });
    }
  });

  it("injeta decisões do Grill-me e Design System compactado no blueprint expandido", () => {
    const sampleDs = parseDesignSystemMarkdown(
      "sample-emerald.md",
      [
        "# Sample Emerald — Style Reference",
        "> Crisp dark green interface.",
        "**Theme:** dark",
        "## Tokens — Colors",
        "| Emerald | #10b981 | --color-accent |",
        "| Canvas | #0a0f0d | --color-bg |",
        "## Quick Start",
        "```css",
        ":root { --color-bg: #0a0f0d; --color-accent: #10b981; }",
        "```"
      ].join("\n")
    );

    const spec = expandAppBriefingToSpec({
      rawIdea: "Cria um app de controle de hábitos diários",
      appName: "HabitoVerde",
      appKind: "web_app",
      theme: "dark",
      security: { financial: false, lgpd: false },
      designSystem: sampleDs,
      grillAnswers: [
        {
          id: "q1",
          question: "Qual estilo visual prefere?",
          answer: "Verde escuro moderno"
        },
        {
          id: "q2",
          question: "Começar com exemplos?",
          answer: "Sim, 5 hábitos iniciais"
        }
      ]
    });

    assert.match(spec.expandedPrompt, /Decisões refinadas pelo usuário \(Grill-me/i);
    assert.match(spec.expandedPrompt, /Sim, 5 hábitos iniciais/);
    assert.match(spec.expandedPrompt, /DESIGN SYSTEM APLICADO: "Sample Emerald"/);
    assert.match(spec.projectInstructions, /Identidade Visual \(Design System "Sample Emerald"/);
    assert.ok(toPublicDesignSystemMeta(sampleDs).accentHex === "#10b981");
  });

  it("expõe /projects/design-systems e /projects/briefing/grill apenas no PC local (403 remoto, 200 local)", async () => {
    resetDesignSystemsCacheForTests();
    const prevDataDir = process.env.AI_COUNCIL_DATA_DIR;
    const isolatedDataDir = await mkdtemp(join(tmpdir(), "aic-ds-srv-"));
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

      // 1. Login remoto (simulado via proxy)
      const loginRes = await fetch(`${base}/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "100.64.0.18",
          "X-Forwarded-Proto": "https"
        },
        body: JSON.stringify({ password: "StrongTestPassword!99" })
      });
      assert.equal(loginRes.status, 200);
      const cookiePair = (loginRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

      // 2. Bloqueio 403 remoto em /projects/design-systems
      const remoteDs = await fetch(`${base}/projects/design-systems`, {
        headers: {
          Cookie: cookiePair,
          "X-Forwarded-For": "100.64.0.18",
          "X-Forwarded-Proto": "https"
        }
      });
      assert.equal(remoteDs.status, 403);

      // 3. Bloqueio 403 remoto em /projects/briefing/grill
      const remoteGrill = await fetch(`${base}/projects/briefing/grill`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookiePair,
          "X-Forwarded-For": "100.64.0.18",
          "X-Forwarded-Proto": "https"
        },
        body: JSON.stringify({ prompt: "Cria um app de tarefas" })
      });
      assert.equal(remoteGrill.status, 403);

      // 4. Localhost 200 em /projects/design-systems
      const localDs = await fetch(`${base}/projects/design-systems`);
      assert.equal(localDs.status, 200);
      const dsJson = (await localDs.json()) as {
        designSystems: Array<{ id: string }>;
      };
      assert.equal(dsJson.designSystems.length, 8);

      // 5. Localhost 200 em /projects/briefing/analyze inclui catálogo de Design Systems
      const localAnalyze = await fetch(`${base}/projects/briefing/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: "Cria um app financeiro estilo terminal bloomberg" })
      });
      assert.equal(localAnalyze.status, 200);
      const analyzeJson = (await localAnalyze.json()) as {
        analysis: { isNewAppIdea: boolean };
        designSystems: Array<{ id: string }>;
        recommendedDesignSystemId: string | null;
      };
      assert.equal(analyzeJson.analysis.isNewAppIdea, true);
      assert.equal(analyzeJson.designSystems.length, 8);
      assert.equal(analyzeJson.recommendedDesignSystemId, "fey-bloomberg-terminal");

      // 6. Rota /debates/grill-me: 401 sem autenticação remota, 200 autenticado
      const unauthGeneralGrill = await fetch(`${base}/debates/grill-me`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "100.64.0.18",
          "X-Forwarded-Proto": "https"
        },
        body: JSON.stringify({ prompt: "Me ajuda a planejar um SaaS de agendamentos" })
      });
      assert.equal(unauthGeneralGrill.status, 401);

      const authGeneralGrill = await fetch(`${base}/debates/grill-me`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookiePair,
          "X-Forwarded-For": "100.64.0.18",
          "X-Forwarded-Proto": "https"
        },
        body: JSON.stringify({ prompt: "Me ajuda a planejar um SaaS de agendamentos" })
      });
      assert.equal(authGeneralGrill.status, 200);
      const generalGrillJson = (await authGeneralGrill.json()) as {
        questions: Array<{ category: string; options: string[] }>;
      };
      assert.ok(generalGrillJson.questions.length >= 3 && generalGrillJson.questions.length <= 10);
      assert.equal(
        generalGrillJson.questions.some((q) => q.category === "visual"),
        false,
        "Grill-me geral não deve injetar pergunta visual de paleta"
      );
    } finally {
      server.closeAllConnections?.();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      if (prevDataDir === undefined) {
        delete process.env.AI_COUNCIL_DATA_DIR;
      } else {
        process.env.AI_COUNCIL_DATA_DIR = prevDataDir;
      }
      await rm(isolatedDataDir, { recursive: true, force: true });
    }
  });
});
