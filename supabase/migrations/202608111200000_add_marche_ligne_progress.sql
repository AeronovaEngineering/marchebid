-- Adds the missing progression column on marche_lignes that the Suivi tab
-- has been waiting on since early on. The UI already handles the missing
-- column gracefully (shows "migration requise" instead of crashing) --
-- this migration is what turns that into a working tab.

ALTER TABLE public.marche_lignes ADD COLUMN IF NOT EXISTS progression TEXT
  CHECK (progression IN ('non_commence', 'en_cours', 'termine'))
  DEFAULT 'non_commence';

COMMENT ON COLUMN public.marche_lignes.progression IS
  'Site-progress status shown on the Suivi tab: non_commence | en_cours | termine. Independent of bid_lignes.statut (pricing/confirmation), this tracks physical execution.';

-- Existing rows get the DEFAULT backfilled automatically by ADD COLUMN,
-- so no separate UPDATE is needed here.

-- ----------------------------------------------------------------------
-- Confirm the write-side RLS policy this depends on actually exists.
--
-- 202608110000001_marche_remplir.sql already created:
--   CREATE POLICY "marche_lignes_update" ON public.marche_lignes
--     FOR UPDATE USING (auth.uid() IS NOT NULL);
-- ...which covers Suivi's progression writes (any authenticated user,
-- same as every other write on this table) with no changes needed.
--
-- This block is just a defensive safety net in case that migration was
-- only partially applied to this environment -- it's a no-op if the
-- policy is already there, and creates it if it somehow isn't, so this
-- migration doesn't silently depend on a policy that may not exist.
-- ----------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'marche_lignes'
      AND policyname = 'marche_lignes_update'
  ) THEN
    CREATE POLICY "marche_lignes_update" ON public.marche_lignes
      FOR UPDATE USING (auth.uid() IS NOT NULL);
  END IF;
END $$;

-- Sanity check after applying: as a logged-in authenticated (non-admin)
-- user, opening the Suivi tab should no longer show "migration requise",
-- and changing a ligne's progression should persist without an RLS error.