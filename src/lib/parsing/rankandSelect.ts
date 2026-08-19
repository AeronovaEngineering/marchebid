import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";

// ---------------------------------------------------------------------------
// 1. Types
// ---------------------------------------------------------------------------
export interface MarcheLigne {
  numero?: string | null;
  designation: string;
  unite?: string | null;
  quantite?: number | null;
  chapitre_ou_zone?: string | null;
}

export interface CatalogueItem {
  id: string;
  designation: string;
  categorie?: string | null;
  sous_categorie?: string | null;
  specs?: Record<string, unknown> | null;
  prix_fourniture?: number | null;
  unite?: string | null;
}

export interface ScoredCandidate {
  catalogueItem: CatalogueItem;
  categoryScore: number;
  textScore: number;
  /** Structured-spec match against the candidate's real specs JSONB — see
   *  computeSpecMatchScore. Primary ranking signal whenever the ligne's
   *  local extraction found usable specs; 0 (no signal) otherwise.
   *  +2 per genuinely matching key/value, -1 per key present on both
   *  sides that disagrees, 0 for a key present on only one side (missing
   *  data isn't evidence of a mismatch), plus a small mots_cles bonus. */
  specMatchScore: number;
  /** True when at least one structured spec (diamètre, pression, etc.)
   *  genuinely matched between the ligne and this candidate. Used to
   *  floor candidates that only conflict — see allSpecsConflict. */
  hasGenuineSpecMatch: boolean;
  /** True when there was at least one comparable structured spec AND
   *  every one of them disagreed (no genuine match at all) — this
   *  candidate actively conflicts on everything that could be checked.
   *  Such a candidate must rank below any candidate with even one
   *  genuine match, regardless of price or text score: a candidate
   *  that's simply silent on a spec is not worse than one that's
   *  actively wrong about it. */
  allSpecsConflict: boolean;
  price: number;
}

export interface Decision {
  chosen_catalogue_id: string | null;
  /** "none" means no real candidate was available to choose from (empty
   *  candidate pool, a category with zero catalogue matches, or a failed
   *  selection call) — chosen_catalogue_id is null and nothing was
   *  actually evaluated. "low" is reserved for a genuine, evaluated match
   *  that just isn't a strong one; conflating the two misleads callers
   *  into treating "we found nothing" the same as "we found a weak fit". */
  confidence: "high" | "medium" | "low" | "none";
  justification: string;
}

export interface ProcessResult {
  marche_ligne_numero: string | null;
  candidates_considered: string[];
  decision: Decision;
}

// ---------------------------------------------------------------------------
// 2. Unit normalization — same alias table as the Python version
// ---------------------------------------------------------------------------
const UNIT_ALIASES: Record<string, string> = {
  u: "u",
  unite: "u",
  "unité": "u",
  ml: "ml",
  "m.l": "ml",
  "mètre linéaire": "ml",
  "metre lineaire": "ml",
  ens: "ens",
  "l'ensemble": "ens",
  ensemble: "ens",
  kg: "kg",
  m2: "m2",
  "m²": "m2",
  m3: "m3",
  "m³": "m3",
};

export function normalizeUnit(u: string | null | undefined): string | null {
  if (!u) return null;
  const key = u.trim().toLowerCase();
  return UNIT_ALIASES[key] ?? key;
}

// ---------------------------------------------------------------------------
// 3. Fuzzy text scoring — token_set_ratio, dependency-free port of the
//    rapidfuzz algorithm the Python version relies on.
// ---------------------------------------------------------------------------
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "") // strip accents (é -> e) for looser matching
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Classic Levenshtein ratio: 2*matches / (len(a)+len(b)) as a percentage,
 *  same formula rapidfuzz/python-Levenshtein use for `ratio`. */
