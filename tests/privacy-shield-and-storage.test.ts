import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  isVaultLocked,
  lockMasterVault,
  resetDataProtectionCache,
  setEncryptAtRestEnabled,
  setVaultKeyCodecForTests,
  setupMasterPasswordVault,
  touchVaultActivity,
  unlockMasterVault
} from "../src/security/data-protection.js";
import {
  scanImageAttachmentForPrivacy,
  setImageOcrRunnerForTests
} from "../src/security/image-ocr.js";
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
  createPromptTemplate,
  listPromptTemplates
} from "../src/persistence/template-store.js";
import {
  invalidateUserMemoryCache,
  readUserMemory,
  upsertUserMemoryFacts
} from "../src/persistence/user-memory-store.js";
import { readMonitorEvents } from "../src/server/events-store.js";
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
    let tempEnvPath = "";
    let baseUrl = "";
    let closeServer: () => Promise<void>;

    before(async () => {
      tempDataDir = await mkdtemp(join(tmpdir(), "ai-council-privacy-test-"));
      tempEnvPath = join(tempDataDir, ".env.test");
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
        requirePasswordLocal: false,
        envPath: tempEnvPath
      });

      await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      closeServer = () => new Promise<void>((res) => server.close(() => res()));
    });

    after(async () => {
      await closeServer?.();
      setImageOcrRunnerForTests(null);
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
      await createPromptTemplate({
        title: "Template Confidencial",
        prompt: "Revise arquitetura interna sigilosa",
        tag: "INTERNO"
      });
      await writeFile(
        join(tempDataDir, "monitor-events.json"),
        JSON.stringify(
          [
            {
              source: "chatgpt",
              severity: "warning",
              signal: "approaching_usage_limit",
              confidence: "high",
              message: "Aviso de teste",
              matchedText: "limite próximo",
              url: "https://chatgpt.com",
              observedAt: new Date().toISOString()
            }
          ],
          null,
          2
        ),
        "utf8"
      );

      // Liga criptografia em repouso -> migra tudo (debates, projetos, memória, templates e monitor-events)
      const onRes = await setEncryptAtRestEnabled(true);
      assert.equal(onRes.settings.encryptAtRest, true);
      assert.ok(onRes.migratedFiles >= 6);

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

      const rawTemplatesFile = await readFile(
        join(tempDataDir, "templates.json"),
        "utf8"
      );
      assert.equal(isEncryptedEnvelope(rawTemplatesFile), true);
      assert.ok(!rawTemplatesFile.includes("Template Confidencial"));

      const rawEventsFile = await readFile(
        join(tempDataDir, "monitor-events.json"),
        "utf8"
      );
      assert.equal(isEncryptedEnvelope(rawEventsFile), true);
      assert.ok(!rawEventsFile.includes("Aviso de teste"));

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
      const loadedTemplates = await listPromptTemplates();
      assert.ok(loadedTemplates.some((t) => t.title === "Template Confidencial"));
      const loadedEvents = await readMonitorEvents();
      assert.equal(loadedEvents.length, 1);
      assert.equal(loadedEvents[0]?.message, "Aviso de teste");

      // Desliga criptografia em repouso -> restaura JSON legível sem perder nada
      const offRes = await setEncryptAtRestEnabled(false);
      assert.equal(offRes.settings.encryptAtRest, false);
      assert.ok(offRes.migratedFiles >= 6);

      const plainTemplatesFile = await readFile(
        join(tempDataDir, "templates.json"),
        "utf8"
      );
      assert.equal(isEncryptedEnvelope(plainTemplatesFile), false);
      assert.ok(plainTemplatesFile.includes("Template Confidencial"));

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

    it("OCR local detecta CPF em imagem anexada, retorna 409 com sensitiveBoxes e protege na saída", async () => {
      setImageOcrRunnerForTests(async (buf) => {
        const marker = buf.toString("utf8");
        if (marker.includes("TARJADA")) {
          return {
            supported: true,
            text: "Tela limpa sem dados",
            words: [{ text: "Tela", x: 10, y: 10, width: 40, height: 18 }],
            width: 400,
            height: 200
          };
        }
        return {
          supported: true,
          text: "Cliente CPF 529.982.247-25 ativo",
          words: [
            { text: "Cliente", x: 10, y: 20, width: 60, height: 18 },
            { text: "CPF", x: 80, y: 20, width: 35, height: 18 },
            { text: "529.982.247-25", x: 120, y: 20, width: 130, height: 18 },
            { text: "ativo", x: 260, y: 20, width: 45, height: 18 }
          ],
          width: 400,
          height: 200
        };
      });

      try {
        const fakeImgB64 = Buffer.from("RAW_IMAGE_WITH_CPF").toString("base64");
        const scan = await scanImageAttachmentForPrivacy(
          {
            name: "print.png",
            kind: "image",
            mimeType: "image/png",
            dataBase64: fakeImgB64,
            content: "",
            size: 32
          },
          "strict"
        );
        assert.equal(scan.hasFindings, true);
        assert.ok(scan.sensitiveBoxes.length >= 1);
        assert.ok(scan.sensitiveBoxes[0]!.x <= 120);

        // Prompt limpo + print com CPF -> 409 com imageFindings e sensitiveBoxes
        const warnRes = await fetch(`${baseUrl}/debates`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Print da tela",
            topic: "Veja este print de tela",
            participants: ["chatgpt"],
            interactionMode: "direct",
            responseMode: "normal",
            webSearchMode: "off",
            attachments: [
              {
                name: "print.png",
                kind: "image",
                mimeType: "image/png",
                dataBase64: fakeImgB64,
                content: "",
                size: 32
              }
            ]
          })
        });
        assert.equal(warnRes.status, 409);
        const warnBody = (await warnRes.json()) as {
          code: string;
          imageFindings?: Array<{ attachmentName: string; sensitiveBoxes: unknown[] }>;
        };
        assert.equal(warnBody.code, "PRIVACY_SHIELD_WARNING");
        assert.equal(warnBody.imageFindings?.[0]?.attachmentName, "print.png");
        assert.ok((warnBody.imageFindings?.[0]?.sensitiveBoxes.length ?? 0) >= 1);

        // Após tarjar no canvas (imagem limpa), envia com sucesso (201)
        const cleanImgB64 = Buffer.from("IMAGE_TARJADA_OK").toString("base64");
        const okRes = await fetch(`${baseUrl}/debates`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: "Print tarjado",
            topic: "Veja este print tarjado",
            participants: ["chatgpt"],
            interactionMode: "direct",
            responseMode: "normal",
            webSearchMode: "off",
            privacyAction: "mask",
            attachments: [
              {
                name: "print.png",
                kind: "image",
                mimeType: "image/png",
                dataBase64: cleanImgB64,
                content: "",
                size: 32
              }
            ]
          })
        });
        assert.equal(okRes.status, 201);
      } finally {
        setImageOcrRunnerForTests(null);
      }
    });

    it("Cofre com Senha Mestra (scrypt): ativa com Chave de Recuperação, tranca com 423, destranca com senha/recuperação e respeita auto-lock", async () => {
      const setupRes = await fetch(`${baseUrl}/privacy/vault/setup-master`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          masterPassword: "MinhaSenhaMestraSuperForte!2026",
          autoLockMinutes: 15
        })
      });
      assert.equal(setupRes.status, 200);
      const setupJson = (await setupRes.json()) as {
        enabled: boolean;
        recoveryKey: string;
        protection: { vaultMode: string; vaultLocked: boolean };
      };
      assert.equal(setupJson.enabled, true);
      assert.equal(setupJson.protection.vaultMode, "master_password");
      assert.equal(setupJson.protection.vaultLocked, false);
      assert.ok(setupJson.recoveryKey.length >= 24);

      // Tranca manualmente -> /status deve responder 423 VAULT_LOCKED
      const lockRes = await fetch(`${baseUrl}/privacy/vault/lock`, {
        method: "POST"
      });
      assert.equal(lockRes.status, 200);

      const lockedStatus = await fetch(`${baseUrl}/status`);
      assert.equal(lockedStatus.status, 423);
      const lockedBody = (await lockedStatus.json()) as { code: string; vaultLocked: boolean };
      assert.equal(lockedBody.code, "VAULT_LOCKED");
      assert.equal(lockedBody.vaultLocked, true);

      // Senha errada -> 401
      const wrongUnlock = await fetch(`${baseUrl}/privacy/vault/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: "senha-errada-123" })
      });
      assert.equal(wrongUnlock.status, 401);

      // Destranca com a Senha Mestra correta -> 200 e /status volta a responder 200
      const okUnlock = await fetch(`${baseUrl}/privacy/vault/unlock`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ secret: "MinhaSenhaMestraSuperForte!2026" })
      });
      assert.equal(okUnlock.status, 200);

      const unlockedStatus = await fetch(`${baseUrl}/status`);
      assert.equal(unlockedStatus.status, 200);

      // Testa Auto-Lock por inatividade (simula +16 min > 15 min)
      const now = Date.now();
      touchVaultActivity(now);
      assert.equal(await isVaultLocked(now + 5 * 60_000), false);
      assert.equal(await isVaultLocked(now + 16 * 60_000), true);

      // Destranca usando a Chave de Recuperação!
      const recUnlock = await unlockMasterVault(setupJson.recoveryKey, { isRecovery: true });
      assert.equal(recUnlock.unlocked, true);
      assert.equal(recUnlock.usedRecovery, true);
      assert.equal(await isVaultLocked(), false);

      // Volta para modo "off" restaurando arquivos limpos
      const offRes = await fetch(`${baseUrl}/privacy/settings`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vaultMode: "off" })
      });
      assert.equal(offRes.status, 200);
      lockMasterVault();
      assert.equal(await isVaultLocked(), false);
    });

    it("Item #2: sela as 3 chaves de API em data/.secrets.vault removendo-as do .env (preservando ACCESS_PASSWORD), limpa RAM no lock, recarrega no unlock e restaura no off", async () => {
      const prevEnv = {
        GEMINI_API_KEY: process.env.GEMINI_API_KEY,
        GROQ_API_KEY: process.env.GROQ_API_KEY,
        OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
        NVIDIA_API_KEY: process.env.NVIDIA_API_KEY
      };

      const fakeGemini = "AIzaSyTestVaultGeminiKey1234567890";
      const fakeGroq = "gsk_TestVaultGroqKey1234567890abcd";
      const fakeOr = "sk-or-v1-testvaultopenrouter1234567890";

      try {
        await writeFile(
          tempEnvPath,
          [
            "# Configuração de teste",
            `GEMINI_API_KEY=${fakeGemini}`,
            `GROQ_API_KEY=${fakeGroq}`,
            `OPENROUTER_API_KEY=${fakeOr}`,
            "ACCESS_PASSWORD=MinhaSenhaRemotaIntacta!99",
            `MONITOR_TOKEN=${"b".repeat(64)}`,
            ""
          ].join("\n"),
          "utf8"
        );
        process.env.GEMINI_API_KEY = fakeGemini;
        process.env.GROQ_API_KEY = fakeGroq;
        process.env.OPENROUTER_API_KEY = fakeOr;
        delete process.env.NVIDIA_API_KEY;

        // Ativa Senha Mestra
        const masterRes = await fetch(`${baseUrl}/privacy/vault/setup-master`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            masterPassword: "SenhaMestraParaChaves!2026",
            autoLockMinutes: 30
          })
        });
        assert.equal(masterRes.status, 200);

        // Bloqueia tentativa remota (403)
        const remoteSeal = await fetch(`${baseUrl}/privacy/vault/seal-keys`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forwarded-For": "203.0.113.90",
            "X-AI-Council-Password": "SenhaFortePrivacy!2026"
          },
          body: JSON.stringify({ seal: true })
        });
        assert.equal(remoteSeal.status, 403);

        // Sela as 3 chaves localmente
        const sealRes = await fetch(`${baseUrl}/privacy/vault/seal-keys`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ seal: true })
        });
        assert.equal(sealRes.status, 200);
        const sealBody = (await sealRes.json()) as {
          sealed: boolean;
          keysCount: number;
          protection: { apiKeysSealed: boolean };
        };
        assert.equal(sealBody.sealed, true);
        assert.equal(sealBody.keysCount, 3);
        assert.equal(sealBody.protection.apiKeysSealed, true);

        // Confirma que .env não tem mais nenhuma chave de IA, mas preservou ACCESS_PASSWORD e MONITOR_TOKEN
        const envAfterSeal = await readFile(tempEnvPath, "utf8");
        assert.ok(!envAfterSeal.includes(fakeGemini));
        assert.ok(!envAfterSeal.includes(fakeGroq));
        assert.ok(!envAfterSeal.includes(fakeOr));
        assert.ok(envAfterSeal.includes("ACCESS_PASSWORD=MinhaSenhaRemotaIntacta!99"));
        assert.ok(envAfterSeal.includes(`MONITOR_TOKEN=${"b".repeat(64)}`));

        // Confirma que .secrets.vault existe e está cifrado (AIC_ENC_V1:)
        const rawSecrets = await readFile(join(tempDataDir, ".secrets.vault"), "utf8");
        assert.equal(isEncryptedEnvelope(rawSecrets), true);
        assert.ok(!rawSecrets.includes(fakeGemini));

        // Ao trancar o cofre, chaves somem da RAM (process.env)
        const lockRes = await fetch(`${baseUrl}/privacy/vault/lock`, { method: "POST" });
        assert.equal(lockRes.status, 200);
        assert.equal(process.env.GEMINI_API_KEY, undefined);
        assert.equal(process.env.GROQ_API_KEY, undefined);
        assert.equal(process.env.OPENROUTER_API_KEY, undefined);

        // Ao destrancar, chaves voltam automaticamente para RAM (process.env)
        const unlockRes = await fetch(`${baseUrl}/privacy/vault/unlock`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret: "SenhaMestraParaChaves!2026" })
        });
        assert.equal(unlockRes.status, 200);
        assert.equal(process.env.GEMINI_API_KEY, fakeGemini);
        assert.equal(process.env.GROQ_API_KEY, fakeGroq);
        assert.equal(process.env.OPENROUTER_API_KEY, fakeOr);

        // Ao desligar o cofre (vaultMode = "off"), as 3 chaves são restauradas automaticamente ao .env!
        const offRes = await fetch(`${baseUrl}/privacy/settings`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vaultMode: "off" })
        });
        assert.equal(offRes.status, 200);
        const envRestored = await readFile(tempEnvPath, "utf8");
        assert.ok(envRestored.includes(`GEMINI_API_KEY=${fakeGemini}`));
        assert.ok(envRestored.includes(`GROQ_API_KEY=${fakeGroq}`));
        assert.ok(envRestored.includes(`OPENROUTER_API_KEY=${fakeOr}`));
        assert.ok(envRestored.includes("ACCESS_PASSWORD=MinhaSenhaRemotaIntacta!99"));
      } finally {
        for (const [k, v] of Object.entries(prevEnv)) {
          if (v === undefined) delete process.env[k];
          else process.env[k] = v;
        }
      }
    });
  });
});
