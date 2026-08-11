import type { ReactNode } from "react";

/**
 * Shared list-page conventions
 * -----------------------------------------------------------------------
 * Layout: <PageHeader /> at the top of the page, then a <Card> containing
 * a search/filter bar followed by the data table (see catalogue.tsx for
 * the baseline table markup: rounded-lg border border-border bg-card
 * wrapper, thead bg-muted/50 text-xs uppercase tracking-wide
 * text-muted-foreground, px-4 py-3 cells, rows border-t border-border).
 *
 * Buttons: the primary action (create/confirm) uses the default variant,
 * destructive actions use the destructive variant, everything else
 * (secondary actions, filters, cancel) uses outline or ghost. Never apply
 * custom colors outside these variants.
 * -----------------------------------------------------------------------
 */
export function PageHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
          {title}
        </h1>
        {description && (
          <p className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {action && <div className="flex items-end gap-2">{action}</div>}
    </div>
  );
}