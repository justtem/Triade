import "dotenv/config";

import {
  getProvider,
  getProvidersStatus,
  initProviders
} from "../src/providers/registry.js";
import { classifyError } from "../src/providers/types.js";
import type { AutoPlatform } from "../src/shared/debate-types.js";

// Testa as três chaves com UMA chamada mínima cada (conta 1 requisição no limite diário).
// Use --dry para só conferir a configuração, sem chamar nenhuma API.

const dry = process.argv.includes("--dry");

async function main(): Promise<void> {
  initProviders();

  const statuses = await getProvidersStatus();

  console.log("\n===== CONFIGURAÇÃO =====\n");

  for (const status of statuses) {
    console.log(`${status.name}: ${status.ready ? "pronto" : "NÃO PRONTO"}`);
    if (status.reason) console.log(`  motivo: ${status.reason}`);
    console.log(`  modelos (em ordem de tentativa): ${status.models.join(", ")}`);

    if (status.usage) {
      const u = status.usage;
      console.log(
        `  hoje (${u.day}): ${u.requestsToday}/${u.requestsDailyCap} requisições` +
          (u.tokensDailyCap ? `, ${u.tokensToday}/${u.tokensDailyCap} tokens` : "")
      );
    }
  }

  if (dry) {
    console.log("\nModo --dry: nenhuma API foi chamada.\n");
    return;
  }

  console.log("\n===== TESTE (1 chamada mínima por provedor) =====\n");

  const ids: AutoPlatform[] = ["gemini", "groq", "openrouter"];

  for (const id of ids) {
    const provider = getProvider(id);

    if (!provider) {
      console.log(`${id}: ignorado (não pronto).`);
      continue;
    }

    const started = Date.now();

    try {
      const result = await provider.generate({
        system: "Responda em uma única palavra, sem pontuação.",
        user: "Diga: OK",
        maxTokens: 20
      });

      console.log(
        `${provider.name}: OK  modelo=${result.model}  tokens=${result.totalTokens ?? "?"}  ${Date.now() - started}ms  resposta="${result.text.slice(0, 40)}"`
      );
    } catch (error) {
      const failure = classifyError(error);
      console.log(
        `${provider.name}: FALHOU (${failure.kind}) ${failure.message.slice(0, 220)}`
      );
    }
  }

  console.log(
    "\nSe um provedor falhou com 'model', troque o modelo no .env. Falha nunca gera cobrança: não há cartão nem créditos cadastrados.\n"
  );
}

main().catch((error) => {
  console.error("Erro inesperado:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