function levenshteinRatio(a: string, b: string): number {
  if (a === b) return 100;
  const la = a.length;
  const lb = b.length;
  if (la === 0 || lb === 0) return 0;

  let prev = new Array(lb + 1);
  let curr = new Array(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;

  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  const dist = prev[lb];
  return ((la + lb - dist) / (la + lb)) * 100;
}

/** Core of token_set_ratio, operating on already-tokenized sets. Split apart
 *  from tokenSetRatio() so that at scale the (more expensive) tokenization
 *  step can be done ONCE per string and reused — e.g. the catalogue side's
 *  tokens are computed once in CatalogueIndex, not re-tokenized on every
 *  one of the hundreds of marche_lignes compared against it. */
function tokenSetRatioFromSets(tokensA: Set<string>, tokensB: Set<string>): number {
  if (tokensA.size === 0 && tokensB.size === 0) return 100;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  const intersection = [...tokensA].filter((t) => tokensB.has(t)).sort();
  const diffA = [...tokensA].filter((t) => !tokensB.has(t)).sort();
  const diffB = [...tokensB].filter((t) => !tokensA.has(t)).sort();

  const sortedIntersection = intersection.join(" ");
  const combinedA = [...intersection, ...diffA].join(" ");
  const combinedB = [...intersection, ...diffB].join(" ");

  return Math.max(
    levenshteinRatio(sortedIntersection, combinedA),
    levenshteinRatio(sortedIntersection, combinedB),
    levenshteinRatio(combinedA, combinedB)
  );
}

/** token_set_ratio: split both strings into token sets, compare
 *  (intersection) against (intersection+leftoverA), (intersection+leftoverB)
 *  and (combinedA vs combinedB), take the max ratio. This is what makes it
 *  robust to word reordering and one string being a superset of the other
 *  — exactly the fuzzywuzzy/rapidfuzz behavior the Python version uses.
 *
 *  Convenience form that tokenizes both inputs; for hot loops (scoring one
 *  marche_ligne against hundreds of catalogue items) prefer precomputing
 *  token sets once and calling tokenSetRatioFromSets directly — see
 *  CatalogueIndex / scoreCandidate below. */
export function tokenSetRatio(a: string, b: string): number {
  return tokenSetRatioFromSets(new Set(tokenize(a)), new Set(tokenize(b)));
}

function flattenSpecs(specs: Record<string, unknown> | null | undefined): string {
  if (!specs) return "";
  return Object.entries(specs)
    .map(([k, v]) => `${k} ${v}`)
    .join(" ");
}

// ---------------------------------------------------------------------------
// 3b. Local (no-network) spec extraction — pure regex/keyword extraction of
//     structured data out of a marche_ligne's designation text. Produces the
//     exact same shape a future Haiku-based extractor would produce, so
//     rankCandidates/selectWithHaiku never need to know which one actually
//     ran for a given import job: swap this out for an LLM call later
//     without touching anything downstream.
// ---------------------------------------------------------------------------
export interface ExtractedLigneSpecs {
  categorie: string | null;
  sous_categorie: string | null;
  mots_cles: string[];
  specs: Record<string, string>;
}

/** Diamètre — "ø 100", "ø100", "ø intérieur 12", "ø extérieur 16",
 *  "DN 25", "DN15/20", "diamètre 1''". DN checked first since it's
 *  unambiguous; the ø/diamètre-word forms fall through in order. */
function extractDiametre(text: string): string | null {
  const dn = text.match(/\bDN\s*(\d+(?:\s*\/\s*\d+)?)/i);
  if (dn) return `DN${(dn[1] ?? "").replace(/\s+/g, "")}`;

  const oe = text.match(/[øØ]\s*(int[ée]rieur|ext[ée]rieur)?\s*(\d+(?:[.,]\d+)?)\s*(mm|cm)?/i);
  if (oe) {
    const qualifier = oe[1] ? `${stripAccents(oe[1]).toLowerCase()} ` : "";
    const unit = oe[3] ? oe[3].toLowerCase() : "mm";
    return `ø ${qualifier}${oe[2]}${unit}`;
  }

  // "diamètre 1''" / "diamètre 1 pouce" — inch forms, checked before the
  // plain-number fallback below.
  const inch = text.match(/diam[eè]tre\s*(?:de\s*)?(\d+(?:[.,]\d+)?)\s*(''|"|pouces?\b|po\b)/i);
  if (inch) return `${inch[1]}''`;

  const word = text.match(/diam[eè]tre\s*(?:de\s*)?(\d+(?:[.,]\d+)?)\s*(mm|cm)?/i);
  if (word) return `${word[1]}${word[2] ?? "mm"}`;

  return null;
}

/** Débit — "100m3/h", "300 m3/h", "débit 2m3/h", "débit de 60 à 100m3/h". */
function extractDebit(text: string): string | null {
  const range = text.match(
    /d[ée]bit\s*(?:de\s*)?(\d+(?:[.,]\d+)?)\s*[àa]\s*(\d+(?:[.,]\d+)?)\s*m\s*[3³]\s*\/\s*h/i
  );
  if (range) return `${range[1]} à ${range[2]} m3/h`;

  const single = text.match(/(\d+(?:[.,]\d+)?)\s*m\s*[3³]\s*\/\s*h/i);
  if (single) return `${single[1]}m3/h`;

  return null;
}

/** Pression — "10 bar", "10Bars", "PN16", "PN 10". */
function extractPression(text: string): string | null {
  const pn = text.match(/\bPN\s*(\d+(?:[.,]\d+)?)/i);
  if (pn) return `PN${pn[1]}`;

  const bar = text.match(/(\d+(?:[.,]\d+)?)\s*bars?\b/i);
  if (bar) return `${bar[1]}bar`;

  return null;
}

/** Puissance — "12000 BTU", "300W", "500W". BTU checked first so it isn't
 *  swallowed by the (deliberately narrow) watt pattern. */
function extractPuissance(text: string): string | null {
  const btu = text.match(/(\d+(?:[.,]\d+)?)\s*BTU\b/i);
  if (btu) return `${btu[1]} BTU`;

  const watt = text.match(/(\d+(?:[.,]\d+)?)\s*[wW](?![a-zA-Z])/);
  if (watt) return `${watt[1]}W`;

  return null;
}

/** Dimensions — "150 cm²", "20x20cm", "400x250", "250 x 250". An
 *  un-suffixed "AxB" is only trusted as a physical dimension when both
 *  numbers are already in a plausible fixture/duct size range — bare
 *  small-number "AxB" (e.g. "16x2", "12x1") is the BTP pipe-sizing
 *  convention for diamètre x épaisseur, not a width x height, and is
 *  deliberately left alone here rather than mislabeled. */
function extractDimensions(text: string): string | null {
  const wh = text.match(/(\d+(?:[.,]\d+)?)\s*[xX×]\s*(\d+(?:[.,]\d+)?)\s*(cm|mm|m)?\b/);
  if (wh) {
    const a = parseFloat((wh[1] ?? "").replace(",", "."));
    const b = parseFloat((wh[2] ?? "").replace(",", "."));
    const unit = wh[3];
    if (unit || (a >= 10 && b >= 10)) {
      return `${wh[1]}x${wh[2]}${unit ?? ""}`;
    }
  }

  const area = text.match(/(\d+(?:[.,]\d+)?)\s*cm\s*[²2]/i);
  if (area) return `${area[1]}cm²`;

  return null;
}

/** Matériau — first keyword match, checked in list order (not first
 *  occurring in the text). Matched against the accent-stripped/lowercased
 *  designation so "acier galvanisé" matches regardless of accents/case. */
const MATERIAU_KEYWORDS: string[] = [
  "laiton",
  "pvc",
  "cuivre",
  "acier galvanise",
  "aluminium",
  "inox",
  "bronze",
  "polyethylene",
  "multicouche",
  "ceramique",
  "acrylique",
  "porcelaine",
];

function extractMateriau(normalizedText: string): string | null {
  for (const kw of MATERIAU_KEYWORDS) {
    if (normalizedText.includes(kw)) return kw;
  }
  return null;
}

/** Stopwords that show up in nearly every bordereau line and carry no
 *  distinguishing signal, plus the unit/code tokens that are already
 *  captured under `specs` above and would just be noise in `mots_cles`. */
const MOTS_CLES_STOPWORDS = new Set([
  "fourniture", "fournitures", "pose", "compris", "comprise", "comprises",
  "non", "toutes", "tout", "toute", "sujetion", "sujetions", "raccordement",
  "raccordements", "et", "de", "des", "du", "la", "le", "les", "en", "pour",
  "avec", "sans", "un", "une", "sur", "dans", "par", "y", "ainsi", "que",
  "ou", "a", "comprenant", "mise", "oeuvre", "execution", "suivant", "selon",
  "au", "aux", "ce", "cet", "cette", "ses", "leur", "leurs",
]);
const MOTS_CLES_UNIT_TOKENS = new Set([
  "mm", "cm", "m", "m2", "m3", "ml", "kg", "l", "u", "ens", "dn", "pn",
  "bar", "bars", "btu", "w", "po", "pouce", "pouces",
]);

/** Pulls the 3-6 most distinctive nouns out of a designation: tokenize,
 *  drop stopwords/units/short tokens, and drop any token containing a
 *  digit (measurements and codes already live in `specs`, not here). */
function extractMotsCles(designation: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokenize(designation)) {
    if (out.length >= 6) break;
    if (t.length < 3) continue;
    if (/\d/.test(t)) continue;
    if (MOTS_CLES_STOPWORDS.has(t) || MOTS_CLES_UNIT_TOKENS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

interface CategoryRule {
  categorie: string;
  /** Keywords that identify this categorie, checked against both the
   *  designation and chapitre_ou_zone tokens. */
  categoryKeywords: string[];
  sousCategories: { label: string; keywords: string[] }[];
}

/** Built from the REAL distinct (categorie, sous_categorie) pairs seeded
 *  into materiel_catalogue (supabase/migrations/202608070000002_seed.sql)
 *  — a live `select distinct categorie, sous_categorie from
 *  materiel_catalogue` wasn't reachable from this sandbox (Supabase isn't
 *  on the allowed network list here), so this is the real ground truth
 *  available in-repo. Re-check against the live table once supplier
 *  imports have added more categories/sous_categories than the seed data
 *  covers, and extend the rules below to match.
 *
 *  Gaz is checked before Tuyauterie/Robinets: real gaz-lot items ("Tube
 *  cuivre 12x1 (gaz)", "Vanne gaz 1/2\" bronze") would otherwise be
 *  misclassified purely off the generic word "tube"/"vanne". */
const CATEGORY_RULES: CategoryRule[] = [
  {
    categorie: "Gaz",
    categoryKeywords: ["gaz"],
    sousCategories: [
      { label: "Tuyauterie cuivre", keywords: ["cuivre", "tube", "tuyau"] },
      { label: "Vannes gaz", keywords: ["vanne"] },
      { label: "Flexibles", keywords: ["flexible"] },
    ],
  },
  {
    categorie: "Sanitaires",
    categoryKeywords: [
      "lavabo", "baignoire", "wc", "sanitaire", "sanitaires", "douche",
      "evier", "robinetterie", "mitigeur", "melangeur",
    ],
    sousCategories: [
      { label: "Lavabos", keywords: ["lavabo", "vasque"] },
      { label: "Baignoires", keywords: ["baignoire", "douche"] },
      { label: "WC", keywords: ["wc", "toilette", "cuvette"] },
      { label: "Robinetterie", keywords: ["robinetterie", "mitigeur", "melangeur"] },
    ],
  },
  {
    categorie: "Ventilation",
    categoryKeywords: ["extracteur", "gaine", "ventilation", "ventilateur"],
    sousCategories: [
      { label: "Extracteurs", keywords: ["extracteur", "ventilateur", "extraction"] },
      { label: "Gaines", keywords: ["gaine", "conduit"] },
    ],
  },
  {
    categorie: "Climatisation",
    categoryKeywords: ["climatiseur", "split", "climatisation"],
    sousCategories: [{ label: "Splits", keywords: ["split", "climatiseur"] }],
  },
  {
    categorie: "Robinets",
    categoryKeywords: ["vanne", "robinet", "clapet"],
    sousCategories: [
      { label: "Vannes", keywords: ["vanne"] },
      { label: "Clapets", keywords: ["clapet", "antiretour"] },
    ],
  },
  {
    categorie: "Tuyauterie",
    categoryKeywords: ["tuyauterie", "tube", "tuyau", "coude"],
    sousCategories: [
      { label: "Multicouche", keywords: ["multicouche", "per", "pex"] },
      { label: "PVC", keywords: ["pvc"] },
    ],
  },
];

/** Infers categorie/sous_categorie from the keyword table above, checking
 *  the designation first and falling back to chapitre_ou_zone (a bordereau
 *  zone label like "Sanitaire"/"Tuyauterie" is itself a strong, often
 *  literal, category signal). Multi-word keywords (e.g. "acier
 *  galvanise") are matched as a substring of the normalized text rather
 *  than as a single token. Leaves both fields null rather than guessing
 *  when nothing matches confidently. */
function inferCategorie(
  designation: string,
  zone: string | null | undefined
): { categorie: string | null; sous_categorie: string | null } {
  const normalizedDesignation = stripAccents(designation).toLowerCase();
  const designationTokens = new Set(tokenize(designation));
  const zoneTokens = new Set(tokenize(zone ?? ""));

  const matchesKeyword = (tokens: Set<string>, normalizedText: string, kw: string): boolean =>
    kw.includes(" ") ? normalizedText.includes(kw) : tokens.has(kw);

  for (const rule of CATEGORY_RULES) {
    const hitDesignation = rule.categoryKeywords.some((kw) =>
      matchesKeyword(designationTokens, normalizedDesignation, kw)
    );
    const hitZone = rule.categoryKeywords.some((kw) => matchesKeyword(zoneTokens, "", kw));
    if (!hitDesignation && !hitZone) continue;

    let sous_categorie: string | null = null;
    for (const sc of rule.sousCategories) {
      if (sc.keywords.some((kw) => matchesKeyword(designationTokens, normalizedDesignation, kw))) {
        sous_categorie = sc.label;
        break;
      }
    }
    return { categorie: rule.categorie, sous_categorie };
  }
  return { categorie: null, sous_categorie: null };
}

function stripAccents(s: string): string {
  return s.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
}

/** Diameter-like spec normalization — parses ø/Φ/DN/diamètre/diam/
 *  intérieur/extérieur notations down to a plain number in millimetres,
 *  so two diameter specs can be compared as NUMBERS instead of raw
 *  strings. That matters in practice: "ø 100mm", "100mm", and "DN100"
 *  can all describe the same real-world measurement but are three
 *  different strings, and would wrongly register as a spec conflict
 *  under exact string comparison. All those prefixes/labels are treated
 *  as equivalent notations for "this is a diameter" and stripped before
 *  parsing; DN nominal sizes get no extra conversion since this
 *  catalogue's DN values are already mm-equivalent. Unit is assumed to
 *  be mm — this dataset's overwhelming default — unless the value is
 *  explicitly suffixed with cm (×10) or a bare m (×1000). Inch-denoted
 *  values ('', ", pouce, po) are left unparsed rather than guessed at:
 *  converting them would require an interpretation the raw label doesn't
 *  make explicit, and this function must never guess a unit. Returns
 *  null when nothing numeric is found — callers must treat that as
 *  "can't compare", never as a silent 0mm. */
export function normalizeDiameter(raw: string | null | undefined): number | null {
  if (!raw) return null;
  let text = stripAccents(String(raw)).toLowerCase();

  if (/(''|"|\bpouces?\b|\bpo\b)/.test(text)) return null;

  text = text
    .replace(/[øφ]/g, " ")
    .replace(/diam(?:etre)?/g, " ")
    .replace(/\bdn/g, " ")
    .replace(/interieur/g, " ")
    .replace(/exterieur/g, " ");

  const match = text.match(/(\d+(?:[.,]\d+)?)\s*(mm|cm|m)?/);
  if (!match) return null;

  const value = parseFloat(match[1].replace(",", "."));
  if (Number.isNaN(value)) return null;

  if (match[2] === "cm") return value * 10;
  if (match[2] === "m") return value * 1000;
  return value;
}

/** Débit normalization — parses "100m3/h", "débit 100 m3/h", the lower
 *  bound of a range ("débit de 60 à 100m3/h"), etc. down to a plain
 *  number in m3/h. This dataset only ever expresses débit in m3/h, so
 *  there's no unit conversion to do here — the point is purely comparing
 *  numbers instead of two differently-formatted but numerically
 *  identical strings. Returns null when nothing numeric is found. */
export function normalizeDebit(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const text = stripAccents(String(raw)).toLowerCase();
  const match = text.match(/(\d+(?:[.,]\d+)?)/);
  if (!match) return null;
  const value = parseFloat(match[1].replace(",", "."));
  return Number.isNaN(value) ? null : value;
}

/** Puissance normalization — parses "300W" / "12000 BTU" down to a plain
 *  number in watts, converting BTU/h → W (×0.29307107) so a puissance
 *  expressed in either unit compares as the same underlying quantity
 *  instead of two incomparable strings. Unlike diamètre, there's no
 *  implicit default here — the unit tag (W or BTU) is what's present in
 *  every locally-extracted or catalogue puissance value, so a value with
 *  neither is left unparsed rather than guessed at. Returns null when
 *  nothing numeric is found. */
const BTU_TO_WATTS = 0.29307107;

export function normalizePuissance(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const text = stripAccents(String(raw)).toLowerCase();

  const btu = text.match(/(\d+(?:[.,]\d+)?)\s*btu/);
  if (btu) {
    const value = parseFloat(btu[1].replace(",", "."));
    return Number.isNaN(value) ? null : value * BTU_TO_WATTS;
  }

  const watt = text.match(/(\d+(?:[.,]\d+)?)\s*w\b/);
  if (watt) {
    const value = parseFloat(watt[1].replace(",", "."));
    return Number.isNaN(value) ? null : value;
  }

  return null;
}

/**
 * Pure, no-network extraction of structured data out of a marche_ligne's
 * designation (regex + keyword matching only — same shape a future
 * Haiku-based extractor would produce). Intended as the fast/free default
 * so the ranking stage (rankCandidates, prompt #2 in selectWithHaiku)
 * never needs to know or care whether this or an LLM produced the specs
 * it's scoring against.
 */
export function extractLigneSpecsLocal(ligne: MarcheLigne): ExtractedLigneSpecs {
  const { designation } = ligne;
  const normalized = stripAccents(designation).toLowerCase();

  const specs: Record<string, string> = {};
  const diametre = extractDiametre(designation);
  if (diametre) specs["diametre"] = diametre;
  const debit = extractDebit(designation);
  if (debit) specs["debit"] = debit;
  const pression = extractPression(designation);
  if (pression) specs["pression"] = pression;
  const puissance = extractPuissance(designation);
  if (puissance) specs["puissance"] = puissance;
  const dimensions = extractDimensions(designation);
  if (dimensions) specs["dimensions"] = dimensions;
  const materiau = extractMateriau(normalized);
  if (materiau) specs["materiau"] = materiau;

  const { categorie, sous_categorie } = inferCategorie(designation, ligne.chapitre_ou_zone);

  return {
    categorie,
    sous_categorie,
    mots_cles: extractMotsCles(designation),
    specs,
  };
}

// ---------------------------------------------------------------------------
// 4. CatalogueIndex — preprocess the catalogue ONCE, reuse across every
//    marche_ligne in the import job. This is the main scale lever: with a
//    500+ item catalogue and a few hundred lines to process, doing unit
//    normalization / spec flattening per row instead of per catalogue load
//    means redoing the same string work tens of thousands of times for no
//    reason. The unit bucketing also turns the "hard filter" into an O(1)
//    map lookup instead of an O(n) Array.filter per row.
//
//    If your catalogue grows well past a few thousand items, the natural
//    next step is a second bucket dimension on normalized `categorie` —
//    same pattern as the unit map below — so the fuzzy-scoring pool per
//    row shrinks further before you ever compute a Levenshtein ratio.
// ---------------------------------------------------------------------------
interface IndexedCatalogueItem {
  item: CatalogueItem;
  normalizedUnit: string | null;
  catTokens: Set<string>; // categorie + sous_categorie, tokenized once
  catalogueTokens: Set<string>; // designation + flattened specs, tokenized once
  allTokens: Set<string>; // union of the above, for cheap pre-filtering
}

export class CatalogueIndex {
  private readonly all: IndexedCatalogueItem[] = [];
  private readonly byUnit = new Map<string, IndexedCatalogueItem[]>();
  /** token -> items that mention it, used for the cheap pre-filter stage
   *  below so the expensive Levenshtein-based scoring never has to run
   *  against the whole catalogue once it grows past a few hundred items. */
  private readonly invertedIndex = new Map<string, IndexedCatalogueItem[]>();

  constructor(catalogue: CatalogueItem[]) {
    for (const item of catalogue) {
      const normalizedUnit = normalizeUnit(item.unite);
      const catTokens = new Set(tokenize(`${item.categorie ?? ""} ${item.sous_categorie ?? ""}`));
      const catalogueTokens = new Set(tokenize(`${item.designation} ${flattenSpecs(item.specs)}`));
      const indexed: IndexedCatalogueItem = {
        item,
        normalizedUnit,
        catTokens,
        catalogueTokens,
        allTokens: new Set([...catTokens, ...catalogueTokens]),
      };
      this.all.push(indexed);
      if (normalizedUnit) {
        const bucket = this.byUnit.get(normalizedUnit);
        if (bucket) bucket.push(indexed);
        else this.byUnit.set(normalizedUnit, [indexed]);
      }
      for (const token of indexed.allTokens) {
        const bucket = this.invertedIndex.get(token);
        if (bucket) bucket.push(indexed);
        else this.invertedIndex.set(token, [indexed]);
      }
    }
  }

  get size(): number {
    return this.all.length;
  }

  /** Candidate pool for a given (already-normalized) unit. Falls back to
   *  the full catalogue if the filter would leave nothing — matches the
   *  Python version's "bad unit data shouldn't silently produce zero
   *  candidates" behavior. */
  poolForUnit(unit: string | null): IndexedCatalogueItem[] {
    if (!unit) return this.all;
    const filtered = this.byUnit.get(unit);
    return filtered && filtered.length > 0 ? filtered : this.all;
  }

  /** Cheap shortlist via inverted-index token overlap counting (hashmap
   *  lookups only, no Levenshtein) — used to cut an arbitrarily large pool
   *  down to `keep` items before the expensive fuzzy scoring runs. This is
   *  what keeps rankCandidates roughly constant-cost per line as the
   *  catalogue grows from 500 to 5,000+ items, instead of scaling linearly
   *  with catalogue size. */
  shortlistByTokenOverlap(queryTokens: Set<string>, pool: IndexedCatalogueItem[], keep: number): IndexedCatalogueItem[] {
    const poolSet = new Set(pool);
    const overlapCounts = new Map<IndexedCatalogueItem, number>();
    for (const token of queryTokens) {
      const hits = this.invertedIndex.get(token);
      if (!hits) continue;
      for (const item of hits) {
        if (!poolSet.has(item)) continue;
        overlapCounts.set(item, (overlapCounts.get(item) ?? 0) + 1);
      }
    }
    const ranked = [...overlapCounts.entries()].sort((a, b) => b[1] - a[1]);
    const shortlisted = ranked.slice(0, keep).map(([item]) => item);

    // Tokens can fail to overlap at all (e.g. heavy synonym drift) — rather
    // than return an empty shortlist and silently drop good candidates,
    // pad with the front of the pool so scoring still has something to work
    // with. Cheap insurance against the pre-filter being too aggressive.
    if (shortlisted.length < Math.min(keep, pool.length)) {
      const already = new Set(shortlisted);
      for (const item of pool) {
        if (shortlisted.length >= keep) break;
        if (!already.has(item)) shortlisted.push(item);
      }
    }
    return shortlisted;
  }
}

// ---------------------------------------------------------------------------
// 5. Candidate scoring & ranking
// ---------------------------------------------------------------------------

/** A handful of local-extractor keys don't literally match the catalogue's
 *  own key names even though they mean the same spec — e.g.
 *  extractLigneSpecsLocal emits `materiau` (per its own spec) while
 *  materiel_catalogue.specs uses `materiel` (see seed data: {"materiel":
 *  "laiton", ...}). Checked in order; first alias present on the
 *  candidate wins. */
const SPEC_KEY_ALIASES: Record<string, string[]> = {
  materiau: ["materiau", "materiel"],
};

function specKeyAliases(key: string): string[] {
  return SPEC_KEY_ALIASES[key] ?? [key];
}

/** Human-readable French labels for the local extractor's spec keys, used
 *  only to render localAutoSelect's generated justification text below. */
const SPEC_LABELS: Record<string, string> = {
  diametre: "diamètre",
  debit: "débit",
  pression: "pression",
  puissance: "puissance",
  dimensions: "dimensions",
  materiau: "matériau",
};

function normalizeSpecValue(v: unknown): string {
  return stripAccents(String(v).toLowerCase()).replace(/\s+/g, "");
}

interface NumericSpecComparer {
  normalize: (raw: unknown) => number | null;
  tolerance: number;
}

/** Spec keys that are fundamentally numeric measurements, compared as
 *  numbers-with-tolerance instead of raw-string equality (see
 *  normalizeDiameter/normalizeDebit/normalizePuissance above) — DN
 *  nominal sizes vs. actual mm measurements, or two independently
 *  formatted "100m3/h" strings, aren't always bit-identical for the same
 *  real-world fitting, so a small tolerance avoids treating that
 *  formatting noise as a genuine spec conflict. Tolerances are in each
 *  normalizer's output unit (mm, m3/h, W). */
const NUMERIC_SPEC_COMPARERS: Record<string, NumericSpecComparer> = {
  diametre: { normalize: (v) => normalizeDiameter(String(v)), tolerance: 1 },
  debit: { normalize: (v) => normalizeDebit(String(v)), tolerance: 1 },
  puissance: { normalize: (v) => normalizePuissance(String(v)), tolerance: 50 },
};

type SpecComparison = "match" | "conflict" | "neutral";

/** Single source of truth for "do these two spec values, under this key,
 *  agree" — used by computeSpecMatchScore (ranking), explainSpecMatch
 *  (debug trace), and matchedSpecEntries (justification text) so all
 *  three always reach the same verdict. Numeric spec keys are parsed
 *  through their normalizer and compared as numbers within a small
 *  tolerance; everything else (matériau, dimensions, ...) falls back to
 *  exact normalized-string equality. "neutral" means a numeric value on
 *  either side couldn't be parsed at all (e.g. an inch-denoted diamètre)
 *  — that's not evidence of a match OR a conflict, so it must never
 *  contribute to the score or the all-conflict tier; it's treated the
 *  same as the key being absent. */
function compareSpecValues(key: string, ligneValueRaw: unknown, candidateValueRaw: unknown): SpecComparison {
  const numeric = NUMERIC_SPEC_COMPARERS[key];
  if (numeric) {
    const ligneNum = numeric.normalize(ligneValueRaw);
    const candidateNum = numeric.normalize(candidateValueRaw);
    if (ligneNum === null || candidateNum === null) return "neutral";
    return Math.abs(ligneNum - candidateNum) <= numeric.tolerance ? "match" : "conflict";
  }
  return normalizeSpecValue(ligneValueRaw) === normalizeSpecValue(candidateValueRaw) ? "match" : "conflict";
}

/**
 * Compares the ligne's locally-extracted specs against a candidate's real
 * specs JSONB via compareSpecValues (numeric-with-tolerance for
 * diamètre/débit/puissance, exact normalized-string equality otherwise):
 * +2 for every key (allowing the aliases above) present on both sides
 * that agrees, -1 for a key present on both sides whose values genuinely
 * disagree (a real penalty — being actively wrong on a spec the ligne
 * cares about is worse than being silent on it, so this must never net
 * positive), 0 for a key present on only one side or whose numeric value
 * couldn't be parsed on either side (missing/unparseable data isn't
 * evidence of a mismatch), plus a +0.5 bonus per mots_cle that literally
 * appears in the candidate's designation/specs tokens. Also returns
 * matchedCount/comparedCount over the structured specs alone (mots_cles
 * excluded, and only over keys that were actually comparable) so callers
 * can tell "genuinely matched on at least one spec" apart from
 * "conflicted on every spec that could be checked" — see
 * ScoredCandidate.hasGenuineSpecMatch / allSpecsConflict. Score is 0
 * (with comparedCount 0) when the ligne has no specs to compare
 * (rankCandidates falls back to pure text ranking in that case rather
 * than trusting an all-zero specMatchScore).
 */
interface SpecMatchResult {
  score: number;
  matchedCount: number;
  comparedCount: number;
}

function computeSpecMatchScore(ligneSpecs: ExtractedLigneSpecs, indexed: IndexedCatalogueItem): SpecMatchResult {
  let score = 0;
  let matchedCount = 0;
  let comparedCount = 0;
  const candidateSpecs = indexed.item.specs;
  if (candidateSpecs) {
    for (const [ligneKey, ligneValueRaw] of Object.entries(ligneSpecs.specs)) {
      const matchedKey = specKeyAliases(ligneKey).find((ak) =>
        Object.prototype.hasOwnProperty.call(candidateSpecs, ak)
      );
      if (!matchedKey) continue; // key present on only one side -> neutral, not a comparison

      const outcome = compareSpecValues(ligneKey, ligneValueRaw, candidateSpecs[matchedKey]);
      if (outcome === "neutral") continue; // unparseable numeric value on either side -- can't compare, don't penalize

      comparedCount++;
      if (outcome === "match") {
        score += 2;
        matchedCount++;
      } else {
        score -= 1;
      }
    }
  }

  for (const kw of ligneSpecs.mots_cles) {
    if (indexed.catalogueTokens.has(kw)) score += 0.5;
  }

  return { score, matchedCount, comparedCount };
}

export interface SpecMatchBreakdown {
  score: number;
  matched: { key: string; value: string }[];
  disagreeing: { key: string; ligneValue: string; candidateValue: string }[];
  matchedMotsCles: string[];
}

/** Same comparison as computeSpecMatchScore, but returns WHICH keys matched
 *  / disagreed / which mots_cles hit, instead of just a number — for
 *  debug/trace output only, not used by the ranking hot path. */
export function explainSpecMatch(
  ligneSpecs: ExtractedLigneSpecs,
  candidate: CatalogueItem
): SpecMatchBreakdown {
  const matched: SpecMatchBreakdown["matched"] = [];
  const disagreeing: SpecMatchBreakdown["disagreeing"] = [];
  let score = 0;

  const candidateSpecs = candidate.specs;
  if (candidateSpecs) {
    for (const [ligneKey, ligneValueRaw] of Object.entries(ligneSpecs.specs)) {
      const matchedKey = specKeyAliases(ligneKey).find((ak) =>
        Object.prototype.hasOwnProperty.call(candidateSpecs, ak)
      );
      if (!matchedKey) continue;

      const outcome = compareSpecValues(ligneKey, ligneValueRaw, candidateSpecs[matchedKey]);
      if (outcome === "neutral") continue; // unparseable numeric value on either side -- can't compare

      if (outcome === "match") {
        matched.push({ key: ligneKey, value: String(ligneValueRaw) });
        score += 2;
      } else {
        disagreeing.push({
          key: ligneKey,
          ligneValue: String(ligneValueRaw),
          candidateValue: String(candidateSpecs[matchedKey]),
        });
        score -= 1;
      }
    }
  }

  const candidateTokens = new Set(tokenize(`${candidate.designation} ${flattenSpecs(candidate.specs)}`));
  const matchedMotsCles = ligneSpecs.mots_cles.filter((kw) => candidateTokens.has(kw));
  score += matchedMotsCles.length * 0.5;

  return { score, matched, disagreeing, matchedMotsCles };
}

function scoreCandidate(
  zoneTokens: Set<string>,
  designationTokens: Set<string>,
  ligneSpecs: ExtractedLigneSpecs,
  indexed: IndexedCatalogueItem
): ScoredCandidate {
  const categoryScore = tokenSetRatioFromSets(zoneTokens, indexed.catTokens);
  const textScore = tokenSetRatioFromSets(designationTokens, indexed.catalogueTokens);
  const specMatch = computeSpecMatchScore(ligneSpecs, indexed);
  return {
    catalogueItem: indexed.item,
    categoryScore,
    textScore,
    specMatchScore: specMatch.score,
    hasGenuineSpecMatch: specMatch.matchedCount > 0,
    allSpecsConflict: specMatch.comparedCount > 0 && specMatch.matchedCount === 0,
    price: Number(indexed.item.prix_fourniture ?? 0),
  };
}

/** Category is a hard pre-filter (see rankCandidates below), not a scoring
 *  dimension — categoryScore is kept on ScoredCandidate for
 *  debugging/display only, it doesn't drive sort order.
 *
 *  specMatchScore (real spec-vs-spec agreement) is the primary signal: once
 *  the pool has already passed the unit + category filters, matching
 *  diamètre/pression/matériau/etc. is a much stronger "is this actually the
 *  same product" signal than generic description text overlap. textScore is
 *  now only a tiebreaker between candidates tied on specMatchScore, and
 *  price remains the final tiebreaker.
 *
 *  Ahead of all of that: a hard tier split on spec conflict. A candidate
 *  that actively disagrees on every comparable spec (allSpecsConflict)
 *  must never outrank one with at least one genuine match
 *  (hasGenuineSpecMatch) — not on specMatchScore (already guaranteed by
 *  the +2/-1 formula in most cases), and not on the price/text tiebreakers
 *  either, which the raw score alone can't guarantee once ties are
 *  possible. A candidate that's merely silent on every spec (no
 *  comparable data either way) sits in the middle: no evidence it's
 *  wrong, so it isn't floored, but no evidence it's right either, so it
 *  doesn't outrank a genuine match. */
function specTier(c: ScoredCandidate): number {
  if (c.hasGenuineSpecMatch) return 0;
  if (c.allSpecsConflict) return 2;
  return 1;
}

function compareCandidatesBySpecMatch(a: ScoredCandidate, b: ScoredCandidate): number {
  const tierDiff = specTier(a) - specTier(b);
  if (tierDiff !== 0) return tierDiff;
  const specDiff = Math.round(b.specMatchScore * 100) - Math.round(a.specMatchScore * 100);
  if (specDiff !== 0) return specDiff;
  const textDiff = Math.round(b.textScore * 100) - Math.round(a.textScore * 100);
  if (textDiff !== 0) return textDiff;
  return a.price - b.price;
}

/** Original text-first ordering, kept as the fallback for any ligne whose
 *  local extraction found no usable specs at all — with nothing to
 *  compare, specMatchScore would be 0 for every candidate and provide no
 *  signal, so text similarity is the best available ranking signal. */
function compareCandidatesByText(a: ScoredCandidate, b: ScoredCandidate): number {
  const textDiff = Math.round(b.textScore * 100) - Math.round(a.textScore * 100);
  if (textDiff !== 0) return textDiff;
  return a.price - b.price;
}

export interface RankOptions {
  /** Pool sizes above this trigger the cheap token-overlap pre-filter
   *  before the expensive Levenshtein-based scoring runs. Default 150 —
   *  below that, just scoring everything directly is already fast enough
   *  that a pre-filter stage would only add overhead. */
  prefilterThreshold?: number;
  /** How many items the pre-filter keeps for full scoring. Default 60.
   *  Keep this comfortably above topN so a merely-average text match
   *  doesn't get eliminated before the real scoring gets to see it. */
  prefilterKeep?: number;
  /** Debug hook: called once per rankCandidates() call with the pool size
   *  at each hard-filter stage (unit -> category -> prefilter), so callers
   *  can inspect the "hidden process" without changing ranking behavior. */
  onDebug?: (counts: {
    catalogueSize: number;
    afterUnitFilter: number;
    afterCategoryFilter: number;
    afterPrefilter: number;
    /** Set when the ligne's extracted categorie was confidently known and
     *  the hard category filter genuinely found zero catalogue items in
     *  that categorie (as opposed to the filter simply not applying). */
    categoryFilterExcludedAll: boolean;
  }) => void;
}

export function rankCandidates(
  ligne: MarcheLigne,
  index: CatalogueIndex,
  topN = 4,
  rankOptions: RankOptions = {}
): ScoredCandidate[] {
    const {
    prefilterThreshold = 150,
    prefilterKeep = 60,
    onDebug,
  } = rankOptions;
  const targetUnit = normalizeUnit(ligne.unite);

  // HARD FILTER 1: unit. poolForUnit already falls back to the full
  // catalogue if the unit filter would leave nothing (bad/missing unit
  // data shouldn't silently produce zero candidates).
  const unitPool = index.poolForUnit(targetUnit);

  // Tokenize the ligne's text fields ONCE and reuse across the whole
  // candidate pool, instead of re-tokenizing per catalogue item — this is
  // the difference between O(pool) and O(pool) *string parsing* work per
  // ligne vs. per (ligne, candidate) pair.
  const zoneTokens = new Set(tokenize(`${ligne.chapitre_ou_zone ?? ""} ${ligne.designation}`));
  const designationTokens = new Set(tokenize(ligne.designation));

  // Local (no-network) spec extraction, once per ligne — reused across
  // every candidate below. Whether it found anything decides which
  // comparator drives the final sort (see hasUsableSpecs below).
  const ligneSpecs = extractLigneSpecsLocal(ligne);
  const hasUsableSpecs = Object.keys(ligneSpecs.specs).length > 0;

  // HARD FILTER 2: category. Applied on top of the unit pool, before any
  // Levenshtein-based scoring runs — narrows the pool the same way the
  // unit filter does, rather than just down-ranking a category mismatch.
  //
  // categorie is a small, known set (see CATEGORY_RULES), so this is a
  // plain case-insensitive EXACT match between the ligne's extracted
  // categorie (ligneSpecs.categorie, from inferCategorie) and the
  // candidate's real materiel_catalogue `categorie` column — no fuzzy
  // token overlap here, and nothing else stands in for it.
  //
  // ligneSpecs.categorie is only trusted to filter on when inferCategorie
  // actually resolved one (a missing/unmatchable designation+zone leaves
  // it null rather than guessing — see inferCategorie) — an unknown
  // categorie can't be filtered on, so the unit-only pool is used as-is.
  //
  // Critically: when the categorie IS known and filtering it genuinely
  // leaves zero matches (e.g. no ventilation products yet in the
  // catalogue), that is NOT treated as "the filter must be wrong, ignore
  // it" — fullPool becomes empty and stays empty. Falling back to the
  // unfiltered pool here is exactly what let wrong-category candidates
  // (e.g. Tuyauterie items) survive a Ventilation filter and get
  // presented as if they were valid matches. An honest empty result is
  // the correct outcome; the caller (processBatch/processMarcheLigne/
  // localAutoSelect/selectWithHaiku) turns a genuinely empty pool into an
  // explicit "no catalogue candidates in this categorie" decision instead
  // of guessing.
  let fullPool = unitPool;
  let categoryFilterExcludedAll = false;
  if (ligneSpecs.categorie) {
    const targetCategorie = ligneSpecs.categorie.trim().toLowerCase();
    const categoryMatched = unitPool.filter(
      (indexed) => (indexed.item.categorie ?? "").trim().toLowerCase() === targetCategorie
    );
    fullPool = categoryMatched;
    categoryFilterExcludedAll = categoryMatched.length === 0;
  }

  // The expensive step is the Levenshtein-based token_set_ratio scoring
  // (O(pool) DP computations). Past prefilterThreshold candidates, shrink
  // the pool first with a cheap hashmap-only overlap count so scoring cost
  // stops growing with catalogue size — this is what makes rankCandidates
  // safe to run per-line against a catalogue of thousands of items instead
  // of only hundreds.
  const pool =
    fullPool.length > prefilterThreshold
      ? index.shortlistByTokenOverlap(
          new Set([...zoneTokens, ...designationTokens]),
          fullPool,
          prefilterKeep
        )
      : fullPool;

    onDebug?.({
    catalogueSize: index.size,
    afterUnitFilter: unitPool.length,
    afterCategoryFilter: fullPool.length,
    afterPrefilter: pool.length,
    categoryFilterExcludedAll,
  });

  const scored = pool.map((indexed) => scoreCandidate(zoneTokens, designationTokens, ligneSpecs, indexed));
  scored.sort(hasUsableSpecs ? compareCandidatesBySpecMatch : compareCandidatesByText);
  return scored.slice(0, topN);
}

// ---------------------------------------------------------------------------
// 6. Haiku picks the final one, analyzing this row in isolation
// ---------------------------------------------------------------------------
export const HAIKU_SYSTEM_PROMPT = `Tu es un estimateur en bâtiment (lot fluides : plomberie, \
climatisation, ventilation, gaz). On te donne UNE ligne de bordereau de prix \
(le besoin) et 2 à 4 produits candidats du catalogue fournisseur. Choisis le \
produit qui correspond le mieux au besoin technique, en privilégiant le \
meilleur rapport qualité/prix parmi les candidats fournis (pas nécessairement \
le moins cher si les specs ne correspondent pas aussi bien).

Réponds STRICTEMENT en JSON, rien d'autre, avec ce schéma :
{"chosen_catalogue_id": "<id du candidat choisi>", "confidence": "high"|"medium"|"low", "justification": "<1-2 phrases en français>"}

Si aucun candidat ne correspond raisonnablement au besoin, renvoie \
{"chosen_catalogue_id": null, "confidence": "none", "justification": "<pourquoi aucun ne convient>"}.`;

const DecisionSchema = z.object({
  chosen_catalogue_id: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low", "none"]),
  justification: z.string(),
});

export function buildHaikuUserMessage(ligne: MarcheLigne, candidates: ScoredCandidate[]): string {
  const payload = {
    besoin: {
      designation: ligne.designation,
      unite: ligne.unite ?? null,
      quantite: ligne.quantite ?? null,
      chapitre_ou_zone: ligne.chapitre_ou_zone ?? null,
    },
    candidats: candidates.map((c) => ({
      id: c.catalogueItem.id,
      designation: c.catalogueItem.designation,
      categorie: c.catalogueItem.categorie ?? null,
      sous_categorie: c.catalogueItem.sous_categorie ?? null,
      specs: c.catalogueItem.specs ?? null,
      prix_fourniture: c.catalogueItem.prix_fourniture ?? null,
      unite: c.catalogueItem.unite ?? null,
    })),
  };
  return JSON.stringify(payload);
}

/** Injected function(system, userMessage) -> raw model text. Kept swappable
 *  so this is unit-testable without hitting the network, and so you can
 *  point it at a different transport (Edge Function, queue worker, etc). */
export type ApiCallFn = (system: string, userMessage: string) => Promise<string>;

function parseDecision(raw: string): Decision {
  let cleaned = raw.trim();
  try {
    return DecisionSchema.parse(JSON.parse(cleaned));
  } catch {
    // defensive: strip accidental code fences
    cleaned = cleaned.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    return DecisionSchema.parse(JSON.parse(cleaned));
  }
}

const FALLBACK_DECISION = (justification: string): Decision => ({
  chosen_catalogue_id: null,
  confidence: "none",
  justification,
});

/** Decision for a ligne that reached selection with zero candidates.
 *  Distinguishes "we know the categorie and the catalogue genuinely has
 *  nothing in it" (actionable — catalogue is missing coverage) from the
 *  generic "no candidates at all" case (unknown categorie, empty
 *  catalogue, etc.), so the justification tells the user which one it is
 *  instead of a single opaque message either way. */
function noCandidatesDecision(ligne: MarcheLigne): Decision {
  const { categorie } = extractLigneSpecsLocal(ligne);
  return FALLBACK_DECISION(
    categorie
      ? `Aucun article de catégorie ${categorie} trouvé dans le catalogue.`
      : "Aucun candidat disponible."
  );
}

// ---------------------------------------------------------------------------
// 6b. Local (no-network) auto-selection — used by processBatch /
//     processMarcheLigne INSTEAD of calling selectWithHaiku whenever no
//     apiCallFn was injected and no Haiku API key is configured (e.g.
//     while Haiku credits/access are unavailable). selectWithHaiku itself
//     is untouched: once apiCallFn is available again (injected, or
//     ANTHROPIC_API_KEY set), the exact same call sites go back to real
//     Haiku selection with no further code changes.
// ---------------------------------------------------------------------------

/** Whether a real Haiku call can be attempted via the default client (i.e.
 *  defaultAnthropicCall wouldn't immediately fail for lack of
 *  credentials). Guarded for non-Node environments where `process` isn't
 *  defined. */
function isHaikuConfigured(): boolean {
  try {
    return typeof process !== "undefined" && !!process.env?.ANTHROPIC_API_KEY;
  } catch {
    return false;
  }
}

/** Local specs (from extractLigneSpecsLocal) whose value equals — after
 *  alias resolution + normalization, same rules as computeSpecMatchScore —
 *  the top candidate's real spec value. Used only to render a human
 *  justification string, not to score/rank (rankCandidates already did
 *  that; this just explains its #1 pick in French). */
function matchedSpecEntries(
  ligneSpecs: ExtractedLigneSpecs,
  top: ScoredCandidate
): { key: string; value: string }[] {
  const candidateSpecs = top.catalogueItem.specs;
  const matches: { key: string; value: string }[] = [];
  if (!candidateSpecs) return matches;

  for (const [ligneKey, ligneValueRaw] of Object.entries(ligneSpecs.specs)) {
    const matchedKey = specKeyAliases(ligneKey).find((ak) =>
      Object.prototype.hasOwnProperty.call(candidateSpecs, ak)
    );
    if (!matchedKey) continue;
    if (compareSpecValues(ligneKey, ligneValueRaw, candidateSpecs[matchedKey]) === "match") {
      matches.push({ key: ligneKey, value: ligneValueRaw });
    }
  }
  return matches;
}

/** Builds a French justification string describing WHY the #1 ranked
 *  candidate was picked, e.g. "Correspondance specs: diamètre 20mm,
 *  matériau laiton (2/2 critères), catégorie Tuyauterie — sélection
 *  automatique (Haiku indisponible)." Falls back to describing the text
 *  similarity signal when the ligne had no locally-extractable specs at
 *  all (same case rankCandidates itself falls back to text ordering for). */
function buildLocalJustification(ligneSpecs: ExtractedLigneSpecs, top: ScoredCandidate): string {
  const totalSpecs = Object.keys(ligneSpecs.specs).length;
  const categoriePart = top.catalogueItem.categorie ? `, catégorie ${top.catalogueItem.categorie}` : "";

  if (totalSpecs > 0) {
    const matches = matchedSpecEntries(ligneSpecs, top);
    const specPart =
      matches.length > 0
        ? matches.map((m) => `${SPEC_LABELS[m.key] ?? m.key} ${m.value}`).join(", ")
        : "aucune correspondance exacte";
    return (
      `Correspondance specs: ${specPart} (${matches.length}/${totalSpecs} critères)` +
      `${categoriePart} — sélection automatique (Haiku indisponible).`
    );
  }

  return (
    `Meilleure correspondance texte parmi les candidats, score ${Math.round(top.textScore)}%` +
    `${categoriePart} — sélection automatique (Haiku indisponible).`
  );
}

/**
 * No-network stand-in for selectWithHaiku: auto-selects the #1 ranked
 * candidate (rankCandidates already did the real ranking work — spec-match
 * first, text similarity as tiebreaker/fallback) and generates a
 * justification from the actual matched spec keys instead of leaving it
 * empty. Same Decision shape as selectWithHaiku's output, so callers and
 * downstream code (recap UI, PDF/XLSX renderers, activity logs) don't need
 * to know which path produced a given row's decision.
 *
 * Confidence is capped at "medium": this is a heuristic pick, not a
 * verified one, even when every extracted spec matched exactly.
 */
export function localAutoSelect(ligne: MarcheLigne, candidates: ScoredCandidate[]): Decision {
  if (candidates.length === 0) {
    return noCandidatesDecision(ligne);
  }

  const top = candidates[0];
  const ligneSpecs = extractLigneSpecsLocal(ligne);
  const totalSpecs = Object.keys(ligneSpecs.specs).length;
  const matchedCount = matchedSpecEntries(ligneSpecs, top).length;

  const confidence: Decision["confidence"] =
    totalSpecs > 0 && matchedCount === totalSpecs ? "medium" : "low";

  return {
    chosen_catalogue_id: top.catalogueItem.id,
    confidence,
    justification: buildLocalJustification(ligneSpecs, top),
  };
}

export interface SelectOptions {
  /** Retries on transient failure (network error, malformed JSON). Default 2. */
  retries?: number;
  /** Base delay in ms for exponential backoff between retries. Default 300. */
  retryBaseDelayMs?: number;
}

/**
 * Never throws: a single malformed LLM response degrades to a
 * low-confidence null decision instead of aborting a whole batch. This
 * matters much more at 500-row scale than it did at 20 rows — one flaky
 * response shouldn't cost you the other 499.
 */
export async function selectWithHaiku(
  ligne: MarcheLigne,
  candidates: ScoredCandidate[],
  apiCallFn: ApiCallFn = defaultAnthropicCall,
  options: SelectOptions = {}
): Promise<Decision> {
  if (candidates.length === 0) {
    return noCandidatesDecision(ligne);
  }

  const { retries = 2, retryBaseDelayMs = 300 } = options;
  const userMessage = buildHaikuUserMessage(ligne, candidates);

  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const raw = await apiCallFn(HAIKU_SYSTEM_PROMPT, userMessage);
      return parseDecision(raw);
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        await sleep(retryBaseDelayMs * 2 ** attempt);
      }
    }
  }

  const reason = lastError instanceof Error ? lastError.message : String(lastError);
  return FALLBACK_DECISION(`Échec de sélection automatique après ${retries + 1} tentative(s): ${reason}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let _defaultClient: Anthropic | null = null;
function getDefaultClient(): Anthropic {
  if (!_defaultClient) _defaultClient = new Anthropic();
  return _defaultClient;
}

async function defaultAnthropicCall(system: string, userMessage: string): Promise<string> {
  const client = getDefaultClient();
  const resp = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    system,
    messages: [{ role: "user", content: userMessage }],
  });
  return resp.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

// ---------------------------------------------------------------------------
// 7. Concurrency-limited batch processing (real-time messages.create calls)
// ---------------------------------------------------------------------------
async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function runOne(): Promise<void> {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runOne()));
  return results;
}

/** Pluggable so decisions can survive a re-run of a failed/partial import:
 *  key by whatever uniquely identifies the row (e.g. marche_ligne.id). */
export interface DecisionCache {
  get(key: string): Promise<ProcessResult | undefined> | ProcessResult | undefined;
  set(key: string, value: ProcessResult): Promise<void> | void;
}

export interface ProcessBatchOptions {
  topN?: number;
  /** Max concurrent Haiku calls in flight. Default 8 — high enough to be
   *  fast, low enough to stay well under typical per-minute rate limits
   *  for a few hundred rows. Tune to your tier. */
  concurrency?: number;
  select?: SelectOptions;
  apiCallFn?: ApiCallFn;
  cache?: DecisionCache;
  /** Called after each row resolves — wire this to a progress bar / a
   *  Supabase row update for a live "312 / 500 processed" indicator. */
  onProgress?: (done: number, total: number, result: ProcessResult) => void;
  /** Stable key for cache lookups; defaults to marche_ligne.numero. */
  keyFor?: (ligne: MarcheLigne) => string;
}

/**
 * Processes many marche_lignes against one catalogue: builds the
 * CatalogueIndex once, then fans the Haiku calls out across a bounded
 * worker pool. Good default entry point for interactive imports (dozens to
 * a few hundred rows) where the caller wants results streaming back as
 * they land. For very large one-shot imports, prefer
 * processBatchViaMessageBatches below.
 */
export async function processBatch(
  marcheLignes: MarcheLigne[],
  catalogue: CatalogueItem[],
  options: ProcessBatchOptions = {}
): Promise<ProcessResult[]> {
  const {
    topN = 4,
    concurrency = 8,
    select,
    apiCallFn,
    cache,
    onProgress,
    keyFor = (l) => l.numero ?? l.designation,
  } = options;

  // No apiCallFn injected and no Haiku credentials configured (e.g. while
  // Haiku access/credits are unavailable) -> skip the network call
  // entirely and auto-select locally. Passing a real apiCallFn (or
  // configuring ANTHROPIC_API_KEY again) reverts to real Haiku selection
  // with no other changes needed here.
  const useLocalFallback = !apiCallFn && !isHaikuConfigured();

  const index = new CatalogueIndex(catalogue);
  let done = 0;

  return runWithConcurrency(marcheLignes, concurrency, async (ligne) => {
    const key = keyFor(ligne);
    const cached = cache && (await cache.get(key));
    if (cached) {
      done++;
      onProgress?.(done, marcheLignes.length, cached);
      return cached;
    }

    const candidates = rankCandidates(ligne, index, topN);
    const decision = useLocalFallback
      ? localAutoSelect(ligne, candidates)
      : await selectWithHaiku(ligne, candidates, apiCallFn ?? defaultAnthropicCall, select);
    const result: ProcessResult = {
      marche_ligne_numero: ligne.numero ?? null,
      candidates_considered: candidates.map((c) => c.catalogueItem.id),
      decision,
    };

    if (cache) await cache.set(key, result);
    done++;
    onProgress?.(done, marcheLignes.length, result);
    return result;
  });
}

export interface MessageBatchOptions {
  topN?: number;
  cache?: DecisionCache;
  keyFor?: (ligne: MarcheLigne) => string;
  /** How often to poll for batch completion, in ms. Default 15s. */
  pollIntervalMs?: number;
  /** Give up polling after this long, in ms. Default 2h. */
  pollTimeoutMs?: number;
  client?: Anthropic;
}

export async function processBatchViaMessageBatches(
  marcheLignes: MarcheLigne[],
  catalogue: CatalogueItem[],
  options: MessageBatchOptions = {}
): Promise<ProcessResult[]> {
  const {
    topN = 4,
    cache,
    keyFor = (l) => l.numero ?? l.designation,
    pollIntervalMs = 15_000,
    pollTimeoutMs = 2 * 60 * 60 * 1000,
    client = getDefaultClient(),
  } = options;

  const index = new CatalogueIndex(catalogue);

  // Rows already decided (from a previous partial run) don't need to be
  // resubmitted — this is what makes re-running a failed import cheap.
  const pending: { ligne: MarcheLigne; key: string; candidates: ScoredCandidate[] }[] = [];
  const results = new Map<string, ProcessResult>();

  for (const ligne of marcheLignes) {
    const key = keyFor(ligne);
    const cached = cache && (await cache.get(key));
    if (cached) {
      results.set(key, cached);
      continue;
    }
    const candidates = rankCandidates(ligne, index, topN);
    if (candidates.length === 0) {
      const result: ProcessResult = {
        marche_ligne_numero: ligne.numero ?? null,
        candidates_considered: [],
        decision: noCandidatesDecision(ligne),
      };
      results.set(key, result);
      if (cache) await cache.set(key, result);
      continue;
    }
    pending.push({ ligne, key, candidates });
  }

  if (pending.length > 0) {
    const batch = await client.messages.batches.create({
      requests: pending.map(({ ligne, key, candidates }) => ({
        custom_id: key,
        params: {
          model: "claude-haiku-4-5-20251001",
          max_tokens: 300,
          system: HAIKU_SYSTEM_PROMPT,
          messages: [{ role: "user" as const, content: buildHaikuUserMessage(ligne, candidates) }],
        },
      })),
    });

    await waitForBatchCompletion(client, batch.id, pollIntervalMs, pollTimeoutMs);

    const candidatesByKey = new Map(pending.map((p) => [p.key, p]));
    const batchResults = await client.messages.batches.results(batch.id);
    for await (const entry of batchResults) {
      const pendingRow = candidatesByKey.get(entry.custom_id);
      if (!pendingRow) continue;

      let decision: Decision;
      if (entry.result.type === "succeeded") {
        const text = entry.result.message.content
          .filter((b): b is Anthropic.TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("");
        try {
          decision = parseDecision(text);
        } catch (err) {
          decision = FALLBACK_DECISION(
            `Réponse JSON invalide: ${err instanceof Error ? err.message : String(err)}`
          );
        }
      } else {
        decision = FALLBACK_DECISION(`Requête batch non aboutie (${entry.result.type}).`);
      }

      const result: ProcessResult = {
        marche_ligne_numero: pendingRow.ligne.numero ?? null,
        candidates_considered: pendingRow.candidates.map((c) => c.catalogueItem.id),
        decision,
      };
      results.set(entry.custom_id, result);
      if (cache) await cache.set(entry.custom_id, result);
    }
  }

  // Preserve input order in the returned array.
  return marcheLignes.map((ligne) => {
    const key = keyFor(ligne);
    return (
      results.get(key) ?? {
        marche_ligne_numero: ligne.numero ?? null,
        candidates_considered: [],
        decision: FALLBACK_DECISION("Résultat manquant pour cette ligne après traitement du batch."),
      }
    );
  });
}

async function waitForBatchCompletion(
  client: Anthropic,
  batchId: string,
  pollIntervalMs: number,
  pollTimeoutMs: number
): Promise<void> {
  const deadline = Date.now() + pollTimeoutMs;
  while (true) {
    const batch = await client.messages.batches.retrieve(batchId);
    if (batch.processing_status === "ended") return;
    if (Date.now() > deadline) {
      throw new Error(`Message batch ${batchId} did not complete within ${pollTimeoutMs}ms`);
    }
    await sleep(pollIntervalMs);
  }
}

// ---------------------------------------------------------------------------
// 9. Single-row convenience wrapper (same shape as the Python
//    process_marche_ligne, kept for callers that just want one row done).
// ---------------------------------------------------------------------------
export async function processMarcheLigne(
  ligne: MarcheLigne,
  catalogueOrIndex: CatalogueItem[] | CatalogueIndex,
  apiCallFn?: ApiCallFn,
  topN = 4
): Promise<ProcessResult> {
  const index = catalogueOrIndex instanceof CatalogueIndex ? catalogueOrIndex : new CatalogueIndex(catalogueOrIndex);
  const candidates = rankCandidates(ligne, index, topN);
  // Same local-fallback rule as processBatch: no injected apiCallFn and no
  // Haiku credentials configured -> auto-select locally instead of a
  // network call. Pass a real apiCallFn later to go back to Haiku.
  const decision =
    !apiCallFn && !isHaikuConfigured()
      ? localAutoSelect(ligne, candidates)
      : await selectWithHaiku(ligne, candidates, apiCallFn ?? defaultAnthropicCall);
  return {
    marche_ligne_numero: ligne.numero ?? null,
    candidates_considered: candidates.map((c) => c.catalogueItem.id),
    decision,
  };
}