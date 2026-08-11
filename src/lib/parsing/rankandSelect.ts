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
  price: number;
}

export interface Decision {
  chosen_catalogue_id: string | null;
  confidence: "high" | "medium" | "low";
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
function scoreCandidate(
  zoneTokens: Set<string>,
  designationTokens: Set<string>,
  indexed: IndexedCatalogueItem
): ScoredCandidate {
  const categoryScore = tokenSetRatioFromSets(zoneTokens, indexed.catTokens);
  const textScore = tokenSetRatioFromSets(designationTokens, indexed.catalogueTokens);
  return {
    catalogueItem: indexed.item,
    categoryScore,
    textScore,
    price: Number(indexed.item.prix_fourniture ?? 0),
  };
}

/** Category is now a hard pre-filter (see rankCandidates below), not a
 *  scoring dimension — once we're only looking at candidates that already
 *  passed the unit + category filters, ranking is purely
 *  description/specs similarity, then cheapest price. categoryScore is
 *  kept on ScoredCandidate for debugging/display, it just no longer
 *  drives sort order. */
function compareCandidates(a: ScoredCandidate, b: ScoredCandidate): number {
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
  /** Minimum token_set_ratio (0-100) between the ligne's chapitre_ou_zone
   *  and a catalogue item's categorie/sous_categorie for that item to
   *  survive the hard category filter. Default 45 — items below this are
   *  excluded entirely, same as a unit mismatch. */
  categoryFilterThreshold?: number;
  /** Minimum number of real tokens chapitre_ou_zone must contain before
   *  we trust it enough to hard-filter on it at all. A missing/very short
   *  or generic zone label ("Divers", "Lot 3") can't be confidently
   *  mapped to a catalogue categorie, so filtering on it would just
   *  produce false negatives. Default 2. */
  minCategoryTokensForFilter?: number;
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
    categoryFilterThreshold = 45,
    minCategoryTokensForFilter = 2,
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
  //
  // zoneOnlyTokens (chapitre_ou_zone alone) is the category *filter*
  // signal — kept separate from designation so a strong designation match
  // can't paper over a genuinely different zone/category.
  const zoneOnlyTokens = new Set(tokenize(ligne.chapitre_ou_zone ?? ""));
  const zoneTokens = new Set(tokenize(`${ligne.chapitre_ou_zone ?? ""} ${ligne.designation}`));
  const designationTokens = new Set(tokenize(ligne.designation));

  // HARD FILTER 2: category. Applied on top of the unit pool, before any
  // Levenshtein-based scoring runs — narrows the pool the same way the
  // unit filter does, rather than just down-ranking a category mismatch.
  //
  // Only trust chapitre_ou_zone enough to filter on it when it carries
  // enough real signal (minCategoryTokensForFilter tokens), and only keep
  // the narrowed pool if it's actually non-empty. Either way an ambiguous
  // or unmatchable category falls back to the unit-only pool plus
  // description scoring below, instead of silently returning zero
  // candidates.
  let fullPool = unitPool;
  if (zoneOnlyTokens.size >= minCategoryTokensForFilter) {
    const categoryMatched = unitPool.filter(
      (indexed) => tokenSetRatioFromSets(zoneOnlyTokens, indexed.catTokens) >= categoryFilterThreshold
    );
    if (categoryMatched.length > 0) {
      fullPool = categoryMatched;
    }
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

  const scored = pool.map((indexed) => scoreCandidate(zoneTokens, designationTokens, indexed));
  scored.sort(compareCandidates);
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
{"chosen_catalogue_id": null, "confidence": "low", "justification": "<pourquoi aucun ne convient>"}.`;

const DecisionSchema = z.object({
  chosen_catalogue_id: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
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
  confidence: "low",
  justification,
});

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
    return FALLBACK_DECISION("Aucun candidat disponible.");
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
    apiCallFn = defaultAnthropicCall,
    cache,
    onProgress,
    keyFor = (l) => l.numero ?? l.designation,
  } = options;

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
    const decision = await selectWithHaiku(ligne, candidates, apiCallFn, select);
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
        decision: FALLBACK_DECISION("Aucun candidat disponible."),
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
  apiCallFn: ApiCallFn = defaultAnthropicCall,
  topN = 4
): Promise<ProcessResult> {
  const index = catalogueOrIndex instanceof CatalogueIndex ? catalogueOrIndex : new CatalogueIndex(catalogueOrIndex);
  const candidates = rankCandidates(ligne, index, topN);
  const decision = await selectWithHaiku(ligne, candidates, apiCallFn);
  return {
    marche_ligne_numero: ligne.numero ?? null,
    candidates_considered: candidates.map((c) => c.catalogueItem.id),
    decision,
  };
}