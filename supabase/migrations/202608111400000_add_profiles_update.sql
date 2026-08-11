-- Adds the missing UPDATE RLS policy on public.profiles, allowing a user
-- to update their own profile row.
--
-- Same class of bug as 202608110000001_marche_remplir.sql: profiles only
-- ever had a SELECT policy from init_schema (needed for the profile
-- lookups/joins used across the app), never an UPDATE policy. With RLS
-- enabled and no permissive UPDATE policy, Postgres denies the UPDATE --
-- but critically, when the client doesn't chain .select() after .update(),
-- Postgrest's response for a blocked UPDATE is 200 OK with zero rows
-- affected and NO error, not a visible failure. That's exactly why "Mon
-- profil" showed a success toast while nothing was actually written: the
-- supabase-js call itself never threw. (The profil.tsx save handler has
-- also been updated to chain .select().maybeSingle() and treat a null
-- result as a failure, so this class of silent failure gets caught even
-- if a future RLS gap reintroduces it.)
--
-- Scoped to the user's own row only (id = auth.uid()) -- nobody should be
-- able to update someone else's profile through this policy. An
-- admin-side "edit any user's profile" feature, if one ever gets added,
-- needs its own admin-gated policy or a server function on the
-- service-role client -- not this one.

CREATE POLICY "profiles_update_own" ON public.profiles
  FOR UPDATE USING (id = auth.uid());

-- Sanity check after applying: as a logged-in user, changing your name on
-- /profil should now actually persist -- verify with
-- `select nom from public.profiles where id = '<your-user-id>'` in the
-- SQL editor after saving, and confirm the sidebar/user menu picks up the
-- new name without a page reload.
-- Adds the missing admin-wide SELECT policy on public.profiles.
--
-- profiles has never had a policy letting an admin read rows other than
-- their own -- the only SELECT policy it's ever had (from init_schema,
-- predating every migration in this repo) is scoped to "own row only",
-- same shape user_roles had before 202608070000000_fix_admin_rls_recursion
-- fixed it there. Nobody ever did the equivalent fix for profiles.
--
-- That's a silent filter, not an error: /utilisateurs' list query
-- (`supabase.from("profiles").select(...)`, no .eq filter in the app code
-- at all) runs fine and returns 200 OK -- RLS just quietly drops every row
-- except the querying admin's own, so the table always renders exactly
-- one user no matter how many accounts actually exist. New users being
-- created successfully (service-role client, bypasses RLS) but never
-- showing up in the list -- even after a hard reload -- is exactly this
-- symptom.
--
-- Reuses the same public.is_admin() SECURITY DEFINER helper already
-- established for user_roles, so this doesn't reintroduce the recursion
-- bug that helper exists to avoid. `OR id = auth.uid()` keeps the
-- existing "read own row" behavior working for non-admins even if this
-- policy is the only one ever created (Postgres permissive policies are
-- OR'd together, so this is additive/safe alongside any pre-existing own-
-- row policy either way).

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'profiles'
      AND policyname = 'profiles_admin_read_all'
  ) THEN
    CREATE POLICY "profiles_admin_read_all" ON public.profiles
      FOR SELECT USING (public.is_admin(auth.uid()) OR id = auth.uid());
  END IF;
END $$;

-- Sanity check after applying: as an admin, /utilisateurs should list
-- every account, not just your own -- verify with
-- `select count(*) from public.profiles` in the SQL editor (superuser,
-- bypasses RLS, shows ground truth) vs. what the page actually renders
-- while logged in as that admin. As a non-admin member, you should still
-- only ever see your own row.