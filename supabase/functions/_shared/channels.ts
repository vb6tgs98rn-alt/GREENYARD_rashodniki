/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 *
 * Копирование, распространение, переработка и обратная разработка
 * (reverse engineering) запрещены без письменного разрешения правообладателя.
 * Условия: см. файл LICENSE. Нарушение влечёт ответственность по ст. 1252,
 * 1301 ГК РФ.
 */
// Слой каналов связи: единый интерфейс поверх Telegram, MAX и WhatsApp.
//
// Зачем: бизнес-логика бота (гости, горничные, уборки) не должна знать,
// в каком мессенджере сидит собеседник. Она формирует текст в HTML и
// набор кнопок, а конкретный адаптер переводит это в формат своего API.
//
// Добавление нового канала = один адаптер здесь, логику трогать не нужно.
//
// deno-lint-ignore-file no-explicit-any

// TLS: platform-api*.max.ru выдаёт сертификат, подписанный Минцифры
// (Russian Trusted Root CA). Deno в Supabase Edge его не знает, поэтому
// все вызовы к MAX идут через fetchRu(), который автоматически
// подкладывает клиент с доверенной цепочкой для *.max.ru.
import { fetchRu } from "./ru_ca.ts";

// ═══════════════════════════════════════════════════════════════════
// ТИПЫ
// ═══════════════════════════════════════════════════════════════════

/** Поддерживаемые каналы. Значение совпадает с колонкой channel в БД. */
export type ChannelId = "telegram" | "max" | "whatsapp";

export const CHANNELS: ChannelId[] = ["telegram", "max", "whatsapp"];

export function isChannel(v: unknown): v is ChannelId {
  return typeof v === "string" && (CHANNELS as string[]).includes(v);
}

/**
 * Кнопка. Либо callback (нажатие возвращается вебхуком в поле data),
 * либо ссылка (url). Одновременно указывать нельзя.
 */
export type Btn = { text: string; data?: string; url?: string };

/** Кому шлём: канал + идентификатор чата в этом канале (всегда строкой). */
export type Recipient = { channel: ChannelId; chatId: string };

export type SendOpts = {
  /** Ряды кнопок. Каждый вложенный массив — одна строка. */
  buttons?: Btn[][];
  /** Показывать превью ссылок. По умолчанию выключено. */
  preview?: boolean;
  /** Текст без разметки: HTML не интерпретируется, а экранируется. */
  plain?: boolean;
};

export type SendResult = {
  ok: boolean;
  /** Идентификатор отправленного сообщения (строкой) или null. */
  messageId: string | null;
  error?: string;
};

/** Нормализованное входящее событие — общий вид для всех каналов. */
export type InboundEvent = {
  channel: ChannelId;
  /** Тип: старт по ссылке-приглашению, обычное сообщение, нажатие кнопки. */
  kind: "start" | "message" | "callback";
  chatId: string;
  /** Payload из диплинка (для kind === "start"). */
  startPayload?: string | null;
  /** Текст сообщения или подпись к фото. */
  text: string;
  /** data нажатой кнопки (для kind === "callback"). */
  callbackData?: string | null;
  /** Идентификатор нажатия, нужен чтобы погасить «часики» у кнопки. */
  callbackId?: string | null;
  /** Идентификатор входящего сообщения. */
  messageId?: string | null;
  /** Отправитель. */
  from: { id: string | null; firstName: string | null; lastName: string | null; username: string | null };
  /** Прямая ссылка на приложенное фото, если канал её отдаёт. */
  photoUrl?: string | null;
};

// ═══════════════════════════════════════════════════════════════════
// КОНФИГУРАЦИЯ (секреты только из окружения, никогда из БД и браузера)
// ═══════════════════════════════════════════════════════════════════

