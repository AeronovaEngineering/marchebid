// src/routes/_authenticated/chantiers.index.tsx
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Search, Plus, Building2, X } from "lucide-react";
import { format } from "date-fns";
import { fr } from "date-fns/locale";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { PageHeader } from "@/components/ui/pageHeader";
import { StatutBadge } from "@/components/StatutBadge";
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
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

// ============================================================
// SCHEMA
// ============================================================

const chantierStatuses = [
  { value: "brouillon", label: "Brouillon" },
  { value: "en_cours", label: "En cours" },
  { value: "soumis", label: "Soumis" },
  { value: "gagne", label: "Gagné" },
  { value: "perdu", label: "Perdu" },
] as const;

const createChantierSchema = z.object({
  nom: z.string().min(1, "Le nom est requis"),
  client: z.string().optional(),
  lieu: z.string().optional(),
  statut: z.enum(["brouillon", "en_cours", "soumis", "gagne", "perdu"]).default("brouillon"),
});

// z.input (not z.infer/z.output) here: `.default(...)` makes `statut`
// optional on the way IN (what the form/resolver types need) but required
// on the way OUT (what onSubmit receives after parsing) -- using the
// output type for useForm's generic is what caused the resolver mismatch.
type CreateChantierForm = z.input<typeof createChantierSchema>;

// ============================================================
// QUERIES
// ============================================================

const chantiersQuery = () => ({
  queryKey: ["chantiers-list"],
  queryFn: async () => {
    const { data, error } = await supabase
      .from("chantiers")
      .select(`
        id,
        nom,
        client,
        lieu,
        statut,
        created_at,
        created_by,
        marches (
          id,
          marche_lignes (
            id,
            bid_lignes (
              id,
              statut
            )
          )
        )
      `)
      .order("created_at", { ascending: false });

    if (error) throw error;

    // Compute taux de confirmation for each chantier
    return data?.map(chantier => {
      let totalLignes = 0;
      let lignesConfirmees = 0;

      chantier.marches?.forEach(marche => {
        marche.marche_lignes?.forEach(ligne => {
          // bid_lignes is a one-to-one embed here (unique FK on marche_ligne_id),
          // so Supabase types it as a single object, not an array.
          totalLignes++;
          if (ligne.bid_lignes?.statut === "verifie") lignesConfirmees++;
        });
      });

      const tauxConfirmation = totalLignes > 0
        ? Math.round((lignesConfirmees / totalLignes) * 100)
        : 0;

      return {
        id: chantier.id,
        nom: chantier.nom,
        client: chantier.client,
        lieu: chantier.lieu,
        statut: chantier.statut,
        created_at: chantier.created_at,
        tauxConfirmation,
      };
    }) || [];
  },
});

// ============================================================
// ROUTE
// ============================================================

export const Route = createFileRoute("/_authenticated/chantiers/")({
  component: ChantiersIndexComponent,
});

// ============================================================
// COMPONENT
// ============================================================

