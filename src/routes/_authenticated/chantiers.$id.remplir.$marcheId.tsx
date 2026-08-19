import { useMemo, useState } from "react";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { toast } from "sonner";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Info,
  Loader2,
  Search,
  Sparkles,
  Wrench,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import type { Tables, TablesInsert } from "@/integrations/supabase/types";
import {
  processBatch,
  rankCandidates,
  CatalogueIndex,
  type CatalogueItem as RankCatalogueItem,
  type MarcheLigne as RankMarcheLigne,
} from "@/lib/parsing/rankandSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/ui/pageHeader";
import { EmptyState } from "@/components/ui/Emptystate";
import { StatutBadge } from "@/components/StatutBadge";
import { formatDinars, formatNumber } from "@/lib/format";
import { logActivity } from "@/lib/Activitylog";
import { cn } from "@/lib/utils";

/**
 * NOTE ON STATUT NAMING
 * ----------------------------------------------------------------------
 * The spec for this screen talks about lignes being "confirmed". The
 * actual DB enum (ligne_statut) is: 'non_rempli' | 'suggere' | 'verifie'.
 * There is no 'confirme' value. Throughout this file "confirmed" means
 * statut === 'verifie', and the "Confirmer" button sets that value.
 *
 * NOTE ON RLS
 * ----------------------------------------------------------------------
 * bid_lignes needed an INSERT/UPDATE policy for the mutations below
 * (choose / confirm / pose price / AI prefill) to work at all — see
 * supabase/migrations/202608110100000_add_marches_write_policies.sql
 * ("bid_lignes_write" / "bid_lignes_update"), which must be applied for
 * any of this to actually persist.
 *
 * NOTE ON "EN STOCK"
 * ----------------------------------------------------------------------
 * materiel_catalogue has no dedicated stock column. The "in stock only"
 * filter below is a best-effort filter on specs->>'en_stock' and should
 * be revisited once stock tracking is modeled properly.
 */

type Fourniseeur = Pick<Tables<"fournisseurs">, "id" | "nom">;
type Materiel = Tables<"materiel_catalogue"> & { fournisseurs: Fourniseeur | null };
type BidLigne = Tables<"bid_lignes"> & { materiel: Materiel | null };
type MarcheLigne = Tables<"marche_lignes"> & { bidLigne: BidLigne | null };

interface RankedCandidate {
  materiel: Materiel;
  score: number;
}

interface MatchAllResult {
  candidatesByLigne: Record<string, RankedCandidate[]>;
}

// If a server function call ever hits something that isn't a real
// server-fn route (wrong path, dev server not registering the route, a
// proxy/CDN intercepting the request, etc.) what comes back is often a raw
// HTML 404/500 page instead of JSON. Whatever unwrapped that response into
// `error.message` may have dumped the whole page in there — never show
// that directly in a toast. Detect the shape defensively and fall back to
// a generic message instead.
function friendlyErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const trimmed = raw.trim();
  const looksLikeHtml = /^<(!doctype|html)/i.test(trimmed) || /<\/html>\s*$/i.test(trimmed);
  if (!trimmed || looksLikeHtml) {
    return "Erreur serveur. Réessayez, ou contactez le support si le problème persiste.";
  }
  return raw;
}

const EMPTY_BID_LIGNE: Omit<BidLigne, "id" | "marche_ligne_id"> = {
  materiel_catalogue_id: null,
  prix_fourniture: 0,
  prix_pose: 0,
  statut: "non_rempli",
  notes: null,
  updated_at: new Date().toISOString(),
  materiel: null,
};

