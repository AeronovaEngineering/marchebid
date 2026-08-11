/**
 * Bordereau des prix PDF generator.
 * -----------------------------------------------------------------------
 * This file owns ALL bordereau PDF rendering and nothing else -- it has
 * no Supabase import, no route/server-fn code, and takes plain data in /
 * returns a Buffer out. `generateBordereauPdfServerFn` in
 * chantiers.$id.recap.$marcheId.tsx is responsible for fetching the data
 * (server-side, via supabaseAdmin -- never trusting client-computed
 * totals), building a `BordereauPdfData` from it, and handling storage
 * upload + the `documents` version row. This file only turns that data
 * into PDF bytes.
 *
 * Layout mirrors the client's own "Bordereau des prix & détail estimatif"
 * template (classic Tunisian BTP BOQ format: N° / Désignation / Unité /
 * Quantité / Prix unitaire / Prix total, grouped into roman-numeral
 * chapters with S/TOTAL rows, closed by a "Récapitulation générale" page
 * with TVA + TOTAL TTC + signature blocks) -- except the price columns
 * are actually filled in, and each line splits into a "fourniture" row
 * (the actual catalogue item chosen) directly followed by its own "Pose"
 * row when installation applies, each with its own unit/total price.
 */
import {
  Document,
  Page,
  View,
  Text,
  StyleSheet,
  renderToBuffer,
} from "@react-pdf/renderer";

// ---------------------------------------------------------------------------
// Data contract
// ---------------------------------------------------------------------------

export interface BordereauPdfLigne {
  numero: string | null;
  /** The actual fourniture chosen for this line (catalogue designation,
   * falling back to the original marché line's designation if unmatched). */
  designation: string;
  unite: string | null;
  quantite: number;
  prixFourniture: number;
  totalFourniture: number;
  aPose: boolean;
  prixPose: number;
  totalPose: number;
}

export interface BordereauPdfChapitre {
  /** Roman numeral assigned in order of first appearance (I, II, III...). */
  numeroRomain: string;
  nom: string;
  lignes: BordereauPdfLigne[];
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
  chapitres: BordereauPdfChapitre[];
  totalHt: number;
  tvaPct: number;
  totalTva: number;
  timbreFiscal: number;
  totalTtc: number;
}

// ---------------------------------------------------------------------------
// Roman numerals -- chapters are numbered in the order they're first seen
// in the marché's lignes (ordre column), same as the reference bordereau
// (I - PRODUCTION DES FRIGORIES, II - EQUIPEMENTS DE VENTILATION, ...).
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
// Formatting -- kept local (no import from src/lib/format.ts) since this
// file must stay import-light enough to run in the server PDF renderer;
// same fr-FR / DT convention as the rest of the app.
// ---------------------------------------------------------------------------
// Intl's fr-FR grouping separator is U+202F (narrow no-break space), which
// the standard 14 PDF fonts (Helvetica included, WinAnsiEncoding) have no
// glyph for -- @react-pdf/renderer then silently drops/mis-renders it. Swap
// it (and the regular no-break space, for safety) for a normal space.
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

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------
// Helvetica / Helvetica-Bold are core fonts built into @react-pdf/renderer
// -- used directly by name below, no Font.register() needed.

const COLS = {
  numero: 32,
  designation: 232,
  unite: 40,
  quantite: 55,
  prixUnitaire: 78,
  prixTotal: 83,
};

