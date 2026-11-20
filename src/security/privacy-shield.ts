import type {
  ChatAttachment,
  ResolvedProjectContext
} from "../shared/debate-types.js";

export type PrivacyShieldMode = "strict" | "standard" | "off";
export type PrivacyAction = "mask" | "allow";

export type PrivacyFindingCategory =
  | "private_key"
  | "api_key"
  | "jwt"
  | "credential"
  | "credit_card"
  | "cpf"
  | "cnpj"
  | "email"
  | "phone";

export interface PrivacyFindingSummary {
  category: PrivacyFindingCategory;
  label: string;
  count: number;
  previews: string[];
}

export interface PrivacyScanResult {
  redactedText: string;
  hasFindings: boolean;
  totalMatches: number;
  findings: PrivacyFindingSummary[];
}

const CATEGORY_META: Record<
  PrivacyFindingCategory,
  { label: string; placeholder: string }
> = {
  private_key: { label: "Chave privada (PEM)", placeholder: "CHAVE_PRIVADA_OCULTA" },
  api_key: { label: "Chave de API / Token", placeholder: "CHAVE_API_OCULTA" },
  jwt: { label: "Token JWT", placeholder: "JWT_OCULTO" },
  credential: { label: "Senha / Credencial", placeholder: "SENHA_OCULTA" },
  credit_card: { label: "Cartão de crédito", placeholder: "CARTAO_OCULTO" },
  cpf: { label: "CPF", placeholder: "CPF_OCULTO" },
  cnpj: { label: "CNPJ", placeholder: "CNPJ_OCULTO" },
  email: { label: "E-mail", placeholder: "EMAIL_OCULTO" },
  phone: { label: "Telefone", placeholder: "TELEFONE_OCULTO" }
};

export function normalizePrivacyShieldMode(value: unknown): PrivacyShieldMode {
  if (value === "standard" || value === "off" || value === "strict") {
    return value;
  }
  return "strict";
}

export function normalizePrivacyAction(value: unknown): PrivacyAction | undefined {
  if (value === "mask" || value === "allow") {
    return value;
  }
  return undefined;
}

/** Valida dígitos verificadores de CPF (evita falsos positivos com sequências aleatórias). */
export function isValidCpfDigits(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 11) return false;
  if (/^(\d)\1{10}$/.test(digits)) return false;

  let sum = 0;
  for (let i = 0; i < 9; i++) {
    sum += Number(digits[i]) * (10 - i);
  }
  let check1 = (sum * 10) % 11;
  if (check1 === 10) check1 = 0;
  if (check1 !== Number(digits[9])) return false;

  sum = 0;
  for (let i = 0; i < 10; i++) {
    sum += Number(digits[i]) * (11 - i);
  }
  let check2 = (sum * 10) % 11;
  if (check2 === 10) check2 = 0;
  return check2 === Number(digits[10]);
}

/** Valida dígitos verificadores de CNPJ. */
export function isValidCnpjDigits(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 14) return false;
  if (/^(\d)\1{13}$/.test(digits)) return false;

  const w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
  const w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];

  let sum1 = 0;
  for (let i = 0; i < 12; i++) sum1 += Number(digits[i]) * w1[i]!;
  const r1 = sum1 % 11;
  const d1 = r1 < 2 ? 0 : 11 - r1;
  if (d1 !== Number(digits[12])) return false;

  let sum2 = 0;
  for (let i = 0; i < 13; i++) sum2 += Number(digits[i]) * w2[i]!;
  const r2 = sum2 % 11;
  const d2 = r2 < 2 ? 0 : 11 - r2;
  return d2 === Number(digits[13]);
}