// Значения секретов чистим от ЛЮБЫХ пробелов/переводов строки — и по краям,
// и внутри. Панель Supabase может разбить длинный токен на несколько строк
// (внутренний \n), а любой такой символ в заголовке Authorization или в URL
// приводит к падению fetch (и бот «молча» не отвечает). Все значения здесь —
// это токены, URL, логины и номера, внутренних пробелов в них не бывает.
const env = (k: string, def = "") => (Deno.env.get(k) ?? def).replace(/\s+/g, "");

// Профиль бота: default — общий бот (гости + менеджер), maid — отдельный бот для горничных.
// Каждый профиль читает свой набор секретов, всё остальное (форматирование, парсинг, лимиты) — общее.
export type BotProfile = "default" | "maid";

// Секреты общего бота
const TG_TOKEN = env("TELEGRAM_BOT_TOKEN");
const MAX_TOKEN = env("MAX_BOT_TOKEN");
// Секреты бота горничных (создаём отдельно, чтобы у горничных был свой чат)
const MAID_TG_TOKEN = env("MAID_TELEGRAM_BOT_TOKEN");
const MAID_MAX_TOKEN = env("MAID_MAX_BOT_TOKEN");

const MAX_API = env("MAX_API_BASE", "https://platform-api.max.ru");

const WA_TOKEN = env("WHATSAPP_TOKEN");
const WA_PHONE_ID = env("WHATSAPP_PHONE_ID");
const WA_VERSION = env("WHATSAPP_API_VERSION", "v21.0");

/** Токен Telegram-бота для указанного профиля. */
export function tgTokenFor(profile: BotProfile = "default"): string {
  return profile === "maid" ? MAID_TG_TOKEN : TG_TOKEN;
}

/** Токен MAX-бота для указанного профиля. */
export function maxTokenFor(profile: BotProfile = "default"): string {
  return profile === "maid" ? MAID_MAX_TOKEN : MAX_TOKEN;
}

/** Канал считается включённым, если для него заданы все обязательные секреты. */
export function channelEnabled(channel: ChannelId, profile: BotProfile = "default"): boolean {
  if (channel === "telegram") return !!tgTokenFor(profile);
  if (channel === "max") return !!maxTokenFor(profile);
  if (channel === "whatsapp") return !!WA_TOKEN && !!WA_PHONE_ID;
  return false;
}

/** Список включённых каналов — для отдачи во фронтенд. */
export function enabledChannels(profile: BotProfile = "default"): ChannelId[] {
  return CHANNELS.filter((c) => channelEnabled(c, profile));
}

// ═══════════════════════════════════════════════════════════════════
// РАБОТА С ТЕКСТОМ
// ═══════════════════════════════════════════════════════════════════

/** Экранирование для вставки пользовательских данных в HTML-текст сообщения. */
export function htmlEscape(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** HTML → простой текст. Используется там, где разметка не поддерживается. */
export function htmlToPlain(html: string): string {
  const withBreaks = String(html ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n");
  return decodeEntities(withBreaks.replace(/<[^>]+>/g, "")).trim();
}

/**
 * HTML → разметка WhatsApp.
 * WhatsApp не понимает теги: жирный это *звёздочки*, курсив _подчёркивания_,
 * моноширинный — тройные обратные кавычки. Ссылка выносится в скобки,
 * потому что кликабельного анкора в WhatsApp нет.
 */
export function htmlToWhatsapp(html: string): string {
  let s = String(html ?? "");
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n");
  s = s.replace(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, url, label) => {
    const clean = String(label).replace(/<[^>]+>/g, "").trim();
    // Если подпись совпадает со ссылкой — не дублируем её в скобках.
    return clean && clean !== url ? `${clean} (${url})` : String(url);
  });
  s = s.replace(/<\/?(b|strong)>/gi, "*");
  s = s.replace(/<\/?(i|em)>/gi, "_");
  s = s.replace(/<\/?(s|del|strike)>/gi, "~");
  s = s.replace(/<\/?(code|pre)>/gi, "```");
  s = s.replace(/<[^>]+>/g, "");
  return decodeEntities(s).trim();
}

/**
 * MAX понимает HTML, но набор тегов уже, чем в Telegram.
 * Оставляем только заведомо поддерживаемые, остальное срезаем.
 */
const MAX_ALLOWED_TAGS = new Set(["b", "i", "u", "s", "code", "pre", "a", "mark", "blockquote"]);

export function htmlToMax(html: string): string {
  let s = String(html ?? "").replace(/<br\s*\/?>/gi, "\n");
  // Синонимы приводим к тегам, которые MAX точно понимает.
  s = s.replace(/<(\/?)strong>/gi, "<$1b>").replace(/<(\/?)em>/gi, "<$1i>");
  // Всё, чего нет в белом списке, вырезаем, содержимое оставляем.
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (tag, name: string) =>
    MAX_ALLOWED_TAGS.has(name.toLowerCase()) ? tag : ""
  );
  return s.trim();
}

