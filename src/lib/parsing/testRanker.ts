/**
 * Standalone ranking smoke test — NOT part of the app's routes.
 *
 * Run with:
 *   npx tsx src/lib/parsing/testRanker.ts
 *
 * Exercises rankCandidates() + selectWithHaiku() from rankandSelect.ts
 * directly — no UI, no server function (matchAllLignesServerFn /
 * rankLigneCandidatesServerFn), no reimplemented scoring logic — against
 * the REAL materiel_catalogue table. Meant to catch exactly the kind of
 * silent/opaque failure that's made the ranker hard to debug through the
 * remplir page so far (bad env vars, RLS gaps, empty catalogue, a
 * malformed Haiku response, etc.) fast, before testing through the UI.
 *
 * NOTE ON THE SUPABASE CLIENT
 * ----------------------------------------------------------------------
 * src/integrations/supabase/client.ts resolves its URL/key via
 * `import.meta.env['VITE_...']` first, which is a Vite build-time
 * feature. Under plain Node/tsx (no Vite involved), `import.meta.env` is
 * simply undefined, so indexing into it throws before the
 * `process.env['SUPABASE_...']` SSR fallback is ever reached — that
 * generated client can't be imported as-is outside a Vite build. This
 * script builds an equivalent client directly from @supabase/supabase-js
 * using the exact same env var names client.ts falls back to for SSR
 * (SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY), so it still points at the
 * real, same-config Supabase project — it just skips the Vite-only
 * branch that doesn't apply here.
 *
 * Requires SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY (or their VITE_
 * prefixed equivalents) in the environment — tsx auto-loads a .env file
 * from the project root, so a normal local .env is enough. Selecting a
 * real Haiku decision also needs ANTHROPIC_API_KEY; without it,
 * selectWithHaiku() degrades to a low-confidence fallback decision
 * rather than throwing (that's real production behaviour, not a bug in
 * this script — see rankandSelect.ts).
 */

import { createClient } from "@supabase/supabase-js";
import {
  CatalogueIndex,
  rankCandidates,
  selectWithHaiku,
  type CatalogueItem,
  type MarcheLigne,
  type ScoredCandidate,
} from "./rankandSelect";

// ---------------------------------------------------------------------------
// Supabase client — see file header for why this isn't a raw import of
// src/integrations/supabase/client.ts.
// ---------------------------------------------------------------------------
const SUPABASE_URL = process.env["SUPABASE_URL"] ?? process.env["VITE_SUPABASE_URL"];
const SUPABASE_KEY =
  process.env["SUPABASE_PUBLISHABLE_KEY"] ?? process.env["VITE_SUPABASE_PUBLISHABLE_KEY"];

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error(
    "[testRanker] Missing SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY (or VITE_ equivalents) " +
      "in the environment. tsx auto-loads a .env file from the project root — make sure " +
      "one exists with these set, the same way the app itself does.",
  );
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---------------------------------------------------------------------------
// Hardcoded sample bordereau lines — deliberately varied across the
// categories a lot fluides catalogue actually covers, representative of
// real marche_lignes shapes (numero is optional in MarcheLigne but kept
// here for readable output).
// ---------------------------------------------------------------------------
const SAMPLE_LIGNES: MarcheLigne[] = [
  {
    numero: "1.1",
    designation: "Tuyau PVC pression PN10 diamètre 110mm",
    unite: "ml",
    quantite: 45,
    chapitre_ou_zone: "Tuyauterie",
  },
  {
    numero: "1.5",
    designation: "Coude PVC 90° diamètre 110mm",
    unite: "u",
    quantite: 20,
    chapitre_ou_zone: "Tuyauterie",
  },
  {
    numero: "2.3",
    designation: "Lavabo en porcelaine avec robinetterie mitigeur",
    unite: "u",
    quantite: 8,
    chapitre_ou_zone: "Sanitaire",
  },
  {
    numero: "2.7",
    designation: "Chauffe-eau électrique 200L",
    unite: "u",
    quantite: 2,
    chapitre_ou_zone: "Sanitaire",
  },
  {
    numero: "3.1",
    designation: "Ventilateur d'extraction centrifuge 500 m3/h",
    unite: "u",
    quantite: 4,
    chapitre_ou_zone: "Ventilation",
  },
];

const TOP_N = 5;

// ---------------------------------------------------------------------------

