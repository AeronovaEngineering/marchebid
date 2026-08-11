import { Link, useRouter, useLocation } from "@tanstack/react-router";
import { Building2, BookOpen, Users, Upload, LogOut, HardHat, Menu, X } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentUser } from "@/hooks/useCurrentUser";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useState } from "react";

const nav = [
  { to: "/chantiers", label: "Chantiers", icon: Building2, adminOnly: false, section: "Chiffrage" },
  { to: "/catalogue", label: "Catalogue", icon: BookOpen, adminOnly: false, section: "Chiffrage" },
  { to: "/fourniseeur", label: "fourniseeur", icon: Users, adminOnly: false, section: "Chiffrage" },
  { to: "/import", label: "Import catalogue", icon: Upload, adminOnly: true, section: "Administration" },
  { to: "/utilisateurs", label: "Utilisateurs", icon: Users, adminOnly: true, section: "Administration" },
];

export function AppSidebar() {
  const { data: user } = useCurrentUser();
  const isAdmin = user?.role === "admin";
  const router = useRouter();
  const location = useLocation();
  const queryClient = useQueryClient();
  const [mobileOpen, setMobileOpen] = useState(false);

  async function signOut() {
    await queryClient.cancelQueries();
    queryClient.clear();
    await supabase.auth.signOut();
    router.navigate({ to: "/auth", replace: true });
  }

  const visible = nav.filter((item) => !item.adminOnly || isAdmin);
  const grouped = visible.reduce<Record<string, typeof visible>>((acc, item) => {
    const s = item.section;
    (acc[s] ||= []).push(item);
    return acc;
  }, {});

  const sidebarContent = (
    <aside className="flex h-full w-60 shrink-0 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2 px-5 py-5">
        <div className="flex size-8 items-center justify-center rounded-md bg-sidebar-primary text-sidebar-primary-foreground">
          <HardHat className="size-4" />
        </div>
        <div className="leading-tight">
          <p className="text-sm font-semibold text-sidebar-accent-foreground">AeroNova BID</p>
          <p className="text-[11px] text-sidebar-foreground/60">Bureau d'études</p>
        </div>
      </div>

      <nav className="flex-1 space-y-4 px-3">
        {Object.entries(grouped).map(([section, items]) => (
          <div key={section}>
            <div className="px-2 mb-1.5 text-[10px] uppercase tracking-wider text-sidebar-foreground/50 font-medium">
              {section}
            </div>
            <div className="space-y-0.5">
              {items.map((item) => {
                const active = location.pathname === item.to || location.pathname.startsWith(item.to + "/");
                const Icon = item.icon;
                return (
                  <Link
                    key={item.to}
                    to={item.to}
                    onClick={() => setMobileOpen(false)}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                      active
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
                    )}
                  >
                    <Icon className="size-4" />
                    {item.label}
                  </Link>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      <div className="border-t border-sidebar-border p-3">
        <div className="px-2 pb-2">
          <p className="truncate text-xs font-medium text-sidebar-accent-foreground">
            {user?.profile?.nom ?? user?.email}
          </p>
          <p className="text-[11px] uppercase tracking-wide text-sidebar-foreground/50">
            {isAdmin ? "Administrateur" : "Membre"}
          </p>
        </div>
        <button
          onClick={signOut}
          className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm text-sidebar-foreground/80 transition-colors hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
        >
          <LogOut className="size-4" />
          Déconnexion
        </button>
      </div>
    </aside>
  );

  return (
    <>
      {/* Mobile hamburger button */}
      <div className="lg:hidden sticky top-0 z-20 flex items-center justify-between px-4 h-14 bg-background border-b border-border">
        <div className="flex items-center gap-2">
          <div className="flex size-7 items-center justify-center rounded bg-sidebar-primary text-sidebar-primary-foreground">
            <HardHat className="size-3.5" />
          </div>
          <span className="font-semibold text-sm">AeroNova BID</span>
        </div>
        <Button variant="ghost" size="icon" onClick={() => setMobileOpen((v) => !v)}>
          {mobileOpen ? <X className="size-5" /> : <Menu className="size-5" />}
        </Button>
      </div>

      {/* Desktop sidebar */}
      <div className="hidden lg:flex fixed inset-y-0 left-0 z-30">
        {sidebarContent}
      </div>

      {/* Mobile drawer overlay */}
      {mobileOpen && (
        <div className="lg:hidden fixed inset-0 z-40 bg-black/40" onClick={() => setMobileOpen(false)}>
          <div className="absolute inset-y-0 left-0" onClick={(e) => e.stopPropagation()}>
            {sidebarContent}
          </div>
        </div>
      )}
    </>
  );
}