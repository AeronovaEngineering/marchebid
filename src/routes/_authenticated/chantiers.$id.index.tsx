import { useMemo, useRef, useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  ArrowLeft,
  Building2,
  Download,
  FileSpreadsheet,
  Loader2,
  Lock,
  Plus,
  Trash2,
  Upload,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { StatutBadge } from "@/components/StatutBadge";
import { PageHeader } from "@/components/ui/pageHeader";
import { EmptyState } from "@/components/ui/Emptystate";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatDate, formatDinars } from "@/lib/format";
import { parseBordereauServerFn } from "@/lib/parsing/parseBordereau";
import { logActivity } from "@/lib/Activitylog";

// ----------------------------------------------------------------------------
// Progression physique (Suivi tab). Requires migration:
// supabase/migrations/202608060000000_progression_statut_documents.sql
// (marche_lignes.progression, marches.statut, documents table). Until that
// migration is applied and types.ts regenerated, writes below will fail
// server-side with a clear toast rather than crashing the page.
// ----------------------------------------------------------------------------
type Progression = "non_commence" | "en_cours" | "termine";

const PROGRESSION_LABELS: Record<Progression, string> = {
  non_commence: "Non commencé",
  en_cours: "En cours",
  termine: "Terminé",
};

type MarcheStatut = "en_cours" | "termine";

// Win/loss result of the marché, separate from MarcheStatut above (which
// tracks bordereau-filling progress). One-way door once gagne/perdu is
// set: enforced server-side by the marches_resultat_one_way_trg trigger
// (see supabase/migrations/202608120000000_marches_resultat.sql) — the
// Select below only mirrors that rule by hiding "En attente" once fixed,
// it isn't the real guardrail.
type MarcheResultat = "en_attente" | "gagne" | "perdu";

const RESULTAT_LABELS: Record<MarcheResultat, string> = {
  en_attente: "En attente",
  gagne: "Gagné",
  perdu: "Perdu",
};

// Chantier-level status — same value set StatutBadge already renders for
// kind="chantier" (see RecapMarchePage's badge + CLOSED_STATUTS above).
// "gagne" freezes every marché under this chantier from further edits (see
// isLocked in the "Marchés" tab below), so changing it here has real
// consequences elsewhere in the app, not just a label change.
type ChantierStatut = "brouillon" | "en_cours" | "gagne" | "perdu";

const CHANTIER_STATUT_LABELS: Record<ChantierStatut, string> = {
  brouillon: "Brouillon",
  en_cours: "En cours",
  gagne: "Gagné",
  perdu: "Perdu",
};

// A lot at or above this confirmed-lines percentage is treated as real,
// in-progress work and can no longer be deleted from the UI.
const DELETE_THRESHOLD_PCT = 60;

interface BidLigneInfo {
  statut: string | null;
  prix_fourniture: number | null;
  prix_pose: number | null;
}

interface MarcheLigneRow {
  id: string;
  marche_id: string;
  quantite: number | null;
  a_pose: boolean | null;
  designation: string;
  chapitre_ou_zone: string | null;
  progression?: Progression | null;
  bid_lignes: BidLigneInfo | BidLigneInfo[] | null;
}

interface MarcheRow {
  id: string;
  chantier_id: string;
  lot: string;
  fichier_original: string | null;
  format_detecte: string | null;
  date_import: string | null;
  statut?: MarcheStatut | null;
  resultat?: MarcheResultat | null;
}

interface DocumentRow {
  id: string;
  chantier_id: string;
  marche_id: string | null;
  version: number;
  fichier_url: string;
  created_at: string | null;
}

function bidLigne(row: MarcheLigneRow): BidLigneInfo | null {
  if (!row.bid_lignes) return null;
  return Array.isArray(row.bid_lignes) ? row.bid_lignes[0] ?? null : row.bid_lignes;
}

function isConfirmee(row: MarcheLigneRow): boolean {
  return bidLigne(row)?.statut === "verifie";
}

