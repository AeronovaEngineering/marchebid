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

function mapRow(row: any): ImportedItem {
  const getVal = (key: string | null): any => (key ? row[key] : undefined);

  const designationKey = findKey(row, ["designation", "nom", "name", "article", "produit", "description"]);
  const categorieKey = findKey(row, ["categorie", "category", "catégorie", "type"]);
  const sousCategorieKey = findKey(row, ["sous_categorie", "subcategory", "sous-catégorie", "sous categorie"]);
  const uniteKey = findKey(row, ["unite", "unit", "unité", "u"]);
  const prixKey = findKey(row, ["prix_fourniture", "prix", "price", "prix_ht", "ht"]);

  const specs: any = {};
  const skipKeys = ["designation", "categorie", "sous_categorie", "unite", "prix_fourniture", "prix", "price"];
  Object.keys(row || {}).forEach((key) => {
    if (!skipKeys.some((s) => key.toLowerCase().includes(s))) {
      specs[key] = row[key];
    }
  });

  return {
    designation: getVal(designationKey) || "",
    categorie: getVal(categorieKey) || "",
    sous_categorie: getVal(sousCategorieKey) || "",
    unite: getVal(uniteKey) || "u",
    prix_fourniture: parseFloat(getVal(prixKey)) || 0,
    specs,
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
    statut: "brouillon" as const,
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