// okidoki-proxy — единая Edge Function для всех вызовов Okidoki API.
// Клиент передаёт JWT и action; функция достаёт api_key пользователя из БД
// и делает запрос к api.doki.online. Ключ никогда не улетает на клиент.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const OKI_BASE = "https://api.doki.online";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });

async function getUserAndSettings(auth: string | null) {
  if (!auth) return { user: null, key: null, settings: null };
  const supa = createClient(SUPABASE_URL, SERVICE_ROLE);
  const token = auth.replace(/^Bearer\s+/i, "");
  const { data: { user } } = await supa.auth.getUser(token);
  if (!user) return { user: null, key: null, settings: null };
  const { data: settings } = await supa
    .from("manager_settings")
    .select("okidoki_api_key, okidoki_signer_card_id, okidoki_auto_send, okidoki_field_mapping")
    .eq("user_id", user.id)
    .maybeSingle();
  return { user, key: settings?.okidoki_api_key ?? null, settings, supa };
}

async function oki(path: string, method: "GET" | "POST", api_key: string, body?: unknown, timeoutMs = 15000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    if (method === "GET") {
      const sep = path.includes("?") ? "&" : "?";
      const res = await fetch(`${OKI_BASE}${path}${sep}api_key=${encodeURIComponent(api_key)}`, {
        method: "GET", signal: ac.signal,
      });
      const text = await res.text();
      let data: any; try { data = JSON.parse(text); } catch { data = text; }
      return { ok: res.ok, status: res.status, data };
    } else {
      const res = await fetch(`${OKI_BASE}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(body as object), api_key }),
        signal: ac.signal,
      });
      const text = await res.text();
      let data: any; try { data = JSON.parse(text); } catch { data = text; }
      return { ok: res.ok, status: res.status, data };
    }
  } catch (err) {
    return { ok: false, status: 0, data: { error: String((err as Error).message || err) } };
  } finally {
    clearTimeout(t);
  }
}

function ddmmyyyy(d: string | Date | null | undefined): string {
  if (!d) return "";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${dt.getFullYear()}`;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (req.method !== "POST") return json(405, { error: "method not allowed" });

  const auth = req.headers.get("authorization");
  const { user, key, settings, supa } = await getUserAndSettings(auth);
  if (!user) return json(401, { error: "not authenticated" });

  let payload: any = {};
  try { payload = await req.json(); } catch {}
  const action = String(payload.action || "");

  // 1) Проверка ключа (принимается api_key прямо из тела запроса — ещё не сохранён)
  if (action === "validate") {
    const test_key = String(payload.api_key || key || "");
    if (!test_key) return json(400, { error: "no api_key provided" });
    const r = await oki("/external/get-user-id", "GET", test_key);
    if (!r.ok) return json(200, { valid: false, status: r.status, data: r.data });
    return json(200, { valid: true, oki_user_id: r.data?.user_id });
  }

  if (!key) return json(400, { error: "api_key not configured" });

  if (action === "list_templates") {
    const r = await oki("/external/templates", "GET", key);
    return json(r.ok ? 200 : 502, r.data);
  }

  if (action === "list_signer_cards") {
    const rm = payload.return_main !== false;
    const r = await oki(`/external/additional-user-cards?return_main=${rm}`, "GET", key);
    return json(r.ok ? 200 : 502, r.data);
  }

  if (action === "list_system_entities") {
    const r = await oki("/external/system-entities", "GET", key);
    return json(r.ok ? 200 : 502, r.data);
  }

  // ─── Привязка квартир к шаблонам ─────────────────────────────────────
  if (action === "list_apartment_templates") {
    const { data } = await supa!
      .from("apartment_contract_templates")
      .select("realty_id, apartment_name, okidoki_template_id, field_mapping, apartment_address, deposit, updated_at")
      .eq("user_id", user.id);
    return json(200, { items: data || [] });
  }

  if (action === "save_apartment_template") {
    const { realty_id, apartment_name, okidoki_template_id, field_mapping, apartment_address, deposit } = payload;
    if (!realty_id || !okidoki_template_id) return json(400, { error: "realty_id и okidoki_template_id обязательны" });
    const { error } = await supa!.from("apartment_contract_templates").upsert({
      user_id: user.id,
      realty_id,
      apartment_name: apartment_name || null,
      okidoki_template_id,
      field_mapping: field_mapping || {},
      apartment_address: apartment_address ?? null,
      deposit: deposit ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "user_id,realty_id" });
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  if (action === "delete_apartment_template") {
    const { realty_id } = payload;
    if (!realty_id) return json(400, { error: "realty_id required" });
    const { error } = await supa!.from("apartment_contract_templates")
      .delete().eq("user_id", user.id).eq("realty_id", realty_id);
    if (error) return json(500, { error: error.message });
    return json(200, { ok: true });
  }

  // ─── Создание договора ───────────────────────────────────────────────
  if (action === "create_contract") {
    const booking_id = payload.booking_id;
    if (!booking_id) return json(400, { error: "booking_id required" });

    const { data: bk, error: bkErr } = await supa!
      .from("rc_bookings")
      .select("*")
      .eq("user_id", user.id)
      .eq("booking_id", booking_id)
      .maybeSingle();
    if (bkErr || !bk) return json(404, { error: "booking not found" });

    // Ищем шаблон для этой квартиры (по realty_id)
    const { data: apt } = await supa!
      .from("apartment_contract_templates")
      .select("okidoki_template_id, field_mapping")
      .eq("user_id", user.id)
      .eq("realty_id", bk.realty_id)
      .maybeSingle();

    const template_id = payload.template_id || apt?.okidoki_template_id;
    if (!template_id) {
      return json(400, {
        error: `Для квартиры «${bk.apartment_title || bk.realty_id}» не назначен шаблон договора. Откройте «Договоры (Okidoki)» → «Квартиры и шаблоны».`,
      });
    }

    // Keyword’ы одинаковые во всех шаблонах — зашиты как дефолт.
    // Пользовательский override через manager_settings.okidoki_field_mapping если вдруг в каком-то шаблоне keyword другой.
    // С заглавной — как в шаблоне Okidoki. Объект «Описание и адрес квартиры» — dropdown, не передаётся через entities.
    const DEFAULT_MAPPING: Record<string, string> = {
      begin_date:            "Дата заселения",
      end_date:              "Дата выселения",
      nights:                "Количество суток",
      price_per_night:       "Цена в сутки",
      price_total:           "Полная стоимость",
      prepaid:               "Оплачено",
      deposit:               "Обеспечительный платеж",
      apartment_address:     "Адрес",
    };
    const userMapping: Record<string, string> = (settings?.okidoki_field_mapping as any) || {};
    const aptMapping: Record<string, string> = apt?.field_mapping || {};
    const mapping: Record<string, string> = { ...DEFAULT_MAPPING, ...userMapping, ...aptMapping };

    const nights = Math.max(1, Math.round(
      (new Date(bk.end_date).getTime() - new Date(bk.begin_date).getTime()) / (1000 * 60 * 60 * 24)
    ));
    const priceTotal = Number(bk.amount || 0);
    const prepaid = Number(bk.prepayment || 0);
    const remaining = Math.max(0, priceTotal - prepaid);
    const pricePerNight = nights > 0 ? Math.round((priceTotal / nights) * 100) / 100 : priceTotal;

    const logical: Record<string, string> = {
      begin_date:      ddmmyyyy(bk.begin_date),
      end_date:        ddmmyyyy(bk.end_date),
      nights:          String(nights),
      price_total:     String(priceTotal),
      price_per_night: String(pricePerNight),
      prepaid:         String(prepaid),
      remaining:       String(remaining),
      deposit:         String(payload.deposit ?? ""),
      apartment_title: String(bk.apartment_title || ""),
      apartment_address: String(payload.apartment_address ?? bk.apartment_title ?? ""),
      apartment_description: String(payload.apartment_description ?? ""),
    };

    const entities: Array<{ keyword: string; value: string }> = [];
    for (const [logicalKey, keyword] of Object.entries(mapping)) {
      if (!keyword) continue;
      const v = logical[logicalKey] ?? "";
      if (v === "") continue;
      entities.push({ keyword: String(keyword), value: v });
    }

    const system_entities: Array<{ keyword: string; value: string }> = [];
    if (bk.client_fio) {
      const parts = String(bk.client_fio).trim().split(/\s+/);
      if (parts[0]) system_entities.push({ keyword: "client_last_name",   value: parts[0] });
      if (parts[1]) system_entities.push({ keyword: "client_first_name",  value: parts[1] });
      if (parts[2]) system_entities.push({ keyword: "client_middle_name", value: parts[2] });
    }
    if (bk.client_phone) system_entities.push({ keyword: "client_phone_number", value: String(bk.client_phone) });

    const callback_url = `${SUPABASE_URL}/functions/v1/okidoki-callback`;

    const contractBody: Record<string, unknown> = {
      external_id: String(booking_id),
      template_id,
      source: "GreenYard",
      entities,
      system_entities,
      callback_url,
    };
    if (settings?.okidoki_signer_card_id) {
      contractBody.actual_user_card_id = settings.okidoki_signer_card_id;
    }
    if (payload.redirect_url) contractBody.redirect_url = String(payload.redirect_url);

    const r = await oki("/external/contract", "POST", key, contractBody, 20000);
    if (!r.ok) return json(502, { error: "okidoki error", status: r.status, data: r.data });

    const link = r.data?.link || "";
    const contract_id = r.data?.contract_id || "";
    const status_name = r.data?.status?.name || "";
    const status_internal = r.data?.status?.internal_id ?? null;

    await supa!.from("rc_bookings").update({
      okidoki_contract_id: contract_id,
      okidoki_link: link,
      contract_status: status_name,
      contract_status_internal: status_internal,
      contract_updated_at: new Date().toISOString(),
    }).eq("user_id", user.id).eq("booking_id", booking_id);

    return json(200, { link, contract_id, status: r.data?.status });
  }

  if (action === "list_contracts") {
    const external_id = String(payload.external_id || payload.booking_id || "");
    if (!external_id) return json(400, { error: "external_id required" });
    const r = await oki(`/external/contracts?external_id=${encodeURIComponent(external_id)}`, "GET", key);
    return json(r.ok ? 200 : 502, r.data);
  }

  return json(400, { error: `unknown action: ${action}` });
});
