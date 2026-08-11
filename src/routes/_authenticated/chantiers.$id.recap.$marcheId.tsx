import { useMemo } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { ArrowLeft, FileDown, Lock, Loader2 } from "lucide-react";

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
// Re-fetches the confirmed bid_lignes (+ marche_lignes + materiel_catalogue)
// server-side with the service-role client -- never trusts the client-side
// preview's computed totals for the actual PDF -- groups them into
// roman-numeral chapters, hands that off to the dedicated PDF renderer in
// src/lib/server/bordereauPdf.tsx, and persists the result as a NEW
// `documents` row + `bordereaux/{marcheId}/v{n}.pdf` storage object. Prior
// versions are never overwritten, so the Documents tab keeps every version.
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

    // Route files ship to the client bundle, so the service-role client
    // and the PDF renderer (which pulls in @react-pdf/renderer, a
    // server-only dependency) are both loaded dynamically here rather
    // than imported at module scope.
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

    // Group into chapters in the order they first appear (follows `ordre`),
    // numbering them with roman numerals the same way the client's own
    // bordereau template does (I, II, III...).
    const chapitreOrder: string[] = [];
    const chapitreMap = new Map<string, typeof confirmed>();
    for (const ligne of confirmed) {
      const key = ligne.chapitre_ou_zone?.trim() || "Sans chapitre";
      if (!chapitreMap.has(key)) {
        chapitreMap.set(key, []);
        chapitreOrder.push(key);
      }
      chapitreMap.get(key)!.push(ligne);
    }

    const chapitres: BordereauPdfChapitre[] = chapitreOrder.map((nom, index) => {
      const rows = chapitreMap.get(nom)!;
      const pdfLignes: BordereauPdfLigne[] = rows.map((ligne) => {
        const quantite = Number(ligne.quantite ?? 0);
        const prixFourniture = Number(ligne.bid.prix_fourniture ?? 0);
        const prixPose = ligne.a_pose ? Number(ligne.bid.prix_pose ?? 0) : 0;
        const designation = ligne.bid.materiel_catalogue?.designation ?? ligne.designation;
        return {
          numero: ligne.numero,
          designation,
          unite: ligne.unite,
          quantite,
          prixFourniture,
          totalFourniture: quantite * prixFourniture,
          aPose: Boolean(ligne.a_pose),
          prixPose,
          totalPose: quantite * prixPose,
        };
      });
      const sousTotal = pdfLignes.reduce((acc, l) => acc + l.totalFourniture + l.totalPose, 0);
      return { numeroRomain: toRoman(index + 1), nom, lignes: pdfLignes, sousTotal };
    });

    const totalHt = chapitres.reduce((acc, c) => acc + c.sousTotal, 0);
    const tvaPct = Number(company?.default_vat_rate ?? 19);
    const totalTva = totalHt * (tvaPct / 100);
    const timbreFiscal = Number(company?.fiscal_stamp ?? 0);
    const totalTtc = totalHt + totalTva + timbreFiscal;

    // Next sequential version for this marché. `documents` is read with
    // `as never`, the same defensive cast chantiers.$id.index.tsx already
    // uses, since its migration
    // (202608120000000_add_documents_and_bordereaux_bucket.sql) may not
    // be applied to every environment yet.
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

// A chantier has no literal "terminé" enum value in chantier_statut
// (brouillon | en_cours | soumis | gagne | perdu) — "gagné" and "perdu" are
// the two closed/final states, so we treat either as "terminé" for the
// purposes of locking this page. Adjust here if a dedicated status is added.
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
      const rows = lignes.map((ligne) => {
        const bid = ligne.bid_lignes!;
        const prixFourniture = Number(bid.prix_fourniture ?? 0);
        const prixPose = ligne.a_pose ? Number(bid.prix_pose ?? 0) : 0;
        const quantite = Number(ligne.quantite ?? 0);
        const total = quantite * (prixFourniture + prixPose);
        const designation = bid.materiel_catalogue?.designation ?? ligne.designation;
        return { ligne, designation, prixFourniture, prixPose, quantite, total };
      });
      const sousTotal = rows.reduce((acc, r) => acc + r.total, 0);
      return { chapitre, rows, sousTotal };
    });
  }, [confirmedLignes]);

  const grandTotal = useMemo(() => groups.reduce((acc, g) => acc + g.sousTotal, 0), [groups]);

  const isClosed = data?.chantier ? CLOSED_STATUTS.has(data.chantier.statut ?? "") : false;

  const generateMutation = useMutation({
    mutationFn: () => generateBordereauPdfServerFn({ data: { marcheId } }),
    onSuccess: async (result) => {
      // Trigger the download.
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
            onClick={() =>
              navigate({
                to: "/chantiers/$id/remplir/$marcheId",
                params: { id: chantierId, marcheId },
              })
            }
          >
            <ArrowLeft className="mr-2 size-4" />
            Retour à l'édition
          </Button>
        }
      />

      {isClosed && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
          <Lock className="size-4 shrink-0" />
          Ce chantier est clôturé ({chantier.statut === "gagne" ? "gagné" : "perdu"}). Le
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
            {/* Bordereau preview — styled to mirror the generated PDF layout */}
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
                        <th className="w-10 py-1.5 pr-2 font-medium">N°</th>
                        <th className="py-1.5 pr-2 font-medium">Désignation</th>
                        <th className="w-16 py-1.5 pr-2 text-right font-medium">Qté</th>
                        <th className="w-12 py-1.5 pr-2 font-medium">Unité</th>
                        <th className="w-24 py-1.5 pr-2 text-right font-medium">
                          P.U. fourniture
                        </th>
                        <th className="w-24 py-1.5 pr-2 text-right font-medium">P.U. pose</th>
                        <th className="w-28 py-1.5 text-right font-medium">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {group.rows.map(({ ligne, designation, prixFourniture, prixPose, quantite, total }) => (
                        <tr key={ligne.id} className="border-t border-border/60">
                          <td className="py-1.5 pr-2 align-top text-muted-foreground">
                            {ligne.numero ?? "—"}
                          </td>
                          <td className="py-1.5 pr-2 align-top">{designation}</td>
                          <td className="py-1.5 pr-2 text-right align-top">
                            {formatNumber(quantite)}
                          </td>
                          <td className="py-1.5 pr-2 align-top text-muted-foreground">
                            {ligne.unite ?? "—"}
                          </td>
                          <td className="py-1.5 pr-2 text-right align-top">
                            {formatDinars(prixFourniture)}
                          </td>
                          <td className="py-1.5 pr-2 text-right align-top">
                            {ligne.a_pose ? formatDinars(prixPose) : "—"}
                          </td>
                          <td className="py-1.5 text-right align-top font-medium">
                            {formatDinars(total)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="mt-1 flex justify-end border-t border-border pt-1 text-xs text-muted-foreground">
                    Sous-total {group.chapitre} :&nbsp;
                    <span className="font-medium text-foreground">
                      {formatDinars(group.sousTotal)}
                    </span>
                  </div>
                </section>
              ))}

              <div className="flex justify-end border-t-2 border-foreground/20 pt-3 text-base">
                <span className="mr-3 font-medium">Total général HT</span>
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
            disabled={generateMutation.isPending}
            onClick={() =>
              navigate({
                to: "/chantiers/$id/remplir/$marcheId",
                params: { id: chantierId, marcheId },
              })
            }
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