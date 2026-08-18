import { useState } from "react";
import { History, ArrowUp, ArrowDown } from "lucide-react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDate, formatDinars } from "@/lib/format";
import { useCatalogueItemPriceHistory } from "@/hooks/useCatalogueItemPriceHistory";
import { cn } from "@/lib/utils";

/**
 * Discreet icon button + Dialog showing the price history of a
 * materiel_catalogue item (date, price, variation vs the previous entry).
 * Meant to be dropped next to the existing Edit2 button wherever a
 * catalogue item's price is shown or edited (catalogue.tsx grid + list
 * views, fournisseur.$id.tsx catalogue table).
 *
 * The history query only runs once the dialog is opened (not on mount),
 * so rendering this in a long list of rows doesn't fire a query per row.
 */
export function PriceHistoryDialog({
  materielCatalogueId,
  designation,
  buttonClassName,
  iconClassName,
}: {
  materielCatalogueId: string;
  designation?: string;
  buttonClassName?: string;
  iconClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const { data, isLoading } = useCatalogueItemPriceHistory(open ? materielCatalogueId : undefined);
  const rows = data?.rows ?? [];

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        title="Historique des prix"
        aria-label="Historique des prix"
        className={cn("h-8 w-8 p-0", buttonClassName)}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <History className={cn("size-4", iconClassName)} />
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-[420px]">
          <DialogHeader>
            <DialogTitle>Historique des prix</DialogTitle>
            <DialogDescription>
              {designation
                ? `Évolution du prix fournisseur pour "${designation}".`
                : "Évolution du prix fournisseur de cet article."}
            </DialogDescription>
          </DialogHeader>

          {isLoading ? (
            <div className="space-y-2 py-2">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Aucun historique de prix disponible pour cet article.
            </p>
          ) : (
            <ul className="max-h-80 space-y-1 overflow-y-auto py-1">
              {rows.map((entry, index) => {
                // rows is sorted newest first, so the previous (older)
                // price is the next entry in the array.
                const previous = rows[index + 1];
                const diff = previous ? entry.prix_fourniture - previous.prix_fourniture : 0;

                return (
                  <li
                    key={entry.id}
                    className="flex items-center justify-between rounded-md px-2 py-2 text-sm even:bg-muted/40"
                  >
                    <span className="text-muted-foreground">{formatDate(entry.date_effective)}</span>
                    <span className="flex items-center gap-1.5 font-mono tabular-nums">
                      {diff !== 0 &&
                        (diff > 0 ? (
                          <ArrowUp className="size-3.5 text-destructive" />
                        ) : (
                          <ArrowDown className="size-3.5 text-green-600" />
                        ))}
                      {formatDinars(entry.prix_fourniture)}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}