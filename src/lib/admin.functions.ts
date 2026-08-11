import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const roleSchema = z.enum(["admin", "membre"]);

async function assertAdmin(supabase: {
  from: (t: string) => {
    select: (c: string) => {
      eq: (
        c: string,
        v: string,
      ) => { eq: (c2: string, v2: string) => { maybeSingle: () => Promise<{ data: unknown }> } };
    };
  };
}, userId: string) {
  const { data } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("Accès réservé aux administrateurs");
}

/**
 * Records a row in `activity_logs` for the Journal d'activité page.
 * Uses the service-role client (bypasses RLS) since this runs inside
 * server functions that already own the mutation. Fire-and-forget:
 * a logging failure must never fail the calling mutation.
 */
async function logActivity(
  supabaseAdmin: {
    from: (table: string) => { insert: (row: Record<string, unknown>) => Promise<{ error: unknown }> };
  },
  params: {
    actorId: string | null;
    action: string;
    entity_type: string;
    entity_id?: string | null;
    details?: Record<string, unknown> | null;
  },
) {
  try {
    const { error } = await supabaseAdmin.from("activity_logs").insert({
      user_id: params.actorId,
      action: params.action,
      entity_type: params.entity_type,
      entity_id: params.entity_id ?? null,
      details: params.details ?? null,
    });
    if (error) console.error("logActivity failed:", error);
  } catch (err) {
    console.error("logActivity failed:", err);
  }
}

export const needsFirstAdmin = createServerFn({ method: "GET" }).handler(async () => {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { count } = await supabaseAdmin
    .from("profiles")
    .select("id", { count: "exact", head: true });
  return { needed: (count ?? 0) === 0 };
});

export const createTeamUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z
      .object({
        email: z.string().trim().email().max(255),
        password: z.string().min(8).max(72),
        nom: z.string().trim().max(120).optional(),
        role: roleSchema,
      })
      .parse(data),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase as never, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { nom: data.nom ?? data.email.split("@")[0] ?? "", role: data.role },
    });
    if (error) throw new Error(error.message);

    const userId = created.user?.id;
    if (!userId) throw new Error("Création impossible");

    await supabaseAdmin.from("profiles").upsert({
      id: userId,
      email: data.email,
      nom: data.nom ?? data.email.split("@")[0] ?? null,
      actif: true,
    });
    await supabaseAdmin.from("user_roles").delete().eq("user_id", userId);
    await supabaseAdmin.from("user_roles").insert({ user_id: userId, role: data.role });

    await logActivity(supabaseAdmin, {
      actorId: context.userId,
      action: "create",
      entity_type: "user",
      entity_id: userId,
      details: { email: data.email, role: data.role },
    });

    return { ok: true, id: userId };
  });

export const setUserRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z.object({ userId: z.string().uuid(), role: roleSchema }).parse(data),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase as never, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    await supabaseAdmin.from("user_roles").delete().eq("user_id", data.userId);
    const { error } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: data.userId, role: data.role });
    if (error) throw new Error(error.message);

    await logActivity(supabaseAdmin, {
      actorId: context.userId,
      action: "update",
      entity_type: "user",
      entity_id: data.userId,
      details: { role: data.role },
    });

    return { ok: true };
  });

export const setUserActive = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) =>
    z.object({ userId: z.string().uuid(), actif: z.boolean() }).parse(data),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.supabase as never, context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("profiles")
      .update({ actif: data.actif })
      .eq("id", data.userId);
    if (error) throw new Error(error.message);
    await supabaseAdmin.auth.admin.updateUserById(data.userId, {
      ban_duration: data.actif ? "none" : "876000h",
    });

    await logActivity(supabaseAdmin, {
      actorId: context.userId,
      action: "update",
      entity_type: "user",
      entity_id: data.userId,
      details: { actif: data.actif },
    });

    return { ok: true };
  });


/** Creates the first account of the bureau with the admin role. No-op afterwards. */
export const createFirstAdmin = createServerFn({ method: "POST" })
  .inputValidator((data: unknown) =>
    z
      .object({
        email: z.string().trim().email().max(255),
        password: z.string().min(8).max(72),
        nom: z.string().trim().max(120).optional(),
      })
      .parse(data),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { count } = await supabaseAdmin
      .from("profiles")
      .select("id", { count: "exact", head: true });
    if ((count ?? 0) > 0) throw new Error("Un compte existe déjà : demandez une invitation.");

    const nom = data.nom ?? data.email.split("@")[0] ?? "";
    const { data: created, error } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      email_confirm: true,
      user_metadata: { nom, role: "admin" },
    });
    if (error) throw new Error(error.message);
    const userId = created.user?.id;
    if (!userId) throw new Error("Création impossible");

    await supabaseAdmin
      .from("profiles")
      .upsert({ id: userId, email: data.email, nom, actif: true });
    await supabaseAdmin.from("user_roles").delete().eq("user_id", userId);
    await supabaseAdmin.from("user_roles").insert({ user_id: userId, role: "admin" });

    // No `context.userId` here (no auth middleware, by design — this is the
    // very first account) so the actor is the account being created.
    await logActivity(supabaseAdmin, {
      actorId: userId,
      action: "create",
      entity_type: "user",
      entity_id: userId,
      details: { email: data.email, role: "admin", first_admin: true },
    });

    return { ok: true };
  });