/** Обрезка до лимита канала с многоточием. */
function clamp(s: string, limit: number): string {
  return s.length > limit ? s.slice(0, limit - 1) + "…" : s;
}

// Лимиты длины текста сообщения по каналам.
const TEXT_LIMIT: Record<ChannelId, number> = {
  telegram: 4096,
  max: 4000,
  whatsapp: 4096,
};

// ═══════════════════════════════════════════════════════════════════
// АДАПТЕР: TELEGRAM
// ═══════════════════════════════════════════════════════════════════

function tgKeyboard(buttons?: Btn[][]): any {
  if (!buttons?.length) return undefined;
  const rows = buttons
    .map((row) =>
      row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: b.data ?? "" }))
    )
    .filter((row) => row.length > 0);
  return rows.length ? { inline_keyboard: rows } : undefined;
}

async function tgSend(chatId: string, html: string, opts: SendOpts, profile: BotProfile): Promise<SendResult> {
  const token = tgTokenFor(profile);
  const payload: Record<string, any> = {
    chat_id: chatId,
    text: clamp(html, TEXT_LIMIT.telegram),
    disable_web_page_preview: !opts.preview,
  };
  if (!opts.plain) payload.parse_mode = "HTML";
  const kb = tgKeyboard(opts.buttons);
  if (kb) payload.reply_markup = kb;

  const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await r.json().catch(() => ({}));
  if (!data?.ok) {
    console.error("[channels/telegram] sendMessage:", JSON.stringify(data).slice(0, 500));
    return { ok: false, messageId: null, error: "telegram_send_failed" };
  }
  return { ok: true, messageId: data?.result?.message_id != null ? String(data.result.message_id) : null };
}

async function tgAnswerCallback(callbackId: string, text: string, profile: BotProfile): Promise<void> {
  const token = tgTokenFor(profile);
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ callback_query_id: callbackId, text }),
  }).catch(() => {});
}

