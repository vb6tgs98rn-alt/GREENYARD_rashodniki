/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 *
 * Копирование, распространение, переработка и обратная разработка
 * (reverse engineering) запрещены без письменного разрешения правообладателя.
 * Условия: см. файл LICENSE. Нарушение влечёт ответственность по ст. 1252,
 * 1301 ГК РФ.
 */
// Edge Function: отдельный бот для горничных (v1).
//
// Держит собственный Telegram- и MAX-токен (MAID_TELEGRAM_BOT_TOKEN /
// MAID_MAX_BOT_TOKEN), работает независимо от общего бота гостей/менеджера.
// Все ответы горничной идут через botProfile: "maid", уведомления менеджеру —
// через общий бот (botProfile: "default"), как раньше.
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  answerCallback,
  type BotProfile,
  type Btn,
  type ChannelId,
  CHANNEL_TITLE,
  channelEnabled,
  enabledChannels,
  htmlEscape,
  type InboundEvent,
  inviteLink,
  isChannel,
  parseMaxUpdate,
  parseTelegramUpdate,
  type Recipient,
  sendMessage,
} from "../_shared/channels.ts";

const MAID_PROFILE: BotProfile = "maid";

const TG_SECRET    = Deno.env.get("MAID_TELEGRAM_WEBHOOK_SECRET")   ?? "";
const MAX_SECRET   = Deno.env.get("MAID_MAX_WEBHOOK_SECRET")        ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")                   ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")      ?? "";

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

// Telegram разрешает в secret_token только [A-Za-z0-9_-]; менеджер мог задать
// произвольный секрет. Приводим к SHA-256 hex, как в общем боте.
let _tgWebhookToken: string | null = null;
async function tgWebhookToken(): Promise<string> {
  if (_tgWebhookToken !== null) return _tgWebhookToken;
  if (!TG_SECRET) { _tgWebhookToken = ""; return ""; }
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(TG_SECRET));
  _tgWebhookToken = Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return _tgWebhookToken;
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

// ─── Отправка ─────────────────────────────────────────────────────────

/** Горничной: всегда через bot-профиль "maid". */
async function sendMaid(to: Recipient, html: string, buttons?: Btn[][]) {
  return await sendMessage(to, html, { buttons, botProfile: MAID_PROFILE });
}

/** Менеджеру: через общий бот (профиль "default"). */
async function sendManagerRcpt(to: Recipient, html: string) {
  return await sendMessage(to, html, { botProfile: "default" });
}

// ─── Настройки менеджера ──────────────────────────────────────────────

type ManagerSettings = {
  manager_tg_chat_id: number | null;
  manager_channel: ChannelId | null;
  manager_channel_chat_id: string | null;
  notify_on_inbound: boolean | null;
  notify_on_cleaning_response: boolean | null;
  notify_on_supply_request: boolean | null;
  manager_recipients: Array<{ channel: string; chat_id: string }> | null;
};

function managerRcpt(s: any): Recipient | null {
  const channel = (isChannel(s?.manager_channel) ? s.manager_channel : "telegram") as ChannelId;
  const chatId = s?.manager_channel_chat_id
    ?? (channel === "telegram" && s?.manager_tg_chat_id != null ? String(s.manager_tg_chat_id) : null);
  return chatId ? { channel, chatId } : null;
}

