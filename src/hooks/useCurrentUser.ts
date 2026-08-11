import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type AppRole = "admin" | "membre";

export function useCurrentUser() {
  return useQuery({
    queryKey: ["current-user"],
    queryFn: async () => {
      const { data } = await supabase.auth.getUser();
      const user = data.user;
      if (!user) return null;
      const [{ data: profile }, { data: roles }] = await Promise.all([
        supabase.from("profiles").select("*").eq("id", user.id).maybeSingle(),
        supabase.from("user_roles").select("role").eq("user_id", user.id),
      ]);
      const role: AppRole = roles?.some((r) => r.role === "admin") ? "admin" : "membre";
      return { id: user.id, email: user.email ?? "", profile, role };
    },
    staleTime: 60_000,
  });
}

export function useIsAdmin() {
  const { data } = useCurrentUser();
  return data?.role === "admin";
}
