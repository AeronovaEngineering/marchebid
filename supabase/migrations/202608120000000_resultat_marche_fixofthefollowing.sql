-- Adds a win/loss result to marches, separate from the existing
-- marches.statut (en_cours/termine, which tracks bordereau-filling
-- progress and gates PDF regeneration — see
-- 202608060000000_progression_statut_documents.sql).
--
-- marches.resultat: en_attente (default) -> gagne | perdu, one-way door.
-- Once gagne/perdu, a marché can never go back to en_attente (checked by
-- the trigger below). gagne <-> perdu switches are allowed.

alter table public.marches
  add column if not exists resultat text not null default 'en_attente';

alter table public.marches
  drop constraint if exists marches_resultat_check;

alter table public.marches
  add constraint marches_resultat_check
  check (resultat in ('en_attente', 'gagne', 'perdu'));

create or replace function public.marches_resultat_one_way()
returns trigger
language plpgsql
as $$
begin
  if old.resultat in ('gagne', 'perdu') and new.resultat = 'en_attente' then
    raise exception
      'Le résultat du marché "%" est déjà fixé (%) : retour à en_attente impossible.',
      old.lot, old.resultat;
  end if;
  return new;
end;
$$;

drop trigger if exists marches_resultat_one_way_trg on public.marches;

create trigger marches_resultat_one_way_trg
  before update on public.marches
  for each row
  when (old.resultat is distinct from new.resultat)
  execute function public.marches_resultat_one_way();