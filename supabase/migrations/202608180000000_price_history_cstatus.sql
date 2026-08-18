-- Adds a real price-history table for materiel_catalogue, captured at the
-- database level via a trigger.
--
-- WHY A TRIGGER (not app-code inserts): prix_fourniture is changed from 3
-- different places in the frontend (catalogue.tsx create+edit dialog,
-- fournisseur.$id.tsx inline row edit, and Catalogueimportpanel.tsx bulk
-- CSV/Excel import via src/lib/catalogueImport.ts). Capturing history in
-- each screen separately means it's guaranteed to be forgotten in one of
-- them eventually. A trigger on materiel_catalogue itself fires no matter
-- which code path performed the INSERT/UPDATE, including the bulk import.
--
-- NOTE: 202608131000000_add_catalogue_history.sql has "history" in its
-- name but only adds materiel_catalogue.created_at (used for the "Modifié
-- le ..." badge on fournisseur.$id.tsx). It never created a price-history
-- table -- this migration is the first one that actually does.

-- ----------------------------------------------------------------------------
-- 1. History table
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.materiel_catalogue_historique_prix (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  materiel_catalogue_id UUID NOT NULL
    REFERENCES public.materiel_catalogue(id) ON DELETE CASCADE,
  prix_fourniture NUMERIC(10, 2) NOT NULL,
  date_effective TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL
);

COMMENT ON TABLE public.materiel_catalogue_historique_prix IS
  'One row per price a materiel_catalogue item has ever had, oldest to newest. Populated exclusively by the trg_materiel_catalogue_historique_prix trigger below -- never insert into this table directly from application code.';
COMMENT ON COLUMN public.materiel_catalogue_historique_prix.date_effective IS
  'When this price became active: created_at for the first row, now() at the time of the update for every subsequent row.';
COMMENT ON COLUMN public.materiel_catalogue_historique_prix.created_by IS
  'auth.uid() of whoever made the change, if the change happened in an authenticated request. Null for changes with no session (e.g. this migration''s own backfill).';

CREATE INDEX IF NOT EXISTS idx_materiel_catalogue_historique_prix_item
  ON public.materiel_catalogue_historique_prix(materiel_catalogue_id, date_effective DESC);

-- ----------------------------------------------------------------------------
-- 2. Trigger function + trigger
--
-- SECURITY DEFINER: the trigger must be able to insert into the history
-- table regardless of who is editing the catalogue (any authenticated
-- user, per materiel_catalogue's own RLS policies), even though the
-- history table itself only grants authenticated users SELECT below.
-- Without SECURITY DEFINER, a plain INSERT/UPDATE on materiel_catalogue
-- would fail with an RLS violation on materiel_catalogue_historique_prix
-- the moment a non-owner role tried to price-edit an item.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.fn_materiel_catalogue_historique_prix()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    -- New article: record its starting price, dated at its creation time.
    INSERT INTO public.materiel_catalogue_historique_prix
      (materiel_catalogue_id, prix_fourniture, date_effective, created_by)
    VALUES
      (NEW.id, NEW.prix_fourniture, NEW.created_at, auth.uid());

  ELSIF TG_OP = 'UPDATE' AND NEW.prix_fourniture IS DISTINCT FROM OLD.prix_fourniture THEN
    -- Existing article, price actually changed (the column trigger fires
    -- on any UPDATE that sets prix_fourniture, even to the same value --
    -- every save from the UI does -- so this guard is what prevents a
    -- no-op edit from creating a spurious history row).
    INSERT INTO public.materiel_catalogue_historique_prix
      (materiel_catalogue_id, prix_fourniture, date_effective, created_by)
    VALUES
      (NEW.id, NEW.prix_fourniture, now(), auth.uid());
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.fn_materiel_catalogue_historique_prix() IS
  'Appends a row to materiel_catalogue_historique_prix whenever a materiel_catalogue row is created or has its prix_fourniture changed. SECURITY DEFINER so it can write regardless of the caller''s own RLS grants on the history table.';

DROP TRIGGER IF EXISTS trg_materiel_catalogue_historique_prix ON public.materiel_catalogue;

CREATE TRIGGER trg_materiel_catalogue_historique_prix
  AFTER INSERT OR UPDATE OF prix_fourniture ON public.materiel_catalogue
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_materiel_catalogue_historique_prix();

-- ----------------------------------------------------------------------------
-- 3. Backfill
--
-- Existing articles never went through the trigger, so they'd otherwise
-- show an empty history despite having a real (current) price. Give each
-- of them a single starting entry using their current price and date_maj
-- (same "best approximation we have" reasoning add_catalogue_history used
-- for created_at -- there's no earlier price to recover).
--
-- Guarded with NOT EXISTS so this migration stays safe to re-run and
-- won't double-insert for rows the trigger has since populated.
-- ----------------------------------------------------------------------------

INSERT INTO public.materiel_catalogue_historique_prix
  (materiel_catalogue_id, prix_fourniture, date_effective, created_by)
SELECT mc.id, mc.prix_fourniture, mc.date_maj, NULL
FROM public.materiel_catalogue mc
WHERE NOT EXISTS (
  SELECT 1
  FROM public.materiel_catalogue_historique_prix h
  WHERE h.materiel_catalogue_id = mc.id
);

-- ----------------------------------------------------------------------------
-- 4. RLS
--
-- Read-only policy for authenticated users, same trust model as the rest
-- of the project (e.g. marche_remises in 202608131000000_add_catalogue_history.sql:
-- "any authenticated user can read"). Deliberately NOT mirroring that
-- table's insert/update/delete policies here: this table has exactly one
-- writer, the SECURITY DEFINER trigger above, and should never be written
-- to directly from client code -- so no insert/update/delete policy is
-- added at all (RLS default-denies those, which is what we want).
-- ----------------------------------------------------------------------------

ALTER TABLE public.materiel_catalogue_historique_prix ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "materiel_catalogue_historique_prix_read_all" ON public.materiel_catalogue_historique_prix;
CREATE POLICY "materiel_catalogue_historique_prix_read_all"
  ON public.materiel_catalogue_historique_prix FOR SELECT
  USING (auth.uid() IS NOT NULL);

-- Sanity check after applying:
--   1. Create a catalogue article, then update its prix_fourniture 2-3
--      times -- `select * from materiel_catalogue_historique_prix where
--      materiel_catalogue_id = '<id>' order by date_effective desc;`
--      should show one row per price, newest first.
--   2. An update that does NOT touch prix_fourniture (e.g. only renaming
--      an article) must NOT add a new history row.
--   3. `select count(*) from materiel_catalogue_historique_prix;` right
--      after this migration runs should be >= the row count of
--      materiel_catalogue (the backfill).

-- Reminder: after applying this migration, regenerate Supabase types
-- (e.g. `supabase gen types typescript`) so materiel_catalogue_historique_prix
-- is properly typed. Until that's done, the frontend accesses it with the
-- same `as never` / `as any` escape hatch already used for the
-- `documents` table elsewhere in this codebase (see chantiers.$id.index.tsx).