const styles = StyleSheet.create({
  page: {
    paddingTop: 90,
    paddingBottom: 56,
    paddingHorizontal: 36,
    fontSize: 8.5,
    fontFamily: "Helvetica",
    color: "#1a1a1a",
  },
  header: {
    position: "absolute",
    top: 24,
    left: 36,
    right: 36,
    borderBottomWidth: 1,
    borderBottomColor: "#333333",
    paddingBottom: 6,
  },
  headerTop: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  headerProject: {
    fontSize: 8,
    color: "#444444",
    maxWidth: 340,
  },
  headerCompany: {
    fontSize: 8,
    color: "#444444",
    textAlign: "right",
  },
  headerTitle: {
    marginTop: 4,
    textAlign: "center",
  },
  headerTitleMain: {
    fontSize: 11,
    fontFamily: "Helvetica-Bold",
    textTransform: "uppercase",
  },
  headerTitleLot: {
    fontSize: 9,
    fontFamily: "Helvetica-Bold",
    marginTop: 1,
  },
  footer: {
    position: "absolute",
    bottom: 20,
    left: 36,
    right: 36,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7,
    color: "#777777",
    borderTopWidth: 0.5,
    borderTopColor: "#cccccc",
    paddingTop: 4,
  },

  // Table
  tableHeaderRow: {
    flexDirection: "row",
    backgroundColor: "#e8e8e8",
    borderBottomWidth: 1,
    borderBottomColor: "#333333",
    paddingVertical: 3,
    fontFamily: "Helvetica-Bold",
    fontSize: 7.5,
    textTransform: "uppercase",
  },
  chapitreRow: {
    flexDirection: "row",
    marginTop: 8,
    paddingVertical: 2,
    borderBottomWidth: 0.75,
    borderBottomColor: "#1a1a1a",
  },
  chapitreLabel: {
    fontFamily: "Helvetica-Bold",
    fontSize: 9,
  },
  ligneRow: {
    flexDirection: "row",
    paddingVertical: 2.5,
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
    paddingVertical: 3,
    borderTopWidth: 0.75,
    borderTopColor: "#1a1a1a",
    fontFamily: "Helvetica-Bold",
  },
  cellNumero: { width: COLS.numero, color: "#555555" },
  cellDesignation: { width: COLS.designation, paddingRight: 4 },
  cellDesignationPose: {
    width: COLS.designation,
    paddingRight: 4,
    paddingLeft: 10,
    fontStyle: "italic",
    color: "#444444",
  },
  cellUnite: { width: COLS.unite, color: "#555555" },
  cellQuantite: { width: COLS.quantite, textAlign: "right" },
  cellPrixUnitaire: { width: COLS.prixUnitaire, textAlign: "right" },
  cellPrixTotal: { width: COLS.prixTotal, textAlign: "right", fontFamily: "Helvetica-Bold" },

  // Recap page
  recapTitle: {
    fontSize: 13,
    fontFamily: "Helvetica-Bold",
    textAlign: "center",
    textTransform: "uppercase",
    marginBottom: 18,
  },
  recapRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
    borderBottomWidth: 0.5,
    borderBottomColor: "#dddddd",
    fontSize: 9.5,
  },
  recapChapitreLabel: { maxWidth: 380 },
  recapChapitreValue: { fontFamily: "Helvetica-Bold" },
  recapTotalsBlock: { marginTop: 18 },
  recapTotalRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 4,
    fontSize: 10,
  },
  recapTotalRowFinal: {
    flexDirection: "row",
    justifyContent: "space-between",
    paddingVertical: 6,
    marginTop: 4,
    borderTopWidth: 1,
    borderTopColor: "#1a1a1a",
    fontSize: 12,
    fontFamily: "Helvetica-Bold",
  },
  signatures: {
    marginTop: 60,
    flexDirection: "row",
    justifyContent: "space-between",
  },
  signatureBlock: { width: 220 },
  signatureLabel: { fontSize: 9, fontFamily: "Helvetica-Bold", marginBottom: 24 },
  signatureSub: { fontSize: 8, color: "#555555" },
});

// ---------------------------------------------------------------------------
// Repeated page chrome
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
        <Text style={styles.headerTitleMain}>Bordereau des prix &amp; détail estimatif</Text>
        <Text style={styles.headerTitleLot}>Lot : {data.lot}</Text>
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
      <Text style={styles.cellNumero}>N°</Text>
      <Text style={styles.cellDesignation}>Désignation des travaux</Text>
      <Text style={styles.cellUnite}>U</Text>
      <Text style={styles.cellQuantite}>Quantité</Text>
      <Text style={styles.cellPrixUnitaire}>P.U. (H.T.V.A)</Text>
      <Text style={styles.cellPrixTotal}>P.T. (H.T.V.A)</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Chapter + line rows
