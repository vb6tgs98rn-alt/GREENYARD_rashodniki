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
export const TELEGRAM_BOT_USERNAME_DEFAULT = 'GreenYardRashodnikiBot';
export const BOT_FUNCTION_URL = 'https://wpwuxcxmtvdxftqrrxuu.supabase.co/functions/v1/telegram-bot';

// ─────────────────────────────────────────────────────────────────────────────
// 0) Утилиты
// ─────────────────────────────────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

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

  const row = {
    user_id: user.id,
    apartment_id: String(apartmentId),
    apartment_title: apartmentTitle || null,
    updated_at: new Date().toISOString(),
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

// ─────────────────────────────────────────────────────────────────────────────
// 6) Рендер раздела «Брони»
// ─────────────────────────────────────────────────────────────────────────────

let _bookingsState = { all: [], filter: { apt: '', status: '', source: '' } };

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
    const sourceTag = b.source ? `<span class="bk-tag">${esc(b.source)}</span>` : '';
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

    const actions = isCancelled
      ? ''
      : `<div class="bk-card-actions">
          <button class="btn btn-secondary bk-btn-chat" data-session-booking="${esc(b.booking_id)}">💬 Чат</button>
          <button class="btn btn-primary bk-btn-link ${linkSent ? 'is-sent' : ''}" data-link-booking="${esc(b.booking_id)}" data-secure="${esc(secureId)}">
            ${linkSent ? '✓ Ссылка скопирована' : '📋 Ссылка гостю'}
          </button>
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
            <option value="manual">Manual</option>
            <option value="avito">Avito</option>
            <option value="cian">ЦИАН</option>
            <option value="sutochno">Суточно</option>
            <option value="booking">Booking</option>
            <option value="ostrovok">Ostrovok</option>
            <option value="yandex">Яндекс</option>
          </select>
          <button class="btn btn-secondary" id="bookingsReloadBtn" type="button">↻ Обновить</button>
        </div>
        <div id="bookingsListBox" style="flex:1;overflow:auto;"></div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

// ─────────────────────────────────────────────────────────────────────────────
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
  setFieldVal('instr_directions_metro', data.directions_metro);
  setFieldVal('instr_parking_info', data.parking_info);
  setFieldVal('instr_entrance_code', data.entrance_code);
  setFieldVal('instr_door_code', data.door_code);
  setFieldVal('instr_key_location', data.key_location);
  setFieldVal('instr_checkin_from', data.checkin_from || '14:00');
  setFieldVal('instr_checkin_instruction', data.checkin_instruction);
  setFieldVal('instr_wifi_ssid', data.wifi_ssid);
  setFieldVal('instr_wifi_password', data.wifi_password);
  setFieldVal('instr_amenities', Array.isArray(data.amenities) ? data.amenities.join(', ') : '');
  setFieldVal('instr_apartment_notes', data.apartment_notes);
  setFieldVal('instr_smoking_policy', data.smoking_policy);
  setFieldVal('instr_pets_policy', data.pets_policy);
  setFieldVal('instr_quiet_hours', data.quiet_hours);
  setFieldVal('instr_other_rules', data.other_rules);
  setFieldVal('instr_checkout_until', data.checkout_until || '12:00');
  setFieldVal('instr_checkout_checklist', data.checkout_checklist);
  setFieldVal('instr_key_return_info', data.key_return_info);
  setFieldVal('instr_emergency_phone', data.emergency_phone);
  setFieldVal('instr_emergency_telegram', data.emergency_telegram);
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
  const keys = ['full_address','directions_metro','parking_info','entrance_code','door_code','key_location','checkin_instruction','wifi_ssid','wifi_password','apartment_notes','smoking_policy','pets_policy','quiet_hours','other_rules','checkout_checklist','key_return_info','emergency_phone','emergency_telegram','ai_instructions'];
  if (keys.some(k => data[k] && String(data[k]).trim())) return true;
  if (Array.isArray(data.amenities) && data.amenities.length) return true;
  return false;
}

function setFieldVal(id, val) {
  const el = document.getElementById(id);
  if (el) el.value = val ?? '';
}

function readInstructionForm() {
  const get = (id) => document.getElementById(id)?.value?.trim() || null;
  const amenitiesRaw = get('instr_amenities') || '';
  const amenities = amenitiesRaw.split(',').map(s => s.trim()).filter(Boolean);
  return {
    full_address:        get('instr_full_address'),
    directions_metro:    get('instr_directions_metro'),
    parking_info:        get('instr_parking_info'),
    entrance_code:       get('instr_entrance_code'),
    door_code:           get('instr_door_code'),
    key_location:        get('instr_key_location'),
    checkin_from:        get('instr_checkin_from') || '14:00',
    checkin_instruction: get('instr_checkin_instruction'),
    wifi_ssid:           get('instr_wifi_ssid'),
    wifi_password:       get('instr_wifi_password'),
    amenities,
    apartment_notes:     get('instr_apartment_notes'),
    smoking_policy:      get('instr_smoking_policy'),
    pets_policy:         get('instr_pets_policy'),
    quiet_hours:         get('instr_quiet_hours'),
    other_rules:         get('instr_other_rules'),
    checkout_until:      get('instr_checkout_until') || '12:00',
    checkout_checklist:  get('instr_checkout_checklist'),
    key_return_info:     get('instr_key_return_info'),
    emergency_phone:     get('instr_emergency_phone'),
    emergency_telegram:  get('instr_emergency_telegram'),
    ai_instructions:     get('instr_ai_instructions'),
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
        <label><span class="small">Как добраться от метро</span><input data-instr-field id="instr_directions_metro" type="text" placeholder="От м. Крылатское — автобус 829 до ост. Тимошенко, 5 мин пешком" /></label>
        <label><span class="small">Парковка</span><input data-instr-field id="instr_parking_info" type="text" placeholder="Платная во дворе, 200 ₽/сут. Бесплатная на ул. Партизанская" /></label>

        <h3 class="instr-h">🔑 Заселение</h3>
        <div class="instr-grid-2">
          <label><span class="small">Код от подъезда</span><input data-instr-field id="instr_entrance_code" type="text" placeholder="К1234" /></label>
          <label><span class="small">Код от двери / где ключи</span><input data-instr-field id="instr_door_code" type="text" placeholder="5678" /></label>
        </div>
        <label><span class="small">Где взять ключи</span><input data-instr-field id="instr_key_location" type="text" placeholder="Сейф у двери справа. Внутри 2 ключа" /></label>
        <label><span class="small">Время заезда с</span><input data-instr-field id="instr_checkin_from" type="text" placeholder="14:00" /></label>
        <label><span class="small">Инструкция заселения (свободный текст)</span><textarea data-instr-field id="instr_checkin_instruction" rows="3" placeholder="Поднимитесь на 5 этаж, квартира направо от лифта"></textarea></label>

        <h3 class="instr-h">📶 Wi-Fi</h3>
        <div class="instr-grid-2">
          <label><span class="small">Имя сети</span><input data-instr-field id="instr_wifi_ssid" type="text" placeholder="GreenYard_5G" /></label>
          <label><span class="small">Пароль</span><input data-instr-field id="instr_wifi_password" type="text" placeholder="welcome2024" /></label>
        </div>

        <h3 class="instr-h">🏠 О квартире</h3>
        <label><span class="small">Что есть (через запятую)</span><input data-instr-field id="instr_amenities" type="text" placeholder="стиралка, фен, утюг, посудомойка, кондиционер" /></label>
        <label><span class="small">Особенности</span><textarea data-instr-field id="instr_apartment_notes" rows="2" placeholder="Балкон выходит на парк, окна шумоизолированные"></textarea></label>

        <h3 class="instr-h">📋 Правила</h3>
        <div class="instr-grid-2">
          <label><span class="small">Курение</span><input data-instr-field id="instr_smoking_policy" type="text" placeholder="запрещено / только на балконе / разрешено" /></label>
          <label><span class="small">Животные</span><input data-instr-field id="instr_pets_policy" type="text" placeholder="можно / нельзя" /></label>
        </div>
        <label><span class="small">Часы тишины</span><input data-instr-field id="instr_quiet_hours" type="text" placeholder="С 23:00 до 8:00 — тишина" /></label>
        <label><span class="small">Другие правила</span><textarea data-instr-field id="instr_other_rules" rows="2"></textarea></label>

        <h3 class="instr-h">🚪 Выезд</h3>
        <label><span class="small">Время выезда до</span><input data-instr-field id="instr_checkout_until" type="text" placeholder="12:00" /></label>
        <label><span class="small">Чек-лист при выезде</span><textarea data-instr-field id="instr_checkout_checklist" rows="2" placeholder="Закройте окна, выключите свет, вынесите мусор"></textarea></label>
        <label><span class="small">Куда оставить ключи</span><input data-instr-field id="instr_key_return_info" type="text" placeholder="В сейф, код 5678" /></label>

        <h3 class="instr-h">📞 Контакты</h3>
        <div class="instr-grid-2">
          <label><span class="small">Телефон для экстренных</span><input data-instr-field id="instr_emergency_phone" type="text" placeholder="+7 999 123-45-67" /></label>
          <label><span class="small">Telegram (без @)</span><input data-instr-field id="instr_emergency_telegram" type="text" placeholder="ivan_manager" /></label>
        </div>

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

let _chatsState = { items: [], activeSessionId: null, realtimeChannel: null, pollTimer: null };

export async function openChatsModal() {
  ensureChatsModal();
  // Сбрасываем активный чат при каждом открытии — начинаем со списка
  _chatsState.activeSessionId = null;
  _chatsState.items = [];
  openModal('guestChatsModal');
  await reloadChats();
  // После успешной загрузки — запускаем polling и realtime
  startChatsPolling();
  attachVisibilityRefresh();
  try { await attachRealtimeForChats(); } catch (e) { console.warn('[bot] realtime attach failed:', e); }
}

// Когда пользователь возвращается во вкладку (напр. переключившись из телеграма) — сразу перечитываем
let _lastRefetchAt = 0;
async function refetchAllOnResume(source, { force = false } = {}) {
  const modal = document.getElementById('guestChatsModal');
  if (!modal || !modal.classList.contains('open')) return;
  // Дебаунс: не чаще раза в секунду
  const now = Date.now();
  if (!force && now - _lastRefetchAt < 1000) return;
  _lastRefetchAt = now;
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
    if (_chatsState.activeSessionId) await renderActiveChat();
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
    if (document.visibilityState === 'visible') refetchAllOnResume('vis');
  });
  window.addEventListener('focus', () => refetchAllOnResume('focus'));
  window.addEventListener('pageshow', () => refetchAllOnResume('pageshow'));
  // На iOS любое касание после возврата — ещё один refetch (дебаунсится)
  document.addEventListener('touchstart', () => refetchAllOnResume('touch'), { passive: true });
  document.addEventListener('pointerdown', () => refetchAllOnResume('pointer'), { passive: true });
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
          await renderActiveChat();
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

async function renderActiveChat() {
  const box = document.getElementById('chatThreadBox');
  const head = document.getElementById('chatThreadHead');
  const composer = document.getElementById('chatComposer');
  if (!box) return;
  const sessionId = _chatsState.activeSessionId;
  if (!sessionId) {
    box.innerHTML = `<div class="empty" style="padding:2rem;text-align:center;opacity:.6;">Выберите чат слева</div>`;
    if (head) head.innerHTML = '';
    if (composer) composer.style.display = 'none';
    return;
  }
  const meta = _chatsState.items.find(c => c.session_id === sessionId);
  if (head && meta) {
    const name = meta.tg_first_name
      ? `${esc(meta.tg_first_name)}${meta.tg_last_name ? ' ' + esc(meta.tg_last_name) : ''}`
      : (meta.client_fio ? esc(meta.client_fio) : 'Гость');
    const aiOn = meta.ai_enabled !== false;
    head.innerHTML = `
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

  }
  if (composer) composer.style.display = 'flex';

  box.innerHTML = `<div class="empty" style="padding:2rem;text-align:center;opacity:.6;">Загружаем сообщения…</div>`;
  let msgs = [];
  try {
    msgs = await fetchMessages(sessionId);
  } catch (err) {
    console.warn('[bot] renderActiveChat fetch failed:', err?.message || err);
    box.innerHTML = `<div class="empty" style="padding:2rem;text-align:center;opacity:.6;color:#c66;">Ошибка загрузки: ${esc(err?.message || 'сеть')}</div>`;
    return;
  }
  console.log('[bot] renderActiveChat: session', sessionId, 'msgs:', msgs.length);
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
    return `<div class="chat-msg ${cls}"><div class="chat-msg-meta small">${esc(label)} · ${esc(time)}</div><div class="chat-msg-body">${esc(m.body || '')}</div></div>`;
  }).join('');
  box.innerHTML = html || `<div class="empty" style="padding:2rem;text-align:center;opacity:.6;">Сообщений пока нет (получено 0 строк).<br/>session_id: <code>${esc(sessionId)}</code></div>`;

  // прокручиваем вниз (в двух микротасках, чтобы дождаться layout)
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      box.scrollTop = box.scrollHeight;
    });
  });

  // отмечаем прочитанным
  await markChatAsRead(sessionId);
  // Обновляем только бейдж unread в виде-item списка (без перерендера всего списка)
  const rowUnread = document.querySelector(`[data-chat-session="${sessionId}"] .chat-unread`);
  if (rowUnread) rowUnread.remove();
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
              await renderActiveChat();
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

