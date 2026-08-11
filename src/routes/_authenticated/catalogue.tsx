// src/routes/_authenticated/catalogue.tsx
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { useState, useMemo, useRef } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
  Search,
  Grid3x3,
  List,
  Plus,
  Upload,
  Package,
  X,
  Building2,
  Image as ImageIcon,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Edit2,
} from "lucide-react";
import { toast } from "sonner";

import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { PageHeader } from "@/components/ui/pageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { CatalogueItemForm } from "@/components/CatalogueItemForm";
import { CatalogueImportPanel } from "@/components/Catalogueimportpanel";
import { logActivity } from "@/lib/activitylog";
import { cn } from "@/lib/utils";
import { formatDinars } from "@/lib/format";
import { EmptyState } from "@/components/ui/Emptystate";

// ============================================================
// SCHEMAS
// ============================================================

const createItemSchema = z.object({
  fournisseur_id: z.string().min(1, "Le fournisseur est requis"),
  designation: z.string().min(1, "La désignation est requise"),
  categorie: z.string().optional(),
  sous_categorie: z.string().optional(),
  unite: z.string().min(1, "L'unité est requise"),
  prix_fourniture: z.number().min(0, "Le prix doit être positif"),
});

type CreateItemForm = z.infer<typeof createItemSchema>;

// ============================================================
// TYPES
// ============================================================

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
  image_url?: string | null;
  fournisseurs?: {
    id: string;
    nom: string;
  } | null;
};

// ============================================================
// QUERIES
// ============================================================

const catalogueQuery = (filters: {
  search: string;
  categorie: string;
  sousCategorie: string;
  fournisseur: string;
  inStockOnly: boolean;
  page: number;
  pageSize: number;
}) => ({
  queryKey: ["catalogue", filters],
  queryFn: async () => {
    let query = supabase
      .from("materiel_catalogue")
      .select(`
        *,
        fournisseurs (
          id,
          nom
        )
      `, { count: "exact" });

    if (filters.search) {
      query = query.ilike("designation", `%${filters.search}%`);
    }

    if (filters.categorie && filters.categorie !== "all") {
      query = query.eq("categorie", filters.categorie);
    }

    if (filters.sousCategorie && filters.sousCategorie !== "all") {
      query = query.eq("sous_categorie", filters.sousCategorie);
    }

    if (filters.fournisseur && filters.fournisseur !== "all") {
      query = query.eq("fournisseur_id", filters.fournisseur);
    }

    if (filters.inStockOnly) {
      query = query.eq("statut", "verifie");
    }

    const from = (filters.page - 1) * filters.pageSize;
    const to = from + filters.pageSize - 1;
    query = query.range(from, to);
    query = query.order("designation", { ascending: true });

    const { data, error, count } = await query;

    if (error) throw error;
    return { items: (data || []) as unknown as CatalogueItem[], total: count || 0 };
  },
  placeholderData: keepPreviousData,
});

