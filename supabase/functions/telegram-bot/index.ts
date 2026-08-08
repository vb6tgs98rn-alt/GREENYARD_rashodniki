/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 *
 * Копирование, распространение, переработка и обратная разработка
 * (reverse engineering) запрещены без письменного разрешения правообладателя.
 * Условия: см. файл LICENSE. Нарушение влечёт ответственность по ст. 1252,
 * 1301 ГК РФ.
 */
// Edge Function: бот для гостей и горничных (v14 — оплата через Точка Банк).
//
// Работает сразу в трёх мессенджерах: Telegram, MAX и WhatsApp.
// Вся логика ниже про каналы ничего не знает: она получает Recipient
// (канал + идентификатор чата) и отдаёт текст в HTML, а перевод в формат
// конкретного мессенджера делает supabase/functions/_shared/channels.ts.
//
// Имя функции осталось прежним, чтобы не переподключать вебхук Telegram.
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  answerCallback,
  type Btn,
  CHANNEL_TITLE,
  type ChannelId,
  enabledChannels,
  htmlEscape,
  type InboundEvent,
  inviteLink,
  isChannel,
  parseMaxUpdate,
  parseTelegramUpdate,
  parseWhatsappUpdate,
  type Recipient,
  sendMessage,
} from "../_shared/channels.ts";
import { ensureBookingPayment, paymentMessage } from "../_shared/tochka_booking.ts";

const TG_SECRET    = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")   ?? "";
const MAX_SECRET   = Deno.env.get("MAX_WEBHOOK_SECRET")        ?? "";
const WA_VERIFY    = Deno.env.get("WHATSAPP_VERIFY_TOKEN")     ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")              ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OR_API_KEY   = Deno.env.get("OPENROUTER_API_KEY")        ?? "";
const OR_MODEL     = Deno.env.get("OPENROUTER_MODEL")          ?? "openai/gpt-oss-120b:free";
const OR_REFERER   = Deno.env.get("OPENROUTER_REFERER")        ?? "https://green-yard.app";
const OR_TITLE     = Deno.env.get("OPENROUTER_TITLE")          ?? "Green Yard Guest Bot";

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-telegram-bot-api-secret-token",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function svc() {
  return createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function userClient(authHeader: string) {
  return createClient(SUPABASE_URL, SERVICE_ROLE, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function getUserIdFromJwt(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!auth) return null;
  try {
    const client = userClient(auth);
    const { data, error } = await client.auth.getUser();
    if (error || !data?.user) return null;
    return data.user.id;
  } catch (_e) {
    return null;
  }
}

/** Короткий псевдоним отправки: логика ниже вызывает только его. */
async function send(to: Recipient, text: string, buttons?: Btn[][], preview = false) {
  return await sendMessage(to, text, { buttons, preview });
}

/**
 * Меню гостя. Возвращается в нейтральном виде — каждый канал сам решит,
 * рисовать это кнопками или списком.
 */
function guestKeyboard(channelUrl?: string | null, payEnabled = false): Btn[][] {
  const rows: Btn[][] = [
    [{ text: "📍 Адрес", data: "address" }, { text: "📶 Wi-Fi", data: "wifi" }],
    [{ text: "🔑 Заселение", data: "checkin_info" }, { text: "🚪 Выезд", data: "checkout_info" }],
    [{ text: "✅ Я приехал", data: "i_arrived" }, { text: "👋 Я уезжаю", data: "i_leaving" }],
    [{ text: "📋 Правила", data: "rules" }, { text: "📞 Помощь", data: "help" }],
  ];
  // Кнопку оплаты показываем, только если арендодатель включил приём оплаты.
  if (payEnabled) rows.push([{ text: "💳 Оплатить проживание", data: "pay" }]);
  if (channelUrl) rows.push([{ text: "📢 Наш канал", url: channelUrl }]);
  return rows;
}

// ═══════════════════════════════════════════════════════════════════
// ГОСТИ
// ═══════════════════════════════════════════════════════════════════

type Session = {
  id: string;
  user_id: string;
  booking_id: number;
  secure_id: string | null;
  realty_id: number | null;
  tg_chat_id: number | null;
  tg_username: string | null;
  tg_first_name: string | null;
  tg_last_name: string | null;
  channel: ChannelId;
  channel_chat_id: string | null;
  started_at: string | null;
  last_message_at: string | null;
  ai_enabled?: boolean | null;
};

const SESSION_COLS =
  "id,user_id,booking_id,secure_id,realty_id,tg_chat_id,tg_username,tg_first_name,tg_last_name,channel,channel_chat_id,started_at,last_message_at,ai_enabled,awaiting_email";

/** Куда писать гостю. */
function sessionRcpt(s: Session): Recipient {
  const channel = (isChannel(s.channel) ? s.channel : "telegram") as ChannelId;
  return {
    channel,
    chatId: s.channel_chat_id
      ?? (channel === "telegram" && s.tg_chat_id != null ? String(s.tg_chat_id) : ""),
  };
}

async function findSessionBySecureId(secureId: string): Promise<Session | null> {
  const sb = svc();
  const { data, error } = await sb
    .from("guest_sessions")
    .select(SESSION_COLS)
    .eq("secure_id", secureId)
    .maybeSingle();
  if (error) console.error("[bot] findSessionBySecureId:", error.message);
  return (data as Session) ?? null;
}

/** Ищем сессию по паре «канал + чат»: в разных мессенджерах id могут совпасть. */
async function findSessionByRcpt(to: Recipient): Promise<Session | null> {
  const sb = svc();
  const { data, error } = await sb
    .from("guest_sessions")
    .select(SESSION_COLS)
    .eq("channel", to.channel)
    .eq("channel_chat_id", to.chatId)
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) console.error("[bot] findSessionByRcpt:", error.message);
  return (data as Session) ?? null;
}

async function resolveApartmentId(userId: string, realtyId: number | null, bookingId?: number | null): Promise<{ id: string | null; diag: any }> {
  const diag: any = { realty_id: realtyId, booking_id: bookingId ?? null };
  if (!realtyId && !bookingId) return { id: null, diag: { ...diag, reason: "no_realty_no_booking" } };
  const sb = svc();
  const { data, error } = await sb
    .from("app_state")
    .select("state")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("[bot] resolveApartmentId app_state:", error.message);
    return { id: null, diag: { ...diag, reason: "app_state_error", error: error.message } };
  }
  const apts = (data?.state?.apartments ?? []) as any[];
  diag.apartments_count = apts.length;
  if (realtyId) {
    const found = apts.find((a) => String(a?.externalIds?.realtyCalendarUnitId ?? "") === String(realtyId));
    if (found?.id) return { id: String(found.id), diag: { ...diag, matched_by: "realty_id" } };
  }
  if (bookingId) {
    const bookings = (data?.state?.bookings ?? []) as any[];
    diag.bookings_count = bookings.length;
    const bk = bookings.find((b) => String(b?.externalIds?.realtyCalendarBookingId ?? b?.id ?? "") === String(bookingId));
    if (bk?.apartmentId) return { id: String(bk.apartmentId), diag: { ...diag, matched_by: "booking_id" } };
  }
  return { id: null, diag: { ...diag, reason: "not_matched" } };
}

async function loadInstructions(userId: string, apartmentId: string | null) {
  if (!apartmentId) return null;
  const sb = svc();
  const { data, error } = await sb
    .from("guest_instructions")
    .select("*")
    .eq("user_id", userId)
    .eq("apartment_id", apartmentId)
    .maybeSingle();
  if (error) console.error("[bot] loadInstructions:", error.message);
  // Отдаём только поля, которые есть в форме приложения,
  // чтобы гость видел ровно то, что менеджер ввёл.
  return pickFormFields(data);
}

async function loadManagerSettings(userId: string) {
  const sb = svc();
  const { data, error } = await sb
    .from("manager_settings")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) console.error("[bot] loadManagerSettings:", error.message);
  return data;
}

async function logMessage(
  session: Session,
  direction: "inbound" | "bot" | "manager" | "system",
  body: string,
  payload: any = null,
) {
  const sb = svc();
  const { error } = await sb.from("guest_messages").insert({
    user_id: session.user_id,
    session_id: session.id,
    booking_id: session.booking_id,
    direction,
    body,
    payload,
    is_read_by_manager: direction !== "inbound",
  });
  if (error) console.error("[bot] logMessage:", error.message);
  await sb
    .from("guest_sessions")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", session.id);
}

async function logEvent(session: Session, eventType: string, details: any = {}) {
  const sb = svc();
  const { error } = await sb.from("guest_events").insert({
    user_id: session.user_id,
    session_id: session.id,
    booking_id: session.booking_id,
    event_type: eventType,
    details,
  });
  if (error) console.error("[bot] logEvent:", error.message);
}

