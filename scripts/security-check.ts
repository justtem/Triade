import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HTML_CONTENT_SECURITY_POLICY } from "../src/server/http-utils.js";

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TSX_CLI_PATH = resolve(ROOT_DIR, "node_modules/tsx/dist/cli.mjs");

interface GateResult {
  name: string;
  ok: boolean;
  detail: string;
  warning?: string;
}

function runGate(name: string, fn: () => { ok: boolean; detail: string; warning?: string }): GateResult {
  try {
    const res = fn();
    return { name, ...res };
  } catch (error) {
    return {
      name,
      ok: false,
      detail: error instanceof Error ? error.message : String(error)
    };
  }
}

const SECRET_FILE_PATTERNS: RegExp[] = [
  /^\.env$/i,
  /^\.env\.(?!example$)/i,
  /^data\//i,
  /\.vault(\.|$)/i,
  /\.secrets\.vault$/i,
  /\.(key|pem|p12|pfx|kdbx)$/i,
  /(^|\/)sessions\.json$/i
];

const HARDCODED_SECRET_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "Google/Gemini API key", regex: /\bAIza[0-9A-Za-z_-]{30,}\b/ },
  { label: "Groq API key", regex: /\bgsk_[0-9A-Za-z]{24,}\b/ },
  { label: "OpenRouter API key", regex: /\bsk-or-v1-[0-9a-fA-F]{32,}\b/ },
  { label: "GitHub PAT", regex: /\b(?:ghp_[0-9A-Za-z]{30,}|github_pat_[0-9A-Za-z_]{30,})\b/ },
  { label: "AWS Access Key", regex: /\bAKIA[0-9A-Z]{16}\b/ },
  {
    label: "Private Key PEM",
    regex:
      /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\r\n]+[A-Za-z0-9+/=\r\n]{40,}-----END [A-Z0-9 ]*PRIVATE KEY-----/
  }
];

const PERSONAL_INFO_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  {
    label: "Hostname Tailscale pessoal (*.tail*.ts.net)",
    regex: /\b[a-z0-9-]+\.tail[0-9a-f]{4,}\.ts\.net\b/i
  },
  {
    label: "IP Tailscale específico (100.65-127.x.x)",
    regex: /\b100\.(?:6[5-9]|[7-9]\d|1[0-1]\d|12[0-7])\.\d{1,3}\.\d{1,3}\b/
  },
  {
    label: "Caminho local com nome de usuário Windows",
    regex: /[A-Za-z]:\\Users\\(?!seu-usuario\b|usuario\b|user\b|username\b|example\b)[A-Za-z0-9._-]+/i
  }
];

