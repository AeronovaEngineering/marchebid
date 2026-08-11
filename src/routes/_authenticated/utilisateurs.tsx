// src/routes/_authenticated/utilisateurs.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { createUserServerFn, deleteUserServerFn } from "@/lib/server/manageUsers";
import { PageHeader } from "@/components/ui/pageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Lock, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

// ============================================================
// TYPES
// ============================================================

type AppRole = "admin" | "membre";

type UserRow = {
  id: string;
  email: string | null;
  nom: string | null;
  created_at: string | null;
  roles: AppRole[];
};

// ============================================================
// HELPERS (replacing missing lib files)
// ============================================================

async function createUserFn(data: {
  email: string;
  password: string;
  full_name: string;
  role: AppRole;
}) {
  // User creation touches supabase.auth.admin.createUser, which requires
  // the service role key. That call, plus the profile/role inserts, runs
  // server-side inside createUserServerFn — never in this client file.
  return createUserServerFn({ data });
}

async function setUserRoleFn(data: { user_id: string; role: AppRole }) {
  // Check if role exists
  const { data: existing, error: checkError } = await supabase
    .from("user_roles")
    .select("id")
    .eq("user_id", data.user_id)
    .single();

  if (checkError && checkError.code !== "PGRST116") {
    throw new Error(checkError.message);
  }

  if (existing) {
    // Update existing role
    const { error: updateError } = await supabase
      .from("user_roles")
      .update({ role: data.role })
      .eq("user_id", data.user_id);

    if (updateError) throw new Error(updateError.message);
  } else {
    // Insert new role
    const { error: insertError } = await supabase
      .from("user_roles")
      .insert({
        user_id: data.user_id,
        role: data.role,
      });

    if (insertError) throw new Error(insertError.message);
  }
}

async function deleteUserFn(data: { user_id: string }) {
  // Deletion also touches supabase.auth.admin.deleteUser, which requires
  // the service role key, so this runs server-side inside
  // deleteUserServerFn — never in this client file.
  return deleteUserServerFn({ data });
}

async function logActivityFn(
  action: string,
  type: string,
  userId: string | null,
  metadata: any
) {
  // Simple console log for now - you can implement a proper activity log table later
  console.log(`[${action}] ${type}`, { userId, ...metadata });
}

// ============================================================
// ROUTE
// ============================================================

export const Route = createFileRoute("/_authenticated/utilisateurs")({
  component: UsersPage,
});

// ============================================================
// COMPONENT
// ============================================================