type ManagerSettings = {
  manager_tg_chat_id: number | null;
  manager_channel: ChannelId | null;
  manager_channel_chat_id: string | null;
  notify_on_inbound: boolean | null;
  notify_on_checkin: boolean | null;
  notify_on_checkout: boolean | null;
  notify_on_complaint: boolean | null;
  guest_channel_url: string | null;
  guest_channel_invite: string | null;
  guest_invite_template: string | null;
};

/** Куда писать менеджеру. Пока настройки не обновлены — это Telegram. */
function managerRcpt(s: any): Recipient | null {
  const channel = (isChannel(s?.manager_channel) ? s.manager_channel : "telegram") as ChannelId;
  const chatId = s?.manager_channel_chat_id
    ?? (channel === "telegram" && s?.manager_tg_chat_id != null ? String(s.manager_tg_chat_id) : null);
  return chatId ? { channel, chatId } : null;
}

async function notifyManager(userId: string, text: string, flag?: keyof ManagerSettings) {
  const settings = await loadManagerSettings(userId);
  const to = managerRcpt(settings);
  if (!to) {
    console.log("[bot] notifyManager пропущено: чат менеджера не задан");
    return;
  }
  if (flag && (settings as any)?.[flag] === false) {
    console.log(`[bot] notifyManager пропущено по флагу ${String(flag)}`);
    return;
  }
  await send(to, text);
}

// ═══════════════════════════════════════════════════════════════════
// ГОРНИЧНЫЕ
// ═══════════════════════════════════════════════════════════════════

interface Maid {
  id: string;
  user_id: string;
  tg_chat_id: number | null;
  channel: ChannelId;
  channel_chat_id: string | null;
  name: string;
  phone: string | null;
  active: boolean;
}

const MAID_COLS = "id, user_id, tg_chat_id, channel, channel_chat_id, name, phone, active";

function maidRcpt(m: { channel?: string | null; channel_chat_id?: string | null; tg_chat_id?: number | null }): Recipient | null {
  const channel = (isChannel(m?.channel) ? m.channel : "telegram") as ChannelId;
  const chatId = m?.channel_chat_id
    ?? (channel === "telegram" && m?.tg_chat_id != null ? String(m.tg_chat_id) : null);
  return chatId ? { channel, chatId } : null;
}

async function findMaidByRcpt(to: Recipient): Promise<Maid | null> {
  const sb = svc();
  const { data } = await sb
    .from("maids")
    .select(MAID_COLS)
    .eq("channel", to.channel)
    .eq("channel_chat_id", to.chatId)
    .eq("active", true)
    .maybeSingle();
  return (data as Maid) || null;
}

async function findMaidByInviteToken(token: string): Promise<Maid | null> {
  const sb = svc();
  const { data } = await sb
    .from("maids")
    .select(MAID_COLS)
    .eq("invite_token", token)
    .maybeSingle();
  return (data as Maid) || null;
}