// ---------------------------------------------------------------------------
// Server function: rank + prefill every unconfirmed ligne of a marché.
//
// Backed by src/lib/parsing/rankandSelect.ts's real production pipeline
// (category → text/specs similarity → price ordering, unit hard-filter,
// then a real Anthropic Haiku call to pick the actual winner among the
// top-ranked candidates) via its designed batch entry point, processBatch.
// No local scoring logic lives here anymore — this function only adapts
// Supabase rows in and Supabase upserts out.
// ---------------------------------------------------------------------------
const matchAllLignesServerFn = createServerFn({ method: "POST" })
  .validator((marcheId: string) => marcheId)
  .handler(async ({ data: marcheId }): Promise<MatchAllResult> => {
    // NOTE ON supabaseAdmin
    // ------------------------------------------------------------------
    // The plain `supabase` client (src/integrations/supabase/client.ts)
    // has no server-side session storage — `storage` resolves to
    // `undefined` whenever `window` is undefined — so any createServerFn
    // handler using it always runs as an anonymous request. marche_lignes,
    // bid_lignes and materiel_catalogue all have a `auth.uid() IS NOT
    // NULL` SELECT policy, so those reads were silently returning zero
    // rows here (not an error — RLS just filters everything out), which
    // is what made ranking look like it always found no candidates.
    // supabaseAdmin (service role) bypasses RLS; safe to use for these
    // reads since this handler only reads shared marché/catalogue data,
    // nothing user-scoped.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: lignes, error: lignesError } = await supabaseAdmin
      .from("marche_lignes")
      .select("id, numero, designation, unite, quantite, chapitre_ou_zone")
      .eq("marche_id", marcheId);
    if (lignesError) throw lignesError;
    if (!lignes || lignes.length === 0) return { candidatesByLigne: {} };

    const { data: bidLignes, error: bidError } = await supabaseAdmin
      .from("bid_lignes")
      .select("marche_ligne_id, statut")
      .in(
        "marche_ligne_id",
        lignes.map((l) => l.id),
      );
    if (bidError) throw bidError;

    const confirmedIds = new Set(
      (bidLignes ?? []).filter((b) => b.statut === "verifie").map((b) => b.marche_ligne_id),
    );
    const unconfirmed = lignes.filter((l) => !confirmedIds.has(l.id));
    if (unconfirmed.length === 0) return { candidatesByLigne: {} };

    // The full real materiel_catalogue, not a subset — exactly what
    // rankandSelect's CatalogueIndex/rankCandidates pipeline expects to be
    // built from.
    const { data: catalogue, error: catalogueError } = await supabaseAdmin
      .from("materiel_catalogue")
      .select("*, fournisseurs:fournisseur_id(id, nom)")
      .eq("statut", "verifie");
    if (catalogueError) throw catalogueError;

    const catalogueRows = (catalogue ?? []) as unknown as Materiel[];
    const catalogueById = new Map(catalogueRows.map((m) => [m.id, m]));

    // Adapt the Supabase rows into rankandSelect's own input shapes (extra
    // properties like `fournisseurs` are harmless — only the fields the
    // ranker actually reads need to line up) and hand off to its designed
    // batch entry point. No ranking/selection logic is reimplemented here.
    const catalogueForRanking: RankCatalogueItem[] = catalogueRows.map((m) => ({
      id: m.id,
      designation: m.designation,
      categorie: m.categorie,
      sous_categorie: m.sous_categorie,
      specs: (m.specs as Record<string, unknown> | null) ?? null,
      prix_fourniture: m.prix_fourniture,
      unite: m.unite,
    }));
    const lignesForRanking: RankMarcheLigne[] = unconfirmed.map((l) => ({
      numero: l.numero,
      designation: l.designation,
      unite: l.unite,
      quantite: l.quantite,
      chapitre_ou_zone: l.chapitre_ou_zone,
    }));

    // processBatch builds the CatalogueIndex once, ranks + Haiku-selects
    // every unconfirmed ligne with a bounded worker pool, and preserves
    // input order in its result array — that ordering guarantee is what
    // lets us zip `results[i]` back to `unconfirmed[i]` below.
    const results = await processBatch(lignesForRanking, catalogueForRanking);

    const candidatesByLigne: Record<string, RankedCandidate[]> = {};
    const upserts: TablesInsert<"bid_lignes">[] = [];

    unconfirmed.forEach((ligne, i) => {
      const result = results[i];
      if (!result) return;

      // Best-first order from rankCandidates is preserved in
      // candidates_considered — reconstruct Materiel objects (with their
      // joined fournisseur) for the Alternatives UI by id lookup.
      candidatesByLigne[ligne.id] = result.candidates_considered
        .map((catalogueId) => catalogueById.get(catalogueId))
        .filter((materiel): materiel is Materiel => Boolean(materiel))
        .map((materiel) => ({ materiel, score: 0 }));

      // Only prefill when Haiku actually reached a decision — a null
      // chosen_catalogue_id ("aucun candidat ne correspond") should leave
      // the ligne unmatched rather than force the #1 ranked-but-rejected
      // candidate onto it.
      const chosenId = result.decision.chosen_catalogue_id;
      const chosen = chosenId ? catalogueById.get(chosenId) : null;
      if (chosen) {
        upserts.push({
          marche_ligne_id: ligne.id,
          materiel_catalogue_id: chosen.id,
          prix_fourniture: chosen.prix_fourniture,
          statut: "suggere",
          updated_at: new Date().toISOString(),
        });
      }
    });

    if (upserts.length > 0) {
      const { error: upsertError } = await supabaseAdmin
        .from("bid_lignes")
        .upsert(upserts, { onConflict: "marche_ligne_id" });
      if (upsertError) throw upsertError;
    }

    return { candidatesByLigne };
  });

// ---------------------------------------------------------------------------
// Server function: rank candidates for ONE ligne, scoped to whichever row
// is selected in the left pane.
//
// This is deliberately separate from matchAllLignesServerFn above: that one
// runs the full pipeline (rank + a real Haiku call per row) for every
// unconfirmed ligne in the marché and is meant to be triggered explicitly
// via "Lancer l'IA". This one only runs rankCandidates (unit + catégorie
// hard filters, then description/specs similarity, then price — see
// rankandSelect.ts) for a single ligne, with no LLM call, so it's cheap
// enough to re-run every time the user clicks a different row on the left
// without waiting on Haiku or burning API calls just to populate the
// right pane.
// ---------------------------------------------------------------------------
const rankLigneCandidatesServerFn = createServerFn({ method: "POST" })
  .validator((marcheLigneId: string) => marcheLigneId)
  .handler(async ({ data: marcheLigneId }): Promise<{ candidates: RankedCandidate[] }> => {
    // See NOTE ON supabaseAdmin in matchAllLignesServerFn above — same
    // reason: the plain `supabase` client has no session server-side, so
    // marche_lignes/materiel_catalogue's `auth.uid() IS NOT NULL` SELECT
    // policies were silently zeroing out both reads below.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: ligne, error: ligneError } = await supabaseAdmin
      .from("marche_lignes")
      .select("designation, unite, quantite, chapitre_ou_zone")
      .eq("id", marcheLigneId)
      .maybeSingle();
    if (ligneError) throw ligneError;
    if (!ligne) return { candidates: [] };

    const { data: catalogue, error: catalogueError } = await supabaseAdmin
      .from("materiel_catalogue")
      .select("*, fournisseurs:fournisseur_id(id, nom)")
      .eq("statut", "verifie");
    if (catalogueError) throw catalogueError;

    const catalogueRows = (catalogue ?? []) as unknown as Materiel[];
    const catalogueById = new Map(catalogueRows.map((m) => [m.id, m]));

    const catalogueForRanking: RankCatalogueItem[] = catalogueRows.map((m) => ({
      id: m.id,
      designation: m.designation,
      categorie: m.categorie,
      sous_categorie: m.sous_categorie,
      specs: (m.specs as Record<string, unknown> | null) ?? null,
      prix_fourniture: m.prix_fourniture,
      unite: m.unite,
    }));

    const index = new CatalogueIndex(catalogueForRanking);
    const rankedLigne = {
      designation: ligne.designation,
      unite: ligne.unite,
      quantite: ligne.quantite,
      chapitre_ou_zone: ligne.chapitre_ou_zone,
    };
    const scored = rankCandidates(rankedLigne, index, 4);
    

    const candidates: RankedCandidate[] = scored
      .map((c) => {
        const materiel = catalogueById.get(c.catalogueItem.id);
        return materiel ? { materiel, score: c.textScore } : null;
      })
      .filter((c): c is RankedCandidate => c !== null);

    return { candidates };
  });

