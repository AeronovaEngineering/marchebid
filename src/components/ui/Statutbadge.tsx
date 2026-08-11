import { cn } from "@/lib/utils";

const CHANTIER_LABELS: Record<string, { label: string; className: string }> = {
  brouillon: { label: "Brouillon", className: "bg-muted text-muted-foreground" },
  en_cours: { label: "En cours", className: "bg-warning/15 text-warning" },
  soumis: { label: "Soumis", className: "bg-primary/12 text-primary" },
  gagne: { label: "Gagné", className: "bg-success/15 text-success" },
  perdu: { label: "Perdu", className: "bg-destructive/12 text-destructive" },
};

const LIGNE_LABELS: Record<string, { label: string; className: string }> = {
  non_rempli: { label: "Non rempli", className: "bg-muted text-muted-foreground" },
  suggere: { label: "Suggéré", className: "bg-warning/15 text-warning" },
  verifie: { label: "Vérifié", className: "bg-success/15 text-success" },
  brouillon: { label: "Brouillon", className: "bg-muted text-muted-foreground" },
};

const CATALOGUE_LABELS: Record<string, { label: string; className: string }> = {
  brouillon: { label: "Brouillon", className: "bg-muted text-muted-foreground" },
  verifie: { label: "Vérifié", className: "bg-success/15 text-success" },
};

export function StatutBadge({
  statut,
  kind = "chantier",
}: {
  statut: string;
  kind?: "chantier" | "ligne" | "catalogue";
}) {
  const map =
    kind === "chantier" ? CHANTIER_LABELS : kind === "ligne" ? LIGNE_LABELS : CATALOGUE_LABELS;
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