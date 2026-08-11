// src/routes/_authenticated/fournisseur.index.tsx
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Search, Plus, Building2, X, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/ui/pageHeader";
import { EmptyState } from "@/components/ui/Emptystate";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";

// ============================================================
// SCHEMA
// ============================================================

const createFournisseurSchema = z.object({
  nom: z.string().min(1, "Le nom est requis"),
  contact: z.string().optional(),
  telephone: z.string().optional(),
  email: z.string().email("Email invalide").optional().or(z.literal("")),
  notes: z.string().optional(),
});

type CreateFournisseurForm = z.infer<typeof createFournisseurSchema>;

// ============================================================
// QUERIES
// ============================================================

const fournisseursQuery = () => ({
  queryKey: ["fournisseurs-list"],
  queryFn: async () => {
    const { data, error } = await supabase
      .from("fournisseurs")
      .select("*")
      .order("nom", { ascending: true });

    if (error) throw error;
    return data || [];
  },
});

// ============================================================
// ROUTE
// ============================================================

export const Route = createFileRoute("/_authenticated/fournisseur/")({
  component: FournisseurIndexComponent,
});

// ============================================================
// COMPONENT
// ============================================================

function FournisseurIndexComponent() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchQuery, setSearchQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; nom: string } | null>(null);

  const { data: fournisseurs, isLoading, error } = useQuery(fournisseursQuery());

  const filteredFournisseurs = fournisseurs?.filter(f =>
  f.nom.toLowerCase().includes(searchQuery.toLowerCase()) ||
  (f.contact?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false)
) || [];

  const hasFournisseurs = filteredFournisseurs.length > 0;

  // ============================================================
  // CREATE MUTATION
  // ============================================================

  const form = useForm<CreateFournisseurForm>({
    resolver: zodResolver(createFournisseurSchema),
    defaultValues: {
      nom: "",
      contact: "",
      telephone: "",
      email: "",
      notes: "",
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: CreateFournisseurForm) => {
      const { data: newFournisseur, error } = await supabase
        .from("fournisseurs")
        .insert({
          nom: data.nom,
          contact: data.contact || null,
          telephone: data.telephone || null,
          email: data.email || null,
          notes: data.notes || null,
        })
        .select()
        .single();

      if (error) throw error;
      return newFournisseur;
    },
    onSuccess: (newFournisseur) => {
      toast.success("Fournisseur créé avec succès");
      queryClient.invalidateQueries({ queryKey: ["fournisseurs-list"] });
      setDialogOpen(false);
      form.reset();
      navigate({
        to: "/fournisseur/$id",
        params: { id: newFournisseur.id },
      });
    },
    onError: (error: Error) => {
      toast.error("Erreur lors de la création du fournisseur", {
        description: error.message,
      });
    },
  });

  const onSubmit = (data: CreateFournisseurForm) => {
    createMutation.mutate(data);
  };

  // ============================================================
  // DELETE MUTATION
  // ============================================================
  // materiel_catalogue.fournisseur_id -> fournisseurs has ON DELETE CASCADE,
  // so deleting the fournisseur row is enough; the DB removes the catalogue
  // items automatically. bid_lignes.materiel_catalogue_id -> materiel_catalogue
  // has ON DELETE SET NULL, so no FK violation can occur, but any bid_ligne
  // pointing at one of these items will silently lose that reference — we
  // surface the count in the confirmation dialog instead of hiding it.

  const { data: deleteImpact, isLoading: deleteImpactLoading } = useQuery({
    queryKey: ["fournisseur-delete-impact", deleteTarget?.id],
    queryFn: async () => {
      if (!deleteTarget) return { itemCount: 0, bidLignesCount: 0 };

      const { count: itemCount, error: itemsError } = await supabase
        .from("materiel_catalogue")
        .select("*", { count: "exact", head: true })
        .eq("fournisseur_id", deleteTarget.id);
      if (itemsError) throw itemsError;

      const { data: items, error: idsError } = await supabase
        .from("materiel_catalogue")
        .select("id")
        .eq("fournisseur_id", deleteTarget.id);
      if (idsError) throw idsError;

      const ids = items?.map((item) => item.id) ?? [];
      let bidLignesCount = 0;
      if (ids.length > 0) {
        const { count, error: bidError } = await supabase
          .from("bid_lignes")
          .select("*", { count: "exact", head: true })
          .in("materiel_catalogue_id", ids);
        if (bidError) throw bidError;
        bidLignesCount = count ?? 0;
      }

      return { itemCount: itemCount ?? 0, bidLignesCount };
    },
    enabled: !!deleteTarget,
  });

  const deleteFournisseurMutation = useMutation({
    mutationFn: async (fournisseurId: string) => {
      const { error } = await supabase.from("fournisseurs").delete().eq("id", fournisseurId);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Fournisseur supprimé");
      queryClient.invalidateQueries({ queryKey: ["fournisseurs-list"] });
      setDeleteTarget(null);
    },
    onError: (error: Error) => {
      toast.error("Erreur lors de la suppression du fournisseur", {
        description: error.message,
      });
    },
  });

  // ============================================================
  // LOADING STATE
  // ============================================================

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Fournisseurs"
          description="Gérez votre catalogue fournisseurs"
          action={<Skeleton className="h-9 w-40" />}
        />
        <Card>
          <CardContent className="p-6">
            <div className="space-y-4">
              <Skeleton className="h-10 w-full" />
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 py-3 border-b border-border last:border-0">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-4 w-28" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ============================================================
  // ERROR STATE
  // ============================================================

  if (error) {
    return (
      <div className="p-8 text-center">
        <p className="text-destructive">Erreur lors du chargement des fournisseurs</p>
        <p className="text-sm text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  // ============================================================
  // RENDER
  // ============================================================

  return (
    <div className="space-y-6">
      <PageHeader
        title="Fournisseurs"
        description="Gérez vos fournisseurs et leur catalogue"
        action={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="mr-1 size-4" />
            Ajouter un fournisseur
          </Button>
        }
      />

      <Card>
        <CardContent className="p-6">
          {/* Search Bar */}
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Rechercher un fournisseur..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 pr-9"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X className="size-4" />
              </button>
            )}
          </div>

          {/* List */}
          {!hasFournisseurs ? (
            searchQuery ? (
              <div className="py-12 text-center">
                <p className="text-muted-foreground">
                  Aucun fournisseur ne correspond à votre recherche
                </p>
              </div>
            ) : (
              <EmptyState
                icon={Building2}
                title="Aucun fournisseur"
                description="Ajoutez votre premier fournisseur pour commencer"
                action={
                  <Button onClick={() => setDialogOpen(true)}>
                    <Plus className="mr-1 size-4" />
                    Ajouter un fournisseur
                  </Button>
                }
              />
            )
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Nom</th>
                    <th className="px-4 py-3 font-medium">Contact</th>
                    <th className="px-4 py-3 font-medium">Téléphone</th>
                    <th className="px-4 py-3 font-medium">Email</th>
                    <th className="px-4 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredFournisseurs.map((fournisseur) => (
                    <tr
                      key={fournisseur.id}
                      className="cursor-pointer border-t border-border transition-colors hover:bg-muted/30"
                      onClick={() => {
                        navigate({
                          to: "/fournisseur/$id",
                          params: { id: fournisseur.id },
                        });
                      }}
                    >
                      <td className="px-4 py-3 font-medium">
                        <Link
                          to="/fournisseur/$id"
                          params={{ id: fournisseur.id }}
                          className="hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {fournisseur.nom}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {fournisseur.contact || "—"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {fournisseur.telephone || "—"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {fournisseur.email || "—"}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-7 px-2 text-destructive hover:text-destructive"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteTarget({ id: fournisseur.id, nom: fournisseur.nom });
                          }}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Create Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Nouveau fournisseur</DialogTitle>
            <DialogDescription>
              Ajoutez un nouveau fournisseur à votre catalogue.
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="nom"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nom *</FormLabel>
                    <FormControl>
                      <Input placeholder="Nom du fournisseur" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="contact"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Contact</FormLabel>
                    <FormControl>
                      <Input placeholder="Nom du contact" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="telephone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Téléphone</FormLabel>
                    <FormControl>
                      <Input placeholder="Numéro de téléphone" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Email</FormLabel>
                    <FormControl>
                      <Input type="email" placeholder="email@fournisseur.com" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes</FormLabel>
                    <FormControl>
                      <Input placeholder="Informations supplémentaires" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <DialogFooter>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setDialogOpen(false)}
                >
                  Annuler
                </Button>
                <Button type="submit" disabled={createMutation.isPending}>
                  {createMutation.isPending ? "Création..." : "Créer"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Supprimer {deleteTarget?.nom} ?</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteImpactLoading ? (
                "Vérification des données liées..."
              ) : (
                <>
                  Cette action est irréversible. Elle supprimera également{" "}
                  <strong>
                    {deleteImpact?.itemCount ?? 0} article
                    {(deleteImpact?.itemCount ?? 0) > 1 ? "s" : ""}
                  </strong>{" "}
                  de son catalogue.
                  {(deleteImpact?.bidLignesCount ?? 0) > 0 && (
                    <>
                      {" "}
                      <strong>
                        {deleteImpact?.bidLignesCount} ligne
                        {(deleteImpact?.bidLignesCount ?? 0) > 1 ? "s" : ""} de soumission
                      </strong>{" "}
                      référence{(deleteImpact?.bidLignesCount ?? 0) > 1 ? "nt" : ""} actuellement
                      ces articles et perdra{(deleteImpact?.bidLignesCount ?? 0) > 1 ? "" : ""}{" "}
                      cette référence (mise à null).
                    </>
                  )}
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Annuler</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deleteTarget && deleteFournisseurMutation.mutate(deleteTarget.id)}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              disabled={deleteFournisseurMutation.isPending || deleteImpactLoading}
            >
              {deleteFournisseurMutation.isPending ? "Suppression..." : "Supprimer"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}