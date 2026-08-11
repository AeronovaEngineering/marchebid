// src/routes/_authenticated/journal.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/ui/pageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/format";

// ============================================================
// CONSTANTS
// ============================================================

const ACTION_LABELS: Record<string, string> = {
  login: "Connexion",
  logout: "Déconnexion",
  signup: "Inscription",
  create: "Création",
  update: "Modification",
  delete: "Suppression",
  validate: "Validation",
  cancel: "Annulation",
  convert: "Conversion",
  payment: "Paiement",
};

// ============================================================
// TYPES
// ============================================================

type ActivityLog = {
  id: string;
  user_id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  details: Record<string, any> | null;
  created_at: string;
  user_email?: string;
};

// ============================================================
// ROUTE
// ============================================================

export const Route = createFileRoute("/_authenticated/journal")({
  component: LogsPage,
});

// ============================================================
// COMPONENT
// ============================================================

function LogsPage() {
  // requires supabase/migrations/202608100000000_activity_logs.sql — until
  // that migration is applied and types.ts regenerated, this query will
  // fail (the `as never` casts below suppress the type error, not the
  // runtime one) and the table below will show its error/empty state.
  const q = useQuery({
    queryKey: ["activity_logs"],
    queryFn: async (): Promise<ActivityLog[]> => {
      const { data, error } = await supabase
        .from("activity_logs" as never)
        .select(`
          *,
          profiles!user_id (email)
        `)
        .order("created_at", { ascending: false })
        .limit(200);

      if (error) throw error;
      return (data ?? []).map((log: any) => ({
        ...log,
        user_email: log.profiles?.email ?? null,
      }));
    },
  });

  const logs = q.data || [];

  return (
    <>
      <PageHeader
        title="Journal d'activité"
        description="Historique des actions (200 dernières)."
      />

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="p-3 text-left">Date</th>
                  <th className="p-3 text-left">Utilisateur</th>
                  <th className="p-3 text-left">Action</th>
                  <th className="p-3 text-left">Entité</th>
                  <th className="p-3 text-left">Détails</th>
                </tr>
              </thead>
              <tbody>
                {q.isLoading && (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-muted-foreground">
                      Chargement...
                    </td>
                  </tr>
                )}

                {q.isError && (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-destructive">
                      Erreur lors du chargement du journal. La table
                      "activity_logs" a-t-elle été migrée ?
                    </td>
                  </tr>
                )}

                {!q.isLoading && !q.isError && logs.length === 0 && (
                  <tr>
                    <td colSpan={5} className="p-8 text-center text-muted-foreground">
                      Aucun événement enregistré.
                    </td>
                  </tr>
                )}

                {!q.isLoading && logs.map((log) => (
                  <tr key={log.id} className="border-t border-border">
                    <td className="whitespace-nowrap p-3 text-muted-foreground">
                      {formatDate(log.created_at)}
                    </td>
                    <td className="p-3">{log.user_email ?? "—"}</td>
                    <td className="p-3">
                      <Badge variant="outline">
                        {ACTION_LABELS[log.action] ?? log.action}
                      </Badge>
                    </td>
                    <td className="p-3 text-muted-foreground">
                      {log.entity_type ?? "—"}
                    </td>
                    <td className="p-3 text-muted-foreground">
                      {log.details ? JSON.stringify(log.details) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </>
  );
}