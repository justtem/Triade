import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isValidCnpjDigits,
  isValidCpfDigits,
  isValidCreditCardLuhn,
  redactAttachmentsForShield,
  redactProjectContextForShield,
  scanAndRedactText
} from "../src/security/privacy-shield.js";
import {
  decryptTextWithKey,
  encryptTextWithKey,
  isEncryptedEnvelope,
  resetDataProtectionCache,
  setEncryptAtRestEnabled,
  setVaultKeyCodecForTests
} from "../src/security/data-protection.js";
import {
  createDebateSession,
  getDebateSessionById
} from "../src/debate/debate-engine.js";
import { resetDebateStorageState } from "../src/persistence/debate-store.js";
import {
  addProjectFile,
  createProject,
  readProjectFileText
} from "../src/persistence/project-store.js";
import {
  invalidateUserMemoryCache,
  readUserMemory,
  upsertUserMemoryFacts
} from "../src/persistence/user-memory-store.js";
import { createMonitorServer } from "../src/server/app.js";

describe("Escudo de Privacidade (DLP Híbrido) & Criptografia em Repouso (AES-256-GCM + DPAPI)", () => {
  it("valida dígitos reais de CPF, CNPJ e cartão (Luhn) sem falsos positivos", () => {
    // CPF válido (fictício de teste) vs inválido
    assert.equal(isValidCpfDigits("529.982.247-25"), true);
    assert.equal(isValidCpfDigits("111.111.111-11"), false);
    assert.equal(isValidCpfDigits("123.456.789-00"), false);

    // CNPJ válido (fictício de teste) vs inválido
    assert.equal(isValidCnpjDigits("11.222.333/0001-81"), true);
    assert.equal(isValidCnpjDigits("11.222.333/0001-00"), false);

    // Cartão Luhn válido (teste padrão Visa 4111...) vs número comum inválido
    assert.equal(isValidCreditCardLuhn("4111 1111 1111 1111"), true);
    assert.equal(isValidCreditCardLuhn("4111 1111 1111 1112"), false);
  });

  it("Modo Estrito (padrão) detecta e mascara segredos, CPF, CNPJ, cartão, e-mail e telefone; Modo Padrão poupa e-mail/telefone", () => {
    const sample = [
      "Meu CPF é 529.982.247-25 e CNPJ 11.222.333/0001-81.",
      "Cartão: 4111-1111-1111-1111.",
      "Chave Gemini: AIzaSyD1234567890abcdefghijk12345.",
      "Contato: maria.silva@exemplo.com.br ou (11) 98765-4321."
    ].join(" ");

    const strictScan = scanAndRedactText(sample, "strict");
    assert.equal(strictScan.hasFindings, true);
    assert.ok(!strictScan.redactedText.includes("529.982.247-25"));
    assert.ok(!strictScan.redactedText.includes("11.222.333/0001-81"));
    assert.ok(!strictScan.redactedText.includes("4111-1111-1111-1111"));
    assert.ok(!strictScan.redactedText.includes("AIzaSyD1234567890abcdefghijk12345"));
    assert.ok(!strictScan.redactedText.includes("maria.silva@exemplo.com.br"));
    assert.ok(!strictScan.redactedText.includes("98765-4321"));
    assert.ok(strictScan.redactedText.includes("[CPF_OCULTO_1]"));
    assert.ok(strictScan.redactedText.includes("[CHAVE_API_OCULTA_1]"));
    assert.ok(strictScan.redactedText.includes("[EMAIL_OCULTO_1]"));
    assert.ok(strictScan.redactedText.includes("[TELEFONE_OCULTO_1]"));

    // Previews retornados para a UI nunca expõem o valor completo
    for (const f of strictScan.findings) {
      for (const p of f.previews) {
        assert.ok(!p.includes("529.982.247-25"));
        assert.ok(!p.includes("AIzaSyD1234567890abcdefghijk12345"));
        assert.ok(!p.includes("4111-1111-1111-1111"));
      }
    }

    // Modo Padrão mascara segredos/CPF/CNPJ/cartão mas mantém e-mail e telefone
    const standardScan = scanAndRedactText(sample, "standard");
    assert.ok(!standardScan.redactedText.includes("529.982.247-25"));
    assert.ok(!standardScan.redactedText.includes("AIzaSyD1234567890abcdefghijk12345"));
    assert.ok(standardScan.redactedText.includes("maria.silva@exemplo.com.br"));
    assert.ok(standardScan.redactedText.includes("(11) 98765-4321"));

    // Modo Off não altera nada
    const offScan = scanAndRedactText(sample, "off");
    assert.equal(offScan.hasFindings, false);
    assert.equal(offScan.redactedText, sample);
  });

  it("Modo Híbrido mascara anexos, remove binário de PDF com dado sensível e mascara contexto de Projeto", () => {
    const attResult = redactAttachmentsForShield(
      [
        {
          name: "contrato.pdf",
          kind: "pdf",
          mimeType: "application/pdf",
          dataBase64: "JVBERi0xLjQK",
          content: "Contratante CPF 529.982.247-25, email cliente@empresa.com.",
          size: 1200
        }
      ],
      "strict"
    );

    assert.equal(attResult.redactedCount, 2);
    assert.equal(attResult.attachments?.[0]?.dataBase64, undefined);
    assert.ok(attResult.attachments?.[0]?.content.includes("[CPF_OCULTO_1]"));
    assert.ok(attResult.attachments?.[0]?.content.includes("[EMAIL_OCULTO_1]"));

    const projResult = redactProjectContextForShield(
      {
        projectId: "proj_1",
        projectName: "Fintech",
        instructions: "Falar com joao@fintech.com.br",
        mode: "full",
        totalFilesScanned: 1,
        chunks: [
          {
            sourceName: "config.ts",
            sourceType: "uploaded",
            content: "const key = 'gsk_1234567890abcdefghijklmnop';"
          }
        ]
      },
      "strict"
    );

    assert.equal(projResult.redactedCount, 2);
    assert.ok(!projResult.context?.instructions.includes("joao@fintech.com.br"));
    assert.ok(!projResult.context?.chunks[0]?.content.includes("gsk_1234567890abcdefghijklmnop"));
  });

  it("AES-256-GCM cifra, decifra e rejeita adulteração do ciphertext", () => {
    const key = Buffer.alloc(32, 7);
    const plain = JSON.stringify({ secret: "conversa privada", ok: true });
    const enc = encryptTextWithKey(plain, key);

    assert.equal(isEncryptedEnvelope(enc), true);
    assert.ok(!enc.includes("conversa privada"));
    assert.equal(decryptTextWithKey(enc, key), plain);

    // Adulteração no auth tag / payload deve lançar erro
    const tampered = `${enc.slice(0, -4)}AAAA`;
    assert.throws(() => decryptTextWithKey(tampered, key));
  });

  describe("Integração HTTP: Escudo Híbrido (409 -> mask/allow) + Criptografia em Repouso (migração on/off)", () => {
    let tempDataDir = "";
    let baseUrl = "";
    let closeServer: () => Promise<void>;

    before(async () => {
      tempDataDir = await mkdtemp(join(tmpdir(), "ai-council-privacy-test-"));
      process.env.AI_COUNCIL_DATA_DIR = tempDataDir;
      resetDataProtectionCache();
      resetDebateStorageState();
      invalidateUserMemoryCache();

      // Codec DPAPI determinístico para testes rápidos e portáveis
      setVaultKeyCodecForTests({
        protect: async (buf) => Buffer.from(buf.map((b) => b ^ 0x5a)),
        unprotect: async (buf) => Buffer.from(buf.map((b) => b ^ 0x5a))
      });

      const { server } = createMonitorServer({
        host: "127.0.0.1",
        port: 0,
        token: "b".repeat(64),
        accessPassword: "SenhaFortePrivacy!2026",
        requirePasswordLocal: false
      });

      await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      closeServer = () => new Promise<void>((res) => server.close(() => res()));
    });

    after(async () => {
      await closeServer?.();
      setVaultKeyCodecForTests(null);
      resetDataProtectionCache();
      resetDebateStorageState();
      invalidateUserMemoryCache();
      delete process.env.AI_COUNCIL_DATA_DIR;
      if (tempDataDir) {
        await rm(tempDataDir, { recursive: true, force: true }).catch(() => {});
      }
    });

    it("retorna 409 PRIVACY_SHIELD_WARNING para prompt com CPF, mascara ao escolher 'mask' e auto-mascara anexos silenciosamente", async () => {
      // 1. Prompt com CPF sem privacyAction -> bloqueia com 409 e não envia
      const warnRes = await fetch(`${baseUrl}/debates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          topic: "Analise o cadastro do CPF 529.982.247-25",
          participants: ["chatgpt"],
          interactionMode: "direct",
          responseMode: "normal",
          webSearchMode: "off"
        })
      });
      assert.equal(warnRes.status, 409);
      const warnBody = (await warnRes.json()) as {
        code: string;
        findings: Array<{ category: string; count: number }>;
      };
      assert.equal(warnBody.code, "PRIVACY_SHIELD_WARNING");
      assert.ok(warnBody.findings.some((f) => f.category === "cpf"));

      // 2. Reenvia com privacyAction="mask" + anexo contendo email -> cria sessão mascarada
      const maskedRes = await fetch(`${baseUrl}/debates`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Cadastro CPF 529.982.247-25",
          topic: "Analise o cadastro do CPF 529.982.247-25",
          participants: ["chatgpt"],
          interactionMode: "direct",
          responseMode: "normal",
          webSearchMode: "off",
          privacyAction: "mask",
          attachments: [
            {
              name: "notas.txt",
              kind: "text",
              mimeType: "text/plain",
              content: "Email interno: diretoria@empresa.com.br",
              size: 40
            }
          ]
        })
      });
      assert.equal(maskedRes.status, 201);
      const maskedBody = (await maskedRes.json()) as {
        debate: { id: string; title: string; topic: string };
        privacyShield: { promptMasked: boolean; attachmentsMaskedCount: number };
      };
      assert.equal(maskedBody.privacyShield.promptMasked, true);
      assert.equal(maskedBody.privacyShield.attachmentsMaskedCount, 1);
      assert.ok(!maskedBody.debate.title.includes("529.982.247-25"));
      assert.ok(!maskedBody.debate.topic.includes("529.982.247-25"));
      assert.ok(maskedBody.debate.topic.includes("[CPF_OCULTO_1]"));

      // Confirma que a task persistida também tem o anexo mascarado
      const stored = await getDebateSessionById(maskedBody.debate.id);
      assert.ok(stored);
      assert.ok(!stored.tasks[0]?.prompt.includes("diretoria@empresa.com.br"));
      assert.ok(stored.tasks[0]?.prompt.includes("[EMAIL_OCULTO_1]"));
    });

    it("ativa criptografia em repouso (AES-256-GCM), cifra arquivos existentes no disco, mantém leitura transparente e decifra ao desativar", async () => {
      // Cria dados reais em debates, projetos e memória pessoal
      const session = await createDebateSession({
        title: "Sessão Confidencial",
        topic: "Plano estratégico secreto",
        participants: ["chatgpt"],
        interactionMode: "direct",
        responseMode: "normal",
        webSearchMode: "off"
      });
      const proj = await createProject({
        name: "Projeto Cofre",
        instructions: "Regra interna secreta"
      });
      const { file } = await addProjectFile(proj.id, {
        name: "doc.txt",
        content: "Conteúdo confidencial do arquivo do projeto."
      });
      await upsertUserMemoryFacts([
        { text: "Prefere respostas curtas em TypeScript", category: "preference" }
      ]);

      // Liga criptografia em repouso -> migra tudo
      const onRes = await setEncryptAtRestEnabled(true);
      assert.equal(onRes.settings.encryptAtRest, true);
      assert.ok(onRes.migratedFiles >= 4);

      // Arquivos brutos no disco devem estar cifrados (AIC_ENC_V1:) e sem texto claro
      const rawSessionFile = await readFile(
        join(tempDataDir, "sessions", `${session.id}.json`),
        "utf8"
      );
      assert.equal(isEncryptedEnvelope(rawSessionFile), true);
      assert.ok(!rawSessionFile.includes("Plano estratégico secreto"));

      const rawProjFile = await readFile(
        join(tempDataDir, "projects", proj.id, "files", `${file.id}.txt`),
        "utf8"
      );
      assert.equal(isEncryptedEnvelope(rawProjFile), true);
      assert.ok(!rawProjFile.includes("Conteúdo confidencial"));

      // Leitura pelas stores e exportação LGPD continuam 100% transparentes
      invalidateUserMemoryCache();
      const loadedSession = await getDebateSessionById(session.id);
      assert.equal(loadedSession?.topic, "Plano estratégico secreto");
      const loadedFileText = await readProjectFileText(proj.id, file.id);
      assert.equal(loadedFileText, "Conteúdo confidencial do arquivo do projeto.");
      const loadedMem = await readUserMemory();
      assert.ok(
        loadedMem.facts.some((f) => f.text.includes("TypeScript"))
      );

      // Desliga criptografia em repouso -> restaura JSON legível sem perder nada
      const offRes = await setEncryptAtRestEnabled(false);
      assert.equal(offRes.settings.encryptAtRest, false);
      assert.ok(offRes.migratedFiles >= 4);

      const plainSessionFile = await readFile(
        join(tempDataDir, "sessions", `${session.id}.json`),
        "utf8"
      );
      assert.equal(isEncryptedEnvelope(plainSessionFile), false);
      assert.ok(plainSessionFile.includes("Plano estratégico secreto"));

      // Alterar criptografia remotamente via HTTP é bloqueado com 403
      const remoteEnc = await fetch(`${baseUrl}/privacy/settings`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          "X-Forwarded-For": "203.0.113.88",
          "X-AI-Council-Password": "SenhaFortePrivacy!2026"
        },
        body: JSON.stringify({ encryptAtRest: true })
      });
      assert.equal(remoteEnc.status, 403);
    });
  });
});