function checkGitSecretsGate(): { ok: boolean; detail: string; warning?: string } {
  let trackedFiles: string[] = [];
  try {
    const out = execFileSync("git", ["ls-files"], {
      cwd: ROOT_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    trackedFiles = out
      .split(/\r?\n/)
      .map((f) => f.trim())
      .filter(Boolean);
  } catch {
    return {
      ok: true,
      detail: "Repositório Git não detectado; checagem de git ls-files ignorada.",
      warning: "Execute dentro de um repositório Git para validar rastreamento."
    };
  }

  const forbiddenTracked = trackedFiles.filter((file) =>
    SECRET_FILE_PATTERNS.some((rx) => rx.test(file))
  );
  if (forbiddenTracked.length > 0) {
    return {
      ok: false,
      detail: `Arquivo(s) sensível(is) rastreado(s) no Git: ${forbiddenTracked.join(", ")}`
    };
  }

  // Varredura de segredos hardcoded em código-fonte rastreado (ignora pasta tests/ e bibliotecas public/vendor/)
  const codeFiles = trackedFiles.filter(
    (f) =>
      /^(src|public|scripts)\//.test(f) &&
      !f.startsWith("public/vendor/") &&
      /\.(ts|js|mjs|cjs|html|css|json)$/.test(f) &&
      !f.endsWith("security-check.ts")
  );
  const leakedHits: string[] = [];
  for (const rel of codeFiles) {
    const abs = resolve(ROOT_DIR, rel);
    if (!existsSync(abs)) continue;
    const content = readFileSync(abs, "utf8");
    for (const rule of HARDCODED_SECRET_PATTERNS) {
      if (rule.regex.test(content)) {
        leakedHits.push(`${rel} (${rule.label})`);
      }
    }
  }

  if (leakedHits.length > 0) {
    return {
      ok: false,
      detail: `Possível segredo hardcoded encontrado em: ${leakedHits.join("; ")}`
    };
  }

  // Varredura de informações pessoais / IPs e hostnames privados (inclui tests/ e docs)
  const allTextFiles = trackedFiles.filter(
    (f) =>
      !f.startsWith("public/vendor/") &&
      /\.(ts|js|mjs|cjs|html|css|json|md)$/.test(f) &&
      !f.endsWith("security-check.ts") &&
      f !== "package-lock.json"
  );
  const personalHits: string[] = [];
  for (const rel of allTextFiles) {
    const abs = resolve(ROOT_DIR, rel);
    if (!existsSync(abs)) continue;
    const content = readFileSync(abs, "utf8");
    for (const rule of PERSONAL_INFO_PATTERNS) {
      if (rule.regex.test(content)) {
        personalHits.push(`${rel} (${rule.label})`);
      }
    }
  }

  if (personalHits.length > 0) {
    return {
      ok: false,
      detail: `Informação pessoal/rede privada encontrada em: ${personalHits.join("; ")}`
    };
  }

  return {
    ok: true,
    detail: `${trackedFiles.length} arquivo(s) rastreado(s) verificados — nenhum segredo, IP/hostname privado ou pasta data/ no Git.`
  };
}

function checkCspAndLocalAssetsGate(): { ok: boolean; detail: string } {
  const csp = HTML_CONTENT_SECURITY_POLICY;
  const requiredDirectives = [
    "default-src 'self'",
    "script-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'"
  ];
  const missing = requiredDirectives.filter((d) => !csp.includes(d));
  if (missing.length > 0) {
    return { ok: false, detail: `Diretiva(s) ausente(s) na CSP: ${missing.join(", ")}` };
  }
  if (/unsafe-eval/i.test(csp) || /https?:\/\//i.test(csp)) {
    return {
      ok: false,
      detail: "CSP contém 'unsafe-eval' ou domínio externo (http/https) não permitido."
    };
  }

  const indexHtml = readFileSync(resolve(ROOT_DIR, "public/index.html"), "utf8");
  const externalAssetMatch = indexHtml.match(
    /<(?:script|link)\b[^>]*(?:src|href)\s*=\s*["']https?:\/\/[^"']+["'][^>]*>/i
  );
  if (externalAssetMatch) {
    return {
      ok: false,
      detail: "public/index.html referencia script ou stylesheet de CDN externa."
    };
  }

  return {
    ok: true,
    detail: "CSP 100% self-hosted (object-src 'none', font-src 'self', zero CDNs em index.html)."
  };
}

function checkNpmAuditGate(): { ok: boolean; detail: string; warning?: string } {
  const npmCli = process.env.npm_execpath;
  const res =
    npmCli && existsSync(npmCli)
      ? spawnSync(process.execPath, [npmCli, "audit", "--json"], {
          cwd: ROOT_DIR,
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000
        })
      : spawnSync("cmd.exe", ["/d", "/s", "/c", "npm.cmd audit --json"], {
          cwd: ROOT_DIR,
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000
        });

  if (!res.stdout) {
    return {
      ok: true,
      detail: "npm audit indisponível offline no momento.",
      warning: "Rode 'npm audit' com acesso à internet para checar CVEs."
    };
  }

  const parsed = JSON.parse(res.stdout) as {
    metadata?: {
      vulnerabilities?: {
        info?: number;
        low?: number;
        moderate?: number;
        high?: number;
        critical?: number;
        total?: number;
      };
    };
  };
  const v = parsed.metadata?.vulnerabilities;
  if (!v) {
    return {
      ok: true,
      detail: "npm audit retornou resposta sem tabela de vulnerabilidades.",
      warning: "Verifique conectividade com o registry npm."
    };
  }

  const high = v.high ?? 0;
  const critical = v.critical ?? 0;
  const moderate = v.moderate ?? 0;
  const low = v.low ?? 0;

  if (high > 0 || critical > 0) {
    return {
      ok: false,
      detail: `Vulnerabilidades críticas/altas detectadas: critical=${critical}, high=${high}, moderate=${moderate}, low=${low}.`
    };
  }

  return {
    ok: true,
    detail: `Dependências limpas (critical=0, high=0, moderate=${moderate}, low=${low}).`,
    ...(moderate > 0 || low > 0
      ? { warning: `Existem ${moderate} moderada(s) e ${low} baixa(s) — monitore atualizações.` }
      : {})
  };
}

function checkWindowsNtfsGate(): { ok: boolean; detail: string; warning?: string } {
  if (process.platform !== "win32") {
    return {
      ok: true,
      detail: "Ambiente não-Windows (verificação NTFS icacls aplicável apenas no Windows)."
    };
  }

  const targets = [resolve(ROOT_DIR, ".env"), resolve(ROOT_DIR, "data")].filter((p) =>
    existsSync(p)
  );
  if (targets.length === 0) {
    return {
      ok: true,
      detail: "Arquivos .env e data/ ainda não criados (NTFS será aplicado no primeiro startup)."
    };
  }

  const broadPrincipals = /\b(Everyone|Todos|BUILTIN\\Users|BUILTIN\\Usu[aá]rios|Authenticated Users|Usu[aá]rios Autenticados)\b/i;
  const exposed: string[] = [];

  for (const target of targets) {
    const out = execFileSync("icacls.exe", [target], {
      encoding: "utf8",
      windowsHide: true
    });
    if (broadPrincipals.test(out)) {
      exposed.push(target);
    }
  }

  if (exposed.length > 0) {
    return {
      ok: false,
      detail: `Permissões NTFS amplas detectadas em: ${exposed.join(", ")}. Clique em "Reaplicar NTFS" no Monitor ou reinicie o servidor.`
    };
  }

  return {
    ok: true,
    detail: `Permissões NTFS validadas em ${targets.length} caminho(s) (.env / data) — acesso restrito ao seu usuário + SYSTEM.`
  };
}

function checkSecurityTestsGate(): { ok: boolean; detail: string } {
  const suites = [
    "tests/security-server.test.ts",
    "tests/privacy-shield-and-storage.test.ts",
    "tests/prompt-defense-and-markdown.test.ts",
    "tests/setup-wizard.test.ts",
    "tests/frontend-integrity.test.ts"
  ];

  const res = spawnSync(process.execPath, [TSX_CLI_PATH, "--test", ...suites], {
    cwd: ROOT_DIR,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000
  });

  const combined = `${res.stdout ?? ""}\n${res.stderr ?? ""}`;
  const passMatch = combined.match(/ℹ pass (\d+)/);
  const failMatch = combined.match(/ℹ fail (\d+)/);
  const passed = passMatch?.[1] ?? "?";
  const failed = failMatch?.[1] ?? (res.status === 0 ? "0" : "?");

  if (res.status !== 0) {
    return {
      ok: false,
      detail: `Falha nas suítes de segurança (pass=${passed}, fail=${failed}). Rode 'npm test' para detalhes.`
    };
  }

  return {
    ok: true,
    detail: `${passed} teste(s) de segurança, privacidade e integridade ESM aprovados (fail=0).`
  };
}

function main(): void {
  console.log("==========================================================");
  console.log("AI Council — Auditoria Contínua de Segurança (security:check)");
  console.log("==========================================================");

  const results: GateResult[] = [
    runGate("1. Segredos & Git", checkGitSecretsGate),
    runGate("2. CSP & Ativos 100% Locais", checkCspAndLocalAssetsGate),
    runGate("3. Dependências (npm audit)", checkNpmAuditGate),
    runGate("4. Permissões NTFS (Windows)", checkWindowsNtfsGate),
    runGate("5. Suítes de Segurança & ESM", checkSecurityTestsGate)
  ];

  let allOk = true;
  for (const r of results) {
    const tag = r.ok ? "[OK]" : "[FALHOU]";
    console.log(`${tag} ${r.name}: ${r.detail}`);
    if (r.warning) {
      console.log(`     [AVISO] ${r.warning}`);
    }
    if (!r.ok) allOk = false;
  }

  console.log("==========================================================");
  if (allOk) {
    console.log("Resultado: TODOS os 5 controles automatizados passaram.");
    process.exitCode = 0;
  } else {
    console.error("Resultado: 1 ou mais controles falharam. Corrija antes de commitar.");
    process.exitCode = 1;
  }
}

main();