function UsersPage() {
  const { data: currentUser, isLoading: authLoading } = useCurrentUser();
  const queryClient = useQueryClient();

  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    email: "",
    password: "",
    full_name: "",
    role: "membre" as AppRole,
  });
  const [toDelete, setToDelete] = useState<UserRow | null>(null);

  const isAdmin = currentUser?.role === "admin";

  // ============================================================
  // QUERIES
  // ============================================================

  const q = useQuery({
    queryKey: ["users_list"],
    enabled: isAdmin,
    queryFn: async (): Promise<UserRow[]> => {
      const [{ data: profiles }, { data: roles }] = await Promise.all([
        supabase.from("profiles").select("id,email,nom,created_at").order("created_at"),
        supabase.from("user_roles").select("user_id,role"),
      ]);

      const roleMap = new Map<string, AppRole[]>();
      (roles ?? []).forEach((r) => {
        const arr = roleMap.get(r.user_id) ?? [];
        arr.push(r.role as AppRole);
        roleMap.set(r.user_id, arr);
      });

      return (profiles ?? []).map((p) => ({
        ...p,
        roles: roleMap.get(p.id) ?? [],
      }));
    },
  });

  // ============================================================
  // MUTATIONS
  // ============================================================

  const createMutation = useMutation({
    mutationFn: createUserFn,
    onSuccess: () => {
      toast.success("Utilisateur créé");
      logActivityFn("create", "user", null, { email: form.email, role: form.role });
      setOpen(false);
      setForm({ email: "", password: "", full_name: "", role: "membre" });
      queryClient.invalidateQueries({ queryKey: ["users_list"] });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Erreur lors de la création");
    },
  });

  const setRoleMutation = useMutation({
    mutationFn: setUserRoleFn,
    onSuccess: () => {
      toast.success("Rôle mis à jour");
      queryClient.invalidateQueries({ queryKey: ["users_list"] });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Erreur lors de la mise à jour du rôle");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteUserFn,
    onSuccess: () => {
      toast.success("Utilisateur supprimé");
      logActivityFn("delete", "user", toDelete?.id || null, { email: toDelete?.email });
      setToDelete(null);
      queryClient.invalidateQueries({ queryKey: ["users_list"] });
    },
    onError: (error: Error) => {
      toast.error(error.message || "Erreur lors de la suppression");
    },
  });

  // ============================================================
  // HANDLERS
  // ============================================================

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.email || !form.password || !form.full_name) {
      toast.error("Tous les champs sont requis");
      return;
    }
    createMutation.mutate(form);
  };

  const changeRole = async (user: UserRow, role: AppRole) => {
    setRoleMutation.mutate({ user_id: user.id, role });
  };

  const confirmDelete = async () => {
    if (!toDelete) return;
    deleteMutation.mutate({ user_id: toDelete.id });
  };

  // ============================================================
  // LOADING / PERMISSION CHECK
  // ============================================================

  if (authLoading) {
    return (
      <div className="p-10 text-center">
        <Loader2 className="mx-auto h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Utilisateurs" />
        <Card>
          <CardContent className="p-10 text-center">
            <Lock className="mx-auto mb-3 h-10 w-10 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              Réservé aux administrateurs.
            </p>
          </CardContent>
        </Card>
      </>
    );
  }

  // ============================================================
  // RENDER
  // ============================================================

  return (
    <>
      <PageHeader
        title="Utilisateurs"
        description="Créez et gérez les comptes ayant accès à la plateforme."
        action={
          <Button onClick={() => setOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Nouvel utilisateur
          </Button>
        }
      />

      <Card>
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="p-3 text-left">Nom</th>
                  <th className="p-3 text-left">Email</th>
                  <th className="w-48 p-3 text-left">Rôle</th>
                  <th className="w-16 p-3 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {q.isLoading && (
                  <tr>
                    <td colSpan={4} className="p-8 text-center text-muted-foreground">
                      Chargement…
                    </td>
                  </tr>
                )}
                {(q.data ?? []).map((u) => (
                  <tr key={u.id} className="border-t border-border">
                    <td className="p-3 font-medium">
                      {u.nom ?? "—"}
                      {u.id === currentUser?.id && (
                        <Badge variant="outline" className="ml-2">
                          Vous
                        </Badge>
                      )}
                    </td>
                    <td className="p-3 text-muted-foreground">{u.email}</td>
                    <td className="p-3">
                      <Select
                        value={u.roles[0] ?? "membre"}
                        onValueChange={(v) => changeRole(u, v as AppRole)}
                        disabled={u.id === currentUser?.id}
                      >
                        <SelectTrigger className="h-8 w-44">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="admin">Administrateur</SelectItem>
                          <SelectItem value="membre">Membre</SelectItem>
                        </SelectContent>
                      </Select>
                    </td>
                    <td className="p-3 text-right">
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={u.id === currentUser?.id}
                        onClick={() => setToDelete(u)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </td>
                  </tr>
                ))}
                {q.data?.length === 0 && (
                  <tr>
                    <td colSpan={4} className="p-8 text-center text-muted-foreground">
                      Aucun utilisateur.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* Create Dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Nouvel utilisateur</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleCreate} className="space-y-4">
            <div className="space-y-2">
              <Label>Nom complet</Label>
              <Input
                required
                value={form.full_name}
                onChange={(e) => setForm((f) => ({ ...f, full_name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Email</Label>
              <Input
                type="email"
                required
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Mot de passe (min. 6)</Label>
              <Input
                type="password"
                minLength={6}
                required
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label>Rôle</Label>
              <Select
                value={form.role}
                onValueChange={(v) => setForm((f) => ({ ...f, role: v as AppRole }))}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="admin">Administrateur</SelectItem>
                  <SelectItem value="membre">Membre</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setOpen(false)}>
                Annuler
              </Button>
              <Button type="submit" disabled={createMutation.isPending}>
                {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Créer
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog
        open={!!toDelete}
        onOpenChange={(v) => !v && setToDelete(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer cet utilisateur ?</AlertDialogTitle>
            <AlertDialogDescription>
              Le compte « {toDelete?.email} » sera supprimé définitivement.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Suppression..." : "Supprimer"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}