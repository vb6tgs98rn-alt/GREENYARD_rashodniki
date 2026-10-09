/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 */
/**
 * platformPayouts.js — ожидаемые выплаты от площадок, где гость оплачивает
 * бронь полностью на сервисе бронирования (деньги приходят нам позже).
 *
 * Сейчас поддерживается Островок (модель Hybrid):
 *   • отчётный месяц = месяц ДАТЫ ВЫЕЗДА (бронь 28.08–01.09 → отчёт за сентябрь);
 *   • выплата — в следующем месяце, в окне 11–15-го рабочего дня
 *     (1–5 р.д. сверка, 6–10 р.д. документы, 11–15 р.д. перевод);
 *   • сумма к выплате = сумма брони − комиссия площадки (platform_tax).
 *
 * Разбивка только по площадкам и отчётным месяцам (без квартир).
 * Отметка «Пришло» хранится в state.finance.platformPayouts[`${platform}|${YYYY-MM}`].
 */

import { getSupabaseClient, requireUser } from './supabase-client.js';
import { getState } from './state.js';

// Правила выплат по площадкам. Ключ — значение поля source в RealtyCalendar.
export const PAYOUT_RULES = {
  'ostrovok.ru': {
    label: 'Островок',
    windowStartWorkday: 11, // первый рабочий день окна перевода
    windowEndWorkday: 15,   // последний рабочий день окна перевода
  },
};

// Нерабочие праздничные дни РФ (ММ-ДД). Переносы выходных не учитываем —
// окно в любом случае ориентировочное, это подписано в интерфейсе.
const RU_HOLIDAYS = new Set([
  '01-01', '01-02', '01-03', '01-04', '01-05', '01-06', '01-07', '01-08',
  '02-23', '03-08', '05-01', '05-09', '06-12', '11-04',
]);

const MONTHS_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS_GEN = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

function isWorkday(y, m, d) {
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  return !RU_HOLIDAYS.has(`${pad(m)}-${pad(d)}`);
}

// N-й рабочий день месяца (y, m — 1..12). Возвращает ISO-дату.
function nthWorkday(y, m, n) {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  let count = 0;
  for (let d = 1; d <= last; d++) {
    if (isWorkday(y, m, d)) {
      count += 1;
      if (count === n) return isoOf(y, m, d);
    }
  }
  return isoOf(y, m, last);
}

// Месяц, следующий за YYYY-MM.
function nextMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
}

export function payoutKey(platform, ym) { return `${platform}|${ym}`; }

export function fmtDayMonth(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS_GEN[m - 1]}`;
}

export function fmtMonthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  const nowY = new Date().getFullYear();
  return y === nowY ? MONTHS_NOM[m - 1] : `${MONTHS_NOM[m - 1]} ${y}`;
}

/**
 * Собирает ожидаемые выплаты по площадкам.
 * Возвращает массив строк, отсортированный по дате выплаты:
 *   { key, platform, label, month, bookings, gross, commission, net,
 *     windowFrom, windowTo, status, received }
 * status: 'accruing' — месяц ещё идёт (выезды продолжаются);
 *         'waiting'   — месяц закрыт, окно выплаты ещё не наступило;
 *         'window'    — сейчас идёт окно выплаты;
 *         'overdue'   — окно прошло, отметки «Пришло» нет;
 *         'received'  — отмечено «Пришло».
 */
export async function getPlatformPayoutsAsync() {
  const supabase = getSupabaseClient();
  const user = supabase ? await requireUser() : null;
  if (!supabase || !user) return [];
  const platforms = Object.keys(PAYOUT_RULES);
  const { data, error } = await supabase
    .from('rc_bookings')
    .select('booking_id, source, end_date, amount, platform_tax, status')
    .eq('user_id', user.id)
    .in('source', platforms)
    .not('status', 'in', '(canceled,deleted)')
    .limit(3000);
  if (error) { console.warn('[payouts] rc_bookings fetch error:', error.message); return []; }

  const received = getState().finance?.platformPayouts || {};
  const today = new Date().toISOString().slice(0, 10);
  const todayYm = today.slice(0, 7);

  // Группируем по (площадка × месяц выезда).
  const groups = new Map();
  (data || []).forEach((b) => {
    if (!b.end_date) return;
    const ym = String(b.end_date).slice(0, 7);
    const key = payoutKey(b.source, ym);
    if (!groups.has(key)) {
      groups.set(key, { key, platform: b.source, month: ym, bookings: 0, gross: 0, commission: 0 });
    }
    const g = groups.get(key);
    g.bookings += 1;
    g.gross += Number(b.amount || 0);
    g.commission += Number(b.platform_tax || 0);
  });

  const rows = [];
  groups.forEach((g) => {
    const rule = PAYOUT_RULES[g.platform];
    const nm = nextMonth(g.month);
    const windowFrom = nthWorkday(nm.y, nm.m, rule.windowStartWorkday);
    const windowTo = nthWorkday(nm.y, nm.m, rule.windowEndWorkday);
    const mark = received[g.key] || null;
    let status;
    if (mark) status = 'received';
    else if (g.month >= todayYm) status = 'accruing';
    else if (today < windowFrom) status = 'waiting';
    else if (today <= windowTo) status = 'window';
    else status = 'overdue';
    rows.push({
      ...g,
      label: rule.label,
      net: Math.max(0, g.gross - g.commission),
      windowFrom,
      windowTo,
      status,
      received: mark,
    });
  });
  rows.sort((a, b) => (a.windowTo < b.windowTo ? -1 : a.windowTo > b.windowTo ? 1 : a.label.localeCompare(b.label)));
  return rows;
}
