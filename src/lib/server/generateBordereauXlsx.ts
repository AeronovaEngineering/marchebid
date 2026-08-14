import XLSX from "xlsx-js-style";
import type { BordereauPdfChapitre, BordereauPdfData, BordereauPdfLigne } from "./bordereauPdf";
import { isRemiseActive, remiseMontant, type Remise } from "@/lib/bordereauRemises";

const DINARS_FORMAT = '#,##0.000" DT"';
const QUANTITE_FORMAT = "#,##0.##";

const FONT_TITLE = { name: "Arial", sz: 14, bold: true, italic: true };
const FONT_SUBTITLE = { name: "Arial", sz: 11, italic: true };
const FONT_HEADER = { name: "Times New Roman", sz: 10, bold: true, italic: true };
const FONT_CHAPITRE = { name: "Times New Roman", sz: 11, bold: true };
const FONT_NUMERO = { name: "Times New Roman", sz: 11, bold: true };
const FONT_BODY = { name: "Times New Roman", sz: 11 };
const FONT_TOTAL_LABEL = { name: "Times New Roman", sz: 11, bold: true, italic: true };
const FONT_TOTAL_VALUE = { name: "Times New Roman", sz: 11, bold: true };
const FONT_GRAND_TOTAL_LABEL = { name: "Times New Roman", sz: 12, bold: true, italic: true };
const FONT_GRAND_TOTAL_VALUE = { name: "Times New Roman", sz: 12, bold: true };

const THIN = { style: "thin" };
const DOUBLE = { style: "double" };
const GRID = { top: THIN, bottom: THIN, left: THIN, right: THIN };
const GRID_TOP_DBL = { top: DOUBLE, bottom: THIN, left: THIN, right: THIN };
const GRID_BOTTOM_DBL = { top: THIN, bottom: DOUBLE, left: THIN, right: THIN };
const GRID_HEADER = { top: DOUBLE, bottom: DOUBLE, left: THIN, right: THIN };

const COL_WIDTHS = [{ wch: 7 }, { wch: 55 }, { wch: 6 }, { wch: 11 }, { wch: 13 }, { wch: 15 }];
const HEADER_ROW = [
  "N° DES PRIX",
  "DESIGNATION DES TRAVAUX",
  "U",
  "QUANTITE",
  "PRIX UNITAIRE (H.T.V.A)",
  "PRIX TOTAL (H.T.V.A)",
];

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" });
}

function formatRemiseLabel(remise: Remise): string {
  return remise.type === "pourcentage"
    ? `${remise.valeur.toLocaleString("fr-FR")}%`
    : `${remise.valeur.toLocaleString("fr-FR", { minimumFractionDigits: 3, maximumFractionDigits: 3 })} DT`;
}

type Row = (string | number | null)[];

interface RowMeta {
  /** Per-column style overrides for this row, keyed by 0-based column index. */
  styles: Record<number, Record<string, unknown>>;
  /** Border applied to every one of the 6 cells in this row. */
  border: Record<string, unknown>;
  /** Row height in points, if this row needs extra height for wrapped text. */
  height?: number;
}

interface SheetBuilder {
  rows: Row[];
  meta: RowMeta[];
}

function newBuilder(): SheetBuilder {
  return { rows: [], meta: [] };
}

function push(b: SheetBuilder, row: Row, meta: RowMeta): void {
  b.rows.push(row);
  b.meta.push(meta);
}

function pushBlankRow(b: SheetBuilder): void {
  push(b, [null, null, null, null, null, null], { styles: {}, border: {} });
}

function pushTitleRow(b: SheetBuilder, text: string, font: Record<string, unknown>): void {
  push(b, [text, null, null, null, null, null], {
    styles: { 0: { font, alignment: { horizontal: "left", vertical: "center" } } },
    border: {},
  });
}

function pushHeaderRow(b: SheetBuilder): void {
  const cellStyle = { font: FONT_HEADER, alignment: { horizontal: "center", vertical: "center", wrapText: true } };
  push(b, HEADER_ROW as Row, {
    styles: { 0: cellStyle, 1: cellStyle, 2: cellStyle, 3: cellStyle, 4: cellStyle, 5: cellStyle },
    border: GRID_HEADER,
    height: 30,
  });
}

