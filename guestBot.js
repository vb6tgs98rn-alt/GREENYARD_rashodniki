/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 *
 * Копирование, распространение, переработка и обратная разработка
 * (reverse engineering) запрещены без письменного разрешения правообладателя.
 * Условия: см. файл LICENSE. Нарушение влечёт ответственность по ст. 1252,
 * 1301 ГК РФ.
 */
// =============================================================================
// guestBot.js — клиентский модуль для гостевого Telegram-бота.
// Содержит:
//   1) API-функции к Supabase (manager_settings, guest_instructions,
//      guest_sessions, guest_messages, guest_events, v_guest_chats)
//   2) Рендеры для разделов «Брони», «Инструкции для гостей», «Чаты с гостями»,
//      «Настройки уведомлений» — каждая открывается как модалка.
//   3) Подписку на Supabase Realtime для входящих сообщений в чатах.
//
// Архитектура:
//   - Все методы работают через RLS (user_id = auth.uid())
//   - Никаких глобалов; экспортируется набор функций + initGuestBotModule(state)
//   - Зависимости: supabase-client.js, render.js (openModal/closeModal/setStatus),
//     api.js (fetchRealtyCalendarBookings), state.js (apartments).
// =============================================================================

import { getSupabaseClient, waitForAuthReady} from './supabase-client.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { openModal, closeModal, setStatus } from './render.js';
import { fetchRealtyCalendarBookings } from './api.js';

// URL Edge Function бота (один webhook для всех пользователей).
export const TELEGRAM_BOT_USERNAME_DEFAULT = 'greenyard_guests_bot';
export const BOT_FUNCTION_URL = 'https://wpwuxcxmtvdxftqrrxuu.supabase.co/functions/v1/telegram-bot';
// Отдельный бот для горничных (@A_smena_bot). Приглашения и сообщения горничным идут туда.
export const MAID_BOT_FUNCTION_URL = 'https://wpwuxcxmtvdxftqrrxuu.supabase.co/functions/v1/maid-bot';

// ─────────────────────────────────────────────────────────────────────────────
// 0) Утилиты
// ─────────────────────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

// Безопасный вывод тела сообщения: сначала экранируем всё,
// потом возвращаем только белый список Telegram-тегов и переводы строк.
const fmtBody = (s) => {
  let h = esc(s);
  h = h
    .replace(/&lt;(\/?)b&gt;/g, '<$1b>')
    .replace(/&lt;(\/?)strong&gt;/g, '<$1strong>')
    .replace(/&lt;(\/?)i&gt;/g, '<$1i>')
    .replace(/&lt;(\/?)em&gt;/g, '<$1em>')
    .replace(/&lt;(\/?)u&gt;/g, '<$1u>')
    .replace(/&lt;(\/?)s&gt;/g, '<$1s>')
    .replace(/&lt;(\/?)code&gt;/g, '<$1code>')
    .replace(/&lt;(\/?)pre&gt;/g, '<$1pre>');
  return h.replace(/\n/g, '<br>');
};

const fmtDate = (s) => {
  if (!s) return '';
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return String(s);
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
  } catch { return String(s); }
};

const fmtDateShort = (s) => {
  if (!s) return '';
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return String(s);
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });
  } catch { return String(s); }
};