function fmtDateShort(iso: string | null): string {
  if (!iso) return "?";
  const d = new Date(iso);
  if (isNaN(+d)) return String(iso);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}`;
}

async function logMaidMessage(
  maid: Maid,
  direction: "inbound" | "outbound" | "system",
  sender: "maid" | "bot" | "manager",
  text: string,
  messageId?: string | null,
  photoUrl?: string,
) {
  const to = maidRcpt(maid);
  if (!to) return;
  const sb = svc();
  await sb.from("maid_messages").insert({
    user_id: maid.user_id,
    maid_id: maid.id,
    // Старую колонку продолжаем заполнять только для Telegram,
    // чтобы прежние выборки по tg_chat_id не сломались.
    tg_chat_id: to.channel === "telegram" ? Number(to.chatId) : null,
    tg_message_id: to.channel === "telegram" && messageId ? Number(messageId) : null,
    channel: to.channel,
    channel_chat_id: to.chatId,
    direction,
    sender,
    text: text || null,
    photo_url: photoUrl || null,
  });
}

/** Обработка нажатий кнопок горничной. */
async function handleMaidCallback(maid: Maid, to: Recipient, data: string, messageId: string | null): Promise<boolean> {
  const sb = svc();

  const [action, cleaningId] = data.split(":");
  if (!cleaningId) return false;

  const { data: cleaning } = await sb
    .from("cleanings")
    .select("id, user_id, booking_id, realty_id, apartment_title, maid_id, scheduled_date, scheduled_time, status, offered_to")
    .eq("id", cleaningId)
    .maybeSingle();

  if (!cleaning || cleaning.user_id !== maid.user_id) {
    await send(to, "Уборка не найдена или уже неактуальна.");
    return true;
  }

  if (action === "maid_accept") {
    if (cleaning.status !== "pending_response") {
      // Кто-то уже принял
      if (cleaning.maid_id && cleaning.maid_id !== maid.id) {
        await send(to, `Эта уборка уже принята другой горничной. Спасибо.`);
      } else {
        await send(to, `Статус уборки: ${cleaning.status}.`);
      }
      return true;
    }
    await sb.from("cleanings").update({
      status: "accepted",
      maid_id: maid.id,
      accepted_at: new Date().toISOString(),
      tg_message_id: to.channel === "telegram" && messageId ? Number(messageId) : null,
      channel: to.channel,
      channel_message_id: messageId,
    }).eq("id", cleaning.id);

    // Убираем предложение у остальных, кому его отправляли
    const offered: string[] = Array.isArray(cleaning.offered_to) ? cleaning.offered_to : [];
    for (const otherId of offered) {
      if (otherId === maid.id) continue;
      const { data: other } = await sb.from("maids").select("channel, channel_chat_id, tg_chat_id").eq("id", otherId).maybeSingle();
      const otherTo = other ? maidRcpt(other) : null;
      if (otherTo) {
        await send(otherTo, `ℹ️ Уборка (${htmlEscape(cleaning.apartment_title || "")}, ${fmtDateShort(cleaning.scheduled_date)}) уже принята другой горничной.`);
      }
    }

    await send(to, `✅ Спасибо. Уборка <b>${fmtDateShort(cleaning.scheduled_date)}</b> за вами.`);
    await notifyManager(maid.user_id, `✅ <b>${htmlEscape(maid.name)}</b> сможет убраться <b>${fmtDateShort(cleaning.scheduled_date)}</b> (${htmlEscape(cleaning.apartment_title || "")}).`, "notify_on_cleaning_response" as any);
    return true;
  }

  if (action === "maid_decline") {
    if (cleaning.status !== "pending_response") {
      await send(to, `Уборка уже в статусе: ${cleaning.status}.`);
      return true;
    }
    // Если уборку предлагали ещё кому-то — не отменяем; иначе снимаем исполнителя
    const offered: string[] = Array.isArray(cleaning.offered_to) ? cleaning.offered_to : [];
    const others = offered.filter((id) => id !== maid.id);
    const updatePatch: any = { declined_at: new Date().toISOString(), offered_to: others };
    if (others.length === 0) updatePatch.status = "declined";
    await sb.from("cleanings").update(updatePatch).eq("id", cleaning.id);

    await send(to, `❌ Хорошо, передали менеджеру. Уборка <b>${fmtDateShort(cleaning.scheduled_date)}</b>.`);
    await notifyManager(maid.user_id, `❌ <b>${htmlEscape(maid.name)}</b> не сможет убраться <b>${fmtDateShort(cleaning.scheduled_date)}</b> (${htmlEscape(cleaning.apartment_title || "")}).${others.length === 0 ? "\n⚠️ Больше никому не предложено — назначьте вручную." : ""}`, "notify_on_cleaning_response" as any);
    return true;
  }

  if (action === "maid_on_site") {
    if (cleaning.maid_id !== maid.id) {
      await send(to, "Эта уборка не назначена вам.");
      return true;
    }
    if (cleaning.status === "completed") {
      await send(to, "Уборка уже завершена.");
      return true;
    }
    await sb.from("cleanings").update({
      status: "on_site",
      on_site_at: new Date().toISOString(),
    }).eq("id", cleaning.id);

    const kb: Btn[][] = [[{ text: "✅ Уборка завершена", data: `maid_completed:${cleaning.id}` }]];
    await send(to, `🏠 Отмечено: вы на месте.\n📍 ${htmlEscape(cleaning.apartment_title || "")}\n\nКогда закончите — нажмите кнопку ниже.`, kb);
    await notifyManager(maid.user_id, `🏠 Горничная <b>${htmlEscape(maid.name)}</b> на месте: ${htmlEscape(cleaning.apartment_title || "")}.`, "notify_on_cleaning_response" as any);
    return true;
  }

  if (action === "maid_completed") {
    if (cleaning.maid_id !== maid.id) {
      await send(to, "Эта уборка не назначена вам.");
      return true;
    }
    if (cleaning.status === "completed") {
      await send(to, "Уборка уже отмечена как завершённая.");
      return true;
    }
    await sb.from("cleanings").update({
      status: "completed",
      completed_at: new Date().toISOString(),
    }).eq("id", cleaning.id);

    await send(to, `✅ Спасибо! Уборка отмечена как завершённая.\n📍 ${htmlEscape(cleaning.apartment_title || "")}`);
    await notifyManager(maid.user_id, `✅ Горничная <b>${htmlEscape(maid.name)}</b> завершила уборку: ${htmlEscape(cleaning.apartment_title || "")} (${fmtDateShort(cleaning.scheduled_date)}).`, "notify_on_cleaning_response" as any);
    return true;
  }

  if (action === "maid_supply") {
    // Помечаем «ждём описание расходника» служебной записью в переписке
    await sb.from("maid_messages").insert({
      user_id: maid.user_id,
      maid_id: maid.id,
      tg_chat_id: to.channel === "telegram" ? Number(to.chatId) : null,
      channel: to.channel,
      channel_chat_id: to.chatId,
      direction: "system",
      sender: "bot",
      text: `awaiting_supply:${cleaning.id}`,
    });
    await send(to, `📦 Напишите, что нужно докупить — можно текстом и/или фото.\nВаше следующее сообщение будет отправлено менеджеру как заявка.`);
    return true;
  }

  return false;
}

/** Горничная перешла по ссылке-приглашению: привязываем её чат к каналу. */
async function handleMaidStart(to: Recipient, token: string, from: InboundEvent["from"]) {
  const maid = await findMaidByInviteToken(token);
  if (!maid) {
    await send(to, "Ссылка-приглашение недействительна или уже использована. Попросите менеджера прислать новую.");
    return;
  }
  const sb = svc();
  await sb.from("maids").update({
    // tg_chat_id заполняем только для Telegram — в других каналах его нет.
    tg_chat_id: to.channel === "telegram" ? Number(to.chatId) : null,
    channel: to.channel,
    channel_chat_id: to.chatId,
    invite_token: null,
    updated_at: new Date().toISOString(),
  }).eq("id", maid.id);

  const bound: Maid = { ...maid, channel: to.channel, channel_chat_id: to.chatId };
  const displayName = maid.name || [from?.firstName, from?.lastName].filter(Boolean).join(" ") || "";
  const welcome = `Здравствуйте, <b>${htmlEscape(displayName)}</b>.\n\nКогда появится новая уборка, вы получите сообщение с двумя кнопками: <b>Принять</b> или <b>Отказаться</b>.\n\nНапишите любое сообщение в этот чат — менеджер его увидит и ответит.`;
  await send(to, welcome);
  await logMaidMessage(bound, "outbound", "bot", welcome);

  await notifyManager(maid.user_id, `👋 Горничная <b>${htmlEscape(displayName)}</b> подключилась через ${CHANNEL_TITLE[to.channel]}.`);
}

async function handleMaidFreeText(maid: Maid, to: Recipient, text: string, messageId: string | null, photoUrl?: string) {
  const sb = svc();

  // Ждём ли мы описание расходника (последняя служебная запись awaiting_supply:<id>)
  const { data: sysMsg } = await sb
    .from("maid_messages")
    .select("id, text")
    .eq("maid_id", maid.id)
    .eq("direction", "system")
    .like("text", "awaiting_supply:%")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (sysMsg?.text) {
    const cleaningId = String(sysMsg.text).replace("awaiting_supply:", "");
    const { data: cleaning } = await sb
      .from("cleanings")
      .select("realty_id, apartment_title")
      .eq("id", cleaningId)
      .maybeSingle();
    await sb.from("supply_requests").insert({
      user_id: maid.user_id,
      maid_id: maid.id,
      realty_id: cleaning?.realty_id ?? null,
      text: text || null,
      photo_url: photoUrl || null,
    });
    // Снимаем маркер ожидания
    await sb.from("maid_messages").delete().eq("id", sysMsg.id);

    await logMaidMessage(maid, "inbound", "maid", text, messageId, photoUrl);
    await send(to, `📦 Заявка на расходники принята. Менеджер уведомлён.`);
    await notifyManager(
      maid.user_id,
      `📦 <b>Заявка на расходники</b>\nОт: <b>${htmlEscape(maid.name)}</b>\nКвартира: ${htmlEscape(cleaning?.apartment_title || "?")}\n\n${htmlEscape(text || "(без описания)")}${photoUrl ? `\n<a href="${photoUrl}">фото</a>` : ""}`,
      "notify_on_supply_request" as any,
    );
    return;
  }

  // Обычное сообщение горничной → чат с менеджером
  await logMaidMessage(maid, "inbound", "maid", text, messageId, photoUrl);
  await notifyManager(
    maid.user_id,
    `💬 <b>${htmlEscape(maid.name)}</b> (горничная):\n\n${htmlEscape(text)}`,
    "notify_on_inbound",
  );
}

// ═══════════════════════════════════════════════════════════════════
// БЛОКИ ИНСТРУКЦИЙ ДЛЯ ГОСТЯ
// ═══════════════════════════════════════════════════════════════════

// Список полей, которые менеджер реально редактирует в приложении
// (раздел «Инструкции для гостей»). Всё остальное, что могло остаться
// в базе от старых версий формы, бот игнорирует — иначе гостю уходят
// данные, которые менеджер не видит и не может исправить.
const INSTRUCTION_FORM_FIELDS = [
  "apartment_title",
  "full_address",
  "checkin_from",
  "checkout_until",
  "wifi_ssid",
  "wifi_password",
  "smoking_policy",
  "pets_policy",
  "quiet_hours",
  "other_rules",
  "ai_instructions",
] as const;

function pickFormFields(instr: any): any {
  if (!instr) return instr;
  const out: Record<string, any> = {};
  for (const key of INSTRUCTION_FORM_FIELDS) out[key] = (instr as any)[key] ?? null;
  return out;
}

function blockAddress(instr: any): string | null {
  if (!instr) return null;
  const parts: string[] = [];
  if (instr.full_address)     parts.push(`📍 <b>Адрес</b>\n${htmlEscape(instr.full_address)}`);
  return parts.length ? parts.join("\n\n") : null;
}
function blockCheckin(instr: any): string | null {
  if (!instr) return null;
  const parts: string[] = [];
  if (instr.checkin_from)         parts.push(`🕒 <b>Заезд с</b> ${htmlEscape(instr.checkin_from)}`);
  return parts.length ? parts.join("\n\n") : null;
}
function blockWifi(instr: any): string | null {
  if (!instr) return null;
  const parts: string[] = [];
  if (instr.wifi_ssid)     parts.push(`📶 <b>Сеть</b> <code>${htmlEscape(instr.wifi_ssid)}</code>`);
  if (instr.wifi_password) parts.push(`🔑 <b>Пароль</b> <code>${htmlEscape(instr.wifi_password)}</code>`);
  return parts.length ? parts.join("\n") : null;
}
function blockRules(instr: any): string | null {
  if (!instr) return null;
  const parts: string[] = [];
  if (instr.smoking_policy) parts.push(`🚭 <b>Курение:</b> ${htmlEscape(instr.smoking_policy)}`);
  if (instr.pets_policy)    parts.push(`🐾 <b>Животные:</b> ${htmlEscape(instr.pets_policy)}`);
  if (instr.quiet_hours)    parts.push(`🤫 <b>Тишина:</b> ${htmlEscape(instr.quiet_hours)}`);
  if (instr.other_rules)    parts.push(`📋 <b>Другие правила</b>\n${htmlEscape(instr.other_rules)}`);
  return parts.length ? parts.join("\n") : null;
}
function blockCheckout(instr: any): string | null {
  if (!instr) return null;
  const parts: string[] = [];
  if (instr.checkout_until)     parts.push(`🕒 <b>Выезд до</b> ${htmlEscape(instr.checkout_until)}`);
  return parts.length ? parts.join("\n\n") : null;
}
function blockHelp(_instr: any): string {
  return [
    "📞 <b>Контакты</b>",
    "Напишите любое сообщение — менеджер увидит его и ответит.",
  ].join("\n");
}

function buildAiSystemPrompt(instr: any): string {
  const emergency = "связаться с менеджером через этот чат — он всё видит";

  const facts: string[] = [];
  if (instr?.apartment_title)     facts.push(`Название квартиры: ${instr.apartment_title}`);
  if (instr?.full_address)        facts.push(`Полный адрес: ${instr.full_address}`);
  if (instr?.checkin_from)        facts.push(`Заезд с: ${instr.checkin_from}`);
  if (instr?.wifi_ssid)           facts.push(`Wi-Fi сеть: ${instr.wifi_ssid}`);
  if (instr?.wifi_password)       facts.push(`Wi-Fi пароль: ${instr.wifi_password}`);
  if (instr?.smoking_policy)      facts.push(`Курение: ${instr.smoking_policy}`);
  if (instr?.pets_policy)         facts.push(`Животные: ${instr.pets_policy}`);
  if (instr?.quiet_hours)         facts.push(`Часы тишины: ${instr.quiet_hours}`);
  if (instr?.other_rules)         facts.push(`Другие правила: ${instr.other_rules}`);
  if (instr?.checkout_until)      facts.push(`Выезд до: ${instr.checkout_until}`);

  const factsBlock = facts.length ? facts.join("\n") : "(Структурированные данные о квартире не заполнены.)";
  const aiExtra = (instr?.ai_instructions ?? "").toString().trim() || "(Дополнительные инструкции не заданы.)";

  return [
    "Ты — AI-помощник для гостя, который снял конкретную квартиру посуточно. Отвечай коротко, вежливо, на русском языке.",
    "",
    "ЖЕСТКИЕ ПРАВИЛА (нарушать НЕЛЬЗЯ):",
    "1. Используй ТОЛЬКО информацию из блока «ДАННЫЕ КВАРТИРЫ» ниже. Любые внешние знания запрещены.",
    "2. НИКОГДА не выдумывай адреса, коды, пароли, телефоны, правила, время, цены, названия мест, расстояния. Нет в данных — ты НЕ ЗНАЕШЬ ответа.",
    "3. Если вопрос выходит за рамки данных, ответь честно: «К сожалению, я не знаю этого точно. Лучше спросить менеджера», и укажи контакт: " + emergency + ".",
    "4. Не предлагай внешние карты, гугл, яндекс, магазины, аптеки, транспорт и т.п., если это явно не указано в данных.",
    "5. Ответ — обычный текст (легкая Markdown-вёрстка допустима), без HTML-тегов, без вымышленных линков. Коротко, по делу, 1–5 предложений.",
    "6. Не придумывай за гостя что он хочет сделать. Не выполняй действия от его имени в каких-либо внешних сервисах.",
    "7. Если гость просит решить проблему быта (поломка, шум соседей, пропал свет, горячая вода) — если в данных нет чёткого решения, переводи на менеджера.",
    "",
    "=== ДАННЫЕ КВАРТИРЫ (единственный допустимый источник) ===",
    factsBlock,
    "",
    "=== ДОПОЛНИТЕЛЬНЫЕ ИНСТРУКЦИИ ОТ МЕНЕДЖЕРА ПО ЭТОЙ КВАРТИРЕ ===",
    aiExtra,
    "",
    "Контакт менеджера для выхода за рамки данных: " + emergency + ".",
  ].join("\n");
}

function buildWelcomeMessage(fromName: string, instr: any): string {
  const greeting = `Здравствуйте, ${htmlEscape(fromName || "гость")}! 👋\n\nВаше бронирование найдено. Вот всё, что нужно знать:`;
  const blocks: string[] = [];
  const addr = blockAddress(instr);     if (addr)     blocks.push(addr);
  const cin  = blockCheckin(instr);     if (cin)      blocks.push(cin);
  const wifi = blockWifi(instr);        if (wifi)     blocks.push(wifi);
  const rules = blockRules(instr);      if (rules)    blocks.push(rules);
  const cout = blockCheckout(instr);    if (cout)     blocks.push(cout);
  if (!blocks.length) return `${greeting}\n\nИнструкция по заселению ещё не заполнена менеджером. Я уже сообщил ему — он скоро свяжется с вами.\n\nВы можете написать сюда любой вопрос — я передам менеджеру.`;
  return `${greeting}\n\n${blocks.join("\n\n━━━━━━━━━━━━━━━\n\n")}\n\n💬 Если что-то непонятно — напишите сюда, я передам менеджеру.`;
}

function ddmmyyyy(d: string | Date | null | undefined): string {
  if (!d) return "";
  const dt = typeof d === "string" ? new Date(d) : d;
  if (Number.isNaN(dt.getTime())) return "";
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${dt.getFullYear()}`;
}

