import { readFile } from "node:fs/promises";

import type { BuilderCommandRun } from "../shared/debate-types.js";
import {
  listWorkspaceSourceFiles,
  resolveSafeWorkspacePath
} from "./workspace-writer.js";

export type SecurityAuditSeverity = "critical" | "warning";

export interface SecurityAuditFinding {
  severity: SecurityAuditSeverity;
  ruleId: string;
  file: string;
  line: number;
  message: string;
  fixHint: string;
}

export interface WorkspaceSecurityAuditResult {
  auditedFilesCount: number;
  passed: boolean;
  criticalCount: number;
  warningCount: number;
  findings: SecurityAuditFinding[];
  checkRun: BuilderCommandRun;
}

const AUDITED_EXT_RE = /\.(?:ts|tsx|js|jsx|mjs|cjs|html)$/i;
const TEST_PATH_RE = /(?:^|\/)(?:tests?|__tests__|spec)\//i;

function isSafeStaticInnerHtmlLine(line: string): boolean {
  // Permite limpar elemento (el.innerHTML = "") ou inserir string puramente literal sem interpolação
  const m = line.match(/\.innerHTML\s*=\s*(.+?)\s*;?\s*$/);
  if (!m?.[1]) return false;
  const rhs = m[1].trim();
  if (rhs === '""' || rhs === "''" || rhs === "``") return true;
  if (/^(['"])[^'"\\]*\1$/.test(rhs)) return true;
  return false;
}

function scanSourceFileContent(
  relPath: string,
  content: string,
  isTestFile: boolean
): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];
  const lines = content.replace(/\r\n/g, "\n").split("\n");

  if (isTestFile) {
    // Alerta menor em testes HTTP sem closeAllConnections (não bloqueia, apenas informa)
    if (
      /\b(?:createApp|createServer)\b/.test(content) &&
      !/closeAllConnections/.test(content)
    ) {
      findings.push({
        severity: "warning",
        ruleId: "test_missing_close_all_connections",
        file: relPath,
        line: 1,
        message: "Teste HTTP sem server.closeAllConnections?.() no encerramento.",
        fixHint: "Chame server.closeAllConnections?.() antes de server.close() no finally."
      });
    }
    return findings;
  }

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx] ?? "";
    const trimmed = line.trim();
    const lineNo = idx + 1;
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("*")) {
      continue;
    }

    // 1. XSS: innerHTML / outerHTML dinâmico ou document.write
    if (/\.(?:innerHTML|outerHTML)\s*[+]?=/.test(trimmed) && !isSafeStaticInnerHtmlLine(trimmed)) {
      findings.push({
        severity: "critical",
        ruleId: "xss_dynamic_innerhtml",
        file: relPath,
        line: lineNo,
        message: "Atribuição dinâmica a innerHTML/outerHTML (risco de XSS).",
        fixHint: "Use document.createElement() + textContent/replaceChildren() em vez de innerHTML."
      });
    }

    if (/\bdocument\.write\s*\(/.test(trimmed)) {
      findings.push({
        severity: "critical",
        ruleId: "xss_document_write",
        file: relPath,
        line: lineNo,
        message: "Uso de document.write() detectado (risco de XSS).",
        fixHint: "Construa o DOM de forma segura com createElement e textContent."
      });
    }

    // 2. Exposição de rede acidental em 0.0.0.0
    if (
      /(?:\.listen\s*\([^)]*['"`]0\.0\.0\.0['"`])|(?:(?:HOST|host)\s*[:=]\s*['"`]0\.0\.0\.0['"`])/.test(
        trimmed
      )
    ) {
      findings.push({
        severity: "critical",
        ruleId: "network_bind_all_interfaces",
        file: relPath,
        line: lineNo,
        message: "Servidor configurado em 0.0.0.0 (expõe protótipo local na rede).",
        fixHint: "Use bind estrito em '127.0.0.1' por padrão."
      });
    }

    // 3. Hash fraco para senha (md5/sha1/sha256 em contexto de password/senha no mesmo bloco)
    if (/createHash\s*\(\s*['"`](?:md5|sha1|sha256)['"`]\s*\)/i.test(trimmed)) {
      const sameBlockContext: string[] = [trimmed];
      for (let back = 1; back <= 2 && idx - back >= 0; back++) {
        const prevLine = (lines[idx - back] ?? "").trim();
        if (prevLine === "}") break;
        sameBlockContext.push(prevLine);
      }
      if (/\b(?:pass|password|passwd|pwd|senha)\b/i.test(sameBlockContext.join(" "))) {
        findings.push({
          severity: "critical",
          ruleId: "weak_password_hash",
          file: relPath,
          line: lineNo,
          message: "Hash simples (md5/sha1/sha256) usado para senha.",
          fixHint: "Use crypto.scryptSync(password, salt, 64) com salt aleatório e crypto.timingSafeEqual."
        });
      }
    }

    // 4. Vazamento de segredo/PII em console.log
    if (
      /\bconsole\.(?:log|info|debug|warn|error)\s*\([^)]*\b(?:password|passwd|senha|cpf|secret|apikey|api_key|privatekey)\b/i.test(
        trimmed
      )
    ) {
      findings.push({
        severity: "critical",
        ruleId: "pii_secret_console_log",
        file: relPath,
        line: lineNo,
        message: "Possível impressão de senha, CPF ou segredo em console.log.",
        fixHint: "Remova dados sensíveis/PII dos logs ou registre apenas IDs técnicos."
      });
    }

    // 5. Execução arbitrária perigosa (eval / new Function)
    if (/(?:^|[^\w.$])eval\s*\(|\bnew\s+Function\s*\(/.test(trimmed)) {
      findings.push({
        severity: "critical",
        ruleId: "unsafe_dynamic_eval",
        file: relPath,
        line: lineNo,
        message: "Uso de eval() ou new Function() bloqueado por segurança.",
        fixHint: "Substitua por lógica explícita ou JSON.parse()."
      });
    }
  }

  // Alerta menor: servidor HTTP sem headers básicos de segurança
  if (
    /^src\//i.test(relPath) &&
    /\bcreateServer\s*\(/.test(content) &&
    (!/X-Content-Type-Options/i.test(content) || !/X-Frame-Options/i.test(content))
  ) {
    findings.push({
      severity: "warning",
      ruleId: "missing_security_headers",
      file: relPath,
      line: 1,
      message: "Servidor HTTP sem cabeçalhos X-Content-Type-Options / X-Frame-Options.",
      fixHint: "Defina res.setHeader('X-Content-Type-Options', 'nosniff') e res.setHeader('X-Frame-Options', 'DENY')."
    });
  }

  return findings;
}

/**
 * Mini-auditor estático de segurança em 0ms (OWASP/LGPD básico) sobre o código gerado.
 * - Falhas críticas reprovam a verificação e acionam o Auto-Fix automaticamente.
 * - Alertas menores aparecem apenas como informação transparente no card.
 */
export async function auditWorkspaceSecurity(
  rootDir: string
): Promise<WorkspaceSecurityAuditResult> {
  const startedAt = Date.now();
  const allFiles = await listWorkspaceSourceFiles(rootDir, 120);
  const targetFiles = allFiles.filter((p) => AUDITED_EXT_RE.test(p));

  const findings: SecurityAuditFinding[] = [];
  let auditedSourceCount = 0;

  for (const relPath of targetFiles) {
    const isTest = TEST_PATH_RE.test(relPath);
    if (!isTest) auditedSourceCount++;
    try {
      const safe = await resolveSafeWorkspacePath(rootDir, relPath);
      const raw = await readFile(safe.absPath, "utf8");
      if (raw.length > 250_000) continue;
      findings.push(...scanSourceFileContent(safe.relPath, raw, isTest));
    } catch {
      // Ignora arquivos ilegíveis/bloqueados
    }
  }

  const criticals = findings.filter((f) => f.severity === "critical");
  const warnings = findings.filter((f) => f.severity === "warning");
  const passed = criticals.length === 0;
  const durationMs = Math.max(1, Date.now() - startedAt);

  const lines: string[] = [];
  if (passed) {
    lines.push(
      `Auditoria estática aprovada em ${auditedSourceCount} arquivo(s) — 0 falhas críticas (OWASP/LGPD básico).`
    );
    if (warnings.length > 0) {
      lines.push("", `Alertas menores (${warnings.length}) — informativos:`);
      for (const w of warnings.slice(0, 8)) {
        lines.push(`- [AVISO] ${w.file}:${w.line} (${w.ruleId}): ${w.message}`);
      }
    }
  } else {
    lines.push(
      `Auditoria de segurança detectou ${criticals.length} falha(s) crítica(s) — corrigir antes de aprovar:`
    );
    for (const c of criticals.slice(0, 12)) {
      lines.push(
        `- [CRÍTICO] ${c.file}:${c.line} (${c.ruleId}): ${c.message} → Correção: ${c.fixHint}`
      );
    }
    if (warnings.length > 0) {
      lines.push("", `Alertas menores (${warnings.length}):`);
      for (const w of warnings.slice(0, 5)) {
        lines.push(`- [AVISO] ${w.file}:${w.line}: ${w.message}`);
      }
    }
  }

  return {
    auditedFilesCount: auditedSourceCount,
    passed,
    criticalCount: criticals.length,
    warningCount: warnings.length,
    findings,
    checkRun: {
      label: "Auditoria de Segurança",
      command: "security-audit (0ms)",
      exitCode: passed ? 0 : 1,
      ok: passed,
      durationMs,
      output: lines.join("\n")
    }
  };
}
