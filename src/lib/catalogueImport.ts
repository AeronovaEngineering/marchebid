// src/lib/catalogueImport.ts
import * as XLSX from "xlsx";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

// ============================================================
// TYPES
// ============================================================

export type ImportedItem = {
  designation: string;
  categorie: string;
  sous_categorie: string;
  unite: string;
  prix_fourniture: number;
  specs: Record<string, any>;
  /** Derived from an explicit stock column in the import file, if present. */
  statut: "brouillon" | "verifie";
};

export const createFournisseurSchema = z.object({
  nom: z.string().min(1, "Le nom est requis"),
  contact: z.string().optional(),
  telephone: z.string().optional(),
  email: z.string().email("Email invalide").optional().or(z.literal("")),
});

export type CreateFournisseurForm = z.infer<typeof createFournisseurSchema>;

// ============================================================
// QUERIES
// ============================================================

export const fournisseursListQuery = () => ({
  queryKey: ["fournisseurs-list"],
  queryFn: async () => {
    const { data, error } = await supabase
      .from("fournisseurs")
      .select("id, nom")
      .order("nom", { ascending: true });

    if (error) throw error;
    return data || [];
  },
});

// ============================================================
// COLUMN MAPPING
// ============================================================

/**
 * Finds the actual key on `obj` that matches one of `possibleKeys`,
 * ignoring case, accents, and non-letter characters (so "Prix HT",
 * "prix_ht" and "PrixHT" all match "prix_ht").
 */
export function findKey(obj: any, possibleKeys: string[]): string | null {
  if (!obj || typeof obj !== "object") return null;
  const keys = Object.keys(obj);
  for (const possible of possibleKeys) {
    const found = keys.find(
      (k) => k.toLowerCase().replace(/[^a-z]/g, "") === possible.toLowerCase().replace(/[^a-z]/g, "")
    );
    if (found) return found;
  }
  return null;
}

/**
 * Interprets common truthy/falsy spellings found in spreadsheet stock
 * columns: real booleans, 1/0, and French/English yes-no words.
 */
function parseBooleanish(value: any): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const s = String(value ?? "").trim().toLowerCase();
  return ["true", "1", "oui", "yes", "y", "vrai", "x", "disponible"].includes(s);
}

/**
 * Parses a designation/description cell that may hold a plain string OR a
 * JSON blob of structured specs (e.g. '{"diametre":"16mm","pression":"10bar"}').
 * Not every import file uses the JSON format, so this degrades gracefully:
 * - Valid JSON object -> its keys become `specs`. If no separate designation
 *   was found elsewhere on the row, a name-like key inside the JSON (if any)
 *   is used as the designation.
 * - Anything else (plain text, or JSON that fails to parse) -> treated as
 *   plain text, only used as a designation fallback, specs stays empty.
 */
function parseDescriptionField(
  raw: any,
  hasSeparateDesignation: boolean
): { designationFallback: string; specs: Record<string, any> } {
  if (typeof raw === "string" && raw.trim().startsWith("{")) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const nameKeyInJson = findKey(parsed, ["designation", "nom", "name", "libelle", "title"]);
        const specs: Record<string, any> = {};
        let designationFallback = "";
        for (const [k, v] of Object.entries(parsed)) {
          if (k === nameKeyInJson && !hasSeparateDesignation) {
            designationFallback = String(v ?? "").trim();
            continue; // don't duplicate it inside specs
          }
          specs[k] = v;
        }
        return { designationFallback, specs };
      }
    } catch {
      // Not actually valid JSON despite the leading "{" - fall through
      // to the plain-text branch below.
    }
  }

  // Plain text (or invalid JSON): only useful as a designation fallback.
  const text = raw == null ? "" : String(raw).trim();
  return {
    designationFallback: hasSeparateDesignation ? "" : text,
    specs: {},
  };
}

