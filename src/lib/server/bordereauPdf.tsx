/**
 * Bordereau des prix PDF generator.
 * Matches the exact template format from the XLSX file.
 */
import {
  Document,
  Page,
  View,
  Text,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";
import { isRemiseActive, remiseMontant, type Remise } from "@/lib/bordereauRemises";

// ---------------------------------------------------------------------------
// Data contract
// ---------------------------------------------------------------------------

export interface BordereauPdfLigne {
  numero: string | null;
  designation: string;
  unite: string | null;
  /** null on the article/pose sub-rows — quantité is shown once, on the
   *  description row, and not repeated below it. */
  quantite: number | null;
  /** null on the description row: the official wording has no price of
   *  its own, the fourniture/pose prices are broken out on the sub-rows
   *  below it instead. */
  prixUnitaire: number | null;
  prixTotal: number | null;
  /** Sub-row holding the article chosen from the catalogue (name +
   *  fourniture price), indented under its description row. */
  isArticle?: boolean;
  /** Sub-row holding the pose price, indented under its description row. */
  isPose?: boolean;
  parentNumero?: string;
}

export interface BordereauPdfChapitre {
  numeroRomain: string;
  nom: string;
  lignes: BordereauPdfLigne[];
  /** Chapter subtotal before this chapter's own remise is applied. */
  sousTotalBrut: number;
  /** This chapter's discount, if any. Null/absent = no discount. */
  remise: Remise | null;
  /** Chapter subtotal AFTER this chapter's remise — this is the number
   *  that feeds into the grand total. Equals sousTotalBrut when remise
   *  is inactive. */
  sousTotal: number;
}

export interface BordereauPdfCompany {
  companyName: string | null;
  address: string | null;
  matriculeFiscal: string | null;
}

export interface BordereauPdfData {
  chantierNom: string;
  chantierClient: string | null;
  chantierLieu: string | null;
  lot: string;
  dateImport: string | null;
  version: number;
  company: BordereauPdfCompany;
  /** Preamble paragraphs (the "PREAMBULES" page that precedes the priced
   *  table in the official bordereau) — lot-specific boilerplate clauses,
   *  each entry already carrying its own numbering/bullet prefix (e.g.
   *  "1)   Pour l'ensemble des travaux…", "§   La fourniture de…").
   *  Rendered as its own first page, justified, matching the source
   *  document. Omitted entirely (no blank page) when not provided. */
  preambule?: string[];
  chapitres: BordereauPdfChapitre[];
  /** Sum of chapitres[].sousTotal (i.e. after chapter remises, before the
   *  global remise). Only meaningful to show when remiseGlobale is
   *  active — otherwise it equals totalHt and is redundant. */
  totalHtBrut: number;
  /** The overall discount, if any, applied on top of totalHtBrut. */
  remiseGlobale: Remise | null;
  /** Final total HT — after every chapter remise AND the global remise.
   *  This is what TVA is computed on. */
  totalHt: number;
  tvaPct: number;
  totalTva: number;
  timbreFiscal: number;
  totalTtc: number;
}

// ---------------------------------------------------------------------------
// Roman numerals
// ---------------------------------------------------------------------------
const ROMAN_NUMERALS: [number, string][] = [
  [1000, "M"], [900, "CM"], [500, "D"], [400, "CD"],
  [100, "C"], [90, "XC"], [50, "L"], [40, "XL"],
  [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"],
];

export function toRoman(n: number): string {
  let remaining = n;
  let out = "";
  for (const [value, symbol] of ROMAN_NUMERALS) {
    while (remaining >= value) {
      out += symbol;
      remaining -= value;
    }
  }
  return out || "I";
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
function frNumber(value: number, minimumFractionDigits: number, maximumFractionDigits: number): string {
  return value
    .toLocaleString("fr-FR", { minimumFractionDigits, maximumFractionDigits })
    .replace(/[\u202f\u00a0]/g, " ");
}

function formatDinars(value: number): string {
  return `${frNumber(value, 3, 3)} DT`;
}

function formatNumber(value: number): string {
  return frNumber(value, 0, 2);
}

function formatDate(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("fr-FR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

/** "10%" or "50.000 DT" — used in remise row labels. */
function formatRemiseLabel(remise: Remise): string {
  return remise.type === "pourcentage" ? `${frNumber(remise.valeur, 0, 2)}%` : formatDinars(remise.valeur);
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

// Proportions taken straight from the source XLSX column widths (A 5.85 ·
// B 54.7 · C 4.99 · D 10.7 · E 10.7 · F 13.99), scaled to fill the page's
// actual usable width (595.28pt page − 30pt margins each side = 535.28pt).
// The previous fixed widths summed to 580pt — wider than the page itself,
// which is what was squeezing "PRIX UNITAIRE (H.T.V.A)" into an
// abbreviation-looking wrap in the header row.
const COLS = {
  numero: 31,
  designation: 289,
  unite: 26,
  quantite: 57,
  prixUnitaire: 57,
  prixTotal: 75,
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 85,
    paddingBottom: 50,
    paddingHorizontal: 30,
    fontSize: 8,
    fontFamily: "Helvetica",
    color: "#1a1a1a",
  },
  header: {
    position: "absolute",
    top: 20,
    left: 30,
    right: 30,
    borderBottomWidth: 1,
    borderBottomColor: "#333333",
    paddingBottom: 4,
  },
  headerTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  headerProject: {
    fontSize: 7.5,
    color: "#444444",
    maxWidth: 320,
  },
  headerCompany: {
    fontSize: 7.5,
    color: "#444444",
    textAlign: "right",
    maxWidth: 200,
  },
  headerTitle: {
    marginTop: 4,
    textAlign: "center",
  },
  headerTitleMain: {
    fontSize: 10,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
  },
  headerTitleLot: {
    fontSize: 8.5,
    fontFamily: "Helvetica-Bold",
    marginTop: 1,
  },
  footer: {
    position: "absolute",
    bottom: 16,
    left: 30,
    right: 30,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 6.5,
    color: "#777777",
    borderTopWidth: 0.5,
    borderTopColor: "#cccccc",
    paddingTop: 3,
  },

  tableHeaderRow: {
    flexDirection: "row",
    backgroundColor: "#e8e8e8",
    borderBottomWidth: 1,
    borderBottomColor: "#333333",
    paddingVertical: 2.5,
    fontFamily: "Helvetica-Bold",
    fontSize: 7,
    textTransform: "uppercase",
  },
  chapitreRow: {
    flexDirection: "row",
    marginTop: 6,
    paddingVertical: 2,
    borderBottomWidth: 0.75,
    borderBottomColor: "#1a1a1a",
  },
  chapitreLabel: {
    fontFamily: "Helvetica-Bold",
    fontSize: 8.5,
  },
  ligneRow: {
    flexDirection: "row",
    paddingVertical: 2.5,
    borderBottomWidth: 0.5,
    borderBottomColor: "#dddddd",
  },
  articleRow: {
    flexDirection: "row",
    paddingVertical: 2,
    borderBottomWidth: 0.5,
    borderBottomColor: "#dddddd",
  },
  poseRow: {
    flexDirection: "row",
    paddingVertical: 2,
    borderBottomWidth: 0.5,
    borderBottomColor: "#dddddd",
    backgroundColor: "#f7f7f7",
  },
  sousTotalRow: {
    flexDirection: "row",
    paddingVertical: 2.5,
    borderTopWidth: 0.75,
    borderTopColor: "#1a1a1a",
    fontFamily: "Helvetica-Bold",
    marginTop: 1,
  },
  remiseRow: {
    flexDirection: "row",
    paddingVertical: 1.5,
    fontSize: 7.5,
    color: "#555555",
  },
  remiseRowBrut: {
    flexDirection: "row",
    paddingVertical: 1.5,
    fontSize: 7.5,
    color: "#888888",
    textDecoration: "line-through",
  },
  cellNumero: { width: COLS.numero, color: "#555555" },
  cellDesignation: { width: COLS.designation, paddingRight: 4 },
  cellDesignationArticle: {
    width: COLS.designation,
    paddingRight: 4,
    paddingLeft: 8,
    fontFamily: "Helvetica-Bold",
    color: "#1a1a1a",
  },
  cellDesignationPose: {
    width: COLS.designation,
    paddingRight: 4,
    paddingLeft: 8,
    fontStyle: "italic",
    color: "#444444",
  },
  cellUnite: { width: COLS.unite, color: "#555555" },
  cellQuantite: { width: COLS.quantite, textAlign: "right" },
  cellPrixUnitaire: { width: COLS.prixUnitaire, textAlign: "right" },
  cellPrixTotal: { width: COLS.prixTotal, textAlign: "right", fontFamily: "Helvetica-Bold" },

  recapTitle: {
    fontSize: 12,
    fontFamily: "Helvetica-Bold",
    textAlign: "center",
    textTransform: "uppercase",
    marginBottom: 14,
  },
  recapSubtitle: {
    fontSize: 8,
    textAlign: "center",
    marginBottom: 10,
    color: "#444444",
  },
  recapRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3.5,
    borderBottomWidth: 0.5,
    borderBottomColor: "#dddddd",
    fontSize: 8.5,
  },
  recapChapitreLabel: { maxWidth: 400 },
  recapChapitreValue: { fontFamily: "Helvetica-Bold" },
  recapRemiseRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 1.5,
    paddingLeft: 8,
    fontSize: 7.5,
    color: "#888888",
    fontStyle: "italic",
  },
  recapTotalsBlock: { marginTop: 14 },
  recapTotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 3.5,
    fontSize: 9,
  },
  recapTotalRowFinal: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 5,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: "#1a1a1a",
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
  },
  recapAmountWords: {
    fontSize: 8,
    fontStyle: "italic",
    marginTop: 6,
    color: "#444444",
  },
  signatures: {
    marginTop: 40,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  signatureBlock: { width: 200 },
  signatureLabel: { fontSize: 8, fontFamily: "Helvetica-Bold", marginBottom: 20 },
  signatureSub: { fontSize: 7, color: "#555555" },
  signatureLine: { fontSize: 7, color: "#555555", marginTop: 2 },

  preambleTitle: {
    fontSize: 15,
    fontFamily: "Helvetica-Bold",
    textDecoration: "underline",
    marginTop: 10,
    marginBottom: 16,
  },
  preambleParagraph: {
    fontSize: 9.5,
    textAlign: "justify",
    lineHeight: 1.5,
    marginBottom: 10,
  },
  preambleSubParagraph: {
    fontSize: 9.5,
    textAlign: "justify",
    lineHeight: 1.5,
    marginBottom: 6,
    paddingLeft: 14,
  },
});

// ---------------------------------------------------------------------------
// Page chrome
// ---------------------------------------------------------------------------
function PageHeader({ data }: { data: BordereauPdfData }) {
  return (
    <View style={styles.header} fixed>
      <View style={styles.headerTop}>
        <Text style={styles.headerProject}>
          {data.chantierNom}
          {data.chantierClient ? ` — ${data.chantierClient}` : ""}
          {data.chantierLieu ? `\n${data.chantierLieu}` : ""}
        </Text>
        {data.company.companyName && (
          <Text style={styles.headerCompany}>
            {data.company.companyName}
            {data.company.address ? `\n${data.company.address}` : ""}
          </Text>
        )}
      </View>
      <View style={styles.headerTitle}>
        <Text style={styles.headerTitleMain}>BORDEREAU DES PRIX &amp; DETAIL ESTIMATIF</Text>
        <Text style={styles.headerTitleLot}>LOT {data.lot}</Text>
      </View>
    </View>
  );
}

function PageFooter({ data }: { data: BordereauPdfData }) {
  return (
    <View style={styles.footer} fixed>
      <Text>
        {data.dateImport ? `Marché importé le ${formatDate(data.dateImport)} · ` : ""}
        Version {data.version}
      </Text>
      <Text
        render={({ pageNumber, totalPages }) => `Page ${pageNumber} / ${totalPages}`}
      />
    </View>
  );
}

function TableHeaderRow() {
  return (
    <View style={styles.tableHeaderRow}>
      <Text style={styles.cellNumero}>N° DES PRIX</Text>
      <Text style={styles.cellDesignation}>DESIGNATION DES TRAVAUX</Text>
      <Text style={styles.cellUnite}>U</Text>
      <Text style={styles.cellQuantite}>QUANTITE</Text>
      <Text style={styles.cellPrixUnitaire}>PRIX UNITAIRE (H.T.V.A)</Text>
      <Text style={styles.cellPrixTotal}>PRIX TOTAL (H.T.V.A)</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Line blocks
// ---------------------------------------------------------------------------
function LigneBlock({ ligne }: { ligne: BordereauPdfLigne }) {
  // Three row shapes share this block:
  //  - description row (isArticle/isPose both false): the official
  //    bordereau wording, verbatim, never replaced by the chosen
  //    article's name. Carries numero/unité/quantité; no price of its
  //    own — that's broken out on the sub-rows below.
  //  - article row (isArticle): the selected catalogue item's name and
  //    fourniture price, indented under its description.
  //  - pose row (isPose): the pose price, indented under its description.
  const rowStyle = ligne.isPose ? styles.poseRow : ligne.isArticle ? styles.articleRow : styles.ligneRow;
  const designationStyle = ligne.isPose
    ? styles.cellDesignationPose
    : ligne.isArticle
      ? styles.cellDesignationArticle
      : styles.cellDesignation;
  const designationText = ligne.isArticle ? `\u203A ${ligne.designation}` : ligne.designation;

  return (
    <View style={rowStyle} wrap={false}>
      <Text style={styles.cellNumero}>{ligne.numero ?? ""}</Text>
      <Text style={designationStyle}>{designationText}</Text>
      <Text style={styles.cellUnite}>{ligne.unite ?? ""}</Text>
      <Text style={styles.cellQuantite}>{ligne.quantite !== null ? formatNumber(ligne.quantite) : ""}</Text>
      <Text style={styles.cellPrixUnitaire}>
        {ligne.prixUnitaire !== null ? formatDinars(ligne.prixUnitaire) : ""}
      </Text>
      <Text style={styles.cellPrixTotal}>
        {ligne.prixTotal !== null ? formatDinars(ligne.prixTotal) : ""}
      </Text>
    </View>
  );
}

// Width of the "label" span used by the remise/sous-total rows — numero
// through prixUnitaire combined, so only the prixTotal column carries a
// value, matching how sousTotalRow already lays out S/TOTAL.
const REMISE_LABEL_WIDTH = COLS.numero + COLS.designation + COLS.unite + COLS.quantite + COLS.prixUnitaire;

function ChapitreBlock({ chapitre }: { chapitre: BordereauPdfChapitre }) {
  const hasRemise = isRemiseActive(chapitre.remise);
  return (
    <View>
      <View style={styles.chapitreRow} wrap={false}>
        <Text style={styles.chapitreLabel}>
          {chapitre.numeroRomain} — {chapitre.nom}
        </Text>
      </View>
      {chapitre.lignes.map((ligne, i) => (
        <LigneBlock key={`${chapitre.numeroRomain}-${i}`} ligne={ligne} />
      ))}
      {hasRemise && (
        <View style={styles.remiseRowBrut} wrap={false}>
          <Text style={[styles.cellNumero, { width: REMISE_LABEL_WIDTH }]}>
            Sous-total brut ({chapitre.numeroRomain})
          </Text>
          <Text style={styles.cellPrixTotal}>{formatDinars(chapitre.sousTotalBrut)}</Text>
        </View>
      )}
      {hasRemise && (
        <View style={styles.remiseRow} wrap={false}>
          <Text style={[styles.cellNumero, { width: REMISE_LABEL_WIDTH }]}>
            Remise ({formatRemiseLabel(chapitre.remise!)})
          </Text>
          <Text style={styles.cellPrixTotal}>
            -{formatDinars(remiseMontant(chapitre.sousTotalBrut, chapitre.remise))}
          </Text>
        </View>
      )}
      <View style={styles.sousTotalRow} wrap={false}>
        <Text style={[styles.cellNumero, { width: REMISE_LABEL_WIDTH }]}>
          S/TOTAL ({chapitre.numeroRomain})
        </Text>
        <Text style={styles.cellPrixTotal}>{formatDinars(chapitre.sousTotal)}</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Preamble page — the lot-specific boilerplate clauses that precede the
// priced table in the official bordereau (source doc: rows 5–31 of the
// XLSX, "PREAMBULES"). Only rendered when the caller actually supplies
// paragraphs; omitted entirely otherwise rather than showing a blank page.
// Paragraphs beginning with "§" render with a hanging sub-indent to match
// the source's nested bullet clauses under each numbered point.
// ---------------------------------------------------------------------------
function PreamblePage({ data }: { data: BordereauPdfData }) {
  if (!data.preambule || data.preambule.length === 0) return null;
  return (
    <Page size="A4" style={styles.page}>
      <PageHeader data={data} />
      <PageFooter data={data} />

      <Text style={styles.preambleTitle}>PREAMBULES</Text>

      {data.preambule.map((paragraph, i) => (
        <Text
          key={i}
          style={paragraph.trim().startsWith("§") ? styles.preambleSubParagraph : styles.preambleParagraph}
        >
          {paragraph}
        </Text>
      ))}
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Recap page
// ---------------------------------------------------------------------------
function RecapPage({ data }: { data: BordereauPdfData }) {
  const hasRemiseGlobale = isRemiseActive(data.remiseGlobale);
  return (
    <Page size="A4" style={styles.page}>
      <PageHeader data={data} />
      <PageFooter data={data} />

      <Text style={styles.recapTitle}>RÉCAPITULATION GÉNÉRALE</Text>
      <Text style={styles.recapSubtitle}>
        {data.chantierNom} · LOT: {data.lot}
      </Text>

      {data.chapitres.map((chapitre) => {
        const hasChapitreRemise = isRemiseActive(chapitre.remise);
        return (
          <View key={chapitre.numeroRomain}>
            <View style={styles.recapRow} wrap={false}>
              <Text style={styles.recapChapitreLabel}>
                {chapitre.numeroRomain} — {chapitre.nom} (S/Total {chapitre.numeroRomain})
              </Text>
              <Text style={styles.recapChapitreValue}>{formatDinars(chapitre.sousTotal)}</Text>
            </View>
            {hasChapitreRemise && (
              <View style={styles.recapRemiseRow} wrap={false}>
                <Text>
                  dont remise {formatRemiseLabel(chapitre.remise!)} sur {formatDinars(chapitre.sousTotalBrut)}
                </Text>
                <Text>-{formatDinars(remiseMontant(chapitre.sousTotalBrut, chapitre.remise))}</Text>
              </View>
            )}
          </View>
        );
      })}

      <View style={styles.recapTotalsBlock}>
        {hasRemiseGlobale && (
          <>
            <View style={styles.recapTotalRow}>
              <Text>Sous-total (après remises chapitres)</Text>
              <Text>{formatDinars(data.totalHtBrut)}</Text>
            </View>
            <View style={styles.recapTotalRow}>
              <Text>Remise globale ({formatRemiseLabel(data.remiseGlobale!)})</Text>
              <Text>-{formatDinars(remiseMontant(data.totalHtBrut, data.remiseGlobale))}</Text>
            </View>
          </>
        )}
        <View style={styles.recapTotalRow}>
          <Text>TOTAL GÉNÉRAL (H.T.V.A)</Text>
          <Text>{formatDinars(data.totalHt)}</Text>
        </View>
        <View style={styles.recapTotalRow}>
          <Text>T.V.A ({formatNumber(data.tvaPct)}%)</Text>
          <Text>{formatDinars(data.totalTva)}</Text>
        </View>
        {data.timbreFiscal > 0 && (
          <View style={styles.recapTotalRow}>
            <Text>Timbre fiscal</Text>
            <Text>{formatDinars(data.timbreFiscal)}</Text>
          </View>
        )}
        <View style={styles.recapTotalRowFinal}>
          <Text>TOTAL GÉNÉRAL (T.T.C)</Text>
          <Text>{formatDinars(data.totalTtc)}</Text>
        </View>
      </View>

      <Text style={styles.recapAmountWords}>
        Arrêté le présent détail estimatif T.T.C à la somme de : {formatDinars(data.totalTtc)}
      </Text>

      <View style={styles.signatures}>
        <View style={styles.signatureBlock}>
          <Text style={styles.signatureLabel}>Lu et Accepté par</Text>
          <Text style={styles.signatureSub}>L'Entrepreneur Soussigné</Text>
          <Text style={styles.signatureLine}>.................... le..........</Text>
        </View>
        <View style={styles.signatureBlock}>
          <Text style={styles.signatureLabel}>Dressé par</Text>
          <Text style={styles.signatureSub}>{data.company.companyName ?? "BEST engineering"}</Text>
          <Text style={styles.signatureLine}>.................... le..........</Text>
        </View>
      </View>

      <View style={{ marginTop: 16 }}>
        <Text style={styles.signatureLabel}>Vu et approuvé par</Text>
        <Text style={styles.signatureSub}>……………………………………………</Text>
        <Text style={styles.signatureLine}>Tunis, le.....……………</Text>
      </View>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------
function BordereauDocument({ data }: { data: BordereauPdfData }) {
  const documentProps = data.company.companyName ? { author: data.company.companyName } : {};
  return (
    <Document title={`Bordereau ${data.lot} — v${data.version}`} {...documentProps}>
      <PreamblePage data={data} />
      <Page size="A4" style={styles.page} wrap>
        <PageHeader data={data} />
        <PageFooter data={data} />
        <TableHeaderRow />
        {data.chapitres.map((chapitre) => (
          <ChapitreBlock key={chapitre.numeroRomain} chapitre={chapitre} />
        ))}
      </Page>
      <RecapPage data={data} />
    </Document>
  );
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
export async function generateBordereauPdfBuffer(data: BordereauPdfData): Promise<Buffer> {
  return renderToBuffer(<BordereauDocument data={data} />);
}