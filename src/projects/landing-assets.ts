import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { dirname, extname, join } from "node:path";

import type { ChatAttachment } from "../shared/debate-types.js";
import {
  applyWorkspaceChanges,
  resolveSafeWorkspacePath
} from "./workspace-writer.js";

const MAX_SLOT_IMAGE_BYTES = 3 * 1024 * 1024; // 3 MB
const MAX_SLOT_NUMBER = 20;

const ALLOWED_IMAGE_MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif"
};

export interface SavedImageSlotResult {
  slot: number;
  relPath: string;
  publicUrl: string;
  originalName: string;
  bytes: number;
}

export interface ApplyImageSlotsOutcome {
  savedAssets: SavedImageSlotResult[];
  updatedHtml: boolean;
  updatedSlotsInHtml: number[];
  skippedReasons: string[];
}

export interface ExportStaticBundleResult {
  outputDir: string;
  relOutputDir: string;
  copiedFiles: string[];
  readmePath: string;
}

/**
 * Valida os magic bytes reais do binário de imagem para evitar spoofing de MIME,
 * upload de SVG malicioso (XSS) ou arquivos executáveis disfarçados.
 */
export function hasValidImageMagicBytes(buf: Buffer, mimeType: string): boolean {
  if (buf.length < 12) return false;
  const mime = mimeType.toLowerCase().trim();

  if (mime === "image/png") {
    return (
      buf[0] === 0x89 &&
      buf[1] === 0x50 &&
      buf[2] === 0x4e &&
      buf[3] === 0x47 &&
      buf[4] === 0x0d &&
      buf[5] === 0x0a &&
      buf[6] === 0x1a &&
      buf[7] === 0x0a
    );
  }

  if (mime === "image/jpeg" || mime === "image/jpg") {
    return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  }

  if (mime === "image/gif") {
    const header = buf.subarray(0, 6).toString("ascii");
    return header === "GIF87a" || header === "GIF89a";
  }

  if (mime === "image/webp") {
    const riff = buf.subarray(0, 4).toString("ascii");
    const webp = buf.subarray(8, 12).toString("ascii");
    return riff === "RIFF" && webp === "WEBP";
  }

  return false;
}

/**
 * Extrai os slots numéricos (1, 2, 3...) desejados pelo usuário a partir de linguagem natural:
 * - "coloque na imagem 1" / "foto 2 e foto 3" / "imagens 1, 2 e 3" / "slot 4"
 * - "coloca no hero" -> slot 1
 * - "segunda imagem" / "terceira foto" -> slots 2 / 3
 * - Se não houver número explícito, distribui sequencialmente nos slots disponíveis (1, 2, 3...).
 */