export async function openNotifySettingsModal() {
  ensureNotifySettingsModal();
  openModal('notifySettingsModal');
  const s = await fetchManagerSettings() || {};
  setFieldVal('ns_chat_id', s.manager_tg_chat_id ?? '');
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
        <label><span class="small">Ваш Telegram chat_id (получите у @userinfobot)</span>
          <input id="ns_chat_id" type="text" inputmode="numeric" placeholder="561644215" />
        </label>
        <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin:.5rem 0;">
          <button class="btn btn-secondary" id="ns_test_btn" type="button">Отправить тестовое сообщение</button>
        </div>
        <label class="check"><input type="checkbox" id="ns_notify_inbound" /> Новое сообщение от гостя</label>
        <label class="check"><input type="checkbox" id="ns_notify_checkin" /> Гость нажал «Я приехал»</label>
        <label class="check"><input type="checkbox" id="ns_notify_checkout" /> Гость нажал «Я уезжаю»</label>
        <label class="check"><input type="checkbox" id="ns_notify_complaint" /> Жалоба от гостя</label>

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

export async function copyGuestInviteToClipboard(booking, state) {
  // 1) Создаём/обновляем сессию (фиксируем secure_id и время «ссылка отправлена»)
  const session = await ensureSessionForBooking(booking);

  // 2) Берём шаблон + настройки бота
  const settings = await fetchManagerSettings() || {};
  const tpl = settings.guest_invite_template || DEFAULT_INVITE_TEMPLATE;

  // 3) Имя бота: пытаемся прочитать из настроек, иначе дефолт
  const botUsername = window.__GUEST_BOT_USERNAME__ || TELEGRAM_BOT_USERNAME_DEFAULT;
  const link = buildGuestLink(session.secure_id, botUsername);

  // 4) Адрес — из инструкции квартиры
  const apts = state?.apartments || [];
  const apt = apts.find(a => String(a.externalIds?.realtyCalendarUnitId || '') === String(booking.realty_id || ''));
  let address = booking.apartment_title || '';
  if (apt) {
    const instr = await fetchInstructionFor(apt.id);
    if (instr?.full_address) address = instr.full_address;
  }

  // 5) Текст
  const text = renderInviteText(tpl, {
    name:    booking.client_fio || 'гость',
    address: address,
    dates:   `${fmtDate(booking.begin_date)} — ${fmtDate(booking.end_date)}`,
    nights:  nightsBetween(booking.begin_date, booking.end_date),
    amount:  Number(booking.amount || 0).toLocaleString('ru-RU'),
    link,
  });

  // 6) Кладём в буфер
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
  }

  return { ok: true, text, link };
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

    const saveCancelBtn = e.target.closest('[data-save-cancel-reason]');
    if (saveCancelBtn) {
      const bid = saveCancelBtn.getAttribute('data-save-cancel-reason');
      const textarea = document.querySelector(`textarea[data-cancel-reason="${bid}"]`);
      const reason = (textarea?.value || '').trim();
      const supabase = getSupabaseClient();
      if (!supabase) return;
      try {
        const { error } = await supabase
          .from('rc_bookings')
          .update({ cancellation_reason: reason || null })
          .eq('booking_id', Number(bid));
        if (error) throw error;
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
      const b = _bookingsState.all.find(x => String(x.booking_id) === String(bid));
      if (!b) return;
      try {
        await copyGuestInviteToClipboard(b, state);
        linkBtn.textContent = '✓ Ссылка скопирована';
        linkBtn.classList.add('is-sent');
        setStatus('Текст приглашения в буфере');
      } catch (err) {
        alert('Не удалось скопировать ссылку: ' + (err?.message || err));
      }
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
    if (e.target.closest('#nsSaveBtn')) {
      try {
        const chatId = document.getElementById('ns_chat_id').value.trim();
        const patch = {
          manager_tg_chat_id: chatId ? Number(chatId) : null,
          guest_channel_url:  document.getElementById('ns_channel_url').value.trim() || null,
          guest_invite_template: document.getElementById('ns_template').value || null,
          notify_on_inbound:   document.getElementById('ns_notify_inbound').checked,
          notify_on_checkin:   document.getElementById('ns_notify_checkin').checked,
          notify_on_checkout:  document.getElementById('ns_notify_checkout').checked,
          notify_on_complaint: document.getElementById('ns_notify_complaint').checked,
        };
        await saveManagerSettings(patch);
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
        // сначала сохраним chat_id, чтобы Edge Function знал куда писать
        const chatId = document.getElementById('ns_chat_id').value.trim();
        if (!chatId) { alert('Сначала укажите ваш Telegram chat_id'); return; }
        await saveManagerSettings({ manager_tg_chat_id: Number(chatId) });
        await sendTestNotificationToManager();
        alert('Тестовое сообщение отправлено! Проверьте Telegram.');
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
