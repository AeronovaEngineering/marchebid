-- supabase/migrations/202608100000000_activity_logs.sql
-- Backs the Journal d'activité page (src/routes/_authenticated/journal.tsx),
-- which already queries this table. Until this migration is applied,
-- logActivity() calls throughout the app will fail silently (they're
-- fire-and-forget) and the journal will stay empty.

create table if not exists public.activity_logs (
  id uuid primary key default gen_random_uuid(),
  -- References profiles.id (not auth.users.id directly) so that
  -- PostgREST's `profiles!user_id(email)` embedding used on the journal
  -- page works out of the box.
  user_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  details jsonb,
  created_at timestamptz not null default now()
);

create index if not exists activity_logs_created_at_idx
  on public.activity_logs (created_at desc);

create index if not exists activity_logs_entity_idx
  on public.activity_logs (entity_type, entity_id);

alter table public.activity_logs enable row level security;

-- Any authenticated member can write a log entry, but only as themselves.
-- (Server functions write via the service-role client and bypass RLS.)
create policy "activity_logs_insert_own"
  on public.activity_logs
  for insert
  to authenticated
  with check (auth.uid() = user_id);

-- Journal d'activité is an admin-only page (see AppShell nav), so reads
-- are restricted to admins via the existing has_role() helper.
create policy "activity_logs_select_admin"
  on public.activity_logs
  for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));