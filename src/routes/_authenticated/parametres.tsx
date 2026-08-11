// src/routes/_authenticated/parametres.tsx
import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { PageHeader } from "@/components/ui/pageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { toast } from "sonner";
import { Loader2, Lock } from "lucide-react";

// ============================================================
// TYPES
// ============================================================

type CompanySettings = {
  id: string;
  company_name: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  matricule_fiscal: string | null;
  rc: string | null;
  ccb: string | null;
  footer_address: string | null;
  default_vat_rate: number | null;
  fiscal_stamp: number | null;
  logo_url: string | null;
  created_at: string;
  updated_at: string;
};

// ============================================================
// ROUTE
// ============================================================

export const Route = createFileRoute("/_authenticated/parametres")({
  component: SettingsPage,
});

// ============================================================
// COMPONENT
// ============================================================

function SettingsPage() {
  const { data: user, isLoading: authLoading } = useCurrentUser();
  const queryClient = useQueryClient();
  const isAdmin = user?.role === "admin";

  const [form, setForm] = useState<Partial<CompanySettings>>({});
  const [busy, setBusy] = useState(false);

  // ============================================================
  // QUERY - Fetch settings (using a table if it exists)
  // ============================================================

  const q = useQuery({
    queryKey: ["company_settings"],
    enabled: isAdmin,
    queryFn: async (): Promise<CompanySettings | null> => {
      try {
        // Try to fetch from the database
        const { data, error } = await supabase
          .from("company_settings")
          .select("*")
          .eq("id", "1")
          .single();

        if (error) {
          // If table doesn't exist, use localStorage fallback
          console.warn("Company settings table not found, using localStorage");
          const stored = localStorage.getItem("company_settings");
          if (stored) {
            try {
              return JSON.parse(stored);
            } catch {
              return null;
            }
          }
          return null;
        }

        return data as CompanySettings;
      } catch (error) {
        // Fallback to localStorage
        const stored = localStorage.getItem("company_settings");
        if (stored) {
          try {
            return JSON.parse(stored);
          } catch {
            return null;
          }
        }
        return null;
      }
    },
  });

  // ============================================================
  // MUTATION - Save settings
  // ============================================================

  const saveMutation = useMutation({
    mutationFn: async (data: Partial<CompanySettings>) => {
      // Try to save to database first
      try {
        const { error } = await supabase
          .from("company_settings")
          .upsert({
            id: "1",
            company_name: data.company_name || null,
            address: data.address || null,
            phone: data.phone || null,
            email: data.email || null,
            matricule_fiscal: data.matricule_fiscal || null,
            rc: data.rc || null,
            ccb: data.ccb || null,
            footer_address: data.footer_address || null,
            default_vat_rate: data.default_vat_rate || null,
            fiscal_stamp: data.fiscal_stamp || null,
            logo_url: data.logo_url || null,
            updated_at: new Date().toISOString(),
          })
          .eq("id", "1");

        if (error) throw error;
        return { success: true, source: "database" };
      } catch (error) {
        // Fallback to localStorage
        console.warn("Saving to localStorage as fallback");
        localStorage.setItem("company_settings", JSON.stringify(data));
        return { success: true, source: "localStorage" };
      }
    },
    onSuccess: () => {
      toast.success("Paramètres enregistrés");
      queryClient.invalidateQueries({ queryKey: ["company_settings"] });
      setBusy(false);
    },
    onError: (error: Error) => {
      toast.error(error.message || "Erreur lors de l'enregistrement");
      setBusy(false);
    },
  });

  // ============================================================
  // EFFECT - Load settings into form
  // ============================================================

  useEffect(() => {
    if (q.data) {
      setForm(q.data);
    } else {
      // Default values
      setForm({
        company_name: "",
        address: "",
        phone: "",
        email: "",
        matricule_fiscal: "",
        rc: "",
        ccb: "",
        footer_address: "",
        default_vat_rate: 20,
        fiscal_stamp: 0,
        logo_url: "",
      });
    }
  }, [q.data]);

  // ============================================================
  // HANDLERS
  // ============================================================

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    const { name, value } = e.target;
    setForm((prev) => ({
      ...prev,
      [name]: value,
    }));
  };

  const handleNumberChange = (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    const { name, value } = e.target;
    setForm((prev) => ({
      ...prev,
      [name]: value === "" ? null : parseFloat(value),
    }));
  };

  const handleSave = () => {
    setBusy(true);
    saveMutation.mutate(form);
  };

  const bind = (key: keyof CompanySettings) => ({
    name: key,
    value: (form[key] as string | number | null | undefined) ?? "",
    onChange: handleChange,
  });

  const bindNumber = (key: keyof CompanySettings) => ({
    name: key,
    value: (form[key] as string | number | null | undefined) ?? "",
    onChange: handleNumberChange,
  });

  // ============================================================
  // LOADING / PERMISSION CHECK
  // ============================================================

  if (authLoading || q.isLoading) {
    return (
      <div className="flex min-h-[400px] items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <>
        <PageHeader title="Paramètres société" />
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
        title="Paramètres société"
        description="Informations affichées sur les documents."
        action={
          <Button onClick={handleSave} disabled={busy || saveMutation.isPending}>
            {busy || saveMutation.isPending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : null}
            Enregistrer
          </Button>
        }
      />

      <Card>
        <CardContent className="space-y-4 p-6">
          <div className="grid gap-4 md:grid-cols-2">
            {/* Company Name */}
            <div className="space-y-1.5">
              <Label htmlFor="company_name">Nom société</Label>
              <Input id="company_name" {...bind("company_name")} />
            </div>

            {/* Matricule Fiscal */}
            <div className="space-y-1.5">
              <Label htmlFor="matricule_fiscal">Matricule fiscal</Label>
              <Input id="matricule_fiscal" {...bind("matricule_fiscal")} />
            </div>

            {/* Address */}
            <div className="space-y-1.5">
              <Label htmlFor="address">Adresse (en-tête)</Label>
              <Input id="address" {...bind("address")} />
            </div>

            {/* Phone */}
            <div className="space-y-1.5">
              <Label htmlFor="phone">Téléphone</Label>
              <Input id="phone" {...bind("phone")} />
            </div>

            {/* Email */}
            <div className="space-y-1.5">
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" {...bind("email")} />
            </div>

            {/* RC */}
            <div className="space-y-1.5">
              <Label htmlFor="rc">R.C</Label>
              <Input id="rc" {...bind("rc")} />
            </div>

            {/* CCB */}
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="ccb">C.C.B (compte bancaire)</Label>
              <Textarea id="ccb" rows={2} {...bind("ccb")} />
            </div>

            {/* Footer Address */}
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="footer_address">Adresse pied de page</Label>
              <Textarea id="footer_address" rows={2} {...bind("footer_address")} />
            </div>

            {/* Default VAT */}
            <div className="space-y-1.5">
              <Label htmlFor="default_vat_rate">TVA par défaut (%)</Label>
              <Input
                id="default_vat_rate"
                type="number"
                step="0.01"
                {...bindNumber("default_vat_rate")}
              />
            </div>

            {/* Fiscal Stamp */}
            <div className="space-y-1.5">
              <Label htmlFor="fiscal_stamp">Timbre fiscal (DT)</Label>
              <Input
                id="fiscal_stamp"
                type="number"
                step="0.001"
                {...bindNumber("fiscal_stamp")}
              />
            </div>

            {/* Logo URL */}
            <div className="space-y-1.5 md:col-span-2">
              <Label htmlFor="logo_url">URL du logo (optionnel)</Label>
              <Input
                id="logo_url"
                placeholder="https://…"
                {...bind("logo_url")}
              />
            </div>
          </div>
        </CardContent>
      </Card>
    </>
  );
}