const fournisseursQuery = () => ({
  queryKey: ["fournisseurs-list"],
  queryFn: async () => {
    const { data, error } = await supabase
      .from("fournisseurs")
      .select("id, nom")
      .order("nom", { ascending: true });

    if (error) throw error;
    return data || [];
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
// STORAGE
// ============================================================

/**
 * Uploads an image to the `catalogue-images` Supabase Storage bucket
 * (public read) under `${fournisseurId}/${uuid}-${filename}`, then
 * returns its public URL to store on `materiel_catalogue.image_url`.
 */
async function uploadCatalogueImage(file: File, fournisseurId: string): Promise<string> {
  const path = `${fournisseurId}/${crypto.randomUUID()}-${file.name}`;

  const { error: uploadError } = await supabase.storage
    .from("catalogue-images")
    .upload(path, file, {
      cacheControl: "3600",
      upsert: false,
    });

  if (uploadError) {
    throw new Error(`Échec de l'envoi de l'image : ${uploadError.message}`);
  }

  const { data: publicUrlData } = supabase.storage
    .from("catalogue-images")
    .getPublicUrl(path);

  return publicUrlData.publicUrl;
}

/**
 * Extracts the storage object path (the part after the bucket name) from a
 * `catalogue-images` public URL, so a stored image_url can be deleted
 * without assuming a fixed host/prefix format. Returns null if the URL
 * doesn't look like a catalogue-images public URL.
 */
function catalogueImagePathFromUrl(url: string): string | null {
  const marker = "/catalogue-images/";
  const index = url.indexOf(marker);
  if (index === -1) return null;
  const path = url.slice(index + marker.length);
  return path ? decodeURIComponent(path) : null;
}

/**
 * Deletes a previously-uploaded catalogue image from storage, given its
 * public URL. Best-effort: never throws (a failed cleanup of an orphaned
 * file should never block the create/update of the catalogue item
 * itself), but both failure modes are surfaced now instead of one of them
 * silently no-oping:
 *  - path extraction failing (malformed/unexpected URL shape) used to
 *    just `return` with nothing logged at all -- now it's a console.error
 *    so a bad URL format doesn't look identical to "nothing to delete".
 *  - the actual storage remove() call erroring (e.g. a missing DELETE
 *    policy on storage.objects for this bucket) used to only go to
 *    console.error, invisible to anyone testing the UI -- now it also
 *    surfaces a toast so a human tester actually sees the cleanup failed,
 *    without blocking their save.
 */
async function deleteCatalogueImage(url: string): Promise<void> {
  const path = catalogueImagePathFromUrl(url);
  if (!path) {
    console.error(
      "Suppression de l'ancienne image du catalogue ignorée : impossible d'extraire le chemin de stockage depuis l'URL.",
      url,
    );
    toast.error("Ancienne image non supprimée du stockage (URL inattendue)", {
      description: url,
    });
    return;
  }

  const { error } = await supabase.storage.from("catalogue-images").remove([path]);
  if (error) {
    console.error("Échec de la suppression de l'ancienne image du catalogue :", error);
    toast.error("Ancienne image non supprimée du stockage", { description: error.message });
  }
}

// ============================================================
// ROUTE
// ============================================================

export const Route = createFileRoute("/_authenticated/catalogue")({
  component: CatalogueComponent,
});

// ============================================================
// COMPONENT
// ============================================================

function CatalogueComponent() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: user } = useCurrentUser();
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [isUploadingImage, setIsUploadingImage] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategorie, setSelectedCategorie] = useState<string>("all");
  const [selectedSousCategorie, setSelectedSousCategorie] = useState<string>("all");
  const [selectedFournisseur, setSelectedFournisseur] = useState<string>("all");
  const [inStockOnly, setInStockOnly] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const pageSize = 50;

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [editingItem, setEditingItem] = useState<CatalogueItem | null>(null);
  const [importSheetOpen, setImportSheetOpen] = useState(false);

  // Debounced search
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const searchTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const handleSearchChange = (value: string) => {
    setSearchQuery(value);
    if (searchTimeoutRef.current) {
      clearTimeout(searchTimeoutRef.current);
    }
    searchTimeoutRef.current = setTimeout(() => {
      setDebouncedSearch(value);
      setCurrentPage(1);
    }, 300);
  };

  const filters = useMemo(
    () => ({
      search: debouncedSearch,
      categorie: selectedCategorie,
      sousCategorie: selectedSousCategorie,
      fournisseur: selectedFournisseur,
      inStockOnly,
      page: currentPage,
      pageSize,
    }),
    [debouncedSearch, selectedCategorie, selectedSousCategorie, selectedFournisseur, inStockOnly, currentPage]
  );

  const { data, isLoading, isFetching, error, refetch } = useQuery(catalogueQuery(filters));
  const { data: fournisseurs } = useQuery(fournisseursQuery());
  const { data: categoriesMap } = useQuery(categoriesQuery());

  const totalPages = Math.ceil((data?.total || 0) / pageSize);

  // ============================================================
  // CREATE ITEM
  // ============================================================

  const form = useForm<CreateItemForm>({
    resolver: zodResolver(createItemSchema),
    defaultValues: {
      fournisseur_id: "",
      designation: "",
      categorie: "",
      sous_categorie: "",
      unite: "",
      prix_fourniture: 0,
    },
  });

  const createItemMutation = useMutation({
    mutationFn: async (data: any) => {
      let imageUrl: string | null = data.existingImageUrl ?? null;
      if (data.imageFile) {
        setIsUploadingImage(true);
        try {
          imageUrl = await uploadCatalogueImage(data.imageFile, data.fournisseur_id);
        } finally {
          setIsUploadingImage(false);
        }
      } else if (data.imageRemoved) {
        imageUrl = null;
      }

      const { data: newItem, error } = await supabase
        .from("materiel_catalogue")
        .insert({
          fournisseur_id: data.fournisseur_id,
          designation: data.designation,
          categorie: data.categorie || null,
          sous_categorie: data.sous_categorie || null,
          unite: data.unite,
          prix_fourniture: data.prix_fourniture,
          specs: data.specs || {},
          statut: "brouillon" as const,
          image_url: imageUrl,
        })
        .select()
        .single();

      if (error) throw error;
      return newItem;
    },
    onSuccess: (newItem) => {
      toast.success("Article ajouté au catalogue");
      void logActivity({
        action: "create",
        entity_type: "materiel_catalogue",
        entity_id: newItem.id,
        details: { designation: newItem.designation },
      });
      queryClient.invalidateQueries({ queryKey: ["catalogue"] });
      setCreateDialogOpen(false);
      form.reset();
      refetch();
    },
    onError: (error: Error) => {
      toast.error("Erreur lors de l'ajout", { description: error.message });
    },
  });

  // ============================================================
  // EDIT ITEM
  // ============================================================

  const editItemMutation = useMutation({
    mutationFn: async ({ id, data }: { id: string; data: any }) => {
      const oldImageUrl: string | null = data.existingImageUrl ?? null;
      let imageUrl: string | null = oldImageUrl;
      // Whether the old file in storage is now orphaned and should be
      // removed once the item has been safely updated to point elsewhere.
      let staleImageUrl: string | null = null;

      if (data.imageFile) {
        setIsUploadingImage(true);
        try {
          // Upload the new image first. If this throws, mutationFn throws
          // too, before touching the row or deleting anything -- the item
          // keeps its old (still valid) image_url.
          imageUrl = await uploadCatalogueImage(data.imageFile, data.fournisseur_id);
        } finally {
          setIsUploadingImage(false);
        }
        if (oldImageUrl && oldImageUrl !== imageUrl) {
          staleImageUrl = oldImageUrl;
        }
      } else if (data.imageRemoved) {
        imageUrl = null;
        if (oldImageUrl) {
          staleImageUrl = oldImageUrl;
        }
      }

      const { error } = await supabase
        .from("materiel_catalogue")
        .update({
          fournisseur_id: data.fournisseur_id,
          designation: data.designation,
          categorie: data.categorie || null,
          sous_categorie: data.sous_categorie || null,
          unite: data.unite,
          prix_fourniture: data.prix_fourniture,
          specs: data.specs || {},
          date_maj: new Date().toISOString(),
          image_url: imageUrl,
        })
        .eq("id", id);

      if (error) throw error;

      // Only delete the old file once the row has actually been updated to
      // stop referencing it, so a failed update never leaves the item
      // pointing at a file that no longer exists. Best-effort: an orphaned
      // file here just wastes storage, it never corrupts app state.
      if (staleImageUrl) {
        await deleteCatalogueImage(staleImageUrl);
      }
    },
    onSuccess: (_result, variables) => {
      toast.success("Article modifié");
      void logActivity({
        action: "update",
        entity_type: "materiel_catalogue",
        entity_id: variables.id,
        details: { designation: variables.data.designation },
      });
      queryClient.invalidateQueries({ queryKey: ["catalogue"] });
      setEditDialogOpen(false);
      setEditingItem(null);
      refetch();
    },
    onError: (error: Error) => {
      toast.error("Erreur lors de la modification", { description: error.message });
    },
  });

  const openEditDialog = (item: CatalogueItem) => {
    setEditingItem(item);
    setEditDialogOpen(true);
  };

  // Import fournisseur selection, file parsing/mapping, preview, and the
  // bulk-insert mutation all live in <CatalogueImportPanel>, shared with
  // the standalone /import route (see src/lib/catalogueImport.ts).

  // ============================================================
  // PAGINATION HELPERS
  // ============================================================

  const goToPage = (page: number) => {
    setCurrentPage(Math.max(1, Math.min(page, totalPages)));
  };

  // ============================================================
  // RENDER - LOADING
  // ============================================================

  if (isLoading && !data) {
    return (
      <div className="space-y-6">
        <PageHeader
          title="Catalogue"
          description="Parcourez et gérez votre catalogue fournisseurs"
          action={<Skeleton className="h-9 w-40" />}
        />
        <div className="flex flex-wrap gap-4">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-10 w-40" />
          <Skeleton className="h-10 w-40" />
          <Skeleton className="ml-auto h-10 w-32" />
        </div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-64" />
          ))}
        </div>
      </div>
    );
  }

  // ============================================================
  // RENDER - ERROR
  // ============================================================

  if (error) {
    return (
      <div className="p-8 text-center">
        <p className="text-destructive">Erreur lors du chargement du catalogue</p>
        <p className="text-sm text-muted-foreground">{error.message}</p>
      </div>
    );
  }

  // ============================================================
  // RENDER
  // ============================================================

  const items = data?.items || [];
  const total = data?.total || 0;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Catalogue"
        description="Parcourez et gérez votre catalogue fournisseurs"
        action={
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setImportSheetOpen(true)}>
              <Upload className="mr-1 size-4" />
              Importer
            </Button>
            <Button onClick={() => setCreateDialogOpen(true)}>
              <Plus className="mr-1 size-4" />
              Ajouter un article
            </Button>
          </div>
        }
      />

      {/* Filters */}
      <Card>
        <CardContent className="p-4">
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-4">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  placeholder="Rechercher par désignation..."
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="pl-9"
                />
              </div>

              <Select
                value={selectedCategorie}
                onValueChange={(v) => {
                  setSelectedCategorie(v);
                  setSelectedSousCategorie("all");
                  setCurrentPage(1);
                }}
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Catégorie" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Toutes catégories</SelectItem>
                  {categoriesMap && Object.keys(categoriesMap).map((cat) => (
                    <SelectItem key={cat} value={cat}>
                      {cat}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={selectedSousCategorie}
                onValueChange={(v) => {
                  setSelectedSousCategorie(v);
                  setCurrentPage(1);
                }}
                disabled={selectedCategorie === "all"}
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Sous-catégorie" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Toutes sous-catégories</SelectItem>
                  {categoriesMap && selectedCategorie !== "all" && categoriesMap[selectedCategorie]?.map((sc) => (
                    <SelectItem key={sc} value={sc}>
                      {sc}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Select
                value={selectedFournisseur}
                onValueChange={(v) => {
                  setSelectedFournisseur(v);
                  setCurrentPage(1);
                }}
              >
                <SelectTrigger className="w-[180px]">
                  <SelectValue placeholder="Fournisseur" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">Tous fournisseurs</SelectItem>
                  {fournisseurs?.map((f) => (
                    <SelectItem key={f.id} value={f.id}>
                      {f.nom}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                variant={inStockOnly ? "default" : "outline"}
                size="sm"
                onClick={() => {
                  setInStockOnly(!inStockOnly);
                  setCurrentPage(1);
                }}
                className="whitespace-nowrap"
              >
                {inStockOnly ? "✓ En stock" : "En stock"}
              </Button>

              <div className="ml-auto flex items-center gap-1">
                <ToggleGroup type="single" value={viewMode} onValueChange={(v) => v && setViewMode(v as "grid" | "list")}>
                  <ToggleGroupItem value="grid" aria-label="Vue grille">
                    <Grid3x3 className="size-4" />
                  </ToggleGroupItem>
                  <ToggleGroupItem value="list" aria-label="Vue liste">
                    <List className="size-4" />
                  </ToggleGroupItem>
                </ToggleGroup>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Results count */}
      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          {total} article{total > 1 ? "s" : ""}
          {isFetching && <Loader2 className="size-3.5 animate-spin" />}
        </span>
        <span>
          Page {currentPage} / {totalPages}
        </span>
      </div>

      {/* Grid/List View */}
      {items.length === 0 ? (
        <EmptyState
          icon={Package}
          title="Aucun article dans le catalogue"
          description={searchQuery || selectedCategorie !== "all" ? "Aucun résultat ne correspond à vos filtres" : "Commencez par importer ou ajouter des articles"}
          action={
            <Button onClick={() => setImportSheetOpen(true)}>
              <Upload className="mr-1 size-4" />
              Importer
            </Button>
          }
        />
      ) : viewMode === "grid" ? (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {items.map((item) => (
            <CatalogueCard 
              key={item.id} 
              item={item} 
              onEdit={() => openEditDialog(item)}
            />
          ))}
        </div>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-3 font-medium">Désignation</th>
                    <th className="px-4 py-3 font-medium">Fournisseur</th>
                    <th className="px-4 py-3 font-medium">Catégorie</th>
                    <th className="px-4 py-3 font-medium text-right">Prix</th>
                    <th className="px-4 py-3 font-medium">Unité</th>
                    <th className="px-4 py-3 font-medium">Statut</th>
                    <th className="px-4 py-3 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id} className="border-t border-border hover:bg-muted/30">
                      <td className="px-4 py-3 font-medium">{item.designation}</td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {item.fournisseurs?.nom || "—"}
                      </td>
                      <td className="px-4 py-3 text-muted-foreground">
                        {item.categorie || "—"}
                        {item.sous_categorie && (
                          <span className="ml-1 text-xs text-muted-foreground/60">
                            / {item.sous_categorie}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">
                        {formatDinars(item.prix_fourniture)}
                      </td>
                      <td className="px-4 py-3">{item.unite}</td>
                      <td className="px-4 py-3">
                        <Badge variant={item.statut === "verifie" ? "default" : "secondary"}>
                          {item.statut === "verifie" ? "En stock" : "Brouillon"}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEditDialog(item)}
                          className="h-8 w-8 p-0"
                        >
                          <Edit2 className="size-4" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => goToPage(currentPage - 1)}
            disabled={currentPage === 1}
          >
            <ChevronLeft className="size-4" />
          </Button>
          <div className="flex gap-1">
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              let pageNum;
              if (totalPages <= 5) {
                pageNum = i + 1;
              } else if (currentPage <= 3) {
                pageNum = i + 1;
              } else if (currentPage >= totalPages - 2) {
                pageNum = totalPages - 4 + i;
              } else {
                pageNum = currentPage - 2 + i;
              }
              return (
                <Button
                  key={pageNum}
                  variant={currentPage === pageNum ? "default" : "outline"}
                  size="sm"
                  onClick={() => goToPage(pageNum)}
                  className="min-w-[36px]"
                >
                  {pageNum}
                </Button>
              );
            })}
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => goToPage(currentPage + 1)}
            disabled={currentPage === totalPages}
          >
            <ChevronRight className="size-4" />
          </Button>
        </div>
      )}

      {/* Create Dialog using reusable component */}
      <CatalogueItemForm
        open={createDialogOpen}
        onOpenChange={setCreateDialogOpen}
        onSubmit={createItemMutation.mutate}
        isPending={createItemMutation.isPending}
        isUploadingImage={isUploadingImage}
        fournisseurs={fournisseurs || []}
        categoriesMap={categoriesMap}
        title="Ajouter un article"
        description="Ajoutez un nouvel article au catalogue."
        submitLabel="Ajouter"
      />

      {/* Edit Dialog using reusable component */}
      <CatalogueItemForm
        open={editDialogOpen}
        onOpenChange={setEditDialogOpen}
        onSubmit={(data) => {
          if (editingItem) {
            editItemMutation.mutate({ id: editingItem.id, data });
          }
        }}
        isPending={editItemMutation.isPending}
        isUploadingImage={isUploadingImage}
        fournisseurs={fournisseurs || []}
        categoriesMap={categoriesMap}
        initialData={editingItem || undefined}
        title="Modifier l'article"
        description="Modifiez les informations de l'article."
        submitLabel="Modifier"
      />

      {/* Import Sheet */}
      <Sheet open={importSheetOpen} onOpenChange={setImportSheetOpen}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Importer des articles</SheetTitle>
            <SheetDescription>
              Importez des articles depuis un fichier CSV ou Excel.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-6">
            <CatalogueImportPanel
              onCancel={() => setImportSheetOpen(false)}
              onImported={() => {
                setImportSheetOpen(false);
                refetch();
              }}
            />
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

// ============================================================
// CATALOGUE CARD
// ============================================================

function CatalogueCard({ item, onEdit }: { item: CatalogueItem; onEdit: () => void }) {
  const inStock = item.statut === "verifie";

  return (
    <Card className="h-full overflow-hidden">
      <CardContent className="p-4">
        <div className="mb-3 flex h-32 items-center justify-center rounded-md bg-muted/30 relative">
          {item.image_url ? (
            <img src={item.image_url} alt={item.designation} className="h-full w-full object-cover" />
          ) : (
            <ImageIcon className="size-12 text-muted-foreground/30" />
          )}
          <Button
            variant="ghost"
            size="sm"
            className="absolute top-2 right-2 h-8 w-8 p-0 bg-background/80 hover:bg-background"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            <Edit2 className="size-4" />
          </Button>
        </div>

        <div className="space-y-2">
          <h3 className="line-clamp-2 font-medium leading-tight">
            {item.designation}
          </h3>

          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Building2 className="size-3" />
            <span className="truncate">{item.fournisseurs?.nom || "—"}</span>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap gap-1">
              {item.categorie && (
                <Badge variant="secondary" className="text-xs">
                  {item.categorie}
                </Badge>
              )}
              {item.sous_categorie && (
                <Badge variant="outline" className="text-xs">
                  {item.sous_categorie}
                </Badge>
              )}
            </div>
            <Badge variant={inStock ? "default" : "secondary"} className="text-xs">
              {inStock ? "En stock" : "Brouillon"}
            </Badge>
          </div>

          <div className="flex items-end justify-between pt-2">
            <span className="text-sm text-muted-foreground">{item.unite}</span>
            <span className="text-lg font-semibold tabular-nums">
              {formatDinars(item.prix_fourniture)}
            </span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}