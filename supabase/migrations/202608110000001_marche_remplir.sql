-- Adds the missing write-side RLS policies on marches, marche_lignes, and
-- bid_lignes.
--
-- init_schema.sql only ever created a SELECT policy on each of these three
-- tables ("marches_read_all", "marche_lignes_read_all",
-- "bid_lignes_read_all") -- there was never an INSERT, UPDATE, or DELETE
-- policy. With RLS enabled and no permissive policy for a given command,
-- Postgres denies that command outright, regardless of GRANTs. That's why
-- 202608104000000_fix permissions.sql (GRANT ALL PRIVILEGES ...) didn't
-- fix the "new row violates row-level security policy" errors on
-- uploading a new bordereau or confirming a catalogue match: GRANT
-- controls whether a role may attempt the operation at all, RLS policies
-- separately control which rows it's allowed to touch once permitted --
-- fixing one layer without the other still blocks every INSERT/UPDATE
-- from the app. It's also why pre-seeded demo data (inserted by
-- migrations, which run with elevated privileges and bypass RLS entirely)
-- displays fine while nothing newly created by the app can be written.
--
-- marches/marche_lignes/bid_lignes are day-to-day work tables used by any
-- authenticated team member (not admin-only), matching how the existing
-- "*_read_all" policies on these tables are scoped to "any authenticated
-- user" rather than gated on is_admin(). DELETE on marches is the one
-- exception, kept admin-only since deleting a whole lot is destructive
-- and ties into the "delete lot" feature.

CREATE POLICY "marches_write" ON public.marches
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "marches_update" ON public.marches
  FOR UPDATE USING (auth.uid() IS NOT NULL);

CREATE POLICY "marches_admin_delete" ON public.marches
  FOR DELETE USING (public.is_admin(auth.uid()));

CREATE POLICY "marche_lignes_write" ON public.marche_lignes
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "marche_lignes_update" ON public.marche_lignes
  FOR UPDATE USING (auth.uid() IS NOT NULL);

CREATE POLICY "bid_lignes_write" ON public.bid_lignes
  FOR INSERT WITH CHECK (auth.uid() IS NOT NULL);

CREATE POLICY "bid_lignes_update" ON public.bid_lignes
  FOR UPDATE USING (auth.uid() IS NOT NULL);

-- Sanity check after applying: as a logged-in (non-admin) authenticated
-- user, uploading a new bordereau (INSERT into marches + marche_lignes)
-- and clicking "Choisir" on a catalogue match (UPDATE bid_lignes) should
-- both succeed. Deleting a lot as a non-admin should still fail.