// Автосоздание договора Okidoki при первом старте гостя (если включён auto_send).
// Возвращает ссылку, если договор создан или уже был, иначе null.
async function maybeCreateContract(session: Session): Promise<string | null> {
  const sb = svc();

  // 1) Достаём бронь + настройки менеджера
  const { data: bk } = await sb
    .from("rc_bookings")
    .select("*")
    .eq("user_id", session.user_id)
    .eq("booking_id", session.booking_id)
    .maybeSingle();
  if (!bk) return null;

  // Если ссылка уже есть — просто вернём её
  if (bk.okidoki_link) return String(bk.okidoki_link);

  const { data: ms } = await sb
    .from("manager_settings")
    .select("okidoki_api_key, okidoki_signer_card_id, okidoki_auto_send, okidoki_field_mapping")
    .eq("user_id", session.user_id)
    .maybeSingle();

  if (!ms?.okidoki_auto_send) return null;   // авто-отправка выключена
  if (!ms.okidoki_api_key)   return null;    // не настроен ключ

  // 2) Ищем шаблон квартиры
  const { data: apt } = await sb
    .from("apartment_contract_templates")
    .select("okidoki_template_id, field_mapping, okidoki_object_id, deposit")
    .eq("user_id", session.user_id)
    .eq("realty_id", bk.realty_id)
    .maybeSingle();

  if (!apt?.okidoki_template_id) {
    console.log(`[bot] maybeCreateContract: нет шаблона для realty ${bk.realty_id}`);
    await notifyManager(
      session.user_id,
      `⚠️ Гость запустил бота, но для квартиры <b>${htmlEscape(bk.apartment_title || String(bk.realty_id))}</b> не назначен шаблон договора Okidoki. Договор не создан. Откройте «Договоры (Okidoki)» → «Квартиры и шаблоны».`,
    );
    return null;
  }

  // ВАЖНО: keyword'ы должны СОВПАДАТЬ с названиями полей в шаблоне Okidoki.
  // «Описание и адрес квартиры» — выпадающий список. Передаём значение = ID объекта
  // из настроек шаблона Okidoki (хранится в apartment_contract_templates.okidoki_object_id).
  const DEFAULT_MAPPING: Record<string, string> = {
    begin_date:            "Дата заселения",
    end_date:              "Дата выселения",
    nights:                "Количество суток",
    price_per_night:       "Цена в сутки",
    price_total:           "Полная стоимость",
    prepaid:               "Оплачено",
    deposit:               "Обеспечительный платеж",
    apartment_object:      "Описание и адрес квартиры",
  };
  const userMapping: Record<string, string> = (ms.okidoki_field_mapping as any) || {};
  const aptMapping: Record<string, string> = apt.field_mapping || {};
  const mapping: Record<string, string> = { ...DEFAULT_MAPPING, ...userMapping, ...aptMapping };
  const nights = Math.max(1, Math.round(
    (new Date(bk.end_date).getTime() - new Date(bk.begin_date).getTime()) / (1000 * 60 * 60 * 24),
  ));
  const priceTotal = Number(bk.amount || 0);
  const prepaid = Number(bk.prepayment || 0);
  const remaining = Math.max(0, priceTotal - prepaid);
  const pricePerNight = nights > 0 ? Math.round((priceTotal / nights) * 100) / 100 : priceTotal;

  const deposit = Number(apt.deposit ?? 0);
  const aptObjectId = String(apt.okidoki_object_id || "");
  const logical: Record<string, string> = {
    begin_date:      ddmmyyyy(bk.begin_date),
    end_date:        ddmmyyyy(bk.end_date),
    nights:          String(nights),
    price_total:     String(priceTotal),
    price_per_night: String(pricePerNight),
    prepaid:         String(prepaid),
    remaining:       String(remaining),
    deposit:         String(deposit),
    apartment_title:       String(bk.apartment_title || ""),
    apartment_object:      aptObjectId,
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
    external_id: String(bk.booking_id),
    template_id: apt.okidoki_template_id,
    source: "GreenYard",
    entities,
    system_entities,
    callback_url,
    api_key: ms.okidoki_api_key,
  };
  if (ms.okidoki_signer_card_id) contractBody.actual_user_card_id = ms.okidoki_signer_card_id;

  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 20000);
    const r = await fetch("https://api.doki.online/external/contract", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(contractBody),
      signal: ac.signal,
    });
    clearTimeout(t);
    const text = await r.text();
    let data: any; try { data = JSON.parse(text); } catch { data = text; }
    if (!r.ok) {
      console.error("[bot] okidoki contract error:", r.status, text);
      await notifyManager(session.user_id, `❌ Не удалось создать договор гостю (бронь <code>${session.booking_id}</code>): ${htmlEscape(String(data?.error || data || r.status))}`);
      return null;
    }
    const link = data?.link || "";
    const contract_id = data?.contract_id || "";
    const statusName = data?.status?.name || "";
    const statusInternal = data?.status?.internal_id ?? null;
    await sb.from("rc_bookings").update({
      okidoki_contract_id: contract_id,
      okidoki_link: link,
      contract_status: statusName,
      contract_status_internal: statusInternal,
      contract_updated_at: new Date().toISOString(),
    }).eq("user_id", session.user_id).eq("booking_id", session.booking_id);

    // Если черновик (internal_id=0) — гостю не отправляем, а уведомляем менеджера с деталями
    if (statusInternal === 0) {
      const sentKeywords = entities.map((e) => `• ${htmlEscape(e.keyword)}: <code>${htmlEscape(e.value)}</code>`).join("\n");
      await notifyManager(
        session.user_id,
        `⚠️ Договор по брони <code>${session.booking_id}</code> создан, но остался в статусе «Черновик».\n\nЭто значит, что keyword’ы, которые мы отправили, <b>не совпали</b> с названиями полей в шаблоне Okidoki, или в шаблоне остались незаполненные обязательные поля (например список «Описание и адрес квартиры»).\n\n<b>Что делать:</b>\n1) Откройте договор, посмотрите, какие поля остались пустыми.\n2) Сверьте точные названия полей в шаблоне (какой там регистр, пробелы) — если в шаблоне название другое (например «цена в сутки», а не «Цена в сутки») — сообщите в поддержку.\n3) Сейчас мы слали keyword’ы <b>с заглавной буквы</b> — как в видимых метках полей в Okidoki.\n\n<b>Передано:</b>\n${sentKeywords}\n\n<a href="${link}">Открыть черновик</a>`,
      );
      return null;
    }

    return link || null;
  } catch (e) {
    console.error("[bot] okidoki contract exception:", e);
    return null;
  }
}

