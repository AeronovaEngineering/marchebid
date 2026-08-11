// src/routes/_authenticated/profil.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { PageHeader } from "@/components/ui/pageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { logActivity } from "@/lib/Activitylog";

// ============================================================
// ROUTE
// ============================================================

export const Route = createFileRoute("/_authenticated/profil")({
  component: ProfilePage,
});

// ============================================================
// COMPONENT
// ============================================================

function ProfilePage() {
  const { data: user, isLoading: authLoading } = useCurrentUser();
  const queryClient = useQueryClient();
  const [fullName, setFullName] = useState("");
  const [savingProfile, setSavingProfile] = useState(false);
  const [pwd, setPwd] = useState({ next: "", confirm: "" });
  const [savingPwd, setSavingPwd] = useState(false);

  // ============================================================
  // QUERY - Profile
  // ============================================================

  const profileQ = useQuery({
    queryKey: ["my_profile", user?.id],
    enabled: !!user?.id,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("profiles")
        .select("nom, email")
        .eq("id", user!.id)
        .maybeSingle();

      if (error) throw error;
      return data;
    },
  });

  // ============================================================
  // EFFECT - Set full name from profile
  // ============================================================

  useEffect(() => {
    if (profileQ.data?.nom) {
      setFullName(profileQ.data.nom);
    }
  }, [profileQ.data]);

  // ============================================================
  // HANDLERS
  // ============================================================

  async function saveProfile(e: React.FormEvent) {
    e.preventDefault();
    if (!fullName.trim()) {
      toast.error("Le nom est requis");
      return;
    }

    setSavingProfile(true);
    try {
      // .select().maybeSingle() is what makes a silently RLS-blocked
      // UPDATE detectable: Postgrest's default behavior when RLS denies
      // an UPDATE (and no .select() is chained) is 200 OK + zero rows
      // affected, with `error` staying null — not a thrown error. That
      // silent-success shape is exactly what let this toast lie before:
      // the Supabase call "succeeded" even though nothing was written.
      const { data, error } = await supabase
        .from("profiles")
        .update({ nom: fullName.trim() })
        .eq("id", user!.id)
        .select("id, nom")
        .maybeSingle();

      if (error) throw error;
      if (!data) {
        throw new Error(
          "La mise à jour n'a pas été appliquée (droits insuffisants sur le profil).",
        );
      }

      void logActivity({
        action: "update",
        entity_type: "profile",
        entity_id: user!.id,
        details: { nom: fullName.trim() },
      });

      // "current-user" is the key useCurrentUser() (and thus AppShell's
      // sidebar/user menu) reads from — invalidate it so the new name
      // shows up immediately outside this page too.
      queryClient.invalidateQueries({ queryKey: ["current-user"] });
      queryClient.invalidateQueries({ queryKey: ["my_profile"] });
      queryClient.invalidateQueries({ queryKey: ["users_list"] });
      toast.success("Profil mis à jour");
    } catch (error: any) {
      toast.error(error.message || "Erreur lors de la mise à jour");
    } finally {
      setSavingProfile(false);
    }
  }

  async function changePassword(e: React.FormEvent) {
    e.preventDefault();

    if (pwd.next.length < 6) {
      toast.error("Le mot de passe doit contenir au moins 6 caractères");
      return;
    }

    if (pwd.next !== pwd.confirm) {
      toast.error("Les mots de passe ne correspondent pas");
      return;
    }

    setSavingPwd(true);
    try {
      const { error } = await supabase.auth.updateUser({
        password: pwd.next,
      });

      if (error) throw error;

      setPwd({ next: "", confirm: "" });
      toast.success("Mot de passe modifié");
    } catch (error: any) {
      toast.error(error.message || "Erreur lors du changement de mot de passe");
    } finally {
      setSavingPwd(false);
    }
  }

  // ============================================================
  // LOADING STATE
  // ============================================================

  if (authLoading || profileQ.isLoading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="p-8 text-center">
        <p className="text-muted-foreground">Veuillez vous connecter pour accéder à votre profil.</p>
      </div>
    );
  }

  // ============================================================
  // RENDER
  // ============================================================

  return (
    <>
      <PageHeader
        title="Mon profil"
        description="Gérez vos informations personnelles et votre mot de passe."
      />

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Profile Info */}
        <Card>
          <CardHeader>
            <CardTitle>Informations</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={saveProfile} className="space-y-4">
              <div className="space-y-1.5">
                <Label>Email</Label>
                <Input
                  value={user.email || ""}
                  disabled
                  className="bg-muted"
                />
              </div>

              <div className="space-y-1.5">
                <Label>Nom complet</Label>
                <Input
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Votre nom complet"
                />
              </div>

              <Button type="submit" disabled={savingProfile}>
                {savingProfile && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Enregistrer
              </Button>
            </form>
          </CardContent>
        </Card>

        {/* Change Password */}
        <Card>
          <CardHeader>
            <CardTitle>Changer le mot de passe</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={changePassword} className="space-y-4">
              <div className="space-y-1.5">
                <Label>Nouveau mot de passe</Label>
                <Input
                  type="password"
                  minLength={6}
                  value={pwd.next}
                  onChange={(e) => setPwd((p) => ({ ...p, next: e.target.value }))}
                  placeholder="Minimum 6 caractères"
                />
              </div>

              <div className="space-y-1.5">
                <Label>Confirmer</Label>
                <Input
                  type="password"
                  minLength={6}
                  value={pwd.confirm}
                  onChange={(e) => setPwd((p) => ({ ...p, confirm: e.target.value }))}
                  placeholder="Confirmez le mot de passe"
                />
              </div>

              <Button type="submit" disabled={savingPwd}>
                {savingPwd && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Modifier le mot de passe
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </>
  );
}