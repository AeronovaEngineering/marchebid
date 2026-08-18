-- Adds the missing UPDATE policy on chantiers.
--
-- ROOT CAUSE of "the statut dropdown changes but reverts when I leave the
-- page": init_schema.sql only ever gave chantiers a SELECT policy
-- ("chantiers_read_all") plus admin-only INSERT/DELETE ("chantiers_admin_write",
-- "chantiers_admin_delete") -- there has never been an UPDATE policy on
-- this table. With RLS enabled and no permissive policy for a given
-- command, Postgres silently returns 0 rows affected for that command
-- instead of raising a permission error -- so
-- `supabase.from("chantiers").update({ statut: value })` in
-- chantiers.$id.index.tsx "succeeds" (no error, no toast), the optimistic
-- UI update makes it LOOK saved, but the row in the database never
-- actually changes. Navigating away and back re-fetches the real,
-- untouched row, which is why it looks reverted.
--
-- This is the exact same class of bug already diagnosed and fixed once
-- for marches/marche_lignes/bid_lignes in 202608110000001_marche_remplir.sql
-- -- it just never got applied to chantiers.
--
-- SCOPE: any authenticated user, not admin-only. The chantier statut
-- dropdown in chantiers.$id.index.tsx has no admin/role gating in the UI
-- (unlike, say, materiel_catalogue's admin-only write/update) -- it's
-- meant to be a day-to-day action for any team member, same trust level
-- as chantiers_read_all and as the marches_update precedent above. Not
-- touching INSERT/DELETE here: those stay admin-only exactly as before.

CREATE POLICY "chantiers_update" ON public.chantiers
  FOR UPDATE USING (auth.uid() IS NOT NULL);

-- Sanity check after applying: change a chantier's statut via the
-- dropdown, navigate to another page, come back -- it should now stick.