/**
 * Отправляет гостю ссылку на оплату остатка по брони.
 *
 * Сумма — задолженность (полная стоимость минус внесённая предоплата).
 * Если долга нет, ничего не отправляем. Способ оплаты (ссылка Точки,
 * QR СБП или реквизиты) арендодатель выбирает в настройках приложения.
 *
 * @param silent при ручном нажатии кнопки гостю нужно ответить всегда,
 *               при автоматической отправке — молчим, если платить нечего.
 */
async function sendPaymentLink(to: Recipient, session: Session, silent: boolean): Promise<void> {
  const sb = svc();
  let res;
  try {
    res = await ensureBookingPayment(sb, session.user_id, session.booking_id);
  } catch (e) {
    console.error("[bot] ensureBookingPayment:", (e as Error).message);
    if (!silent) await send(to, "Не получилось подготовить оплату. Менеджер уже знает и свяжется с вами.");
    await notifyManager(session.user_id, `❌ Не удалось создать оплату по брони <code>${htmlEscape(String(session.booking_id))}</code>: ${htmlEscape(String((e as Error).message).slice(0, 300))}`);
    return;
  }

  if (res.kind === "disabled") {
    if (!silent) await send(to, "Онлайн-оплата пока недоступна. Напишите сюда — менеджер подскажет, как оплатить.");
    return;
  }
  if (res.kind === "nothing_to_pay") {
    if (!silent) await send(to, "✅ Проживание полностью оплачено, доплачивать ничего не нужно.");
    return;
  }
  if (res.kind === "need_email") {
    // Ставим признак ожидания: следующее сообщение гостя разберём как почту.
    await sb.from("guest_sessions").update({ awaiting_email: true }).eq("id", session.id);
    const sum = res.amount.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const ask = `Для оплаты остатка <b>${htmlEscape(sum)} ₽</b> нужна ваша почта — на неё придёт кассовый чек.\n\nНапишите адрес одним сообщением, например: <code>ivan@mail.ru</code>`;
    await sendMessage(to, ask, { preview: false });
    await logMessage(session, "bot", ask, { kind: "ask_email", amount: res.amount });
    return;
  }
  if (res.kind === "error") {
    if (!silent) await send(to, "Не получилось подготовить оплату. Менеджер уже знает и свяжется с вами.");
    await notifyManager(session.user_id, `❌ Оплата по брони <code>${htmlEscape(String(session.booking_id))}</code> не создана: ${htmlEscape(String(res.reason || "").slice(0, 300))}`);
    return;
  }

  const msg = paymentMessage(res, htmlEscape);
  if (!msg) return;
  await sendMessage(to, msg, { preview: false });
  await logMessage(session, "bot", msg, {
    kind: "payment_link",
    method: res.method,
    amount: res.amount,
    payment_id: res.paymentId ?? null,
  });
  if (res.paymentId) {
    await sb.from("tochka_payments")
      .update({ sent_at: new Date().toISOString() })
      .eq("id", res.paymentId);
  }
  const sum = res.amount.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  await notifyManager(session.user_id, `💳 Гостю отправлена оплата на <b>${htmlEscape(sum)} ₽</b> (бронь <code>${htmlEscape(String(session.booking_id))}</code>).`);
}

// ═══════════════════════════════════════════════════════════════════
// СЦЕНАРИИ ГОСТЯ
// ═══════════════════════════════════════════════════════════════════

async function handleStart(to: Recipient, args: string, from: InboundEvent["from"]) {
  const secureId = (args || "").trim();
  const fromName = [from?.firstName, from?.lastName].filter(Boolean).join(" ") || from?.username || "";
  if (!secureId) {
    await send(to, "Здравствуйте! Похоже, вы открыли бота без персональной ссылки.\n\nПожалуйста, используйте ссылку, которую прислал менеджер — она содержит данные вашего бронирования.");
    return;
  }
  let session = await findSessionBySecureId(secureId);
  if (!session) {
    await send(to, "Ссылка не найдена или устарела. Свяжитесь, пожалуйста, с менеджером — он отправит новую ссылку.");
    return;
  }
  const sb = svc();
  const updatePatch: Record<string, any> = {
    // Telegram-колонки заполняем только для Telegram, чтобы не смешивать данные.
    tg_chat_id: to.channel === "telegram" ? Number(to.chatId) : null,
    tg_username: to.channel === "telegram" ? (from?.username ?? null) : null,
    tg_first_name: from?.firstName ?? null,
    tg_last_name: from?.lastName ?? null,
    channel: to.channel,
    channel_chat_id: to.chatId,
    updated_at: new Date().toISOString(),
  };
  if (!session.started_at) updatePatch.started_at = new Date().toISOString();
  const { data: upd } = await sb
    .from("guest_sessions")
    .update(updatePatch)
    .eq("id", session.id)
    .select(SESSION_COLS)
    .maybeSingle();
  if (upd) session = upd as Session;

  const { id: apartmentId } = await resolveApartmentId(session.user_id, session.realty_id, session.booking_id);
  const instr = await loadInstructions(session.user_id, apartmentId);
  const settings = (await loadManagerSettings(session.user_id)) as ManagerSettings | null;

  const welcome = buildWelcomeMessage(fromName, instr);
  await send(to, welcome, guestKeyboard(settings?.guest_channel_url ?? null, Boolean((settings as any)?.tochka_enabled)));
  await logMessage(session, "bot", welcome, { kind: "welcome" });
  await logEvent(session, "custom", { kind: "bot_started", channel: to.channel, chat_id: to.chatId, from: fromName });
  await notifyManager(session.user_id, `🟢 Гость <b>${htmlEscape(fromName || "—")}</b> запустил бота (${CHANNEL_TITLE[to.channel]}).\nБронь: <code>${session.booking_id}</code>`);

  // Автосоздание договора Okidoki (если включено)
  try {
    const link = await maybeCreateContract(session);
    if (link) {
      const msg = `📄 <b>Договор аренды</b>\n\nДля вашего заселения подготовлен договор. Пожалуйста, ознакомьтесь и подпишите по ссылке:\n${htmlEscape(link)}\n\nПосле подписания менеджер получит уведомление и подтвердит вашу бронь.`;
      await sendMessage(to, msg, { preview: true });
      await logMessage(session, "bot", msg, { kind: "okidoki_link", link });
      await notifyManager(session.user_id, `📄 Гостю отправлена ссылка на договор (бронь <code>${session.booking_id}</code>).`);
    }
  } catch (e) {
    console.error("[bot] maybeCreateContract failed:", e);
  }

  // Ссылка на оплату остатка — сразу за договором.
  try {
    await sendPaymentLink(to, session, true);
  } catch (e) {
    console.error("[bot] sendPaymentLink failed:", e);
  }
}