function pushChapitreRow(b: SheetBuilder, chapitre: BordereauPdfChapitre): void {
  push(b, [chapitre.numeroRomain, chapitre.nom, null, null, null, null], {
    styles: {
      0: { font: FONT_CHAPITRE, alignment: { horizontal: "center", vertical: "center" } },
      1: { font: FONT_CHAPITRE, alignment: { horizontal: "left", vertical: "center" } },
    },
    border: GRID_TOP_DBL,
  });
}

function pushLigneRow(b: SheetBuilder, ligne: BordereauPdfLigne): void {
  const designation = ligne.isArticle ? `\u203A ${ligne.designation}` : ligne.designation;
  const styles: Record<number, Record<string, unknown>> = {
    0: { font: FONT_NUMERO, alignment: { horizontal: "center", vertical: "top" } },
    1: { font: FONT_BODY, alignment: { horizontal: "left", vertical: "top", wrapText: true } },
    2: { font: FONT_BODY, alignment: { horizontal: "center", vertical: "center" } },
    3: { font: FONT_BODY, alignment: { horizontal: "center", vertical: "top" } },
    4: { font: FONT_BODY, alignment: { horizontal: "right", vertical: "top" } },
    5: { font: FONT_BODY, alignment: { horizontal: "right", vertical: "top" } },
  };
  if (ligne.quantite !== null) styles[3] = { ...styles[3], numFmt: QUANTITE_FORMAT };
  if (ligne.prixUnitaire !== null) styles[4] = { ...styles[4], numFmt: DINARS_FORMAT };
  if (ligne.prixTotal !== null) styles[5] = { ...styles[5], numFmt: DINARS_FORMAT };

  const estimatedLines = Math.max(1, Math.ceil(designation.length / 80));
  push(
    b,
    [ligne.numero, designation, ligne.unite, ligne.quantite, ligne.prixUnitaire, ligne.prixTotal],
    { styles, border: GRID, height: estimatedLines > 1 ? Math.min(15 * estimatedLines, 120) : undefined },
  );
}

function pushLabelValueRow(
  b: SheetBuilder,
  label: string,
  value: number,
  opts: { border: Record<string, unknown>; labelFont: Record<string, unknown>; valueFont: Record<string, unknown> },
): void {
  push(b, [null, label, null, null, null, value], {
    styles: {
      1: { font: opts.labelFont, alignment: { horizontal: "left", vertical: "center" } },
      5: { font: opts.valueFont, alignment: { horizontal: "right", vertical: "center" }, numFmt: DINARS_FORMAT },
    },
    border: opts.border,
  });
}

function pushSousTotalRows(b: SheetBuilder, chapitre: BordereauPdfChapitre): void {
  if (isRemiseActive(chapitre.remise)) {
    pushLabelValueRow(b, `Sous-total brut (${chapitre.numeroRomain})`, chapitre.sousTotalBrut, {
      border: GRID,
      labelFont: FONT_BODY,
      valueFont: FONT_BODY,
    });
    pushLabelValueRow(
      b,
      `Remise (${formatRemiseLabel(chapitre.remise)})`,
      -remiseMontant(chapitre.sousTotalBrut, chapitre.remise),
      { border: GRID, labelFont: FONT_BODY, valueFont: FONT_BODY },
    );
  }
  pushLabelValueRow(b, `S/TOTAL (${chapitre.numeroRomain})`, chapitre.sousTotal, {
    border: GRID_BOTTOM_DBL,
    labelFont: FONT_TOTAL_LABEL,
    valueFont: FONT_TOTAL_VALUE,
  });
}