/** Достаём прямую ссылку на самое крупное фото из апдейта Telegram. */
async function tgPhotoUrl(msg: any, profile: BotProfile = "default"): Promise<string | null> {
  const photos = msg?.photo;
  if (!Array.isArray(photos) || photos.length === 0) return null;
  const fileId = photos[photos.length - 1]?.file_id;
  if (!fileId) return null;
  const token = tgTokenFor(profile);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
    const j = await r.json();
    const path = j?.result?.file_path;
    return path ? `https://api.telegram.org/file/bot${token}/${path}` : null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// АДАПТЕР: MAX
// ═══════════════════════════════════════════════════════════════════
// Особенности против Telegram:
//  • токен идёт в заголовке Authorization КАК ЕСТЬ, без префикса Bearer;
//  • получатель передаётся query-параметром chat_id, а не в теле;
//  • клавиатура — это вложение типа inline_keyboard;
//  • в ряду не больше 7 кнопок (для ссылок — не больше 3).

function maxKeyboard(buttons?: Btn[][]): any[] | undefined {
  if (!buttons?.length) return undefined;
  const rows = buttons
    .map((row) => {
      const hasLink = row.some((b) => !!b.url);
      const perRow = hasLink ? 3 : 7;
      return row
        .slice(0, perRow)
        .map((b) => (b.url ? { type: "link", text: b.text, url: b.url } : { type: "callback", text: b.text, payload: b.data ?? "" }));
    })
    .filter((row) => row.length > 0);
  if (!rows.length) return undefined;
  return [{ type: "inline_keyboard", payload: { buttons: rows } }];
}

async function maxSend(chatId: string, html: string, opts: SendOpts, profile: BotProfile): Promise<SendResult> {
  const token = maxTokenFor(profile);
  const url = new URL("/messages", MAX_API);
  url.searchParams.set("chat_id", chatId);
  if (!opts.preview) url.searchParams.set("disable_link_preview", "true");

  const body: Record<string, any> = { text: clamp(opts.plain ? htmlToPlain(html) : htmlToMax(html), TEXT_LIMIT.max) };
  if (!opts.plain) body.format = "html";
  const attachments = maxKeyboard(opts.buttons);
  if (attachments) body.attachments = attachments;

  const r = await fetchRu(url.href, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (r.status !== 200) {
    console.error("[channels/max] sendMessage:", r.status, JSON.stringify(data).slice(0, 500));
    return { ok: false, messageId: null, error: "max_send_failed" };
  }
  return { ok: true, messageId: data?.message?.body?.mid ? String(data.message.body.mid) : null };
}

async function maxAnswerCallback(callbackId: string, text: string, profile: BotProfile): Promise<void> {
  const token = maxTokenFor(profile);
  const url = new URL("/answers", MAX_API);
  url.searchParams.set("callback_id", callbackId);
  await fetchRu(url.href, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: token },
    body: JSON.stringify(text ? { notification: text } : {}),
  }).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════════
// АДАПТЕР: WHATSAPP (Meta Cloud API)
// ═══════════════════════════════════════════════════════════════════
// Ограничения, которых нет в Telegram и MAX:
//  • свободное сообщение можно отправить только в течение 24 часов
//    после последнего сообщения собеседника, иначе нужен утверждённый шаблон;
//  • кнопок-ответов максимум 3, подпись до 20 символов;
//  • если кнопок больше — используем список (до 10 пунктов);
//  • разметки HTML нет, только *звёздочки*.

function waPhone(chatId: string): string {
  return String(chatId).replace(/[^\d]/g, "");
}

function waInteractive(text: string, buttons: Btn[][]): any | null {
  const flat = buttons.flat().filter((b) => !b.url && b.data);
  if (flat.length === 0) return null;

  if (flat.length <= 3) {
    return {
      type: "button",
      body: { text: clamp(text, 1024) },
      action: {
        buttons: flat.map((b) => ({
          type: "reply",
          reply: { id: clamp(b.data ?? "", 256), title: clamp(b.text, 20) },
        })),
      },
    };
  }

  return {
    type: "list",
    body: { text: clamp(text, 1024) },
    action: {
      button: "Выбрать",
      sections: [
        {
          title: "Меню",
          rows: flat.slice(0, 10).map((b) => ({
            id: clamp(b.data ?? "", 200),
            title: clamp(b.text, 24),
          })),
        },
      ],
    },
  };
}

async function waSend(chatId: string, html: string, opts: SendOpts): Promise<SendResult> {
  const text = clamp(htmlToWhatsapp(html), TEXT_LIMIT.whatsapp);
  const to = waPhone(chatId);

  const body: Record<string, any> = { messaging_product: "whatsapp", recipient_type: "individual", to };

  const interactive = opts.buttons?.length ? waInteractive(text, opts.buttons) : null;
  if (interactive) {
    body.type = "interactive";
    body.interactive = interactive;
  } else {
    body.type = "text";
    body.text = { body: text, preview_url: !!opts.preview };
  }

  const r = await fetch(`https://graph.facebook.com/${WA_VERSION}/${WA_PHONE_ID}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${WA_TOKEN}` },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error("[channels/whatsapp] sendMessage:", r.status, JSON.stringify(data).slice(0, 500));
    return { ok: false, messageId: null, error: "whatsapp_send_failed" };
  }
  return { ok: true, messageId: data?.messages?.[0]?.id ?? null };
}

