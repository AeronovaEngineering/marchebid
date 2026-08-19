// src/lib/parsing/debugTrace.ts
//
// Drop this next to rankAndSelect.ts. Requires the 3 small patches described
// in rankAndSelect.patch.md (adds `onDebug` to RankOptions + exports
// `explainSpecMatch`). Nothing else in rankAndSelect.ts needs to change.
//
// Usage — wire this in wherever you currently call rankCandidates() for a
// real bordereau line (e.g. inside your API route / processMarcheLigne call
// site), guarded by an env flag so it's opt-in in the running app:
//
//   import { traceMarcheLigne } from "@/lib/parsing/debugTrace";
//
//   if (process.env.DEBUG_RANKER === "1") {
//     traceMarcheLigne(ligne, index, topN);
//   }
//
// Every call appends a block to console AND to logs/ranker-debug-<ts>.txt
// (one file per process run — first call creates it, rest append).

import fs from "fs";
import path from "path";
import {
  MarcheLigne,
  CatalogueIndex,
  ScoredCandidate,
  Decision,
  extractLigneSpecsLocal,
  rankCandidates,
  localAutoSelect,
  explainSpecMatch,
  RankOptions,
} from "./rankAndSelect";

let logFilePath: string | null = null;

function ensureLogFile(): string {
  if (logFilePath) return logFilePath;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(process.cwd(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  logFilePath = path.join(dir, `ranker-debug-${ts}.txt`);
  return logFilePath;
}

function write(text: string) {
  // eslint-disable-next-line no-console
  console.log(text);
  fs.appendFileSync(ensureLogFile(), text + "\n");
}

export interface TracedResult {
  candidates: ScoredCandidate[];
  decision: Decision;
}

/**
 * Runs the exact same local pipeline rankCandidates()/localAutoSelect() use
 * (no Haiku), but captures and prints/logs every intermediate step:
 * extracted specs, hard-filter pass/exclude counts, top-N candidates with
 * full score breakdown (which spec keys matched/disagreed, which mots_cles
 * hit, fuzzy text score, price), and the final auto-picked candidate with
 * its justification.
 */
export function traceMarcheLigne(
  ligne: MarcheLigne,
  index: CatalogueIndex,
  topN = 4,
  rankOptions: RankOptions = {}
): TracedResult {
  const counts = {
    catalogueSize: index.size,
    afterUnitFilter: 0,
    afterCategoryFilter: 0,
    afterPrefilter: 0,
  };

  const candidates = rankCandidates(ligne, index, topN, {
    ...rankOptions,
    onDebug: (c) => Object.assign(counts, c),
  });

  const ligneSpecs = extractLigneSpecsLocal(ligne);
  const decision = localAutoSelect(ligne, candidates);

  const lines: string[] = [];
  lines.push("=".repeat(80));
  lines.push(`DESIGNATION: ${ligne.designation.slice(0, 100)}`);
  lines.push(
    `  zone=${ligne.chapitre_ou_zone ?? "-"}  unite=${ligne.unite ?? "-"}  qte=${ligne.quantite ?? "-"}  numero=${ligne.numero ?? "-"}`
  );

  lines.push(`--- extraction locale (extractLigneSpecsLocal) ---`);
  lines.push(`  categorie=${ligneSpecs.categorie ?? "-"}  sous_categorie=${ligneSpecs.sous_categorie ?? "-"}`);
  lines.push(`  mots_cles=[${ligneSpecs.mots_cles.join(", ")}]`);
  lines.push(`  specs=${JSON.stringify(ligneSpecs.specs)}`);

  lines.push(`--- filtres durs (unite -> categorie -> prefiltre) ---`);
  lines.push(
    `  catalogue=${counts.catalogueSize}  ->  apres unite=${counts.afterUnitFilter}` +
      ` (exclus=${counts.catalogueSize - counts.afterUnitFilter})` +
      `  ->  apres categorie=${counts.afterCategoryFilter}` +
      ` (exclus=${counts.afterUnitFilter - counts.afterCategoryFilter})` +
      `  ->  apres prefiltre=${counts.afterPrefilter}` +
      ` (exclus=${counts.afterCategoryFilter - counts.afterPrefilter})`
  );

  lines.push(`--- top ${candidates.length} candidats (JSON envoye a la comparaison + scores) ---`);
  candidates.forEach((c, i) => {
    const breakdown = explainSpecMatch(ligneSpecs, c.catalogueItem);
    lines.push(`  ${i + 1}. [${c.catalogueItem.id}] ${c.catalogueItem.designation.slice(0, 70)}`);
    lines.push(`     specs_catalogue=${JSON.stringify(c.catalogueItem.specs ?? {})}`);
    lines.push(
      `     specMatchScore=${c.specMatchScore.toFixed(1)}` +
        `  match=[${breakdown.matched.map((m) => `${m.key}:${m.value}`).join(", ")}]` +
        `  disagree=[${breakdown.disagreeing.map((d) => `${d.key}(${d.ligneValue}!=${d.candidateValue})`).join(", ")}]` +
        `  mots_cles_touches=[${breakdown.matchedMotsCles.join(", ")}]`
    );
    lines.push(`     textScore=${c.textScore.toFixed(1)}  prix=${c.price}`);
  });

  lines.push(`--- decision finale (localAutoSelect) ---`);
  lines.push(`  chosen_catalogue_id=${decision.chosen_catalogue_id ?? "AUCUN"}  confidence=${decision.confidence}`);
  lines.push(`  justification: ${decision.justification}`);
  lines.push("");

  write(lines.join("\n"));

  return { candidates, decision };
}

export function getDebugLogPath(): string | null {
  return logFilePath;
}