// ---------------------------------------------------------------------------
function LigneBlock({ ligne }: { ligne: BordereauPdfLigne }) {
  return (
    <>
      <View style={styles.ligneRow} wrap={false}>
        <Text style={styles.cellNumero}>{ligne.numero ?? "—"}</Text>
        <Text style={styles.cellDesignation}>{ligne.designation}</Text>
        <Text style={styles.cellUnite}>{ligne.unite ?? "—"}</Text>
        <Text style={styles.cellQuantite}>{formatNumber(ligne.quantite)}</Text>
        <Text style={styles.cellPrixUnitaire}>{formatDinars(ligne.prixFourniture)}</Text>
        <Text style={styles.cellPrixTotal}>{formatDinars(ligne.totalFourniture)}</Text>
      </View>
      {ligne.aPose && (
        <View style={styles.poseRow} wrap={false}>
          <Text style={styles.cellNumero} />
          <Text style={styles.cellDesignationPose}>Pose</Text>
          <Text style={styles.cellUnite}>{ligne.unite ?? "—"}</Text>
          <Text style={styles.cellQuantite}>{formatNumber(ligne.quantite)}</Text>
          <Text style={styles.cellPrixUnitaire}>{formatDinars(ligne.prixPose)}</Text>
          <Text style={styles.cellPrixTotal}>{formatDinars(ligne.totalPose)}</Text>
        </View>
      )}
    </>
  );
}

function ChapitreBlock({ chapitre }: { chapitre: BordereauPdfChapitre }) {
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
      <View style={styles.sousTotalRow} wrap={false}>
        <Text style={[styles.cellNumero, { width: COLS.numero + COLS.designation + COLS.unite + COLS.quantite + COLS.prixUnitaire }]}>
          {`S/TOTAL (${chapitre.numeroRomain})`}
        </Text>
        <Text style={styles.cellPrixTotal}>{formatDinars(chapitre.sousTotal)}</Text>
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Recap page
// ---------------------------------------------------------------------------
function RecapPage({ data }: { data: BordereauPdfData }) {
  return (
    <Page size="A4" style={styles.page}>
      <PageHeader data={data} />
      <PageFooter data={data} />

      <Text style={styles.recapTitle}>Récapitulation générale</Text>

      {data.chapitres.map((chapitre) => (
        <View key={chapitre.numeroRomain} style={styles.recapRow} wrap={false}>
          <Text style={styles.recapChapitreLabel}>
            {chapitre.numeroRomain} — {chapitre.nom}
          </Text>
          <Text style={styles.recapChapitreValue}>{formatDinars(chapitre.sousTotal)}</Text>
        </View>
      ))}

      <View style={styles.recapTotalsBlock}>
        <View style={styles.recapTotalRow}>
          <Text>Total général (H.T.V.A)</Text>
          <Text>{formatDinars(data.totalHt)}</Text>
        </View>
        <View style={styles.recapTotalRow}>
          <Text>{`T.V.A (${formatNumber(data.tvaPct)}%)`}</Text>
          <Text>{formatDinars(data.totalTva)}</Text>
        </View>
        {data.timbreFiscal > 0 && (
          <View style={styles.recapTotalRow}>
            <Text>Timbre fiscal</Text>
            <Text>{formatDinars(data.timbreFiscal)}</Text>
          </View>
        )}
        <View style={styles.recapTotalRowFinal}>
          <Text>Total général (T.T.C)</Text>
          <Text>{formatDinars(data.totalTtc)}</Text>
        </View>
      </View>

      <View style={styles.signatures}>
        <View style={styles.signatureBlock}>
          <Text style={styles.signatureLabel}>Lu et accepté par</Text>
          <Text style={styles.signatureSub}>L'entrepreneur soussigné</Text>
        </View>
        <View style={styles.signatureBlock}>
          <Text style={styles.signatureLabel}>Dressé par</Text>
          <Text style={styles.signatureSub}>{data.company.companyName ?? ""}</Text>
        </View>
      </View>
    </Page>
  );
}

// ---------------------------------------------------------------------------
// Document
// ---------------------------------------------------------------------------
function BordereauDocument({ data }: { data: BordereauPdfData }) {
  // exactOptionalPropertyTypes rejects `author={string | undefined}` outright
  // (an optional prop must be omitted, not passed as undefined) -- so the
  // prop is only spread in when a company name actually exists.
  const documentProps = data.company.companyName ? { author: data.company.companyName } : {};
  return (
    <Document title={`Bordereau ${data.lot} — v${data.version}`} {...documentProps}>
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