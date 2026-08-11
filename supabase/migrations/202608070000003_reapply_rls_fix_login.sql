-- ============================================================================
-- Ré-application forcée du correctif RLS (idempotent) + diagnostic.
-- Ne fait AUCUN mal si le correctif était déjà en place : tout est DROP IF
-- EXISTS puis CREATE, donc ce script est safe à relancer autant de fois
-- que nécessaire.
-- ============================================================================

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

DROP POLICY IF EXISTS "user_roles_read_own" ON public.user_roles;
CREATE POLICY "user_roles_read_own" ON public.user_roles
  FOR SELECT USING (user_id = auth.uid());

DROP POLICY IF EXISTS "user_roles_admin_read" ON public.user_roles;
CREATE POLICY "user_roles_admin_read" ON public.user_roles
  FOR SELECT USING (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "user_roles_admin_write" ON public.user_roles;
CREATE POLICY "user_roles_admin_write" ON public.user_roles
  FOR INSERT WITH CHECK (public.is_admin(auth.uid()));

DROP POLICY IF EXISTS "user_roles_admin_update" ON public.user_roles;
CREATE POLICY "user_roles_admin_update" ON public.user_roles
  FOR UPDATE USING (public.is_admin(auth.uid()));

-- ============================================================================
-- DIAGNOSTIC — regardez ce que ça renvoie et collez-le moi tel quel.
-- ============================================================================

-- 1. Les policies réellement actives sur user_roles, MAINTENANT.
SELECT policyname, cmd, qual, with_check
FROM pg_policies
WHERE tablename = 'user_roles'
ORDER BY policyname;

-- 2. Est-ce que la fonction is_admin existe bien et est SECURITY DEFINER ?
SELECT proname, prosecdef
FROM pg_proc
WHERE proname = 'is_admin';

-- 3. Le contenu RÉEL de user_roles, lu en tant que superuser (RLS n'a aucun
--    effet ici, donc ceci montre la vérité brute quel que soit votre user
--    de connexion) — si votre compte admin n'apparaît pas ici du tout,
--    le problème n'est PAS RLS, c'est que la ligne n'a jamais été insérée.
SELECT ur.user_id, ur.role, p.email
FROM public.user_roles ur
LEFT JOIN public.profiles p ON p.id = ur.user_id
ORDER BY p.email;