export function parseImageSlotAssignments(
  prompt: string,
  imageCount: number,
  availableEmptySlots: number[] = []
): number[] {
  if (imageCount <= 0) return [];

  const norm = String(prompt || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const picked: number[] = [];
  const pushSlot = (n: number) => {
    if (
      Number.isInteger(n) &&
      n >= 1 &&
      n <= MAX_SLOT_NUMBER &&
      !picked.includes(n) &&
      picked.length < imageCount
    ) {
      picked.push(n);
    }
  };

  // 1. Padrões explícitos com listas: "imagens 1 e 2", "fotos 2, 3", "imagem 1", "slot 3"
  const listRegex =
    /\b(?:imagens?|fotos?|slots?|espacos?|lugares?)\s*(?:n[°ºo.]?\s*)?(\d+(?:\s*(?:,|e|\/)\s*\d+)*)/g;
  for (const m of norm.matchAll(listRegex)) {
    const nums = (m[1] ?? "").match(/\d+/g) ?? [];
    for (const rawNum of nums) {
      pushSlot(Number(rawNum));
    }
  }

  // 2. Ordinais naturais e termos semânticos ("hero" -> 1, "primeira" -> 1, "segunda" -> 2...)
  const ordinalRules: Array<[RegExp, number]> = [
    [/\b(?:no\s+hero|capa|banner\s+principal|primeir[ao]\s+(?:imagem|foto|espaco|slot))\b/, 1],
    [/\b(?:segund[ao]\s+(?:imagem|foto|espaco|slot))\b/, 2],
    [/\b(?:terceir[ao]\s+(?:imagem|foto|espaco|slot))\b/, 3],
    [/\b(?:quart[ao]\s+(?:imagem|foto|espaco|slot))\b/, 4],
    [/\b(?:quint[ao]\s+(?:imagem|foto|espaco|slot))\b/, 5]
  ];
  for (const [re, slot] of ordinalRules) {
    if (re.test(norm)) {
      pushSlot(slot);
    }
  }

  // 3. Completa os restantes com os próximos slots vazios encontrados no HTML ou sequencial (1, 2, 3...)
  const fallbackPool = [
    ...availableEmptySlots.filter((n) => Number.isInteger(n) && n >= 1 && n <= MAX_SLOT_NUMBER),
    1,
    2,
    3,
    4,
    5,
    6
  ];
  for (const candidate of fallbackPool) {
    if (picked.length >= imageCount) break;
    pushSlot(candidate);
  }

  return picked;
}

/**
 * Detecta se a mensagem do usuário é puramente um pedido de colocar/trocar imagens nos slots
 * (ex.: "coloque na imagem 1", "imagem 1 e 2", "troca a foto do hero"), sem pedir alterações
 * de texto, layout ou novas funcionalidades.
 */
export function isPureImageSlotSwapRequest(prompt: string): boolean {
  const norm = String(prompt || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();

  if (!norm || norm.length > 160) return false;

  // Se pedir alteração de layout/texto/cores/funcionalidade junto, deixa a IA também agir
  if (
    /\b(cor|cores|fonte|texto|titulo|preco|planos|secao|secoes|botao|menu|header|footer|faq|formulario|whatsapp|bug|erro|responsivo|animacao|crie|refatore|reescreva|layout|estilo|tema|css|api|rota|teste)\b/.test(
      norm
    )
  ) {
    return false;
  }

  return /\b(imagem|imagens|foto|fotos|slot|slots|hero|capa|banner|coloc[ae]|colocar|troqu[ea]|trocar|substitu[ai]|substituir|us[ae]\s+ess[ae]|ponh[ae]|inser[ei]|atualiz[ae])\b/.test(
    norm
  );
}

/**
 * Gera um SVG placeholder editorial limpo (100% local, sem scripts/links externos)
 * para um slot numerado (Espaço Imagem 1, 2, 3...).
 */
export function buildDefaultSlotPlaceholderSvg(slotNumber: number): string {
  const n = Math.max(1, Math.min(MAX_SLOT_NUMBER, Math.floor(slotNumber)));
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 750" width="1200" height="750" role="img" aria-label="Espaço Imagem ${n}">`,
    `  <rect width="1200" height="750" rx="24" fill="#181a20"/>`,
    `  <rect x="28" y="28" width="1144" height="694" rx="18" fill="none" stroke="#343846" stroke-width="2" stroke-dasharray="10 10"/>`,
    `  <circle cx="600" cy="315" r="54" fill="#232632" stroke="#454b5e" stroke-width="2"/>`,
    `  <rect x="572" y="294" width="56" height="42" rx="6" fill="none" stroke="#cbd5e1" stroke-width="2.5"/>`,
    `  <circle cx="590" cy="309" r="5" fill="#cbd5e1"/>`,
    `  <path d="M575 332l14-14 10 10 12-13 14 17" fill="none" stroke="#cbd5e1" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`,
    `  <text x="600" y="422" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="34" font-weight="700" fill="#f1f5f9">ESPAÇO IMAGEM ${n}</text>`,
    `  <text x="600" y="464" text-anchor="middle" font-family="system-ui, -apple-system, Segoe UI, sans-serif" font-size="20" fill="#94a3b8">Envie sua foto no chat dizendo &quot;coloque na imagem ${n}&quot;</text>`,
    `</svg>`
  ].join("\n");
}

/**
 * Garante que todos os placeholders `/assets/slot-N.svg` referenciados em `public/index.html`
 * existam fisicamente no disco (evitando 404 no smoke-test e no navegador).
 */
export async function ensureDefaultLandingSlotPlaceholders(
  folderPath: string
): Promise<string[]> {
  let html: string;
  try {
    const safeHtml = await resolveSafeWorkspacePath(folderPath, "public/index.html");
    html = await readFile(safeHtml.absPath, "utf8");
  } catch {
    return [];
  }

  const slotNums = new Set<number>();
  for (const m of html.matchAll(/(?:\/|\.?\/)?assets\/slot-(\d+)\.svg\b/gi)) {
    const num = Number(m[1]);
    if (Number.isInteger(num) && num >= 1 && num <= MAX_SLOT_NUMBER) {
      slotNums.add(num);
    }
  }

  if (slotNums.size === 0) return [];

  const created: string[] = [];
  for (const n of Array.from(slotNums).sort((a, b) => a - b)) {
    const relPath = `public/assets/slot-${n}.svg`;
    try {
      const safe = await resolveSafeWorkspacePath(folderPath, relPath);
      try {
        await lstat(safe.absPath);
        continue; // Já existe
      } catch {
        // Não existe ainda -> cria placeholder editorial local
      }
      await mkdir(dirname(safe.absPath), { recursive: true });
      await writeFile(safe.absPath, buildDefaultSlotPlaceholderSvg(n), "utf8");
      created.push(relPath);
    } catch {
      // Ignora erro de caminho inseguro
    }
  }

  return created;
}

function findAvailablePlaceholderSlotsInHtml(html: string): number[] {
  const placeholderSlots: number[] = [];
  const allSlots: number[] = [];

  for (const m of html.matchAll(/<img\b[^>]*\bdata-image-slot=["'](\d+)["'][^>]*>/gi)) {
    const fullTag = m[0] ?? "";
    const n = Number(m[1]);
    if (!Number.isInteger(n) || n < 1 || n > MAX_SLOT_NUMBER) continue;
    if (!allSlots.includes(n)) allSlots.push(n);
    if (/slot-\d+\.svg/i.test(fullTag) && !placeholderSlots.includes(n)) {
      placeholderSlots.push(n);
    }
  }

  return placeholderSlots.length > 0 ? placeholderSlots : allSlots;
}

function replaceImageSlotInHtml(
  html: string,
  slotNumber: number,
  publicAssetUrl: string
): { html: string; changed: boolean } {
  let changed = false;

  // 1. Atualiza o atributo src da tag <img ... data-image-slot="N" ...>
  const imgRe = new RegExp(
    `(<img\\b[^>]*\\bdata-image-slot=["']${slotNumber}["'][^>]*>)`,
    "gi"
  );
  let nextHtml = html.replace(imgRe, (tag) => {
    changed = true;
    if (/\bsrc=["'][^"']*["']/i.test(tag)) {
      return tag.replace(/\bsrc=["'][^"']*["']/i, `src="${publicAssetUrl}"`);
    }
    return tag.replace(/^<img\b/i, `<img src="${publicAssetUrl}"`);
  });

  // 2. Fallback: se o HTML usa src="/assets/slot-N.svg" sem data-image-slot
  if (!changed) {
    const svgSrcRe = new RegExp(
      `((?:src|href)=["'])(?:\\/|\\.?\\/)?assets\\/slot-${slotNumber}\\.svg(["'])`,
      "gi"
    );
    nextHtml = nextHtml.replace(svgSrcRe, (_m, p1: string, p2: string) => {
      changed = true;
      return `${p1}${publicAssetUrl}${p2}`;
    });
  }

  // 3. Oculta/remove a legenda de placeholder quando a foto real entrou no slot
  if (changed) {
    const badgeRe = new RegExp(
      `<([a-z0-9]+)\\b[^>]*\\bdata-slot-placeholder=["']${slotNumber}["'][^>]*>[\\s\\S]*?<\\/\\1>`,
      "gi"
    );
    nextHtml = nextHtml.replace(badgeRe, "");
  }

  return { html: nextHtml, changed };
}

/**
 * Salva anexos de imagem validados (magic bytes + tamanho + sandbox) em `public/assets/slot-<N>.<ext>`
 * e, se `public/index.html` existir com slots correspondentes, já substitui automaticamente com backup.
 */
export async function applyImageSlotsToWorkspace(
  folderPath: string,
  prompt: string,
  attachments: ChatAttachment[]
): Promise<ApplyImageSlotsOutcome> {
  const imageAttachments = (attachments ?? []).filter(
    (att) =>
      att &&
      att.kind === "image" &&
      typeof att.dataBase64 === "string" &&
      att.dataBase64.trim().length > 0 &&
      typeof att.mimeType === "string"
  );

  if (imageAttachments.length === 0) {
    return {
      savedAssets: [],
      updatedHtml: false,
      updatedSlotsInHtml: [],
      skippedReasons: []
    };
  }

  let existingHtml = "";
  let hasHtml = false;
  try {
    const safeHtml = await resolveSafeWorkspacePath(folderPath, "public/index.html");
    existingHtml = await readFile(safeHtml.absPath, "utf8");
    hasHtml = existingHtml.trim().length > 0;
  } catch {
    hasHtml = false;
  }

  const availableSlots = hasHtml ? findAvailablePlaceholderSlotsInHtml(existingHtml) : [];
  const assignedSlots = parseImageSlotAssignments(
    prompt,
    imageAttachments.length,
    availableSlots
  );

  const savedAssets: SavedImageSlotResult[] = [];
  const skippedReasons: string[] = [];

  for (let i = 0; i < imageAttachments.length; i++) {
    const att = imageAttachments[i]!;
    const slot = assignedSlots[i] ?? i + 1;
    const mime = (att.mimeType ?? "").toLowerCase().trim();
    const ext = ALLOWED_IMAGE_MIME_TO_EXT[mime];

    if (!ext) {
      skippedReasons.push(`${att.name}: formato de imagem não permitido (${mime || "desconhecido"}).`);
      continue;
    }

    const base64Clean = att.dataBase64!.replace(/^data:[^;]+;base64,/i, "").trim();
    const buf = Buffer.from(base64Clean, "base64");
    if (buf.length === 0 || buf.length > MAX_SLOT_IMAGE_BYTES) {
      skippedReasons.push(`${att.name}: tamanho inválido (máx. 3 MB).`);
      continue;
    }

    if (!hasValidImageMagicBytes(buf, mime)) {
      skippedReasons.push(`${att.name}: assinatura binária não corresponde a ${mime}.`);
      continue;
    }

    const relPath = `public/assets/slot-${slot}.${ext}`;
    const safeAsset = await resolveSafeWorkspacePath(folderPath, relPath);
    await mkdir(dirname(safeAsset.absPath), { recursive: true });
    await writeFile(safeAsset.absPath, buf);

    savedAssets.push({
      slot,
      relPath: safeAsset.relPath,
      publicUrl: `/assets/slot-${slot}.${ext}`,
      originalName: att.name,
      bytes: buf.length
    });
  }

  let updatedHtml = false;
  const updatedSlotsInHtml: number[] = [];

  if (hasHtml && savedAssets.length > 0) {
    let workingHtml = existingHtml;
    for (const saved of savedAssets) {
      const res = replaceImageSlotInHtml(workingHtml, saved.slot, saved.publicUrl);
      if (res.changed) {
        workingHtml = res.html;
        updatedSlotsInHtml.push(saved.slot);
      }
    }

    if (updatedSlotsInHtml.length > 0 && workingHtml !== existingHtml) {
      await applyWorkspaceChanges(folderPath, [
        { path: "public/index.html", content: workingHtml }
      ]);
      updatedHtml = true;
    }
  }

  return {
    savedAssets,
    updatedHtml,
    updatedSlotsInHtml,
    skippedReasons
  };
}

async function copyDirectorySafe(
  srcDir: string,
  destDir: string,
  relPrefix: string,
  copiedOut: string[]
): Promise<void> {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
    const srcPath = join(srcDir, entry.name);
    const destPath = join(destDir, entry.name);
    const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;

    if (entry.isDirectory()) {
      await copyDirectorySafe(srcPath, destPath, relPath, copiedOut);
    } else if (entry.isFile()) {
      const ext = extname(entry.name).toLowerCase();
      if ([".env", ".key", ".pem", ".db", ".sqlite"].includes(ext)) continue;
      await copyFile(srcPath, destPath);
      copiedOut.push(relPath);
    }
  }
}

/**
 * Exporta a pasta `public/` do projeto para `deploy-static/` pronta para hospedar
 * na Netlify Drop, Vercel ou GitHub Pages (com caminhos relativos `./style.css`, `./app.js`, `./assets/...`).
 */
export async function exportStaticLandingBundle(
  folderPath: string
): Promise<ExportStaticBundleResult> {
  const safePublic = await resolveSafeWorkspacePath(folderPath, "public/index.html");
  const publicDir = dirname(safePublic.absPath);
  const safeExportIndex = await resolveSafeWorkspacePath(
    folderPath,
    "deploy-static/index.html"
  );
  const outputDir = dirname(safeExportIndex.absPath);

  await rm(outputDir, { recursive: true, force: true });
  const copiedFiles: string[] = [];
  await copyDirectorySafe(publicDir, outputDir, "", copiedFiles);

  // Reescreve caminhos absolutos raiz (/style.css, /app.js, /assets/...) para relativos (./...)
  // para funcionar tanto em domínio raiz quanto em subpasta (ex.: GitHub Pages /meu-repo/)
  const exportedIndexPath = join(outputDir, "index.html");
  const rawHtml = await readFile(exportedIndexPath, "utf8");
  const relativeHtml = rawHtml.replace(
    /\b(href|src)=(["'])\/(style\.css|app\.js|assets\/[^"']+)\2/gi,
    "$1=$2./$3$2"
  );
  await writeFile(exportedIndexPath, relativeHtml, "utf8");

  const readmeText = [
    "================================================================",
    "AI Council — Pacote Estático Pronto para Publicar (deploy-static)",
    "================================================================",
    "",
    "Esta pasta contém todos os arquivos prontos da sua Landing Page",
    "(index.html, style.css, app.js e assets/) com caminhos relativos.",
    "",
    "COMO PUBLICAR GRÁTIS EM 1 MINUTO:",
    "1. Netlify Drop: acesse https://app.netlify.com/drop e arraste esta pasta deploy-static.",
    "2. Vercel: suba esta pasta em https://vercel.com/new (Framework Preset: Other).",
    "3. GitHub Pages: envie o conteúdo desta pasta para a branch main/gh-pages do repositório.",
    "",
    "CONFIGURAÇÕES IMPORTANTES ANTES DE PUBLICAR:",
    "- WhatsApp: abra app.js e edite LANDING_CONFIG.whatsappNumber com seu número (55 + DDD + número).",
    "- Formulário de Leads em hospedagem estática: crie um endpoint grátis no Formspree",
    "  (https://formspree.io) e cole a URL em LANDING_CONFIG.externalFormAction no topo do app.js.",
    ""
  ].join("\n");

  const readmePath = join(outputDir, "README-PUBLICAR.txt");
  await writeFile(readmePath, readmeText, "utf8");
  copiedFiles.push("README-PUBLICAR.txt");

  return {
    outputDir,
    relOutputDir: "deploy-static",
    copiedFiles,
    readmePath
  };
}
