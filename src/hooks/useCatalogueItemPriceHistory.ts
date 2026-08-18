import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type PriceHistoryEntry = {
  id: string;
  prix_fourniture: number;
  date_effective: string;
};

// materiel_catalogue_historique_prix doesn't exist in the generated Supabase
// types until `supabase gen types typescript` is re-run after
// 202608140000000_materiel_catalogue_historique_prix.sql is applied -- same
// `as never` escape hatch already used for the `documents` table elsewhere
// (see useDocuments in chantiers.$id.index.tsx). If the migration hasn't
// been applied yet, this degrades to an empty list instead of crashing.
export function useCatalogueItemPriceHistory(materielCatalogueId: string | null | undefined) {
  return useQuery({
    queryKey: ["catalogue-item-price-history", materielCatalogueId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("materiel_catalogue_historique_prix" as never)
        .select("id, prix_fourniture, date_effective")
        .eq("materiel_catalogue_id", materielCatalogueId as string)
        .order("date_effective", { ascending: false });

      if (error) {
        return { rows: [] as PriceHistoryEntry[], migrationPending: true };
      }
      return { rows: (data ?? []) as unknown as PriceHistoryEntry[], migrationPending: false };
    },
    enabled: Boolean(materielCatalogueId),
  });
}