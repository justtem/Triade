import "dotenv/config";

import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startRunner } from "./debate/runner.js";
import {
  applyNtfsOwnerOnlyPermissions,
  readPrivacySettings
} from "./security/data-protection.js";
import { createMonitorServer } from "./server/app.js";
import { ensureBootstrapEnv, getSetupMissingProviders } from "./server/env-config.js";
import { getLocalWifiAddresses } from "./server/http-utils.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DATA_DIR = process.env.AI_COUNCIL_DATA_DIR
  ? resolve(process.env.AI_COUNCIL_DATA_DIR)
  : resolve(ROOT_DIR, "data");

const HOST = "127.0.0.1";
const LISTEN_HOST = process.env.HOST?.trim() || "0.0.0.0";
const PORT = Number(process.env.PORT) || 4317;

async function main(): Promise<void> {
  const bootstrap = await ensureBootstrapEnv(ROOT_DIR);
  if (bootstrap.generatedToken) {
    console.log(
      "[AI Council] Arquivo .env inicializado automaticamente com MONITOR_TOKEN seguro."
    );
  }

  await mkdir(DATA_DIR, { recursive: true });

  const ntfsResult = await applyNtfsOwnerOnlyPermissions([
    bootstrap.envPath,
    DATA_DIR
  ]);
  const privacySettings = await readPrivacySettings();

  const { server, auth } = createMonitorServer({
    host: HOST,
    port: PORT,
    token: bootstrap.token,
    envPath: bootstrap.envPath
  });

  server.listen(PORT, LISTEN_HOST, () => {
    const wifiIps = getLocalWifiAddresses();
    const missingProviders = getSetupMissingProviders();
    console.log("==========================================================");
    console.log("AI Council ativo!");
    console.log(`• No PC (Local):       http://${HOST}:${PORT}`);
    if (wifiIps.length > 0) {
      for (const ip of wifiIps) {
        console.log(`• No Celular (Wi-Fi):  http://${ip}:${PORT}`);
      }
    }
    if (missingProviders.length > 0) {
      console.log(
        `• Configuração inicial: abra http://${HOST}:${PORT} no navegador para colar suas 3 chaves gratuitas (${missingProviders.join(", ")}).`
      );
    }
    console.log("• Acesso remoto:       protegido por ACCESS_PASSWORD + rate-limit (5 erros / 15 min)");
    console.log(
      `• Privacidade local:   Escudo DLP (${privacySettings.shieldMode}) | Repouso (${privacySettings.encryptAtRest ? "AES-256-GCM + DPAPI" : "JSON local"}) | NTFS (${ntfsResult.applied ? "restrito ao usuário" : ntfsResult.supported ? "pendente" : "N/A"})`
    );
    if (auth.isUsingWeakDefaultPassword()) {
      console.warn(
        "[AI Council][SEGURANÇA] ATENÇÃO: ACCESS_PASSWORD ainda está no padrão fraco ('aicouncil2026') ou tem menos de 8 caracteres. Defina uma senha forte no .env ou pela tela Chaves & Acesso!"
      );
    }
    console.log("==========================================================");

    startRunner();
  });
}

main().catch((error: unknown) => {
  console.error(
    "Falha ao iniciar monitor:",
    error instanceof Error ? error.message : "Erro desconhecido"
  );
  process.exitCode = 1;
});
