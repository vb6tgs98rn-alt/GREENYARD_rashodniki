// =============================================================================
// Supabase Edge Function: realtycalendar-webhook (v5)
// =============================================================================
// Принимает POST от RealtyCalendar, нормализует, сохраняет в rc_bookings.
// v5: при новой брони или изменении дат — создаёт/обновляет уборку в cleanings,
// шлёт уведомление горничным (через TG).
// RC ждёт HTTP 200 — иначе будет ретраить с задержками до 2 суток.
// =============================================================================

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") || "";

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey",
};

function ok(body: any = { ok: true }, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...corsHeaders },
  });
}

// ─── Telegram helpers ────────────────────────────────────────────────────────

function htmlEscape(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

async function tgSend(chatId: number | string, text: string, extra: any = {}) {
  if (!BOT_TOKEN) return null;
  try {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...extra,
      }),
    });
    const j = await res.json();
    return j;
  } catch (e) {
    console.error("[rc-webhook] tgSend failed", e);
    return null;
  }
}

// Формат даты дд.ММ.гггг
function fmtDate(iso: string | null): string {
  if (!iso) return "?";
  const d = new Date(iso);
  if (isNaN(+d)) return String(iso);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const yy = d.getUTCFullYear();
  return `${dd}.${mm}.${yy}`;
}

// ─── Уборки ──────────────────────────────────────────────────────────────────

async function createOrUpdateCleaning(userId: string, booking: any) {
  if (!booking.realty_id || !booking.end_date) return;

  // Ищем существующую уборку по booking_id (booking_id хранится как text)
  const bookingIdStr = String(booking.booking_id);
  const { data: existing } = await admin
    .from("cleanings")
    .select("id, status, scheduled_date, maid_id, tg_message_id")
    .eq("user_id", userId)
    .eq("booking_id", bookingIdStr)
    .maybeSingle();

  // Настройки менеджера
  const { data: ms } = await admin
    .from("manager_settings")
    .select("cleaning_default_time, manager_tg_chat_id")
    .eq("user_id", userId)
    .maybeSingle();

  const cleaningTime = (ms?.cleaning_default_time as string | undefined) || "12:00:00";
  const managerChat = ms?.manager_tg_chat_id;

  if (existing) {
    // Обновляем дату, если сдвинулась (например перенос выселения)
    if (existing.scheduled_date !== booking.end_date && existing.status !== "completed") {
      await admin
        .from("cleanings")
        .update({
          scheduled_date: booking.end_date,
          apartment_title: booking.apartment_title,
          updated_at: new Date().toISOString(),
        })
        .eq("id", existing.id);
      // Уведомляем горничную (если назначена) и менеджера
      if (existing.maid_id) {
        const { data: maid } = await admin
          .from("maids").select("tg_chat_id, name").eq("id", existing.maid_id).maybeSingle();
        if (maid?.tg_chat_id) {
          await tgSend(
            maid.tg_chat_id,
            `⚠️ <b>Дата уборки изменилась</b>\n📍 ${htmlEscape(booking.apartment_title || "")}\n📅 Новая дата: ${fmtDate(booking.end_date)}, ${(cleaningTime as string).slice(0,5)}`
          );
        }
      }
      if (managerChat) {
        await tgSend(
          managerChat,
          `📅 Дата уборки по брони <code>${bookingIdStr}</code> перенесена на ${fmtDate(booking.end_date)} (${htmlEscape(booking.apartment_title || "")}).`
        );
      }
    }
    return;
  }

  // Создаём новую уборку
  const { data: inserted, error: insErr } = await admin
    .from("cleanings")
    .insert({
      user_id: userId,
      booking_id: bookingIdStr,
      realty_id: booking.realty_id,
      apartment_title: booking.apartment_title,
      scheduled_date: booking.end_date,
      scheduled_time: cleaningTime,
      status: "pending_response",
    })
    .select("id")
    .single();

  if (insErr || !inserted) {
    console.error("[rc-webhook] insert cleaning failed:", insErr?.message);
    return;
  }

  const cleaningId = inserted.id;

  // Ищем закреплённых горничных за квартирой
  const { data: maidLinks } = await admin
    .from("maid_apartments")
    .select("maid_id")
    .eq("user_id", userId)
    .eq("realty_id", booking.realty_id);

  const maidIds = (maidLinks || []).map(m => m.maid_id);

  if (maidIds.length === 0) {
    // Нет закреплённой горничной — уведомляем менеджера
    if (managerChat) {
      await tgSend(
        managerChat,
        `⚠️ Новая бронь <code>${bookingIdStr}</code> — <b>${htmlEscape(booking.apartment_title || "")}</b>, выселение ${fmtDate(booking.end_date)}.\nЗа этой квартирой не закреплена ни одна горничная. Назначьте вручную в приложении.`
      );
    }
    return;
  }

  // Достаём tg_chat_id и имена
  const { data: maids } = await admin
    .from("maids")
    .select("id, name, tg_chat_id")
    .in("id", maidIds)
    .eq("active", true);

  const offered: string[] = [];
  for (const m of maids || []) {
    if (!m.tg_chat_id) continue;
    const kb = {
      inline_keyboard: [
        [
          { text: "✅ Принять", callback_data: `maid_accept:${cleaningId}` },
          { text: "❌ Отказаться", callback_data: `maid_decline:${cleaningId}` },
        ],
        [
          { text: "📦 Заказать расходник", callback_data: `maid_supply:${cleaningId}` },
        ],
      ],
    };
    const text = `🧹 <b>Новая уборка</b>\n📍 ${htmlEscape(booking.apartment_title || "?")}\n📅 ${fmtDate(booking.end_date)}, ${(cleaningTime as string).slice(0,5)}\n👤 Гость выселяется ${fmtDate(booking.end_date)}`;
    const r = await tgSend(m.tg_chat_id, text, { reply_markup: kb });
    if (r?.ok && r.result?.message_id) {
      offered.push(m.id);
      // Если только одна горничная — сохраняем message_id для последующего edit
      if ((maids?.length || 0) === 1) {
        await admin
          .from("cleanings")
          .update({ tg_message_id: r.result.message_id, maid_id: m.id })
          .eq("id", cleaningId);
      }
    }
  }

  if (offered.length > 0) {
    await admin
      .from("cleanings")
      .update({ offered_to: offered })
      .eq("id", cleaningId);
  }

  // Уведомление менеджеру
  if (managerChat) {
    const maidNames = (maids || []).map(m => m.name).join(", ");
    await tgSend(
      managerChat,
      `🧹 Уборка по брони <code>${bookingIdStr}</code> — <b>${htmlEscape(booking.apartment_title || "")}</b>, ${fmtDate(booking.end_date)}. Отправлено горничным: ${htmlEscape(maidNames)}.`
    );
  }
}

