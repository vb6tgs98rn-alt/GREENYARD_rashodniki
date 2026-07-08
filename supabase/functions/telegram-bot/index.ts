// Edge Function: telegram-bot (v2 — fixed)
// Назначение:
//   1) POST /            — вебхук Telegram (приём апдейтов от ботa)
//   2) POST /send        — отправка сообщения гостю от имени менеджера (вызывается из приложения)
//   3) POST /test        — тестовое сообщение менеджеру (вызывается из настроек)
//
// Все имена колонок выверены по фактической схеме БД:
//   guest_sessions:     id, user_id, booking_id, secure_id, realty_id,
//                       tg_chat_id (bigint), tg_username, tg_first_name, tg_last_name,
//                       link_sent_at, started_at, last_message_at,
//                       is_subscribed_channel, created_at, updated_at
//   guest_instructions: full_address, directions_metro, parking_info,
//                       entrance_code, door_code, key_location,
//                       checkin_from, checkin_instruction,
//                       wifi_ssid, wifi_password,
//                       amenities (jsonb[]), apartment_notes,
//                       smoking_policy, pets_policy, quiet_hours, other_rules,
//                       checkout_until, checkout_checklist, key_return_info,
//                       emergency_phone, emergency_telegram
//   guest_messages:     id, user_id, session_id, booking_id, direction,
//                       body (text), payload (jsonb), is_read_by_manager, created_at
//   guest_events:       id, user_id, session_id, booking_id, event_type,
//                       details (jsonb), notified_manager_at, resolved_at, created_at
//   manager_settings:   manager_tg_chat_id, notify_on_inbound, notify_on_checkin,
//                       notify_on_checkout, notify_on_complaint,
//                       guest_channel_url, guest_channel_invite, guest_invite_template
//
// Маппинг realty_id -> apartment_id выполняется через app_state.state.apartments[],
// где apartments = [{ id, name, externalIds: { realtyCalendarUnitId } }].
//
// Секреты:
//   TELEGRAM_BOT_TOKEN          (обязателен)
//   SUPABASE_URL                (авто)
//   SUPABASE_SERVICE_ROLE_KEY   (авто)
//   TELEGRAM_WEBHOOK_SECRET     (опционально)

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const TG_TOKEN     = Deno.env.get("TELEGRAM_BOT_TOKEN")        ?? "";
const TG_SECRET    = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")   ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")              ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
// OpenRouter (бесплатные модели). Если ключ не задан, AI-режим выключен.
const OR_API_KEY   = Deno.env.get("OPENROUTER_API_KEY")        ?? "";
const OR_MODEL     = Deno.env.get("OPENROUTER_MODEL")          ?? "google/gemini-2.0-flash-exp:free";
const OR_REFERER   = Deno.env.get("OPENROUTER_REFERER")        ?? "https://green-yard.app";
const OR_TITLE     = Deno.env.get("OPENROUTER_TITLE")          ?? "Green Yard Guest Bot";

const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-telegram-bot-api-secret-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ─────────────────────────────────────────────────────────────────────────────
// Утилиты
// ─────────────────────────────────────────────────────────────────────────────
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

function htmlEscape(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─────────────────────────────────────────────────────────────────────────────
// Telegram API
// ─────────────────────────────────────────────────────────────────────────────
async function tgSendMessage(chatId: number | string, text: string, extra: any = {}) {
  if (!TG_TOKEN) {
    console.error("[telegram-bot] TELEGRAM_BOT_TOKEN не задан");
    return { ok: false, error: "no_token" };
  }
  try {
    // Поддерживаем явное отключение parse_mode (напр. для AI-ответов, где сырой текст без HTML).
    const payload: Record<string, any> = {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
      ...extra,
    };
    if (payload.parse_mode === undefined || payload.parse_mode === null || payload.parse_mode === "") {
      delete payload.parse_mode;
    }
    const r = await fetch(`${TG_API}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!data.ok) console.error("[telegram-bot] sendMessage error:", JSON.stringify(data));
    return data;
  } catch (e) {
    console.error("[telegram-bot] sendMessage exception:", e);
    return { ok: false, error: String(e) };
  }
}

async function tgAnswerCallback(callbackId: string, text = "") {
  try {
    await fetch(`${TG_API}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ callback_query_id: callbackId, text }),
    });
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Клавиатура
// ─────────────────────────────────────────────────────────────────────────────
function guestKeyboard(channelUrl?: string | null) {
  const rows: any[] = [
    [{ text: "📍 Адрес", callback_data: "address" }, { text: "📶 Wi-Fi", callback_data: "wifi" }],
    [{ text: "🔑 Заселение", callback_data: "checkin_info" }, { text: "🚪 Выезд", callback_data: "checkout_info" }],
    [{ text: "✅ Я приехал", callback_data: "i_arrived" }, { text: "👋 Я уезжаю", callback_data: "i_leaving" }],
    [{ text: "📋 Правила", callback_data: "rules" }, { text: "📞 Помощь", callback_data: "help" }],
  ];
  if (channelUrl) rows.push([{ text: "📢 Наш канал", url: channelUrl }]);
  return { inline_keyboard: rows };
}

