// src/routes/_authenticated/dashboard.tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Building2, Clock, CheckCircle2, TrendingUp, Plus } from "lucide-react";
import { format } from "date-fns";
import { fr } from "date-fns/locale";

import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { PageHeader } from "@/components/ui/pageHeader";
import { StatutBadge } from "@/components/StatutBadge";
import { formatDinars } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/ui/Emptystate";

// ============================================================
// QUERIES
// ============================================================

const dashboardQuery = () => ({
  queryKey: ["dashboard-stats"],
  queryFn: async () => {
    // Fetch all chantiers with their stats
    const { data: chantiers, error: chantiersError } = await supabase
      .from("chantiers")
      .select(`
        id,
        nom,
        client,
        statut,
        created_at,
        created_by,
        marches (
          id,
          marche_lignes (
            id,
            bid_lignes (
              id,
              statut,
              prix_fourniture,
              prix_pose
            )
          )
        )
      `)
      .order("created_at", { ascending: false });

    if (chantiersError) throw chantiersError;

    // Calculate stats
    const totalChantiers = chantiers?.length || 0;
    const enCours = chantiers?.filter(c => c.statut === "en_cours").length || 0;
    const termines = chantiers?.filter(c => 
      c.statut === "gagne" || c.statut === "perdu"
    ).length || 0;

    // Calculate total chiffré (sum of all confirmed bid_lignes totals)
    // NOTE: bid_lignes is a one-to-one relation here (unique marche_ligne_id
    // on bid_lignes), so Supabase infers a single object, not an array —
    // there's exactly one (or zero) bid_ligne per marche_ligne.
    let montantTotal = 0;
    chantiers?.forEach(chantier => {
      chantier.marches?.forEach(marche => {
        marche.marche_lignes?.forEach(ligne => {
          const bid = ligne.bid_lignes;
          if (bid && bid.statut === "verifie") {
            montantTotal += (bid.prix_fourniture || 0) + (bid.prix_pose || 0);
          }
        });
      });
    });

    // Build chantier list with computed fields
    const chantierList = chantiers?.map(chantier => {
      let totalLignes = 0;
      let lignesConfirmees = 0;

      chantier.marches?.forEach(marche => {
        marche.marche_lignes?.forEach(ligne => {
          const bid = ligne.bid_lignes;
          if (bid) {
            totalLignes++;
            if (bid.statut === "verifie") lignesConfirmees++;
          }
        });
      });

      const tauxConfirmation = totalLignes > 0 
        ? Math.round((lignesConfirmees / totalLignes) * 100)
        : 0;

      return {
        id: chantier.id,
        nom: chantier.nom,
        client: chantier.client,
        statut: chantier.statut,
        created_at: chantier.created_at,
        tauxConfirmation,
        responsable: "—", // Will be populated from profiles if needed
      };
    }) || [];

    return {
      stats: {
        totalChantiers,
        enCours,
        termines,
        montantTotal,
      },
      chantiers: chantierList,
    };
  },
});

// ============================================================
// ROUTE
// ============================================================

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: DashboardComponent,
});

// ============================================================
// COMPONENTS
// ============================================================

