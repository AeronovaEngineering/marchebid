import { useMemo, useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import { ArrowLeft, FileDown, Lock, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";
import type { BordereauPdfChapitre, BordereauPdfLigne } from "@/lib/server/bordereauPdf";
import {
  applyRemise,
  isRemiseActive,
  remiseMontant,
  type Remise,
  type RemiseType,
} from "@/lib/bordereauRemises";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/pageHeader";
import { EmptyState } from "@/components/ui/Emptystate";
import { StatutBadge } from "@/components/StatutBadge";
import { formatDinars, formatDate, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";

// ----------------------------------------------------------------------------
// Remise helpers shared by both server functions below. Each server fn does
// its own DB reads (separate requests), so this is duplicated wiring, not
// duplicated math — the math itself lives in @/lib/bordereauRemises and is
// imported, not reimplemented, so PDF/XLSX/on-screen preview can't drift.
//
// NOTE: marche_remises and marches.remise_globale_type/valeur are new (see
// the accompanying migration). Until `supabase gen types` is re-run they
// aren't in the generated Tables<> types, so this file accesses them with
// `as never` / `as any`, the same escape hatch already used here for the
// `documents` table.
// ----------------------------------------------------------------------------
type MarcheRemiseRow = { chapitre_ou_zone: string; type: RemiseType; valeur: number };

function remiseMapFromRows(rows: MarcheRemiseRow[] | null | undefined): Map<string, Remise> {
  const map = new Map<string, Remise>();
  for (const row of rows ?? []) {
    if (row.valeur > 0) map.set(row.chapitre_ou_zone, { type: row.type, valeur: row.valeur });
  }
  return map;
}

function remiseGlobaleFromMarche(marche: any): Remise | null {
  const type = marche?.remise_globale_type as RemiseType | null | undefined;
  const valeur = Number(marche?.remise_globale_valeur ?? 0);
  if (!type || valeur <= 0) return null;
  return { type, valeur };
}

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

    const { data: remisesRaw } = await supabaseAdmin
      .from("marche_remises" as never)
      .select("chapitre_ou_zone, type, valeur")
      .eq("marche_id", marcheId);
    const remiseMap = remiseMapFromRows(remisesRaw as unknown as MarcheRemiseRow[] | null);
    const remiseGlobale = remiseGlobaleFromMarche(marche);

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

    // Chapter subtotals are computed brut first (sum of the raw lignes),
    // then each chapter's own remise (if any) is applied to get the net
    // sousTotal that feeds the grand total — see @/lib/bordereauRemises
    // for the shared discount-then-TVA order this and the recap page
    // both follow.
    const chapitres: BordereauPdfChapitre[] = chapitreOrder.map((nom, index) => {
      const items = chapitreMap.get(nom)!;
      const lignes = items.map((item) => item.ligne);
      // Description rows carry a null prixTotal (their price lives on
      // the article/pose sub-rows below), so guard against that here.
      const sousTotalBrut = lignes.reduce((acc, l) => acc + (l.prixTotal ?? 0), 0);
      const remise = remiseMap.get(nom) ?? null;
      const sousTotal = applyRemise(sousTotalBrut, remise);
      return { numeroRomain: toRoman(index + 1), nom, lignes, sousTotalBrut, remise, sousTotal };
    });

    const totalHtBrut = chapitres.reduce((acc, c) => acc + c.sousTotal, 0);
    const totalHt = applyRemise(totalHtBrut, remiseGlobale);
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
      totalHtBrut,
      remiseGlobale,
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
        type: "pdf",
        fichier_url: publicUrlData.publicUrl,
        storage_path: storagePath,
      } as never);
    if (insertError) {
      throw new Error(`PDF généré mais échec de l'enregistrement : ${insertError.message}`);
    }

    return { url: publicUrlData.publicUrl, version, fileName };
  });

