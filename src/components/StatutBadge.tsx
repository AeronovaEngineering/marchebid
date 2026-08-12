import { cn } from "@/lib/utils";

// Matches the chantiers.statut CHECK constraint added in
// supabase/migrations/20260812090000_chantiers_statut_derivation.sql.
// en_cours and perdu are (usually) auto-derived from the chantier's
// marchés by a DB trigger -- see that migration for the derivation rules.
// brouillon, propose, and termine are manual-only.
const CHANTIER_LABELS: Record<string, { label: string; className: string }> = {
  brouillon: { label: "Brouillon", className: "bg-muted text-muted-foreground" },
  propose: { label: "Proposé", className: "bg-primary/12 text-primary" },
  en_cours: { label: "En cours", className: "bg-accent text-accent-foreground" },
  termine: { label: "Terminé", className: "bg-success/15 text-success" },
  perdu: { label: "Perdu", className: "bg-destructive/12 text-destructive" },
};

const LIGNE_LABELS: Record<string, { label: string; className: string }> = {
  non_rempli: { label: "Non rempli", className: "bg-muted text-muted-foreground" },
  suggere: { label: "Suggéré", className: "bg-warning/20 text-warning-foreground" },
  verifie: { label: "Vérifié", className: "bg-success/15 text-success" },
  brouillon: { label: "Brouillon", className: "bg-muted text-muted-foreground" },
};

export function StatutBadge({
  statut,
  kind = "chantier",
}: {
  statut: string;
  kind?: "chantier" | "ligne" | "catalogue";
}) {
  const map = kind === "chantier" ? CHANTIER_LABELS : LIGNE_LABELS;
  const entry = map[statut] ?? { label: statut, className: "bg-muted text-muted-foreground" };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        entry.className,
      )}
    >
      {entry.label}
    </span>
  );
}