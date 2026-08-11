// src/lib/server/manageUsers.ts
//
// Server-side user management. Anything that touches supabase.auth.admin.*
// requires the service role key, which must never reach the browser, so
// these operations run inside TanStack Start server functions using the
// server-only admin client from client.server.ts.

import { createServerFn } from "@tanstack/react-start";

type AppRole = "admin" | "membre";

// ============================================================
// CREATE USER
// ============================================================

interface CreateUserInput {
  email: string;
  password: string;
  full_name: string;
  role: AppRole;
}

export const createUserServerFn = createServerFn({ method: "POST" })
  .validator((data: CreateUserInput) => {
    if (!data?.email || !data?.password || !data?.full_name) {
      throw new Error("Tous les champs sont requis");
    }
    if (data.password.length < 6) {
      throw new Error("Le mot de passe doit contenir au moins 6 caractères");
    }
    return data;
  })
  .handler(async ({ data }) => {
    // Dynamic import: this file is not itself a .server.ts module, so a
    // top-level import of client.server.ts could get pulled into the
    // client bundle. Loading it here keeps the service-role client
    // server-only, per client.server.ts's own instructions.
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // 1. Create the auth user via the Admin API (requires service role key).
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: data.email,
      password: data.password,
      user_metadata: { full_name: data.full_name },
      email_confirm: true,
    });

    if (authError) throw new Error(authError.message);
    if (!authData.user) throw new Error("Échec de la création de l'utilisateur");

    const userId = authData.user.id;

    // 2. Insert the profile row.
    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .insert({
        id: userId,
        email: data.email,
        nom: data.full_name,
        actif: true,
      });

    if (profileError) {
      // Profile insert failed after the auth user was already created.
      // Try to roll back the auth user so we don't leave an orphaned
      // account with no profile, then report clearly either way.
      const { error: cleanupError } = await supabaseAdmin.auth.admin.deleteUser(userId);
      if (cleanupError) {
        throw new Error(
          `Le profil n'a pas pu être créé (${profileError.message}) et le compte auth orphelin (${userId}) n'a pas pu être supprimé automatiquement (${cleanupError.message}). Une intervention manuelle est nécessaire.`,
        );
      }
      throw new Error(`Échec de la création du profil : ${profileError.message}`);
    }

    // 3. Assign the role.
    const { error: roleError } = await supabaseAdmin
      .from("user_roles")
      .insert({
        user_id: userId,
        role: data.role,
      });

    if (roleError) {
      // Auth user + profile exist, but the role assignment failed.
      // Don't roll back the whole user for this — surface a clear,
      // specific error so an admin can assign the role manually.
      throw new Error(
        `Utilisateur et profil créés, mais l'attribution du rôle "${data.role}" a échoué : ${roleError.message}. Attribuez le rôle manuellement.`,
      );
    }

    return { id: userId, email: authData.user.email ?? data.email };
  });

// ============================================================
// DELETE USER
// ============================================================

interface DeleteUserInput {
  user_id: string;
}

export const deleteUserServerFn = createServerFn({ method: "POST" })
  .validator((data: DeleteUserInput) => {
    if (!data?.user_id) throw new Error("user_id manquant");
    return data;
  })
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Delete from profiles first (cascades to user_roles via FK).
    const { error: profileError } = await supabaseAdmin
      .from("profiles")
      .delete()
      .eq("id", data.user_id);

    if (profileError) throw new Error(profileError.message);

    // Delete the auth user via the Admin API.
    const { error: authError } = await supabaseAdmin.auth.admin.deleteUser(data.user_id);
    if (authError) {
      // Profile row is already gone; surface this clearly rather than
      // silently swallowing it, since it leaves an orphaned auth user.
      throw new Error(
        `Le profil a été supprimé, mais le compte auth n'a pas pu être supprimé : ${authError.message}. Une suppression manuelle du compte auth peut être nécessaire.`,
      );
    }
  });