async function handleCommand(to: Recipient, cmd: string) {
  const session = await findSessionByRcpt(to);
  if (!session) {
    await send(to, "Сначала откройте бота по персональной ссылке от менеджера (она содержит код вашего бронирования).");
    return;
  }
  const { id: apartmentId } = await resolveApartmentId(session.user_id, session.realty_id, session.booking_id);
  const instr = await loadInstructions(session.user_id, apartmentId);
  const settings = (await loadManagerSettings(session.user_id)) as ManagerSettings | null;
  const fallback = "Инструкция ещё не заполнена менеджером. Напишите сюда — менеджер ответит.";
  let reply = "";
  switch (cmd) {
    case "address": case "info": reply = blockAddress(instr) || fallback; break;
    case "wifi": reply = blockWifi(instr) || fallback; break;
    case "checkin": case "checkin_info": reply = blockCheckin(instr) || fallback; break;
    case "checkout": case "checkout_info": reply = blockCheckout(instr) || fallback; break;
    case "rules": reply = blockRules(instr) || "Особых правил нет. Будьте аккуратны и уважайте соседей."; break;
    case "help": reply = blockHelp(instr); break;
    case "pay": case "payment":
      await sendPaymentLink(to, session, false);
      await logMessage(session, "inbound", "Запрос оплаты", { kind: "command", cmd });
      return;
    case "menu": case "start_menu": reply = "Выберите, что вас интересует:"; break;
    default: reply = "Команда не распознана. Используйте кнопки ниже.";
  }
  await send(to, reply, guestKeyboard(settings?.guest_channel_url ?? null, Boolean((settings as any)?.tochka_enabled)));
  await logMessage(session, "bot", reply, { kind: "command", cmd });
}

async function handleArrival(to: Recipient, from: InboundEvent["from"], kind: "arrived" | "leaving") {
  const session = await findSessionByRcpt(to);
  if (!session) { await send(to, "Сессия не найдена. Откройте бота по ссылке от менеджера."); return; }
  const fromName = [from?.firstName, from?.lastName].filter(Boolean).join(" ") || from?.username || "";
  const settings = (await loadManagerSettings(session.user_id)) as ManagerSettings | null;
  const kb = guestKeyboard(settings?.guest_channel_url ?? null, Boolean((settings as any)?.tochka_enabled));
  if (kind === "arrived") {
    const reply = "Спасибо! ✅ Я передал менеджеру, что вы приехали. Хорошего отдыха!";
    await send(to, reply, kb);
    await logMessage(session, "bot", reply, { kind: "arrival" });
    await logEvent(session, "checkin", { from: fromName });
    await notifyManager(session.user_id, `✅ Гость <b>${htmlEscape(fromName || "—")}</b> сообщил о заселении.\nБронь: <code>${session.booking_id}</code>`, "notify_on_checkin");
  } else {
    const reply = "Спасибо, что были у нас! 👋 Я передал менеджеру, что вы уезжаете.";
    await send(to, reply, kb);
    await logMessage(session, "bot", reply, { kind: "departure" });
    await logEvent(session, "checkout", { from: fromName });
    await notifyManager(session.user_id, `👋 Гость <b>${htmlEscape(fromName || "—")}</b> сообщил, что уезжает.\nБронь: <code>${session.booking_id}</code>`, "notify_on_checkout");
  }
}

/** Почта в свободном тексте: гость может написать «моя почта ivan@mail.ru». */
function extractEmail(text: string): string | null {
  const m = String(text || "").match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  return m ? m[0].toLowerCase() : null;
}

/**
 * Ответ гостя на вопрос о почте для чека.
 *
 * @returns true, если сообщение обработано и дальше его вести не надо.
 */
async function handleEmailAnswer(to: Recipient, session: Session, text: string): Promise<boolean> {
  const sb = svc();
  const email = extractEmail(text);
  if (!email) {
    // Гость написал что-то другое — не держим его в тупике, снимаем ожидание.
    await sb.from("guest_sessions").update({ awaiting_email: false }).eq("id", session.id);
    (session as any).awaiting_email = false;
    return false;
  }

  await sb.from("rc_bookings")
    .update({ client_email: email })
    .eq("user_id", session.user_id)
    .eq("booking_id", session.booking_id);
  await sb.from("guest_sessions").update({ awaiting_email: false }).eq("id", session.id);
  (session as any).awaiting_email = false;

  const ok = `Спасибо, чек пришлём на <code>${htmlEscape(email)}</code>. Готовлю ссылку на оплату…`;
  await sendMessage(to, ok, { preview: false });
  await logMessage(session, "bot", ok, { kind: "email_saved" });

  await sendPaymentLink(to, session, false);
  return true;
}

