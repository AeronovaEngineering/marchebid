import { createFileRoute, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { HardHat, Loader2, ShieldCheck } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { createFirstAdmin, needsFirstAdmin } from "@/lib/admin.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/auth")({
  head: () => ({
    meta: [
      { title: "Connexion — Métré BTP" },
      { name: "description", content: "Accès réservé à l'équipe du bureau d'études." },
      { property: "og:title", content: "Connexion — Métré BTP" },
      { property: "og:description", content: "Accès réservé à l'équipe du bureau d'études." },
      { name: "robots", content: "noindex" },
    ],
  }),
  component: AuthPage,
});

function AuthPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [nom, setNom] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const checkFirst = useServerFn(needsFirstAdmin);
  const createAdmin = useServerFn(createFirstAdmin);
  const { data: first } = useQuery({
    queryKey: ["needs-first-admin"],
    queryFn: () => checkFirst(),
    staleTime: 0,
  });
  const isSetup = first?.needed === true;

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setLoading(true);
    setError(null);

    if (isSetup) {
      try {
        await createAdmin({ data: { email, password, nom: nom || undefined } });
      } catch (createError) {
        setLoading(false);
        setError(
          createError instanceof Error ? createError.message : "Création du compte impossible.",
        );
        return;
      }
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });
    setLoading(false);
    if (signInError) {
      setError("Identifiants invalides ou compte désactivé.");
      return;
    }
    router.navigate({ to: "/chantiers", replace: true });
  }

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <div className="hidden flex-col justify-between bg-sidebar p-12 text-sidebar-foreground lg:flex">
        <div className="flex items-center gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <HardHat className="size-5" />
          </div>
          <span className="text-sm font-semibold text-sidebar-accent-foreground">Métré BTP</span>
        </div>
        <div className="max-w-md">
          <h1 className="text-3xl font-semibold leading-tight text-sidebar-accent-foreground">
            Du marché client à la soumission chiffrée.
          </h1>
          <p className="mt-4 text-sm leading-relaxed text-sidebar-foreground/70">
            Importez le marché, remplissez les prix de fourniture et de pose depuis votre catalogue
            fournisseurs, et sortez le récapitulatif par chapitre.
          </p>
        </div>
        <p className="text-xs text-sidebar-foreground/40">Application interne — accès sur invitation</p>
      </div>

      <div className="flex items-center justify-center px-6 py-16">
        <form onSubmit={onSubmit} className="w-full max-w-sm space-y-5">
          <div>
            <h2 className="text-xl font-semibold">
              {isSetup ? "Créer le compte administrateur" : "Connexion"}
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              {isSetup
                ? "Premier compte du bureau : il reçoit le rôle administrateur et crée ensuite les autres comptes."
                : "Les comptes sont créés par un administrateur."}
            </p>
          </div>

          {isSetup && (
            <div className="space-y-2">
              <Label htmlFor="nom">Nom complet</Label>
              <Input
                id="nom"
                value={nom}
                onChange={(e) => setNom(e.target.value)}
                placeholder="Prénom Nom"
              />
            </div>
          )}

          <div className="space-y-2">
            <Label htmlFor="email">Adresse e-mail</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="prenom@bet.tn"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">Mot de passe</Label>
            <Input
              id="password"
              type="password"
              autoComplete={isSetup ? "new-password" : "current-password"}
              required
              minLength={isSetup ? 8 : undefined}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button type="submit" className="w-full" disabled={loading}>
            {loading && <Loader2 className="mr-2 size-4 animate-spin" />}
            {isSetup ? "Créer le compte et entrer" : "Se connecter"}
          </Button>

          {isSetup && (
            <p className="flex items-start gap-2 rounded-md border border-dashed border-accent bg-accent/10 p-3 text-xs text-muted-foreground">
              <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-accent-foreground" />
              Aucun compte n'existe encore. Mot de passe : 8 caractères minimum.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
