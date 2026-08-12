-- ============================================================================
-- Chantiers statut: collapse to 5 values (brouillon, propose, en_cours,
-- termine, perdu) and add a Postgres trigger that keeps a chantier's statut
-- in sync with its marchés' RESULTATS (gagne/perdu/en_attente), not their
-- progression statut.
--
-- FIXES vs the previous version of this file:
--   1. chantiers.statut is a real Postgres ENUM type (chantier_statut), not
--      text+CHECK. The old script tried `update ... set statut = 'propose'`
--      before 'propose' existed in the enum, which Postgres rejects -- and
--      you can't ADD VALUE and use it in the same transaction anyway (db
--      push runs the whole file as one transaction). So instead of
--      ALTER TYPE ... ADD VALUE, this rebuilds the enum type outright.
--   2. The derived-status trigger now reads marches.RESULTAT
--      (en_attente/gagne/perdu -- see 202608120000000_marches_resultat.sql)
--      instead of marches.statut (en_cours/termine, which is bordereau
--      progress and has nothing to do with winning/losing). The old
--      version would have silently never fired on a real gagné/perdu, and
--      its `where statut = 'perdu'` filter would break against
--      marches.statut's own CHECK constraint.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Rebuild chantier_statut as an enum with the new 5-value vocabulary,
--    remapping old values as we go. Done as a type swap (not
--    ALTER TYPE ... ADD VALUE) so it's safe inside a single transaction.
--
--    'soumis' -> 'propose'   (straight rename, same meaning)
--    'gagne'  -> 'en_cours'  (NOT 'termine' -- winning a marché means the
--                             work starts, it doesn't mean the chantier is
--                             wrapped up; see DERIVED STATUS LOGIC below)
--    'brouillon', 'en_cours', 'perdu' pass through unchanged.
-- ----------------------------------------------------------------------------

-- Fail loudly on any value outside the expected OLD vocabulary, before
-- touching the type -- same intent as the original script's guard.
do $$
declare
  bad_count int;
begin
  select count(*) into bad_count
  from public.chantiers
  where statut::text not in ('brouillon', 'en_cours', 'soumis', 'gagne', 'perdu');

  if bad_count > 0 then
    raise exception
      'chantiers_statut_derivation: % row(s) in chantiers have a statut outside the expected old vocabulary -- inspect them manually before re-running this migration.',
      bad_count;
  end if;
end $$;

create type public.chantier_statut_new as enum
  ('brouillon', 'propose', 'en_cours', 'termine', 'perdu');

-- Drop the default first -- it's typed against the old enum and blocks
-- the column type change otherwise. Re-applied after the swap.
alter table public.chantiers alter column statut drop default;

alter table public.chantiers
  alter column statut type public.chantier_statut_new
  using (
    case statut::text
      when 'soumis' then 'propose'
      when 'gagne'  then 'en_cours'
      else statut::text
    end
  )::public.chantier_statut_new;

alter table public.chantiers alter column statut set default 'brouillon';

drop type public.chantier_statut;
alter type public.chantier_statut_new rename to chantier_statut;

-- ----------------------------------------------------------------------------
-- 2. Derived status trigger, driven by marches.RESULTAT.
--
-- Rules (only two auto-transitions -- everything else is manual-only):
--   a) chantier has >= 1 marché AND every one of them has resultat = 'perdu'
--        -> chantier.statut = 'perdu'
--   b) chantier has >= 1 marché with resultat = 'gagne'
--        -> chantier.statut = 'en_cours'
--
-- 'brouillon' and 'propose' are never *set* by this trigger -- they're the
-- pre-decision starting states, entered manually before any marché has
-- been won or all lost.
--
-- 'termine' is INTENTIONALLY not covered by any rule here -- no
-- unambiguous signal in the marchés data for "fully wrapped up"; stays a
-- manual, explicit action elsewhere in the app.
--
-- PRECEDENCE: as written, rules (a)/(b) are re-evaluated and applied on
-- every marché resultat change regardless of the chantier's CURRENT
-- statut -- including a chantier already manually marked 'termine'. If
-- 'termine' and/or 'perdu' should instead be sticky once reached, add
-- `and statut <> 'termine'` to the two UPDATE statements below.
-- ----------------------------------------------------------------------------
create or replace function public.recompute_chantier_statut(p_chantier_id uuid)
returns void
language plpgsql
as $$
declare
  v_total_marches int;
  v_all_perdu boolean;
  v_has_gagne boolean;
begin
  select
    count(*),
    count(*) filter (where resultat <> 'perdu') = 0,
    bool_or(resultat = 'gagne')
  into v_total_marches, v_all_perdu, v_has_gagne
  from public.marches
  where chantier_id = p_chantier_id;

  if v_total_marches = 0 then
    -- No marchés yet: nothing to derive from, leave statut exactly as the
    -- user set it (brouillon/propose/etc).
    return;
  end if;

  if v_all_perdu then
    update public.chantiers set statut = 'perdu' where id = p_chantier_id;
  elsif v_has_gagne then
    update public.chantiers set statut = 'en_cours' where id = p_chantier_id;
  end if;
  -- Any other mix (e.g. only en_attente, or en_attente+perdu with no
  -- gagne and not all perdu) matches neither rule -- statut untouched.
end;
$$;

create or replace function public.trg_marches_recompute_chantier_statut()
returns trigger
language plpgsql
as $$
begin
  perform public.recompute_chantier_statut(new.chantier_id);
  return new;
end;
$$;

drop trigger if exists marches_recompute_chantier_statut on public.marches;

create trigger marches_recompute_chantier_statut
  after insert or update of resultat on public.marches
  for each row
  execute function public.trg_marches_recompute_chantier_statut();

-- ----------------------------------------------------------------------------
-- 3. Backfill: apply the new derivation to every existing chantier once.
--    Safe to re-run.
-- ----------------------------------------------------------------------------
do $$
declare
  c record;
begin
  for c in select id from public.chantiers loop
    perform public.recompute_chantier_statut(c.id);
  end loop;
end $$;