// src/lib/activityLog.ts
import { supabase } from "@/integrations/supabase/client";

export type ActivityAction =
  | "login"
  | "logout"
  | "signup"
  | "create"
  | "update"
  | "delete"
  | "validate"
  | "cancel"
  | "convert"
  | "payment";

interface LogActivityParams {
  action: ActivityAction | (string & {});
  entity_type: string;
  entity_id?: string | null;
  details?: Record<string, any> | null;
}

/**
 * Records a row in `activity_logs` for the Journal d'activité page
 * (src/routes/_authenticated/journal.tsx).
 *
 * This is intentionally fire-and-forget: a logging failure should never
 * block or roll back the mutation that triggered it. Errors are logged
 * to the console instead of thrown. Call it after a mutation succeeds,
 * e.g.:
 *
 *   await logActivity({
 *     action: "create",
 *     entity_type: "chantier",
 *     entity_id: chantier.id,
 *     details: { nom: chantier.nom },
 *   });
 */
export async function logActivity({
  action,
  entity_type,
  entity_id = null,
  details = null,
}: LogActivityParams): Promise<void> {
  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    const { error } = await supabase.from("activity_logs" as never).insert({
      user_id: user?.id ?? null,
      action,
      entity_type,
      entity_id,
      details,
    } as never);

    if (error) {
      console.error("logActivity failed:", error.message);
    }
  } catch (err) {
    console.error("logActivity failed:", err);
  }
}