// ─────────────────────────────────────────────────────────────────────────────
// Доступ к данным
// ─────────────────────────────────────────────────────────────────────────────
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
  started_at: string | null;
  last_message_at: string | null;
};

async function findSessionBySecureId(secureId: string): Promise<Session | null> {
  const sb = svc();
  const { data, error } = await sb
    .from("guest_sessions")
    .select("id,user_id,booking_id,secure_id,realty_id,tg_chat_id,tg_username,tg_first_name,tg_last_name,started_at,last_message_at")
    .eq("secure_id", secureId)
    .maybeSingle();
  if (error) console.error("[telegram-bot] findSessionBySecureId:", error.message);
  return (data as Session) ?? null;
}

async function findSessionByChatId(chatId: number): Promise<Session | null> {
  const sb = svc();
  const { data, error } = await sb
    .from("guest_sessions")
    .select("id,user_id,booking_id,secure_id,realty_id,tg_chat_id,tg_username,tg_first_name,tg_last_name,started_at,last_message_at")
    .eq("tg_chat_id", chatId)
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) console.error("[telegram-bot] findSessionByChatId:", error.message);
  return (data as Session) ?? null;
}

// Маппинг realty_id -> apartment_id через app_state пользователя
async function resolveApartmentId(userId: string, realtyId: number | null): Promise<string | null> {
  if (!realtyId) return null;
  const sb = svc();
  const { data, error } = await sb
    .from("app_state")
    .select("state")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) {
    console.error("[telegram-bot] resolveApartmentId app_state:", error.message);
    return null;
  }
  const apts = (data?.state?.apartments ?? []) as any[];
  const found = apts.find((a) => String(a?.externalIds?.realtyCalendarUnitId ?? "") === String(realtyId));
  return found?.id ? String(found.id) : null;
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
  if (error) console.error("[telegram-bot] loadInstructions:", error.message);
  return data;
}

async function loadManagerSettings(userId: string) {
  const sb = svc();
  const { data, error } = await sb
    .from("manager_settings")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  if (error) console.error("[telegram-bot] loadManagerSettings:", error.message);
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
  if (error) console.error("[telegram-bot] logMessage:", error.message);

  // Обновляем last_message_at
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
  if (error) console.error("[telegram-bot] logEvent:", error.message);
}

async function notifyManager(userId: string, text: string, flag?: keyof ManagerSettings) {
  const settings = await loadManagerSettings(userId);
  if (!settings?.manager_tg_chat_id) {
    console.log("[telegram-bot] notifyManager skipped: no manager_tg_chat_id");
    return;
  }
  if (flag && settings[flag] === false) {
    console.log(`[telegram-bot] notifyManager skipped by flag ${String(flag)}`);
    return;
  }
  await tgSendMessage(settings.manager_tg_chat_id, text);
}

type ManagerSettings = {
  manager_tg_chat_id: number | null;
  notify_on_inbound: boolean | null;
  notify_on_checkin: boolean | null;
  notify_on_checkout: boolean | null;
  notify_on_complaint: boolean | null;
  guest_channel_url: string | null;
  guest_channel_invite: string | null;
  guest_invite_template: string | null;
};