async function handleFreeText(to: Recipient, from: InboundEvent["from"], text: string, messageId: string | null) {
  const session = await findSessionByRcpt(to);
  if (!session) {
    await send(to, "Сессия не найдена. Откройте бота по персональной ссылке от менеджера (она содержит код вашего бронирования).");
    return;
  }
  const fromName = [from?.firstName, from?.lastName].filter(Boolean).join(" ") || from?.username || "Гость";
  await logMessage(session, "inbound", text, { message_id: messageId, channel: to.channel, from });

  // Ждём почту для чека — разбираем её до всей остальной логики.
  if ((session as any).awaiting_email) {
    const handled = await handleEmailAnswer(to, session, text);
    if (handled) return;
  }

  const { id: apartmentId, diag: resolveDiag } = await resolveApartmentId(session.user_id, session.realty_id, session.booking_id);
  const instr = await loadInstructions(session.user_id, apartmentId);
  const settings = (await loadManagerSettings(session.user_id)) as ManagerSettings | null;
  const kb = guestKeyboard(settings?.guest_channel_url ?? null, Boolean((settings as any)?.tochka_enabled));

  const aiInstrLen = (instr?.ai_instructions ?? "").toString().trim().length;
  const sessionAiEnabled = session.ai_enabled !== false;
  const aiEnabled = !!OR_API_KEY && aiInstrLen > 0 && sessionAiEnabled;
  const diag: Record<string, any> = {
    has_key: !!OR_API_KEY,
    key_len: OR_API_KEY.length,
    apartment_id: apartmentId,
    resolve: resolveDiag,
    instr_found: !!instr,
    ai_instr_len: aiInstrLen,
    ai_enabled: aiEnabled,
    session_ai_enabled: sessionAiEnabled,
    channel: to.channel,
    model: OR_MODEL,
  };
  console.log(`[bot] handleFreeText diag: ${JSON.stringify(diag)}`);
  try {
    await svc().from("guest_sessions").update({ debug_last: { kind: "ai_diag", at: new Date().toISOString(), ...diag } }).eq("id", session.id);
  } catch (e) { console.error("[bot] debug_last diag update failed:", e); }

  if (aiEnabled) {
    const systemPrompt = buildAiSystemPrompt(instr);
    let aiText: string | null = null;
    let usedModel: string | null = null;
    const modelErrors: Array<{ model: string; error: string }> = [];
    const modelsToTry = [
      OR_MODEL,
      "google/gemma-4-31b-it:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "google/gemma-4-26b-a4b-it:free",
      "openrouter/free",
    ].filter((m, i, arr) => m && arr.indexOf(m) === i);

    for (const modelId of modelsToTry) {
      let modelErr = "";
      try {
        const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${OR_API_KEY}`,
            "Content-Type": "application/json",
            "HTTP-Referer": OR_REFERER,
            "X-Title": OR_TITLE,
          },
          body: JSON.stringify({
            model: modelId,
            temperature: 0.2,
            max_tokens: 500,
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user",   content: text },
            ],
          }),
        });
        const bodyText = await r.text();
        if (!r.ok) modelErr = `http_${r.status}: ${bodyText.slice(0, 200)}`;
        else {
          try {
            const data = JSON.parse(bodyText);
            const msg = data?.choices?.[0]?.message?.content;
            if (typeof msg === "string" && msg.trim()) { aiText = msg.trim(); usedModel = modelId; break; }
            else modelErr = `empty_response`;
          } catch (e) { modelErr = `parse_error: ${String(e)}`; }
        }
      } catch (e) { modelErr = `fetch_exception: ${String(e)}`; }
      modelErrors.push({ model: modelId, error: modelErr });
      console.error(`[bot] openrouter model failed ${modelId}: ${modelErr}`);
    }

    try {
      await svc().from("guest_sessions").update({ debug_last: { kind: "ai_result", at: new Date().toISOString(), ok: !!aiText, reply_len: aiText?.length ?? 0, used_model: usedModel, errors: modelErrors } }).eq("id", session.id);
    } catch (e) { console.error("[bot] debug_last result update failed:", e); }

    if (aiText) {
      const outText = aiText.length > 3800 ? aiText.slice(0, 3800) + "…" : aiText;
      // Ответ модели — обычный текст: разметку не интерпретируем.
      await sendMessage(to, outText, { buttons: kb, plain: true });
      await logMessage(session, "bot", outText, { kind: "ai_reply", model: usedModel });
      await notifyManager(session.user_id, `🤖 <b>${htmlEscape(fromName)}</b> (бронь <code>${session.booking_id}</code>) — вопрос:\n${htmlEscape(text)}\n\n<i>AI-ответ гостю:</i>\n${htmlEscape(outText)}`, "notify_on_inbound");
      return;
    }
    console.warn("[bot] AI включён, но вызов не удался — передаём сообщение менеджеру");
  }

  const reply = sessionAiEnabled
    ? "Спасибо за сообщение! ✉️ Я передал его менеджеру — он скоро ответит."
    : "Спасибо за сообщение! ✉️ Менеджер увидит его и ответит лично.";
  await send(to, reply, kb);
  await logMessage(session, "bot", reply, { kind: "ack" });
  await notifyManager(session.user_id, `💬 <b>${htmlEscape(fromName)}</b> (бронь <code>${session.booking_id}</code>):\n\n${htmlEscape(text)}`, "notify_on_inbound");
}

// ═══════════════════════════════════════════════════════════════════
// ЕДИНЫЙ ОБРАБОТЧИК ВХОДЯЩИХ СОБЫТИЙ (общий для всех каналов)
// ═══════════════════════════════════════════════════════════════════

async function handleEvent(ev: InboundEvent) {
  const to: Recipient = { channel: ev.channel, chatId: ev.chatId };

  // ─── Нажатие кнопки ───────────────────────────────────────────────
  if (ev.kind === "callback") {
    if (ev.callbackId) await answerCallback(ev.channel, ev.callbackId);
    const data = ev.callbackData || "";

    // Сначала горничная: её кнопки начинаются с maid_
    if (data.startsWith("maid_")) {
      const maid = await findMaidByRcpt(to);
      if (maid) {
        const handled = await handleMaidCallback(maid, to, data, ev.messageId ?? null);
        if (handled) return;
      }
    }

    if (data === "i_arrived") await handleArrival(to, ev.from, "arrived");
    else if (data === "i_leaving") await handleArrival(to, ev.from, "leaving");
    else await handleCommand(to, data);
    return;
  }

  // ─── Переход по ссылке-приглашению ────────────────────────────────
  if (ev.kind === "start") {
    const arg = (ev.startPayload || "").trim();
    if (arg.startsWith("maid_")) {
      await handleMaidStart(to, arg.slice(5), ev.from);
      return;
    }
    await handleStart(to, arg, ev.from);
    return;
  }

  // ─── Обычное сообщение ────────────────────────────────────────────
  const text = ev.text || "";

  // Если чат уже привязан к горничной — весь трафик её
  const maid = await findMaidByRcpt(to);
  if (maid) {
    if (text.trim() || ev.photoUrl) {
      await handleMaidFreeText(maid, to, text, ev.messageId ?? null, ev.photoUrl ?? undefined);
    }
    return;
  }

  if (text.startsWith("/")) {
    const cmd = text.split(/\s+/)[0].replace(/^\//, "").split("@")[0];
    await handleCommand(to, cmd);
    return;
  }
  if (text.trim()) await handleFreeText(to, ev.from, text, ev.messageId ?? null);
}

// ═══════════════════════════════════════════════════════════════════
// ВЕБХУКИ КАНАЛОВ
// ═══════════════════════════════════════════════════════════════════

async function endpointTelegramWebhook(req: Request): Promise<Response> {
  if (TG_SECRET) {
    const got = req.headers.get("x-telegram-bot-api-secret-token");
    if (got !== TG_SECRET) return json({ ok: false, error: "bad_secret" }, 401);
  }
  let update: any = null;
  try { update = await req.json(); }
  catch { return json({ ok: false, error: "bad_json" }, 400); }
  try {
    const ev = await parseTelegramUpdate(update);
    if (ev) await handleEvent(ev);
  } catch (e) { console.error("[bot] telegram handleEvent error:", e); }
  return json({ ok: true });
}

/**
 * MAX не передаёт секретный заголовок, поэтому секрет кладём в адрес вебхука:
 * .../telegram-bot/max?s=<MAX_WEBHOOK_SECRET>
 */
async function endpointMaxWebhook(req: Request, url: URL): Promise<Response> {
  if (MAX_SECRET && url.searchParams.get("s") !== MAX_SECRET) {
    return json({ ok: false, error: "bad_secret" }, 401);
  }
  let update: any = null;
  try { update = await req.json(); }
  catch { return json({ ok: false, error: "bad_json" }, 400); }
  try {
    const ev = parseMaxUpdate(update);
    if (ev) await handleEvent(ev);
  } catch (e) { console.error("[bot] max handleEvent error:", e); }
  return json({ ok: true });
}

/** WhatsApp сначала проверяет адрес GET-запросом с контрольным токеном. */
function endpointWhatsappVerify(url: URL): Response {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge") ?? "";
  if (mode === "subscribe" && WA_VERIFY && token === WA_VERIFY) {
    return new Response(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  }
  return new Response("forbidden", { status: 403 });
}

async function endpointWhatsappWebhook(req: Request): Promise<Response> {
  let body: any = null;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: "bad_json" }, 400); }
  try {
    const events = await parseWhatsappUpdate(body);
    for (const ev of events) await handleEvent(ev);
  } catch (e) { console.error("[bot] whatsapp handleEvent error:", e); }
  // WhatsApp повторяет доставку при любом ответе кроме 200.
  return json({ ok: true });
}

// ═══════════════════════════════════════════════════════════════════
// ЭНДПОИНТЫ ДЛЯ ПРИЛОЖЕНИЯ
// ═══════════════════════════════════════════════════════════════════

/** Какие каналы настроены на сервере и как выглядят ссылки-приглашения. */
async function endpointChannels(req: Request): Promise<Response> {
  const userId = await getUserIdFromJwt(req);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 401);
  const list = enabledChannels();
  return json({
    ok: true,
    channels: list.map((c) => ({
      id: c,
      title: CHANNEL_TITLE[c],
      // Пример ссылки с подставным кодом — чтобы интерфейс мог показать формат.
      invite_example: inviteLink(c, "КОД"),
    })),
  });
}

async function endpointSend(req: Request): Promise<Response> {
  const userId = await getUserIdFromJwt(req);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 401);
  let body: any = null;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: "bad_json" }, 400); }
  const sessionId = body?.session_id;
  const text = (body?.text || "").toString().trim();
  if (!sessionId || !text) return json({ ok: false, error: "session_id_and_text_required" }, 400);
  const sb = svc();
  const { data: session, error } = await sb
    .from("guest_sessions")
    .select("id,user_id,booking_id,tg_chat_id,channel,channel_chat_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (error || !session) return json({ ok: false, error: "session_not_found" }, 404);
  if (session.user_id !== userId) return json({ ok: false, error: "forbidden" }, 403);
  const to = sessionRcpt(session as Session);
  if (!to.chatId) return json({ ok: false, error: "guest_not_connected" }, 409);

  const res = await send(to, text);
  if (!res.ok) {
    console.error("[bot] endpointSend ошибка отправки:", res.error);
    return json({ ok: false, error: "channel_error" }, 502);
  }
  const { error: insErr } = await sb.from("guest_messages").insert({
    user_id: session.user_id,
    session_id: session.id,
    booking_id: session.booking_id,
    direction: "manager",
    body: text,
    payload: { message_id: res.messageId, channel: to.channel, via: "endpoint_send" },
    is_read_by_manager: true,
  });
  if (insErr) console.error("[bot] endpointSend insert:", insErr.message);
  await sb.from("guest_sessions").update({ last_message_at: new Date().toISOString() }).eq("id", session.id);
  return json({ ok: true, message_id: res.messageId, channel: to.channel, tg_message_id: res.messageId });
}

async function endpointTest(req: Request): Promise<Response> {
  const userId = await getUserIdFromJwt(req);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 401);
  const settings = await loadManagerSettings(userId);
  const to = managerRcpt(settings);
  if (!to) return json({ ok: false, error: "manager_chat_id_not_set" }, 400);
  const text = `✅ <b>Это тестовое сообщение от Green Yard.</b>\n\nКанал: <b>${CHANNEL_TITLE[to.channel]}</b>.\nЕсли вы видите его — уведомления настроены корректно и бот будет писать сюда о действиях гостей.`;
  const r = await send(to, text);
  if (!r.ok) {
    console.error("[bot] endpointTest ошибка отправки:", r.error);
    return json({ ok: false, error: "channel_error", channel: to.channel }, 502);
  }
  return json({ ok: true, channel: to.channel });
}

/** Сообщение от менеджера горничной. */
async function endpointSendMaid(req: Request): Promise<Response> {
  const userId = await getUserIdFromJwt(req);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 401);
  let body: any = null;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: "bad_json" }, 400); }
  const maidId = body?.maid_id;
  const text = (body?.text || "").toString().trim();
  if (!maidId || !text) return json({ ok: false, error: "maid_id_and_text_required" }, 400);
  const sb = svc();
  const { data: maid, error } = await sb
    .from("maids")
    .select("id, user_id, tg_chat_id, channel, channel_chat_id, name")
    .eq("id", maidId)
    .maybeSingle();
  if (error || !maid) return json({ ok: false, error: "maid_not_found" }, 404);
  if (maid.user_id !== userId) return json({ ok: false, error: "forbidden" }, 403);
  const to = maidRcpt(maid);
  if (!to) return json({ ok: false, error: "maid_not_connected" }, 409);

  const res = await send(to, text);
  if (!res.ok) {
    console.error("[bot] endpointSendMaid ошибка отправки:", res.error);
    return json({ ok: false, error: "channel_error" }, 502);
  }
  await sb.from("maid_messages").insert({
    user_id: maid.user_id,
    maid_id: maid.id,
    tg_chat_id: to.channel === "telegram" ? Number(to.chatId) : null,
    tg_message_id: to.channel === "telegram" && res.messageId ? Number(res.messageId) : null,
    channel: to.channel,
    channel_chat_id: to.chatId,
    direction: "outbound",
    sender: "manager",
    text,
  });
  return json({ ok: true, message_id: res.messageId, channel: to.channel, tg_message_id: res.messageId });
}

/**
 * Ссылка-приглашение для горничной в выбранном канале.
 * Тело: { maid_id, channel }.
 */
async function endpointMaidInvite(req: Request): Promise<Response> {
  const userId = await getUserIdFromJwt(req);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 401);
  let body: any = null;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: "bad_json" }, 400); }
  const maidId = body?.maid_id;
  const channel = isChannel(body?.channel) ? body.channel : "telegram";
  if (!maidId) return json({ ok: false, error: "maid_id_required" }, 400);

  const sb = svc();
  const { data: maid } = await sb.from("maids").select("id, user_id, invite_token").eq("id", maidId).maybeSingle();
  if (!maid) return json({ ok: false, error: "maid_not_found" }, 404);
  if (maid.user_id !== userId) return json({ ok: false, error: "forbidden" }, 403);

  // Токен одноразовый: если его уже погасили при подключении — выпускаем новый.
  let token: string = maid.invite_token ?? "";
  if (!token) {
    token = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    await sb.from("maids").update({ invite_token: token, updated_at: new Date().toISOString() }).eq("id", maid.id);
  }

  const link = inviteLink(channel, `maid_${token}`);
  if (!link) return json({ ok: false, error: "channel_not_configured", channel }, 409);
  return json({ ok: true, channel, link });
}

/**
 * Ссылка-приглашение для гостя в выбранном канале.
 * Тело: { session_id, channel }.
 */
async function endpointGuestInvite(req: Request): Promise<Response> {
  const userId = await getUserIdFromJwt(req);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 401);
  let body: any = null;
  try { body = await req.json(); }
  catch { return json({ ok: false, error: "bad_json" }, 400); }
  const sessionId = body?.session_id;
  const channel = isChannel(body?.channel) ? body.channel : "telegram";
  if (!sessionId) return json({ ok: false, error: "session_id_required" }, 400);

  const sb = svc();
  const { data: session } = await sb.from("guest_sessions").select("id, user_id, secure_id").eq("id", sessionId).maybeSingle();
  if (!session) return json({ ok: false, error: "session_not_found" }, 404);
  if (session.user_id !== userId) return json({ ok: false, error: "forbidden" }, 403);
  if (!session.secure_id) return json({ ok: false, error: "no_secure_id" }, 409);

  const link = inviteLink(channel, session.secure_id);
  if (!link) return json({ ok: false, error: "channel_not_configured", channel }, 409);
  return json({ ok: true, channel, link });
}

/** Утренние напоминания горничным в день уборки. Защита: заголовок x-cron-secret. */
async function endpointCleaningReminders(req: Request): Promise<Response> {
  const got = req.headers.get("x-cron-secret") || "";
  const sb = svc();
  const { data: cfg } = await sb.from("cron_config").select("secret").eq("key", "cleaning_reminders").maybeSingle();
  const secret = cfg?.secret || Deno.env.get("CRON_SECRET") || "";
  if (!secret || got !== secret) return json({ ok: false, error: "forbidden" }, 403);

  const today = new Date().toISOString().slice(0, 10);

  const { data: cleanings } = await sb
    .from("cleanings")
    .select("id, user_id, maid_id, apartment_title, scheduled_date, scheduled_time, status, reminded_at")
    .eq("scheduled_date", today)
    .in("status", ["accepted", "pending_response"])
    .is("reminded_at", null);

  let sent = 0;
  for (const c of cleanings || []) {
    if (!c.maid_id) continue;
    const { data: maid } = await sb.from("maids").select("channel, channel_chat_id, tg_chat_id, name").eq("id", c.maid_id).maybeSingle();
    const to = maid ? maidRcpt(maid) : null;
    if (!to) continue;
    const text = `⏰ Напоминание: сегодня уборка.\nАдрес: ${htmlEscape(c.apartment_title || "")}`;
    const r = await send(to, text);
    if (r.ok) {
      await sb.from("cleanings").update({ reminded_at: new Date().toISOString() }).eq("id", c.id);
      sent++;
    }
  }

  return json({ ok: true, sent, total: (cleanings || []).length });
}

// ═══════════════════════════════════════════════════════════════════
// МАРШРУТИЗАЦИЯ
// ═══════════════════════════════════════════════════════════════════

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/telegram-bot/, "") || "/";
  try {
    // Вебхуки мессенджеров
    if (req.method === "POST" && (path === "/" || path === ""))    return await endpointTelegramWebhook(req);
    if (req.method === "POST" && path === "/max")                  return await endpointMaxWebhook(req, url);
    if (req.method === "GET"  && path === "/whatsapp")             return endpointWhatsappVerify(url);
    if (req.method === "POST" && path === "/whatsapp")             return await endpointWhatsappWebhook(req);

    // Эндпоинты приложения
    if (req.method === "POST" && path === "/send")                 return await endpointSend(req);
    if (req.method === "POST" && path === "/send_maid")            return await endpointSendMaid(req);
    if (req.method === "POST" && path === "/test")                 return await endpointTest(req);
    if (req.method === "POST" && path === "/maid_invite")          return await endpointMaidInvite(req);
    if (req.method === "POST" && path === "/guest_invite")         return await endpointGuestInvite(req);
    if (req.method === "GET"  && path === "/channels")             return await endpointChannels(req);
    if (req.method === "POST" && path === "/cleaning_reminders")   return await endpointCleaningReminders(req);

    if (req.method === "GET" && (path === "/" || path === "")) {
      return json({
        ok: true,
        service: "green-yard-bot",
        version: 15,
        enabled_channels: enabledChannels(),
        endpoints: [
          "POST /", "POST /max", "GET|POST /whatsapp",
          "POST /send", "POST /send_maid", "POST /test",
          "POST /maid_invite", "POST /guest_invite",
          "GET /channels", "POST /cleaning_reminders",
        ],
      });
    }
    return json({ ok: false, error: "not_found", path }, 404);
  } catch (e) {
    // Полные детали (включая stack) — только в серверный лог;
    // клиенту отдаём общее сообщение (CodeQL js/stack-trace-exposure).
    console.error("[bot] router error:", e);
    return json({ ok: false, error: "Internal server error" }, 500);
  }
});