const fmtTime = (s) => {
  if (!s) return '';
  try {
    const d = new Date(s);
    if (Number.isNaN(d.getTime())) return '';
    return d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
};

const fmtMoney = (n) => {
  const x = Number(n || 0);
  return x.toLocaleString('ru-RU') + ' ₽';
};

const nightsBetween = (a, b) => {
  if (!a || !b) return 0;
  try {
    const d1 = new Date(a); const d2 = new Date(b);
    if (Number.isNaN(d1.getTime()) || Number.isNaN(d2.getTime())) return 0;
    return Math.max(0, Math.round((d2 - d1) / 86400000));
  } catch { return 0; }
};

const DEFAULT_INVITE_TEMPLATE = `Здравствуйте, {name}! 👋

Подтверждаем вашу бронь:
📍 {address}
📅 {dates} · {nights} ноч.
💰 {amount} ₽

Для удобства подготовили Telegram-бота — там вся информация о заселении, Wi-Fi, контакты, если нужна помощь:

👉 {link}

До встречи!`;

// ─────────────────────────────────────────────────────────────────────────────
// 1) API: manager_settings
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchManagerSettings() {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  await waitForAuthReady();
  const { data: { session: _sess } } = await supabase.auth.getSession();
  const user = _sess?.user ?? null;
  if (!user) return null;
  const { data, error } = await supabase
    .from('manager_settings').select('*').eq('user_id', user.id).maybeSingle();
  if (error) { console.warn('[bot] fetchManagerSettings:', error.message); return null; }
  return data || null;
}

export async function saveManagerSettings(patch) {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase не подключён');
  await waitForAuthReady();
  const { data: { session: _sess } } = await supabase.auth.getSession();
  const user = _sess?.user ?? null;
  if (!user) throw new Error('Войдите в аккаунт');
  const row = { user_id: user.id, updated_at: new Date().toISOString(), ...patch };
  const { error } = await supabase.from('manager_settings').upsert(row, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 2) API: guest_instructions
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchAllInstructions() {
  const supabase = getSupabaseClient();
  if (!supabase) return [];
  await waitForAuthReady();
  const { data: { session: _sess } } = await supabase.auth.getSession();
  const user = _sess?.user ?? null;
  if (!user) return [];
  const { data, error } = await supabase
    .from('guest_instructions').select('*').eq('user_id', user.id);
  if (error) { console.warn('[bot] fetchAllInstructions:', error.message); return []; }
  return data || [];
}

export async function fetchInstructionFor(apartmentId) {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  await waitForAuthReady();
  const { data: { session: _sess } } = await supabase.auth.getSession();
  const user = _sess?.user ?? null;
  if (!user) return null;
  const { data, error } = await supabase
    .from('guest_instructions').select('*')
    .eq('user_id', user.id).eq('apartment_id', String(apartmentId)).maybeSingle();
  if (error) { console.warn('[bot] fetchInstructionFor:', error.message); return null; }
  return data || null;
}

export async function saveInstruction(apartmentId, apartmentTitle, patch) {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase не подключён');
  await waitForAuthReady();
  const { data: { session: _sess } } = await supabase.auth.getSession();
  const user = _sess?.user ?? null;
  if (!user) throw new Error('Войдите в аккаунт');
  // Без apartment_id upsert упадёт в БД (NOT NULL),
  // поэтому отлавливаем раньше и с понятным сообщением.
  if (apartmentId === null || apartmentId === undefined || String(apartmentId).trim() === '') {
    throw new Error('Не выбрана квартира — нечего сохранять');
  }
  // Из patch принудительно вырезаем служебные поля, чтобы при копировании
  // инструкций из другой квартиры не попадал чужой id/user_id.
  const safePatch = { ...(patch || {}) };
  delete safePatch.id;
  delete safePatch.user_id;
  delete safePatch.apartment_id;
  delete safePatch.apartment_title;
  delete safePatch.created_at;
  delete safePatch.updated_at;

  // Поля, которых нет в форме, принудительно обнуляем: раньше они оставались
  // от старых версий интерфейса и бот отправлял гостю данные, которые
  // менеджер уже не видит и не может исправить.
  const LEGACY_FIELDS = {
    directions_metro: null, parking_info: null, entrance_code: null,
    door_code: null, key_location: null, checkin_instruction: null,
    checkout_checklist: null, key_return_info: null,
    emergency_phone: null, emergency_telegram: null,
    apartment_notes: null, amenities: null,
  };

  const row = {
    user_id: user.id,
    apartment_id: String(apartmentId),
    apartment_title: apartmentTitle || null,
    updated_at: new Date().toISOString(),
    ...LEGACY_FIELDS,
    ...safePatch,
  };
  const { error } = await supabase
    .from('guest_instructions')
    .upsert(row, { onConflict: 'user_id,apartment_id' });
  if (error) throw new Error(error.message);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3) API: guest_sessions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Создаёт или находит сессию для брони. Используется когда менеджер
 * нажимает «скопировать ссылку» — мы заранее регистрируем secure_id,
 * чтобы бот при /start <secure_id> сразу нашёл бронь.
 */
export async function ensureSessionForBooking(booking) {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase не подключён');
  await waitForAuthReady();
  const { data: { session: _sess } } = await supabase.auth.getSession();
  const user = _sess?.user ?? null;
  if (!user) throw new Error('Войдите в аккаунт');
  if (!booking?.booking_id) throw new Error('Бронь без booking_id');
  // secure_id берём из raw_payload
  const secureId =
    booking?.raw_payload?.data?.booking?.secure_id ||
    booking?.raw_payload?.booking?.secure_id ||
    String(booking.booking_id);

  // upsert по (user_id, booking_id)
  const row = {
    user_id: user.id,
    booking_id: Number(booking.booking_id),
    secure_id: String(secureId),
    realty_id: booking.realty_id ?? null,
    link_sent_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  // Канал по умолчанию из настроек; при первом входе гостя бот уточнит его сам.
  try {
    const ms = await fetchManagerSettings();
    if (ms?.guest_default_channel) row.channel = ms.guest_default_channel;
  } catch { /* некритично — останется Telegram */ }
  const { data, error } = await supabase
    .from('guest_sessions')
    .upsert(row, { onConflict: 'user_id,booking_id' })
    .select()
    .maybeSingle();
  if (error) throw new Error(error.message);

  // Дополнительно проставляем guest_link_sent_at в rc_bookings (для бейджа в списке)
  await supabase
    .from('rc_bookings')
    .update({ guest_link_sent_at: row.link_sent_at })
    .eq('user_id', user.id).eq('booking_id', row.booking_id);

  return data || row;
}

// Получить сессию быстро (без network) — читаем напрямую из localStorage.
function getSessionFromStorage() {
  try {
    const raw = localStorage.getItem('gy-auth-session');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

// Прямой REST-запрос к Supabase с AbortController+timeout — обходит зависания supabase-js после возврата из фона.
async function restQuery(path, timeoutMs = 8000) {
  const sess = getSessionFromStorage();
  const token = sess?.access_token;
  if (!token) throw new Error('not authenticated');
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      signal: ac.signal,
      cache: 'no-store',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`REST ${res.status}: ${text.slice(0, 200)}`);
    }
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

function getUidFromStorage() {
  const sess = getSessionFromStorage();
  return sess?.user?.id || null;
}

export async function fetchGuestChats() {
  const uid = getUidFromStorage();
  if (!uid) throw new Error('not authenticated');
  return await restQuery(`v_guest_chats?select=*&user_id=eq.${uid}&order=last_message_at.desc.nullslast`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4) API: guest_messages
// ─────────────────────────────────────────────────────────────────────────────

export async function fetchMessages(sessionId, limit = 200) {
  const uid = getUidFromStorage();
  if (!uid) throw new Error('not authenticated');
  const path = `guest_messages?select=*&user_id=eq.${uid}&session_id=eq.${sessionId}&order=created_at.asc&limit=${limit}`;
  return await restQuery(path);
}

/**
 * Менеджер пишет в чат через приложение. Сообщение сохраняется как
 * direction='manager' и Edge Function (по триггеру/Realtime) перешлёт его гостю.
 * Простой подход: пишем в таблицу, а бот отдельным вызовом sendManagerMessage
 * сразу шлёт через Telegram API. Используем Edge Function endpoint /send.
 */
export async function sendManagerMessage(session, text) {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase не подключён');
  await waitForAuthReady();
  const { data: { session: _sess } } = await supabase.auth.getSession();
  const user = _sess?.user ?? null;
  if (!user) throw new Error('Войдите в аккаунт');
  if (!session?.session_id) throw new Error('Чат не найден');
  if (!text || !text.trim()) throw new Error('Пустое сообщение');

  // Просим Edge Function отправить в Telegram И сохранить в БД (одной операцией).
  // Не пишем в БД сами: избегаем дублирования и ситуации «в БД есть, а в TG нет».
  const sess = await supabase.auth.getSession();
  const accessToken = sess?.data?.session?.access_token || '';
  const resp = await fetch(`${BOT_FUNCTION_URL}/send`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { 'authorization': `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify({ session_id: session.session_id, text: text.trim() }),
  });
  if (!resp.ok) {
    let msg = `HTTP ${resp.status}`;
    try { const j = await resp.json(); msg = j?.error || msg; } catch {}
    throw new Error(msg);
  }
  return { ok: true };
}

/**
 * Переключатель AI-режима на конкретный чат (сессия). Когда OFF —
 * бот не отвечает гостю сам, только пересылает менеджеру.
 */
export async function setChatAiEnabled(sessionId, enabled) {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase не подключён');
  await waitForAuthReady();
  const { data: { session: _sess } } = await supabase.auth.getSession();
  const user = _sess?.user ?? null;
  if (!user) throw new Error('Войдите в аккаунт');
  const { error } = await supabase
    .from('guest_sessions')
    .update({ ai_enabled: !!enabled })
    .eq('id', sessionId)
    .eq('user_id', user.id);
  if (error) throw new Error(error.message);
  return { ok: true };
}

export async function markChatAsRead(sessionId) {
  const supabase = getSupabaseClient();
  if (!supabase) return;
  await waitForAuthReady();
  const { data: { session: _sess } } = await supabase.auth.getSession();
  const user = _sess?.user ?? null;
  if (!user) return;
  await supabase
    .from('guest_messages')
    .update({ is_read_by_manager: true })
    .eq('user_id', user.id)
    .eq('session_id', sessionId)
    .eq('direction', 'inbound')
    .eq('is_read_by_manager', false);
}

export async function fetchUnreadCount() {
  const supabase = getSupabaseClient();
  if (!supabase) return 0;
  await waitForAuthReady();
  const { data: { session: _sess } } = await supabase.auth.getSession();
  const user = _sess?.user ?? null;
  if (!user) return 0;
  const { count, error } = await supabase
    .from('guest_messages')
    .select('id', { count: 'exact', head: true })
    .eq('user_id', user.id)
    .eq('direction', 'inbound')
    .eq('is_read_by_manager', false);
  if (error) { console.warn('[bot] fetchUnreadCount:', error.message); return 0; }
  return count || 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5) Утилиты для шаблона приглашения
// ─────────────────────────────────────────────────────────────────────────────

export function renderInviteText(template, vars) {
  const tpl = template && template.trim() ? template : DEFAULT_INVITE_TEMPLATE;
  return tpl
    .replaceAll('{name}',    vars.name    || 'гость')
    .replaceAll('{address}', vars.address || 'будет уточнён')
    .replaceAll('{dates}',   vars.dates   || '')
    .replaceAll('{nights}',  String(vars.nights ?? ''))
    .replaceAll('{amount}',  String(vars.amount ?? ''))
    .replaceAll('{link}',    vars.link    || '');
}

function buildGuestLink(secureId, botUsername) {
  const name = botUsername || TELEGRAM_BOT_USERNAME_DEFAULT;
  return `https://t.me/${name}?start=${encodeURIComponent(secureId)}`;
}

// ──────────────────────────────────────────────────────────────────
// 5а) Мессенджеры: Telegram, MAX, WhatsApp
// ──────────────────────────────────────────────────────────────────

export const CHANNEL_TITLE = {
  telegram: 'Telegram',
  max: 'MAX',
  whatsapp: 'WhatsApp',
};

let _channelsCache = null;

/** Заголовки с JWT текущего пользователя для вызовов серверной функции. */
export async function botAuthHeaders() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase не подключён');
  await waitForAuthReady();
  const { data: { session } } = await supabase.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('Войдите в аккаунт');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
}

/** Мессенджеры, реально настроенные на сервере (есть токены). */
export async function fetchChannels() {
  if (_channelsCache) return _channelsCache;
  try {
    const r = await fetch(`${BOT_FUNCTION_URL}/channels`, { headers: await botAuthHeaders() });
    const j = await r.json().catch(() => ({}));
    _channelsCache = j?.ok && Array.isArray(j.channels) && j.channels.length
      ? j.channels
      : [{ id: 'telegram', title: 'Telegram' }];
  } catch (e) {
    console.warn('[bot] fetchChannels:', e?.message || e);
    _channelsCache = [{ id: 'telegram', title: 'Telegram' }];
  }
  return _channelsCache;
}

/** Ссылка-приглашение гостю в выбранном мессенджере. */
export async function fetchGuestInvite(sessionId, channel) {
  const r = await fetch(`${BOT_FUNCTION_URL}/guest_invite`, {
    method: 'POST',
    headers: await botAuthHeaders(),
    body: JSON.stringify({ session_id: sessionId, channel }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j?.ok) throw new Error(j?.error || 'invite_failed');
  return j.link;
}

/** Заполнить <select> списком мессенджеров. */
export async function fillChannelOptions(selectEl, selectedId) {
  if (!selectEl) return;
  const list = await fetchChannels();
  const cur = selectedId || 'telegram';
  const rows = [...list];
  if (!rows.some(c => c.id === cur)) rows.push({ id: cur, title: CHANNEL_TITLE[cur] || cur });
  selectEl.innerHTML = rows
    .map(c => `<option value="${c.id}"${c.id === cur ? ' selected' : ''}>${c.title || CHANNEL_TITLE[c.id] || c.id}</option>`)
    .join('');
}

// ─────────────────────────────────────────────────────────────────────────────
// 6) Рендер раздела «Брони»
// ─────────────────────────────────────────────────────────────────────────────

let _bookingsState = { all: [], filter: { apt: '', status: '', source: '' } };
// Мессенджеры, реально настроенные на сервере — для кнопок копирования ссылки гостю.
let _bookingsChannels = [{ id: 'telegram', title: 'Telegram' }];

export async function openBookingsModal(state) {
  ensureBookingsModal();
  openModal('bookingsModal');
  await reloadBookings(state);
}

async function reloadBookings(state) {
  const box = document.getElementById('bookingsListBox');
  if (box) box.innerHTML = '<div class="small" style="padding:1rem;opacity:.6;">Загрузка...</div>';
  const all = await fetchRealtyCalendarBookings(500);
  _bookingsState.all = all || [];
  // Подгружаем список мессенджеров один раз — чтобы кнопки рендерились синхронно (важно для iOS-копирования).
  try { _bookingsChannels = await fetchChannels(); } catch { _bookingsChannels = [{ id: 'telegram', title: 'Telegram' }]; }
  renderBookingsList(state);
  renderBookingsFilters(state);
}

function renderBookingsFilters(state) {
  const aptSel = document.getElementById('bookingFilterApt');
  if (aptSel) {
    const apts = state?.apartments || [];
    const cur = _bookingsState.filter.apt;
    aptSel.innerHTML = `<option value="">Все квартиры</option>` +
      apts.map(a => `<option value="${esc(a.id)}" ${cur === a.id ? 'selected' : ''}>${esc(a.name)}</option>`).join('');
  }
}

function detectBookingStatus(b) {
  // Отменённая имеет приоритет над датами: RealtyCalendar может прислать
  // статус "canceled" (одна l) или "deleted", или is_deleted=true.
  const st = String(b.status || '').toLowerCase();
  if (b.is_deleted || st === 'canceled' || st === 'cancelled' || st === 'deleted' || st === 'removed') {
    return 'cancelled';
  }
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const beg = b.begin_date ? new Date(b.begin_date) : null;
  const end = b.end_date ? new Date(b.end_date) : null;
  if (beg && end) {
    if (today < beg) return 'upcoming';
    if (today >= beg && today < end) return 'active';
    if (today >= end) return 'past';
  }
  return 'upcoming';
}

function renderBookingsList(state) {
  const box = document.getElementById('bookingsListBox');
  if (!box) return;

  const apts = state?.apartments || [];
  const aptById = new Map(apts.map(a => [String(a.externalIds?.realtyCalendarUnitId || ''), a]));

  const filter = _bookingsState.filter;
  const filterApt = filter.apt;
  const filterStatus = filter.status;
  const filterSource = filter.source;

  // Группируем
  const groups = { active: [], upcoming: [], past: [], cancelled: [] };
  for (const b of _bookingsState.all) {
    const apt = aptById.get(String(b.realty_id || ''));
    if (filterApt && apt?.id !== filterApt) continue;
    if (filterSource && b.source !== filterSource) continue;
    const st = detectBookingStatus(b);
    if (filterStatus && st !== filterStatus) continue;
    groups[st].push({ b, apt });
  }

  const renderCard = ({ b, apt }) => {
    const gross = Number(b.amount || 0);
    const tax = Number(b.platform_tax || b.raw_payload?.data?.booking?.platform_tax || 0);
    const net = Math.max(0, gross - tax);
    const nights = nightsBetween(b.begin_date, b.end_date);
    const secureId = b.raw_payload?.data?.booking?.secure_id || String(b.booking_id || '');
    const linkSent = !!b.guest_link_sent_at;
    const aptName = apt?.name || b.apartment_title || `realty_id=${b.realty_id}`;
    const phone = b.client_phone ? `<span class="small" style="opacity:.7;">${esc(b.client_phone)}</span>` : '';
    const guestName = b.client_fio || 'Без имени';
    const dates = `${fmtDate(b.begin_date)} → ${fmtDate(b.end_date)}`;
    const sourceMap = { manual: 'Вручную', 'sutochno.ru': 'Суточно', 'ostrovok.ru': 'Ostrovok', 'YandexTravel': 'Яндекс Путешествия', widget: 'Виджет' };
    const sourceTag = b.source ? `<span class="bk-tag">${esc(sourceMap[b.source] || b.source)}</span>` : '';
    const isCancelled = detectBookingStatus(b) === 'cancelled';
    const taxLine = tax > 0
      ? `<div class="small" style="opacity:.7;">Комиссия: ${fmtMoney(tax)} · Чистый: <b>${fmtMoney(net)}</b></div>`
      : `<div class="small" style="opacity:.7;">Без комиссии</div>`;

    const cancelBlock = isCancelled
      ? `<div class="bk-cancel-reason" style="margin-top:.5rem;padding:.5rem;background:rgba(255,80,80,.08);border-radius:.5rem;">
           <div class="small" style="margin-bottom:.3rem;opacity:.7;">Причина отмены:</div>
           <textarea data-cancel-reason="${esc(b.booking_id)}" rows="2" placeholder="Например: гость отменил, двойное бронирование, техническая ошибка…" style="width:100%;box-sizing:border-box;resize:vertical;min-height:2.5rem;">${esc(b.cancellation_reason || '')}</textarea>
           <div style="display:flex;justify-content:flex-end;margin-top:.3rem;">
             <button class="btn btn-secondary btn-sm" data-save-cancel-reason="${esc(b.booking_id)}" type="button">Сохранить</button>
           </div>
         </div>`
      : '';

    // Кнопки копирования ссылки: если настроен один мессенджер — одна кнопка,
    // если несколько — отдельная кнопка на каждый (гость выбирает, для какого копировать).
    const channels = (_bookingsChannels && _bookingsChannels.length) ? _bookingsChannels : [{ id: 'telegram', title: 'Telegram' }];
    const linkButtons = channels.length > 1
      ? channels.map(c =>
          `<button class="btn btn-primary bk-btn-link" data-link-booking="${esc(b.booking_id)}" data-channel="${esc(c.id)}" data-secure="${esc(secureId)}">
             📋 ${esc(c.title || CHANNEL_TITLE[c.id] || c.id)}
           </button>`).join('')
      : `<button class="btn btn-primary bk-btn-link ${linkSent ? 'is-sent' : ''}" data-link-booking="${esc(b.booking_id)}" data-channel="${esc(channels[0].id)}" data-secure="${esc(secureId)}">
           ${linkSent ? '✓ Ссылка скопирована' : '📋 Ссылка гостю'}
         </button>`;
    const actions = isCancelled
      ? ''
      : `<div class="bk-card-actions">
          <button class="btn btn-secondary bk-btn-chat" data-session-booking="${esc(b.booking_id)}">💬 Чат</button>
          ${linkButtons}
        </div>`;

    return `
      <div class="bk-card${isCancelled ? ' bk-cancelled' : ''}" data-booking="${esc(b.booking_id)}" style="${isCancelled ? 'opacity:.75;' : ''}">
        <div class="bk-card-head">
          <div>
            <div class="bk-guest">${esc(guestName)}</div>
            ${phone}
          </div>
          <div class="bk-apt">${esc(aptName)}</div>
        </div>
        <div class="bk-card-body">
          <div class="bk-dates">${esc(dates)} · ${nights} ноч.</div>
          <div class="bk-amount">${fmtMoney(gross)} ${sourceTag}</div>
          ${taxLine}
        </div>
        ${cancelBlock}
        ${actions}
      </div>`;
  };

  const section = (title, list, emoji) => list.length
    ? `<div class="bk-group"><div class="bk-group-title">${emoji} ${title} <span class="bk-count">${list.length}</span></div><div class="bk-grid">${list.map(renderCard).join('')}</div></div>`
    : '';

  const html = [
    section('Сейчас в квартире',      groups.active,    '🟢'),
    section('Предстоящие',            groups.upcoming,  '📅'),
    section('Завершённые',            groups.past,      '✅'),
    section('Отменённые',             groups.cancelled, '❌'),
  ].join('') || `<div class="empty" style="padding:2rem;text-align:center;opacity:.6;">Броней пока нет. После синхронизации с RealtyCalendar они появятся здесь.</div>`;

  box.innerHTML = html;
}

function ensureBookingsModal() {
  if (document.getElementById('bookingsModal')) return;
  const html = `
    <div class="modal-backdrop" id="bookingsModal" aria-hidden="true">
      <div class="modal" style="width:min(960px,100%);max-height:92dvh;display:flex;flex-direction:column;">
        <div class="section-head">
          <div>
            <h2 class="modal-title">Брони</h2>
            <p class="muted">Все бронирования из RealtyCalendar. Нажмите «Ссылка гостю» — текст с приглашением скопируется в буфер обмена.</p>
          </div>
          <button class="menu-toggle" id="closeBookingsModal" type="button" aria-label="Закрыть">✕</button>
        </div>
        <div class="bk-filters" style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.75rem;">
          <select id="bookingFilterApt" class="bk-filter"></select>
          <select id="bookingFilterStatus" class="bk-filter">
            <option value="">Все статусы</option>
            <option value="active">Активные</option>
            <option value="upcoming">Предстоящие</option>
            <option value="past">Завершённые</option>
            <option value="cancelled">Отменённые</option>
          </select>
          <select id="bookingFilterSource" class="bk-filter">
            <option value="">Все источники</option>
            <option value="manual">Вручную</option>
            <option value="Avito">Avito</option>
            <option value="Cian">ЦИАН</option>
            <option value="sutochno.ru">Суточно</option>
            <option value="ostrovok.ru">Ostrovok</option>
            <option value="YandexTravel">Яндекс Путешествия</option>
            <option value="Bronevik">Броневик</option>
            <option value="Otello">Otello</option>
            <option value="widget">Виджет</option>
          </select>
          <button class="btn btn-secondary" id="bookingsReloadBtn" type="button">↻ Обновить</button>
        </div>
        <div id="bookingsListBox" style="flex:1;overflow:auto;"></div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

// ─────────────────────────────────────────────────────────────────────────────
// ─── Ручная бронь ──────────────────────────────────────────────────
function ensureManualBookingModal() {
  if (document.getElementById('manualBookingModal')) return;
  const html = `
    <div class="modal-backdrop" id="manualBookingModal" aria-hidden="true">
      <div class="modal" style="width:min(560px,100%);max-height:92dvh;overflow:auto;">
        <div class="section-head">
          <div>
            <h2 class="modal-title">Новая бронь</h2>
            <p class="muted">Заполните данные гостя и брони. После создания будут доступны чат и ссылка гостю.</p>
          </div>
          <button class="menu-toggle" id="closeManualBooking" type="button" aria-label="Закрыть">✕</button>
        </div>
        <div class="grid" style="gap:.75rem;">
          <label><span class="small">Квартира</span><select id="mb_apartment"></select></label>
          <div class="row">
            <label><span class="small">Имя гостя</span><input id="mb_fio" type="text" placeholder="ФИО"></label>
            <label><span class="small">Телефон</span><input id="mb_phone" type="tel" inputmode="tel" placeholder="+7…"></label>
          </div>
          <label><span class="small">Email гостя (для чека, необязательно)</span><input id="mb_email" type="email" placeholder="guest@example.com"></label>
          <div class="row">
            <label><span class="small">Заезд</span><input id="mb_begin" type="date"></label>
            <label><span class="small">Выезд</span><input id="mb_end" type="date"></label>
          </div>
          <div class="row">
            <label><span class="small">Сумма, ₽</span><input id="mb_amount" type="number" min="0" step="1" value="0"></label>
            <label><span class="small">Предоплата, ₽</span><input id="mb_prepay" type="number" min="0" step="1" value="0"></label>
          </div>
          <label><span class="small">Источник</span><select id="mb_source">
            <option value="manual">Вручную</option>
            <option value="avito">Avito</option>
            <option value="cian">ЦИАН</option>
            <option value="sutochno">Суточно</option>
            <option value="booking">Booking</option>
            <option value="ostrovok">Ostrovok</option>
            <option value="yandex">Яндекс</option>
          </select></label>
          <div id="mb_error" class="small" style="color:var(--color-error);" hidden></div>
        </div>
        <div style="display:flex;gap:.75rem;justify-content:flex-end;margin-top:1rem;">
          <button class="btn btn-secondary" id="cancelManualBooking" type="button">Отмена</button>
          <button class="btn btn-primary" id="saveManualBooking" type="button">Создать бронь</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

function openManualBookingModal(state) {
  ensureManualBookingModal();
  const apts = state?.apartments || [];
  const sel = document.getElementById('mb_apartment');
  if (sel) {
    sel.innerHTML = apts.length
      ? apts.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')
      : '<option value="">Нет квартир</option>';
  }
  ['mb_fio', 'mb_phone', 'mb_email'].forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  const amount = document.getElementById('mb_amount'); if (amount) amount.value = '0';
  const prepay = document.getElementById('mb_prepay'); if (prepay) prepay.value = '0';
  const src = document.getElementById('mb_source'); if (src) src.value = 'manual';
  const errBox = document.getElementById('mb_error'); if (errBox) { errBox.hidden = true; errBox.textContent = ''; }
  const today = new Date();
  const tomorrow = new Date(today.getTime() + 86400000);
  const iso = (d) => d.toISOString().slice(0, 10);
  const beg = document.getElementById('mb_begin'); if (beg) beg.value = iso(today);
  const end = document.getElementById('mb_end'); if (end) end.value = iso(tomorrow);
  openModal('manualBookingModal');
}

// Создание ручной брони — INSERT в rc_bookings.
async function submitManualBooking(state) {
  const errBox = document.getElementById('mb_error');
  const showErr = (m) => { if (errBox) { errBox.textContent = m; errBox.hidden = false; } };
  const aptId = document.getElementById('mb_apartment')?.value;
  const apt = (state?.apartments || []).find(a => a.id === aptId);
  if (!apt) { showErr('Выберите квартиру.'); return; }
  const fio = (document.getElementById('mb_fio')?.value || '').trim();
  const phone = (document.getElementById('mb_phone')?.value || '').trim();
  const email = (document.getElementById('mb_email')?.value || '').trim();
  const begin = document.getElementById('mb_begin')?.value;
  const end = document.getElementById('mb_end')?.value;
  const amount = Math.max(0, Number(document.getElementById('mb_amount')?.value) || 0);
  const prepay = Math.max(0, Number(document.getElementById('mb_prepay')?.value) || 0);
  const source = document.getElementById('mb_source')?.value || 'manual';
  if (!fio) { showErr('Укажите имя гостя.'); return; }
  if (!begin || !end) { showErr('Укажите даты заезда и выезда.'); return; }
  if (end <= begin) { showErr('Дата выезда должна быть позже заезда.'); return; }
  if (prepay > amount) { showErr('Предоплата не может превышать сумму.'); return; }
  const supabase = getSupabaseClient();
  if (!supabase) { showErr('Нет подключения к базе.'); return; }
  const btn = document.getElementById('saveManualBooking');
  if (btn) { btn.disabled = true; btn.textContent = 'Создаём…'; }
  try {
    await waitForAuthReady();
    const { data: { session: _sess } } = await supabase.auth.getSession();
    const user = _sess?.user ?? null;
    if (!user) throw new Error('Сеанс не найден. Войдите заново.');
    const realtyId = apt.externalIds?.realtyCalendarUnitId;
    const nowIso = new Date().toISOString();
    const row = {
      booking_id: Date.now(),          // 13-значный id, не конфликтует с 9-значными RC
      user_id: user.id,
      agency_id: 0,                    // NOT NULL, для ручных — 0
      realty_id: realtyId ? Number(realtyId) : null,
      apartment_title: apt.name,
      begin_date: begin,
      end_date: end,
      amount,
      prepayment: prepay,
      status: 'confirmed',
      source,
      client_fio: fio,
      client_phone: phone || null,
      client_email: email || null,
      rc_created_at: nowIso,
    };
    const { error } = await supabase.from('rc_bookings').insert(row);
    if (error) throw error;
    closeModal('manualBookingModal');
    setStatus('Бронь создана');
    await reloadBookings(state);
  } catch (err) {
    showErr('Не удалось создать бронь: ' + (err?.message || err));
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Создать бронь'; }
  }
}

// 7) Раздел «Инструкции для гостей»
// ─────────────────────────────────────────────────────────────────────────────

let _instructionsState = { apartmentId: null, apartmentTitle: '' };

export async function openInstructionsModal(state) {
  ensureInstructionsModal();
  openModal('guestInstructionsModal');
  const apts = state?.apartments || [];
  const sel = document.getElementById('instrApartmentSelect');
  if (!sel) return;
  sel.innerHTML = apts.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  if (!apts.length) { clearInstructionForm(); return; }
  // Сохраняем выбор между открытиями модалки:
  // берём ранее выбранную квартиру, если она всё ещё в списке;
  // иначе первую.
  let pick = apts.find(a => a.id === _instructionsState.apartmentId) || apts[0];
  _instructionsState.apartmentId = pick.id;
  _instructionsState.apartmentTitle = pick.name;
  sel.value = pick.id;
  await loadInstructionIntoForm(pick.id, pick.name);
}

async function loadInstructionIntoForm(apartmentId, apartmentTitle) {
  // Перед загрузкой — очищаем все поля, чтобы не показывались данные от предыдущей квартиры
  // в момент между асинхронной загрузкой.
  document.querySelectorAll('#guestInstructionsModal [data-instr-field]').forEach(el => { el.value = ''; });
  const data = await fetchInstructionFor(apartmentId) || {};
  setFieldVal('instr_full_address', data.full_address);
  setFieldVal('instr_checkin_from', data.checkin_from || '14:00');
  setFieldVal('instr_checkout_until', data.checkout_until || '12:00');
  setFieldVal('instr_wifi_ssid', data.wifi_ssid);
  setFieldVal('instr_wifi_password', data.wifi_password);
  setFieldVal('instr_smoking_policy', data.smoking_policy);
  setFieldVal('instr_pets_policy', data.pets_policy);
  setFieldVal('instr_quiet_hours', data.quiet_hours);
  setFieldVal('instr_other_rules', data.other_rules);
  setFieldVal('instr_ai_instructions', data.ai_instructions);
  _instructionsState.apartmentId = apartmentId;
  _instructionsState.apartmentTitle = apartmentTitle;
  // Если данные уже введены — блокируем все поля, кнопка «Редактировать». Иначе — ввод, кнопка «Сохранить».
  setInstructionsReadOnly(hasAnyInstructionData(data));
}

function clearInstructionForm() {
  document.querySelectorAll('#guestInstructionsModal [data-instr-field]')
    .forEach(el => { el.value = ''; });
  setInstructionsReadOnly(false);
}

// Read-only паттерн для полей инструкций — после ввода блокируем, кнопка меняется на «Редактировать».
function setInstructionsReadOnly(readOnly) {
  document.querySelectorAll('#guestInstructionsModal [data-instr-field]').forEach(el => {
    if (readOnly) el.setAttribute('readonly', '');
    else el.removeAttribute('readonly');
  });
  const saveBtn = document.getElementById('instrSaveBtn');
  if (saveBtn) {
    saveBtn.textContent = readOnly ? 'Редактировать' : 'Сохранить';
    saveBtn.dataset.mode = readOnly ? 'edit' : 'save';
  }
}

function hasAnyInstructionData(data) {
  if (!data) return false;
  const keys = ['full_address','wifi_ssid','wifi_password','smoking_policy','pets_policy','quiet_hours','other_rules','ai_instructions'];
  return keys.some(k => data[k] && String(data[k]).trim());
}

function setFieldVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val ?? '';
}

function readInstructionForm() {
  const get = (id) => document.getElementById(id)?.value?.trim() || null;
  return {
    full_address:    get('instr_full_address'),
    checkin_from:    get('instr_checkin_from') || '14:00',
    checkout_until:  get('instr_checkout_until') || '12:00',
    wifi_ssid:       get('instr_wifi_ssid'),
    wifi_password:   get('instr_wifi_password'),
    smoking_policy:  get('instr_smoking_policy'),
    pets_policy:     get('instr_pets_policy'),
    quiet_hours:     get('instr_quiet_hours'),
    other_rules:     get('instr_other_rules'),
    ai_instructions: get('instr_ai_instructions'),
  };
}

function ensureInstructionsModal() {
  if (document.getElementById('guestInstructionsModal')) return;
  const html = `
    <div class="modal-backdrop" id="guestInstructionsModal" aria-hidden="true">
      <div class="modal" style="width:min(720px,100%);max-height:92dvh;overflow:auto;">
        <div class="section-head">
          <div>
            <h2 class="modal-title">Инструкции для гостей</h2>
            <p class="muted">Что бот говорит гостю. Поля можно менять в любой момент — изменения подхватятся при следующем сообщении гостя.</p>
          </div>
          <button class="menu-toggle" id="closeInstructionsModal" type="button" aria-label="Закрыть">✕</button>
        </div>

        <label><span class="small">Квартира</span>
          <select id="instrApartmentSelect" style="margin-top:.4rem;"></select>
        </label>

        <h3 class="instr-h">📍 Адрес</h3>
        <label><span class="small">Полный адрес</span><input data-instr-field id="instr_full_address" type="text" placeholder="Москва, ул. Маршала Тимошенко 9, кв 12, подъезд 2, этаж 5" /></label>

        <h3 class="instr-h">⏰ Время заезда / выезда</h3>
        <div class="instr-grid-2">
          <label><span class="small">Заезд с</span><input data-instr-field id="instr_checkin_from" type="text" placeholder="14:00" /></label>
          <label><span class="small">Выезд до</span><input data-instr-field id="instr_checkout_until" type="text" placeholder="12:00" /></label>
        </div>

        <h3 class="instr-h">📶 Wi-Fi</h3>
        <div class="instr-grid-2">
          <label><span class="small">Имя сети</span><input data-instr-field id="instr_wifi_ssid" type="text" placeholder="GreenYard_5G" /></label>
          <label><span class="small">Пароль</span><input data-instr-field id="instr_wifi_password" type="text" placeholder="welcome2024" /></label>
        </div>

        <h3 class="instr-h">📋 Правила проживания</h3>
        <div class="instr-grid-2">
          <label><span class="small">Курение</span><input data-instr-field id="instr_smoking_policy" type="text" placeholder="запрещено / только на балконе / разрешено" /></label>
          <label><span class="small">Животные</span><input data-instr-field id="instr_pets_policy" type="text" placeholder="можно / нельзя" /></label>
        </div>
        <label><span class="small">Часы тишины</span><input data-instr-field id="instr_quiet_hours" type="text" placeholder="С 23:00 до 8:00 — тишина" /></label>
        <label><span class="small">Другие правила</span><textarea data-instr-field id="instr_other_rules" rows="2"></textarea></label>

        <h3 class="instr-h">🤖 Инструкция для AI-бота</h3>
        <p class="muted small" style="margin:-.2rem 0 .4rem;">Свободный текст: любые правила, особенности, лайфхаки, ответы на частые вопросы именно по этой квартире. Бот будет отвечать гостю на основе <b>только</b> этого текста и полей выше. Если чего-то нет — предложит связаться с менеджером и не будет ничего выдумывать. Если поле пустое — AI-режим для этой квартиры выключен.</p>
        <label><textarea data-instr-field id="instr_ai_instructions" rows="8" placeholder="Пример:&#10;— Стиральная машина Bosch, инструкция в ящике под мойкой. Порошок в шкафчике над машиной.&#10;— Ближайшая аптека — на первом этаже дома напротив, работает круглосуточно.&#10;— Мусоропровод в подъезде на площадке между этажами.&#10;— Батарею в спальне можно регулировать вентилем справа."></textarea></label>

        <div id="instrSaveMsg" class="small" style="margin-top:.5rem;" hidden></div>
        <div class="actions" style="justify-content:flex-end;gap:.5rem;margin-top:1rem;">
          <button class="btn btn-primary" id="instrSaveBtn" type="button">Сохранить</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8) Раздел «Чаты с гостями»
// ─────────────────────────────────────────────────────────────────────────────

let _chatsState = {
  items: [],
  activeSessionId: null,
  realtimeChannel: null,
  pollTimer: null,
  // Кеш последней отрисованной разметки — чтобы фоновые обновления не трогали DOM впустую.
  lastThreadSession: null,
  lastThreadHtml: '',
  lastHeadHtml: '',
};

export async function openChatsModal() {
  ensureChatsModal();
  // Сбрасываем активный чат при каждом открытии — начинаем со списка
  _chatsState.activeSessionId = null;
  _chatsState.items = [];
  _chatsState.lastThreadSession = null;
  _chatsState.lastThreadHtml = '';
  _chatsState.lastHeadHtml = '';
  openModal('guestChatsModal');
  await reloadChats();
  // После успешной загрузки — запускаем polling и realtime
  startChatsPolling();
  attachVisibilityRefresh();
  try { await attachRealtimeForChats(); } catch (e) { console.warn('[bot] realtime attach failed:', e); }
}

// Когда пользователь возвращается во вкладку (напр. переключившись из телеграма) — сразу перечитываем
let _lastRefetchAt = 0;
// «Страница уходила в фон, после возврата ещё не обновлялись».
let _needsResumeRefetch = false;
async function refetchAllOnResume(source, { force = false } = {}) {
  const modal = document.getElementById('guestChatsModal');
  if (!modal || !modal.classList.contains('open')) return;
  // Дебаунс: не чаще раза в секунду
  const now = Date.now();
  if (!force && now - _lastRefetchAt < 1000) return;
  _lastRefetchAt = now;
  _needsResumeRefetch = false;
  console.log(`[bot] resume from ${source} — hard refetch`);
  // Показываем в UI что обновляемся
  const badge = document.getElementById('chatsRefreshBadge');
  if (badge) { badge.textContent = `♻ (${source})`; badge.style.opacity = '1'; }
  // Пересоздаём realtime (WebSocket мог закрыться в фоне)
  try { detachRealtimeForChats(); } catch {}
  try { await attachRealtimeForChats(); } catch (e) { console.warn('[bot] realtime re-attach:', e); }
  // Перечитываем данные
  try {
    const chats = await fetchGuestChats();
    _chatsState.items = chats;
    renderChatsList();
    if (_chatsState.activeSessionId) await renderActiveChat({ silent: true });
    if (badge) { badge.textContent = '✓'; setTimeout(() => { badge.style.opacity = '0'; }, 800); }
  } catch (err) {
    console.warn(`[bot] ${source} refetch:`, err?.message || err);
    if (badge) { badge.textContent = `⚠ ${err?.message || 'err'}`; }
  }
}

function attachVisibilityRefresh() {
  if (window._botVisibilityAttached) return;
  window._botVisibilityAttached = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') { _needsResumeRefetch = true; return; }
    refetchAllOnResume('vis');
  });
  window.addEventListener('focus', () => refetchAllOnResume('focus'));
  window.addEventListener('pageshow', () => refetchAllOnResume('pageshow'));
  window.addEventListener('blur', () => { _needsResumeRefetch = true; });
  // Подстраховка для iOS: там visibilitychange/focus иногда не срабатывают, поэтому первое
  // касание после возврата добирает данные. Проверка _needsResumeRefetch КРИТИЧНА:
  // без неё обработчик стрелял на КАЖДОМ свайпе/нажатии — рвал WebSocket, делал два
  // сетевых запроса и пересобирал всю разметку чата. Именно отсюда лаги при пролистывании.
  const onMaybeResume = () => { if (_needsResumeRefetch) refetchAllOnResume('touch'); };
  document.addEventListener('touchstart', onMaybeResume, { passive: true });
  document.addEventListener('pointerdown', onMaybeResume, { passive: true });
}

// Polling как fallback: каждые 2 секунды.
function startChatsPolling() {
  if (_chatsState.pollTimer) return;
  console.log('[bot] chats polling started (every 2s)');
  _chatsState.pollTimer = setInterval(async () => {
    // Не полим если модалка закрыта
    const modal = document.getElementById('guestChatsModal');
    if (!modal || !modal.classList.contains('open')) return;
    let chats;
    try {
      chats = await fetchGuestChats();
    } catch (err) {
      console.warn('[bot] polling fetchGuestChats:', err?.message || err);
      return; // при ошибке не трогаем UI
    }
    try {
      const prevItems = _chatsState.items;
      const sig = chats.map(c => `${c.session_id}:${c.last_message_at || ''}:${c.ai_enabled}`).join('|');
      const prevSig = prevItems.map(c => `${c.session_id}:${c.last_message_at || ''}:${c.ai_enabled}`).join('|');
      const listChanged = sig !== prevSig;
      if (listChanged) {
        _chatsState.items = chats;
        renderChatsList();
      }
      // Если открыт конкретный чат и в нём появились новые сообщения — перечитываем
      if (_chatsState.activeSessionId) {
        const activeMeta = chats.find(c => c.session_id === _chatsState.activeSessionId);
        const prevActive = prevItems.find(c => c.session_id === _chatsState.activeSessionId);
        const activeChanged = !prevActive || (activeMeta?.last_message_at !== prevActive?.last_message_at);
        if (activeChanged) {
          console.log('[bot] polling: active chat changed — refetch');
          // тихо: без заглушки и без прыжка вниз, если пользователь читает выше
          await renderActiveChat({ silent: true });
        }
      }
    } catch (err) {
      console.warn('[bot] polling render:', err?.message || err);
    }
  }, 2000);
}

function stopChatsPolling() {
  if (_chatsState.pollTimer) {
    clearInterval(_chatsState.pollTimer);
    _chatsState.pollTimer = null;
  }
}

async function reloadChats() {
  const list = document.getElementById('chatsListBox');
  if (list) list.innerHTML = '<div class="small" style="padding:1rem;opacity:.6;">Загрузка...</div>';
  try {
    const chats = await fetchGuestChats();
    _chatsState.items = chats;
  } catch (err) {
    console.warn('[bot] reloadChats failed:', err?.message || err);
    if (list) list.innerHTML = `<div class="empty" style="padding:2rem;text-align:center;opacity:.6;color:#c66;">Не удалось загрузить чаты: ${esc(err?.message || 'ошибка сети')}</div>`;
    return;
  }
  renderChatsList();
  updateChatsGridMode();
  if (_chatsState.activeSessionId) await renderActiveChat();
}

// Переключаем CSS-классы: виден список или чат
function updateChatsGridMode() {
  const grid = document.querySelector('#guestChatsModal .chats-grid');
  if (!grid) return;
  if (_chatsState.activeSessionId) {
    grid.classList.add('has-active');
    grid.classList.remove('no-active');
  } else {
    grid.classList.add('no-active');
    grid.classList.remove('has-active');
  }
}

function renderChatsList() {
  const list = document.getElementById('chatsListBox');
  if (!list) return;
  if (!_chatsState.items.length) {
    list.innerHTML = `<div class="empty" style="padding:2rem;text-align:center;opacity:.6;">Чатов с гостями пока нет.<br/><br/>Когда гость нажмёт ссылку приглашения в Telegram и напишет боту — чат появится здесь.</div>`;
    return;
  }
  list.innerHTML = _chatsState.items.map(c => {
    const name = c.tg_first_name
      ? `${esc(c.tg_first_name)}${c.tg_last_name ? ' ' + esc(c.tg_last_name) : ''}`
      : (c.client_fio ? esc(c.client_fio) : 'Гость');
    const apt = esc(c.apartment_title || `realty_id=${c.realty_id}`);
    const dates = c.begin_date ? `${fmtDateShort(c.begin_date)} → ${fmtDateShort(c.end_date)}` : '';
    const last = c.last_message_at ? fmtTime(c.last_message_at) : (c.started_at ? fmtTime(c.started_at) : '');
    const badge = c.unread_count > 0 ? `<span class="chat-unread">${c.unread_count}</span>` : '';
    const active = c.session_id === _chatsState.activeSessionId ? 'is-active' : '';
    return `
      <button class="chat-row ${active}" data-chat-session="${esc(c.session_id)}" type="button">
        <div class="chat-row-top">
          <div class="chat-row-name">${name}</div>
          <div class="chat-row-time small">${esc(last)}</div>
        </div>
        <div class="chat-row-bottom">
          <div class="small chat-row-apt">${apt} · ${esc(dates)}</div>
          ${badge}
        </div>
      </button>
    `;
  }).join('');
}

/**
 * Рисует активный чат.
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.silent=false] Фоновое обновление (polling / realtime / возврат во вкладку).
 *   В этом режиме НЕ мигаем заглушкой «Загружаем…», не трогаем DOM если разметка
 *   не изменилась и сохраняем позицию прокрутки, если пользователь читает историю выше.
 *   Иначе любое фоновое обновление швыряет вид вниз и чат невозможно пролистать.
 */
async function renderActiveChat({ silent = false } = {}) {
  const box = document.getElementById('chatThreadBox');
  const head = document.getElementById('chatThreadHead');
  const composer = document.getElementById('chatComposer');
  if (!box) return;
  const sessionId = _chatsState.activeSessionId;
  if (!sessionId) {
    box.innerHTML = `<div class="empty" style="padding:2rem;text-align:center;opacity:.6;">Выберите чат слева</div>`;
    if (head) head.innerHTML = '';
    if (composer) composer.style.display = 'none';
    _chatsState.lastThreadSession = null;
    _chatsState.lastThreadHtml = '';
    _chatsState.lastHeadHtml = '';
    return;
  }
  // Смена чата — всегда полный рендер с промоткой вниз, даже если вызвали тихо.
  const sessionChanged = _chatsState.lastThreadSession !== sessionId;
  if (sessionChanged) silent = false;

  const meta = _chatsState.items.find(c => c.session_id === sessionId);
  if (head && meta) {
    const name = meta.tg_first_name
      ? `${esc(meta.tg_first_name)}${meta.tg_last_name ? ' ' + esc(meta.tg_last_name) : ''}`
      : (meta.client_fio ? esc(meta.client_fio) : 'Гость');
    const aiOn = meta.ai_enabled !== false;
    const headHtml = `
      <div style="display:flex;justify-content:space-between;align-items:center;gap:.75rem;flex-wrap:wrap;">
        <div style="display:flex;align-items:center;gap:.5rem;min-width:0;">
          <button type="button" id="chatBackBtn" title="К списку чатов" style="padding:.35rem .6rem;border-radius:8px;border:1px solid #555;background:transparent;color:#ddd;cursor:pointer;font-size:.9rem;">← К списку</button>
          <button type="button" id="chatRefreshBtn" title="Обновить" style="padding:.35rem .5rem;border-radius:8px;border:1px solid #555;background:transparent;color:#ddd;cursor:pointer;font-size:.9rem;">↻</button>
          <div style="min-width:0;">
            <div><b>${name}</b> · ${esc(meta.apartment_title || '')}</div>
            <div class="small" style="opacity:.7;">${esc(meta.begin_date ? fmtDate(meta.begin_date) + ' → ' + fmtDate(meta.end_date) : '')}</div>
          </div>
        </div>
        <button type="button" id="chatAiToggle" data-ai-on="${aiOn ? '1' : '0'}" title="Когда выкл — бот не отвечает гостю сам, вы отвечаете вручную." style="display:inline-flex;align-items:center;gap:.5rem;padding:.4rem .8rem;border-radius:999px;border:1px solid ${aiOn ? '#4ea881' : '#666'};background:${aiOn ? 'rgba(78,168,129,.15)' : 'rgba(120,120,120,.15)'};color:${aiOn ? '#4ea881' : '#aaa'};font-weight:600;font-size:.85rem;cursor:pointer;white-space:nowrap;">
          <span style="display:inline-block;width:12px;height:12px;border-radius:50%;background:${aiOn ? '#4ea881' : '#888'};"></span>
          🤖 AI-бот ${aiOn ? 'ВКЛ' : 'ВЫКЛ'}
        </button>
      </div>
    `;
    // Не пересобираем шапку, если она не изменилась — лишний reflow на каждом обновлении.
    if (headHtml !== _chatsState.lastHeadHtml) {
      head.innerHTML = headHtml;
      _chatsState.lastHeadHtml = headHtml;
    }
  }
  if (composer) composer.style.display = 'flex';

  if (!silent) {
    box.innerHTML = `<div class="empty" style="padding:2rem;text-align:center;opacity:.6;">Загружаем сообщения…</div>`;
  }
  let msgs = [];
  try {
    msgs = await fetchMessages(sessionId);
  } catch (err) {
    console.warn('[bot] renderActiveChat fetch failed:', err?.message || err);
    // При фоновом обновлении не стираем уже прочитанные сообщения из-за обрыва сети.
    if (!silent) {
      box.innerHTML = `<div class="empty" style="padding:2rem;text-align:center;opacity:.6;color:#c66;">Ошибка загрузки: ${esc(err?.message || 'сеть')}</div>`;
    }
    return;
  }
  const html = msgs.map(m => {
    const cls = m.direction === 'inbound' ? 'msg-inbound'
              : m.direction === 'manager' ? 'msg-manager'
              : m.direction === 'system'  ? 'msg-system'
              : 'msg-bot';
    const label = m.direction === 'inbound' ? 'Гость'
                : m.direction === 'manager' ? '👤 Вы'
                : m.direction === 'system'  ? 'Событие'
                : '🤖 Бот';
    const time = fmtTime(m.created_at);
    return `<div class="chat-msg ${cls}"><div class="chat-msg-meta small">${esc(label)} · ${esc(time)}</div><div class="chat-msg-body">${fmtBody(m.body || '')}</div></div>`;
  }).join('');
  const nextHtml = html || `<div class="empty" style="padding:2rem;text-align:center;opacity:.6;">Сообщений пока нет (получено 0 строк).<br/>session_id: <code>${esc(sessionId)}</code></div>`;

  // Фоновое обновление без изменений — выходим без единого касания DOM.
  if (silent && nextHtml === _chatsState.lastThreadHtml) return;

  // Запоминаем, где был пользователь: если он читал историю выше — не дёргаем вниз.
  const prevTop = box.scrollTop;
  const wasNearBottom = box.scrollHeight - prevTop - box.clientHeight < 80;

  box.innerHTML = nextHtml;
  _chatsState.lastThreadHtml = nextHtml;
  _chatsState.lastThreadSession = sessionId;

  // прокручиваем вниз (в двух микротасках, чтобы дождаться layout)
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (!silent || wasNearBottom) box.scrollTop = box.scrollHeight;
      else box.scrollTop = prevTop; // восстанавливаем позицию чтения
    });
  });

  // Отмечаем прочитанным только когда есть что отмечать — иначе лишний UPDATE к базе.
  const rowUnread = document.querySelector(`[data-chat-session="${sessionId}"] .chat-unread`);
  if (rowUnread || !silent) {
    await markChatAsRead(sessionId);
    if (rowUnread) rowUnread.remove();
  }
}

async function attachRealtimeForChats() {
  const supabase = getSupabaseClient();
  if (!supabase) return;

  // Убираем старый канал если есть (при повторном открытии модалки).
  if (_chatsState.realtimeChannel) {
    try { await supabase.removeChannel(_chatsState.realtimeChannel); } catch {}
    _chatsState.realtimeChannel = null;
  }

  // Прокидываем текущий JWT в realtime — иначе RLS-таблицы не видны.
  try {
    const { data } = await supabase.auth.getSession();
    const token = data?.session?.access_token;
    if (token && supabase.realtime?.setAuth) {
      supabase.realtime.setAuth(token);
    }
  } catch (e) {
    console.warn('[bot] realtime setAuth:', e?.message || e);
  }

  try {
    const channel = supabase.channel('guest_msgs_' + Date.now());
    channel
      .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'guest_messages' },
        async (payload) => {
          console.log('[bot] realtime INSERT guest_messages:', payload?.new);
          try {
            const newSessionId = payload?.new?.session_id;
            const chats = await fetchGuestChats();
            _chatsState.items = chats;
            renderChatsList();
            if (newSessionId && newSessionId === _chatsState.activeSessionId) {
              await renderActiveChat({ silent: true });
            }
          } catch (err) {
            console.warn('[bot] realtime handler:', err?.message || err);
          }
        }
      )
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'guest_sessions' },
        async () => {
          try {
            const chats = await fetchGuestChats();
            _chatsState.items = chats;
            renderChatsList();
          } catch (err) {
            console.warn('[bot] realtime session handler:', err?.message || err);
          }
        }
      )
      .subscribe((status, err) => {
        console.log('[bot] realtime subscribe status:', status, err?.message || '');
      });
    _chatsState.realtimeChannel = channel;
  } catch (e) {
    console.warn('[bot] realtime:', e?.message || e);
  }
}

export function detachRealtimeForChats() {
  const supabase = getSupabaseClient();
  if (supabase && _chatsState.realtimeChannel) {
    try { supabase.removeChannel(_chatsState.realtimeChannel); } catch {}
    _chatsState.realtimeChannel = null;
  }
  stopChatsPolling();
}

function ensureChatsModal() {
  if (document.getElementById('guestChatsModal')) return;
  const html = `
    <div class="modal-backdrop" id="guestChatsModal" aria-hidden="true">
      <div class="modal chat-modal" style="width:min(1000px,100%);display:flex;flex-direction:column;padding:1rem;">
        <div class="section-head" style="margin-bottom:.5rem;">
          <div>
            <h2 class="modal-title">Чаты с гостями <span id="chatsRefreshBadge" style="font-size:.7rem;font-weight:400;opacity:0;transition:opacity .3s;margin-left:.5rem;color:#7fbf7f;"></span></h2>
            <p class="muted" style="margin:0;">Сообщения от гостей через Telegram-бота. Вы пишете — гость видит сообщение от имени бота.</p>
          </div>
          <button class="menu-toggle" id="closeChatsModal" type="button" aria-label="Закрыть">✕</button>
        </div>
        <div class="chats-grid">
          <aside class="chats-side">
            <div id="chatsListBox"></div>
          </aside>
          <section class="chats-main">
            <div id="chatThreadHead" class="chats-head"></div>
            <div id="chatThreadBox" class="chats-thread"></div>
            <div id="chatComposer" class="chats-composer" style="display:none;">
              <textarea id="chatInput" rows="2" placeholder="Ваше сообщение от имени бота..."></textarea>
              <button class="btn btn-primary" id="chatSendBtn" type="button">Отправить</button>
            </div>
          </section>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

// ─────────────────────────────────────────────────────────────────────────────
// 9) Раздел «Настройки уведомлений»
// ─────────────────────────────────────────────────────────────────────────────

// Список мессенджеров для выпадающих списков в модалке настроек (кэшируется при открытии).
let _notifyChannels = [{ id: 'telegram', title: 'Telegram' }];

/** HTML <option>ов мессенджеров с выбранным значением. */
function channelOptionsHtml(selected) {
  const list = (_notifyChannels && _notifyChannels.length) ? _notifyChannels : [{ id: 'telegram', title: 'Telegram' }];
  const cur = selected || 'telegram';
  const rows = [...list];
  if (!rows.some(c => c.id === cur)) rows.push({ id: cur, title: CHANNEL_TITLE[cur] || cur });
  return rows.map(c => `<option value="${c.id}"${c.id === cur ? ' selected' : ''}>${c.title || CHANNEL_TITLE[c.id] || c.id}</option>`).join('');
}

/** Добавить строку получателя уведомлений (мессенджер + chat_id). */
function addRecipientRow(channelId, chatId) {
  const box = document.getElementById('ns_recipients');
  if (!box) return;
  const idVal = chatId != null ? String(chatId).replace(/"/g, '&quot;') : '';
  const row = document.createElement('div');
  row.className = 'ns-rcpt-row';
  row.style.cssText = 'display:flex;gap:.5rem;align-items:flex-end;margin-bottom:.5rem;flex-wrap:wrap;';
  row.innerHTML = `
    <label style="flex:0 0 120px;"><span class="small">Мессенджер</span>
      <select class="ns-rcpt-channel">${channelOptionsHtml(channelId)}</select>
    </label>
    <label style="flex:1 1 150px;"><span class="small">chat_id / номер</span>
      <input class="ns-rcpt-chat" type="text" placeholder="561644215" value="${idVal}" />
    </label>
    <button class="btn btn-secondary ns-rcpt-del" type="button" title="Удалить" style="flex:0 0 auto;">✕</button>`;
  box.appendChild(row);
}

/** Собрать получателей из формы (пустые chat_id пропускаем, дубли убираем). */
function collectRecipients() {
  const rows = [...document.querySelectorAll('#ns_recipients .ns-rcpt-row')];
  const out = [];
  const seen = new Set();
  for (const r of rows) {
    const channel = r.querySelector('.ns-rcpt-channel')?.value || 'telegram';
    const chat_id = (r.querySelector('.ns-rcpt-chat')?.value || '').trim();
    if (!chat_id) continue;
    const key = `${channel}:${chat_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ channel, chat_id });
  }
  return out;
}

/** Собрать патч настроек из модалки. Легаси-поля синхроним с первым получателем. */
function buildManagerSettingsPatch() {
  const recipients = collectRecipients();
  const first = recipients[0] || null;
  const tgId = first && first.channel === 'telegram' && /^\d+$/.test(first.chat_id) ? Number(first.chat_id) : null;
  return {
    manager_recipients: recipients,
    // Обратная совместимость: старые одиночные поля = первый получатель.
    manager_channel: first?.channel || 'telegram',
    manager_channel_chat_id: first?.chat_id || null,
    manager_tg_chat_id: tgId,
    guest_default_channel: document.getElementById('ns_guest_channel')?.value || 'telegram',
    guest_channel_url: document.getElementById('ns_channel_url')?.value.trim() || null,
    guest_invite_template: document.getElementById('ns_template')?.value || null,
    notify_on_inbound: document.getElementById('ns_notify_inbound')?.checked,
    notify_on_checkin: document.getElementById('ns_notify_checkin')?.checked,
    notify_on_checkout: document.getElementById('ns_notify_checkout')?.checked,
    notify_on_complaint: document.getElementById('ns_notify_complaint')?.checked,
  };
}

export async function openNotifySettingsModal() {
  ensureNotifySettingsModal();
  openModal('notifySettingsModal');
  const s = await fetchManagerSettings() || {};
  // Список мессенджеров — для выпадающих списков строк-получателей.
  try { _notifyChannels = await fetchChannels(); } catch { _notifyChannels = [{ id: 'telegram', title: 'Telegram' }]; }
  await fillChannelOptions(document.getElementById('ns_guest_channel'), s.guest_default_channel || 'telegram');

  // Получатели уведомлений: берём manager_recipients, иначе — легаси-поля (один адресат).
  let recips = Array.isArray(s.manager_recipients) ? s.manager_recipients.filter(r => r && r.chat_id) : [];
  if (recips.length === 0) {
    const ch = s.manager_channel || 'telegram';
    const id = s.manager_channel_chat_id ?? (ch === 'telegram' && s.manager_tg_chat_id != null ? String(s.manager_tg_chat_id) : '');
    if (id) recips = [{ channel: ch, chat_id: String(id) }];
  }
  const box = document.getElementById('ns_recipients');
  if (box) {
    box.innerHTML = '';
    if (recips.length === 0) addRecipientRow('telegram', '');
    else recips.forEach(r => addRecipientRow(r.channel, r.chat_id));
  }

  const chList = _notifyChannels;
  const hint = document.getElementById('ns_channels_hint');
  if (hint) {
    hint.textContent = chList.length > 1
      ? `Настроены: ${chList.map(c => c.title).join(', ')}.`
      : 'Пока работает только Telegram. Остальные мессенджеры включатся, когда на сервер добавят их токены.';
  }
  setFieldVal('ns_channel_url', s.guest_channel_url ?? 'https://t.me/Green_yard_apart');
  setFieldVal('ns_template', s.guest_invite_template || DEFAULT_INVITE_TEMPLATE);
  document.getElementById('ns_notify_inbound').checked   = s.notify_on_inbound   !== false;
  document.getElementById('ns_notify_checkin').checked   = s.notify_on_checkin   !== false;
  document.getElementById('ns_notify_checkout').checked  = s.notify_on_checkout  !== false;
  document.getElementById('ns_notify_complaint').checked = s.notify_on_complaint !== false;
}

function ensureNotifySettingsModal() {
  if (document.getElementById('notifySettingsModal')) return;
  const html = `
    <div class="modal-backdrop" id="notifySettingsModal" aria-hidden="true">
      <div class="modal" style="width:min(640px,100%);max-height:92dvh;overflow:auto;">
        <div class="section-head">
          <div>
            <h2 class="modal-title">Настройки бота</h2>
            <p class="muted">Куда бот будет вам писать, что присылать и как звучит приглашение гостю.</p>
          </div>
          <button class="menu-toggle" id="closeNotifyModal" type="button" aria-label="Закрыть">✕</button>
        </div>

        <h3 class="instr-h">📣 Уведомления менеджеру</h3>
        <p class="small" style="opacity:.7;margin:.25rem 0 .5rem;">Бот пишет всем получателям сразу. Можно добавить несколько мессенджеров или аккаунтов. chat_id узнайте у бота командой <code>/id</code>.</p>
        <div id="ns_recipients"></div>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin:.5rem 0;">
          <button class="btn btn-secondary" id="ns_add_recipient" type="button">+ Добавить получателя</button>
          <button class="btn btn-secondary" id="ns_test_btn" type="button">Отправить тестовое сообщение</button>
        </div>
        <label class="check"><input type="checkbox" id="ns_notify_inbound" /> Новое сообщение от гостя</label>
        <label class="check"><input type="checkbox" id="ns_notify_checkin" /> Гость нажал «Я приехал»</label>
        <label class="check"><input type="checkbox" id="ns_notify_checkout" /> Гость нажал «Я уезжаю»</label>
        <label class="check"><input type="checkbox" id="ns_notify_complaint" /> Жалоба от гостя</label>

        <h3 class="instr-h">💬 Мессенджер для гостей</h3>
        <label><span class="small">В каком мессенджере приглашать гостей по умолчанию</span>
          <select id="ns_guest_channel"><option value="telegram">Telegram</option></select>
        </label>
        <p class="small" id="ns_channels_hint" style="opacity:.7;margin:.25rem 0 .5rem;"></p>

        <h3 class="instr-h">📢 Канал для гостей</h3>
        <label><span class="small">Ссылка на Telegram-канал</span>
          <input id="ns_channel_url" type="text" placeholder="https://t.me/Green_yard_apart" />
        </label>

        <h3 class="instr-h">✉️ Шаблон приглашения гостю</h3>
        <p class="small" style="opacity:.7;margin:.25rem 0 .5rem;">
          Доступные переменные: <code>{name}</code>, <code>{address}</code>, <code>{dates}</code>, <code>{nights}</code>, <code>{amount}</code>, <code>{link}</code>
        </p>
        <textarea id="ns_template" rows="10" style="font-family:inherit;"></textarea>

        <div id="nsSaveMsg" class="small" style="margin-top:.5rem;" hidden></div>
        <div class="actions" style="justify-content:flex-end;gap:.5rem;margin-top:1rem;">
          <button class="btn btn-primary" id="nsSaveBtn" type="button">Сохранить</button>
        </div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

// ─────────────────────────────────────────────────────────────────────────────
// 10) Действие: скопировать ссылку гостю
// ─────────────────────────────────────────────────────────────────────────────

// Собираем текст приглашения (все сетевые вызовы внутри).
async function buildInviteText(booking, state, channelOverride) {
  const session = await ensureSessionForBooking(booking);
  const settings = await fetchManagerSettings() || {};
  const tpl = settings.guest_invite_template || DEFAULT_INVITE_TEMPLATE;
  // Канал: явный выбор гостя (кнопка) имеет приоритет над умолчанием из настроек.
  const channel = channelOverride || settings.guest_default_channel || 'telegram';

  // Ссылку строит сервер — только он знает имя бота MAX и номер WhatsApp.
  let link;
  try {
    link = await fetchGuestInvite(session.id, channel);
  } catch (e) {
    if (channel !== 'telegram') throw new Error(
      `Не удалось собрать ссылку для ${CHANNEL_TITLE[channel] || channel}: ${e?.message || e}`);
    // Запасной вариант для Telegram — собираем локально.
    const botUsername = window.__GUEST_BOT_USERNAME__ || TELEGRAM_BOT_USERNAME_DEFAULT;
    link = buildGuestLink(session.secure_id, botUsername);
  }

  const apts = state?.apartments || [];
  const apt = apts.find(a => String(a.externalIds?.realtyCalendarUnitId || '') === String(booking.realty_id || ''));
  let address = booking.apartment_title || '';
  if (apt) {
    const instr = await fetchInstructionFor(apt.id);
    if (instr?.full_address) address = instr.full_address;
  }

  const text = renderInviteText(tpl, {
    name:    booking.client_fio || 'гость',
    address: address,
    dates:   `${fmtDate(booking.begin_date)} — ${fmtDate(booking.end_date)}`,
    nights:  nightsBetween(booking.begin_date, booking.end_date),
    amount:  Number(booking.amount || 0).toLocaleString('ru-RU'),
    link,
  });
  return { text, link };
}

/**
 * Копирует в буфер приглашение для гостя.
 * ВАЖНО: вызывать СИНХРОННО из обработчика клика — без await до вызова.
 * На iOS Safari clipboard.writeText после await из user-gesture молча блокируется,
 * поэтому используем ClipboardItem с Promise (Safari 13.4+) — это единственный способ
 * «продлить» user-gesture через сетевые вызовы.
 *
 * Возвращает { ok: true, text, link } если удалось положить в буфер.
 * Бросает исключение если оба способа не сработали (тогда UI должен показать fallback).
 */
export function copyGuestInviteToClipboard(booking, state, channelOverride) {
  // Готовим Promise<Blob> заранее, ДО await — это ключ к работе на iOS.
  const dataPromise = buildInviteText(booking, state, channelOverride);
  const blobPromise = dataPromise.then(({ text }) =>
    new Blob([text], { type: 'text/plain' })
  );

  // Путь A: async clipboard API с ClipboardItem (Safari/Chrome/Edge)
  const hasAsyncClipboard =
    typeof ClipboardItem !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.write === 'function';

  if (hasAsyncClipboard) {
    const item = new ClipboardItem({ 'text/plain': blobPromise });
    return navigator.clipboard.write([item])
      .then(async () => {
        const { text, link } = await dataPromise;
        return { ok: true, text, link };
      })
      .catch(async (errWrite) => {
        // Fallback: writeText (десктоп Chrome, Android)
        try {
          const { text, link } = await dataPromise;
          await navigator.clipboard.writeText(text);
          return { ok: true, text, link };
        } catch (errText) {
          // Последний шанс: execCommand + textarea
          const { text, link } = await dataPromise;
          const ok = legacyCopy(text);
          if (ok) return { ok: true, text, link };
          const e = new Error('Не удалось скопировать. Скопируйте текст вручную.');
          e.text = text; e.link = link;
          throw e;
        }
      });
  }

  // Путь B: нет ClipboardItem — сразу writeText / execCommand
  return dataPromise.then(async ({ text, link }) => {
    try {
      await navigator.clipboard.writeText(text);
      return { ok: true, text, link };
    } catch {
      const ok = legacyCopy(text);
      if (ok) return { ok: true, text, link };
      const e = new Error('Не удалось скопировать. Скопируйте текст вручную.');
      e.text = text; e.link = link;
      throw e;
    }
  });
}

// Legacy fallback через скрытый textarea + execCommand.
function legacyCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    // iOS: нужно именно так, чтобы поле стало selectable
    ta.contentEditable = 'true';
    const range = document.createRange();
    range.selectNodeContents(ta);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    ta.setSelectionRange(0, ta.value.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return !!ok;
  } catch {
    return false;
  }
}

// Модалка с текстом для ручного копирования (когда буфер обмена недоступен).
export function showManualCopyModal(text) {
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:10000;display:flex;align-items:center;justify-content:center;padding:1rem;';
  wrap.innerHTML = `
    <div class="modal" style="background:#1a1a1a;border-radius:12px;padding:1.25rem;max-width:520px;width:100%;max-height:80vh;display:flex;flex-direction:column;gap:.75rem;">
      <h3 style="margin:0;font-size:1.05rem;">Скопируйте текст вручную</h3>
      <p class="small" style="margin:0;opacity:.75;">Браузер заблокировал автокопирование. Выделите текст и скопируйте.</p>
      <textarea readonly style="flex:1;min-height:220px;width:100%;padding:.75rem;border-radius:8px;background:#111;color:#eee;border:1px solid #333;font-family:inherit;font-size:.9rem;"></textarea>
      <div style="display:flex;gap:.5rem;justify-content:flex-end;">
        <button class="btn btn-secondary" data-select-all>Выделить всё</button>
        <button class="btn btn-primary" data-close>Закрыть</button>
      </div>
    </div>
  `;
  const ta = wrap.querySelector('textarea');
  ta.value = text;
  wrap.querySelector('[data-select-all]').addEventListener('click', () => {
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
  });
  wrap.querySelector('[data-close]').addEventListener('click', () => wrap.remove());
  wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
  document.body.appendChild(wrap);
  // Автоматически выделяем текст
  setTimeout(() => { ta.focus(); ta.setSelectionRange(0, ta.value.length); }, 50);
}

// ─────────────────────────────────────────────────────────────────────────────
// 11) Тестовое сообщение менеджеру
// ─────────────────────────────────────────────────────────────────────────────

export async function sendTestNotificationToManager() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase не подключён');
  const sess = await supabase.auth.getSession();
  const accessToken = sess?.data?.session?.access_token || '';
  if (!accessToken) throw new Error('Войдите в аккаунт');
  const r = await fetch(`${BOT_FUNCTION_URL}/test`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ kind: 'manager_test' }),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    throw new Error(`Бот ещё не задеплоен или Telegram отклонил запрос. ${t}`);
  }
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// 12) Экспорт: общий init + хелперы для events.js
// ─────────────────────────────────────────────────────────────────────────────

export function bindGuestBotEvents(state) {
  // Drawer-кнопки. Если их нет — создаём.
  ensureDrawerItems();

  // — Брони
  document.getElementById('openBookingsSection')?.addEventListener('click', async () => {
    document.getElementById('drawerMenu')?.classList.remove('open');
    document.getElementById('drawerBackdrop')?.classList.remove('open');
    await openBookingsModal(state);
  });
  document.body.addEventListener('click', async (e) => {
    const closeBk = e.target.closest('#closeBookingsModal');
    if (closeBk) { closeModal('bookingsModal'); return; }

    const reload = e.target.closest('#bookingsReloadBtn');
    if (reload) { await reloadBookings(state); return; }

    // ─── Ручная бронь ───
    if (e.target.closest('#openManualBookingBtn')) { openManualBookingModal(state); return; }
    if (e.target.closest('#closeManualBooking') || e.target.closest('#cancelManualBooking')) { closeModal('manualBookingModal'); return; }
    if (e.target === document.getElementById('manualBookingModal')) { closeModal('manualBookingModal'); return; }
    if (e.target.closest('#saveManualBooking')) { await submitManualBooking(state); return; }

    const saveCancelBtn = e.target.closest('[data-save-cancel-reason]');
    if (saveCancelBtn) {
      const bid = saveCancelBtn.getAttribute('data-save-cancel-reason');
      const textarea = document.querySelector(`textarea[data-cancel-reason="${bid}"]`);
      const reason = (textarea?.value || '').trim();
      const supabase = getSupabaseClient();
      if (!supabase) return;
      try {
        // Фильтр по user_id обязателен: RLS и так не даст тронуть чужую бронь,
        // но без этого условия PostgREST вернёт тихие 0 строк без ошибки.
        await waitForAuthReady();
        const { data: { session: _sess } } = await supabase.auth.getSession();
        const user = _sess?.user ?? null;
        if (!user) throw new Error('Сеанс не найден. Войдите заново.');
        const { data: updated, error } = await supabase
          .from('rc_bookings')
          .update({ cancellation_reason: reason || null })
          .eq('user_id', user.id)
          .eq('booking_id', Number(bid))
          .select('booking_id');
        if (error) throw error;
        if (!updated?.length) throw new Error('Запись не найдена или нет прав на изменение.');
        // Обновляем локальное состояние
        const b = _bookingsState.all.find(x => String(x.booking_id) === String(bid));
        if (b) b.cancellation_reason = reason || null;
        saveCancelBtn.textContent = '✓ Сохранено';
        setTimeout(() => { if (saveCancelBtn) saveCancelBtn.textContent = 'Сохранить'; }, 1500);
      } catch (err) {
        alert('Не удалось сохранить причину: ' + (err?.message || err));
      }
      return;
    }

    const linkBtn = e.target.closest('[data-link-booking]');
    if (linkBtn) {
      const bid = linkBtn.getAttribute('data-link-booking');
      const channel = linkBtn.getAttribute('data-channel') || undefined;
      const b = _bookingsState.all.find(x => String(x.booking_id) === String(bid));
      if (!b) return;
      const chTitle = channel ? (CHANNEL_TITLE[channel] || channel) : '';
      // ВАЖНО: вызываем СИНХРОННО, без await до этой строки — нужно для iOS.
      copyGuestInviteToClipboard(b, state, channel).then(() => {
        linkBtn.textContent = chTitle ? `✓ Скопировано (${chTitle})` : '✓ Ссылка скопирована';
        linkBtn.classList.add('is-sent');
        setStatus('Текст приглашения в буфере');
      }).catch((err) => {
        // Буфер обмена не сработал — показываем модалку с текстом для ручного копирования
        if (err?.text) {
          showManualCopyModal(err.text);
        } else {
          alert('Не удалось скопировать ссылку: ' + (err?.message || err));
        }
      });
      return;
    }

    const chatBtn = e.target.closest('[data-session-booking]');
    if (chatBtn) {
      const bid = chatBtn.getAttribute('data-session-booking');
      const b = _bookingsState.all.find(x => String(x.booking_id) === String(bid));
      if (!b) return;
      // создаём сессию если нужно, открываем чаты, выбираем эту
      const sess = await ensureSessionForBooking(b);
      await openChatsModal();
      _chatsState.activeSessionId = sess.id;
      await renderActiveChat();
      return;
    }
  });
  document.body.addEventListener('change', (e) => {
    if (e.target.id === 'bookingFilterApt')    { _bookingsState.filter.apt = e.target.value;    renderBookingsList(state); }
    if (e.target.id === 'bookingFilterStatus') { _bookingsState.filter.status = e.target.value; renderBookingsList(state); }
    if (e.target.id === 'bookingFilterSource') { _bookingsState.filter.source = e.target.value; renderBookingsList(state); }
  });

  // — Инструкции
  document.getElementById('openInstructionsSection')?.addEventListener('click', async () => {
    document.getElementById('drawerMenu')?.classList.remove('open');
    document.getElementById('drawerBackdrop')?.classList.remove('open');
    await openInstructionsModal(state);
  });
  document.body.addEventListener('click', async (e) => {
    if (e.target.closest('#closeInstructionsModal')) { closeModal('guestInstructionsModal'); return; }
    if (e.target.closest('#instrSaveBtn')) {
      const btn = document.getElementById('instrSaveBtn');
      // Если кнопка в режиме «Редактировать» — переводим поля в редактируемые и выходим.
      if (btn?.dataset.mode === 'edit') {
        setInstructionsReadOnly(false);
        const first = document.querySelector('#guestInstructionsModal [data-instr-field]');
        if (first) first.focus();
        return;
      }
      try {
        const patch = readInstructionForm();
        await saveInstruction(_instructionsState.apartmentId, _instructionsState.apartmentTitle, patch);
        const msg = document.getElementById('instrSaveMsg');
        if (msg) { msg.hidden = false; msg.textContent = '✓ Сохранено'; msg.style.color = 'var(--color-success, #1a7f37)'; }
        // После успешного сохранения — возвращаемся в read-only, кнопка «Редактировать».
        setInstructionsReadOnly(hasAnyInstructionData(patch));
      } catch (err) {
        const msg = document.getElementById('instrSaveMsg');
        if (msg) { msg.hidden = false; msg.textContent = 'Ошибка: ' + (err?.message || err); msg.style.color = 'var(--color-error,#c33)'; }
      }
    }
    if (e.target.closest('#instrCopyFromBtn')) {
      const apts = state?.apartments || [];
      const others = apts.filter(a => a.id !== _instructionsState.apartmentId);
      if (!others.length) { alert('Нет других квартир для копирования'); return; }
      const list = others.map((a, i) => `${i + 1}. ${a.name}`).join('\n');
      const pick = prompt('Скопировать инструкции из квартиры (номер):\n\n' + list);
      const idx = Number(pick) - 1;
      if (!Number.isInteger(idx) || idx < 0 || idx >= others.length) return;
      const src = others[idx];
      const data = await fetchInstructionFor(src.id);
      if (!data) { alert('У этой квартиры ещё нет инструкций'); return; }
      const patch = { ...data };
      delete patch.id; delete patch.user_id; delete patch.apartment_id;
      delete patch.apartment_title; delete patch.created_at; delete patch.updated_at;
      try {
        await saveInstruction(_instructionsState.apartmentId, _instructionsState.apartmentTitle, patch);
        await loadInstructionIntoForm(_instructionsState.apartmentId, _instructionsState.apartmentTitle);
        setStatus('Скопировано из «' + src.name + '»');
      } catch (err) {
        alert('Не удалось: ' + (err?.message || err));
      }
    }
  });
  document.body.addEventListener('change', async (e) => {
    if (e.target.id === 'instrApartmentSelect') {
      const apts = state?.apartments || [];
      const apt = apts.find(a => a.id === e.target.value);
      if (apt) await loadInstructionIntoForm(apt.id, apt.name);
    }
  });

  // — Чаты
  document.getElementById('openGuestBotChats')?.replaceWith(
    (() => {
      const old = document.getElementById('openGuestBotChats');
      const fresh = old?.cloneNode(true);
      if (fresh) fresh.id = 'openGuestBotChats';
      return fresh;
    })()
  );
  document.getElementById('openGuestBotChats')?.addEventListener('click', async () => {
    document.getElementById('drawerMenu')?.classList.remove('open');
    document.getElementById('drawerBackdrop')?.classList.remove('open');
    await openChatsModal();
  });
  document.body.addEventListener('click', async (e) => {
    if (e.target.closest('#closeChatsModal')) {
      closeModal('guestChatsModal');
      detachRealtimeForChats();
      return;
    }
    if (e.target.closest('#chatRefreshBtn')) {
      try {
        const chats = await fetchGuestChats();
        _chatsState.items = chats;
        renderChatsList();
        if (_chatsState.activeSessionId) await renderActiveChat();
      } catch (err) { console.warn('[bot] refresh:', err?.message || err); }
      return;
    }
    if (e.target.closest('#chatBackBtn')) {
      _chatsState.activeSessionId = null;
      const head = document.getElementById('chatThreadHead');
      const box = document.getElementById('chatThreadBox');
      const composer = document.getElementById('chatComposer');
      if (head) head.innerHTML = '';
      if (box) box.innerHTML = '';
      if (composer) composer.style.display = 'none';
      // Сбрасываем кеш разметки — иначе фоновое обновление решит, что рисовать нечего
      _chatsState.lastThreadSession = null;
      _chatsState.lastThreadHtml = '';
      _chatsState.lastHeadHtml = '';
      renderChatsList();
      updateChatsGridMode();
      return;
    }
    const chatRow = e.target.closest('[data-chat-session]');
    if (chatRow) {
      _chatsState.activeSessionId = chatRow.getAttribute('data-chat-session');
      renderChatsList();
      updateChatsGridMode();
      await renderActiveChat();
      return;
    }
    const aiBtn = e.target.closest('#chatAiToggle');
    if (aiBtn) {
      const sid = _chatsState.activeSessionId;
      if (!sid) return;
      const wasOn = aiBtn.getAttribute('data-ai-on') === '1';
      const nextOn = !wasOn;
      try {
        await setChatAiEnabled(sid, nextOn);
        const meta = _chatsState.items.find(c => c.session_id === sid);
        if (meta) meta.ai_enabled = nextOn;
        await renderActiveChat();
      } catch (err) {
        alert('Не удалось переключить AI: ' + (err?.message || err));
      }
      return;
    }
    if (e.target.closest('#chatSendBtn')) {
      const ta = document.getElementById('chatInput');
      const text = ta?.value || '';
      const meta = _chatsState.items.find(c => c.session_id === _chatsState.activeSessionId);
      if (!meta) { alert('Чат не выбран'); return; }
      if (!text.trim()) return;
      try {
        await sendManagerMessage(meta, text);
        ta.value = '';
        await renderActiveChat();
      } catch (err) {
        alert('Не отправлено: ' + (err?.message || err));
      }
      return;
    }
  });

  // — Настройки бота
  document.getElementById('openNotifySettings')?.addEventListener('click', async () => {
    document.getElementById('drawerMenu')?.classList.remove('open');
    document.getElementById('drawerBackdrop')?.classList.remove('open');
    await openNotifySettingsModal();
  });
  document.body.addEventListener('click', async (e) => {
    if (e.target.closest('#closeNotifyModal')) { closeModal('notifySettingsModal'); return; }
    // Добавить получателя
    if (e.target.closest('#ns_add_recipient')) { addRecipientRow('telegram', ''); return; }
    // Удалить строку получателя
    const delBtn = e.target.closest('.ns-rcpt-del');
    if (delBtn) { delBtn.closest('.ns-rcpt-row')?.remove(); return; }
    if (e.target.closest('#nsSaveBtn')) {
      try {
        await saveManagerSettings(buildManagerSettingsPatch());
        const msg = document.getElementById('nsSaveMsg');
        if (msg) { msg.hidden = false; msg.textContent = '✓ Сохранено'; msg.style.color = 'var(--color-success,#1a7f37)'; }
      } catch (err) {
        const msg = document.getElementById('nsSaveMsg');
        if (msg) { msg.hidden = false; msg.textContent = 'Ошибка: ' + (err?.message || err); msg.style.color = 'var(--color-error,#c33)'; }
      }
      return;
    }
    if (e.target.closest('#ns_test_btn')) {
      try {
        // Сначала сохраняем получателей, иначе сервер не знает, куда писать.
        const patch = buildManagerSettingsPatch();
        if (!patch.manager_recipients.length) {
          alert('Добавьте хотя бы одного получателя с указанным chat_id.');
          return;
        }
        await saveManagerSettings(patch);
        await sendTestNotificationToManager();
        const names = [...new Set(patch.manager_recipients.map(r => CHANNEL_TITLE[r.channel] || r.channel))].join(', ');
        alert(`Тестовое сообщение отправлено всем получателям. Проверьте ${names}.`);
      } catch (err) {
        alert('Не удалось: ' + (err?.message || err));
      }
      return;
    }
  });
}

function ensureDrawerItems() {
  const drawer = document.getElementById('drawerMenu');
  if (!drawer) return;
  // Добавляем 3 пункта если их ещё нет
  if (!document.getElementById('openBookingsSection')) {
    const btn = document.createElement('button');
    btn.className = 'drawer-item';
    btn.id = 'openBookingsSection';
    btn.innerHTML = '<span>Брони</span><span class="small">RealtyCalendar + ссылки гостям</span>';
    // вставляем после кнопки финучёта
    const fin = document.getElementById('openFinanceSection');
    if (fin?.parentNode) fin.insertAdjacentElement('afterend', btn);
    else drawer.appendChild(btn);
  }
  if (!document.getElementById('openInstructionsSection')) {
    const btn = document.createElement('button');
    btn.className = 'drawer-item';
    btn.id = 'openInstructionsSection';
    btn.innerHTML = '<span>Инструкции для гостей</span><span class="small">Что бот говорит гостю</span>';
    const bk = document.getElementById('openBookingsSection');
    if (bk?.parentNode) bk.insertAdjacentElement('afterend', btn);
    else drawer.appendChild(btn);
  }
  if (!document.getElementById('openNotifySettings')) {
    const btn = document.createElement('button');
    btn.className = 'drawer-item';
    btn.id = 'openNotifySettings';
    btn.innerHTML = '<span>Настройки бота</span><span class="small">Уведомления, шаблоны, канал</span>';
    const ch = document.getElementById('openGuestBotChats');
    if (ch?.parentNode) ch.insertAdjacentElement('afterend', btn);
    else drawer.appendChild(btn);
  }
}
