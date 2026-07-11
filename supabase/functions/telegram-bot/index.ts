// Edge Function: telegram-bot (v12 — chats realtime, per-session AI toggle)
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const TG_TOKEN     = Deno.env.get("TELEGRAM_BOT_TOKEN")        ?? "";
const TG_SECRET    = Deno.env.get("TELEGRAM_WEBHOOK_SECRET")   ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")              ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const OR_API_KEY   = Deno.env.get("OPENROUTER_API_KEY")        ?? "";
const OR_MODEL     = Deno.env.get("OPENROUTER_MODEL")          ?? "openai/gpt-oss-120b:free";
const OR_REFERER   = Deno.env.get("OPENROUTER_REFERER")        ?? "https://green-yard.app";
const OR_TITLE     = Deno.env.get("OPENROUTER_TITLE")          ?? "Green Yard Guest Bot";

const TG_API = `https://api.telegram.org/bot${TG_TOKEN}`;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-telegram-bot-api-secret-token",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

function htmlEscape(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function tgSendMessage(chatId: number | string, text: string, extra: any = {}) {
  if (!TG_TOKEN) {
    console.error("[telegram-bot] TELEGRAM_BOT_TOKEN не задан");
    return { ok: false, error: "no_token" };
  }
  try {
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
  ai_enabled?: boolean | null;
};

const SESSION_COLS = "id,user_id,booking_id,secure_id,realty_id,tg_chat_id,tg_username,tg_first_name,tg_last_name,started_at,last_message_at,ai_enabled";

async function findSessionBySecureId(secureId: string): Promise<Session | null> {
  const sb = svc();
  const { data, error } = await sb
    .from("guest_sessions")
    .select(SESSION_COLS)
    .eq("secure_id", secureId)
    .maybeSingle();
  if (error) console.error("[telegram-bot] findSessionBySecureId:", error.message);
  return (data as Session) ?? null;
}

async function findSessionByChatId(chatId: number): Promise<Session | null> {
  const sb = svc();
  const { data, error } = await sb
    .from("guest_sessions")
    .select(SESSION_COLS)
    .eq("tg_chat_id", chatId)
    .order("started_at", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  if (error) console.error("[telegram-bot] findSessionByChatId:", error.message);
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
    console.error("[telegram-bot] resolveApartmentId app_state:", error.message);
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
  if (parts.length === 1) parts.push("Напишите любое сообщение — менеджер увидит его и ответит.");
  else                    parts.push("\nИли просто напишите сюда — менеджер ответит.");
  return parts.join("\n");
}

function buildAiSystemPrompt(instr: any): string {
  const emergency = [
    instr?.emergency_phone ? `телефон ${instr.emergency_phone}` : null,
    instr?.emergency_telegram ? `Telegram @${String(instr.emergency_telegram).replace(/^@/, "")}` : null,
  ].filter(Boolean).join(", ") || "связаться с менеджером через этот чат — он всё видит";

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

// Автосоздание договора Okidoki при первом /start гостя (если включён auto_send).
// Возвращает { link } если договор создан/уже был, иначе null.
async function maybeCreateContract(session: Session, chatId: number): Promise<string | null> {
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
    .select("okidoki_template_id, field_mapping")
    .eq("user_id", session.user_id)
    .eq("realty_id", bk.realty_id)
    .maybeSingle();

  if (!apt?.okidoki_template_id) {
    console.log(`[telegram-bot] maybeCreateContract: no template for realty ${bk.realty_id}`);
    // Уведомим менеджера, что нужно настроить шаблон
    await notifyManager(
      session.user_id,
      `⚠️ Гость запустил бота, но для квартиры <b>${htmlEscape(bk.apartment_title || String(bk.realty_id))}</b> не назначен шаблон договора Okidoki. Договор не создан. Откройте «Договоры (Okidoki)» → «Квартиры и шаблоны».`
    );
    return null;
  }

  const DEFAULT_MAPPING: Record<string, string> = {
    begin_date:            "дата заселения",
    end_date:              "дата выселения",
    price_per_night:       "цена в сутки",
    price_total:           "полная стоимость",
    prepaid:               "оплачено",
    deposit:               "Обеспечительный платеж",
    apartment_title:       "описание и адрес квартиры",
    apartment_address:     "адрес",
    apartment_description: "описание и адрес квартиры",
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

  const logical: Record<string, string> = {
    begin_date:      ddmmyyyy(bk.begin_date),
    end_date:        ddmmyyyy(bk.end_date),
    nights:          String(nights),
    price_total:     String(priceTotal),
    price_per_night: String(pricePerNight),
    prepaid:         String(prepaid),
    remaining:       String(remaining),
    apartment_title: String(bk.apartment_title || ""),
    apartment_address: String(bk.apartment_title || ""),
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
      console.error("[telegram-bot] okidoki contract error:", r.status, text);
      await notifyManager(session.user_id, `❌ Не удалось создать договор гостю (бронь <code>${session.booking_id}</code>): ${htmlEscape(String(data?.error || data || r.status))}`);
      return null;
    }
    const link = data?.link || "";
    const contract_id = data?.contract_id || "";
    await sb.from("rc_bookings").update({
      okidoki_contract_id: contract_id,
      okidoki_link: link,
      contract_status: data?.status?.name || "",
      contract_status_internal: data?.status?.internal_id ?? null,
      contract_updated_at: new Date().toISOString(),
    }).eq("user_id", session.user_id).eq("booking_id", session.booking_id);

    return link || null;
  } catch (e) {
    console.error("[telegram-bot] okidoki contract exception:", e);
    return null;
  }
}

async function handleStart(chatId: number, args: string, from: any) {
  const secureId = (args || "").trim();
  const fromName = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || "";
  if (!secureId) {
    await tgSendMessage(chatId, "Здравствуйте! Похоже, вы открыли бота без персональной ссылки.\n\nПожалуйста, используйте ссылку, которую прислал менеджер — она содержит данные вашего бронирования.");
    return;
  }
  let session = await findSessionBySecureId(secureId);
  if (!session) {
    await tgSendMessage(chatId, "Ссылка не найдена или устарела. Свяжитесь, пожалуйста, с менеджером — он отправит новую ссылку.");
    return;
  }
  const sb = svc();
  const updatePatch: Record<string, any> = {
    tg_chat_id: chatId,
    tg_username: from?.username ?? null,
    tg_first_name: from?.first_name ?? null,
    tg_last_name: from?.last_name ?? null,
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
  await tgSendMessage(chatId, welcome, { reply_markup: guestKeyboard(settings?.guest_channel_url ?? null) });
  await logMessage(session, "bot", welcome, { kind: "welcome" });
  await logEvent(session, "custom", { kind: "bot_started", chat_id: chatId, from: fromName });
  await notifyManager(session.user_id, `🟢 Гость <b>${htmlEscape(fromName || "—")}</b> запустил бота.\nБронь: <code>${session.booking_id}</code>`);

  // Автосоздание договора Okidoki (если включено)
  try {
    const link = await maybeCreateContract(session, chatId);
    if (link) {
      const msg = `📄 <b>Договор аренды</b>\n\nДля вашего заселения подготовлен договор. Пожалуйста, ознакомьтесь и подпишите по ссылке:\n${htmlEscape(link)}\n\nПосле подписания менеджер получит уведомление и подтвердит вашу бронь.`;
      await tgSendMessage(chatId, msg, { disable_web_page_preview: false });
      await logMessage(session, "bot", msg, { kind: "okidoki_link", link });
      await notifyManager(session.user_id, `📄 Гостю отправлена ссылка на договор (бронь <code>${session.booking_id}</code>).`);
    }
  } catch (e) {
    console.error("[telegram-bot] maybeCreateContract failed:", e);
  }
}

async function handleCommand(chatId: number, cmd: string, _from: any) {
  const session = await findSessionByChatId(chatId);
  if (!session) {
    await tgSendMessage(chatId, "Сначала откройте бота по персональной ссылке от менеджера (она содержит /start с кодом).");
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
    case "menu": case "start_menu": reply = "Выберите, что вас интересует:"; break;
    default: reply = "Команда не распознана. Используйте кнопки ниже.";
  }
  await tgSendMessage(chatId, reply, { reply_markup: guestKeyboard(settings?.guest_channel_url ?? null) });
  await logMessage(session, "bot", reply, { kind: "command", cmd });
}

async function handleArrival(chatId: number, from: any, kind: "arrived" | "leaving") {
  const session = await findSessionByChatId(chatId);
  if (!session) { await tgSendMessage(chatId, "Сессия не найдена. Откройте бота по ссылке от менеджера."); return; }
  const fromName = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || "";
  const settings = (await loadManagerSettings(session.user_id)) as ManagerSettings | null;
  if (kind === "arrived") {
    const reply = "Спасибо! ✅ Я передал менеджеру, что вы приехали. Хорошего отдыха!";
    await tgSendMessage(chatId, reply, { reply_markup: guestKeyboard(settings?.guest_channel_url ?? null) });
    await logMessage(session, "bot", reply, { kind: "arrival" });
    await logEvent(session, "checkin", { from: fromName });
    await notifyManager(session.user_id, `✅ Гость <b>${htmlEscape(fromName || "—")}</b> сообщил о заселении.\nБронь: <code>${session.booking_id}</code>`, "notify_on_checkin");
  } else {
    const reply = "Спасибо, что были у нас! 👋 Я передал менеджеру, что вы уезжаете.";
    await tgSendMessage(chatId, reply, { reply_markup: guestKeyboard(settings?.guest_channel_url ?? null) });
    await logMessage(session, "bot", reply, { kind: "departure" });
    await logEvent(session, "checkout", { from: fromName });
    await notifyManager(session.user_id, `👋 Гость <b>${htmlEscape(fromName || "—")}</b> сообщил, что уезжает.\nБронь: <code>${session.booking_id}</code>`, "notify_on_checkout");
  }
}

async function handleFreeText(chatId: number, from: any, text: string, tgMessageId: number) {
  const session = await findSessionByChatId(chatId);
  if (!session) {
    await tgSendMessage(chatId, "Сессия не найдена. Откройте бота по персональной ссылке от менеджера (она содержит /start с кодом).");
    return;
  }
  const fromName = [from?.first_name, from?.last_name].filter(Boolean).join(" ") || from?.username || "Гость";
  await logMessage(session, "inbound", text, { tg_message_id: tgMessageId, from });

  const { id: apartmentId, diag: resolveDiag } = await resolveApartmentId(session.user_id, session.realty_id, session.booking_id);
  const instr = await loadInstructions(session.user_id, apartmentId);
  const settings = (await loadManagerSettings(session.user_id)) as ManagerSettings | null;
  const kb = { reply_markup: guestKeyboard(settings?.guest_channel_url ?? null) };

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
    model: OR_MODEL,
  };
  console.log(`[telegram-bot] handleFreeText diag: ${JSON.stringify(diag)}`);
  try {
    await svc().from("guest_sessions").update({ debug_last: { kind: "ai_diag", at: new Date().toISOString(), ...diag } }).eq("id", session.id);
  } catch (e) { console.error("[telegram-bot] debug_last diag update failed:", e); }

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
      console.error(`[telegram-bot] openrouter model failed ${modelId}: ${modelErr}`);
    }

    try {
      await svc().from("guest_sessions").update({ debug_last: { kind: "ai_result", at: new Date().toISOString(), ok: !!aiText, reply_len: aiText?.length ?? 0, used_model: usedModel, errors: modelErrors } }).eq("id", session.id);
    } catch (e) { console.error("[telegram-bot] debug_last result update failed:", e); }

    if (aiText) {
      const outText = aiText.length > 3800 ? aiText.slice(0, 3800) + "…" : aiText;
      await tgSendMessage(chatId, outText, { ...kb, parse_mode: undefined });
      await logMessage(session, "bot", outText, { kind: "ai_reply", model: usedModel });
      await notifyManager(session.user_id, `🤖 <b>${htmlEscape(fromName)}</b> (бронь <code>${session.booking_id}</code>) — вопрос:\n${htmlEscape(text)}\n\n<i>AI-ответ гостю:</i>\n${htmlEscape(outText)}`, "notify_on_inbound");
      return;
    }
    console.warn("[telegram-bot] AI enabled but call failed; falling back to manager relay");
  }

  const reply = sessionAiEnabled
    ? "Спасибо за сообщение! ✉️ Я передал его менеджеру — он скоро ответит."
    : "Спасибо за сообщение! ✉️ Менеджер увидит его и ответит лично.";
  await tgSendMessage(chatId, reply, kb);
  await logMessage(session, "bot", reply, { kind: "ack" });
  await notifyManager(session.user_id, `💬 <b>${htmlEscape(fromName)}</b> (бронь <code>${session.booking_id}</code>):\n\n${htmlEscape(text)}`, "notify_on_inbound");
}

async function handleUpdate(update: any) {
  if (update.callback_query) {
    const cq = update.callback_query;
    const chatId = cq.message?.chat?.id;
    const data = cq.data || "";
    await tgAnswerCallback(cq.id);
    if (!chatId) return;
    if (data === "i_arrived") await handleArrival(chatId, cq.from, "arrived");
    else if (data === "i_leaving") await handleArrival(chatId, cq.from, "leaving");
    else await handleCommand(chatId, data, cq.from);
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
  if (text.trim()) await handleFreeText(chatId, msg.from, text, tgMessageId);
}

async function endpointWebhook(req: Request): Promise<Response> {
  if (TG_SECRET) {
    const got = req.headers.get("x-telegram-bot-api-secret-token");
    if (got !== TG_SECRET) return json({ ok: false, error: "bad_secret" }, 401);
  }
  let update: any = null;
  try { update = await req.json(); }
  catch { return json({ ok: false, error: "bad_json" }, 400); }
  try { await handleUpdate(update); }
  catch (e) { console.error("[telegram-bot] handleUpdate error:", e); }
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
  const { error: insErr } = await sb.from("guest_messages").insert({
    user_id: session.user_id,
    session_id: session.id,
    booking_id: session.booking_id,
    direction: "manager",
    body: text,
    payload: { tg_message_id: tgMessageId, via: "endpoint_send" },
    is_read_by_manager: true,
  });
  if (insErr) console.error("[telegram-bot] endpointSend insert:", insErr.message);
  await sb.from("guest_sessions").update({ last_message_at: new Date().toISOString() }).eq("id", session.id);
  return json({ ok: true, tg_message_id: tgMessageId });
}

async function endpointTest(req: Request): Promise<Response> {
  const userId = await getUserIdFromJwt(req);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 401);
  const settings = await loadManagerSettings(userId);
  if (!settings?.manager_tg_chat_id) return json({ ok: false, error: "manager_chat_id_not_set" }, 400);
  const text = "✅ <b>Это тестовое сообщение от Green Yard.</b>\n\nЕсли вы видите его — уведомления настроены корректно и бот будет писать сюда о действиях гостей.";
  const r = await tgSendMessage(settings.manager_tg_chat_id, text);
  if (!r.ok) return json({ ok: false, error: "telegram_error", details: r }, 502);
  return json({ ok: true });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
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
