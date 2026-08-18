// src/routes/_authenticated/fournisseur.$id.tsx
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ArrowLeft, Save, Plus, X, Edit2, Check, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { CatalogueItemForm } from "@/components/CatalogueItemForm";
import { PriceHistoryDialog } from "@/components/PriceHistoryDialog";
import { cn } from "@/lib/utils";
import { formatDinars } from "@/lib/format";

// ============================================================
// TYPES
// ============================================================

type Fournisseur = {
  id: string;
  nom: string;
  contact: string | null;
  telephone: string | null;
  email: string | null;
  notes: string | null;
  created_at: string | null;
};

type CatalogueItem = {
  id: string;
  fournisseur_id: string | null;
  designation: string;
  unite: string;
  prix_fourniture: number;
  categorie: string | null;
  sous_categorie: string | null;
  specs: Record<string, any>;
  statut: "verifie" | "brouillon";
  date_maj: string;
  created_at: string;
  image_url?: string | null;
};

// ============================================================
// SCHEMAS
// ============================================================

const editFournisseurSchema = z.object({
  nom: z.string().min(1, "Le nom est requis"),
  contact: z.string().optional(),
  telephone: z.string().optional(),
  email: z.string().email("Email invalide").optional().or(z.literal("")),
  notes: z.string().optional(),
});

type EditFournisseurForm = z.infer<typeof editFournisseurSchema>;

// ============================================================
// QUERIES
// ============================================================

const fournisseurQuery = (id: string) => ({
  queryKey: ["fournisseur", id],
  queryFn: async () => {
    const { data, error } = await supabase
      .from("fournisseurs")
      .select("*")
      .eq("id", id)
      .single();

    if (error) throw error;
    return data as Fournisseur;
  },
});

const catalogueItemsQuery = (fournisseurId: string) => ({
  queryKey: ["catalogue-items", fournisseurId],
  queryFn: async () => {
    const { data, error } = await supabase
      .from("materiel_catalogue")
      .select("*")
      .eq("fournisseur_id", fournisseurId)
      .order("date_maj", { ascending: false });

    if (error) throw error;
    return (data || []) as CatalogueItem[];
  },
});

const categoriesQuery = () => ({
  queryKey: ["catalogue-categories"],
  queryFn: async () => {
    const { data, error } = await supabase
      .from("materiel_catalogue")
      .select("categorie, sous_categorie")
      .not("categorie", "is", null);

    if (error) throw error;

    const categoriesMap = new Map<string, Set<string>>();
    data?.forEach(item => {
      if (item.categorie) {
        if (!categoriesMap.has(item.categorie)) {
          categoriesMap.set(item.categorie, new Set());
        }
        if (item.sous_categorie) {
          categoriesMap.get(item.categorie)?.add(item.sous_categorie);
        }
      }
    });

    const result: Record<string, string[]> = {};
    categoriesMap.forEach((subs, cat) => {
      result[cat] = Array.from(subs).sort();
    });

    return result;
  },
});

// ============================================================
// ROUTE
// ============================================================

export const Route = createFileRoute("/_authenticated/fournisseur/$id")({
  component: FournisseurDetailComponent,
});

// ============================================================
// COMPONENT
// ============================================================