async function cancelCleaning(userId: string, bookingId: number) {
  const bookingIdStr = String(bookingId);
  const { data: cleaning } = await admin
    .from("cleanings")
    .select("id, status, maid_id, apartment_title, scheduled_date")
    .eq("user_id", userId)
    .eq("booking_id", bookingIdStr)
    .maybeSingle();

  if (!cleaning || cleaning.status === "completed" || cleaning.status === "cancelled") return;

  await admin
    .from("cleanings")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", cleaning.id);

  // Уведомляем горничную
  if (cleaning.maid_id) {
    const { data: maid } = await admin
      .from("maids").select("tg_chat_id, name").eq("id", cleaning.maid_id).maybeSingle();
    if (maid?.tg_chat_id) {
      await tgSend(
        maid.tg_chat_id,
        `❌ <b>Уборка отменена</b>\n📍 ${htmlEscape(cleaning.apartment_title || "")}\n📅 ${fmtDate(cleaning.scheduled_date)}\nБронь была отменена гостем/системой.`
      );
    }
  }

  // Менеджеру
  const { data: ms } = await admin
    .from("manager_settings").select("manager_tg_chat_id").eq("user_id", userId).maybeSingle();
  if (ms?.manager_tg_chat_id) {
    await tgSend(
      ms.manager_tg_chat_id,
      `❌ Уборка по брони <code>${bookingIdStr}</code> отменена (${htmlEscape(cleaning.apartment_title || "")}, ${fmtDate(cleaning.scheduled_date)}).`
    );
  }
}

// ---------------------------------------------------------------------------
// Парсер payload от RealtyCalendar
// ---------------------------------------------------------------------------

interface RcBookingNormalized {
  booking_id: number;
  agency_id: number;
  realty_id: number | null;
  apartment_title: string | null;
  begin_date: string | null;
  end_date: string | null;
  amount: number;
  prepayment: number;
  status: string;
  source: string | null;
  client_fio: string | null;
  client_phone: string | null;
  booking_url: string | null;
  rc_created_at: string | null;
  rc_updated_at: string | null;
}

function normalize(payload: any): { action: string; status: string; booking: RcBookingNormalized } | null {
  if (!payload || typeof payload !== "object") return null;
  const action = String(payload.action || "");
  const status = String(payload.status || "");
  const b = payload?.data?.booking;
  if (!b || typeof b !== "object") return null;

  const bookingId = Number(b.id);
  const agencyId  = Number(b.agency_id);
  if (!bookingId || !agencyId) return null;

  return {
    action,
    status,
    booking: {
      booking_id:       bookingId,
      agency_id:        agencyId,
      realty_id:        b.realty_id != null ? Number(b.realty_id) : null,
      apartment_title:  b.apartment?.title ?? null,
      begin_date:       b.begin_date ?? null,
      end_date:         b.end_date ?? null,
      amount:           Number(b.amount || 0),
      prepayment:       Number(b.prepayment || 0),
      status,
      source:           b.source ?? null,
      client_fio:       b.client?.fio ?? null,
      client_phone:     b.client?.phone ?? null,
      booking_url:      b.url ?? null,
      rc_created_at:    b.created_at ?? null,
      rc_updated_at:    b.updated_at ?? null,
    },
  };
}