/**
 * Медиа в WhatsApp отдаётся по временной ссылке, требующей токен,
 * поэтому прямой публичный URL получить нельзя. Возвращаем ссылку на
 * скачивание — она пригодна только для серверного запроса с токеном.
 */
async function waMediaUrl(mediaId: string): Promise<string | null> {
  try {
    const r = await fetch(`https://graph.facebook.com/${WA_VERSION}/${mediaId}`, {
      headers: { Authorization: `Bearer ${WA_TOKEN}` },
    });
    const j = await r.json();
    return j?.url ?? null;
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════
// ЕДИНЫЙ ИНТЕРФЕЙС ОТПРАВКИ
// ═══════════════════════════════════════════════════════════════════

export type SendMessageOpts = SendOpts & { botProfile?: BotProfile };

/**
 * Отправить сообщение в любой канал.
 * Текст всегда передаётся в HTML — адаптер сам приведёт его к своему формату.
 * Параметр botProfile выбирает набор токенов: "default" — общий бот, "maid" — бот горничных.
 */
export async function sendMessage(to: Recipient, html: string, opts: SendMessageOpts = {}): Promise<SendResult> {
  const profile: BotProfile = opts.botProfile ?? "default";
  if (!to?.chatId) return { ok: false, messageId: null, error: "no_chat_id" };
  if (!channelEnabled(to.channel, profile)) {
    console.error(`[channels] канал ${to.channel} (профиль ${profile}) не настроен, сообщение не отправлено`);
    return { ok: false, messageId: null, error: "channel_disabled" };
  }
  try {
    if (to.channel === "telegram") return await tgSend(to.chatId, html, opts, profile);
    if (to.channel === "max") return await maxSend(to.chatId, html, opts, profile);
    if (to.channel === "whatsapp") return await waSend(to.chatId, html, opts);
    return { ok: false, messageId: null, error: "unknown_channel" };
  } catch (e) {
    // Наружу отдаём только флаг: детали исключения не должны попадать в HTTP-ответ.
    console.error(`[channels] исключение при отправке в ${to.channel}:`, e);
    return { ok: false, messageId: null, error: "send_exception" };
  }
}

/** Погасить индикатор загрузки на нажатой кнопке. Для WhatsApp не требуется. */
export async function answerCallback(channel: ChannelId, callbackId: string, text = "", profile: BotProfile = "default"): Promise<void> {
  if (!callbackId) return;
  if (channel === "telegram") return await tgAnswerCallback(callbackId, text, profile);
  if (channel === "max") return await maxAnswerCallback(callbackId, text, profile);
}

// ═══════════════════════════════════════════════════════════════════
// РАЗБОР ВХОДЯЩИХ СОБЫТИЙ
// ═══════════════════════════════════════════════════════════════════

/** Telegram: update → нормализованное событие. Профиль нужен для получения фото по botProfile-токену. */
export async function parseTelegramUpdate(update: any, profile: BotProfile = "default"): Promise<InboundEvent | null> {
  if (update?.callback_query) {
    const cq = update.callback_query;
    const chatId = cq?.message?.chat?.id;
    if (chatId == null) return null;
    return {
      channel: "telegram",
      kind: "callback",
      chatId: String(chatId),
      text: "",
      callbackData: cq.data ?? "",
      callbackId: cq.id ?? null,
      messageId: cq?.message?.message_id != null ? String(cq.message.message_id) : null,
      from: {
        id: cq?.from?.id != null ? String(cq.from.id) : null,
        firstName: cq?.from?.first_name ?? null,
        lastName: cq?.from?.last_name ?? null,
        username: cq?.from?.username ?? null,
      },
    };
  }

  const msg = update?.message || update?.edited_message;
  if (!msg) return null;
  const chatId = msg?.chat?.id;
  if (chatId == null) return null;

  const rawText: string = msg.text || msg.caption || "";
  const from = {
    id: msg?.from?.id != null ? String(msg.from.id) : null,
    firstName: msg?.from?.first_name ?? null,
    lastName: msg?.from?.last_name ?? null,
    username: msg?.from?.username ?? null,
  };

  if (rawText.startsWith("/start")) {
    return {
      channel: "telegram",
      kind: "start",
      chatId: String(chatId),
      startPayload: rawText.replace(/^\/start\s*/, "").trim(),
      text: rawText,
      messageId: msg.message_id != null ? String(msg.message_id) : null,
      from,
    };
  }

  return {
    channel: "telegram",
    kind: "message",
    chatId: String(chatId),
    text: rawText,
    messageId: msg.message_id != null ? String(msg.message_id) : null,
    from,
    photoUrl: await tgPhotoUrl(msg, profile),
  };
}

/** MAX: update → нормализованное событие. */
export function parseMaxUpdate(update: any): InboundEvent | null {
  const type = update?.update_type;

  // Пользователь открыл бота по диплинку вида https://max.ru/<bot>?start=<payload>
  if (type === "bot_started") {
    const chatId = update?.chat_id;
    if (chatId == null) return null;
    return {
      channel: "max",
      kind: "start",
      chatId: String(chatId),
      startPayload: update?.payload ?? "",
      text: "",
      from: maxUser(update?.user),
    };
  }

  if (type === "message_callback") {
    const chatId = update?.message?.recipient?.chat_id;
    if (chatId == null) return null;
    return {
      channel: "max",
      kind: "callback",
      chatId: String(chatId),
      text: "",
      callbackData: update?.callback?.payload ?? "",
      callbackId: update?.callback?.callback_id ?? null,
      messageId: update?.message?.body?.mid ?? null,
      from: maxUser(update?.callback?.user ?? update?.message?.sender),
    };
  }

  if (type === "message_created") {
    const msg = update?.message;
    const chatId = msg?.recipient?.chat_id;
    if (chatId == null) return null;
    const text: string = msg?.body?.text ?? "";
    const from = maxUser(msg?.sender);

    // Команда /start с параметром может прийти и обычным сообщением.
    if (text.startsWith("/start")) {
      return {
        channel: "max",
        kind: "start",
        chatId: String(chatId),
        startPayload: text.replace(/^\/start\s*/, "").trim(),
        text,
        messageId: msg?.body?.mid ?? null,
        from,
      };
    }

    return {
      channel: "max",
      kind: "message",
      chatId: String(chatId),
      text,
      messageId: msg?.body?.mid ?? null,
      from,
      photoUrl: maxPhotoUrl(msg),
    };
  }

  return null;
}

function maxUser(u: any): InboundEvent["from"] {
  // В MAX имя приходит одной строкой, разбираем на имя и фамилию.
  const name: string = u?.name ?? "";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return {
    id: u?.user_id != null ? String(u.user_id) : null,
    firstName: parts[0] ?? null,
    lastName: parts.slice(1).join(" ") || null,
    username: u?.username ?? null,
  };
}

function maxPhotoUrl(msg: any): string | null {
  const atts = msg?.body?.attachments;
  if (!Array.isArray(atts)) return null;
  const img = atts.find((a: any) => a?.type === "image");
  return img?.payload?.url ?? null;
}

/** WhatsApp: тело вебхука → список нормализованных событий (может прийти пачкой). */
export async function parseWhatsappUpdate(body: any): Promise<InboundEvent[]> {
  const out: InboundEvent[] = [];
  const entries = body?.entry;
  if (!Array.isArray(entries)) return out;

  for (const entry of entries) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      const messages = value?.messages;
      if (!Array.isArray(messages)) continue;

      // Профиль отправителя лежит отдельно от самого сообщения.
      const contact = value?.contacts?.[0];
      const profileName: string = contact?.profile?.name ?? "";
      const nameParts = profileName.trim().split(/\s+/).filter(Boolean);

      for (const m of messages) {
        const chatId = m?.from;
        if (!chatId) continue;
        const from = {
          id: String(chatId),
          firstName: nameParts[0] ?? null,
          lastName: nameParts.slice(1).join(" ") || null,
          username: null,
        };

        // Нажатие кнопки или выбор пункта списка.
        if (m?.type === "interactive") {
          const data =
            m?.interactive?.button_reply?.id ??
            m?.interactive?.list_reply?.id ??
            "";
          out.push({
            channel: "whatsapp",
            kind: "callback",
            chatId: String(chatId),
            text: "",
            callbackData: data,
            callbackId: null,
            messageId: m?.id ?? null,
            from,
          });
          continue;
        }

        const text: string = m?.text?.body ?? m?.image?.caption ?? m?.button?.text ?? "";

        if (text.startsWith("/start")) {
          out.push({
            channel: "whatsapp",
            kind: "start",
            chatId: String(chatId),
            startPayload: text.replace(/^\/start\s*/, "").trim(),
            text,
            messageId: m?.id ?? null,
            from,
          });
          continue;
        }

        out.push({
          channel: "whatsapp",
          kind: "message",
          chatId: String(chatId),
          text,
          messageId: m?.id ?? null,
          from,
          photoUrl: m?.image?.id ? await waMediaUrl(m.image.id) : null,
        });
      }
    }
  }

  return out;
}