function FournisseurDetailComponent() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // ============================================================
  // STATE
  // ============================================================

  const [isEditing, setIsEditing] = useState(false);
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [newItemDialogOpen, setNewItemDialogOpen] = useState(false);
  const [itemDirtyStates, setItemDirtyStates] = useState<Record<string, boolean>>({});

  // ============================================================
  // QUERIES
  // ============================================================

  const {
    data: fournisseur,
    isLoading: fournisseurLoading,
    error: fournisseurError,
  } = useQuery(fournisseurQuery(id));

  const {
    data: catalogueItems,
    isLoading: itemsLoading,
    error: itemsError,
  } = useQuery(catalogueItemsQuery(id));

  const { data: categoriesMap } = useQuery(categoriesQuery());

  // ============================================================
  // EDIT FOURNISSEUR FORM
  // ============================================================

  const form = useForm<EditFournisseurForm>({
    resolver: zodResolver(editFournisseurSchema),
    defaultValues: {
      nom: "",
      contact: "",
      telephone: "",
      email: "",
      notes: "",
    },
  });

  useEffect(() => {
    if (fournisseur) {
      form.reset({
        nom: fournisseur.nom,
        contact: fournisseur.contact || "",
        telephone: fournisseur.telephone || "",
        email: fournisseur.email || "",
        notes: fournisseur.notes || "",
      });
    }
  }, [fournisseur, form]);

  const updateFournisseurMutation = useMutation({
    mutationFn: async (data: EditFournisseurForm) => {
      const { error } = await supabase
        .from("fournisseurs")
        .update({
          nom: data.nom,
          contact: data.contact || null,
          telephone: data.telephone || null,
          email: data.email || null,
          notes: data.notes || null,
        })
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Fournisseur mis à jour");
      queryClient.invalidateQueries({ queryKey: ["fournisseur", id] });
      setIsEditing(false);
    },
    onError: (error: Error) => {
      toast.error("Erreur lors de la mise à jour", {
        description: error.message,
      });
    },
  });

  const onEditSubmit = (data: EditFournisseurForm) => {
    updateFournisseurMutation.mutate(data);
  };

  // ============================================================
  // CATALOGUE ITEM OPERATIONS
  // ============================================================

  const updateItemMutation = useMutation({
    mutationFn: async ({
      itemId,
      updates,
    }: {
      itemId: string;
      updates: Partial<Omit<CatalogueItem, "id" | "fournisseur_id" | "date_maj">>;
    }) => {
      const { error } = await supabase
        .from("materiel_catalogue")
        .update({
          ...updates,
          date_maj: new Date().toISOString(),
        })
        .eq("id", itemId);

      if (error) throw error;
    },
    onSuccess: (_, variables) => {
      toast.success("Article mis à jour");
      queryClient.invalidateQueries({ queryKey: ["catalogue-items", id] });
      setEditingItemId(null);
      setItemDirtyStates((prev) => ({ ...prev, [variables.itemId]: false }));
    },
    onError: (error: Error) => {
      toast.error("Erreur lors de la mise à jour", {
        description: error.message,
      });
    },
  });

  const toggleStockMutation = useMutation({
    mutationFn: async ({
      itemId,
      currentStatut,
    }: {
      itemId: string;
      currentStatut: string;
    }) => {
      const newStatut = currentStatut === "verifie" ? "brouillon" : "verifie";
      const { error } = await supabase
        .from("materiel_catalogue")
        .update({
          statut: newStatut,
          date_maj: new Date().toISOString(),
        })
        .eq("id", itemId);

      if (error) throw error;
      return newStatut;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["catalogue-items", id] });
    },
    onError: (error: Error) => {
      toast.error("Erreur lors du changement de statut", {
        description: error.message,
      });
    },
  });

  const createItemMutation = useMutation({
    mutationFn: async (data: any) => {
      // If there's an image file, we'd upload it here (to be implemented)
      const { data: newItem, error } = await supabase
        .from("materiel_catalogue")
        .insert({
          fournisseur_id: id,
          designation: data.designation,
          unite: data.unite,
          prix_fourniture: data.prix_fourniture,
          categorie: data.categorie || null,
          sous_categorie: data.sous_categorie || null,
          statut: "brouillon" as const,
          specs: data.specs || {},
          image_url: data.image_url || null,
        })
        .select()
        .single();

      if (error) throw error;
      return newItem;
    },
    onSuccess: () => {
      toast.success("Article ajouté");
      queryClient.invalidateQueries({ queryKey: ["catalogue-items", id] });
      setNewItemDialogOpen(false);
    },
    onError: (error: Error) => {
      toast.error("Erreur lors de l'ajout", {
        description: error.message,
      });
    },
  });

  const deleteItemMutation = useMutation({
    mutationFn: async (itemId: string) => {
      const { error } = await supabase
        .from("materiel_catalogue")
        .delete()
        .eq("id", itemId);

      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Article supprimé");
      queryClient.invalidateQueries({ queryKey: ["catalogue-items", id] });
    },
    onError: (error: Error) => {
      toast.error("Erreur lors de la suppression", {
        description: error.message,
      });
    },
  });

  // ============================================================
  // FOURNISSEUR DELETION
  // ============================================================
  // materiel_catalogue.fournisseur_id -> fournisseurs has ON DELETE CASCADE,
  // so deleting the fournisseur row is enough; the DB removes the catalogue
  // items automatically. bid_lignes.materiel_catalogue_id -> materiel_catalogue
  // has ON DELETE SET NULL, so no FK violation can occur, but any bid_ligne
  // pointing at one of these items will silently lose that reference — we
  // surface the count in the confirmation dialog instead of hiding it.

  const catalogueItemIds = catalogueItems?.map((item) => item.id) ?? [];

  const { data: affectedBidLignesCount, isLoading: bidLignesImpactLoading } = useQuery({
    queryKey: ["fournisseur-bid-lignes-impact", id, catalogueItemIds.join(",")],
    queryFn: async () => {
      if (catalogueItemIds.length === 0) return 0;
      const { count, error } = await supabase
        .from("bid_lignes")
        .select("*", { count: "exact", head: true })
        .in("materiel_catalogue_id", catalogueItemIds);

      if (error) throw error;
      return count ?? 0;
    },
    enabled: !itemsLoading,
  });

  const deleteFournisseurMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("fournisseurs").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Fournisseur supprimé");
      queryClient.invalidateQueries({ queryKey: ["fournisseurs-list"] });
      navigate({ to: "/fournisseur" });
    },
    onError: (error: Error) => {
      toast.error("Erreur lors de la suppression du fournisseur", {
        description: error.message,
      });
    },
  });

  // ============================================================
  // HELPERS
  // ============================================================

  const markDirty = (itemId: string) => {
    setItemDirtyStates((prev) => ({ ...prev, [itemId]: true }));
  };

  const handleItemChange = (itemId: string, field: string, value: any) => {
    queryClient.setQueryData(
      ["catalogue-items", id],
      (old: CatalogueItem[] | undefined) =>
        old?.map((item) =>
          item.id === itemId ? { ...item, [field]: value } : item
        ) || []
    );
    markDirty(itemId);
  };

  const getUpdatedItem = (itemId: string): CatalogueItem | undefined => {
    const items = queryClient.getQueryData<CatalogueItem[]>(["catalogue-items", id]);
    return items?.find((i) => i.id === itemId);
  };

  const isStockAvailable = (statut: string) => statut === "verifie";

  // date_maj is set to now() on every edit (see updateItemMutation /
  // toggleStockMutation) but not on creation, so if it still matches
  // created_at, the item has never actually been touched since import.
  const wasEditedSinceCreation = (item: CatalogueItem) => item.date_maj !== item.created_at;

  const formatModifiedDate = (isoDate: string) =>
    new Date(isoDate).toLocaleDateString("fr-FR", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric",
    });

  // ============================================================
  // RENDER - LOADING
  // ============================================================

  if (fournisseurLoading || itemsLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-9 w-9" />
          <Skeleton className="h-8 w-48" />
        </div>
        <Card>
          <CardContent className="p-6 space-y-4">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-4 w-full max-w-md" />
            <Skeleton className="h-4 w-full max-w-sm" />
            <Skeleton className="h-4 w-full max-w-xs" />
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-6">
            <div className="space-y-4">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 py-3 border-b border-border">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-4 w-24" />
                  <Skeleton className="h-4 w-20" />
                  <Skeleton className="ml-auto h-6 w-16" />
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ============================================================
  // RENDER - ERROR
  // ============================================================

  if (fournisseurError || itemsError || !fournisseur) {
    return (
      <div className="p-8 text-center">
        <p className="text-destructive">Erreur lors du chargement</p>
        <p className="text-sm text-muted-foreground">
          {fournisseurError?.message || itemsError?.message || "Fournisseur non trouvé"}
        </p>
        <Button className="mt-4" onClick={() => navigate({ to: "/fournisseur" })}>
          Retour aux fournisseurs
        </Button>
      </div>
    );
  }

  // ============================================================
  // RENDER
  // ============================================================

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate({ to: "/fournisseur" })}
          className="gap-1"
        >
          <ArrowLeft className="size-4" />
          Retour
        </Button>

        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="gap-1 text-destructive hover:text-destructive"
            >
              <Trash2 className="size-4" />
              Supprimer le fournisseur
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Supprimer {fournisseur.nom} ?</AlertDialogTitle>
              <AlertDialogDescription>
                Cette action est irréversible. Elle supprimera également{" "}
                <strong>
                  {catalogueItems?.length ?? 0} article
                  {(catalogueItems?.length ?? 0) > 1 ? "s" : ""}
                </strong>{" "}
                de son catalogue.
                {!bidLignesImpactLoading && (affectedBidLignesCount ?? 0) > 0 && (
                  <>
                    {" "}
                    <strong>
                      {affectedBidLignesCount} ligne
                      {(affectedBidLignesCount ?? 0) > 1 ? "s" : ""} de soumission
                    </strong>{" "}
                    référence{(affectedBidLignesCount ?? 0) > 1 ? "nt" : ""} actuellement ces
                    articles et perdra{(affectedBidLignesCount ?? 0) > 1 ? "" : ""} cette
                    référence (mise à null).
                  </>
                )}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Annuler</AlertDialogCancel>
              <AlertDialogAction
                onClick={() => deleteFournisseurMutation.mutate()}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                disabled={deleteFournisseurMutation.isPending}
              >
                {deleteFournisseurMutation.isPending ? "Suppression..." : "Supprimer"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      {/* Fournisseur Info */}
      <Card>
        <CardContent className="p-6">
          {isEditing ? (
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onEditSubmit)} className="space-y-4">
                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="nom"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Nom *</FormLabel>
                        <FormControl>
                          <Input {...field} />
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
                          <Input {...field} />
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
                          <Input {...field} />
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
                          <Input type="email" {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="notes"
                    render={({ field }) => (
                      <FormItem className="md:col-span-2">
                        <FormLabel>Notes</FormLabel>
                        <FormControl>
                          <Input {...field} />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setIsEditing(false);
                      form.reset({
                        nom: fournisseur.nom,
                        contact: fournisseur.contact || "",
                        telephone: fournisseur.telephone || "",
                        email: fournisseur.email || "",
                        notes: fournisseur.notes || "",
                      });
                    }}
                  >
                    Annuler
                  </Button>
                  <Button type="submit" disabled={updateFournisseurMutation.isPending}>
                    {updateFournisseurMutation.isPending ? "Enregistrement..." : "Enregistrer"}
                  </Button>
                </div>
              </form>
            </Form>
          ) : (
            <div>
              <div className="flex items-start justify-between">
                <div>
                  <h2 className="text-2xl font-semibold">{fournisseur.nom}</h2>
                  {fournisseur.notes && (
                    <p className="mt-1 text-sm text-muted-foreground">{fournisseur.notes}</p>
                  )}
                </div>
                <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                  <Edit2 className="mr-1 size-4" />
                  Modifier
                </Button>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-2 text-sm md:grid-cols-3">
                {fournisseur.contact && (
                  <div>
                    <span className="text-muted-foreground">Contact :</span> {fournisseur.contact}
                  </div>
                )}
                {fournisseur.telephone && (
                  <div>
                    <span className="text-muted-foreground">Tél :</span> {fournisseur.telephone}
                  </div>
                )}
                {fournisseur.email && (
                  <div>
                    <span className="text-muted-foreground">Email :</span> {fournisseur.email}
                  </div>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Catalogue Items */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-lg font-medium">Catalogue</h3>
          <div className="flex items-center gap-2">
            <Badge variant="secondary">{catalogueItems?.length || 0} articles</Badge>
            <Button size="sm" onClick={() => setNewItemDialogOpen(true)}>
              <Plus className="mr-1 size-4" />
              Ajouter
            </Button>
          </div>
        </div>

        <Card>
          <CardContent className="p-6">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-3 font-medium">Désignation</th>
                    <th className="px-3 py-3 font-medium">Catégorie</th>
                    <th className="px-3 py-3 font-medium">Sous-catégorie</th>
                    <th className="px-3 py-3 font-medium text-right">Prix</th>
                    <th className="px-3 py-3 font-medium">Unité</th>
                    <th className="px-3 py-3 font-medium text-center">Stock</th>
                    <th className="px-3 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {catalogueItems?.map((item) => {
                    const isEditingItem = editingItemId === item.id;
                    const isDirty = itemDirtyStates[item.id] || false;

                    return (
                      <tr
                        key={item.id}
                        className="border-t border-border transition-colors hover:bg-muted/30"
                      >
                        {isEditingItem ? (
                          <>
                            <td className="px-3 py-2">
                              <Input
                                defaultValue={item.designation}
                                onChange={(e) =>
                                  handleItemChange(item.id, "designation", e.target.value)
                                }
                                className="h-8 text-sm"
                              />
                            </td>
                            <td className="px-3 py-2">
                              <Input
                                defaultValue={item.categorie || ""}
                                onChange={(e) =>
                                  handleItemChange(item.id, "categorie", e.target.value || null)
                                }
                                className="h-8 text-sm"
                              />
                            </td>
                            <td className="px-3 py-2">
                              <Input
                                defaultValue={item.sous_categorie || ""}
                                onChange={(e) =>
                                  handleItemChange(item.id, "sous_categorie", e.target.value || null)
                                }
                                className="h-8 text-sm"
                              />
                            </td>
                            <td className="px-3 py-2">
                              <Input
                                type="number"
                                step="0.01"
                                defaultValue={item.prix_fourniture}
                                onChange={(e) =>
                                  handleItemChange(item.id, "prix_fourniture", parseFloat(e.target.value) || 0)
                                }
                                className="h-8 w-24 text-right text-sm"
                              />
                            </td>
                            <td className="px-3 py-2">
                              <Input
                                defaultValue={item.unite}
                                onChange={(e) =>
                                  handleItemChange(item.id, "unite", e.target.value)
                                }
                                className="h-8 w-16 text-sm"
                              />
                            </td>
                            <td className="px-3 py-2 text-center">
                              <Switch
                                checked={isStockAvailable(item.statut)}
                                onCheckedChange={() => {
                                  toggleStockMutation.mutate({
                                    itemId: item.id,
                                    currentStatut: item.statut,
                                  });
                                }}
                              />
                            </td>
                            <td className="px-3 py-2 text-right">
                              <div className="flex items-center justify-end gap-1">
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2"
                                  onClick={() => {
                                    const updatedItem = getUpdatedItem(item.id);
                                    if (updatedItem) {
                                      updateItemMutation.mutate({
                                        itemId: item.id,
                                        updates: {
                                          designation: updatedItem.designation,
                                          categorie: updatedItem.categorie,
                                          sous_categorie: updatedItem.sous_categorie,
                                          prix_fourniture: updatedItem.prix_fourniture,
                                          unite: updatedItem.unite,
                                          specs: updatedItem.specs,
                                          image_url: updatedItem.image_url,
                                        },
                                      });
                                    }
                                  }}
                                  disabled={!isDirty || updateItemMutation.isPending}
                                >
                                  <Save className="size-3.5" />
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2"
                                  onClick={() => {
                                    setEditingItemId(null);
                                    setItemDirtyStates((prev) => ({ ...prev, [item.id]: false }));
                                  }}
                                >
                                  <X className="size-3.5" />
                                </Button>
                              </div>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="px-3 py-3 font-medium">
                              {item.designation}
                              {wasEditedSinceCreation(item) && (
                                <Badge
                                  variant="outline"
                                  className="ml-2 align-middle text-[10px] font-normal text-muted-foreground"
                                >
                                  Modifié le {formatModifiedDate(item.date_maj)}
                                </Badge>
                              )}
                            </td>
                            <td className="px-3 py-3 text-muted-foreground">
                              {item.categorie || "—"}
                            </td>
                            <td className="px-3 py-3 text-muted-foreground">
                              {item.sous_categorie || "—"}
                            </td>
                            <td className="px-3 py-3 text-right font-mono tabular-nums">
                              {formatDinars(item.prix_fourniture)}
                            </td>
                            <td className="px-3 py-3">{item.unite}</td>
                            <td className="px-3 py-3 text-center">
                              <Badge
                                variant={isStockAvailable(item.statut) ? "default" : "secondary"}
                                className={cn(
                                  "text-xs",
                                  !isStockAvailable(item.statut) && "bg-muted text-muted-foreground"
                                )}
                              >
                                {isStockAvailable(item.statut) ? "En stock" : "Rupture"}
                              </Badge>
                            </td>
                            <td className="px-3 py-3 text-right">
                              <div className="flex items-center justify-end gap-1">
                                <PriceHistoryDialog
                                  materielCatalogueId={item.id}
                                  designation={item.designation}
                                  buttonClassName="h-7 w-7"
                                  iconClassName="size-3.5"
                                />
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-7 px-2"
                                  onClick={() => setEditingItemId(item.id)}
                                >
                                  <Edit2 className="size-3.5" />
                                </Button>
                                <AlertDialog>
                                  <AlertDialogTrigger asChild>
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 px-2 text-destructive hover:text-destructive"
                                    >
                                      <Trash2 className="size-3.5" />
                                    </Button>
                                  </AlertDialogTrigger>
                                  <AlertDialogContent>
                                    <AlertDialogHeader>
                                      <AlertDialogTitle>Supprimer l'article</AlertDialogTitle>
                                      <AlertDialogDescription>
                                        Êtes-vous sûr de vouloir supprimer "{item.designation}" ?
                                        Cette action est irréversible.
                                      </AlertDialogDescription>
                                    </AlertDialogHeader>
                                    <AlertDialogFooter>
                                      <AlertDialogCancel>Annuler</AlertDialogCancel>
                                      <AlertDialogAction
                                        onClick={() => deleteItemMutation.mutate(item.id)}
                                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                      >
                                        Supprimer
                                      </AlertDialogAction>
                                    </AlertDialogFooter>
                                  </AlertDialogContent>
                                </AlertDialog>
                              </div>
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* New Item Dialog using reusable component */}
      <CatalogueItemForm
        open={newItemDialogOpen}
        onOpenChange={setNewItemDialogOpen}
        onSubmit={createItemMutation.mutate}
        isPending={createItemMutation.isPending}
        fournisseurs={[]}
        categoriesMap={categoriesMap}
        fournisseurId={id}
        title="Ajouter un article"
        description={`Ajoutez un nouvel article au catalogue de ${fournisseur.nom}.`}
        submitLabel="Ajouter"
      />
    </div>
  );
}