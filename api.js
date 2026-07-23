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
  const supabase = getSupabaseClient();
  if (!supabase) return [];
  // Ждём готовности сессии с ретраями (5×200мс). Без этого после быстрого входа
  // supabase-js ещё не успевает обновить getSession(), и запрос возвращает пустоту.
  const user = await requireUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from('rc_bookings')
    .select('*')
    .eq('user_id', user.id)
    .order('rc_created_at', { ascending: false })
    .limit(Math.max(1, Math.min(1000, Number(limit) || 500)));
  if (error) {
    console.warn('[RC] fetchRealtyCalendarBookings error:', error.message);
    return [];
  }
  return data || [];
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
  const { data, error } = await supabase
    .from('rc_integrations')
    .select('agency_id, enabled, last_event_at, created_at, updated_at')
    .eq('user_id', user.id)
    .maybeSingle();
  if (error) {
    console.warn('[RC] fetchRealtyCalendarIntegration error:', error.message);
    return null;
  }
  return data || null;
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
          agency_id: 65408,
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