// ----------------------------------------------------------------------------
// Server function — XLSX version. Same assembly pipeline as
// generateBordereauPdfServerFn above (own DB reads, since each
// createServerFn call is a separate request and can't share the other's
// in-memory data), just rendered through generateBordereauXlsxBuffer
// instead of generateBordereauPdfBuffer.
//
// Accepts an optional `version`: the recap page calls this right after
// generateBordereauPdfServerFn and passes that call's resolved version
// through, so both files of the same "Générer" click land on the same
// version number instead of each independently reading the current max
// from `documents` and racing/drifting apart. Still falls back to
// self-computing a version when called on its own (e.g. re-exporting just
// the XLSX later).
// ----------------------------------------------------------------------------
type GenerateBordereauXlsxResult = {
  url: string;
  version: number;
  fileName: string;
};

export const generateBordereauXlsxServerFn = createServerFn({ method: "POST" })
  .validator((data: { marcheId: string; version?: number }) => data)
  .handler(async ({ data }): Promise<GenerateBordereauXlsxResult> => {
    const marcheId = data.marcheId;

    const [{ supabaseAdmin }, { toRoman }, { generateBordereauXlsxBuffer }] = await Promise.all([
      import("@/integrations/supabase/client.server"),
      import("@/lib/server/bordereauPdf"),
      import("@/lib/server/generateBordereauXlsx"),
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

    const { data: remisesRaw } = await supabaseAdmin
      .from("marche_remises" as never)
      .select("chapitre_ou_zone, type, valeur")
      .eq("marche_id", marcheId);
    const remiseMap = remiseMapFromRows(remisesRaw as unknown as MarcheRemiseRow[] | null);
    const remiseGlobale = remiseGlobaleFromMarche(marche);

    let itemCounter = 1;
    const allLignes: { ligne: BordereauPdfLigne; chapitreKey: string }[] = [];

    for (const row of confirmed) {
      const quantite = Number(row.quantite ?? 0);
      const prixFourniture = Number(row.bid.prix_fourniture ?? 0);
      const prixPose = row.a_pose ? Number(row.bid.prix_pose ?? 0) : 0;
      const articleDesignation = row.bid.materiel_catalogue?.designation ?? null;
      const chapitreKey = row.chapitre_ou_zone?.trim() || "Sans chapitre";
      const numero = String(itemCounter);

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
      const sousTotalBrut = lignes.reduce((acc, l) => acc + (l.prixTotal ?? 0), 0);
      const remise = remiseMap.get(nom) ?? null;
      const sousTotal = applyRemise(sousTotalBrut, remise);
      return { numeroRomain: toRoman(index + 1), nom, lignes, sousTotalBrut, remise, sousTotal };
    });

    const totalHtBrut = chapitres.reduce((acc, c) => acc + c.sousTotal, 0);
    const totalHt = applyRemise(totalHtBrut, remiseGlobale);
    const tvaPct = Number(company?.default_vat_rate ?? 19);
    const totalTva = totalHt * (tvaPct / 100);
    const timbreFiscal = Number(company?.fiscal_stamp ?? 0);
    const totalTtc = totalHt + totalTva + timbreFiscal;

    let version = data.version;
    if (version === undefined) {
      const { data: existingDocs } = await supabaseAdmin
        .from("documents" as never)
        .select("version")
        .eq("marche_id", marcheId)
        .order("version", { ascending: false })
        .limit(1);
      version =
        ((existingDocs as unknown as { version: number }[] | null)?.[0]?.version ?? 0) + 1;
    }

    const xlsxBuffer = generateBordereauXlsxBuffer({
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
      totalHtBrut,
      remiseGlobale,
      totalHt,
      tvaPct,
      totalTva,
      timbreFiscal,
      totalTtc,
    });

    const safeLot = marche.lot.replace(/[^a-zA-Z0-9-_]+/g, "_");
    const fileName = `Bordereau_${safeLot}_v${version}.xlsx`;
    const storagePath = `${marcheId}/v${version}.xlsx`;

    const { error: uploadError } = await supabaseAdmin.storage
      .from("bordereaux")
      .upload(storagePath, xlsxBuffer, {
        contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        upsert: false,
      });
    if (uploadError) {
      throw new Error(`Échec de l'envoi du XLSX : ${uploadError.message}`);
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
        type: "xlsx",
        fichier_url: publicUrlData.publicUrl,
        storage_path: storagePath,
      } as never);
    if (insertError) {
      throw new Error(`XLSX généré mais échec de l'enregistrement : ${insertError.message}`);
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
const NO_REMISE: Remise = { type: "pourcentage", valeur: 0 };

type BidLigne = Tables<"bid_lignes">;
type MaterielCatalogue = Tables<"materiel_catalogue">;
type MarcheLigne = Tables<"marche_lignes"> & {
  bid_lignes: (BidLigne & { materiel_catalogue: MaterielCatalogue | null }) | null;
};

function firstOf<T>(value: T | T[] | null | undefined): T | null {
  if (!value) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

// ----------------------------------------------------------------------------
// Remise input — a %/DT toggle plus a number field. Toggle clicks commit
// immediately (a discrete choice); the number field only commits on blur,
// so typing "1" then "0" for "10" doesn't fire a save after every digit.
// ----------------------------------------------------------------------------
function RemiseInput({
  value,
  onChangeType,
  onChangeValeur,
  onBlur,
  disabled,
}: {
  value: Remise;
  onChangeType: (type: RemiseType) => void;
  onChangeValeur: (valeur: number) => void;
  onBlur: () => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <div className="flex overflow-hidden rounded-md border border-border">
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChangeType("pourcentage")}
          className={cn(
            "px-2 py-1 text-xs font-medium transition-colors",
            value.type === "pourcentage"
              ? "bg-primary text-primary-foreground"
              : "bg-background text-muted-foreground hover:text-foreground",
          )}
        >
          %
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onChangeType("montant")}
          className={cn(
            "border-l border-border px-2 py-1 text-xs font-medium transition-colors",
            value.type === "montant"
              ? "bg-primary text-primary-foreground"
              : "bg-background text-muted-foreground hover:text-foreground",
          )}
        >
          DT
        </button>
      </div>
      <input
        type="number"
        inputMode="decimal"
        min={0}
        step="0.001"
        disabled={disabled}
        value={value.valeur === 0 ? "" : value.valeur}
        placeholder="0"
        onChange={(e) => onChangeValeur(Math.max(0, Number(e.target.value) || 0))}
        onBlur={onBlur}
        className="w-20 rounded-md border border-border bg-background px-2 py-1 text-right text-xs tabular-nums focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
      />
    </div>
  );
}

function RecapMarchePage() {
  const { id: chantierId, marcheId } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data, isLoading, isError } = useQuery({
    queryKey: ["recap", marcheId],
    queryFn: async () => {
      const [
        { data: chantier, error: chantierErr },
        { data: marche, error: marcheErr },
        { data: lignes, error: lignesErr },
        { data: remises, error: remisesErr },
      ] = await Promise.all([
        supabase.from("chantiers").select("*").eq("id", chantierId).single(),
        supabase.from("marches").select("*").eq("id", marcheId).single(),
        supabase
          .from("marche_lignes")
          .select("*, bid_lignes(*, materiel_catalogue(*))")
          .eq("marche_id", marcheId)
          .order("ordre", { ascending: true }),
        supabase
          .from("marche_remises" as never)
          .select("chapitre_ou_zone, type, valeur")
          .eq("marche_id", marcheId),
      ]);

      if (chantierErr) throw chantierErr;
      if (marcheErr) throw marcheErr;
      if (lignesErr) throw lignesErr;
      if (remisesErr) throw remisesErr;

      const normalized: MarcheLigne[] = (lignes ?? []).map((row) => ({
        ...row,
        bid_lignes: (() => {
          const bid = firstOf(row.bid_lignes as any);
          if (!bid) return null;
          return { ...bid, materiel_catalogue: firstOf(bid.materiel_catalogue) };
        })(),
      }));

      return {
        chantier,
        marche,
        lignes: normalized,
        remises: (remises ?? []) as unknown as MarcheRemiseRow[],
      };
    },
  });

  const confirmedLignes = useMemo(
    () => (data?.lignes ?? []).filter((l) => l.bid_lignes?.statut === "verifie"),
    [data],
  );

  // Server-saved remises, as maps/values. These are what's actually
  // persisted; `chapitreRemiseEdits` / `globalRemiseEdit` below hold any
  // in-flight local edits that haven't round-tripped yet, and take
  // precedence over these for display so the UI doesn't jump while typing
  // or right after a save (before the query has refetched).
  const serverChapitreRemises = useMemo(() => remiseMapFromRows(data?.remises), [data]);
  const serverRemiseGlobale = useMemo(() => remiseGlobaleFromMarche(data?.marche), [data]);

  const [chapitreRemiseEdits, setChapitreRemiseEdits] = useState<Record<string, Remise>>({});
  const [globalRemiseEdit, setGlobalRemiseEdit] = useState<Remise | undefined>(undefined);

  function chapitreRemiseValue(chapitre: string): Remise {
    return chapitreRemiseEdits[chapitre] ?? serverChapitreRemises.get(chapitre) ?? NO_REMISE;
  }
  const effectiveGlobalRemise = globalRemiseEdit ?? serverRemiseGlobale ?? NO_REMISE;

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
      const sousTotalBrut = rows.reduce((acc, r) => acc + (r.total ?? 0), 0);
      return { chapitre, rows, sousTotalBrut };
    });
  }, [confirmedLignes]);

  const chapitreNet = useMemo(() => {
    const map = new Map<string, number>();
    for (const group of groups) {
      map.set(group.chapitre, applyRemise(group.sousTotalBrut, chapitreRemiseValue(group.chapitre)));
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groups, chapitreRemiseEdits, serverChapitreRemises]);

  const totalHtAvantRemiseGlobale = useMemo(
    () => Array.from(chapitreNet.values()).reduce((acc, v) => acc + v, 0),
    [chapitreNet],
  );
  const grandTotal = applyRemise(totalHtAvantRemiseGlobale, effectiveGlobalRemise);

  const isClosed = data?.chantier ? CLOSED_STATUTS.has(data.chantier.statut ?? "") : false;

  // ---------------------------------------------------------------------
  // Remise mutations
  // ---------------------------------------------------------------------
  const upsertChapitreRemiseMutation = useMutation({
    mutationFn: async ({ chapitre, remise }: { chapitre: string; remise: Remise }) => {
      if (remise.valeur <= 0) {
        const { error } = await supabase
          .from("marche_remises" as never)
          .delete()
          .eq("marche_id", marcheId)
          .eq("chapitre_ou_zone", chapitre);
        if (error) throw error;
        return;
      }
      const { error } = await supabase.from("marche_remises" as never).upsert(
        {
          marche_id: marcheId,
          chapitre_ou_zone: chapitre,
          type: remise.type,
          valeur: remise.valeur,
          updated_at: new Date().toISOString(),
        } as never,
        { onConflict: "marche_id,chapitre_ou_zone" },
      );
      if (error) throw error;
    },
    onSuccess: (_result, variables) => {
      queryClient.invalidateQueries({ queryKey: ["recap", marcheId] });
      setChapitreRemiseEdits((prev) => {
        const next = { ...prev };
        delete next[variables.chapitre];
        return next;
      });
    },
    onError: (error: Error) => {
      toast.error("Impossible d'enregistrer la remise", { description: error.message });
    },
  });

  const updateRemiseGlobaleMutation = useMutation({
    mutationFn: async (remise: Remise) => {
      const { error } = await supabase
        .from("marches")
        .update({
          remise_globale_type: remise.valeur > 0 ? remise.type : null,
          remise_globale_valeur: remise.valeur > 0 ? remise.valeur : 0,
        } as never)
        .eq("id", marcheId);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["recap", marcheId] });
      setGlobalRemiseEdit(undefined);
    },
    onError: (error: Error) => {
      toast.error("Impossible d'enregistrer la remise globale", { description: error.message });
    },
  });

  function handleChapitreTypeChange(chapitre: string, type: RemiseType) {
    const next = { ...chapitreRemiseValue(chapitre), type };
    setChapitreRemiseEdits((prev) => ({ ...prev, [chapitre]: next }));
    upsertChapitreRemiseMutation.mutate({ chapitre, remise: next });
  }
  function handleChapitreValeurChange(chapitre: string, valeur: number) {
    const next = { ...chapitreRemiseValue(chapitre), valeur };
    setChapitreRemiseEdits((prev) => ({ ...prev, [chapitre]: next }));
  }
  function handleChapitreBlur(chapitre: string) {
    upsertChapitreRemiseMutation.mutate({ chapitre, remise: chapitreRemiseValue(chapitre) });
  }

  function handleGlobalTypeChange(type: RemiseType) {
    const next = { ...effectiveGlobalRemise, type };
    setGlobalRemiseEdit(next);
    updateRemiseGlobaleMutation.mutate(next);
  }
  function handleGlobalValeurChange(valeur: number) {
    setGlobalRemiseEdit({ ...effectiveGlobalRemise, valeur });
  }
  function handleGlobalBlur() {
    updateRemiseGlobaleMutation.mutate(effectiveGlobalRemise);
  }

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
    // Sequential, not Promise.all: the XLSX call is passed the PDF call's
    // resolved version so both files from this one click land on the same
    // version number (see the comment on generateBordereauXlsxServerFn) —
    // running them in parallel would have both independently compute
    // "current max + 1" and race.
    mutationFn: async () => {
      const pdf = await generateBordereauPdfServerFn({ data: { marcheId } });
      const xlsx = await generateBordereauXlsxServerFn({
        data: { marcheId, version: pdf.version },
      });
      return { pdf, xlsx };
    },
    onSuccess: async ({ pdf, xlsx }) => {
      // window.open instead of a synthetic <a> download click — a same-tab
      // navigation to a raw storage URL was interacting badly with the
      // SPA's auth/router state (looked like the app had logged out).
      // Opening in new tabs never touches the current tab at all.
      window.open(pdf.url, "_blank");
      window.open(xlsx.url, "_blank");

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

              {groups.map((group) => {
                const remise = chapitreRemiseValue(group.chapitre);
                const net = chapitreNet.get(group.chapitre) ?? group.sousTotalBrut;
                return (
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

                    <div className="mt-2 space-y-1 border-t border-border pt-2 font-sans text-xs">
                      <div className="flex items-center justify-between text-muted-foreground">
                        <span>Remise sur ce chapitre</span>
                        <RemiseInput
                          value={remise}
                          disabled={isClosed}
                          onChangeType={(type) => handleChapitreTypeChange(group.chapitre, type)}
                          onChangeValeur={(valeur) =>
                            handleChapitreValeurChange(group.chapitre, valeur)
                          }
                          onBlur={() => handleChapitreBlur(group.chapitre)}
                        />
                      </div>
                      {isRemiseActive(remise) && (
                        <>
                          <div className="flex justify-end text-muted-foreground">
                            Sous-total brut ({group.chapitre}) :&nbsp;
                            <span className="line-through">
                              {formatDinars(group.sousTotalBrut)}
                            </span>
                          </div>
                          <div className="flex justify-end text-muted-foreground">
                            Remise :&nbsp;
                            <span>-{formatDinars(remiseMontant(group.sousTotalBrut, remise))}</span>
                          </div>
                        </>
                      )}
                      <div className="flex justify-end text-foreground">
                        S/TOTAL ({group.chapitre}) :&nbsp;
                        <span className="font-medium">{formatDinars(net)}</span>
                      </div>
                    </div>
                  </section>
                );
              })}

              <div className="space-y-1.5 border-t-2 border-foreground/20 pt-3 font-sans">
                {isRemiseActive(effectiveGlobalRemise) && (
                  <div className="flex justify-end text-sm text-muted-foreground">
                    Sous-total (après remises chapitres) :&nbsp;
                    <span>{formatDinars(totalHtAvantRemiseGlobale)}</span>
                  </div>
                )}
                <div className="flex items-center justify-between text-sm text-muted-foreground">
                  <span>Remise globale</span>
                  <RemiseInput
                    value={effectiveGlobalRemise}
                    disabled={isClosed}
                    onChangeType={handleGlobalTypeChange}
                    onChangeValeur={handleGlobalValeurChange}
                    onBlur={handleGlobalBlur}
                  />
                </div>
                {isRemiseActive(effectiveGlobalRemise) && (
                  <div className="flex justify-end text-sm text-muted-foreground">
                    Montant de la remise :&nbsp;
                    <span>
                      -{formatDinars(remiseMontant(totalHtAvantRemiseGlobale, effectiveGlobalRemise))}
                    </span>
                  </div>
                )}
                <div className="flex justify-end pt-1 text-base">
                  <span className="mr-3 font-medium">TOTAL GÉNÉRAL (H.T.V.A)</span>
                  <span className="font-semibold">{formatDinars(grandTotal)}</span>
                </div>
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