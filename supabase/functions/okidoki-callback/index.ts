// okidoki-callback — приёмник webhook'ов от Okidoki о смене статуса договора.
// external_id = booking_id в rc_bookings. Обновляет статус и уведомляет менеджера в Telegram.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const TG_BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";

const supa = createClient(SUPABASE_URL, SERVICE_ROLE);

const RUS_STATUS_BY_INTERNAL: Record<number, string> = {
  0: "Черновик",
  1: "Выставлен",
  2: "Подписан",
  3: "Отклонён",
  4: "Ожидает проверки",
  5: "Аннулирован",
};

async function tgSend(chat_id: number | string, text: string) {
  if (!TG_BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id, text, parse_mode: "HTML", disable_web_page_preview: true }),
    });
  } catch (e) {
    console.warn("[okidoki-callback] tgSend:", e);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
  let body: any = {};
  try { body = await req.json(); } catch {}
  const external_id = String(body.external_id || "");
  const status_name = body?.status?.name ?? RUS_STATUS_BY_INTERNAL[body?.status?.internal_id] ?? "";
  const status_internal = body?.status?.internal_id ?? null;
  const okidoki_id = String(body?._id || "");

  console.log(`[okidoki-callback] external_id=${external_id} status=${status_name} (${status_internal}) oki_id=${okidoki_id}`);

  if (!external_id) return new Response(JSON.stringify({ ok: false, error: "no external_id" }), { status: 400 });

  // Ищем бронь
  const { data: bk } = await supa
    .from("rc_bookings")
    .select("user_id, booking_id, apartment_title, client_fio, okidoki_link")
    .eq("booking_id", Number(external_id))
    .maybeSingle();

  if (!bk) {
    console.warn(`[okidoki-callback] booking ${external_id} not found`);
    return new Response(JSON.stringify({ ok: true, note: "booking not found (ignored)" }), { status: 200 });
  }

  const patch: Record<string, unknown> = {
    contract_status: status_name,
    contract_status_internal: status_internal,
    contract_updated_at: new Date().toISOString(),
  };
  if (okidoki_id) patch.okidoki_contract_id = okidoki_id;
  if (status_internal === 2) patch.contract_signed_at = new Date().toISOString();

  await supa.from("rc_bookings").update(patch).eq("booking_id", bk.booking_id).eq("user_id", bk.user_id);

  // Уведомляем менеджера в TG
  const { data: ms } = await supa
    .from("manager_settings")
    .select("manager_tg_chat_id, notify_on_inbound")
    .eq("user_id", bk.user_id)
    .maybeSingle();
  const chat = ms?.manager_tg_chat_id;
  if (chat) {
    let icon = "📄";
    if (status_internal === 2) icon = "✅";
    else if (status_internal === 3 || status_internal === 5) icon = "⚠️";
    else if (status_internal === 1) icon = "📨";
    const text =
      `${icon} <b>Договор ${status_name.toLowerCase()}</b>\n` +
      `Бронь #${bk.booking_id}\n` +
      `${bk.apartment_title || ""}\n` +
      `Гость: ${bk.client_fio || "—"}` +
      (bk.okidoki_link ? `\n<a href="${bk.okidoki_link}">Открыть договор</a>` : "");
    await tgSend(chat, text);
  }

  return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
});
