// src/components/catalogue/CatalogueImportPanel.tsx
import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertCircle, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  fournisseursListQuery,
  createFournisseurSchema,
  type CreateFournisseurForm,
  type ImportedItem,
  parseImportFile,
  isValidImportItem,
  insertCatalogueImport,
  insertFournisseur,
} from "@/lib/catalogueImport";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DialogFooter } from "@/components/ui/dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
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
import { formatDinars } from "@/lib/format";
import { logActivity } from "@/lib/activitylog";

interface CatalogueImportPanelProps {
  /** Called when the user cancels the import (state is reset before this fires). */
  onCancel: () => void;
  /** Called after a successful bulk import (state is reset before this fires). */
  onImported: () => void;
}

export function CatalogueImportPanel({ onCancel, onImported }: CatalogueImportPanelProps) {
  const queryClient = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [newFournisseurOpen, setNewFournisseurOpen] = useState(false);
  const [importData, setImportData] = useState<ImportedItem[]>([]);
  const [importHeaders, setImportHeaders] = useState<string[]>([]);
  const [selectedImportFournisseur, setSelectedImportFournisseur] = useState<string>("");

  const { data: fournisseurs } = useQuery(fournisseursListQuery());

  const fournisseurForm = useForm<CreateFournisseurForm>({
    resolver: zodResolver(createFournisseurSchema),
    defaultValues: {
      nom: "",
      contact: "",
      telephone: "",
      email: "",
    },
  });

  const resetImportState = () => {
    setImportData([]);
    setImportHeaders([]);
    setSelectedImportFournisseur("");
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  // ============================================================
  // CREATE FOURNISSEUR (inline, from the import flow)
  // ============================================================

  const createFournisseurMutation = useMutation({
    mutationFn: insertFournisseur,
    onSuccess: (newFournisseur) => {
      toast.success("Fournisseur créé");
      void logActivity({
        action: "create",
        entity_type: "fournisseur",
        entity_id: newFournisseur.id,
        details: { nom: newFournisseur.nom },
      });
      queryClient.invalidateQueries({ queryKey: ["fournisseurs-list"] });
      setSelectedImportFournisseur(newFournisseur.id);
      setNewFournisseurOpen(false);
      fournisseurForm.reset();
    },
    onError: (error: Error) => {
      toast.error("Erreur lors de la création du fournisseur", {
        description: error.message,
      });
    },
  });

  // ============================================================
  // FILE UPLOAD
  // ============================================================

  const handleFileUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const { headers, items } = await parseImportFile(file);
      setImportHeaders(headers);
      setImportData(items);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erreur lors de la lecture du fichier");
    }
  };

  // ============================================================
  // BULK IMPORT
  // ============================================================

  const importMutation = useMutation({
    mutationFn: ({ fournisseurId, items }: { fournisseurId: string; items: ImportedItem[] }) =>
      insertCatalogueImport(fournisseurId, items),
    onSuccess: (inserted, variables) => {
      toast.success(`${inserted?.length || 0} articles importés avec succès`);
      void logActivity({
        action: "create",
        entity_type: "materiel_catalogue",
        entity_id: null,
        details: { bulk: true, fournisseur_id: variables.fournisseurId, nb_articles: inserted?.length ?? 0 },
      });
      queryClient.invalidateQueries({ queryKey: ["catalogue"] });
      resetImportState();
      onImported();
    },
    onError: (error: Error) => {
      toast.error("Erreur lors de l'import", { description: error.message });
    },
  });

  const validItems = importData.filter(isValidImportItem);
  const skippedCount = importData.length - validItems.length;

  return (
    <div className="space-y-6">
      <div>
        <h4 className="mb-2 text-sm font-medium">1. Sélectionnez un fournisseur</h4>
        <div className="flex gap-2">
          <Select
            onValueChange={(value) => {
              if (value === "__new__") {
                setNewFournisseurOpen(true);
              } else {
                setSelectedImportFournisseur(value);
              }
            }}
            value={selectedImportFournisseur}
          >
            <SelectTrigger className="flex-1">
              <SelectValue placeholder="Sélectionner un fournisseur" />
            </SelectTrigger>
            <SelectContent>
              {fournisseurs?.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.nom}
                </SelectItem>
              ))}
              <SelectItem value="__new__" className="text-primary">
                + Nouveau fournisseur
              </SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div>
        <h4 className="mb-2 text-sm font-medium">2. Téléchargez votre fichier</h4>
        <div className="flex items-center gap-4">
          <Input
            ref={fileInputRef}
            type="file"
            accept=".csv,.xlsx,.xls"
            onChange={handleFileUpload}
            className="flex-1"
          />
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Formats supportés: .csv, .xlsx, .xls
        </p>
      </div>

      {importData.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-medium">
            3. Aperçu ({importData.length} lignes)
          </h4>
          <div className="max-h-96 overflow-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="sticky top-0 bg-muted">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Désignation</th>
                  <th className="px-3 py-2 text-left font-medium">Catégorie</th>
                  <th className="px-3 py-2 text-left font-medium">Sous-catégorie</th>
                  <th className="px-3 py-2 text-right font-medium">Prix</th>
                  <th className="px-3 py-2 text-left font-medium">Unité</th>
                  <th className="px-3 py-2 text-center font-medium">Valide</th>
                </tr>
              </thead>
              <tbody>
                {importData.slice(0, 20).map((item, i) => {
                  const valid = isValidImportItem(item);
                  return (
                    <tr key={i} className={!valid ? "bg-destructive/5" : ""}>
                      <td className="px-3 py-1.5">{item.designation || "—"}</td>
                      <td className="px-3 py-1.5">{item.categorie || "—"}</td>
                      <td className="px-3 py-1.5">{item.sous_categorie || "—"}</td>
                      <td className="px-3 py-1.5 text-right font-mono">
                        {item.prix_fourniture > 0 ? formatDinars(item.prix_fourniture) : "—"}
                      </td>
                      <td className="px-3 py-1.5">{item.unite || "—"}</td>
                      <td className="px-3 py-1.5 text-center">
                        {valid ? (
                          <Check className="mx-auto size-4 text-success" />
                        ) : (
                          <AlertCircle className="mx-auto size-4 text-destructive" />
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {importData.length > 20 && (
              <div className="py-2 text-center text-sm text-muted-foreground">
                + {importData.length - 20} autres lignes
              </div>
            )}
          </div>
          <div className="mt-2 text-sm">
            <span className="text-muted-foreground">Lignes valides: {validItems.length}</span>
            <span className="ml-4 text-muted-foreground">Lignes ignorées: {skippedCount}</span>
          </div>
        </div>
      )}

      <DialogFooter className="mt-6">
        <Button
          variant="outline"
          onClick={() => {
            resetImportState();
            onCancel();
          }}
        >
          Annuler
        </Button>
        <Button
          onClick={() => {
            if (!selectedImportFournisseur) {
              toast.error("Veuillez sélectionner un fournisseur");
              return;
            }
            if (validItems.length === 0) {
              toast.error("Aucune ligne valide à importer");
              return;
            }
            importMutation.mutate({
              fournisseurId: selectedImportFournisseur,
              items: validItems,
            });
          }}
          disabled={importData.length === 0 || importMutation.isPending}
        >
          {importMutation.isPending ? (
            <>
              <Loader2 className="mr-2 size-4 animate-spin" />
              Importation...
            </>
          ) : (
            "Importer"
          )}
        </Button>
      </DialogFooter>

      {/* Nested fournisseur creation */}
      <Dialog open={newFournisseurOpen} onOpenChange={setNewFournisseurOpen}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>Nouveau fournisseur</DialogTitle>
            <DialogDescription>
              Créez un fournisseur pour l'ajouter à la sélection.
            </DialogDescription>
          </DialogHeader>

          <Form {...fournisseurForm}>
            <form
              onSubmit={fournisseurForm.handleSubmit((data) => createFournisseurMutation.mutate(data))}
              className="space-y-4"
            >
              <FormField
                control={fournisseurForm.control}
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
                control={fournisseurForm.control}
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

              <div className="grid grid-cols-2 gap-4">
                <FormField
                  control={fournisseurForm.control}
                  name="telephone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Téléphone</FormLabel>
                      <FormControl>
                        <Input placeholder="Numéro" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={fournisseurForm.control}
                  name="email"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Email</FormLabel>
                      <FormControl>
                        <Input type="email" placeholder="email@..." {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setNewFournisseurOpen(false)}>
                  Annuler
                </Button>
                <Button type="submit" disabled={createFournisseurMutation.isPending}>
                  {createFournisseurMutation.isPending ? "Création..." : "Créer"}
                </Button>
              </DialogFooter>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}