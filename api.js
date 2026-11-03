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
// API-слой для интеграции с RealtyCalendar через Supabase
// =============================================================================
// Архитектура:
//   RC → POST → Supabase Edge Function (realtycalendar-webhook)
//   Edge Function → INSERT/UPDATE → rc_bookings + rc_webhook_log
//   Приложение → SELECT FROM rc_bookings → applyRealtyCalendarBookings (finance.js)
//
// Один webhook URL общий для всех пользователей: внутри Edge Function
// мы определяем пользователя по agency_id (он уникален в RealtyCalendar).
// =============================================================================

import { getSupabaseClient, requireUser } from './supabase-client.js';

export const API_CONFIG = {
  webhookUrl: 'https://wpwuxcxmtvdxftqrrxuu.supabase.co/functions/v1/realtycalendar-webhook',
};

/**
 * Публичный URL вебхука, который пользователь вставит в настройки RealtyCalendar.
 */
export function getWebhookUrl() {
  return API_CONFIG.webhookUrl;
}

/**
 * Загрузить RC-бронирования текущего пользователя.
 * RLS-политика фильтрует по auth.uid().
 * @param {number} [limit=2000]
 * @returns {Promise<Array>}
 */
export async function fetchRealtyCalendarBookings(limit = 500) {
  const n = Math.max(1, Math.min(1000, Number(limit) || 500));
  // Явная загрузка (старт, realtime, вкладка «Брони», настройки) — всегда свежие данные;
  // заодно обновляет кэш для итогов и выплат площадок.
  const all = await getRcBookingsCached({ force: true });
  return all.slice(0, n);
}

// ─── Облегчённая загрузка броней с кэшем ─────────────────────────────────────
// Полный raw_payload брони весит 5–11 КБ, а приложению из него нужны только
// комиссия площадки (platform_tax) и secure_id. Поэтому грузим все колонки, кроме
// raw_payload, и два поля из него — так ответ меньше примерно в 20 раз.
// Чтобы потребители кода не менялись, raw_payload собирается обратно в той же
// форме: { data: { booking: { platform_tax, secure_id } } }.
const RC_LIGHT_COLUMNS = [
  'booking_id', 'user_id', 'agency_id', 'realty_id', 'apartment_title',
  'begin_date', 'end_date', 'amount', 'prepayment', 'status', 'source',
  'client_fio', 'client_phone', 'client_email', 'booking_url',
  'rc_created_at', 'rc_updated_at', 'received_at', 'platform_tax',
  'guest_link_sent_at', 'okidoki_contract_id', 'okidoki_link', 'contract_status',
  'contract_status_internal', 'contract_signed_at', 'contract_updated_at',
  'cancellation_reason', 'tochka_card_enabled', 'cancel_ignored', 'cancel_asked_at',
  'cancel_wait_rcpt', 'cancel_wait_until', 'checkin_time', 'checkout_time',
  'raw_tax:raw_payload->data->booking->platform_tax',
  'raw_secure_id:raw_payload->data->booking->>secure_id',
  'raw_secure_id_old:raw_payload->booking->>secure_id',
].join(',');

// Сколько живёт кэш без внешнего сброса (сброс делает realtime-обновление броней).
const RC_CACHE_TTL_MS = 60 * 1000;
let _rcCache = { at: 0, userId: null, rows: null };
let _rcInFlight = null;

function _restoreRawPayload(row) {
  const { raw_tax, raw_secure_id, raw_secure_id_old, ...rest } = row || {};
  const booking = {};
  if (raw_tax != null) booking.platform_tax = raw_tax;
  const sid = raw_secure_id || raw_secure_id_old || null;
  if (sid) booking.secure_id = sid;
  return { ...rest, raw_payload: { data: { booking } } };
}

/** Сбросить кэш броней (после realtime-события или ручной пересинхронизации). */
export function invalidateRcBookingsCache() {
  _rcCache = { at: 0, userId: null, rows: null };
}

/**
 * Все брони пользователя (до 1000, новые сверху), облегчённые, из кэша.
 * Несколько одновременных вызовов делят один сетевой запрос.
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<Array>}
 */
export async function getRcBookingsCached({ force = false } = {}) {
  const supabase = getSupabaseClient();
  if (!supabase) return [];
  // Ждём готовности сессии с ретраями (5×200мс). Без этого после быстрого входа
  // supabase-js ещё не успевает обновить getSession(), и запрос возвращает пустоту.
  const user = await requireUser();
  if (!user) return [];
  const fresh = _rcCache.rows && _rcCache.userId === user.id && (Date.now() - _rcCache.at) < RC_CACHE_TTL_MS;
  if (!force && fresh) return _rcCache.rows;
  if (_rcInFlight && _rcInFlight.userId === user.id && !force) return _rcInFlight.promise;
  const promise = (async () => {
    const { data, error } = await supabase
      .from('rc_bookings')
      .select(RC_LIGHT_COLUMNS)
      .eq('user_id', user.id)
      .order('rc_created_at', { ascending: false })
      .limit(1000);
    if (error) {
      console.warn('[RC] fetchRealtyCalendarBookings error:', error.message);
      return _rcCache.userId === user.id && _rcCache.rows ? _rcCache.rows : [];
    }
    const rows = (data || []).map(_restoreRawPayload);
    _rcCache = { at: Date.now(), userId: user.id, rows };
    return rows;
  })();
  _rcInFlight = { userId: user.id, promise };
  try { return await promise; }
  finally { if (_rcInFlight && _rcInFlight.promise === promise) _rcInFlight = null; }
}