// ---------------------------------------------------------------------------
// Основной обработчик
// ---------------------------------------------------------------------------

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== "POST") return ok({ ok: false, error: "method_not_allowed" }, 405);

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    await admin.from("rc_webhook_log").insert({
      action: "parse_error", http_status: 400, error_text: "invalid_json", raw_payload: null,
    });
    return ok({ ok: false, error: "invalid_json" });
  }

  const parsed = normalize(payload);
  if (!parsed) {
    await admin.from("rc_webhook_log").insert({
      action: "parse_error", http_status: 400, error_text: "unrecognized_payload", raw_payload: payload,
    });
    return ok({ ok: false, error: "unrecognized_payload" });
  }

  const { action, status, booking } = parsed;

  // user_id по agency_id
  const { data: integration, error: intErr } = await admin
    .from("rc_integrations")
    .select("user_id, enabled")
    .eq("agency_id", booking.agency_id)
    .maybeSingle();

  if (intErr) {
    await admin.from("rc_webhook_log").insert({
      agency_id: booking.agency_id, action, status, booking_id: booking.booking_id,
      http_status: 500, error_text: `integration_lookup_failed: ${intErr.message}`, raw_payload: payload,
    });
    return ok({ ok: false, error: "integration_lookup_failed" });
  }

  if (!integration) {
    await admin.from("rc_webhook_log").insert({
      agency_id: booking.agency_id, action, status, booking_id: booking.booking_id,
      http_status: 200, error_text: "agency_not_registered", raw_payload: payload,
    });
    return ok({ ok: true, note: "agency_not_registered" });
  }

  if (!integration.enabled) {
    await admin.from("rc_webhook_log").insert({
      user_id: integration.user_id, agency_id: booking.agency_id, action, status,
      booking_id: booking.booking_id, http_status: 200, error_text: "integration_disabled", raw_payload: payload,
    });
    return ok({ ok: true, note: "integration_disabled" });
  }

  const userId = integration.user_id;

  if (status === "request") {
    await admin.from("rc_webhook_log").insert({
      user_id: userId, agency_id: booking.agency_id, action, status,
      booking_id: booking.booking_id, http_status: 200, error_text: "skipped_request_status", raw_payload: payload,
    });
    return ok({ ok: true, note: "skipped_request_status" });
  }

  // Upsert в rc_bookings
  const row = {
    user_id: userId, booking_id: booking.booking_id, agency_id: booking.agency_id,
    realty_id: booking.realty_id, apartment_title: booking.apartment_title,
    begin_date: booking.begin_date, end_date: booking.end_date,
    amount: booking.amount, prepayment: booking.prepayment, status: booking.status,
    source: booking.source, client_fio: booking.client_fio, client_phone: booking.client_phone,
    booking_url: booking.booking_url, rc_created_at: booking.rc_created_at, rc_updated_at: booking.rc_updated_at,
    raw_payload: payload, received_at: new Date().toISOString(),
  };

  const { error: upErr } = await admin
    .from("rc_bookings").upsert(row, { onConflict: "user_id,booking_id" });

  if (upErr) {
    await admin.from("rc_webhook_log").insert({
      user_id: userId, agency_id: booking.agency_id, action, status,
      booking_id: booking.booking_id, http_status: 500, error_text: `upsert_failed: ${upErr.message}`, raw_payload: payload,
    });
    return ok({ ok: false, error: "upsert_failed" }, 500);
  }

  // ─── Уборка ────────────────────────────────────────────
  try {
    const statusLower = String(status).toLowerCase();
    const actionLower = String(action).toLowerCase();
    // Отмена
    if (statusLower === "canceled" || statusLower === "cancelled" || actionLower === "cancel" || actionLower === "delete") {
      await cancelCleaning(userId, booking.booking_id);
    } else if (
      // Новая бронь или обновление активной
      statusLower === "booked" || statusLower === "confirmed" || statusLower === "active" ||
      actionLower === "create" || actionLower === "update" || actionLower === "change"
    ) {
      await createOrUpdateCleaning(userId, booking);
    }
  } catch (e) {
    console.error("[rc-webhook] cleaning processing failed:", e);
  }

  await admin.from("rc_webhook_log").insert({
    user_id: userId, agency_id: booking.agency_id, action, status,
    booking_id: booking.booking_id, http_status: 200, error_text: null, raw_payload: null,
  });

  await admin.from("rc_integrations")
    .update({ last_event_at: new Date().toISOString() })
    .eq("user_id", userId);

  return ok({ ok: true });
});