// ─────────────────────────────────────────────────────────────────────────────
// Форматирование инструкций (под реальные поля guest_instructions)
// ─────────────────────────────────────────────────────────────────────────────
function blockAddress(instr: any): string | null {
  if (!instr) return null;
  const parts: string[] = [];
  if (instr.full_address)     parts.push(`📍 <b>Адрес</b>\n${htmlEscape(instr.full_address)}`);
  if (instr.directions_metro) parts.push(`🚇 <b>Как добраться</b>\n${htmlEscape(instr.directions_metro)}`);
  if (instr.parking_info)     parts.push(`🚗 <b>Парковка</b>\n${htmlEscape(instr.parking_info)}`);
  return parts.length ? parts.join("\n\n") : null;
}

function blockCheckin(instr: any): string | null {
  if (!instr) return null;
  const parts: string[] = [];
  if (instr.checkin_from)         parts.push(`🕒 <b>Заезд с</b> ${htmlEscape(instr.checkin_from)}`);
  if (instr.entrance_code)        parts.push(`🚪 <b>Код подъезда</b> <code>${htmlEscape(instr.entrance_code)}</code>`);
  if (instr.door_code)            parts.push(`🔐 <b>Код двери</b> <code>${htmlEscape(instr.door_code)}</code>`);
  if (instr.key_location)         parts.push(`🔑 <b>Где ключи</b>\n${htmlEscape(instr.key_location)}`);
  if (instr.checkin_instruction)  parts.push(`📋 <b>Инструкция</b>\n${htmlEscape(instr.checkin_instruction)}`);
  return parts.length ? parts.join("\n\n") : null;
}

function blockWifi(instr: any): string | null {
  if (!instr) return null;
  const parts: string[] = [];
  if (instr.wifi_ssid)     parts.push(`📶 <b>Сеть</b> <code>${htmlEscape(instr.wifi_ssid)}</code>`);
  if (instr.wifi_password) parts.push(`🔑 <b>Пароль</b> <code>${htmlEscape(instr.wifi_password)}</code>`);
  return parts.length ? parts.join("\n") : null;
}

function blockAbout(instr: any): string | null {
  if (!instr) return null;
  const parts: string[] = [];
  if (Array.isArray(instr.amenities) && instr.amenities.length) {
    parts.push(`🏠 <b>В квартире есть</b>\n${instr.amenities.map((a: any) => "• " + htmlEscape(String(a))).join("\n")}`);
  }
  if (instr.apartment_notes) parts.push(`💡 <b>Особенности</b>\n${htmlEscape(instr.apartment_notes)}`);
  return parts.length ? parts.join("\n\n") : null;
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
  if (instr.checkout_checklist) parts.push(`✅ <b>Перед выездом</b>\n${htmlEscape(instr.checkout_checklist)}`);
  if (instr.key_return_info)    parts.push(`🔑 <b>Куда оставить ключи</b>\n${htmlEscape(instr.key_return_info)}`);
  return parts.length ? parts.join("\n\n") : null;
}

function blockHelp(instr: any): string {
  const parts: string[] = ["📞 <b>Контакты</b>"];
  if (instr?.emergency_phone)    parts.push(`Телефон: ${htmlEscape(instr.emergency_phone)}`);
  if (instr?.emergency_telegram) parts.push(`Telegram: @${htmlEscape(String(instr.emergency_telegram).replace(/^@/, ""))}`);
  if (parts.length === 1) {
    parts.push("Напишите любое сообщение — менеджер увидит его и ответит.");
  } else {
    parts.push("\nИли просто напишите сюда — менеджер ответит.");
  }
  return parts.join("\n");
}

