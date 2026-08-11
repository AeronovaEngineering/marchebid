// src/lib/parsing/parseBordereau.ts

import { createServerFn } from "@tanstack/react-start";
import * as XLSX from "xlsx";

// Regex patterns - exact ports from Python
const ROMAN_RE = /^[IVXLCM]+$/;
const ITEM_CODE_RE = /^\d+(\.\d+)+$/;
const VARIANT_LABEL_RE = /^[a-z]\)\s*/;
const DOTLEADER_RE = /^[.…\s]+$/;
const UNIT_PHRASE_RE = /(L['’]Unit[ée]|L['’]Ensemble|Le\s+M[eè]tre\s+Lin[ée]aire|Le\s+Kilogramme|La\s+Pi[eè]ce)/i;
const DOT_RUN_RE = /[.…]{3,}/;

const BOILERPLATE_SNIPPETS = [
  "BORDEREAU DES PRIX",
  "N° DES PRIX",
  "CONSTRUCTION D'UNE RESIDENCE",
  "BUREAUTIQUE ET COMMERCIAL",
  "BEST engineering",
  "PREAMBULES",
];

const POSE_RE = /\bpose\b/i;
const FOURNITURE_SEULE_RE = /fourniture\s+seule|sans\s+pose|non\s+compris.{0,15}pose/i;
const NOTE_PREFIX_RE = /^(N\.?B\.?\s*:|Remarque|NOTA)\b/i;

// Helper functions
function isBoilerplate(row: any[]): boolean {
  for (let i = 0; i < Math.min(2, row.length); i++) {
    const cell = row[i];
    if (typeof cell === "string") {
      for (const snippet of BOILERPLATE_SNIPPETS) {
        if (cell.includes(snippet)) {
          return true;
        }
      }
    }
  }
  return false;
}

function clean(v: any): string | null | undefined {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const trimmed = v.trim();
    return trimmed || null;
  }
  return v;
}

function looksLikeVariantLabel(text: string): boolean {
  return VARIANT_LABEL_RE.test(text) && text.length < 120;
}

function looksLikeSubcategoryHeader(text: string): boolean {
  const t = text.trim();
  if (t.length > 60) return false;
  if (t.endsWith(".")) return false;
  if (NOTE_PREFIX_RE.test(t)) return false;
  return true;
}

function looksLikeDotLeader(text: string): boolean {
  if (DOTLEADER_RE.test(text)) return true;
  if (UNIT_PHRASE_RE.test(text) && DOT_RUN_RE.test(text)) return true;
  return false;
}

function detectAPose(designation: string): boolean {
  if (FOURNITURE_SEULE_RE.test(designation)) return false;
  return !!POSE_RE.test(designation) || true; // default true for lot fluides
}

// Main parser
export interface BordereauLine {
  numero: string | null;
  designation: string;
  quantite: number;
  unite: string | null;
  chapitre_ou_zone: string | null;
  a_pose: boolean;
}

export interface ParseResult {
  ok: boolean;
  format_detecte?: string | null;
  lignes?: BordereauLine[];
  reason?: string;
}

interface Variant {
  label: string | null;
  unit: string | null;
  quantity: number | null;
  unit_price: any;
  total_price: any;
}

interface Item {
  chapter_code: string | null;
  chapter_title: string | null;
  subcategory: string | null;
  item_code: string | null;
  desc_parts: string[];
  variants: Variant[];
}

