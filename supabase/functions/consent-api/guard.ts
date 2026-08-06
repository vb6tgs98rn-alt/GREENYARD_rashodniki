// ═══════════════════════════════════════════════════════════════════════════
// guard.ts — helper для серверной проверки consent из других edge-функций.
//
// Использование:
//
//   import { requireConsent } from "../consent-api/guard.ts";
//
//   const check = await requireConsent(supabaseServiceClient, userId, "necessary");
//   if (!check.allowed) {
//     return new Response(
//       JSON.stringify({ error: "consent_required", reason: check.reason }),
//       { status: 403, headers: { "Content-Type": "application/json" } }
//     );
//   }
//
// Категории:
//   - "necessary"    — есть ли вообще активный consent + согласие на обработку ПДн
//   - "analytics"    — согласие на аналитику
//   - "marketing"    — согласие на маркетинг
//   - "functional"   — согласие на функциональные виджеты
// ═══════════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

export type ConsentCheckResult = {
  allowed:       boolean;
  reason?:       "no_user" | "no_consent" | "no_personal_data" | "category_denied";
  categories?:   Record<string, boolean>;
  personalData?: boolean;
  version?:      string;
};

/**
 * Проверить, есть ли у пользователя активное согласие для нужной категории.
 * Для "necessary" (по умолчанию) также требуется personal_data=true.
 */
export async function requireConsent(
  supabase:    SupabaseClient,
  userId:      string | null | undefined,
  category:    "necessary" | "analytics" | "marketing" | "functional" = "necessary"
): Promise<ConsentCheckResult> {
  if (!userId) return { allowed: false, reason: "no_user" };

  const { data, error } = await supabase
    .from("user_consents")
    .select("policy_version, categories, personal_data")
    .eq("user_id", userId)
    .is("revoked_at", null)
    .order("given_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return { allowed: false, reason: "no_consent" };

  const cats = (data.categories || {}) as Record<string, boolean>;
  const personalData = !!data.personal_data;

  // necessary => активный consent + согласие на обработку ПДн
  if (category === "necessary") {
    if (!personalData) {
      return {
        allowed: false, reason: "no_personal_data",
        categories: cats, personalData, version: data.policy_version,
      };
    }
    return { allowed: true, categories: cats, personalData, version: data.policy_version };
  }

  // Остальные категории: явное разрешение
  if (!cats[category]) {
    return {
      allowed: false, reason: "category_denied",
      categories: cats, personalData, version: data.policy_version,
    };
  }
  return { allowed: true, categories: cats, personalData, version: data.policy_version };
}
