import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  expandAppBriefingToSpec,
  inferAppKindFromPrompt
} from "../src/projects/app-briefing.js";
import { buildFallbackGrillQuestions } from "../src/projects/app-grill-me.js";
import {
  loadAllLandingArchetypes,
  resetLandingArchetypesCacheForTests,
  selectLandingArchetype
} from "../src/projects/landing-archetypes.js";
import {
  applyImageSlotsToWorkspace,
  ensureDefaultLandingSlotPlaceholders,
  exportStaticLandingBundle,
  hasValidImageMagicBytes,
  isPureImageSlotSwapRequest,
  parseImageSlotAssignments
} from "../src/projects/landing-assets.js";
import { applyWorkspaceChanges } from "../src/projects/workspace-writer.js";

// PNG 1x1 válido em base64 (magic bytes 89 50 4E 47 0D 0A 1A 0A)
const VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";

describe("Onda 4 — Modo Landing Page Pro (Arquétipos, Slots de Imagem & Exportação Estática)", () => {
  it("carrega todos os 5 arquétipos .md e seleciona por nicho ou Grill-me com anti-repetição", async () => {
    resetLandingArchetypesCacheForTests();
    const all = await loadAllLandingArchetypes();
    assert.equal(all.length, 5);
    assert.deepEqual(
      all.map((a) => a.id),
      [
        "bold-conversion",
        "contrast-story",
        "dark-bento",
        "editorial-luxe",
        "local-showcase"
      ]
    );

    const clinic = await selectLandingArchetype({
      prompt: "Crie uma landing page para clínica odontológica premium"
    });
    assert.equal(clinic.archetype?.id, "editorial-luxe");

    // Repetindo o mesmo nicho, anti-repetição alterna para o 2º arquétipo afinado
    const clinic2 = await selectLandingArchetype({
      prompt: "Crie uma landing page para clínica odontológica"
    });
    assert.equal(clinic2.archetype?.id, "contrast-story");

    const cafe = await selectLandingArchetype({
      prompt: "Landing page para cafeteria artesanal no bairro"
    });
    assert.equal(cafe.archetype?.id, "local-showcase");

    // Escolha explícita no Grill-me vence qualquer heurística de domínio
    const fromGrill = await selectLandingArchetype({
      prompt: "Site para clínica odontológica",
      grillAnswers: [
        {
          id: "q_archetype",
          question: "Qual estilo visual?",
          answer: "Dark Bento Tech (escuro cinematográfico)"
        }
      ]
    });
    assert.equal(fromGrill.archetype?.id, "dark-bento");
  });

  it("detecta pedidos de landing/vendas/negócio local, gera Grill-me de conversão e injeta WhatsApp + Formulário + Slots", async () => {
    assert.equal(inferAppKindFromPrompt("Crie uma página de captura de leads para mentoria"), "landing");
    assert.equal(inferAppKindFromPrompt("Site para meu negócio local de barbearia"), "landing");
    assert.equal(inferAppKindFromPrompt("Landing page de vendas para clínica"), "landing");

    const grill = buildFallbackGrillQuestions({
      prompt: "Landing page de vendas para clínica",
      appKind: "landing",
      theme: "light"
    });
    assert.ok(grill.length >= 4);
    assert.ok(grill.some((q) => q.category === "visual" && q.options.some((o) => /Editorial Luxo/i.test(o))));
    assert.ok(grill.some((q) => /Imagem 1, 2, 3/i.test(q.options.join(" "))));

    const { archetype } = await selectLandingArchetype({
      prompt: "Landing page para cafeteria",
      explicitId: "local-showcase"
    });
    const spec = expandAppBriefingToSpec({
      rawIdea: "Landing page para cafeteria artesanal",
      appName: "CafeAurora",
      appKind: "landing",
      theme: "light",
      security: { financial: false, lgpd: false },
      landingArchetype: archetype
    });

    assert.match(spec.expandedPrompt, /POST \/api\/leads/i);
    assert.match(spec.expandedPrompt, /WhatsApp/i);
    assert.match(spec.expandedPrompt, /data-image-slot="1"/i);
    assert.match(spec.expandedPrompt, /Local Showcase/i);
  });

  it("interpreta atribuições naturais de slots (imagem 1, fotos 2 e 3, hero, sequencial) e distingue troca pura vs edição mista", () => {
    assert.deepEqual(parseImageSlotAssignments("Coloque essa foto na imagem 1", 1), [1]);
    assert.deepEqual(parseImageSlotAssignments("Use nas imagens 2 e 3", 2), [2, 3]);
    assert.deepEqual(parseImageSlotAssignments("Coloca no hero e na terceira foto", 2), [1, 3]);
    assert.deepEqual(parseImageSlotAssignments("Adicione essas fotos", 2, [2, 3]), [2, 3]);

    assert.equal(isPureImageSlotSwapRequest("Coloque essa foto na imagem 1"), true);
    assert.equal(isPureImageSlotSwapRequest("Troque a imagem 2 e 3"), true);
    assert.equal(
      isPureImageSlotSwapRequest("Coloque na imagem 1 e mude a cor do cabeçalho para azul"),
      false
    );
  });

  it("gera placeholders SVG locais, valida magic bytes, salva foto em public/assets/slot-N e atualiza public/index.html", async () => {
    const dir = await mkdtemp(join(tmpdir(), "aic-landing-slots-test-"));
    try {
      await applyWorkspaceChanges(dir, [
        {
          path: "public/index.html",
          content: [
            "<!doctype html><html><head><link rel=\"stylesheet\" href=\"/style.css\"></head><body>",
            '<figure data-slot-wrapper="1"><img src="/assets/slot-1.svg" data-image-slot="1" alt="Hero"><figcaption data-slot-placeholder="1">Espaço Imagem 1</figcaption></figure>',
            '<figure data-slot-wrapper="2"><img src="/assets/slot-2.svg" data-image-slot="2" alt="Destaque"><figcaption data-slot-placeholder="2">Espaço Imagem 2</figcaption></figure>',
            '<script src="/app.js"></script></body></html>'
          ].join("\n")
        },
        { path: "public/style.css", content: "body { background: #fff; }" },
        { path: "public/app.js", content: "console.log('ok');" }
      ]);

      // 1. Placeholders SVG são criados automaticamente no disco
      const createdPlaceholders = await ensureDefaultLandingSlotPlaceholders(dir);
      assert.deepEqual(createdPlaceholders, [
        "public/assets/slot-1.svg",
        "public/assets/slot-2.svg"
      ]);
      const svg1 = await readFile(join(dir, "public/assets/slot-1.svg"), "utf8");
      assert.match(svg1, /ESPAÇO IMAGEM 1/);

      // 2. Magic bytes falsos (ex.: script disfarçado de PNG) são bloqueados
      assert.equal(hasValidImageMagicBytes(Buffer.from("<svg><script>alert(1)</script></svg>"), "image/png"), false);
      assert.equal(hasValidImageMagicBytes(Buffer.from(VALID_PNG_BASE64, "base64"), "image/png"), true);

      // 3. Troca real no slot 1 com PNG válido + rejeição de MIME SVG malicioso
      const outcome = await applyImageSlotsToWorkspace(dir, "Coloque essa foto na imagem 1", [
        {
          name: "fachada.png",
          kind: "image",
          mimeType: "image/png",
          dataBase64: VALID_PNG_BASE64,
          content: "",
          size: 68
        },
        {
          name: "xss.svg",
          kind: "image",
          mimeType: "image/svg+xml",
          dataBase64: Buffer.from("<svg><script>alert(1)</script></svg>").toString("base64"),
          content: "",
          size: 36
        }
      ]);

      assert.equal(outcome.savedAssets.length, 1);
      assert.equal(outcome.savedAssets[0]?.slot, 1);
      assert.equal(outcome.savedAssets[0]?.publicUrl, "/assets/slot-1.png");
      assert.equal(outcome.updatedHtml, true);
      assert.deepEqual(outcome.updatedSlotsInHtml, [1]);
      assert.equal(outcome.skippedReasons.length, 1);

      const updatedHtml = await readFile(join(dir, "public/index.html"), "utf8");
      assert.match(updatedHtml, /src="\/assets\/slot-1\.png"/);
      assert.equal(updatedHtml.includes("Espaço Imagem 1"), false);
      assert.match(updatedHtml, /src="\/assets\/slot-2\.svg"/);

      // 4. Exportação estática (deploy-static/) com caminhos relativos + README-PUBLICAR.txt
      const exported = await exportStaticLandingBundle(dir);
      assert.equal(exported.relOutputDir, "deploy-static");
      assert.ok(exported.copiedFiles.includes("index.html"));
      assert.ok(exported.copiedFiles.includes("assets/slot-1.png"));
      assert.ok(exported.copiedFiles.includes("README-PUBLICAR.txt"));

      const exportedHtml = await readFile(join(dir, "deploy-static/index.html"), "utf8");
      assert.match(exportedHtml, /href="\.\/style\.css"/);
      assert.match(exportedHtml, /src="\.\/app\.js"/);
      assert.match(exportedHtml, /src="\.\/assets\/slot-1\.png"/);
      const readmeStat = await stat(join(dir, "deploy-static/README-PUBLICAR.txt"));
      assert.ok(readmeStat.size > 100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
