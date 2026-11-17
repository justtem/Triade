import "dotenv/config";
import { GoogleGenAI } from "@google/genai";

// Lista os modelos disponíveis nas três contas SEM gerar cobrança.
// Nunca imprime as chaves, apenas nomes de modelos.

function section(title: string): void {
  console.log(`\n========== ${title} ==========\n`);
}

async function listGemini(): Promise<void> {
  section("GEMINI (modelos com generateContent)");

  const key = process.env.GEMINI_API_KEY;
  if (!key) {
    console.log("GEMINI_API_KEY ausente no .env");
    return;
  }

  try {
    const ai = new GoogleGenAI({ apiKey: key });
    const pager = await ai.models.list();

    for await (const model of pager) {
      const actions = model.supportedActions ?? [];
      if (actions.includes("generateContent") && model.name) {
        console.log(model.name.replace(/^models\//, ""));
      }
    }
  } catch (error) {
    console.log("Falha ao listar:", error instanceof Error ? error.message : error);
  }
}

async function listGroq(): Promise<void> {
  section("GROQ");

  const key = process.env.GROQ_API_KEY;
  if (!key) {
    console.log("GROQ_API_KEY ausente no .env");
    return;
  }

  try {
    const res = await fetch("https://api.groq.com/openai/v1/models", {
      headers: { Authorization: `Bearer ${key}` }
    });

    if (!res.ok) {
      console.log(`Falha HTTP ${res.status}`);
      return;
    }

    const data = (await res.json()) as { data?: Array<{ id: string }> };
    for (const m of data.data ?? []) {
      console.log(m.id);
    }
  } catch (error) {
    console.log("Falha ao listar:", error instanceof Error ? error.message : error);
  }
}

async function listOpenRouter(): Promise<void> {
  section("OPENROUTER (somente IDs terminando em :free)");

  try {
    const res = await fetch("https://openrouter.ai/api/v1/models");

    if (!res.ok) {
      console.log(`Falha HTTP ${res.status}`);
      return;
    }

    const data = (await res.json()) as { data?: Array<{ id: string }> };
    const free = (data.data ?? []).filter((m) => m.id.endsWith(":free"));

    for (const m of free) {
      console.log(m.id);
    }

    console.log(`\nTotal gratuitos: ${free.length}`);
  } catch (error) {
    console.log("Falha ao listar:", error instanceof Error ? error.message : error);
  }

  const key = process.env.OPENROUTER_API_KEY;
  if (!key) {
    console.log("\nOPENROUTER_API_KEY ausente no .env");
    return;
  }

  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { Authorization: `Bearer ${key}` }
    });

    if (!res.ok) {
      console.log(`\nChave do OpenRouter não validou (HTTP ${res.status}).`);
      return;
    }

    const body = (await res.json()) as { data?: Record<string, unknown> };
    const info = body.data ?? {};

    console.log("\nChave do OpenRouter válida.");
    console.log("Limite diário de modelos gratuitos:", info.free_model_daily_requests ?? "não informado");
    console.log("Limite de crédito da chave:", info.limit ?? "não informado");
  } catch (error) {
    console.log("Falha ao validar chave:", error instanceof Error ? error.message : error);
  }
}

async function main(): Promise<void> {
  await listGemini();
  await listGroq();
  await listOpenRouter();
  console.log("\nConcluído. Copie os nomes que quiser usar (sem chaves) e me envie.\n");
}

main().catch((error) => {
  console.error("Erro inesperado:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