// ═══════════════════════════════════════════════════════════════════
// ССЫЛКИ-ПРИГЛАШЕНИЯ
// ═══════════════════════════════════════════════════════════════════

const TG_BOT_USERNAME = env("TELEGRAM_BOT_USERNAME");
const MAX_BOT_USERNAME = env("MAX_BOT_USERNAME");
const WA_PHONE_NUMBER = env("WHATSAPP_PHONE_NUMBER");
// Юзернеймы бота горничных
const MAID_TG_BOT_USERNAME = env("MAID_TELEGRAM_BOT_USERNAME");
const MAID_MAX_BOT_USERNAME = env("MAID_MAX_BOT_USERNAME");

function tgBotUsernameFor(profile: BotProfile): string {
  return profile === "maid" ? MAID_TG_BOT_USERNAME : TG_BOT_USERNAME;
}

function maxBotUsernameFor(profile: BotProfile): string {
  return profile === "maid" ? MAID_MAX_BOT_USERNAME : MAX_BOT_USERNAME;
}

/**
 * Ссылка, по которой гость или горничная попадёт в нужный бот
 * с переданным параметром.
 *
 * В WhatsApp диплинков к боту нет, поэтому подставляем текст «/start <код>»
 * в поле ввода: собеседнику остаётся нажать «отправить».
 */
export function inviteLink(channel: ChannelId, payload: string, profile: BotProfile = "default"): string | null {
  if (channel === "telegram") {
    const u = tgBotUsernameFor(profile);
    return u ? `https://t.me/${u}?start=${encodeURIComponent(payload)}` : null;
  }
  if (channel === "max") {
    const u = maxBotUsernameFor(profile);
    return u ? `https://max.ru/${u}?start=${encodeURIComponent(payload)}` : null;
  }
  if (channel === "whatsapp") {
    const phone = waPhone(WA_PHONE_NUMBER);
    return phone ? `https://wa.me/${phone}?text=${encodeURIComponent(`/start ${payload}`)}` : null;
  }
  return null;
}

/** Человекочитаемое название канала для интерфейса и уведомлений. */
export const CHANNEL_TITLE: Record<ChannelId, string> = {
  telegram: "Telegram",
  max: "MAX",
  whatsapp: "WhatsApp",
};