async function loadCatalogue(): Promise<CatalogueItem[]> {
  console.log("Chargement du catalogue depuis materiel_catalogue…");
  const { data, error } = await supabase
    .from("materiel_catalogue")
    .select("id, designation, categorie, sous_categorie, specs, prix_fourniture, unite")
    .eq("statut", "verifie");

  if (error) throw error;
  if (!data || data.length === 0) {
    throw new Error(
      "materiel_catalogue n'a renvoyé aucun article 'verifie' — vérifiez la connexion " +
        "Supabase et les données avant de tester le ranking.",
    );
  }

  console.log(`${data.length} article(s) chargé(s) depuis le catalogue.\n`);
  return data as unknown as CatalogueItem[];
}

/**
 * "Hard-filtered candidate count" = the size of the pool rankCandidates
 * actually scored and sorted, i.e. what's left after its two hard
 * filters (unit, then category) and — for very large catalogues — its
 * cheap token-overlap pre-filter. Deliberately NOT reimplemented here:
 * asking rankCandidates for effectively unlimited topN just returns its
 * whole real filtered/sorted pool, so this count can never drift from
 * what the actual ranking logic did.
 */
function fullRankedPool(ligne: MarcheLigne, index: CatalogueIndex): ScoredCandidate[] {
  return rankCandidates(ligne, index, index.size);
}

function formatCandidate(c: ScoredCandidate, rank: number): string {
  return (
    `    ${rank}. [${c.catalogueItem.id}] ${c.catalogueItem.designation}` +
    ` — textScore=${c.textScore.toFixed(1)} categoryScore=${c.categoryScore.toFixed(1)}` +
    ` prix=${c.price}`
  );
}

async function runSample(ligne: MarcheLigne, index: CatalogueIndex): Promise<void> {
  console.log("=".repeat(80));
  console.log(`Ligne [${ligne.numero ?? "—"}] ${ligne.designation}`);
  console.log(`  unite=${ligne.unite ?? "—"}  chapitre_ou_zone=${ligne.chapitre_ou_zone ?? "—"}`);

  const fullPool = fullRankedPool(ligne, index);
  console.log(`  Candidats après filtres durs (unité + catégorie): ${fullPool.length}`);

  const top = fullPool.slice(0, TOP_N);
  if (top.length === 0) {
    console.log("  Aucun candidat — rien à classer, rien à envoyer à Haiku.");
    return;
  }

  console.log(`  Top ${top.length} candidat(s) classé(s):`);
  top.forEach((c, i) => console.log(formatCandidate(c, i + 1)));

  // Real selection call — same function matchAllLignesServerFn /
  // rankLigneCandidatesServerFn ultimately rely on, with its default
  // (real) Anthropic-backed apiCallFn. Never throws on its own: a
  // missing ANTHROPIC_API_KEY or a malformed response degrades to a
  // low-confidence null decision instead, exactly like production.
  const decision = await selectWithHaiku(ligne, top);

  if (decision.chosen_catalogue_id) {
    const chosen = top.find((c) => c.catalogueItem.id === decision.chosen_catalogue_id);
    console.log(
      `  Préremplissage: [${decision.chosen_catalogue_id}] ${chosen?.catalogueItem.designation ?? "(hors du top affiché)"}` +
        ` (confiance=${decision.confidence})`,
    );
  } else {
    console.log(`  Préremplissage: aucun (confiance=${decision.confidence}) — ${decision.justification}`);
  }
}

async function main(): Promise<void> {
  const catalogue = await loadCatalogue();
  const index = new CatalogueIndex(catalogue);

  for (const ligne of SAMPLE_LIGNES) {
    await runSample(ligne, index);
  }

  console.log("=".repeat(80));
  console.log(`Terminé sans erreur — ${SAMPLE_LIGNES.length} ligne(s) testée(s).`);
}

main()
  .then(() => process.exit(0))
  .catch((err: unknown) => {
    // Print the FULL error — message, stack, and any extra fields a
    // Supabase/PostgREST error carries (details/hint/code) — rather than
    // letting it get swallowed or truncated into a generic toast, which
    // is exactly the class of silent failure this script exists to
    // avoid reproducing.
    console.error("\n[testRanker] Échec :");
    if (err instanceof Error) {
      console.error(err.stack ?? err.message);
    }
    console.error(err);
    process.exit(1);
  });