// ──────────────────────────────────────────────────────────────────────────
// AI-бот (OpenRouter, бесплатные модели)
// Строгое правило: отвечает ТОЛЬКО по данным конкретной квартиры, не выдумывает.
// ──────────────────────────────────────────────────────────────────────────
function buildAiSystemPrompt(instr: any): string {
  const emergency = [
    instr?.emergency_phone ? `телефон ${instr.emergency_phone}` : null,
    instr?.emergency_telegram ? `Telegram @${String(instr.emergency_telegram).replace(/^@/, "")}` : null,
  ].filter(Boolean).join(", ") || "связаться с менеджером через этот чат — он всё видит";

  // Компактный контекст квартиры — всё, что AI может цитировать.
  const facts: string[] = [];
  if (instr?.apartment_title)     facts.push(`Название квартиры: ${instr.apartment_title}`);
  if (instr?.full_address)        facts.push(`Полный адрес: ${instr.full_address}`);
  if (instr?.directions_metro)    facts.push(`Как добраться от метро: ${instr.directions_metro}`);
  if (instr?.parking_info)        facts.push(`Парковка: ${instr.parking_info}`);
  if (instr?.checkin_from)        facts.push(`Заезд с: ${instr.checkin_from}`);
  if (instr?.entrance_code)       facts.push(`Код подъезда: ${instr.entrance_code}`);
  if (instr?.door_code)           facts.push(`Код двери: ${instr.door_code}`);
  if (instr?.key_location)        facts.push(`Где ключи: ${instr.key_location}`);
  if (instr?.checkin_instruction) facts.push(`Инструкция по заселению: ${instr.checkin_instruction}`);
  if (instr?.wifi_ssid)           facts.push(`Wi-Fi сеть: ${instr.wifi_ssid}`);
  if (instr?.wifi_password)       facts.push(`Wi-Fi пароль: ${instr.wifi_password}`);
  if (Array.isArray(instr?.amenities) && instr.amenities.length) {
    facts.push(`В квартире есть: ${instr.amenities.map((a: any) => String(a)).join(", ")}`);
  }
  if (instr?.apartment_notes)     facts.push(`Особенности: ${instr.apartment_notes}`);
  if (instr?.smoking_policy)      facts.push(`Курение: ${instr.smoking_policy}`);
  if (instr?.pets_policy)         facts.push(`Животные: ${instr.pets_policy}`);
  if (instr?.quiet_hours)         facts.push(`Часы тишины: ${instr.quiet_hours}`);
  if (instr?.other_rules)         facts.push(`Другие правила: ${instr.other_rules}`);
  if (instr?.checkout_until)      facts.push(`Выезд до: ${instr.checkout_until}`);
  if (instr?.checkout_checklist)  facts.push(`Чек-лист перед выездом: ${instr.checkout_checklist}`);
  if (instr?.key_return_info)     facts.push(`Куда оставить ключи: ${instr.key_return_info}`);

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

async function callOpenRouter(systemPrompt: string, userText: string): Promise<string | null> {
  if (!OR_API_KEY) return null;
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
        model: OR_MODEL,
        temperature: 0.2,
        max_tokens: 500,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userText },
        ],
      }),
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => "");
      console.error("[telegram-bot] openrouter http error:", r.status, errText.slice(0, 500));
      return null;
    }
    const data = await r.json();
    const msg = data?.choices?.[0]?.message?.content;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
    console.error("[telegram-bot] openrouter empty response:", JSON.stringify(data).slice(0, 500));
    return null;
  } catch (e) {
    console.error("[telegram-bot] openrouter exception:", e);
    return null;
  }
}

