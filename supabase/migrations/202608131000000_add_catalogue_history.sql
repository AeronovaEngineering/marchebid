-- Adds the missing created_at column on materiel_catalogue.
--
-- init_schema.sql gave every other core table a created_at column but
-- materiel_catalogue only ever got date_maj. The fournisseur detail page
-- needs to compare the two to decide whether to show a "Modifié le ..."
-- badge (date_maj != created_at means actually edited since creation).

ALTER TABLE public.materiel_catalogue
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now();

COMMENT ON COLUMN public.materiel_catalogue.created_at IS
  'When this row was first created. Compared against date_maj to detect edits since creation.';

-- Backfill: stamp existing rows with date_maj as the best approximation of
-- creation time (the real value was never captured). Rows never edited get
-- created_at == date_maj (correct, no badge). Rows already edited before
-- this migration also get created_at == date_maj and will look "unedited"
-- until their next save -- acceptable, we have no better data.
UPDATE public.materiel_catalogue
SET created_at = date_maj;
-- Adds quantite_realisee to marche_lignes for physical progress tracking.
--
-- marche_lignes.progression (non_commence/en_cours/termine) already exists
-- (202608111200000_add_marche_ligne_progress.sql) but only captures a
-- 3-state label, not a numeric value. The Suivi tab needs "30 out of 42 ml
-- installed" granularity, both for per-line display and for the per-lot
-- progress bar (sum(quantite_realisee) / sum(quantite) * 100).
--
-- NOT adding CHECK (quantite_realisee <= quantite): over-delivery is a
-- real site scenario (crew installs 10.5m against a 10m order due to
-- waste/adjustments). More importantly, if a bordereau quantite is later
-- corrected downward, that constraint would reject the correction if
-- quantite_realisee was already entered at the old value. Leave it out.

ALTER TABLE public.marche_lignes
  ADD COLUMN IF NOT EXISTS quantite_realisee NUMERIC DEFAULT 0
  CHECK (quantite_realisee >= 0);

COMMENT ON COLUMN public.marche_lignes.quantite_realisee IS
  'Physical quantity installed/completed on site. Editable inline on the Suivi tab. When it reaches quantite, progression is auto-set to termine by the UI.';

-- No backfill needed: DEFAULT 0 is the correct starting value for all
-- existing rows (nothing has been recorded yet).

-- Chapter-level and global discounts ("remises") for a marché's bordereau.
--
-- Chapters aren't their own DB rows (they're derived by grouping
-- marche_lignes on chapitre_ou_zone), so a chapter remise is keyed by
-- (marche_id, chapitre_ou_zone) text instead of a chapter_id FK.
-- The overall/global remise lives directly on marches, since there's
-- exactly one per marché.
--
-- Idempotent: safe to re-run.

create table if not exists public.marche_remises (
  id uuid primary key default gen_random_uuid(),
  marche_id uuid not null references public.marches(id) on delete cascade,
  chapitre_ou_zone text not null,
  type text not null check (type in ('pourcentage', 'montant')),
  valeur numeric not null check (valeur >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (marche_id, chapitre_ou_zone)
);

comment on table public.marche_remises is
  'Per-chapter discount applied to a marché''s bordereau. One row per
   (marche_id, chapitre_ou_zone) — chapters are a derived grouping, not a
   table, so this text pair is the join key instead of a chapter_id FK.
   A row disappearing means "no discount on this chapter", same as
   valeur = 0 would.';

alter table public.marches
  add column if not exists remise_globale_type text
    check (remise_globale_type in ('pourcentage', 'montant'));

alter table public.marches
  add column if not exists remise_globale_valeur numeric
    default 0 check (remise_globale_valeur >= 0);

comment on column public.marches.remise_globale_type is
  'Overall discount applied to the bordereau grand total, after all
   chapter-level remises have already been applied to their own chapter,
   and before TVA. Null type / 0 valeur = no global discount.';

-- RLS: same "any authenticated user can read/write" pattern already used
-- on marches itself — marche_remises follows the same trust model, not a
-- stricter one.
alter table public.marche_remises enable row level security;

drop policy if exists "marche_remises_select_authenticated" on public.marche_remises;
create policy "marche_remises_select_authenticated"
  on public.marche_remises for select
  using (auth.uid() is not null);

drop policy if exists "marche_remises_insert_authenticated" on public.marche_remises;
create policy "marche_remises_insert_authenticated"
  on public.marche_remises for insert
  with check (auth.uid() is not null);

drop policy if exists "marche_remises_update_authenticated" on public.marche_remises;
create policy "marche_remises_update_authenticated"
  on public.marche_remises for update
  using (auth.uid() is not null)
  with check (auth.uid() is not null);

drop policy if exists "marche_remises_delete_authenticated" on public.marche_remises;
create policy "marche_remises_delete_authenticated"
  on public.marche_remises for delete
  using (auth.uid() is not null);

-- Sanity check after applying:
--   1. `select * from marche_remises;` as an authenticated user should
--      return an empty set, not a permissions error.
--   2. `select remise_globale_type, remise_globale_valeur from marches
--       limit 1;` should return (null, 0) for existing rows, not error.
-- If either 403s, the RLS policies above didn't take effect — check the
-- migration actually ran against the right schema.

-- Reminder: after applying this migration, regenerate Supabase types
-- (e.g. `supabase gen types typescript`) so marche_remises and the two
-- new marches columns are properly typed. Until that's done, the app
-- code accesses them with the same `as never` / `as any` escape hatches
-- already used for the `documents` table elsewhere in this codebase.
