import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  buildWebContextBlock,
  extractUrlsFromText,
  htmlToCleanText,
  isSafePublicUrl,
  shouldAutoSearchWeb
} from "../src/web/web-context.js";
import { budgetForPlatform } from "../src/shared/context-budget.js";

describe("web-context — Busca na Web, Leitor de Links & Anti-SSRF", () => {
  it("bloqueia URLs locais, LAN, Tailscale e protocolos não-HTTP (anti-SSRF)", () => {
    assert.equal(isSafePublicUrl("https://nodejs.org/en"), true);
    assert.equal(isSafePublicUrl("http://example.com/artigo"), true);

    assert.equal(isSafePublicUrl("http://127.0.0.1:4317/status"), false);
    assert.equal(isSafePublicUrl("http://localhost:4317"), false);
    assert.equal(isSafePublicUrl("http://192.168.1.1/admin"), false);
    assert.equal(isSafePublicUrl("http://10.0.0.5/"), false);
    assert.equal(isSafePublicUrl("http://169.254.169.254/latest/meta-data"), false);
    assert.equal(isSafePublicUrl("https://justem.tail5c7052.ts.net/"), false);
    assert.equal(isSafePublicUrl("http://100.102.52.64:4317/"), false);
    assert.equal(isSafePublicUrl("file:///C:/Windows/win.ini"), false);
    assert.equal(isSafePublicUrl("javascript:alert(1)"), false);
  });

  it("extrai até 3 URLs públicas válidas, desembrulha redirects do Google e ignora IPs privados", () => {
    const text =
      "Leia https://www.google.com/url?sa=t&source=web&url=https://g1.globo.com/tecnologia/&ved=123, veja http://127.0.0.1:4317 e também https://example.com/a.";
    const urls = extractUrlsFromText(text);
    assert.deepEqual(urls, [
      "https://g1.globo.com/tecnologia/",
      "https://example.com/a"
    ]);
  });

  it("ativa busca automática em perguntas normais e pula saudações curtas ou prompts com anexos", () => {
    assert.equal(shouldAutoSearchWeb("Qual a versão mais recente do Node.js?"), true);
    assert.equal(shouldAutoSearchWeb("Como funciona o protocolo HTTP/3?"), true);
    assert.equal(shouldAutoSearchWeb("oi"), false);
    assert.equal(shouldAutoSearchWeb("Obrigado!"), false);
    assert.equal(
      shouldAutoSearchWeb("Revise esse arquivo", { hasAttachments: true }),
      false
    );
    assert.equal(
      shouldAutoSearchWeb("Pesquise na web sobre esse erro do print", {
        hasAttachments: true
      }),
      true
    );
  });

  it("limpa HTML removendo scripts/estilos e extraindo título e conteúdo principal", () => {
    const html = `
      <html>
        <head><title>Artigo &amp; Teste</title><style>body{color:red}</style></head>
        <body>
          <nav>Menu chato</nav>
          <article>
            <h1>Título Principal</h1>
            <p>Conteúdo relevante &quot;limpo&quot; sobre arquitetura.</p>
            <script>console.log("ignorar")</script>
          </article>
          <footer>Rodapé</footer>
        </body>
      </html>
    `;
    const parsed = htmlToCleanText(html);
    assert.equal(parsed.title, "Artigo & Teste");
    assert.ok(parsed.text.includes('Conteúdo relevante "limpo" sobre arquitetura.'));
    assert.ok(!parsed.text.includes("console.log"));
    assert.ok(!parsed.text.includes("Menu chato"));
  });

  it("buildWebContextBlock respeita rigorosamente o orçamento de Groq (2.2k) vs Gemini (6.5k)", () => {
    const sources = [
      {
        index: 1,
        title: "Documentação Oficial",
        url: "https://example.com/docs",
        domain: "example.com",
        snippet: "Resumo curto",
        excerpt: "Texto detalhado ".repeat(400),
        origin: "url" as const,
        fetchedOk: true
      },
      {
        index: 2,
        title: "Notícia Recente",
        url: "https://example.org/news",
        domain: "example.org",
        snippet: "Outro resumo",
        excerpt: "Mais conteúdo ".repeat(300),
        origin: "search" as const,
        fetchedOk: true
      }
    ];

    const groqBlock = buildWebContextBlock(
      sources,
      budgetForPlatform("groq").webContextChars
    );
    const geminiBlock = buildWebContextBlock(
      sources,
      budgetForPlatform("gemini").webContextChars
    );

    assert.ok(groqBlock.length <= budgetForPlatform("groq").webContextChars);
    assert.ok(geminiBlock.length <= budgetForPlatform("gemini").webContextChars);
    assert.ok(geminiBlock.length > groqBlock.length);
    assert.ok(groqBlock.includes("[1] (LINK ENVIADO)"));
  });
});