function DashboardComponent() {
  const { data: user } = useCurrentUser();
  const { data, isLoading, error } = useQuery(dashboardQuery());

  if (error) {
    return (
      <div className="p-8 text-center">
        <p className="text-destructive">Erreur lors du chargement du tableau de bord</p>
        <p className="text-sm text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  const { stats, chantiers } = data || {
    stats: { totalChantiers: 0, enCours: 0, termines: 0, montantTotal: 0 },
    chantiers: [],
  };

  const hasChantiers = chantiers.length > 0;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Tableau de bord"
        description="Vue d'ensemble de votre activité chiffrage"
      />

      {/* Stat Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Building2}
          title="Total chantiers"
          value={isLoading ? undefined : stats.totalChantiers}
          isLoading={isLoading}
        />
        <StatCard
          icon={Clock}
          title="En cours"
          value={isLoading ? undefined : stats.enCours}
          isLoading={isLoading}
          className="border-warning/20 bg-warning/5"
        />
        <StatCard
          icon={CheckCircle2}
          title="Terminés"
          value={isLoading ? undefined : stats.termines}
          isLoading={isLoading}
          className="border-success/20 bg-success/5"
        />
        <StatCard
          icon={TrendingUp}
          title="Montant total chiffré"
          value={isLoading ? undefined : formatDinars(stats.montantTotal)}
          isLoading={isLoading}
          className="border-primary/20 bg-primary/5"
        />
      </div>

      {/* Chantiers List */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Chantiers récents</CardTitle>
          <Button asChild size="sm">
            <Link to="/chantiers">
              <Plus className="mr-1 size-4" />
              Nouveau chantier
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <ChantierTableSkeleton />
          ) : !hasChantiers ? (
            <EmptyState
              icon={Building2}
              title="Aucun chantier pour le moment"
              description="Commencez par créer votre premier chantier pour démarrer le chiffrage."
              action={
                <Button asChild>
                  <Link to="/chantiers">
                    <Plus className="mr-1 size-4" />
                    Créer un chantier
                  </Link>
                </Button>
              }
            />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Chantier</th>
                    <th className="px-4 py-3 font-medium">Responsable</th>
                    <th className="px-4 py-3 font-medium">Statut</th>
                    <th className="px-4 py-3 font-medium text-right">% Confirmées</th>
                    <th className="px-4 py-3 font-medium text-right">Dernière mise à jour</th>
                    <th className="px-4 py-3 font-medium text-right"></th>
                  </tr>
                </thead>
                <tbody>
                  {chantiers.map((chantier) => (
                    <tr
                      key={chantier.id}
                      className="border-t border-border transition-colors hover:bg-muted/30"
                    >
                      <td className="px-4 py-3 font-medium">
                        <Link
                          to="/chantiers/$id"
                          params={{ id: chantier.id }}
                          className="hover:underline"
                        >
                          {chantier.nom}
                        </Link>
                        {chantier.client && (
                          <span className="ml-2 text-xs text-muted-foreground">
                            {chantier.client}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {chantier.responsable}
                      </td>
                      <td className="px-4 py-3">
                        <StatutBadge statut={chantier.statut ?? "brouillon"} kind="chantier" />
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">
                        {chantier.tauxConfirmation}%
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">
                        {chantier.created_at
                          ? format(new Date(chantier.created_at), "dd MMM yyyy", { locale: fr })
                          : "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          asChild
                          variant="ghost"
                          size="sm"
                          className="h-8 px-3 text-xs"
                        >
                          <Link to="/chantiers/$id" params={{ id: chantier.id }}>
                            Voir
                          </Link>
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ============================================================
// HELPERS
// ============================================================

interface StatCardProps {
  icon: React.ElementType;
  title: string;
  value: string | number | undefined;
  isLoading: boolean;
  className?: string;
}

function StatCard({ icon: Icon, title, value, isLoading, className }: StatCardProps) {
  return (
    <Card className={cn("border", className)}>
      <CardContent className="flex items-start justify-between p-5">
        <div>
          <p className="text-sm font-medium text-muted-foreground">{title}</p>
          {isLoading ? (
            <Skeleton className="mt-1 h-8 w-20" />
          ) : (
            <p className="mt-1 text-2xl font-semibold tracking-tight">{value ?? 0}</p>
          )}
        </div>
        <div className="rounded-md bg-muted/50 p-2.5 text-muted-foreground">
          <Icon className="size-5" />
        </div>
      </CardContent>
    </Card>
  );
}

function ChantierTableSkeleton() {
  return (
    <div className="space-y-3">
      {/* Header */}
      <div className="flex items-center gap-4 border-b border-border pb-3">
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-4 w-20" />
        <Skeleton className="ml-auto h-4 w-16" />
        <Skeleton className="h-4 w-28" />
        <Skeleton className="h-4 w-12" />
      </div>
      {/* Rows */}
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 py-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-5 w-20" />
          <Skeleton className="ml-auto h-4 w-12" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-7 w-16" />
        </div>
      ))}
    </div>
  );
}