function buildWelcomeMessage(fromName: string, instr: any): string {
  const greeting = `Здравствуйте, ${htmlEscape(fromName || "гость")}! 👋\n\nВаше бронирование найдено. Вот всё, что нужно знать:`;
  const blocks: string[] = [];
  const addr = blockAddress(instr);     if (addr)     blocks.push(addr);
  const cin  = blockCheckin(instr);     if (cin)      blocks.push(cin);
  const wifi = blockWifi(instr);        if (wifi)     blocks.push(wifi);
  const rules = blockRules(instr);      if (rules)    blocks.push(rules);
  const cout = blockCheckout(instr);    if (cout)     blocks.push(cout);

  if (!blocks.length) {
    return `${greeting}\n\nИнструкция по заселению ещё не заполнена менеджером. Я уже сообщил ему — он скоро свяжется с вами.\n\nВы можете написать сюда любой вопрос — я передам менеджеру.`;
  }
  return `${greeting}\n\n${blocks.join("\n\n━━━━━━━━━━━━━━━\n\n")}\n\n💬 Если что-то непонятно — напишите сюда, я передам менеджеру.`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Хэндлеры команд
// ─────────────────────────────────────────────────────────────────────────────
async function handleStart(chatId: number, args: string, from: any) {
  const secureId = (args || "").trim();
  const fromName = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || "";

  console.log(`[telegram-bot] /start chat=${chatId} secure="${secureId}" from="${fromName}"`);

  if (!secureId) {
    await tgSendMessage(
      chatId,
      "Здравствуйте! Похоже, вы открыли бота без персональной ссылки.\n\nПожалуйста, используйте ссылку, которую прислал менеджер — она содержит данные вашего бронирования.",
    );
    return;
  }

  let session = await findSessionBySecureId(secureId);
  if (!session) {
    console.log(`[telegram-bot] /start: session not found for secure="${secureId}"`);
    await tgSendMessage(
      chatId,
      "Ссылка не найдена или устарела. Свяжитесь, пожалуйста, с менеджером — он отправит новую ссылку.",
    );
    return;
  }

  // Привязываем Telegram-аккаунт к сессии (даже если был привязан — обновляем имя/время)
  const sb = svc();
  const updatePatch: Record<string, any> = {
    tg_chat_id: chatId,
    tg_username: from?.username ?? null,
    tg_first_name: from?.first_name ?? null,
    tg_last_name: from?.last_name ?? null,
    updated_at: new Date().toISOString(),
  };
  if (!session.started_at) updatePatch.started_at = new Date().toISOString();

  const { data: upd, error: updErr } = await sb
    .from("guest_sessions")
    .update(updatePatch)
    .eq("id", session.id)
    .select("id,user_id,booking_id,secure_id,realty_id,tg_chat_id,tg_username,tg_first_name,tg_last_name,started_at,last_message_at")
    .maybeSingle();

  if (updErr) {
    console.error("[telegram-bot] /start update session:", updErr.message);
  }
  if (upd) session = upd as Session;

  // Маппинг квартиры
  const apartmentId = await resolveApartmentId(session.user_id, session.realty_id);
  console.log(`[telegram-bot] /start: realty_id=${session.realty_id} -> apartment_id=${apartmentId}`);

  const instr = await loadInstructions(session.user_id, apartmentId);
  console.log(`[telegram-bot] /start: instructions ${instr ? "FOUND" : "NOT FOUND"}`);

  const settings = (await loadManagerSettings(session.user_id)) as ManagerSettings | null;

  const welcome = buildWelcomeMessage(fromName, instr);
  await tgSendMessage(chatId, welcome, {
    reply_markup: guestKeyboard(settings?.guest_channel_url ?? null),
  });

  await logMessage(session, "bot", welcome, { kind: "welcome" });
  await logEvent(session, "custom", { kind: "bot_started", chat_id: chatId, from: fromName });

  // Уведомляем менеджера
  await notifyManager(
    session.user_id,
    `🟢 Гость <b>${htmlEscape(fromName || "—")}</b> запустил бота.\nБронь: <code>${session.booking_id}</code>`,
  );
}

async function handleCommand(chatId: number, cmd: string, _from: any) {
  const session = await findSessionByChatId(chatId);
  if (!session) {
    await tgSendMessage(
      chatId,
      "Сначала откройте бота по персональной ссылке от менеджера (она содержит /start с кодом).",
    );
    return;
  }

  const apartmentId = await resolveApartmentId(session.user_id, session.realty_id);
  const instr = await loadInstructions(session.user_id, apartmentId);
  const settings = (await loadManagerSettings(session.user_id)) as ManagerSettings | null;

  const fallback = "Инструкция ещё не заполнена менеджером. Напишите сюда — менеджер ответит.";

  let reply = "";
  switch (cmd) {
    case "address":
    case "info":
      reply = blockAddress(instr) || fallback;
      break;
    case "wifi":
      reply = blockWifi(instr) || fallback;
      break;
    case "checkin":
    case "checkin_info":
      reply = blockCheckin(instr) || fallback;
      break;
    case "checkout":
    case "checkout_info":
      reply = blockCheckout(instr) || fallback;
      break;
    case "rules":
      reply = blockRules(instr) || "Особых правил нет. Будьте аккуратны и уважайте соседей.";
      break;
    case "help":
      reply = blockHelp(instr);
      break;
    case "menu":
    case "start_menu":
      reply = "Выберите, что вас интересует:";
      break;
    default:
      reply = "Команда не распознана. Используйте кнопки ниже.";
  }

  await tgSendMessage(chatId, reply, { reply_markup: guestKeyboard(settings?.guest_channel_url ?? null) });
  await logMessage(session, "bot", reply, { kind: "command", cmd });
}

async function handleArrival(chatId: number, from: any, kind: "arrived" | "leaving") {
  const session = await findSessionByChatId(chatId);
  if (!session) {
    await tgSendMessage(chatId, "Сессия не найдена. Откройте бота по ссылке от менеджера.");
    return;
  }
  const fromName = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || "";
  const settings = (await loadManagerSettings(session.user_id)) as ManagerSettings | null;

  if (kind === "arrived") {
    const reply = "Спасибо! ✅ Я передал менеджеру, что вы приехали. Хорошего отдыха!";
    await tgSendMessage(chatId, reply, { reply_markup: guestKeyboard(settings?.guest_channel_url ?? null) });
    await logMessage(session, "bot", reply, { kind: "arrival" });
    await logEvent(session, "checkin", { from: fromName });
    await notifyManager(
      session.user_id,
      `✅ Гость <b>${htmlEscape(fromName || "—")}</b> сообщил о заселении.\nБронь: <code>${session.booking_id}</code>`,
      "notify_on_checkin",
    );
  } else {
    const reply = "Спасибо, что были у нас! 👋 Я передал менеджеру, что вы уезжаете.";
    await tgSendMessage(chatId, reply, { reply_markup: guestKeyboard(settings?.guest_channel_url ?? null) });
    await logMessage(session, "bot", reply, { kind: "departure" });
    await logEvent(session, "checkout", { from: fromName });
    await notifyManager(
      session.user_id,
      `👋 Гость <b>${htmlEscape(fromName || "—")}</b> сообщил, что уезжает.\nБронь: <code>${session.booking_id}</code>`,
      "notify_on_checkout",
    );
  }
}

async function handleFreeText(chatId: number, from: any, text: string, tgMessageId: number) {
  const session = await findSessionByChatId(chatId);
  if (!session) {
    await tgSendMessage(
      chatId,
      "Сессия не найдена. Откройте бота по персональной ссылке от менеджера (она содержит /start с кодом).",
    );
    return;
  }
  const fromName = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || "Гость";

  await logMessage(session, "inbound", text, { tg_message_id: tgMessageId, from });

  // Загружаем контекст квартиры и настройки менеджера.
  const apartmentId = await resolveApartmentId(session.user_id, session.realty_id);
  const instr = await loadInstructions(session.user_id, apartmentId);
  const settings = (await loadManagerSettings(session.user_id)) as ManagerSettings | null;
  const kb = { reply_markup: guestKeyboard(settings?.guest_channel_url ?? null) };

  // AI-режим включается, если есть ключ OpenRouter И менеджер заполнил ai_instructions.
  const aiEnabled = !!OR_API_KEY && !!(instr?.ai_instructions && String(instr.ai_instructions).trim());

  if (aiEnabled) {
    const systemPrompt = buildAiSystemPrompt(instr);
    const aiText = await callOpenRouter(systemPrompt, text);

    if (aiText) {
      // Telegram не любит сырой HTML в AI-ответе — отправляем без parse_mode.
      const outText = aiText.length > 3800 ? aiText.slice(0, 3800) + "…" : aiText;
      await tgSendMessage(chatId, outText, { ...kb, parse_mode: undefined });
      await logMessage(session, "bot", outText, { kind: "ai_reply", model: OR_MODEL });

      // Менеджеру всё равно показываем вопрос и AI-ответ — чтобы он мог вмешаться.
      await notifyManager(
        session.user_id,
        `🤖 <b>${htmlEscape(fromName)}</b> (бронь <code>${session.booking_id}</code>) — вопрос:\n${htmlEscape(text)}\n\n<i>AI-ответ гостю:</i>\n${htmlEscape(outText)}`,
        "notify_on_inbound",
      );
      return;
    }

    // AI не ответил (квота/ошибка) — проваливаемся в обычный сценарий ниже.
    console.warn("[telegram-bot] AI enabled but call failed; falling back to manager relay");
  }

  // Fallback: обычное поведение — передаём менеджеру.
  const reply = "Спасибо за сообщение! ✉️ Я передал его менеджеру — он скоро ответит.";
  await tgSendMessage(chatId, reply, kb);
  await logMessage(session, "bot", reply, { kind: "ack" });

  await notifyManager(
    session.user_id,
    `💬 <b>${htmlEscape(fromName)}</b> (бронь <code>${session.booking_id}</code>):\n\n${htmlEscape(text)}`,
    "notify_on_inbound",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Маршрутизация апдейтов Telegram
// ─────────────────────────────────────────────────────────────────────────────
async function handleUpdate(update: any) {
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat?.id;
    const data = cq.data || "";

    await tgAnswerCallback(cq.id);
    if (!chatId) return;

    if (data === "i_arrived")      await handleArrival(chatId, cq.from, "arrived");
    else if (data === "i_leaving") await handleArrival(chatId, cq.from, "leaving");
    else                            await handleCommand(chatId, data, cq.from);
    return;
  }

  const msg = update.message || update.edited_message;
  if (!msg) return;
  const chatId: number | undefined = msg.chat?.id;
  const text: string = msg.text || "";
  const tgMessageId: number = msg.message_id;
  if (!chatId) return;

  if (text.startsWith("/start")) {
    const arg = text.replace(/^\/start\s*/, "").trim();
    await handleStart(chatId, arg, msg.from);
    return;
  }
  if (text.startsWith("/")) {
    const cmd = text.split(/\s+/)[0].replace(/^\//, "").split("@")[0];
    await handleCommand(chatId, cmd, msg.from);
    return;
  }
  if (text.trim()) {
    await handleFreeText(chatId, msg.from, text, tgMessageId);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Эндпоинты
// ─────────────────────────────────────────────────────────────────────────────
async function endpointWebhook(req: Request): Promise<Response> {
  if (TG_SECRET) {
    const got = req.headers.get("x-telegram-bot-api-secret-token");
    if (got !== TG_SECRET) return json({ ok: false, error: "bad_secret" }, 401);
  }
  let update: any = null;
  try { update = await req.json(); }
  catch { return json({ ok: false, error: "bad_json" }, 400); }

  try {
    await handleUpdate(update);
  } catch (e) {
    console.error("[telegram-bot] handleUpdate error:", e);
  }
  return json({ ok: true });
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
    .select("id,user_id,booking_id,tg_chat_id")
    .eq("id", sessionId)
    .maybeSingle();

  if (error || !session) return json({ ok: false, error: "session_not_found" }, 404);
  if (session.user_id !== userId) return json({ ok: false, error: "forbidden" }, 403);
  if (!session.tg_chat_id) return json({ ok: false, error: "guest_not_connected" }, 409);

  const tgRes = await tgSendMessage(session.tg_chat_id, text);
  if (!tgRes.ok) return json({ ok: false, error: "telegram_error", details: tgRes }, 502);

  const tgMessageId = tgRes?.result?.message_id ?? null;
  await sb.from("guest_messages").insert({
    user_id: session.user_id,
    session_id: session.id,
    booking_id: session.booking_id,
    direction: "manager",
    body: text,
    payload: { tg_message_id: tgMessageId, via: "endpoint_send" },
    is_read_by_manager: true,
  });
  await sb
    .from("guest_sessions")
    .update({ last_message_at: new Date().toISOString() })
    .eq("id", session.id);

  return json({ ok: true, tg_message_id: tgMessageId });
}

async function endpointTest(req: Request): Promise<Response> {
  const userId = await getUserIdFromJwt(req);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 401);

  const settings = await loadManagerSettings(userId);
  if (!settings?.manager_tg_chat_id) {
    return json({ ok: false, error: "manager_chat_id_not_set" }, 400);
  }

  const text =
    "✅ <b>Это тестовое сообщение от Green Yard.</b>\n\n" +
    "Если вы видите его — уведомления настроены корректно и бот будет писать сюда о действиях гостей.";

  const r = await tgSendMessage(settings.manager_tg_chat_id, text);
  if (!r.ok) return json({ ok: false, error: "telegram_error", details: r }, 502);
  return json({ ok: true });
}

// ─────────────────────────────────────────────────────────────────────────────
// Роутер
// ─────────────────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/telegram-bot/, "") || "/";

  try {
    if (req.method === "POST" && (path === "/" || path === ""))   return await endpointWebhook(req);
    if (req.method === "POST" && path === "/send")                return await endpointSend(req);
    if (req.method === "POST" && path === "/test")                return await endpointTest(req);
    if (req.method === "GET"  && (path === "/" || path === ""))   return json({ ok: true, service: "telegram-bot", endpoints: ["POST /", "POST /send", "POST /test"] });
    return json({ ok: false, error: "not_found", path }, 404);
  } catch (e) {
    console.error("[telegram-bot] router error:", e);
    return json({ ok: false, error: "internal", message: String(e) }, 500);
  }
});