function managerRecipients(s: any): Recipient[] {
  const raw = Array.isArray(s?.manager_recipients) ? s.manager_recipients : [];
  const list: Recipient[] = [];
  const seen = new Set<string>();
  const push = (channel: any, chatId: any) => {
    const ch = (isChannel(channel) ? channel : "telegram") as ChannelId;
    const id = chatId == null ? "" : String(chatId).trim();
    if (!id) return;
    const key = `${ch}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    list.push({ channel: ch, chatId: id });
  };
  for (const r of raw) push(r?.channel, r?.chat_id ?? r?.chatId);
  if (list.length === 0) {
    const legacy = managerRcpt(s);
    if (legacy) push(legacy.channel, legacy.chatId);
  }
  return list;
}

async function loadManagerSettings(userId: string) {
  const sb = svc();
  const { data, error } = await sb
    .from("manager_settings")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) console.error("[maid-bot] loadManagerSettings:", error.message);
  return data;
}

async function notifyManager(userId: string, text: string, flag?: keyof ManagerSettings) {
  const settings = await loadManagerSettings(userId);
  if (flag && (settings as any)?.[flag] === false) return;
  const rcpts = managerRecipients(settings);
  if (rcpts.length === 0) return;
  await Promise.all(rcpts.map(async (to) => {
    try { await sendManagerRcpt(to, text); }
    catch (e) { console.error(`[maid-bot] notifyManager (${to.channel}:${to.chatId}):`, e); }
  }));
}

// ─── Горничные ────────────────────────────────────────────────────────

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
    await sendMaid(to, "Уборка не найдена или уже неактуальна.");
    return true;
  }

  if (action === "maid_accept") {
    if (cleaning.status !== "pending_response") {
      if (cleaning.maid_id && cleaning.maid_id !== maid.id) {
        await sendMaid(to, `Эта уборка уже принята другой горничной. Спасибо.`);
      } else {
        await sendMaid(to, `Статус уборки: ${cleaning.status}.`);
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

    const offered: string[] = Array.isArray(cleaning.offered_to) ? cleaning.offered_to : [];
    for (const otherId of offered) {
      if (otherId === maid.id) continue;
      const { data: other } = await sb.from("maids").select("channel, channel_chat_id, tg_chat_id").eq("id", otherId).maybeSingle();
      const otherTo = other ? maidRcpt(other) : null;
      if (otherTo) {
        await sendMaid(otherTo, `ℹ️ Уборка (${htmlEscape(cleaning.apartment_title || "")}, ${fmtDateShort(cleaning.scheduled_date)}) уже принята другой горничной.`);
      }
    }

    await sendMaid(to, `✅ Спасибо. Уборка <b>${fmtDateShort(cleaning.scheduled_date)}</b> за вами.`);
    await notifyManager(maid.user_id, `✅ <b>${htmlEscape(maid.name)}</b> сможет убраться <b>${fmtDateShort(cleaning.scheduled_date)}</b> (${htmlEscape(cleaning.apartment_title || "")}).`, "notify_on_cleaning_response");
    return true;
  }

  if (action === "maid_decline") {
    if (cleaning.status !== "pending_response") {
      await sendMaid(to, `Уборка уже в статусе: ${cleaning.status}.`);
      return true;
    }
    const offered: string[] = Array.isArray(cleaning.offered_to) ? cleaning.offered_to : [];
    const others = offered.filter((id) => id !== maid.id);
    const updatePatch: any = { declined_at: new Date().toISOString(), offered_to: others };
    if (others.length === 0) updatePatch.status = "declined";
    await sb.from("cleanings").update(updatePatch).eq("id", cleaning.id);

    await sendMaid(to, `❌ Хорошо, передали менеджеру. Уборка <b>${fmtDateShort(cleaning.scheduled_date)}</b>.`);
    await notifyManager(maid.user_id, `❌ <b>${htmlEscape(maid.name)}</b> не сможет убраться <b>${fmtDateShort(cleaning.scheduled_date)}</b> (${htmlEscape(cleaning.apartment_title || "")}).${others.length === 0 ? "\n⚠️ Больше никому не предложено — назначьте вручную." : ""}`, "notify_on_cleaning_response");
    return true;
  }

  if (action === "maid_on_site") {
    if (cleaning.maid_id !== maid.id) {
      await sendMaid(to, "Эта уборка не назначена вам.");
      return true;
    }
    if (cleaning.status === "completed") {
      await sendMaid(to, "Уборка уже завершена.");
      return true;
    }
    await sb.from("cleanings").update({
      status: "on_site",
      on_site_at: new Date().toISOString(),
    }).eq("id", cleaning.id);

    const kb: Btn[][] = [[{ text: "✅ Уборка завершена", data: `maid_completed:${cleaning.id}` }]];
    await sendMaid(to, `🏠 Отмечено: вы на месте.\n📍 ${htmlEscape(cleaning.apartment_title || "")}\n\nКогда закончите — нажмите кнопку ниже.`, kb);
    await notifyManager(maid.user_id, `🏠 Горничная <b>${htmlEscape(maid.name)}</b> на месте: ${htmlEscape(cleaning.apartment_title || "")}.`, "notify_on_cleaning_response");
    return true;
  }

  if (action === "maid_completed") {
    if (cleaning.maid_id !== maid.id) {
      await sendMaid(to, "Эта уборка не назначена вам.");
      return true;
    }
    if (cleaning.status === "completed") {
      await sendMaid(to, "Уборка уже отмечена как завершённая.");
      return true;
    }
    await sb.from("cleanings").update({
      status: "completed",
      completed_at: new Date().toISOString(),
    }).eq("id", cleaning.id);

    await sendMaid(to, `✅ Спасибо! Уборка отмечена как завершённая.\n📍 ${htmlEscape(cleaning.apartment_title || "")}`);
    await notifyManager(maid.user_id, `✅ Горничная <b>${htmlEscape(maid.name)}</b> завершила уборку: ${htmlEscape(cleaning.apartment_title || "")} (${fmtDateShort(cleaning.scheduled_date)}).`, "notify_on_cleaning_response");
    return true;
  }

  if (action === "maid_supply") {
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
    await sendMaid(to, `📦 Напишите, что нужно докупить — можно текстом и/или фото.\nВаше следующее сообщение будет отправлено менеджеру как заявка.`);
    return true;
  }

  return false;
}

/** Горничная перешла по ссылке-приглашению: привязываем её чат к каналу. */
async function handleMaidStart(to: Recipient, token: string, from: InboundEvent["from"]) {
  const maid = await findMaidByInviteToken(token);
  if (!maid) {
    await sendMaid(to, "Ссылка-приглашение недействительна или уже использована. Попросите менеджера прислать новую.");
    return;
  }
  const sb = svc();
  await sb.from("maids").update({
    tg_chat_id: to.channel === "telegram" ? Number(to.chatId) : null,
    channel: to.channel,
    channel_chat_id: to.chatId,
    invite_token: null,
    updated_at: new Date().toISOString(),
  }).eq("id", maid.id);

  const bound: Maid = { ...maid, channel: to.channel, channel_chat_id: to.chatId };
  const displayName = maid.name || [from?.firstName, from?.lastName].filter(Boolean).join(" ") || "";
  const welcome = `Здравствуйте, <b>${htmlEscape(displayName)}</b>.\n\nКогда появится новая уборка, вы получите сообщение с двумя кнопками: <b>Принять</b> или <b>Отказаться</b>.\n\nНапишите любое сообщение в этот чат — менеджер его увидит и ответит.`;
  await sendMaid(to, welcome);
  await logMaidMessage(bound, "outbound", "bot", welcome);

  await notifyManager(maid.user_id, `👋 Горничная <b>${htmlEscape(displayName)}</b> подключилась через ${CHANNEL_TITLE[to.channel]}.`);
}

async function handleMaidFreeText(maid: Maid, to: Recipient, text: string, messageId: string | null, photoUrl?: string) {
  const sb = svc();

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
    await sb.from("maid_messages").delete().eq("id", sysMsg.id);

    await logMaidMessage(maid, "inbound", "maid", text, messageId, photoUrl);
    await sendMaid(to, `📦 Заявка на расходники принята. Менеджер уведомлён.`);
    await notifyManager(
      maid.user_id,
      `📦 <b>Заявка на расходники</b>\nОт: <b>${htmlEscape(maid.name)}</b>\nКвартира: ${htmlEscape(cleaning?.apartment_title || "?")}\n\n${htmlEscape(text || "(без описания)")}${photoUrl ? `\n<a href="${photoUrl}">фото</a>` : ""}`,
      "notify_on_supply_request",
    );
    return;
  }

  await logMaidMessage(maid, "inbound", "maid", text, messageId, photoUrl);
  await notifyManager(
    maid.user_id,
    `💬 <b>${htmlEscape(maid.name)}</b> (горничная):\n\n${htmlEscape(text)}`,
    "notify_on_inbound",
  );
}

// ─── Единый обработчик входящих ──────────────────────────────────────

async function handleEvent(ev: InboundEvent) {
  const to: Recipient = { channel: ev.channel, chatId: ev.chatId };

  if (ev.kind === "callback") {
    if (ev.callbackId) await answerCallback(ev.channel, ev.callbackId, "", MAID_PROFILE);
    const data = ev.callbackData || "";

    if (data.startsWith("maid_")) {
      const maid = await findMaidByRcpt(to);
      if (maid) {
        const handled = await handleMaidCallback(maid, to, data, ev.messageId ?? null);
        if (handled) return;
      }
    }
    return;
  }

  if (ev.kind === "start") {
    const arg = (ev.startPayload || "").trim();
    // Поддерживаем и старый формат (maid_<token>), и просто <token>: бот у нас только для горничных.
    const token = arg.startsWith("maid_") ? arg.slice(5) : arg;
    if (token) await handleMaidStart(to, token, ev.from);
    else await sendMaid(to, "Ссылка-приглашение недействительна. Попросите менеджера прислать новую.");
    return;
  }

  const text = ev.text || "";

  const maid = await findMaidByRcpt(to);
  if (maid) {
    if (text.trim() || ev.photoUrl) {
      await handleMaidFreeText(maid, to, text, ev.messageId ?? null, ev.photoUrl ?? undefined);
    }
    return;
  }

  // Незнакомый чат — команда /id и подсказка.
  if (/^\/?id$/i.test(text.trim())) {
    await sendMaid(to, `Ваш chat_id: <code>${to.chatId}</code>`);
    return;
  }

  await sendMaid(to, "Здравствуйте. Это бот горничных Green Yard.\nЧтобы начать — перейдите по ссылке-приглашению, которую пришлёт менеджер.");
}

// ─── Вебхуки ─────────────────────────────────────────────────────────

async function endpointTelegramWebhook(req: Request): Promise<Response> {
  if (TG_SECRET) {
    const got = req.headers.get("x-telegram-bot-api-secret-token");
    if (got !== await tgWebhookToken()) return json({ ok: false, error: "bad_secret" }, 401);
  }
  let update: any = null;
  try { update = await req.json(); }
  catch { return json({ ok: false, error: "bad_json" }, 400); }
  try {
    const ev = await parseTelegramUpdate(update, MAID_PROFILE);
    if (ev) await handleEvent(ev);
  } catch (e) { console.error("[maid-bot] telegram handleEvent error:", e); }
  return json({ ok: true });
}

async function endpointMaxWebhook(req: Request, url: URL): Promise<Response> {
  const expected = MAX_SECRET.trim();
  const got = (url.searchParams.get("s") ?? "").trim();
  if (expected && got !== expected) {
    return json({ ok: false, error: "bad_secret" }, 401);
  }
  let update: any = null;
  try { update = await req.json(); }
  catch { return json({ ok: false, error: "bad_json" }, 400); }
  try {
    const ev = parseMaxUpdate(update);
    if (ev) await handleEvent(ev);
  } catch (e) { console.error("[maid-bot] max handleEvent error:", e); }
  return json({ ok: true });
}

// ─── Endpoint'ы для приложения ────────────────────────────────────────

/** Сообщение от менеджера горничной — идёт через бот горничных. */
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

  const res = await sendMaid(to, text);
  if (!res.ok) {
    console.error("[maid-bot] endpointSendMaid ошибка отправки:", res.error);
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
 * Тело: { maid_id, channel }. Ссылка ведёт на бот ГОРНИЧНЫХ (профиль "maid").
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

  let token: string = maid.invite_token ?? "";
  if (!token) {
    token = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
    await sb.from("maids").update({ invite_token: token, updated_at: new Date().toISOString() }).eq("id", maid.id);
  }

  // Без префикса maid_ — этот бот только для горничных.
  const link = inviteLink(channel, token, MAID_PROFILE);
  if (!link) return json({ ok: false, error: "channel_not_configured", channel }, 409);
  return json({ ok: true, channel, link });
}

/** Регистрирует вебхук Telegram у бота горничных. */
async function endpointSetupWebhook(req: Request): Promise<Response> {
  const userId = await getUserIdFromJwt(req);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 401);
  const token = Deno.env.get("MAID_TELEGRAM_BOT_TOKEN") ?? "";
  if (!token)     return json({ ok: false, error: "no_bot_token" }, 500);
  if (!TG_SECRET) return json({ ok: false, error: "no_webhook_secret" }, 500);
  const hookUrl = `${SUPABASE_URL}/functions/v1/maid-bot`;
  try {
    const resp = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: hookUrl,
        secret_token: await tgWebhookToken(),
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      }),
    });
    const data = await resp.json();
    let info: any = null;
    try {
      const ir = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
      const ij = await ir.json();
      if (ij?.ok) info = {
        url_set: Boolean(ij.result?.url),
        pending: ij.result?.pending_update_count ?? null,
        last_error: ij.result?.last_error_message ?? null,
      };
    } catch { /* не критично */ }
    return json({ ok: Boolean(data?.ok), webhook_url: hookUrl, description: data?.description ?? null, info });
  } catch (e) {
    console.error("[maid-bot] setup_webhook error:", e);
    return json({ ok: false, error: "telegram_request_failed" }, 502);
  }
}

// ─── Роутинг ─────────────────────────────────────────────────────────

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/maid-bot/, "") || "/";
  try {
    if (req.method === "POST" && (path === "/" || path === ""))    return await endpointTelegramWebhook(req);
    if (req.method === "POST" && path === "/max")                  return await endpointMaxWebhook(req, url);

    if (req.method === "POST" && path === "/send_maid")            return await endpointSendMaid(req);
    if (req.method === "POST" && path === "/maid_invite")          return await endpointMaidInvite(req);
    if (req.method === "POST" && path === "/setup_webhook")        return await endpointSetupWebhook(req);

    if (req.method === "GET" && (path === "/" || path === "")) {
      return json({
        ok: true,
        service: "green-yard-maid-bot",
        version: 1,
        enabled_channels: enabledChannels(MAID_PROFILE),
        endpoints: [
          "POST /", "POST /max",
          "POST /send_maid", "POST /maid_invite", "POST /setup_webhook",
        ],
      });
    }
    return json({ ok: false, error: "not_found", path }, 404);
  } catch (e) {
    console.error("[maid-bot] router error:", e);
    return json({ ok: false, error: "Internal server error" }, 500);
  }
});
