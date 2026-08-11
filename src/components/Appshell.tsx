import { useState } from "react";
import { Link, useRouter } from "@tanstack/react-router";
import { Building2, BookOpen, Users, Upload, LogOut, HardHat, Menu, X, Settings, ScrollText, UserCog } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetOverlay,
  SheetPortal,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";

const navGroups = [
  {
    label: "Chiffrage",
    adminOnly: false,
    items: [
      { to: "/chantiers", label: "Chantiers", icon: Building2 },
      { to: "/catalogue", label: "Catalogue", icon: BookOpen },
      { to: "/fournisseur", label: "Fournisseurs", icon: Users },
    ],
  },
  {
    label: "Administration",
    adminOnly: true,
    items: [
      { to: "/import", label: "Import catalogue", icon: Upload },
      { to: "/utilisateurs", label: "Utilisateurs", icon: UserCog },
      { to: "/parametres", label: "Paramètres société", icon: Settings },
      { to: "/journal", label: "Journal d'activité", icon: ScrollText },
    ],
  },
  {
    label: "Mon compte",
    adminOnly: false,
    items: [
      { to: "/profil", label: "Mon profil", icon: UserCog },
    ],
  },
];

interface SidebarContentProps {
  user: any;
  onSignOut: () => Promise<void>;
  onLinkClick?: () => void;
}

function SidebarContent({ user, onSignOut, onLinkClick }: SidebarContentProps) {
  return (
    <>
      {/* Brand */}
      <div className="flex items-center gap-2 px-5 py-5">
        <div className="flex size-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
          <HardHat className="size-4" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold text-sidebar-accent-foreground">
            AeroNova BID
          </p>
          <p className="text-[11px] text-sidebar-foreground/60">Bureau d'études</p>
        </div>
      </div>

      {/* Nav */}
      <nav className="flex-1 space-y-6 px-3 py-4">
        {navGroups.map((group) => {
          const shouldShow = !group.adminOnly || user?.role === "admin";
          if (!shouldShow) return null;

          return (
            <div key={group.label}>
              <p className="px-2 text-[10px] uppercase tracking-wider text-sidebar-foreground/50 font-semibold">
                {group.label}
              </p>
              <div className="mt-2 space-y-0.5">
                {group.items.map((item) => (
                  <Link
                    key={item.to}
                    to={item.to}
                    onClick={onLinkClick}
                    activeProps={{
                      className: "bg-sidebar-accent text-sidebar-accent-foreground",
                    }}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                    )}
                  >
                    <item.icon className="size-4" />
                    {item.label}
                  </Link>
                ))}
              </div>
            </div>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="border-t border-sidebar-border p-3">
        <div className="px-2 pb-2">
          <p className="truncate text-xs font-medium text-sidebar-accent-foreground">
            {user?.profile?.nom ?? user?.email}
          </p>
          <p className="text-[11px] uppercase tracking-wide text-sidebar-foreground/50">
            {user?.role === "admin" ? "Administrateur" : "Membre"}
          </p>
        </div>
        <button
          onClick={onSignOut}
          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
        >
          <LogOut className="size-4" />
          Déconnexion
        </button>
      </div>
    </>
  );
}

interface AppShellProps {
  children: React.ReactNode;
}

export function AppShell({ children }: AppShellProps) {
  const { data: user } = useCurrentUser();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [mobileOpen, setMobileOpen] = useState(false);

  async function signOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    router.navigate({ to: "/auth", replace: true });
  }

  const handleMobileLinkClick = () => {
    setMobileOpen(false);
  };

  return (
    <div className="flex min-h-screen w-full bg-background">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground fixed inset-y-0 left-0 z-40">
        <SidebarContent user={user} onSignOut={signOut} />
      </aside>

      {/* Mobile Top Bar */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 h-14 bg-sidebar text-sidebar-foreground border-b border-sidebar-border flex items-center px-4">
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="mr-2 text-sidebar-foreground hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
            >
              <Menu className="size-5" />
              <span className="sr-only">Toggle menu</span>
            </Button>
          </SheetTrigger>
          <SheetPortal>
            <SheetOverlay className="bg-black/40" />
            <SheetContent
              side="left"
              className="w-72 p-0 bg-sidebar text-sidebar-foreground border-r border-sidebar-border"
            >
              <SidebarContent
                user={user}
                onSignOut={signOut}
                onLinkClick={handleMobileLinkClick}
              />
            </SheetContent>
          </SheetPortal>
        </Sheet>

        {/* Mobile Brand Mark */}
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
            <HardHat className="size-3.5" />
          </div>
          <div className="leading-tight">
            <p className="text-xs font-semibold text-sidebar-accent-foreground">
              AeroNova BID
            </p>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 lg:ml-60">
        <div className="lg:mt-0 mt-14 min-w-0">
          <div className="max-w-[1400px] mx-auto p-4 lg:p-8">
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}