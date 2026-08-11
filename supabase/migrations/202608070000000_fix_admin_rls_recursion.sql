-- Fixes a self-referential RLS policy on public.user_roles.
--
-- Bug: user_roles_admin_read/write/update all check
--   EXISTS(SELECT 1 FROM public.user_roles WHERE user_id = auth.uid() AND role = 'admin')
-- ...as their own USING/WITH CHECK clause. That inner SELECT is itself
-- subject to the very same RLS policy, so it can never see ANY row --
-- including the querying user's own row -- to prove they're admin. Net
-- effect: nobody, including real admins, can ever read their own role row,
-- so the app always falls back to 'membre', and every other table's
-- admin-only write policy (which does the same EXISTS check against
-- user_roles) is silently broken too.
--
-- Fix, the standard Supabase-documented pattern: a SECURITY DEFINER helper
-- function bypasses RLS for its own internal lookup, breaking the
-- circularity, and an explicit "read own row" policy gives every user an
-- unconditional base case to check their own role without needing is_admin.

CREATE OR REPLACE FUNCTION public.is_admin(_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = 'admin'
  )
$$;

-- Let every authenticated user read their own role row unconditionally.
-- This alone is what breaks the recursion for every EXISTS(...auth.uid()...)
-- check elsewhere in the schema, since those only ever check the current
-- user's own row.
DROP POLICY IF EXISTS "user_roles_read_own" ON public.user_roles;
CREATE POLICY "user_roles_read_own" ON public.user_roles
  FOR SELECT USING (user_id = auth.uid());

-- Recreate the admin-wide policies on is_admin() so admins can also read/
-- manage OTHER users' role rows (needed for the Utilisateurs page), without
-- reintroducing the recursive inline EXISTS.
DROP POLICY IF EXISTS "user_roles_admin_read" ON public.user_roles;
CREATE POLICY "user_roles_admin_read" ON public.user_roles
  FOR SELECT USING (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "user_roles_admin_write" ON public.user_roles;
CREATE POLICY "user_roles_admin_write" ON public.user_roles
  FOR INSERT WITH CHECK (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "user_roles_admin_update" ON public.user_roles;
CREATE POLICY "user_roles_admin_update" ON public.user_roles
  FOR UPDATE USING (public.is_admin(auth.uid()));

-- Sanity check after applying: run as an actual admin user (via the app,
-- or `select * from user_roles where user_id = auth.uid()` in the SQL
-- editor while impersonating that user) and confirm the row comes back.
