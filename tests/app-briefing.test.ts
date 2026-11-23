import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  analyzeAppBriefing,
  detectNewAppIdea,
  detectSecurityProfiles,
  expandAppBriefingToSpec,
  suggestAppNameFromPrompt
} from "../src/projects/app-briefing.js";
import { createMonitorServer } from "../src/server/app.js";

describe("Etapa 2 — Briefing 1-Frase, Sugestão de Pasta & Expansor OWASP/LGPD", () => {
  it("detecta ideias simples de novos apps e ignora perguntas explicativas ou travas negativas", () => {
    assert.equal(detectNewAppIdea("Cria um app de controle de gastos pessoais"), true);
    assert.equal(detectNewAppIdea("Quero fazer uma agenda de pacientes para clínica"), true);
    assert.equal(detectNewAppIdea("Faz um contador de água diário"), true);

    assert.equal(detectNewAppIdea("Explique como criar um app de controle de gastos"), false);
    assert.equal(detectNewAppIdea("Compare React vs Vue para criar um site"), false);
    assert.equal(
      detectNewAppIdea("Crie um plano de app financeiro, mas não altere nada nem crie arquivos"),
      false
    );
  });

  it("detecta perfis Financeiro e LGPD corretamente e bloqueia falsos positivos em jogos/RPG", () => {
    const fin = detectSecurityProfiles("Cria um app de controle de gastos e faturas do mês");
    assert.equal(fin.baseOwasp, true);
    assert.equal(fin.financial, true);
    assert.equal(fin.lgpd, false);

    const lgpd = detectSecurityProfiles("Quero um sistema de agenda de pacientes para dentista");
    assert.equal(lgpd.baseOwasp, true);
    assert.equal(lgpd.financial, false);
    assert.equal(lgpd.lgpd, true);

    const both = detectSecurityProfiles(
      "Monte um sistema de loja com cadastro de clientes, CPF e pagamento via PIX"
    );
    assert.equal(both.financial, true);
    assert.equal(both.lgpd, true);

    // Trava negativa anti-falso-positivo (Cuidado #2)
    const rpg = detectSecurityProfiles("Crie um jogo RPG de loja de poções com moedas e personagens");
    assert.equal(rpg.suppressedAsGame, true);
    assert.equal(rpg.financial, false);
    assert.equal(rpg.lgpd, false);
  });

  it("sugere nome limpo de pasta e gera especificação enxuta OWASP + Financeiro + LGPD sem dependências pesadas", () => {
    assert.equal(suggestAppNameFromPrompt("Cria um app chamado FinPulse de gastos"), "FinPulse");
    assert.equal(
      suggestAppNameFromPrompt("Quero fazer uma agenda de pacientes para clínica"),
      "AgendaPacientesClinica"
    );

    const spec = expandAppBriefingToSpec({
      rawIdea: "Sistema de clínica com cadastro de pacientes e cobrança de mensalidades",
      appName: "ClinicaSegura",
      appKind: "web_app",
      theme: "dark",
      security: { financial: true, lgpd: true }
    });

    assert.match(spec.projectInstructions, /ZERO dependências externas em runtime/i);
    assert.match(spec.projectInstructions, /amountCents/i);
    assert.match(spec.projectInstructions, /Idempotency-Key/i);
    assert.match(spec.projectInstructions, /scryptSync/i);
    assert.match(spec.projectInstructions, /Exportar dados/i);
    assert.match(spec.expandedPrompt, /127\.0\.0\.1:/);
    assert.match(spec.expandedPrompt, /protótipo local/i);
    assert.match(spec.expandedPrompt, /produção pública/i);
    assert.doesNotMatch(spec.expandedPrompt, /100% certificado LGPD/i);
  });

  it("analisa briefing localmente sugerindo pasta base válida", async () => {
    const tmpBase = await mkdtemp(join(tmpdir(), "aic-briefing-base-"));
    try {
      const analysis = await analyzeAppBriefing(
        "Cria um app de controle de gastos pessoais",
        { baseDir: tmpBase }
      );
      assert.equal(analysis.isNewAppIdea, true);
      assert.equal(analysis.security.financial, true);
      assert.equal(analysis.baseDir, tmpBase);
      assert.ok(analysis.folderPath.startsWith(tmpBase));
    } finally {
      await rm(tmpBase, { recursive: true, force: true });
    }
  });

  it("bloqueia /projects/briefing/* com HTTP 403 quando acessado via proxy/remoto", async () => {
    const prevDataDir = process.env.AI_COUNCIL_DATA_DIR;
    const isolatedDataDir = await mkdtemp(join(tmpdir(), "aic-briefing-srv-data-"));
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
      const cookiePair = (loginRes.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

      const res = await fetch(`${base}/projects/briefing/prepare`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: cookiePair,
          "X-Forwarded-For": "100.64.0.12",
          "X-Forwarded-Proto": "https"
        },
        body: JSON.stringify({ prompt: "Cria um app de gastos" })
      });

      assert.equal(res.status, 403);
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
