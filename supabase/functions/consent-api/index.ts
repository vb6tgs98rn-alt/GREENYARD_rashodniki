// ═══════════════════════════════════════════════════════════════════════════
// consent-api — приём и отзыв согласий пользователя (152-ФЗ)
//
// Endpoints (POST /functions/v1/consent-api):
//   action=submit  { policy_version, categories, personal_data, user_agent }
//   action=revoke  { reason? }
//   action=current                    -> текущее согласие
//   action=has_consent { category }   -> { allowed: bool }
//
// Проверяет:
//   - JWT авторизацию через Supabase (verify_jwt=true в конфиге)
//   - Валидность policy_version (должна существовать и быть is_active)
//   - Логирует IP из заголовков (X-Forwarded-For)
// ═══════════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL         = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY    = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// ─── Client с сервисной ролью (для записи в user_consents в обход RLS при нужде) ─
// Мы используем serviceRoleClient только для чтения policy и записи IP.
// Основные операции идут через клиент с JWT пользователя — для аудита RLS.
const serviceClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

function getIP(req: Request): string | null {
  const xf = req.headers.get("x-forwarded-for");
  if (xf) return xf.split(",")[0].trim();
  return req.headers.get("cf-connecting-ip")
      || req.headers.get("x-real-ip")
      || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST")    return json({ error: "method_not_allowed" }, 405);

  // ── Auth ─────────────────────────────────────────────────────────────
  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthorized" }, 401);

  // Клиент с пользовательским JWT для операций от имени юзера
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth:   { persistSession: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData?.user) return json({ error: "unauthorized" }, 401);
  const user = userData.user;

  // ── Тело ─────────────────────────────────────────────────────────────
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "invalid_json" }, 400); }
  const action = String(body?.action || "");

  const ip = getIP(req);
  const ua = String(body?.user_agent || req.headers.get("user-agent") || "").slice(0, 500);

  try {
    if (action === "submit") {
      // Валидация версии политики
      const policyVersion = String(body.policy_version || "");
      if (!policyVersion) return json({ error: "missing_policy_version" }, 400);

      const { data: policy, error: polErr } = await serviceClient
        .from("privacy_policies")
        .select("version, is_active")
        .eq("version", policyVersion)
        .maybeSingle();

      if (polErr) return json({ error: "policy_lookup_failed", details: polErr.message }, 500);
      if (!policy) return json({ error: "unknown_policy_version" }, 400);
      if (!policy.is_active) return json({ error: "policy_not_active" }, 400);

      // Категории: normalize
      const rawCats = body.categories && typeof body.categories === "object" ? body.categories : {};
      const categories = {
        necessary:  true, // всегда true
        analytics:  !!rawCats.analytics,
        marketing:  !!rawCats.marketing,
        functional: !!rawCats.functional,
      };
      const personalData = !!body.personal_data;

      // Отзываем все предыдущие активные consent-записи этого юзера
      await userClient
        .from("user_consents")
        .update({ revoked_at: new Date().toISOString(), revoke_reason: "superseded" })
        .eq("user_id", user.id)
        .is("revoked_at", null);

      // Пишем новую запись (через service client, чтобы записать IP)
      const { data: inserted, error: insErr } = await serviceClient
        .from("user_consents")
        .insert({
          user_id:        user.id,
          policy_version: policyVersion,
          categories,
          personal_data:  personalData,
          ip_address:     ip,
          user_agent:     ua,
        })
        .select("id, policy_version, categories, personal_data, given_at")
        .single();

      if (insErr) return json({ error: "insert_failed", details: insErr.message }, 500);
      return json({ ok: true, consent: inserted });
    }

    if (action === "revoke") {
      const reason = String(body.reason || "").slice(0, 500);
      const { error: revErr } = await userClient
        .from("user_consents")
        .update({ revoked_at: new Date().toISOString(), revoke_reason: reason || "user_request" })
        .eq("user_id", user.id)
        .is("revoked_at", null);

      if (revErr) return json({ error: "revoke_failed", details: revErr.message }, 500);
      return json({ ok: true });
    }

    if (action === "current") {
      const { data, error } = await serviceClient
        .from("user_consents")
        .select("id, policy_version, categories, personal_data, given_at")
        .eq("user_id", user.id)
        .is("revoked_at", null)
        .order("given_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) return json({ error: "read_failed", details: error.message }, 500);
      return json({ ok: true, consent: data || null });
    }

    if (action === "has_consent") {
      const category = String(body.category || "necessary");
      if (category === "necessary") return json({ ok: true, allowed: true });

      const { data } = await serviceClient
        .from("user_consents")
        .select("categories")
        .eq("user_id", user.id)
        .is("revoked_at", null)
        .order("given_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const allowed = !!(data?.categories && (data.categories as any)[category]);
      return json({ ok: true, allowed });
    }

    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    // Не логируем персональные данные — только техническая информация
    console.error("[consent-api] unhandled", e instanceof Error ? e.message : e);
    return json({ error: "internal" }, 500);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// Экспорт helper для других edge-функций
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Использование в других edge-функциях:
 *
 *   import { requireConsent } from "../consent-api/guard.ts";
 *   const check = await requireConsent(userId, "necessary");
 *   if (!check.allowed) return json({ error: "consent_required" }, 403);
 *
 * См. отдельный файл guard.ts.
 */