// ---------------------------------------------------------------------------
// Public entry point — synchronous, same as before. Returns a real Buffer,
// not a Promise, so no call-site changes are needed.
// ---------------------------------------------------------------------------
export function generateBordereauXlsxBuffer(data: BordereauPdfData): Buffer {
  const b = newBuilder();

  pushTitleRow(b, "BORDEREAU DES PRIX & DETAIL ESTIMATIF", FONT_TITLE);
  pushTitleRow(b, `LOT ${data.lot}`, FONT_TITLE);
  pushBlankRow(b);
  pushTitleRow(
    b,
    `${data.chantierNom}${data.chantierClient ? ` — ${data.chantierClient}` : ""}${data.chantierLieu ? ` — ${data.chantierLieu}` : ""}`,
    FONT_SUBTITLE,
  );
  pushTitleRow(
    b,
    `${data.company.companyName ? `${data.company.companyName} · ` : ""}${data.dateImport ? `Marché importé le ${formatDate(data.dateImport)} · ` : ""}Version ${data.version}`,
    FONT_SUBTITLE,
  );
  pushBlankRow(b);

  pushHeaderRow(b);

  for (const chapitre of data.chapitres) {
    pushChapitreRow(b, chapitre);
    for (const ligne of chapitre.lignes) {
      pushLigneRow(b, ligne);
    }
    pushSousTotalRows(b, chapitre);
  }

  pushBlankRow(b);
  if (isRemiseActive(data.remiseGlobale)) {
    pushLabelValueRow(b, "Sous-total (après remises chapitres)", data.totalHtBrut, {
      border: GRID,
      labelFont: FONT_BODY,
      valueFont: FONT_BODY,
    });
    pushLabelValueRow(
      b,
      `Remise globale (${formatRemiseLabel(data.remiseGlobale)})`,
      -remiseMontant(data.totalHtBrut, data.remiseGlobale),
      { border: GRID, labelFont: FONT_BODY, valueFont: FONT_BODY },
    );
  }
  pushLabelValueRow(b, "TOTAL GÉNÉRAL (H.T.V.A)", data.totalHt, {
    border: GRID,
    labelFont: FONT_GRAND_TOTAL_LABEL,
    valueFont: FONT_GRAND_TOTAL_VALUE,
  });
  pushLabelValueRow(b, `T.V.A (${data.tvaPct.toLocaleString("fr-FR")}%)`, data.totalTva, {
    border: GRID,
    labelFont: FONT_GRAND_TOTAL_LABEL,
    valueFont: FONT_GRAND_TOTAL_VALUE,
  });
  if (data.timbreFiscal > 0) {
    pushLabelValueRow(b, "Timbre fiscal", data.timbreFiscal, {
      border: GRID,
      labelFont: FONT_GRAND_TOTAL_LABEL,
      valueFont: FONT_GRAND_TOTAL_VALUE,
    });
  }
  pushLabelValueRow(b, "TOTAL GÉNÉRAL (T.T.C)", data.totalTtc, {
    border: GRID_HEADER,
    labelFont: FONT_GRAND_TOTAL_LABEL,
    valueFont: FONT_GRAND_TOTAL_VALUE,
  });

  const worksheet = XLSX.utils.aoa_to_sheet(b.rows);
  worksheet["!cols"] = COL_WIDTHS;
  worksheet["!rows"] = b.meta.map((m) => (m.height ? { hpt: m.height } : {}));

  // Apply per-cell styles: font/alignment/numFmt from `styles`, plus the
  // row's border on all 6 columns (even blank cells, so the grid stays
  // continuous like the original template).
  b.meta.forEach((m, r) => {
    for (let c = 0; c < 6; c++) {
      const address = XLSX.utils.encode_cell({ r, c });
      if (!worksheet[address]) {
        // Blank cell that aoa_to_sheet didn't create — add an empty one so
        // it can still carry a border.
        worksheet[address] = { t: "z", v: undefined };
      }
      const cell = worksheet[address];
      const cellStyle = m.styles[c];
      cell.s = {
        font: cellStyle?.font,
        alignment: cellStyle?.alignment,
        border: m.border,
      };
      if (cellStyle?.numFmt) cell.z = cellStyle.numFmt as string;
    }
  });

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "Bordereau");
  workbook.Props = {
    Title: `Bordereau ${data.lot} — v${data.version}`,
    Author: data.company.companyName ?? undefined,
  };

  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
}