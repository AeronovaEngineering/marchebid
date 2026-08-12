import { useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { ArrowLeft, FileDown, Lock, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import type { BordereauPdfChapitre, BordereauPdfLigne } from "@/lib/server/bordereauPdf";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/pageHeader";
import { EmptyState } from "@/components/ui/Emptystate";
import { StatutBadge } from "@/components/StatutBadge";
import { formatDinars, formatDate, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

// ----------------------------------------------------------------------------
// Server function
// ----------------------------------------------------------------------------
type GenerateBordereauResult = {
  url: string;
  version: number;
  fileName: string;
};

function firstOfRow<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export const generateBordereauPdfServerFn = createServerFn({ method: "POST" })
  .validator((data: { marcheId: string }) => data)
  .handler(async ({ data }): Promise<GenerateBordereauResult> => {
    const marcheId = data.marcheId;

    const [{ supabaseAdmin }, { generateBordereauPdfBuffer, toRoman }] = await Promise.all([
      import("@/integrations/supabase/client.server"),
      import("@/lib/server/bordereauPdf"),
    ]);

    const { data: marche, error: marcheErr } = await supabaseAdmin
      .from("marches")
      .select("*")
      .eq("id", marcheId)
      .single();
    if (marcheErr || !marche) throw marcheErr ?? new Error("Marché introuvable.");

    const { data: chantier, error: chantierErr } = await supabaseAdmin
      .from("chantiers")
      .select("*")
      .eq("id", marche.chantier_id)
      .single();
    if (chantierErr || !chantier) throw chantierErr ?? new Error("Chantier introuvable.");

    const { data: lignesRaw, error: lignesErr } = await supabaseAdmin
      .from("marche_lignes")
      .select("*, bid_lignes(*, materiel_catalogue(*))")
      .eq("marche_id", marcheId)
      .order("ordre", { ascending: true });
    if (lignesErr) throw lignesErr;

    const confirmed = (lignesRaw ?? [])
      .map((row) => {
        const bid = firstOfRow(row.bid_lignes as any);
        if (!bid || bid.statut !== "verifie") return null;
        const materiel = firstOfRow(bid.materiel_catalogue as any);
        return { ...row, bid: { ...bid, materiel_catalogue: materiel } };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (confirmed.length === 0) {
      throw new Error(
        "Aucune ligne confirmée pour ce marché : impossible de générer le bordereau.",
      );
    }

    const { data: company } = await supabaseAdmin
      .from("company_settings")
      .select("*")
      .eq("id", "1")
      .maybeSingle();

    // Build lignes: description row (official wording, verbatim) +
    // article sub-row (selected catalogue item + fourniture price) +
    // pose sub-row (if applicable). The official designation is never
    // overwritten by the chosen article's name — see bordereauPdf.tsx's
    // LigneBlock for how the three row shapes render.
    let itemCounter = 1;
    const allLignes: { ligne: BordereauPdfLigne; chapitreKey: string }[] = [];

    for (const row of confirmed) {
      const quantite = Number(row.quantite ?? 0);
      const prixFourniture = Number(row.bid.prix_fourniture ?? 0);
      const prixPose = row.a_pose ? Number(row.bid.prix_pose ?? 0) : 0;
      const articleDesignation = row.bid.materiel_catalogue?.designation ?? null;
      const chapitreKey = row.chapitre_ou_zone?.trim() || "Sans chapitre";
      const numero = String(itemCounter);

      // Row 1: the official bordereau description, exactly as issued —
      // no price on this row, that's broken out below.
      allLignes.push({
        ligne: {
          numero,
          designation: row.designation,
          unite: row.unite,
          quantite,
          prixUnitaire: null,
          prixTotal: null,
        },
        chapitreKey,
      });

      // Row 2: the selected catalogue article, with its fourniture price.
      if (articleDesignation) {
        allLignes.push({
          ligne: {
            numero: null,
            designation: articleDesignation,
            unite: null,
            quantite: null,
            prixUnitaire: prixFourniture,
            prixTotal: quantite * prixFourniture,
            isArticle: true,
            parentNumero: numero,
          },
          chapitreKey,
        });
      }

      // Row 3: pose, if applicable.
      if (row.a_pose && prixPose > 0) {
        allLignes.push({
          ligne: {
            numero: null,
            designation: "Pose",
            unite: null,
            quantite: null,
            prixUnitaire: prixPose,
            prixTotal: quantite * prixPose,
            isPose: true,
            parentNumero: numero,
          },
          chapitreKey,
        });
      }

      itemCounter++;
    }

    // Group into chapters
    const chapitreOrder: string[] = [];
    const chapitreMap = new Map<string, typeof allLignes>();
    for (const item of allLignes) {
      const key = item.chapitreKey;
      if (!chapitreMap.has(key)) {
        chapitreMap.set(key, []);
        chapitreOrder.push(key);
      }
      chapitreMap.get(key)!.push(item);
    }

    const chapitres: BordereauPdfChapitre[] = chapitreOrder.map((nom, index) => {
      const items = chapitreMap.get(nom)!;
      const lignes = items.map((item) => item.ligne);
      // Description rows carry a null prixTotal (their price lives on
      // the article/pose sub-rows below), so guard against that here.
      const sousTotal = lignes.reduce((acc, l) => acc + (l.prixTotal ?? 0), 0);
      return { numeroRomain: toRoman(index + 1), nom, lignes, sousTotal };
    });

    const totalHt = chapitres.reduce((acc, c) => acc + c.sousTotal, 0);
    const tvaPct = Number(company?.default_vat_rate ?? 19);
    const totalTva = totalHt * (tvaPct / 100);
    const timbreFiscal = Number(company?.fiscal_stamp ?? 0);
    const totalTtc = totalHt + totalTva + timbreFiscal;

    const { data: existingDocs } = await supabaseAdmin
      .from("documents" as never)
      .select("version")
      .eq("marche_id", marcheId)
      .order("version", { ascending: false })
      .limit(1);
    const version =
      ((existingDocs as unknown as { version: number }[] | null)?.[0]?.version ?? 0) + 1;

    const pdfBuffer = await generateBordereauPdfBuffer({
      chantierNom: chantier.nom,
      chantierClient: chantier.client,
      chantierLieu: chantier.lieu,
      lot: marche.lot,
      dateImport: marche.date_import,
      version,
      company: {
        companyName: company?.company_name ?? null,
        address: company?.address ?? null,
        matriculeFiscal: company?.matricule_fiscal ?? null,
      },
      chapitres,
      totalHt,
      tvaPct,
      totalTva,
      timbreFiscal,
      totalTtc,
    });

    const safeLot = marche.lot.replace(/[^a-zA-Z0-9-_]+/g, "_");
    const fileName = `Bordereau_${safeLot}_v${version}.pdf`;
    const storagePath = `${marcheId}/v${version}.pdf`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from("bordereaux")
      .upload(storagePath, pdfBuffer, {
        contentType: "application/pdf",
        upsert: false,
      });
    if (uploadError) {
      throw new Error(`Échec de l'envoi du PDF : ${uploadError.message}`);
    }

    const { data: publicUrlData } = supabaseAdmin.storage
      .from("bordereaux")
      .getPublicUrl(storagePath);

    const { error: insertError } = await supabaseAdmin
      .from("documents" as never)
      .insert({
        chantier_id: chantier.id,
        marche_id: marcheId,
        version,
        fichier_url: publicUrlData.publicUrl,
        storage_path: storagePath,
      } as never);
    if (insertError) {
      throw new Error(`PDF généré mais échec de l'enregistrement : ${insertError.message}`);
    }

    return { url: publicUrlData.publicUrl, version, fileName };
  });

// ----------------------------------------------------------------------------
// Route
// ----------------------------------------------------------------------------
export const Route = createFileRoute(
  "/_authenticated/chantiers/$id/recap/$marcheId",
)({
  component: RecapMarchePage,
});

const CLOSED_STATUTS = new Set(["gagne", "perdu"]);

type BidLigne = Tables<"bid_lignes">;
type MaterielCatalogue = Tables<"materiel_catalogue">;
type MarcheLigne = Tables<"marche_lignes"> & {
  bid_lignes: (BidLigne & { materiel_catalogue: MaterielCatalogue | null }) | null;
};

function firstOf<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

function RecapMarchePage() {
  const { id: chantierId, marcheId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["recap", marcheId],
    queryFn: async () => {
      const [{ data: chantier, error: chantierErr }, { data: marche, error: marcheErr }, { data: lignes, error: lignesErr }] =
        await Promise.all([
          supabase.from("chantiers").select("*").eq("id", chantierId).single(),
          supabase.from("marches").select("*").eq("id", marcheId).single(),
          supabase
            .from("marche_lignes")
            .select("*, bid_lignes(*, materiel_catalogue(*))")
            .eq("marche_id", marcheId)
            .order("ordre", { ascending: true }),
        ]);

      if (chantierErr) throw chantierErr;
      if (marcheErr) throw marcheErr;
      if (lignesErr) throw lignesErr;

      const normalized: MarcheLigne[] = (lignes ?? []).map((row) => ({
        ...row,
        bid_lignes: (() => {
          const bid = firstOf(row.bid_lignes as any);
          if (!bid) return null;
          return { ...bid, materiel_catalogue: firstOf(bid.materiel_catalogue) };
        })(),
      }));

      return { chantier, marche, lignes: normalized };
    },
  });

  const confirmedLignes = useMemo(
    () => (data?.lignes ?? []).filter((l) => l.bid_lignes?.statut === "verifie"),
    [data],
  );

  const groups = useMemo(() => {
    const map = new Map<string, MarcheLigne[]>();
    for (const ligne of confirmedLignes) {
      const key = ligne.chapitre_ou_zone?.trim() || "Sans chapitre";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(ligne);
    }
    return Array.from(map.entries()).map(([chapitre, lignes]) => {
      let itemCounter = 1;
      const rows = [];
      for (const ligne of lignes) {
        const bid = ligne.bid_lignes!;
        const prixFourniture = Number(bid.prix_fourniture ?? 0);
        const prixPose = ligne.a_pose ? Number(bid.prix_pose ?? 0) : 0;
        const quantite = Number(ligne.quantite ?? 0);
        const articleDesignation = bid.materiel_catalogue?.designation ?? null;
        const numero = String(itemCounter);

        // Row 1: the official bordereau description, unchanged — no
        // price here, that's broken out on the sub-rows below it.
        rows.push({
          ligne,
          kind: "description" as const,
          designation: ligne.designation,
          unite: ligne.unite,
          quantite: quantite as number | null,
          prixUnitaire: null as number | null,
          total: null as number | null,
          numero,
        });

        // Row 2: the selected catalogue article + its fourniture price.
        if (articleDesignation) {
          rows.push({
            ligne,
            kind: "article" as const,
            designation: articleDesignation,
            unite: null,
            quantite: null,
            prixUnitaire: prixFourniture,
            total: quantite * prixFourniture,
            numero: "",
          });
        }

        // Row 3: pose, if applicable.
        if (ligne.a_pose && prixPose > 0) {
          rows.push({
            ligne,
            kind: "pose" as const,
            designation: "Pose",
            unite: null,
            quantite: null,
            prixUnitaire: prixPose,
            total: quantite * prixPose,
            numero: "",
          });
        }
        itemCounter++;
      }
      const sousTotal = rows.reduce((acc, r) => acc + (r.total ?? 0), 0);
      return { chapitre, rows, sousTotal };
    });
  }, [confirmedLignes]);

  const grandTotal = useMemo(() => groups.reduce((acc, g) => acc + g.sousTotal, 0), [groups]);

  const isClosed = data?.chantier ? CLOSED_STATUTS.has(data.chantier.statut ?? "") : false;

  // "Retour à l'édition" used to be a pure navigation — it never touched
  // bid_lignes.statut, so every ligne stayed 'verifie' and the remplir
  // screen's right pane (gated on allConfirmed) never left the "toutes
  // confirmées" success card, no matter what you clicked there. This
  // mutation reverts every confirmed ligne of this marché back to
  // 'suggere' first, so remplir actually reopens the catalogue/candidates
  // view to let the user pick something else — same effect a manual
  // re-choice already has on any single ligne, just applied to all of
  // them at once. Only used when the chantier isn't closed (locked
  // chantiers don't allow re-editing at all — see isClosed below).
  const reopenEditionMutation = useMutation({
    mutationFn: async () => {
      const ligneIds = (data?.lignes ?? []).map((l) => l.id);
      if (ligneIds.length === 0) return;
      const { error } = await supabase
        .from("bid_lignes")
        .update({ statut: "suggere", updated_at: new Date().toISOString() })
        .eq("statut", "verifie")
        .in("marche_ligne_id", ligneIds);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["marche-lignes", marcheId] });
      navigate({
        to: "/chantiers/$id/remplir/$marcheId",
        params: { id: chantierId, marcheId },
      });
    },
    onError: (error: Error) => {
      toast.error("Impossible de rouvrir l'édition", { description: error.message });
    },
  });

  function handleRetourEdition() {
    if (isClosed) {
      // Chantier locked: no statut change, just go look at it read-only.
      navigate({
        to: "/chantiers/$id/remplir/$marcheId",
        params: { id: chantierId, marcheId },
      });
      return;
    }
    reopenEditionMutation.mutate();
  }

  const generateMutation = useMutation({
    mutationFn: () => generateBordereauPdfServerFn({ data: { marcheId } }),
    onSuccess: async (result) => {
      const link = document.createElement("a");
      link.href = result.url;
      link.download = result.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();

      await queryClient.invalidateQueries({ queryKey: ["documents", chantierId] });

      navigate({
        to: "/chantiers/$id",
        params: { id: chantierId },
        search: { tab: "documents" } as any,
      });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24 text-sm text-muted-foreground">
        <Loader2 className="mr-2 size-4 animate-spin" />
        Chargement du récapitulatif…
      </div>
    );
  }

  if (isError || !data?.chantier || !data?.marche) {
    return (
      <EmptyState
        icon={FileDown}
        title="Impossible de charger ce récapitulatif"
        description="Le marché ou le chantier demandé est introuvable."
      />
    );
  }

  const { chantier, marche } = data;

  return (
    <div>
      <PageHeader
        title={
          <>
            Récapitulatif — {marche.lot}
            <StatutBadge statut={chantier.statut ?? "brouillon"} kind="chantier" />
          </>
        }
        description={
          <>
            {chantier.nom}
            {chantier.client ? ` · ${chantier.client}` : ""} · Aperçu avant génération du
            bordereau
          </>
        }
        action={
          <Button
            variant="outline"
            disabled={reopenEditionMutation.isPending}
            onClick={handleRetourEdition}
          >
            {reopenEditionMutation.isPending ? (
              <Loader2 className="mr-2 size-4 animate-spin" />
            ) : (
              <ArrowLeft className="mr-2 size-4" />
            )}
            Retour à l'édition
          </Button>
        }
      />

      {isClosed && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <Lock className="size-4 shrink-0" />
          Ce chantier est clôturé Le
          bordereau ne peut plus être régénéré depuis cette page.
        </div>
      )}

      {groups.length === 0 ? (
        <EmptyState
          icon={FileDown}
          title="Aucune ligne confirmée"
          description="Aucune ligne de ce marché n'a encore été validée. Retournez à l'édition pour confirmer les lignes avant de générer le bordereau."
        />
      ) : (
        <Card className="overflow-hidden">
          <CardContent className="p-8">
            <div className="mx-auto max-w-3xl space-y-8 font-serif text-[13px] leading-relaxed text-foreground">
              <header className="border-b border-border pb-4 text-center">
                <p className="text-xs uppercase tracking-widest text-muted-foreground">
                  Bordereau de prix
                </p>
                <h2 className="mt-1 text-xl font-semibold">{marche.lot}</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {chantier.nom}
                  {chantier.lieu ? ` — ${chantier.lieu}` : ""}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {chantier.client ? `Client : ${chantier.client} · ` : ""}
                  {formatDate(marche.date_import)}
                </p>
              </header>

              {groups.map((group) => (
                <section key={group.chapitre}>
                  <h3 className="mb-2 border-b border-border pb-1 text-sm font-semibold uppercase tracking-wide">
                    {group.chapitre}
                  </h3>
                  <table className="w-full border-collapse text-left">
                    <thead>
                      <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                        <th className="w-12 py-1.5 pr-2 font-medium">N°</th>
                        <th className="py-1.5 pr-2 font-medium">Désignation</th>
                        <th className="w-12 py-1.5 pr-2 font-medium">U</th>
                        <th className="w-16 py-1.5 pr-2 text-right font-medium">Qté</th>
                        <th className="w-24 py-1.5 pr-2 text-right font-medium">P.U. (H.T.V.A)</th>
                        <th className="w-28 py-1.5 text-right font-medium">P.T. (H.T.V.A)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map((row, idx) => (
                        <tr
                          key={idx}
                          className={cn(
                            "border-t border-border/60",
                            row.kind === "pose" && "bg-muted/30",
                          )}
                        >
                          <td className="py-1.5 pr-2 align-top text-muted-foreground">
                            {row.numero}
                          </td>
                          <td
                            className={cn(
                              "py-1.5 pr-2 align-top",
                              row.kind === "article" && "pl-4 font-medium",
                              row.kind === "pose" && "pl-4 italic text-muted-foreground",
                            )}
                          >
                            {row.kind === "article" ? `\u203A ${row.designation}` : row.designation}
                          </td>
                          <td className="py-1.5 pr-2 align-top text-muted-foreground">
                            {row.unite ?? ""}
                          </td>
                          <td className="py-1.5 pr-2 text-right align-top">
                            {row.quantite !== null ? formatNumber(row.quantite) : ""}
                          </td>
                          <td className="py-1.5 pr-2 text-right align-top">
                            {row.prixUnitaire !== null ? formatDinars(row.prixUnitaire) : ""}
                          </td>
                          <td className="py-1.5 text-right align-top font-medium">
                            {row.total !== null ? formatDinars(row.total) : ""}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="mt-1 flex justify-end border-t border-border pt-1 text-xs text-muted-foreground">
                    S/TOTAL ({group.chapitre}) :&nbsp;
                    <span className="font-medium text-foreground">
                      {formatDinars(group.sousTotal)}
                    </span>
                  </div>
                </section>
              ))}

              <div className="flex justify-end border-t-2 border-foreground/20 pt-3 text-base">
                <span className="mr-3 font-medium">TOTAL GÉNÉRAL (H.T.V.A)</span>
                <span className="font-semibold">{formatDinars(grandTotal)}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {!isClosed && groups.length > 0 && (
        <div className="mt-6 flex justify-end gap-3">
          <Button
            variant="outline"
            disabled={generateMutation.isPending || reopenEditionMutation.isPending}
            onClick={handleRetourEdition}
          >
            Retour à l'édition
          </Button>
          <Button
            disabled={generateMutation.isPending}
            onClick={() => generateMutation.mutate()}
          >
            {generateMutation.isPending ? (
              <>
                <Loader2 className="mr-2 size-4 animate-spin" />
                Génération en cours…
              </>
            ) : (
              <>
                <FileDown className="mr-2 size-4" />
                Confirmer et générer le PDF
              </>
            )}
          </Button>
        </div>
      )}

      {generateMutation.isError && (
        <p className={cn("mt-3 text-right text-sm text-destructive")}>
          Échec de la génération du bordereau : {(generateMutation.error as Error).message}
        </p>
      )}
    </div>
  );
}