/** Valida número de cartão de crédito via algoritmo de Luhn (13 a 19 dígitos). */
export function isValidCreditCardLuhn(raw: string): boolean {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  if (/^(\d)\1+$/.test(digits)) return false;

  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let digit = Number(digits[i]);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

/** Gera prévia já mascarada para exibição segura na UI (nunca expõe o dado completo). */
function maskPreview(category: PrivacyFindingCategory, rawValue: string): string {
  const clean = rawValue.trim();
  if (category === "private_key") return "-----BEGIN PRIVATE KEY----- ••••";
  if (category === "cpf") {
    const d = clean.replace(/\D/g, "");
    return d.length === 11 ? `${d.slice(0, 3)}.***.***-${d.slice(9)}` : "***.***.***-**";
  }
  if (category === "cnpj") {
    const d = clean.replace(/\D/g, "");
    return d.length === 14 ? `${d.slice(0, 2)}.***.***/****-${d.slice(12)}` : "**.***.***/****-**";
  }
  if (category === "credit_card") {
    const d = clean.replace(/\D/g, "");
    return `•••• •••• •••• ${d.slice(-4)}`;
  }
  if (category === "email") {
    const at = clean.indexOf("@");
    if (at > 0) {
      const user = clean.slice(0, at);
      const domain = clean.slice(at + 1);
      return `${user[0] ?? "*"}***@${domain.slice(0, 2)}***`;
    }
    return "***@***";
  }
  if (category === "phone") {
    const d = clean.replace(/\D/g, "");
    return `(**) *****-${d.slice(-4)}`;
  }
  if (clean.length <= 8) return "••••••••";
  return `${clean.slice(0, 4)}••••${clean.slice(-2)}`;
}

interface Collector {
  counters: Partial<Record<PrivacyFindingCategory, number>>;
  previews: Partial<Record<PrivacyFindingCategory, string[]>>;
}

function recordMatch(
  collector: Collector,
  category: PrivacyFindingCategory,
  rawValue: string
): string {
  const next = (collector.counters[category] ?? 0) + 1;
  collector.counters[category] = next;
  const list = collector.previews[category] ?? [];
  if (list.length < 3) {
    list.push(maskPreview(category, rawValue));
  }
  collector.previews[category] = list;
  return `[${CATEGORY_META[category].placeholder}_${next}]`;
}

function finalizeFindings(collector: Collector): PrivacyFindingSummary[] {
  const order: PrivacyFindingCategory[] = [
    "private_key",
    "api_key",
    "jwt",
    "credential",
    "credit_card",
    "cpf",
    "cnpj",
    "email",
    "phone"
  ];
  const out: PrivacyFindingSummary[] = [];
  for (const cat of order) {
    const count = collector.counters[cat] ?? 0;
    if (count > 0) {
      out.push({
        category: cat,
        label: CATEGORY_META[cat].label,
        count,
        previews: collector.previews[cat] ?? []
      });
    }
  }
  return out;
}

export function mergePrivacyFindings(
  lists: PrivacyFindingSummary[][]
): PrivacyFindingSummary[] {
  const byCat = new Map<PrivacyFindingCategory, PrivacyFindingSummary>();
  for (const list of lists) {
    for (const item of list) {
      const prev = byCat.get(item.category);
      if (!prev) {
        byCat.set(item.category, {
          category: item.category,
          label: item.label,
          count: item.count,
          previews: [...item.previews.slice(0, 3)]
        });
      } else {
        prev.count += item.count;
        for (const p of item.previews) {
          if (prev.previews.length < 3 && !prev.previews.includes(p)) {
            prev.previews.push(p);
          }
        }
      }
    }
  }
  return Array.from(byCat.values());
}

/**
 * Escaneia e mascara dados sensíveis em um texto conforme o modo configurado.
 * - `off`: não analisa nem altera.
 * - `standard`: segredos técnicos (PEM, API keys, JWT, senhas), cartão (Luhn), CPF e CNPJ válidos.
 * - `strict` (padrão): tudo do `standard` + e-mails e telefones.
 */
export function scanAndRedactText(
  text: string,
  mode: PrivacyShieldMode
): PrivacyScanResult {
  if (!text || mode === "off") {
    return {
      redactedText: text ?? "",
      hasFindings: false,
      totalMatches: 0,
      findings: []
    };
  }

  const collector: Collector = { counters: {}, previews: {} };
  let out = text;

  // 1. Blocos PEM / chaves privadas
  out = out.replace(
    /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]{16,}?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    (match) => recordMatch(collector, "private_key", match)
  );

  // 2. Tokens JWT (header.payload.signature)
  out = out.replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    (match) => recordMatch(collector, "jwt", match)
  );

  // 3. Chaves de API / Tokens conhecidos
  out = out.replace(
    /\b(?:AIza[0-9A-Za-z_-]{20,}|gsk_[0-9A-Za-z]{16,}|sk-or-v1-[0-9a-fA-F]{20,}|sk-(?:proj-|ant-)?[0-9A-Za-z_-]{20,}|(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{20,}|github_pat_[0-9A-Za-z_]{24,}|AKIA[0-9A-Z]{16}|xox[baprs]-[0-9A-Za-z-]{15,})\b/g,
    (match) => recordMatch(collector, "api_key", match)
  );
  out = out.replace(
    /\b(Bearer\s+)([0-9A-Za-z._-]{24,})\b/g,
    (_full, prefix: string, token: string) =>
      `${prefix}${recordMatch(collector, "api_key", token)}`
  );

  // 4. Atribuições explícitas de senha/segredo/chave (preserva o rótulo e mascara o valor)
  out = out.replace(
    /\b((?:minha\s+)?(?:senha|password|passwd|secret(?:_key)?|api[_-]?key|access[_-]?token|private[_-]?key|client[_-]?secret)\s*(?:é|eh|[:=])\s*["']?)([^\s"'`;,]{6,})(["']?)/gi,
    (full, prefix: string, val: string, suffix: string) => {
      // Evita remarcar placeholders já gerados pelo escudo
      if (/^\[[A-Z0-9_]+_\d+\]$/.test(val)) return full;
      return `${prefix}${recordMatch(collector, "credential", val)}${suffix}`;
    }
  );

  // 5. CNPJ formatado (00.000.000/0000-00) com validação real de dígitos
  out = out.replace(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/g, (match) =>
    isValidCnpjDigits(match) ? recordMatch(collector, "cnpj", match) : match
  );

  // 6. CPF formatado (000.000.000-00) ou precedido de "cpf" com validação real Mod-11
  out = out.replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, (match) =>
    isValidCpfDigits(match) ? recordMatch(collector, "cpf", match) : match
  );
  out = out.replace(/\b(cpf\s*(?:é|eh|n[úu]mero|[:=])?\s*)(\d{11})\b/gi, (full, prefix: string, digits: string) =>
    isValidCpfDigits(digits)
      ? `${prefix}${recordMatch(collector, "cpf", digits)}`
      : full
  );

  // 7. Cartão de crédito (13-19 dígitos separados por espaço/hífen ou contínuos) validado por Luhn
  out = out.replace(
    /(?<!\d)(?:\d{4}[ -]?){3}\d{1,7}(?!\d)|\b\d{13,19}\b/g,
    (match) => {
      // Evita confundir timestamps de 13 dígitos (ex: 1700000000000) ou números puros começando em 17/16/15
      const digits = match.replace(/\D/g, "");
      if (digits.length === 13 && !/[ -]/.test(match) && /^(15|16|17|18|19)/.test(digits)) {
        return match;
      }
      if (!isValidCreditCardLuhn(match)) return match;
      return recordMatch(collector, "credit_card", match);
    }
  );

  if (mode === "strict") {
    // 8. E-mails
    out = out.replace(
      /\b[A-Za-z0-9._%+-]{2,}@[A-Za-z0-9.-]+\.[A-Za-z]{2,12}\b/g,
      (match) => recordMatch(collector, "email", match)
    );

    // 9. Telefones brasileiros e internacionais com DDD/DDI
    out = out.replace(
      /(?<!\d)(?:\+55\s?)?(?:\(\d{2}\)\s?|\b[1-9]\d\s)(?:9\s?\d{4}|\d{4})[-.\s]?\d{4}(?!\d)|\+[1-9]\d{1,2}[\s.-]\(?\d{2,4}\)?[\s.-]\d{3,4}[\s.-]\d{4}(?!\d)/g,
      (match) => {
        const digits = match.replace(/\D/g, "");
        if (digits.length < 10 || digits.length > 15) return match;
        return recordMatch(collector, "phone", match);
      }
    );
  }

  const findings = finalizeFindings(collector);
  const totalMatches = findings.reduce((acc, f) => acc + f.count, 0);

  return {
    redactedText: out,
    hasFindings: totalMatches > 0,
    totalMatches,
    findings
  };
}

