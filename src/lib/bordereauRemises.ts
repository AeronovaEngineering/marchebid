/**
 * Shared discount ("remise") math for the bordereau.
 *
 * Chapters aren't their own DB rows — they're derived by grouping
 * marche_lignes on chapitre_ou_zone — so a chapter remise is keyed by
 * that same text key, not a chapter_id. This module has no knowledge of
 * Supabase or React; it's pure math, imported by:
 *   - the recap page's on-screen live preview
 *   - generateBordereauPdfServerFn / bordereauPdf.tsx
 *   - generateBordereauXlsxServerFn / generateBordereauXlsx.ts
 * so the three surfaces can never silently disagree on a total.
 *
 * Order of operations (discount-then-TVA — the more common convention,
 * used here unless a different order is explicitly requested):
 *   1. Each chapter's brut subtotal gets its own chapter remise applied.
 *   2. The net chapter subtotals are summed → total HT before the global
 *      remise (`totalHtAvantRemiseGlobale`).
 *   3. The global remise (marches.remise_globale_type/valeur) is applied
 *      to that sum → total HT, final (`totalHt`).
 *   4. TVA is computed on the post-discount total HT.
 *   5. Timbre fiscal is added on top — it is never discounted.
 */

export type RemiseType = "pourcentage" | "montant";

export interface Remise {
  type: RemiseType;
  valeur: number;
}

/** True for a remise that actually removes money — a zero-valeur remise
 *  (the input's "empty" state) is treated as no discount everywhere. */
export function isRemiseActive(remise: Remise | null | undefined): remise is Remise {
  return !!remise && remise.valeur > 0;
}

/**
 * Amount after applying a discount.
 *  - `pourcentage` is capped at 100% (a typo'd 150% can't go negative).
 *  - `montant` (fixed DT) is capped at the amount itself, for the same
 *    reason — a fixed discount larger than the subtotal never produces
 *    a negative chapter or grand total.
 */
export function applyRemise(amount: number, remise: Remise | null | undefined): number {
  if (!isRemiseActive(remise)) return amount;
  if (remise.type === "pourcentage") {
    return amount * (1 - Math.min(remise.valeur, 100) / 100);
  }
  return Math.max(0, amount - remise.valeur);
}

/** The DT amount a discount removes (always >= 0, regardless of caps). */
export function remiseMontant(amount: number, remise: Remise | null | undefined): number {
  return amount - applyRemise(amount, remise);
}

export interface ChapitreForTotals {
  /** chapitre_ou_zone — the same grouping key used everywhere else. */
  key: string;
  sousTotalBrut: number;
  remise: Remise | null;
}

export interface BordereauTotalsInput {
  chapitres: ChapitreForTotals[];
  remiseGlobale: Remise | null;
  tvaPct: number;
  timbreFiscal: number;
}

export interface BordereauTotalsResult {
  /** Net subtotal per chapter (brut minus that chapter's own remise). */
  chapitreNet: Map<string, number>;
  /** Sum of net chapter subtotals — total HT before the global remise. */
  totalHtAvantRemiseGlobale: number;
  /** Final total HT, after every discount (chapter + global), before TVA. */
  totalHt: number;
  totalTva: number;
  timbreFiscal: number;
  totalTtc: number;
}

export function computeBordereauTotals(input: BordereauTotalsInput): BordereauTotalsResult {
  const chapitreNet = new Map<string, number>();
  let totalHtAvantRemiseGlobale = 0;

  for (const chapitre of input.chapitres) {
    const net = applyRemise(chapitre.sousTotalBrut, chapitre.remise);
    chapitreNet.set(chapitre.key, net);
    totalHtAvantRemiseGlobale += net;
  }

  const totalHt = applyRemise(totalHtAvantRemiseGlobale, input.remiseGlobale);
  const totalTva = totalHt * (input.tvaPct / 100);
  const totalTtc = totalHt + totalTva + input.timbreFiscal;

  return {
    chapitreNet,
    totalHtAvantRemiseGlobale,
    totalHt,
    totalTva,
    timbreFiscal: input.timbreFiscal,
    totalTtc,
  };
}