function ligneMontant(row: MarcheLigneRow): number {
  const bid = bidLigne(row);
  if (!bid) return 0;
  const quantite = Number(row.quantite ?? 0);
  let total = Number(bid.prix_fourniture ?? 0) * quantite;
  if (row.a_pose) total += Number(bid.prix_pose ?? 0) * quantite;
  return total;
}

// ----------------------------------------------------------------------------

export const Route = createFileRoute("/_authenticated/chantiers/$id/")({
  component: ChantierDetailPage,
});

function useChantier(id: string) {
  return useQuery({
    queryKey: ["chantier", id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("chantiers")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw error;
      return data;
    },
  });
}

function useMarches(chantierId: string) {
  return useQuery({
    queryKey: ["marches", chantierId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("marches")
        .select("*")
        .eq("chantier_id", chantierId)
        .order("date_import", { ascending: false });
      if (error) throw error;
      return (data ?? []) as MarcheRow[];
    },
  });
}

function useLignes(chantierId: string) {
  return useQuery({
    queryKey: ["marche_lignes", "chantier", chantierId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("marche_lignes")
        .select("*, marches!inner(id, chantier_id), bid_lignes(statut, prix_fourniture, prix_pose)")
        .eq("marches.chantier_id", chantierId);
      if (error) throw error;
      return (data ?? []) as unknown as MarcheLigneRow[];
    },
  });
}

// documents table doesn't exist until the migration above is applied; this
// hook degrades to an empty list + a flag instead of crashing the page.
function useDocuments(chantierId: string) {
  return useQuery({
    queryKey: ["documents", chantierId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("documents" as never)
        .select("*")
        .eq("chantier_id", chantierId)
        .order("version", { ascending: false });
      if (error) {
        return { rows: [] as DocumentRow[], migrationPending: true };
      }
      return { rows: (data ?? []) as unknown as DocumentRow[], migrationPending: false };
    },
  });
}