/**
 * Modo Híbrido: mascara automaticamente conteúdo textual de anexos e PDFs antes de enviar às IAs.
 * Se um PDF tiver dados sensíveis detectados no texto extraído, remove o binário `dataBase64`
 * para garantir que o Gemini também receba apenas o texto já mascarado.
 */
export function redactAttachmentsForShield(
  attachments: ChatAttachment[] | undefined,
  mode: PrivacyShieldMode
): {
  attachments: ChatAttachment[] | undefined;
  redactedCount: number;
  findings: PrivacyFindingSummary[];
} {
  if (!attachments || attachments.length === 0 || mode === "off") {
    return { attachments, redactedCount: 0, findings: [] };
  }

  let redactedCount = 0;
  const findingLists: PrivacyFindingSummary[][] = [];

  const next = attachments.map((att) => {
    if (!att.content || typeof att.content !== "string") {
      return att;
    }
    const scan = scanAndRedactText(att.content, mode);
    if (!scan.hasFindings) {
      return att;
    }

    redactedCount += scan.totalMatches;
    findingLists.push(scan.findings);

    if (att.kind === "pdf") {
      // Remove PDF binário não-mascarado para que nenhuma IA (inclusive Gemini) veja o dado bruto
      const { dataBase64: _stripped, ...rest } = att;
      return {
        ...rest,
        content: scan.redactedText
      };
    }

    return {
      ...att,
      content: scan.redactedText
    };
  });

  return {
    attachments: next,
    redactedCount,
    findings: mergePrivacyFindings(findingLists)
  };
}

/**
 * Modo Híbrido: mascara automaticamente instruções e trechos recuperados do Projeto (RAG/arquivos locais).
 */
export function redactProjectContextForShield(
  context: ResolvedProjectContext | null,
  mode: PrivacyShieldMode
): {
  context: ResolvedProjectContext | null;
  redactedCount: number;
  findings: PrivacyFindingSummary[];
} {
  if (!context || mode === "off") {
    return { context, redactedCount: 0, findings: [] };
  }

  let redactedCount = 0;
  const findingLists: PrivacyFindingSummary[][] = [];

  const instScan = scanAndRedactText(context.instructions, mode);
  if (instScan.hasFindings) {
    redactedCount += instScan.totalMatches;
    findingLists.push(instScan.findings);
  }

  const nextChunks = context.chunks.map((chunk) => {
    const scan = scanAndRedactText(chunk.content, mode);
    if (!scan.hasFindings) return chunk;
    redactedCount += scan.totalMatches;
    findingLists.push(scan.findings);
    return {
      ...chunk,
      content: scan.redactedText
    };
  });

  return {
    context: {
      ...context,
      instructions: instScan.redactedText,
      chunks: nextChunks
    },
    redactedCount,
    findings: mergePrivacyFindings(findingLists)
  };
}