// ---------------------------------------------------------------------------

export const Route = createFileRoute(
  "/_authenticated/chantiers/$id/remplir/$marcheId",
)({
  component: RemplirMarcheScreen,
});

function useMarcheLignes(marcheId: string) {
  return useQuery({
    queryKey: ["marche-lignes", marcheId],
    queryFn: async (): Promise<MarcheLigne[]> => {
      const { data: lignes, error: lignesError } = await supabase
        .from("marche_lignes")
        .select("*")
        .eq("marche_id", marcheId)
        .order("ordre", { ascending: true });
      if (lignesError) throw lignesError;
      if (!lignes || lignes.length === 0) return [];

      const { data: bidLignes, error: bidError } = await supabase
        .from("bid_lignes")
        .select("*, materiel:materiel_catalogue_id(*, fournisseurs:fournisseur_id(id, nom))")
        .in(
          "marche_ligne_id",
          lignes.map((l) => l.id),
        );
      if (bidError) throw bidError;

      const bidByLigneId = new Map((bidLignes ?? []).map((b) => [b.marche_ligne_id, b as unknown as BidLigne]));

      return lignes.map((ligne) => ({
        ...ligne,
        bidLigne: bidByLigneId.get(ligne.id) ?? null,
      }));
    },
  });
}

function RemplirMarcheScreen() {
  const { id: chantierId, marcheId } = Route.useParams();
  const queryClient = useQueryClient();
  const { data: lignes, isLoading } = useMarcheLignes(marcheId);

  const [selectedLigneId, setSelectedLigneId] = useState<string | null>(null);
  const [candidatesByLigne, setCandidatesByLigne] = useState<Record<string, RankedCandidate[]>>({});

  const orderedLignes = lignes ?? [];
  const total = orderedLignes.length;
  const confirmed = orderedLignes.filter((l) => (l.bidLigne?.statut ?? "non_rempli") === "verifie").length;
  const allConfirmed = total > 0 && confirmed === total;

  const selectedLigne = orderedLignes.find((l) => l.id === selectedLigneId) ?? null;

  // Re-rank candidates scoped to whichever ligne is selected. This is what
  // makes clicking a different row on the left actually change what shows
  // on the right, instead of always falling through to the generic
  // catalogue browse: candidatesByLigne only gets populated in bulk by the
  // explicit "Lancer l'IA" batch run, so any ligne that hasn't been through
  // that yet (e.g. the very first click, before anyone has hit "Lancer
  // l'IA") needs its own fetch. We skip the fetch when candidatesByLigne
  // already has this ligne (from a prior batch run) to avoid redoing work
  // Haiku already vetted.
  const alreadyHasCandidates = selectedLigneId !== null && selectedLigneId in candidatesByLigne;
  const ligneCandidatesQuery = useQuery({
    queryKey: ["ligne-candidates", selectedLigneId],
    queryFn: () => rankLigneCandidatesServerFn({ data: selectedLigneId as string }),
    enabled: selectedLigneId !== null && !alreadyHasCandidates,
  });

  const selectedLigneCandidates: RankedCandidate[] = selectedLigneId
    ? (candidatesByLigne[selectedLigneId] ?? ligneCandidatesQuery.data?.candidates ?? [])
    : [];

  // Auto-select first unconfirmed ligne once data loads, if nothing selected yet.
  useMemo(() => {
    if (selectedLigneId === null && orderedLignes.length > 0) {
      const firstUnconfirmed = orderedLignes.find(
        (l) => (l.bidLigne?.statut ?? "non_rempli") !== "verifie",
      );
      setSelectedLigneId((firstUnconfirmed ?? orderedLignes[0])?.id ?? null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orderedLignes.length]);

  const groups = useMemo(() => {
    const out: { zone: string; lignes: MarcheLigne[] }[] = [];
    for (const ligne of orderedLignes) {
      const zone = ligne.chapitre_ou_zone?.trim() || "Sans zone";
      const current = out[out.length - 1];
      if (current && current.zone === zone) {
        current.lignes.push(ligne);
      } else {
        out.push({ zone, lignes: [ligne] });
      }
    }
    return out;
  }, [orderedLignes]);

  function advanceToNextUnconfirmed(justConfirmedId: string) {
    const idx = orderedLignes.findIndex((l) => l.id === justConfirmedId);
    for (let i = idx + 1; i < orderedLignes.length; i++) {
      const l = orderedLignes[i];
      if (!l) continue;
      if ((l.bidLigne?.statut ?? "non_rempli") !== "verifie") {
        setSelectedLigneId(l.id);
        return;
      }
    }
    // Nothing after it — look from the top (in case earlier ones remain).
    for (const l of orderedLignes) {
      if (l.id !== justConfirmedId && (l.bidLigne?.statut ?? "non_rempli") !== "verifie") {
        setSelectedLigneId(l.id);
        return;
      }
    }
    setSelectedLigneId(null);
  }

  const runAiMutation = useMutation({
    mutationFn: () => matchAllLignesServerFn({ data: marcheId }),
    onSuccess: (result) => {
      setCandidatesByLigne((prev) => ({ ...prev, ...result.candidatesByLigne }));
      queryClient.invalidateQueries({ queryKey: ["marche-lignes", marcheId] });
    },
    onError: (error: Error) => {
      toast.error("Erreur lors de la correspondance IA", { description: friendlyErrorMessage(error) });
    },
  });

  const chooseMutation = useMutation({
    mutationFn: async ({ marcheLigneId, materiel }: { marcheLigneId: string; materiel: Materiel }) => {
      const { error } = await supabase.from("bid_lignes").upsert(
        {
          marche_ligne_id: marcheLigneId,
          materiel_catalogue_id: materiel.id,
          prix_fourniture: materiel.prix_fourniture,
          statut: "suggere",
          updated_at: new Date().toISOString(),
        },
        { onConflict: "marche_ligne_id" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["marche-lignes", marcheId] });
    },
    onError: (error: Error) => {
      toast.error("Erreur lors du choix de l'article", { description: friendlyErrorMessage(error) });
    },
  });

  const confirmMutation = useMutation({
    mutationFn: async (marcheLigneId: string) => {
      const { error } = await supabase
        .from("bid_lignes")
        .update({ statut: "verifie", updated_at: new Date().toISOString() })
        .eq("marche_ligne_id", marcheLigneId);
      if (error) throw error;
      return marcheLigneId;
    },
    onSuccess: (marcheLigneId) => {
      const ligne = orderedLignes.find((l) => l.id === marcheLigneId);
      void logActivity({
        action: "validate",
        entity_type: "bid_ligne",
        entity_id: marcheLigneId,
        details: {
          designation: ligne?.designation ?? null,
          materiel_id: ligne?.bidLigne?.materiel_catalogue_id ?? null,
        },
      });
      queryClient.invalidateQueries({ queryKey: ["marche-lignes", marcheId] });
      advanceToNextUnconfirmed(marcheLigneId);
    },
    onError: (error: Error) => {
      toast.error("Erreur lors de la confirmation", { description: friendlyErrorMessage(error) });
    },
  });

  const updatePosePrixMutation = useMutation({
    mutationFn: async ({ marcheLigneId, prixPose }: { marcheLigneId: string; prixPose: number }) => {
      const { error } = await supabase.from("bid_lignes").upsert(
        {
          marche_ligne_id: marcheLigneId,
          prix_pose: prixPose,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "marche_ligne_id" },
      );
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["marche-lignes", marcheId] });
    },
    onError: (error: Error) => {
      toast.error("Erreur lors de l'enregistrement du prix de pose", { description: friendlyErrorMessage(error) });
    },
  });

  return (
    // Fixed-height shell so the two panes below can scroll independently
    // instead of the whole page. 4rem approximates the AppShell's top
    // header/nav height — adjust this offset if the panes don't exactly
    // fill the remaining viewport height in the real layout.
    <div className="flex h-[calc(100vh-4rem)] flex-col">
      <PageHeader
        title="Remplissage du marché"
        description="Associez chaque ligne du bordereau à un article du catalogue."
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 gap-6 overflow-hidden lg:grid-cols-[1.3fr_1fr]">
        <LeftPane
          isLoading={isLoading}
          groups={groups}
          confirmed={confirmed}
          total={total}
          selectedLigneId={selectedLigneId}
          onSelect={setSelectedLigneId}
          onChangePosePrix={(marcheLigneId, prixPose) =>
            updatePosePrixMutation.mutate({ marcheLigneId, prixPose })
          }
        />

        <RightPane
          chantierId={chantierId}
          marcheId={marcheId}
          allConfirmed={allConfirmed}
          hasLignes={total > 0}
          selectedLigne={selectedLigne}
          candidates={selectedLigneCandidates}
          isRankingCandidates={ligneCandidatesQuery.isLoading && !alreadyHasCandidates}
          onRunAi={() => runAiMutation.mutate()}
          isRunningAi={runAiMutation.isPending}
          onChoose={(materiel) =>
            selectedLigne && chooseMutation.mutate({ marcheLigneId: selectedLigne.id, materiel })
          }
          onConfirm={() => selectedLigne && confirmMutation.mutate(selectedLigne.id)}
          isConfirming={confirmMutation.isPending}
        />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// LEFT PANE
// ---------------------------------------------------------------------------

function LeftPane({
  isLoading,
  groups,
  confirmed,
  total,
  selectedLigneId,
  onSelect,
  onChangePosePrix,
}: {
  isLoading: boolean;
  groups: { zone: string; lignes: MarcheLigne[] }[];
  confirmed: number;
  total: number;
  selectedLigneId: string | null;
  onSelect: (id: string) => void;
  onChangePosePrix: (marcheLigneId: string, prixPose: number) => void;
}) {
  return (
    <Card className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <p className="text-sm font-medium">Lignes du bordereau</p>
        <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-semibold tabular-nums">
          {confirmed}/{total}
        </span>
      </div>

      {isLoading ? (
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : total === 0 ? (
        <div className="flex-1 overflow-y-auto">
          <EmptyState
            icon={Wrench}
            title="Aucune ligne"
            description="Ce marché ne contient aucune ligne à chiffrer."
          />
        </div>
      ) : (
        // This is the pane's own scroll container — it scrolls
        // independently of the page. The per-chapitre_ou_zone title rows
        // inside <GroupRows> are `sticky top-0` relative to *this* element,
        // which is what makes each chapter title stick to the top of the
        // pane while its rows scroll underneath, then get handed off to
        // the next chapter's title once its rows scroll past.
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-3 text-left">N°</th>
                <th className="px-4 py-3 text-left">Désignation</th>
                <th className="px-4 py-3 text-left">Unité</th>
                <th className="px-4 py-3 text-right">Qté</th>
                <th className="px-4 py-3 text-right">P.U.</th>
                <th className="px-4 py-3 text-right">Total</th>
                <th className="px-4 py-3 text-left">Statut</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => (
                <GroupRows
                  key={group.zone}
                  zone={group.zone}
                  lignes={group.lignes}
                  selectedLigneId={selectedLigneId}
                  onSelect={onSelect}
                  onChangePosePrix={onChangePosePrix}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function GroupRows({
  zone,
  lignes,
  selectedLigneId,
  onSelect,
  onChangePosePrix,
}: {
  zone: string;
  lignes: MarcheLigne[];
  selectedLigneId: string | null;
  onSelect: (id: string) => void;
  onChangePosePrix: (marcheLigneId: string, prixPose: number) => void;
}) {
  return (
    <>
      <tr className="sticky top-0 z-10 border-t border-border bg-muted">
        <td colSpan={7} className="px-4 py-2 text-xs font-semibold uppercase tracking-wide text-foreground">
          {zone}
        </td>
      </tr>
      {lignes.map((ligne) => (
        <LigneRows
          key={ligne.id}
          ligne={ligne}
          selected={ligne.id === selectedLigneId}
          onSelect={() => onSelect(ligne.id)}
          onChangePosePrix={(prixPose) => onChangePosePrix(ligne.id, prixPose)}
        />
      ))}
    </>
  );
}

function LigneRows({
  ligne,
  selected,
  onSelect,
  onChangePosePrix,
}: {
  ligne: MarcheLigne;
  selected: boolean;
  onSelect: () => void;
  onChangePosePrix: (prixPose: number) => void;
}) {
  const statut = ligne.bidLigne?.statut ?? "non_rempli";
  const prixFourniture = ligne.bidLigne?.prix_fourniture ?? 0;
  const prixPose = ligne.bidLigne?.prix_pose ?? 0;

  return (
    <>
      <tr
        onClick={onSelect}
        className={cn(
          "cursor-pointer border-t border-border transition-colors hover:bg-accent/40",
          selected && "bg-primary/5",
        )}
      >
        <td className="px-4 py-3 align-top text-muted-foreground">{ligne.numero || "—"}</td>
        <td className="px-4 py-3 align-top font-medium">{ligne.designation}</td>
        <td className="px-4 py-3 align-top text-muted-foreground">{ligne.unite || "—"}</td>
        <td className="px-4 py-3 text-right align-top tabular-nums">{formatNumber(ligne.quantite)}</td>
        <td className="px-4 py-3 text-right align-top tabular-nums">{formatDinars(prixFourniture)}</td>
        <td className="px-4 py-3 text-right align-top tabular-nums font-medium">
          {formatDinars(prixFourniture * (ligne.quantite ?? 0))}
        </td>
        <td className="px-4 py-3 align-top">
          <StatutBadge statut={statut} kind="ligne" />
        </td>
      </tr>

      {ligne.a_pose && (
        <tr
          onClick={onSelect}
          className={cn(
            "cursor-pointer border-t border-dashed border-border/70 bg-muted/10 text-muted-foreground transition-colors hover:bg-accent/30",
            selected && "bg-primary/5",
          )}
        >
          <td className="px-4 py-2 align-top" />
          <td className="px-4 py-2 pl-8 align-top text-xs italic">Pose :</td>
          <td className="px-4 py-2 align-top" />
          <td className="px-4 py-2 align-top" />
          <td className="px-4 py-2 text-right align-top" onClick={(e) => e.stopPropagation()}>
            <Input
              type="number"
              step="0.001"
              min={0}
              defaultValue={prixPose}
              onBlur={(e) => {
                const value = Number(e.target.value);
                if (!Number.isNaN(value) && value !== prixPose) onChangePosePrix(value);
              }}
              className="h-7 w-24 text-right text-xs tabular-nums"
            />
          </td>
          <td className="px-4 py-2 text-right align-top text-xs tabular-nums">
            {formatDinars(prixPose * (ligne.quantite ?? 0))}
          </td>
          <td className="px-4 py-2 align-top" />
        </tr>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// RIGHT PANE
// ---------------------------------------------------------------------------

function RightPane({
  chantierId,
  marcheId,
  allConfirmed,
  hasLignes,
  selectedLigne,
  candidates,
  isRankingCandidates,
  onRunAi,
  isRunningAi,
  onChoose,
  onConfirm,
  isConfirming,
}: {
  chantierId: string;
  marcheId: string;
  allConfirmed: boolean;
  hasLignes: boolean;
  selectedLigne: MarcheLigne | null;
  candidates: RankedCandidate[];
  isRankingCandidates: boolean;
  onRunAi: () => void;
  isRunningAi: boolean;
  onChoose: (materiel: Materiel) => void;
  onConfirm: () => void;
  isConfirming: boolean;
}) {
  if (hasLignes && allConfirmed) {
    return (
      <div className="h-full overflow-y-auto">
        <Card>
          <CardContent className="flex flex-col items-center justify-center gap-4 py-16 text-center">
            <CheckCircle2 className="size-10 text-success" />
            <div>
              <p className="font-medium">Toutes les lignes sont confirmées</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Vous pouvez passer à la génération du récapitulatif.
              </p>
            </div>
            <Button asChild>
              <Link to="/chantiers/$id/recap/$marcheId" params={{ id: chantierId, marcheId }}>
                Passer à la validation
                <ChevronRight className="size-4" />
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    // Its own scroll container: stays fully visible within the pane and
    // only scrolls internally if content genuinely exceeds the available
    // height, rather than scrolling the page.
    <div className="h-full overflow-y-auto">
      <div className="flex flex-col gap-4">
        <Card>
          <CardContent className="flex items-center justify-between gap-3 py-3">
            <div>
              <p className="text-sm font-medium">Correspondance IA</p>
              <p className="text-xs text-muted-foreground">
                Analyse toutes les lignes non confirmées et propose un article pour chacune.
              </p>
            </div>
            <Button onClick={onRunAi} disabled={isRunningAi}>
              {isRunningAi ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
              Lancer l'IA
            </Button>
          </CardContent>
        </Card>

        {!selectedLigne ? (
          <>
            <Card>
              <EmptyState
                icon={Wrench}
                title="Parcourez le catalogue"
                description="Cliquez sur une ligne à gauche pour lui associer un article, ou parcourez le catalogue complet ci-dessous."
              />
            </Card>

            {/* DEFAULT STATE: no ligne selected — general browsable catalogue.
                No target ligne exists yet, so "Choisir" is disabled here;
                this is a browse/inspect view (use the info icon for full
                details) rather than an assignment flow. */}
            <CatalogueSearchCard currentMaterielId={null} onChoose={onChoose} canChoose={false} />
          </>
        ) : (
          <>
            <SelectedMaterielCard
              ligne={selectedLigne}
              onConfirm={onConfirm}
              isConfirming={isConfirming}
            />

            {isRankingCandidates ? (
              <Card>
                <CardContent className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  Classement des candidats pour cette ligne…
                </CardContent>
              </Card>
            ) : (
              candidates.length > 0 && (
                <RankedCandidatesCard
                  candidates={candidates}
                  currentMaterielId={selectedLigne.bidLigne?.materiel_catalogue_id ?? null}
                  onChoose={onChoose}
                />
              )
            )}

            {/* SELECTED STATE: the general browsable catalogue stays
                available below the ranked results for manual search /
                override. */}
            <CatalogueSearchCard
              currentMaterielId={selectedLigne.bidLigne?.materiel_catalogue_id ?? null}
              onChoose={onChoose}
              canChoose
            />
          </>
        )}
      </div>
    </div>
  );
}

function SelectedMaterielCard({
  ligne,
  onConfirm,
  isConfirming,
}: {
  ligne: MarcheLigne;
  onConfirm: () => void;
  isConfirming: boolean;
}) {
  const materiel = ligne.bidLigne?.materiel ?? null;
  const isConfirmed = ligne.bidLigne?.statut === "verifie";

  return (
    <Card>
      <CardContent className="py-4">
        <p className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Ligne sélectionnée
        </p>
        <p className="mb-3 text-sm font-medium">{ligne.designation}</p>

        {!materiel ? (
          <p className="rounded-md border border-dashed border-border px-3 py-6 text-center text-sm text-muted-foreground">
            Aucun article associé pour l'instant. Lancez l'IA ou cherchez dans le catalogue ci-dessous.
          </p>
        ) : (
          <div className="rounded-lg border border-border p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <p className="truncate text-sm font-medium">{materiel.designation}</p>
                  <MaterielInfoDialog materiel={materiel} />
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {materiel.fournisseurs?.nom ?? "Fournisseur inconnu"}
                </p>
                {materiel.specs && Object.keys(materiel.specs as object).length > 0 && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    {Object.entries(materiel.specs as Record<string, unknown>)
                      .map(([k, v]) => `${k}: ${v}`)
                      .join(" · ")}
                  </p>
                )}
              </div>
              <p className="whitespace-nowrap text-sm font-semibold tabular-nums">
                {formatDinars(materiel.prix_fourniture)}
              </p>
            </div>
            <Button
              className="mt-3 w-full"
              onClick={onConfirm}
              disabled={isConfirmed || isConfirming}
            >
              {isConfirming ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <CheckCircle2 className="size-4" />
              )}
              {isConfirmed ? "Confirmé" : "Confirmer"}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Ranked candidates, produced by rankandSelect.ts's rankCandidates: unité +
// catégorie hard-filtered first, then ordered by designation/specs
// similarity, then by price as the final tiebreaker (see rankCandidates in
// rankandSelect.ts) — candidates arrives here already in that order, so the
// #1 (best) candidate is always candidates[0].
// ---------------------------------------------------------------------------
function RankedCandidatesCard({
  candidates,
  currentMaterielId,
  onChoose,
}: {
  candidates: RankedCandidate[];
  currentMaterielId: string | null;
  onChoose: (materiel: Materiel) => void;
}) {
  const [top, ...rest] = candidates;
  if (!top) return null;
  const topMateriel = top.materiel;
  const topIsCurrent = topMateriel.id === currentMaterielId;

  return (
    <Card>
      <CardContent className="py-4">
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Candidats classés
        </p>

        {/* #1 ranked candidate — shown prominently, this is what "Lancer
            l'IA" prefills / what a manual click here selects immediately. */}
        <div
          className={cn(
            "rounded-lg border-2 p-3",
            topIsCurrent ? "border-primary/50 bg-primary/5" : "border-primary/30",
          )}
        >
          <div className="mb-1.5 flex items-center gap-1.5">
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
              Meilleure correspondance
            </span>
          </div>
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <p className="truncate text-sm font-medium">{topMateriel.designation}</p>
                <MaterielInfoDialog materiel={topMateriel} />
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {topMateriel.fournisseurs?.nom ?? "Fournisseur inconnu"}
              </p>
            </div>
            <p className="whitespace-nowrap text-sm font-semibold tabular-nums">
              {formatDinars(topMateriel.prix_fourniture)}
            </p>
          </div>
          <Button
            className="mt-3 w-full"
            size="sm"
            variant={topIsCurrent ? "outline" : "default"}
            onClick={() => onChoose(topMateriel)}
            disabled={topIsCurrent}
          >
            {topIsCurrent ? "Sélectionné" : "Choisir"}
          </Button>
        </div>

        {/* Remaining ranked candidates, in descending order. */}
        {rest.length > 0 && (
          <div className="mt-3 space-y-2">
            {rest.map(({ materiel }) => (
              <div
                key={materiel.id}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2",
                  materiel.id === currentMaterielId && "border-primary/40 bg-primary/5",
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-sm">{materiel.designation}</p>
                    <MaterielInfoDialog materiel={materiel} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {materiel.fournisseurs?.nom ?? "Fournisseur inconnu"} · {formatDinars(materiel.prix_fourniture)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onChoose(materiel)}
                  disabled={materiel.id === currentMaterielId}
                >
                  {materiel.id === currentMaterielId ? "Sélectionné" : "Choisir"}
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Read-only info popup — full details for one catalogue item. Attached as a
// small "i" icon on every catalogue item card/row, in both the default
// browse pane and the ranked-candidates pane.
// ---------------------------------------------------------------------------
function MaterielInfoDialog({ materiel }: { materiel: Materiel }) {
  // materiel_catalogue has no guaranteed image column in the shared
  // Materiel type used across this file — read it defensively so this
  // still compiles/renders whether or not the column exists, and simply
  // omit the image if there isn't one.
  const imageUrl = (materiel as unknown as { image_url?: string | null }).image_url ?? null;
  const specs = (materiel.specs as Record<string, unknown> | null) ?? null;
  const specEntries = specs ? Object.entries(specs) : [];

  return (
    <Dialog>
      <DialogTrigger asChild>
        <button
          type="button"
          onClick={(e) => e.stopPropagation()}
          aria-label="Voir les détails de l'article"
          className="shrink-0 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <Info className="size-3.5" />
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-md" onClick={(e) => e.stopPropagation()}>
        <DialogHeader>
          <DialogTitle>{materiel.designation}</DialogTitle>
          <DialogDescription>
            {materiel.fournisseurs?.nom ?? "Fournisseur inconnu"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {imageUrl && (
            <img
              src={imageUrl}
              alt={materiel.designation}
              className="max-h-48 w-full rounded-md border border-border object-contain"
            />
          )}

          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
            <InfoField label="Catégorie" value={materiel.categorie ?? "—"} />
            <InfoField label="Sous-catégorie" value={materiel.sous_categorie ?? "—"} />
            <InfoField label="Unité" value={materiel.unite ?? "—"} />
            <InfoField label="Prix fourniture" value={formatDinars(materiel.prix_fourniture)} />
            <InfoField
              label="Statut"
              value={materiel.statut === "verifie" ? "En stock" : "Brouillon"}
            />
          </div>

          {specEntries.length > 0 && (
            <div>
              <p className="mb-1.5 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Spécifications
              </p>
              <div className="space-y-1 rounded-md border border-border p-2.5 text-sm">
                {specEntries.map(([key, value]) => (
                  <div key={key} className="flex items-start justify-between gap-3">
                    <span className="text-muted-foreground">{key}</span>
                    <span className="text-right font-medium">{String(value)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function InfoField({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="font-medium">{value}</p>
    </div>
  );
}

const CATALOGUE_PAGE_SIZE = 20;

function CatalogueSearchCard({
  currentMaterielId,
  onChoose,
  canChoose,
}: {
  currentMaterielId: string | null;
  onChoose: (materiel: Materiel) => void;
  /** When false (default/no-ligne-selected browse mode) there is no target
   *  ligne to assign an article to — the "Choisir" buttons are shown
   *  disabled instead of hidden, so the list still reads consistently
   *  between the two states. */
  canChoose: boolean;
}) {
  const [search, setSearch] = useState("");
  const [categorie, setCategorie] = useState<string>("__all__");
  const [sousCategorie, setSousCategorie] = useState<string>("__all__");
  const [fournisseurId, setFournisseurId] = useState<string>("__all__");
  const [enStockOnly, setEnStockOnly] = useState(false);
  const [page, setPage] = useState(0);

  // Any filter change invalidates the current page — otherwise you can land
  // on e.g. page 3 of an empty filtered result set.
  function resetPageAnd<T>(setter: (v: T) => void) {
    return (v: T) => {
      setPage(0);
      setter(v);
    };
  }

  // Total size of the real materiel_catalogue table, independent of the
  // filters below — this is what backs the "142 articles disponibles"
  // badge, so it always reflects the full catalogue, not the filtered view.
  const catalogueCountQuery = useQuery({
    queryKey: ["catalogue-total-count"],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("materiel_catalogue")
        .select("*", { count: "exact", head: true });
      if (error) throw error;
      return count ?? 0;
    },
  });

  // Filter option lists derived from the real catalogue data (not a
  // hardcoded/stale list) — sous_categorie narrows to whatever's actually
  // under the selected categorie, same as fournisseurs and categorie itself.
  const categoriesQuery = useQuery({
    queryKey: ["catalogue-categories"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("materiel_catalogue")
        .select("categorie")
        .not("categorie", "is", null);
      if (error) throw error;
      return Array.from(new Set((data ?? []).map((r) => r.categorie).filter(Boolean))) as string[];
    },
  });

  const sousCategoriesQuery = useQuery({
    queryKey: ["catalogue-sous-categories", categorie],
    queryFn: async () => {
      let query = supabase.from("materiel_catalogue").select("sous_categorie").not("sous_categorie", "is", null);
      if (categorie !== "__all__") query = query.eq("categorie", categorie);
      const { data, error } = await query;
      if (error) throw error;
      return Array.from(new Set((data ?? []).map((r) => r.sous_categorie).filter(Boolean))) as string[];
    },
  });

  const fournisseursQuery = useQuery({
    queryKey: ["fournisseurs-list"],
    queryFn: async () => {
      const { data, error } = await supabase.from("fournisseurs").select("id, nom").order("nom");
      if (error) throw error;
      return data ?? [];
    },
  });

  // The actual browsable list — the full real materiel_catalogue table
  // (no statut restriction: this is a browse/inspect view, drafts included,
  // see the info popup's statut field), with real range()-based pagination
  // instead of a silent .limit(20) truncation. `count: "exact"` on the same
  // query gives the filtered total so pagination controls know how many
  // pages actually exist.
  const resultsQuery = useQuery({
    queryKey: ["catalogue-search", search, categorie, sousCategorie, fournisseurId, enStockOnly, page],
    queryFn: async () => {
      let query = supabase
        .from("materiel_catalogue")
        .select("*, fournisseurs:fournisseur_id(id, nom)", { count: "exact" })
        .order("designation", { ascending: true })
        .range(page * CATALOGUE_PAGE_SIZE, page * CATALOGUE_PAGE_SIZE + CATALOGUE_PAGE_SIZE - 1);

      if (search.trim()) query = query.ilike("designation", `%${search.trim()}%`);
      if (categorie !== "__all__") query = query.eq("categorie", categorie);
      if (sousCategorie !== "__all__") query = query.eq("sous_categorie", sousCategorie);
      if (fournisseurId !== "__all__") query = query.eq("fournisseur_id", fournisseurId);
      // Best-effort: no dedicated stock column, see file header note.
      if (enStockOnly) query = query.eq("specs->>en_stock", "true");

      const { data, error, count } = await query;
      if (error) throw error;
      return { items: (data ?? []) as unknown as Materiel[], count: count ?? 0 };
    },
  });

  const items = resultsQuery.data?.items ?? [];
  const filteredCount = resultsQuery.data?.count ?? 0;
  const totalPages = Math.max(1, Math.ceil(filteredCount / CATALOGUE_PAGE_SIZE));

  return (
    <Card>
      <CardContent className="py-4">
        <div className="mb-3 flex items-center justify-between gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Catalogue complet
          </p>
          <span className="whitespace-nowrap rounded-full bg-muted px-2.5 py-1 text-xs font-semibold tabular-nums">
            {catalogueCountQuery.isLoading
              ? "…"
              : `${formatNumber(catalogueCountQuery.data ?? 0)} articles disponibles`}
          </span>
        </div>

        <div className="space-y-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Rechercher un article…"
              value={search}
              onChange={(e) => resetPageAnd(setSearch)(e.target.value)}
              className="pl-8"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={categorie}
              onValueChange={(v) => {
                // Changing categorie can invalidate the current
                // sous_categorie selection, so reset it back to "all".
                resetPageAnd(setCategorie)(v);
                setSousCategorie("__all__");
              }}
            >
              <SelectTrigger className="h-8 w-auto min-w-[9rem] text-xs">
                <SelectValue placeholder="Catégorie" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Toutes catégories</SelectItem>
                {(categoriesQuery.data ?? []).map((cat) => (
                  <SelectItem key={cat} value={cat}>
                    {cat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={sousCategorie} onValueChange={resetPageAnd(setSousCategorie)}>
              <SelectTrigger className="h-8 w-auto min-w-[9rem] text-xs">
                <SelectValue placeholder="Sous-catégorie" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Toutes sous-catégories</SelectItem>
                {(sousCategoriesQuery.data ?? []).map((sousCat) => (
                  <SelectItem key={sousCat} value={sousCat}>
                    {sousCat}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select value={fournisseurId} onValueChange={resetPageAnd(setFournisseurId)}>
              <SelectTrigger className="h-8 w-auto min-w-[9rem] text-xs">
                <SelectValue placeholder="Fournisseur" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">Tous fournisseurs</SelectItem>
                {(fournisseursQuery.data ?? []).map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.nom}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Checkbox
                checked={enStockOnly}
                onCheckedChange={(v) => resetPageAnd(setEnStockOnly)(v === true)}
              />
              En stock uniquement
            </label>
          </div>
        </div>

        <div className="mt-3 max-h-80 space-y-2 overflow-y-auto">
          {resultsQuery.isLoading ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : resultsQuery.isError ? (
            // Distinct from "no results": don't let a failed query masquerade
            // as an empty catalogue — that's the exact case that let bug A
            // hide silently before.
            <div className="flex flex-col items-center gap-2 py-6 text-center">
              <p className="text-sm text-destructive">
                {friendlyErrorMessage(resultsQuery.error)}
              </p>
              <Button size="sm" variant="outline" onClick={() => resultsQuery.refetch()}>
                Réessayer
              </Button>
            </div>
          ) : items.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">Aucun résultat.</p>
          ) : (
            items.map((materiel) => (
              <div
                key={materiel.id}
                className={cn(
                  "flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2",
                  materiel.id === currentMaterielId && "border-primary/40 bg-primary/5",
                )}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <p className="truncate text-sm">{materiel.designation}</p>
                    <MaterielInfoDialog materiel={materiel} />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {materiel.fournisseurs?.nom ?? "Fournisseur inconnu"} · {formatDinars(materiel.prix_fourniture)}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onChoose(materiel)}
                  disabled={!canChoose || materiel.id === currentMaterielId}
                  title={canChoose ? undefined : "Sélectionnez une ligne à gauche d'abord"}
                >
                  {materiel.id === currentMaterielId ? "Sélectionné" : "Choisir"}
                </Button>
              </div>
            ))
          )}
        </div>

        {/* Real pagination controls — the browse list is never silently
            truncated; instead it pages through the full filtered result set. */}
        {!resultsQuery.isLoading && !resultsQuery.isError && filteredCount > 0 && (
          <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
            <p className="text-xs text-muted-foreground">
              {formatNumber(filteredCount)} résultat{filteredCount > 1 ? "s" : ""}
            </p>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={page === 0}
              >
                <ChevronLeft className="size-3.5" />
              </Button>
              <span className="text-xs tabular-nums text-muted-foreground">
                Page {page + 1} / {totalPages}
              </span>
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={page >= totalPages - 1}
              >
                <ChevronRight className="size-3.5" />
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}