function ChantierDetailPage() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: chantier, isLoading: loadingChantier } = useChantier(id);
  const { data: marches, isLoading: loadingMarches } = useMarches(id);
  const { data: lignes, isLoading: loadingLignes } = useLignes(id);
  const { data: documents, isLoading: loadingDocuments } = useDocuments(id);

  const [lotName, setLotName] = useState("");
  const [uploading, setUploading] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Chantier statut update — optimistic like updateResultat below, reverted
  // if the write fails (e.g. a one-way-door trigger on chantiers mirroring
  // the one on marches_resultat, if one exists server-side).
  const [updatingStatut, setUpdatingStatut] = useState(false);

  // Lot deletion. Only offered below the 60% confirmed-lines threshold —
  // this is meant for wiping out lots created purely for testing, not for
  // touching real in-progress work. See DELETE_THRESHOLD_PCT below.
  const [pendingDelete, setPendingDelete] = useState<{ id: string; lot: string; nbLignes: number } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Suivi tab: filters the confirmed-lines table by marché. Only surfaced
  // in the UI when the chantier has more than one marché (see hasMultipleMarches).
  const [suiviLotFilter, setSuiviLotFilter] = useState<string>("all");

  const stats = useMemo(() => {
    const rows = lignes ?? [];
    const confirmees = rows.filter(isConfirmee);
    const montant = confirmees.reduce((sum, row) => sum + ligneMontant(row), 0);
    return {
      total: rows.length,
      confirmees: confirmees.length,
      montant,
    };
  }, [lignes]);

  const marchesWithStats = useMemo(() => {
    return (marches ?? []).map((marche) => {
      const rows = (lignes ?? []).filter((l) => l.marche_id === marche.id);
      const confirmees = rows.filter(isConfirmee).length;
      const pct = rows.length ? Math.round((confirmees / rows.length) * 100) : 0;
      return { marche, nbLignes: rows.length, nbConfirmees: confirmees, pct };
    });
  }, [marches, lignes]);

  const lignesConfirmeesSuivi = useMemo(
    () => (lignes ?? []).filter(isConfirmee),
    [lignes],
  );

  const hasMultipleMarches = (marches?.length ?? 0) > 1;

  const suiviLignesFiltered = useMemo(() => {
    if (!hasMultipleMarches || suiviLotFilter === "all") return lignesConfirmeesSuivi;
    return lignesConfirmeesSuivi.filter((row) => row.marche_id === suiviLotFilter);
  }, [lignesConfirmeesSuivi, hasMultipleMarches, suiviLotFilter]);

  async function handleFileSelected(file: File) {
    if (!lotName.trim()) {
      toast.error("Indiquez le nom du lot avant d'importer un fichier.");
      return;
    }
    setUploading(true);
    setParseError(null);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const result = await parseBordereauServerFn({ data: formData });
      if (!result.ok) {
        setParseError(result.reason ?? "Échec de l'analyse du fichier.");
        return;
      }

      const { data: marche, error: marcheError } = await supabase
        .from("marches")
        .insert({
          chantier_id: id,
          lot: lotName.trim(),
          fichier_original: file.name,
          format_detecte: result.format_detecte ?? file.name.split(".").pop() ?? null,
        })
        .select()
        .single();
      if (marcheError || !marche) throw marcheError ?? new Error("Création du marché impossible.");

      const rows = result.lignes.map((l, index) => ({
        marche_id: marche.id,
        numero: l.numero ?? null,
        designation: l.designation,
        quantite: l.quantite,
        unite: l.unite ?? null,
        chapitre_ou_zone: l.chapitre_ou_zone ?? null,
        a_pose: l.a_pose,
        ordre: index,
      }));

      if (rows.length > 0) {
        const { error: lignesError } = await supabase.from("marche_lignes").insert(rows);
        if (lignesError) throw lignesError;
      }

      toast.success(`Lot "${lotName.trim()}" importé (${rows.length} lignes).`);
      void logActivity({
        action: "create",
        entity_type: "marche",
        entity_id: marche.id,
        details: { lot: lotName.trim(), fichier: file.name, nb_lignes: rows.length },
      });
      await queryClient.invalidateQueries({ queryKey: ["marches", id] });
      await queryClient.invalidateQueries({ queryKey: ["marche_lignes", "chantier", id] });
      navigate({ to: "/chantiers/$id/remplir/$marcheId", params: { id, marcheId: marche.id } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur lors de l'import du marché.");
    } finally {
      setUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function updateProgression(ligneId: string, value: Progression) {
    queryClient.setQueryData<MarcheLigneRow[]>(["marche_lignes", "chantier", id], (prev) =>
      prev?.map((row) => (row.id === ligneId ? { ...row, progression: value } : row)),
    );
    const { error } = await supabase
      .from("marche_lignes")
      // @ts-expect-error — `progression` requires the pending migration; see note above.
      .update({ progression: value })
      .eq("id", ligneId);
    if (error) {
      toast.error(
        "Impossible d'enregistrer la progression : la colonne 'progression' n'existe pas encore (migration requise).",
      );
      queryClient.invalidateQueries({ queryKey: ["marche_lignes", "chantier", id] });
    }
  }

  async function updateChantierStatut(value: ChantierStatut) {
    const previous = (chantier?.statut as ChantierStatut | null | undefined) ?? "brouillon";
    if (value === previous) return;
    setUpdatingStatut(true);
    queryClient.setQueryData<typeof chantier>(["chantier", id], (prev) =>
      prev ? { ...prev, statut: value } : prev,
    );
    const { error } = await supabase
      .from("chantiers")
      .update({ statut: value })
      .eq("id", id);
    if (error) {
      toast.error("Impossible d'enregistrer le statut du chantier.");
      queryClient.setQueryData<typeof chantier>(["chantier", id], (prev) =>
        prev ? { ...prev, statut: previous } : prev,
      );
    } else {
      void logActivity({
        action: "update",
        entity_type: "chantier",
        entity_id: id,
        details: { statut: value },
      });
      // "gagne" locks every marché below (see isLocked in the Marchés tab),
      // so other queries derived from this chantier need a refresh too.
      await queryClient.invalidateQueries({ queryKey: ["marches", id] });
    }
    setUpdatingStatut(false);
  }

  async function updateResultat(marcheId: string, value: MarcheResultat) {
    const previous = marches?.find((m) => m.id === marcheId)?.resultat ?? "en_attente";
    queryClient.setQueryData<MarcheRow[]>(["marches", id], (prev) =>
      prev?.map((m) => (m.id === marcheId ? { ...m, resultat: value } : m)),
    );
    const { error } = await supabase
      .from("marches")
      // @ts-expect-error — `resultat` requires the pending migration; see note above.
      .update({ resultat: value })
      .eq("id", marcheId);
    if (error) {
      toast.error(
        error.message.includes("en_attente")
          ? "Ce marché est déjà gagné ou perdu : retour à \"En attente\" impossible."
          : "Impossible d'enregistrer le résultat du marché.",
      );
      queryClient.setQueryData<MarcheRow[]>(["marches", id], (prev) =>
        prev?.map((m) => (m.id === marcheId ? { ...m, resultat: previous } : m)),
      );
    } else {
      void logActivity({
        action: "update",
        entity_type: "marche",
        entity_id: marcheId,
        details: { resultat: value },
      });
      await queryClient.invalidateQueries({ queryKey: ["chantier", id] });
    }
  }

  async function handleConfirmDelete() {
    const target = pendingDelete;
    if (!target) return;
    setDeletingId(target.id);
    try {
      // The marches -> marche_lignes -> bid_lignes foreign keys are both
      // ON DELETE CASCADE, so deleting the marches row alone is enough;
      // no need to manually delete marche_lignes/bid_lignes first.
      // Requires the "marches_admin_delete" RLS policy to be applied, or
      // this silently 403s the same way "Choisir" used to.
      const { error } = await supabase.from("marches").delete().eq("id", target.id);
      if (error) throw error;

      toast.success(`Lot "${target.lot}" supprimé (${target.nbLignes} ligne(s)).`);
      void logActivity({
        action: "delete",
        entity_type: "marche",
        entity_id: target.id,
        details: { lot: target.lot, nb_lignes: target.nbLignes },
      });
      await queryClient.invalidateQueries({ queryKey: ["marches", id] });
      await queryClient.invalidateQueries({ queryKey: ["marche_lignes", "chantier", id] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur lors de la suppression du lot.");
    } finally {
      setDeletingId(null);
      setPendingDelete(null);
    }
  }

  if (loadingChantier) {
    return <div className="flex justify-center py-16"><Loader2 className="size-6 animate-spin text-muted-foreground" /></div>;
  }

  if (!chantier) {
    return (
      <EmptyState
        icon={Building2}
        title="Chantier introuvable"
        description="Ce chantier n'existe pas ou a été supprimé."
        action={
          <Button asChild variant="outline">
            <Link to="/chantiers">Retour aux chantiers</Link>
          </Button>
        }
      />
    );
  }

  const hasMarches = (marches?.length ?? 0) > 0;

  return (
    <div>
      <Link
        to="/chantiers"
        className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Retour aux chantiers
      </Link>

      <PageHeader
        title={
          <>
            {chantier.nom}
            <StatutBadge statut={chantier.statut ?? "brouillon"} kind="chantier" />
          </>
        }
        description={chantier.client ?? undefined}
        action={
          <Select
            value={(chantier.statut as ChantierStatut | null) ?? "brouillon"}
            disabled={updatingStatut}
            onValueChange={(value) => updateChantierStatut(value as ChantierStatut)}
          >
            <SelectTrigger className="w-40">
              {updatingStatut ? (
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" />
                  <SelectValue />
                </span>
              ) : (
                <SelectValue />
              )}
            </SelectTrigger>
            <SelectContent>
              {(Object.keys(CHANTIER_STATUT_LABELS) as ChantierStatut[]).map((key) => (
                <SelectItem key={key} value={key}>
                  {CHANTIER_STATUT_LABELS[key]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      {/* Stats row */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Lignes</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{loadingLignes ? "—" : stats.total}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Confirmées</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {loadingLignes ? "—" : `${stats.confirmees} / ${stats.total}`}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Montant chiffré</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">
              {loadingLignes ? "—" : formatDinars(stats.montant)}
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Upload section */}
      <Card className="mb-6">
        <CardContent className="p-4">
          {!hasMarches ? (
            <div>
              <p className="mb-3 text-sm font-medium">Importer le bordereau du marché</p>
              <UploadForm
                lotName={lotName}
                setLotName={setLotName}
                uploading={uploading}
                fileInputRef={fileInputRef}
                onFileSelected={handleFileSelected}
              />
              {parseError && (
                <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                  <p className="text-destructive">{parseError}</p>
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => toast("Saisie manuelle à venir.")}
                  >
                    Ajouter une ligne manuellement
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <details className="group">
              <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium text-primary">
                <Plus className="size-4" />
                Ajouter un marché / lot
              </summary>
              <div className="mt-3">
                <UploadForm
                  lotName={lotName}
                  setLotName={setLotName}
                  uploading={uploading}
                  fileInputRef={fileInputRef}
                  onFileSelected={handleFileSelected}
                />
                {parseError && (
                  <div className="mt-3 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm">
                    <p className="text-destructive">{parseError}</p>
                    <Button
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      onClick={() => toast("Saisie manuelle à venir.")}
                    >
                      Ajouter une ligne manuellement
                    </Button>
                  </div>
                )}
              </div>
            </details>
          )}
        </CardContent>
      </Card>

      {/* Tabs */}
      <Tabs defaultValue="marches">
        <TabsList>
          <TabsTrigger value="marches">Marchés</TabsTrigger>
          <TabsTrigger value="suivi">Suivi</TabsTrigger>
          <TabsTrigger value="documents">Documents</TabsTrigger>
        </TabsList>

        <TabsContent value="marches" className="mt-4">
          {loadingMarches ? (
            <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          ) : !hasMarches ? (
            <EmptyState
              icon={FileSpreadsheet}
              title="Aucun marché importé"
              description="Importez un bordereau ci-dessus pour commencer le chiffrage."
            />
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <TableHead>Lot</TableHead>
                    <TableHead>Date d'import</TableHead>
                    <TableHead>Lignes</TableHead>
                    <TableHead>% confirmées</TableHead>
                    <TableHead>Résultat</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {marchesWithStats.map(({ marche, nbLignes, nbConfirmees, pct }) => {
                    const isComplete = nbLignes > 0 && pct === 100;
                    // A marché at 100% is simply ready for the recap/PDF
                    // step — it can still be reopened and edited freely.
                    // Only a chantier that has been won ('gagne') freezes
                    // its marchés from further edits.
                    const isLocked = chantier.statut === "gagne";
                    return (
                      <TableRow
                        key={marche.id}
                        className="cursor-pointer border-t border-border hover:bg-muted/30"
                        onClick={() => {
                          if (isLocked) return;
                          navigate({
                            to: "/chantiers/$id/remplir/$marcheId",
                            params: { id, marcheId: marche.id },
                          });
                        }}
                      >
                        <TableCell className="font-medium">
                          <span className="inline-flex items-center gap-1.5">
                            {marche.lot}
                            {isLocked && (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <Lock className="size-3.5 text-muted-foreground" />
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    Chantier gagné : ce marché est verrouillé et ne peut plus être modifié.
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            )}
                          </span>
                        </TableCell>
                        <TableCell>{formatDate(marche.date_import)}</TableCell>
                        <TableCell>{nbLignes}</TableCell>
                        <TableCell>{pct}%</TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <Select
                            value={marche.resultat ?? "en_attente"}
                            disabled={isLocked}
                            onValueChange={(value) => updateResultat(marche.id, value as MarcheResultat)}
                          >
                            <SelectTrigger className="w-32">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {(Object.keys(RESULTAT_LABELS) as MarcheResultat[])
                                // Once fixed (gagne/perdu), "En attente" is no longer
                                // offered — the DB trigger is the real guardrail, this
                                // just mirrors it in the UI.
                                .filter(
                                  (key) =>
                                    key !== "en_attente" ||
                                    !marche.resultat ||
                                    marche.resultat === "en_attente",
                                )
                                .map((key) => (
                                  <SelectItem key={key} value={key}>
                                    {RESULTAT_LABELS[key]}
                                  </SelectItem>
                                ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-2">
                            {isComplete ? (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span>
                                      <Button
                                        size="sm"
                                        variant="outline"
                                        disabled={marche.statut === "termine"}
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          toast("Génération du PDF depuis la page de récapitulatif.");
                                        }}
                                      >
                                        <Download className="size-4" />
                                        Télécharger PDF
                                      </Button>
                                    </span>
                                  </TooltipTrigger>
                                  {marche.statut === "termine" && (
                                    <TooltipContent>
                                      Ce marché est terminé : aucune nouvelle génération n'est possible.
                                    </TooltipContent>
                                  )}
                                </Tooltip>
                              </TooltipProvider>
                            ) : (
                              <span className="text-xs text-muted-foreground">En cours de saisie</span>
                            )}

                            {pct >= DELETE_THRESHOLD_PCT ? (
                              <TooltipProvider>
                                <Tooltip>
                                  <TooltipTrigger asChild>
                                    <span>
                                      <Button
                                        size="sm"
                                        variant="ghost"
                                        disabled
                                        className="h-8 w-8 p-0 text-muted-foreground"
                                        onClick={(e) => e.stopPropagation()}
                                      >
                                        <Trash2 className="size-4" />
                                      </Button>
                                    </span>
                                  </TooltipTrigger>
                                  <TooltipContent>
                                    {`Ce lot est avancé à ${pct}% et ne peut plus être supprimé`}
                                  </TooltipContent>
                                </Tooltip>
                              </TooltipProvider>
                            ) : (
                              <Button
                                size="sm"
                                variant="ghost"
                                className="h-8 w-8 p-0 text-destructive hover:text-destructive"
                                disabled={deletingId === marche.id}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setPendingDelete({ id: marche.id, lot: marche.lot, nbLignes });
                                }}
                              >
                                {deletingId === marche.id ? (
                                  <Loader2 className="size-4 animate-spin" />
                                ) : (
                                  <Trash2 className="size-4" />
                                )}
                              </Button>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>

        <TabsContent value="suivi" className="mt-4">
          {loadingLignes ? (
            <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          ) : (
            <div className="space-y-3">
              {hasMultipleMarches && (
                <div className="flex justify-end">
                  <Select value={suiviLotFilter} onValueChange={setSuiviLotFilter}>
                    <SelectTrigger className="w-56">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Tous les lots</SelectItem>
                      {(marches ?? []).map((marche) => (
                        <SelectItem key={marche.id} value={marche.id}>
                          {marche.lot}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}

              {suiviLignesFiltered.length === 0 ? (
                <EmptyState
                  icon={FileSpreadsheet}
                  title="Aucune ligne confirmée"
                  description="Le suivi de chantier apparaît ici une fois des lignes vérifiées dans le chiffrage."
                />
              ) : (
                <div className="overflow-hidden rounded-lg border border-border bg-card">
                  <Table>
                    <TableHeader>
                      <TableRow className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                        <TableHead>Désignation</TableHead>
                        <TableHead>Zone / chapitre</TableHead>
                        <TableHead>Progression</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {suiviLignesFiltered.map((row) => (
                        <TableRow key={row.id} className="border-t border-border">
                          <TableCell className="font-medium">{row.designation}</TableCell>
                          <TableCell>{row.chapitre_ou_zone ?? "—"}</TableCell>
                          <TableCell>
                            <Select
                              value={row.progression ?? "non_commence"}
                              onValueChange={(value) => updateProgression(row.id, value as Progression)}
                            >
                              <SelectTrigger className="w-44">
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                {(Object.keys(PROGRESSION_LABELS) as Progression[]).map((key) => (
                                  <SelectItem key={key} value={key}>
                                    {PROGRESSION_LABELS[key]}
                                  </SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </TabsContent>

        <TabsContent value="documents" className="mt-4">
          {loadingDocuments ? (
            <div className="flex justify-center py-10"><Loader2 className="size-5 animate-spin text-muted-foreground" /></div>
          ) : documents?.migrationPending || (documents?.rows.length ?? 0) === 0 ? (
            <EmptyState
              icon={FileSpreadsheet}
              title="Aucun document généré"
              description={
                documents?.migrationPending
                  ? "L'historique des PDF nécessite la migration 'documents' (voir supabase/migrations)."
                  : "Les PDF générés depuis la page de récapitulatif apparaîtront ici, avec un historique complet des versions."
              }
            />
          ) : (
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground">
                    <TableHead>Version</TableHead>
                    <TableHead>Date de génération</TableHead>
                    <TableHead>Statut</TableHead>
                    <TableHead className="text-right">Action</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {documents!.rows.map((doc, index) => (
                    <TableRow key={doc.id} className="border-t border-border">
                      <TableCell>v{doc.version}</TableCell>
                      <TableCell>{formatDate(doc.created_at)}</TableCell>
                      <TableCell>
                        <span
                          className={
                            index === 0
                              ? "inline-flex items-center rounded-full bg-success/15 px-2 py-0.5 text-[11px] font-medium text-success"
                              : "inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground"
                          }
                        >
                          {index === 0 ? "Actuelle" : "Ancienne"}
                        </span>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="sm" variant="outline" asChild>
                          <a href={doc.fichier_url} target="_blank" rel="noreferrer">
                            <Download className="size-4" />
                            Télécharger
                          </a>
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </TabsContent>
      </Tabs>

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer le lot "{pendingDelete?.lot}" ?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDelete?.nbLignes ?? 0} ligne{(pendingDelete?.nbLignes ?? 0) > 1 ? "s" : ""} seront
              supprimées définitivement, ainsi que les prix et matchs de catalogue associés. Cette action
              est irréversible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmDelete}>Supprimer</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function UploadForm({
  lotName,
  setLotName,
  uploading,
  fileInputRef,
  onFileSelected,
}: {
  lotName: string;
  setLotName: (v: string) => void;
  uploading: boolean;
  fileInputRef: React.RefObject<HTMLInputElement>;
  onFileSelected: (file: File) => void;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <div className="flex-1">
        <Label htmlFor="lot-name" className="mb-1.5 block text-xs text-muted-foreground">
          Nom du lot (ex. Gros Œuvre, Électricité, Fluides)
        </Label>
        <Input
          id="lot-name"
          value={lotName}
          onChange={(e) => setLotName(e.target.value)}
          placeholder="Nom du lot"
          disabled={uploading}
        />
      </div>
      <div>
        <input
          ref={fileInputRef}
          type="file"
          accept=".xls,.xlsx"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) onFileSelected(file);
          }}
        />
        <Button
          type="button"
          disabled={uploading}
          onClick={() => fileInputRef.current?.click()}
        >
          {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
          {uploading ? "Analyse en cours…" : "Importer un bordereau (.xls, .xlsx)"}
        </Button>
      </div>
    </div>
  );
}