function ChantiersIndexComponent() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: user } = useCurrentUser();
  const [searchQuery, setSearchQuery] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);

  const { data: chantiers, isLoading, error } = useQuery(chantiersQuery());

  // Filter chantiers client-side
  const filteredChantiers = chantiers?.filter(chantier =>
    chantier.nom.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (chantier.client?.toLowerCase().includes(searchQuery.toLowerCase()) ?? false)
  ) || [];

  const hasChantiers = filteredChantiers.length > 0;

  // ============================================================
  // CREATE MUTATION
  // ============================================================

  const form = useForm<CreateChantierForm>({
    resolver: zodResolver(createChantierSchema),
    defaultValues: {
      nom: "",
      client: "",
      lieu: "",
      statut: "brouillon",
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: CreateChantierForm) => {
      const { data: newChantier, error } = await supabase
        .from("chantiers")
        .insert({
          nom: data.nom,
          client: data.client || null,
          lieu: data.lieu || null,
          statut: data.statut ?? "brouillon",
          created_by: user?.id || null,
        })
        .select()
        .single();

      if (error) throw error;
      return newChantier;
    },
    onSuccess: (newChantier) => {
      toast.success("Chantier créé avec succès");
      queryClient.invalidateQueries({ queryKey: ["chantiers-list"] });
      setDialogOpen(false);
      form.reset();
      void logActivity({ action: "create", entity_type: "chantier", entity_id: newChantier.id, details: { nom: newChantier.nom } });
      navigate({
        to: "/chantiers/$id",
        params: { id: newChantier.id },
      });
    },
    onError: (error: Error) => {
      toast.error("Erreur lors de la création du chantier", {
        description: error.message,
      });
    },
  });

  const onSubmit = (data: CreateChantierForm) => {
    createMutation.mutate(data);
  };

  // ============================================================
  // LOADING STATE
  // ============================================================

  if (isLoading) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Chantiers"
          description="Gérez tous vos chantiers de chiffrage"
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
                  <Skeleton className="h-5 w-20" />
                  <Skeleton className="ml-auto h-4 w-28" />
                  <Skeleton className="h-4 w-12" />
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
        <p className="text-destructive">Erreur lors du chargement des chantiers</p>
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
        title="Chantiers"
        description="Gérez tous vos chantiers de chiffrage"
        action={
          <Button onClick={() => setDialogOpen(true)}>
            <Plus className="mr-1 size-4" />
            Nouveau chantier
          </Button>
        }
      />

      <Card>
        <CardContent className="p-6">
          {/* Search Bar */}
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Rechercher un chantier..."
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

          {/* Table */}
          {!hasChantiers ? (
            searchQuery ? (
              <div className="py-12 text-center">
                <p className="text-muted-foreground">
                  Aucun chantier ne correspond à votre recherche
                </p>
              </div>
            ) : (
              <EmptyState
                icon={Building2}
                title="Aucun chantier"
                description="Commencez par créer votre premier chantier"
                action={
                  <Button onClick={() => setDialogOpen(true)}>
                    <Plus className="mr-1 size-4" />
                    Créer un chantier
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
                    <th className="px-4 py-3 font-medium">Client</th>
                    <th className="px-4 py-3 font-medium">Statut</th>
                    <th className="px-4 py-3 font-medium text-right">% Confirmées</th>
                    <th className="px-4 py-3 font-medium text-right">Créé le</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredChantiers.map((chantier) => (
                    <tr
                      key={chantier.id}
                      className="cursor-pointer border-t border-border transition-colors hover:bg-muted/30"
                      onClick={() => {
                        navigate({
                          to: "/chantiers/$id",
                          params: { id: chantier.id },
                        });
                      }}
                    >
                      <td className="px-4 py-3 font-medium">
                        <Link
                          to="/chantiers/$id"
                          params={{ id: chantier.id }}
                          className="hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {chantier.nom}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {chantier.client || "—"}
                      </td>
                      <td className="px-4 py-3">
                        <StatutBadge statut={chantier.statut ?? "brouillon"} kind="chantier" />
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">
                        {chantier.tauxConfirmation}%
                      </td>
                      <td className="px-4 py-3 text-right text-muted-foreground">
                        {chantier.created_at
                          ? format(new Date(chantier.created_at), "dd MMM yyyy", { locale: fr })
                          : "—"}
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
            <DialogTitle>Nouveau chantier</DialogTitle>
            <DialogDescription>
              Créez un nouveau chantier pour commencer le chiffrage.
            </DialogDescription>
          </DialogHeader>

          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="nom"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Nom du chantier *</FormLabel>
                    <FormControl>
                      <Input placeholder="Ex: Résidence Les Oliviers" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="client"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Client</FormLabel>
                    <FormControl>
                      <Input placeholder="Nom du client" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="lieu"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Lieu</FormLabel>
                    <FormControl>
                      <Input placeholder="Adresse du chantier" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="statut"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Statut</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      defaultValue={field.value ?? "brouillon"}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Sélectionner un statut" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {chantierStatuses.map((status) => (
                          <SelectItem key={status.value} value={status.value}>
                            {status.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
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
    </div>
  );
}