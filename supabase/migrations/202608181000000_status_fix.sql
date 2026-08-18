-- Makes a chantier's 'termine' statut sticky against the auto-derivation
-- trigger from 202608120900000_chantiers_statut.sql.
--
-- BUG: recompute_chantier_statut() re-evaluates and applies its two rules
-- on every marché resultat change regardless of the chantier's CURRENT
-- statut -- including a chantier a user already manually marked 'termine'.
-- If a marché's resultat is later changed (e.g. someone corrects a result
-- after the fact), the trigger can silently flip a 'termine' chantier back
-- to 'en_cours' or 'perdu' with no user action -- which looks exactly like
-- "I pick a statut in the dropdown and it doesn't stick". That migration's
-- own comment already flagged this exact fix (see its "PRECEDENCE" note).
--
-- DECISION: only guard 'termine', not 'perdu'/'propose'/'brouillon' too.
-- 'perdu' and 'en_cours' are themselves the two values this trigger
-- derives in the first place (rules a/b below) -- re-deriving them when
-- the underlying marché results change is the trigger doing its job, not
-- overwriting a manual choice. 'brouillon' and 'propose' were already
-- never touched by this trigger (see the original migration's comment:
-- "never *set* by this trigger -- they're the pre-decision starting
-- states"). 'termine' is the one value that migration explicitly
-- documents as "INTENTIONALLY not covered by any rule here... stays a
-- manual, explicit action" -- so it's the only one that should never be
-- silently overwritten once reached. If the product later wants 'perdu'
-- to also be sticky (a chantier marked lost should never auto-reopen even
-- if a marché result is corrected), add `and statut <> 'perdu'` to the
-- v_has_gagne branch below in a follow-up migration.

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
    update public.chantiers set statut = 'perdu' where id = p_chantier_id and statut <> 'termine';
  elsif v_has_gagne then
    update public.chantiers set statut = 'en_cours' where id = p_chantier_id and statut <> 'termine';
  end if;
  -- Any other mix (e.g. only en_attente, or en_attente+perdu with no
  -- gagne and not all perdu) matches neither rule -- statut untouched.
end;
$$;

-- No trigger/backfill changes needed: trg_marches_recompute_chantier_statut
-- already calls this function, and CREATE OR REPLACE FUNCTION takes effect
-- immediately for all existing callers -- nothing to re-wire.

-- Sanity check after applying:
--   1. Manually set a chantier to 'termine', then flip one of its
--      marchés' resultat to 'perdu' (making all its marchés perdu) or
--      'gagne' -- the chantier should stay 'termine' in both cases.
--   2. A chantier NOT at 'termine' should still auto-derive to
--      'perdu'/'en_cours' exactly as before this migration.