/**
 * Полный raw_payload нескольких броней — только для диагностики в настройках RC.
 * @param {Array<number|string>} ids
 */
export async function fetchRealtyCalendarRawPayloads(ids) {
  const supabase = getSupabaseClient();
  if (!supabase || !Array.isArray(ids) || !ids.length) return new Map();
  const user = await requireUser();
  if (!user) return new Map();
  const { data, error } = await supabase
    .from('rc_bookings')
    .select('booking_id, raw_payload')
    .eq('user_id', user.id)
    .in('booking_id', ids);
  if (error) {
    console.warn('[RC] fetchRealtyCalendarRawPayloads error:', error.message);
    return new Map();
  }
  return new Map((data || []).map((r) => [String(r.booking_id), r.raw_payload]));
}

/**
 * Последние строки журнала вебхуков (для блока «Последние события»).
 * @param {number} [limit=20]
 */
export async function fetchRealtyCalendarLog(limit = 20) {
  const supabase = getSupabaseClient();
  if (!supabase) return [];
  const user = await requireUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from('rc_webhook_log')
    .select('id, action, status, booking_id, http_status, error_text, received_at')
    .eq('user_id', user.id)
    .order('received_at', { ascending: false })
    .limit(Math.max(1, Math.min(200, Number(limit) || 20)));
  if (error) {
    console.warn('[RC] fetchRealtyCalendarLog error:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Прочитать текущую интеграцию пользователя.
 * @returns {Promise<{agency_id:number, enabled:boolean, last_event_at?:string}|null>}
 */
export async function fetchRealtyCalendarIntegration() {
  const supabase = getSupabaseClient();
  if (!supabase) return null;
  const user = await requireUser();
  if (!user) return null;
  // Сразу после входа PostgREST-запрос иногда уходит раньше, чем supabase-js
  // успевает прикрепить токен сессии к заголовкам. Тогда сервер отвечает 200,
  // но пустым набором (RLS фильтрует по auth.uid()), и статус ошибочно
  // сбрасывается в «Не подключено». Поэтому: если пришло пусто, но сессия
  // живая — повторяем несколько раз с небольшой паузой.
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data, error } = await supabase
      .from('rc_integrations')
      .select('agency_id, enabled, last_event_at, created_at, updated_at')
      .eq('user_id', user.id)
      .maybeSingle();
    if (error) {
      console.warn('[RC] fetchRealtyCalendarIntegration error:', error.message);
      return null;
    }
    if (data) return data;
    // Пусто. Проверяем, есть ли валидная сессия — если да, вероятна гонка, ретраим.
    const { data: sess } = await supabase.auth.getSession();
    if (!sess?.session?.access_token) return null; // сессии нет — пользователь и правда не подключён
    if (attempt < 3) await new Promise((r) => setTimeout(r, 300));
  }
  return null;
}

/**
 * Сохранить/обновить интеграцию: привязать agency_id текущему пользователю.
 * Бросает ошибку с понятным текстом, если что-то пошло не так.
 * @param {number|string} agencyId
 */
export async function saveRealtyCalendarIntegration(agencyId) {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase не подключён');
  const user = await requireUser();
  if (!user) throw new Error('Войдите в аккаунт');
  const num = Number(agencyId);
  if (!Number.isInteger(num) || num <= 0) {
    throw new Error('agency_id должен быть положительным числом');
  }
  const { error } = await supabase
    .from('rc_integrations')
    .upsert(
      {
        user_id: user.id,
        agency_id: num,
        enabled: true,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
  if (error) {
    const msg = String(error.message || '');
    if (msg.includes('rc_integrations_agency_id_key') || msg.toLowerCase().includes('duplicate')) {
      throw new Error('Этот agency_id уже подключён к другому аккаунту');
    }
    throw new Error(msg || 'Не удалось сохранить интеграцию');
  }
  return { ok: true };
}

/**
 * Отключить интеграцию: удалить связку user ↔ agency_id.
 */
export async function disconnectRealtyCalendar() {
  const supabase = getSupabaseClient();
  if (!supabase) throw new Error('Supabase не подключён');
  const user = await requireUser();
  if (!user) throw new Error('Войдите в аккаунт');
  const { error } = await supabase
    .from('rc_integrations')
    .delete()
    .eq('user_id', user.id);
  if (error) throw new Error(error.message || 'Не удалось отключить интеграцию');
  return { ok: true };
}

/**
 * Пример payload от RealtyCalendar (для блока диагностики).
 * Возвращает строку JSON, готовую к выводу в <pre>.
 */
export function buildFinanceWebhookExample() {
  return JSON.stringify(
    {
      action: 'create_booking',
      status: 'booked',
      data: {
        booking: {
          id: 113386019,
          agency_id: 12345,
          realty_id: 208656,
          begin_date: '2026-07-01',
          end_date: '2026-07-03',
          amount: 5000,
          prepayment: 4500,
          apartment: { id: 208656, title: 'Тверская 18' },
          client: { fio: 'Иван Петров', phone: '+7 999 888-88-88' },
          source: 'manual',
          url: 'https://realtycalendar.ru/event_calendars/113386019',
          created_at: '2026-06-28T11:30:24.239+03:00',
        },
      },
    },
    null,
    2
  );
}