function mapRow(row: any): ImportedItem {
  const getVal = (key: string | null): any => (key ? row[key] : undefined);

  const designationKey = findKey(row, ["designation", "nom", "name", "article", "produit", "libelle"]);
  const categorieKey = findKey(row, ["categorie", "category", "catégorie", "type"]);
  const sousCategorieKey = findKey(row, ["sous_categorie", "subcategory", "sous-catégorie", "sous categorie"]);
  const uniteKey = findKey(row, ["unite", "unit", "unité", "u"]);
  const prixKey = findKey(row, ["prix_fourniture", "prix", "price", "prix_ht", "ht"]);
  const descriptionKey = findKey(row, ["description", "desc", "details"]);
  const stockKey = findKey(row, ["en_stock", "instock", "in_stock", "stock", "disponible"]);

  const rawDesignation = getVal(designationKey);
  let designation = rawDesignation ? String(rawDesignation).trim() : "";

  const { designationFallback, specs } = parseDescriptionField(
    getVal(descriptionKey),
    Boolean(designation)
  );
  if (!designation && designationFallback) {
    designation = designationFallback;
  }

  // Any remaining columns not already accounted for (designation, category,
  // sub-category, unit, price, description, stock) still fall through to
  // specs, same as before - this keeps files with a flat "extra columns are
  // specs" shape (no JSON description) working exactly as they did.
  const mappedKeys = new Set(
    [designationKey, categorieKey, sousCategorieKey, uniteKey, prixKey, descriptionKey, stockKey].filter(
      (k): k is string => Boolean(k)
    )
  );
  Object.keys(row || {}).forEach((key) => {
    if (!mappedKeys.has(key)) {
      specs[key] = row[key];
    }
  });

  const stockRaw = getVal(stockKey);
  const hasStockValue = Boolean(stockKey) && stockRaw !== undefined && stockRaw !== null && stockRaw !== "";
  const statut: ImportedItem["statut"] = hasStockValue
    ? parseBooleanish(stockRaw)
      ? "verifie"
      : "brouillon"
    : "brouillon";

  return {
    designation,
    categorie: getVal(categorieKey) || "",
    sous_categorie: getVal(sousCategorieKey) || "",
    unite: getVal(uniteKey) || "u",
    prix_fourniture: parseFloat(getVal(prixKey)) || 0,
    specs,
    statut,
  };
}

// ============================================================
// FILE PARSING
// ============================================================

/**
 * Reads a CSV/XLSX/XLS file and maps its rows to ImportedItem[] using
 * the same fuzzy column-name matching as the rest of the import flow.
 * Rejects with a user-facing message (in French, matching the rest of
 * the app) if the file can't be read or parsed.
 */
export function parseImportFile(file: File): Promise<{ headers: string[]; items: ImportedItem[] }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = (e) => {
      try {
        const result = e.target?.result;
        if (!result) {
          reject(new Error("Erreur de lecture du fichier"));
          return;
        }
        const data = new Uint8Array(result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: "array" });
        const firstSheetName = workbook.SheetNames[0];
        if (!firstSheetName) {
          reject(new Error("Le fichier ne contient aucune feuille"));
          return;
        }
        const firstSheet = workbook.Sheets[firstSheetName];
        const jsonData = XLSX.utils.sheet_to_json(firstSheet);

        if (jsonData.length === 0) {
          reject(new Error("Le fichier est vide"));
          return;
        }

        const headers = Object.keys(jsonData[0] || {});
        const items = jsonData.map((row: any) => mapRow(row));

        resolve({ headers, items });
      } catch (err) {
        console.error(err);
        reject(new Error("Erreur lors de la lecture du fichier"));
      }
    };

    reader.onerror = () => reject(new Error("Erreur de lecture du fichier"));
    reader.readAsArrayBuffer(file);
  });
}

export function isValidImportItem(item: ImportedItem): boolean {
  return Boolean(item.designation) && item.prix_fourniture > 0;
}

// ============================================================
// PERSISTENCE
// ============================================================

/**
 * Bulk-inserts the given (already-validated) rows into
 * materiel_catalogue for the given fournisseur, as brouillon items.
 */
export async function insertCatalogueImport(fournisseurId: string, items: ImportedItem[]) {
  const rows = items.map((item) => ({
    fournisseur_id: fournisseurId,
    designation: item.designation,
    categorie: item.categorie || null,
    sous_categorie: item.sous_categorie || null,
    unite: item.unite || "u",
    prix_fourniture: item.prix_fourniture || 0,
    specs: item.specs || {},
    statut: item.statut,
  }));

  const { data: inserted, error } = await supabase
    .from("materiel_catalogue")
    .insert(rows)
    .select();

  if (error) throw error;
  return inserted;
}

export async function insertFournisseur(data: CreateFournisseurForm) {
  const { data: newFournisseur, error } = await supabase
    .from("fournisseurs")
    .insert({
      nom: data.nom,
      contact: data.contact || null,
      telephone: data.telephone || null,
      email: data.email || null,
    })
    .select()
    .single();

  if (error) throw error;
  return newFournisseur;
}