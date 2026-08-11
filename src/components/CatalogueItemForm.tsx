// src/components/catalogue/CatalogueItemForm.tsx
import { useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Plus, X, Image as ImageIcon, UploadCloud, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

const itemSchema = z.object({
  fournisseur_id: z.string().min(1, "Le fournisseur est requis"),
  designation: z.string().min(1, "La désignation est requise"),
  categorie: z.string().optional(),
  sous_categorie: z.string().optional(),
  unite: z.string().min(1, "L'unité est requise"),
  prix_fourniture: z.number().min(0, "Le prix doit être positif"),
});

type ItemFormData = z.infer<typeof itemSchema>;

interface CatalogueItemFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (data: any) => void;
  isPending: boolean;
  isUploadingImage?: boolean;
  fournisseurs: { id: string; nom: string }[];
  categoriesMap?: Record<string, string[]>;
  initialData?: {
    id?: string;
    fournisseur_id?: string;
    designation?: string;
    categorie?: string;
    sous_categorie?: string;
    unite?: string;
    prix_fourniture?: number;
    specs?: Record<string, any>;
    image_url?: string | null;
  };
  fournisseurId?: string;
  title?: string;
  description?: string;
  submitLabel?: string;
}

export function CatalogueItemForm({
  open,
  onOpenChange,
  onSubmit,
  isPending,
  isUploadingImage = false,
  fournisseurs,
  categoriesMap = {},
  initialData,
  fournisseurId,
  title = "Ajouter un article",
  description = "Ajoutez un nouvel article au catalogue.",
  submitLabel = "Ajouter",
}: CatalogueItemFormProps) {
  const [specs, setSpecs] = useState<{ name: string; value: string }[]>([{ name: "", value: "" }]);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [imageRemoved, setImageRemoved] = useState(false);
  const [isDraggingImage, setIsDraggingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>("");

  const form = useForm<ItemFormData>({
    resolver: zodResolver(itemSchema),
    defaultValues: {
      fournisseur_id: fournisseurId || "",
      designation: "",
      categorie: "",
      sous_categorie: "",
      unite: "",
      prix_fourniture: 0,
    },
  });

  // Reset form when initialData changes or dialog opens
  useEffect(() => {
    if (initialData && open) {
      form.reset({
        fournisseur_id: initialData.fournisseur_id || fournisseurId || "",
        designation: initialData.designation || "",
        categorie: initialData.categorie || "",
        sous_categorie: initialData.sous_categorie || "",
        unite: initialData.unite || "",
        prix_fourniture: initialData.prix_fourniture || 0,
      });
      setSelectedCategory(initialData.categorie || "");

      // Load specs
      if (initialData.specs && Object.keys(initialData.specs).length > 0) {
        const specEntries = Object.entries(initialData.specs).map(([name, value]) => ({
          name,
          value: String(value),
        }));
        setSpecs(specEntries.length > 0 ? specEntries : [{ name: "", value: "" }]);
      } else {
        setSpecs([{ name: "", value: "" }]);
      }

      // Load image preview
      if (initialData.image_url) {
        setImagePreview(initialData.image_url);
      } else {
        setImagePreview(null);
        setImageFile(null);
      }
      setImageRemoved(false);
    } else if (open && !initialData) {
      form.reset({
        fournisseur_id: fournisseurId || "",
        designation: "",
        categorie: "",
        sous_categorie: "",
        unite: "",
        prix_fourniture: 0,
      });
      setSelectedCategory("");
      setSpecs([{ name: "", value: "" }]);
      setImagePreview(null);
      setImageFile(null);
      setImageRemoved(false);
    }
  }, [open, initialData, fournisseurId, form]);

  const resetForm = () => {
    form.reset({
      fournisseur_id: fournisseurId || "",
      designation: "",
      categorie: "",
      sous_categorie: "",
      unite: "",
      prix_fourniture: 0,
    });
    setSelectedCategory("");
    setSpecs([{ name: "", value: "" }]);
    setImagePreview(null);
    setImageFile(null);
    setImageRemoved(false);
  };

  const addSpecRow = () => {
    setSpecs([...specs, { name: "", value: "" }]);
  };

  const removeSpecRow = (index: number) => {
    if (specs.length > 1) {
      setSpecs(specs.filter((_, i) => i !== index));
    }
  };

  const updateSpec = (index: number, field: "name" | "value", value: string) => {
    const updated = [...specs];
    updated[index][field] = value;
    setSpecs(updated);
  };

  const processImageFile = (file: File | undefined | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return;
    setImageFile(file);
    setImageRemoved(false);
    const reader = new FileReader();
    reader.onload = (event) => {
      setImagePreview(event.target?.result as string);
    };
    reader.readAsDataURL(file);
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    processImageFile(e.target.files?.[0]);
    // Allow re-selecting the same file later (e.g. after removing it)
    e.target.value = "";
  };

  const handleRemoveImage = () => {
    setImageFile(null);
    setImagePreview(null);
    // Only meaningful when editing an item that already had an image —
    // signals to the caller that image_url should be cleared, since no
    // new file replaces it.
    if (initialData?.image_url) {
      setImageRemoved(true);
    }
  };

  const handleImageDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDraggingImage(false);
    processImageFile(e.dataTransfer.files?.[0]);
  };

  const handleSubmit = (data: ItemFormData) => {
    // Build specs object
    const specsObj: Record<string, any> = {};
    specs.forEach((spec) => {
      if (spec.name && spec.value) {
        specsObj[spec.name] = spec.value;
      }
    });

    onSubmit({
      ...data,
      specs: specsObj,
      imageFile: imageFile,
      imageRemoved: imageRemoved,
      existingImageUrl: initialData?.image_url ?? null,
      id: initialData?.id,
    });
  };

  const getSubCategories = () => {
    if (!selectedCategory) return [];
    return categoriesMap[selectedCategory] || [];
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[600px] max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-4">
            {/* Fournisseur selector (only show if not in a specific fournisseur context) */}
            {!fournisseurId && (
              <FormField
                control={form.control}
                name="fournisseur_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Fournisseur *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Sélectionner un fournisseur" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {fournisseurs.map((f) => (
                          <SelectItem key={f.id} value={f.id}>
                            {f.nom}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            )}

            {/* Image Upload - not inside FormField to avoid context issues */}
            <div>
              <Label>Image</Label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleImageUpload}
                className="hidden"
              />
              {imagePreview ? (
                <div className="mt-2 flex items-center gap-4">
                  <div className="group relative h-24 w-24 shrink-0 overflow-hidden rounded-md border">
                    <img src={imagePreview} alt="Aperçu" className="h-full w-full object-cover" />
                    <button
                      type="button"
                      onClick={handleRemoveImage}
                      className="absolute -right-1 -top-1 rounded-full bg-destructive p-0.5 text-white hover:bg-destructive/90"
                      aria-label="Retirer l'image"
                    >
                      <X className="size-3" />
                    </button>
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="absolute inset-0 flex items-center justify-center bg-black/0 text-transparent transition-colors group-hover:bg-black/50 group-hover:text-white"
                    >
                      <span className="text-xs font-medium">Remplacer</span>
                    </button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Cliquez sur l'image pour la remplacer, ou sur le X pour la retirer.
                  </p>
                </div>
              ) : (
                <div
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setIsDraggingImage(true);
                  }}
                  onDragLeave={() => setIsDraggingImage(false)}
                  onDrop={handleImageDrop}
                  className={cn(
                    "mt-2 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-4 py-6 text-center transition-colors",
                    isDraggingImage
                      ? "border-primary bg-primary/5"
                      : "border-muted-foreground/25 hover:border-muted-foreground/50 hover:bg-muted/30",
                  )}
                >
                  <div className="flex size-12 items-center justify-center rounded-full bg-muted">
                    {isDraggingImage ? (
                      <UploadCloud className="size-6 text-primary" />
                    ) : (
                      <ImageIcon className="size-6 text-muted-foreground" />
                    )}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    Glissez-déposez une image ici, ou{" "}
                    <span className="font-medium text-foreground underline underline-offset-2">
                      cliquez pour parcourir
                    </span>
                  </p>
                  <p className="text-xs text-muted-foreground">PNG, JPG, WEBP…</p>
                </div>
              )}
            </div>

            <FormField
              control={form.control}
              name="designation"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Désignation *</FormLabel>
                  <FormControl>
                    <Input placeholder="Nom de l'article" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="categorie"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Catégorie</FormLabel>
                    <Select
                      onValueChange={(value) => {
                        field.onChange(value);
                        setSelectedCategory(value);
                        // Reset sous-categorie when category changes
                        form.setValue("sous_categorie", "");
                      }}
                      value={field.value || ""}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Sélectionner" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="">Aucune</SelectItem>
                        {Object.keys(categoriesMap).map((cat) => (
                          <SelectItem key={cat} value={cat}>
                            {cat}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="sous_categorie"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Sous-catégorie</FormLabel>
                    <Select
                      onValueChange={field.onChange}
                      value={field.value || ""}
                      disabled={!selectedCategory}
                    >
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Sélectionner" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="">Aucune</SelectItem>
                        {getSubCategories().map((sub) => (
                          <SelectItem key={sub} value={sub}>
                            {sub}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <FormField
                control={form.control}
                name="unite"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Unité *</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger>
                          <SelectValue placeholder="Sélectionner" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="u">u</SelectItem>
                        <SelectItem value="m">m</SelectItem>
                        <SelectItem value="m²">m²</SelectItem>
                        <SelectItem value="m³">m³</SelectItem>
                        <SelectItem value="kg">kg</SelectItem>
                        <SelectItem value="L">L</SelectItem>
                        <SelectItem value="Ens">Ens</SelectItem>
                        <SelectItem value="ML">ML</SelectItem>
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="prix_fourniture"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Prix fourniture (TND) *</FormLabel>
                    <FormControl>
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        placeholder="0.00"
                        onChange={(e) => field.onChange(parseFloat(e.target.value) || 0)}
                        value={field.value || ""}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
            </div>

            {/* Specs - not inside FormField to avoid context issues */}
            <div>
              <div className="flex items-center justify-between">
                <Label>Spécifications</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={addSpecRow}
                >
                  <Plus className="mr-1 size-3" />
                  Ajouter
                </Button>
              </div>
              <div className="mt-2 space-y-2">
                {specs.map((spec, index) => (
                  <div key={index} className="flex items-center gap-2">
                    <Input
                      placeholder="Nom"
                      value={spec.name}
                      onChange={(e) => updateSpec(index, "name", e.target.value)}
                      className="flex-1"
                    />
                    <Input
                      placeholder="Valeur"
                      value={spec.value}
                      onChange={(e) => updateSpec(index, "value", e.target.value)}
                      className="flex-1"
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => removeSpecRow(index)}
                      disabled={specs.length <= 1}
                      className="text-destructive hover:text-destructive"
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  onOpenChange(false);
                  resetForm();
                }}
              >
                Annuler
              </Button>
              <Button type="submit" disabled={isPending || isUploadingImage}>
                {(isPending || isUploadingImage) && (
                  <Loader2 className="mr-2 size-4 animate-spin" />
                )}
                {isUploadingImage
                  ? "Envoi de l'image..."
                  : isPending
                    ? "En cours..."
                    : submitLabel}
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}