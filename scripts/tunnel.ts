import "dotenv/config";
import { spawn } from "node:child_process";

const PORT = Number(process.env.PORT) || 4317;
const PASSWORD = process.env.ACCESS_PASSWORD?.trim() || "aicouncil2026";

// Remove códigos ANSI que limpam a tela (\x1b[2J, \x1b[H, \x1bc, etc.)
function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "")
    .replace(/\x1bc/g, "")
    .replace(/\r/g, "");
}

console.log("==========================================================");
console.log("AI COUNCIL — TÚNEL HTTPS REMOTO PARA CELULAR");
console.log("==========================================================");
console.log(`Conectando túnel HTTPS para http://127.0.0.1:${PORT} ...`);
console.log(`Senha para desbloquear no celular: ${PASSWORD}`);
console.log("Aguarde 3 segundos enquanto o link HTTPS é gerado...\n");

const sshArgs = [
  "-T",
  "-o",
  "StrictHostKeyChecking=no",
  "-o",
  "ServerAliveInterval=30",
  "-o",
  "ExitOnForwardFailure=yes",
  "-R",
  `80:127.0.0.1:${PORT}`,
  "nokey@localhost.run"
];

const child = spawn("ssh", sshArgs, {
  stdio: ["pipe", "pipe", "pipe"]
});

let printedUrl = "";
let buffer = "";

function handleOutput(chunk: Buffer): void {
  const clean = stripAnsi(chunk.toString("utf8"));
  buffer += clean;

  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Captura exclusivamente o link público do túnel (ex.: https://xxxx.app.lhr.life)
    const match = trimmed.match(/https:\/\/[a-zA-Z0-9.-]+\.lhr\.life/);
    if (match && match[0] !== printedUrl) {
      printedUrl = match[0];
      console.log("==========================================================");
      console.log("✅ LINK HTTPS PRONTO PARA ABRIR NO CELULAR:");
      console.log(`👉  ${printedUrl}`);
      console.log(`🔒  Senha no site: ${PASSWORD}`);
      console.log("==========================================================");
      console.log("(Mantenha este terminal aberto enquanto estiver usando no celular)\n");
    } else if (/permission denied|error:|failed/i.test(trimmed)) {
      console.error(`[Túnel Erro] ${trimmed}`);
    }
  }
}

child.stdout.on("data", handleOutput);
child.stderr.on("data", handleOutput);

child.on("error", (err) => {
  console.error("[AI Council] Erro ao iniciar cliente SSH:", err.message);
});

child.on("close", (code) => {
  console.log(`\n[AI Council] Túnel HTTPS encerrado (código ${code ?? 0}).`);
});