function parseBordereau(buffer: ArrayBuffer, sheetName: string = "BP"): ParseResult {
  try {
    // Read workbook
    const workbook = XLSX.read(buffer, { type: "array" });
    
    // Try "BP" first, fallback to first sheet
    let sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      const firstSheetName = workbook.SheetNames[0];
      if (!firstSheetName) {
        return { ok: false, reason: "No sheets found in workbook" };
      }
      sheet = workbook.Sheets[firstSheetName];
    }
    if (!sheet) {
      return { ok: false, reason: `Sheet "${sheetName}" not found` };
    }

    // Get rows as arrays (header: 1, defval: null)
    const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null }) as any[][];
    const rows = rawRows.map(row => row.map(clean));

    const items: BordereauLine[] = [];
    let chapterCode: string | null = null;
    let chapterTitle: string | null = null;
    let subcategory: string | null = null;
    let currentItem: Item | null = null;
    let currentVariantLabel: string | null = null;
    let ordreCounter = 0;

    function flushItem(): void {
      if (currentItem && currentItem.variants.length > 0) {
        const desc = currentItem.desc_parts.join(" ").trim();
        let zone = currentItem.chapter_title || "";
        if (currentItem.subcategory) {
          zone = zone ? `${zone} — ${currentItem.subcategory}` : currentItem.subcategory;
        }
        const codePrefix = currentItem.chapter_code ? `${currentItem.chapter_code}. ` : "";
        const zoneFull = (codePrefix + zone).trim();

        for (const v of currentItem.variants) {
          let fullDesignation = desc;
          if (v.label) {
            fullDesignation = `${fullDesignation} — ${v.label}`;
          }
          fullDesignation = fullDesignation.replace(/^ — | — $/g, "").trim();
          
          ordreCounter++;
          items.push({
            numero: currentItem.item_code,
            designation: fullDesignation,
            quantite: v.quantity || 0,
            unite: v.unit,
            chapitre_ou_zone: zoneFull || null,
            a_pose: detectAPose(fullDesignation),
          });
        }
      }
      currentItem = null;
    }

    for (const row of rows) {
      const [c0, c1, c2, c3, c4, c5] = row;

      if (isBoilerplate(row)) continue;
      if (row.every(c => c === null || c === undefined)) continue;
      if (c1 && typeof c1 === "string" && c1.toUpperCase().startsWith("S/TOTAL")) {
        flushItem();
        continue;
      }

      // Chapter detection (Roman numeral in c0, title in c1)
      if (c0 && typeof c0 === "string" && ROMAN_RE.test(c0) && (c2 === null || c2 === " ") && c3 === null) {
        flushItem();
        chapterCode = c0;
        chapterTitle = c1 || null;
        subcategory = null;
        continue;
      }

      // Item code detection
      if (c0 && typeof c0 === "string" && ITEM_CODE_RE.test(c0)) {
        flushItem();
        currentItem = {
          chapter_code: chapterCode,
          chapter_title: chapterTitle,
          subcategory: subcategory,
          item_code: c0,
          desc_parts: c1 ? [c1] : [],
          variants: [],
        };
        currentVariantLabel = null;
        continue;
      }

      // Variant data row (unit, quantity, prices)
      if ((c2 === null || c2 === " ") ? false : c2 !== null && c2 !== undefined && c2 !== " ") {
        if (c3 !== null && c3 !== undefined) {
          if (currentItem !== null) {
            currentItem.variants.push({
              label: currentVariantLabel,
              unit: c2 || null,
              quantity: typeof c3 === "number" ? c3 : (c3 ? parseFloat(String(c3)) : null),
              unit_price: c4 || null,
              total_price: c5 || null,
            });
          }
          currentVariantLabel = null;
          continue;
        }
      }

      // Description text or variant label
      if (c1 && typeof c1 === "string") {
        if (looksLikeDotLeader(c1)) {
          continue;
        }
        if (looksLikeVariantLabel(c1)) {
          currentVariantLabel = c1;
          continue;
        }
        if (currentItem !== null) {
          currentItem.desc_parts.push(c1);
        } else if (looksLikeSubcategoryHeader(c1)) {
          subcategory = c1;
        }
        // else: stray preamble/note text with no item open - dropped
        continue;
      }
    }

    flushItem();

    if (items.length === 0) {
      return { ok: false, reason: "No items parsed from the bordereau" };
    }

    return {
      ok: true,
      format_detecte: "bordereau",
      lignes: items,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : "Unknown error parsing file",
    };
  }
}

// Server function - matches the existing signature in chantiers.$id.index.tsx
export const parseBordereauServerFn = createServerFn({ method: "POST" })
  .validator((formData: FormData) => {
    const file = formData.get("file");
    if (!file || !(file instanceof File)) throw new Error("No file provided");
    if (!file.name.match(/\.(xls|xlsx)$/i)) {
      throw new Error("File must be an Excel (.xls or .xlsx) file");
    }
    return file;
  })
  .handler(async ({ data: file }) => {
    try {
      const arrayBuffer = await file.arrayBuffer();
      const result = parseBordereau(arrayBuffer);
      return result;
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : "Failed to parse bordereau",
      };
    }
  });