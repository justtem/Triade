
import "dotenv/config";
import OpenAI from "openai";
import { GoogleGenAI } from "@google/genai";

async function main() {
  const openaiKey = process.env.OPENAI_API_KEY;
  const geminiKey = process.env.GEMINI_API_KEY;

  if (!openaiKey || !geminiKey) {
    throw new Error("Verifique as chaves no arquivo .env");
  }

  // Consultar modelos da OpenAI
  console.log("\n========== OPENAI ==========\n");

  const openai = new OpenAI({
    apiKey: openaiKey
  });

  const openaiModels = await openai.models.list();

  for await (const model of openaiModels) {
    console.log(model.id);
  }

  // Consultar modelos do Google
  console.log("\n========== GEMINI ==========\n");

  const gemini = new GoogleGenAI({
    apiKey: geminiKey
  });

  const geminiModels = await gemini.models.list();

  for await (const model of geminiModels) {
    const actions = model.supportedActions ?? [];

    if (actions.includes("generateContent")) {
      console.log(model.name);
    }
  }
}

main().catch((error) => {
  console.error("\nFalha ao consultar modelos:");
  console.error(error.message);
  process.exitCode = 1;
});
