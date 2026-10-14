/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 */
/**
 * platformPayouts.js — ожидаемые выплаты от площадок, где гость оплачивает
 * бронь полностью на сервисе бронирования (деньги приходят нам позже).
 *
 * Правила (по ответам поддержки площадок):
 *   • Островок (Hybrid): раз в месяц, отчётный месяц — по дате выезда,
 *     перевод в 11–15-й рабочий день следующего месяца.
 *   • Броневик (реестровая оплата): раз в месяц, по дате выезда,
 *     перевод после 7-го числа следующего месяца в течение 2–5 рабочих дней.
 *   • Яндекс Путешествия (апартаменты): по каждой брони отдельно,
 *     через 5 рабочих дней после выезда гостя.
 * Сумма к выплате = сумма брони − комиссия площадки (platform_tax из RealtyCalendar).
 *
 * Выплаты показываются по месяцу поступления. Отметка «Пришло» хранится в
 * state.finance.platformPayouts[key], где key:
 *   — помесячные площадки: `${source}|${YYYY-MM}` (месяц выездов);
 *   — посуточные (Яндекс): `${source}|d:${YYYY-MM-DD}` (дата выплаты).
 */

import { getSupabaseClient, requireUser } from './supabase-client.js';
import { getState } from './state.js';

// Правила выплат. Ключ — значение поля source в RealtyCalendar.
export const PAYOUT_RULES = {
  'ostrovok.ru': {
    label: 'Островок',
    mode: 'monthly',
    // Окно: с N-го по M-й рабочий день следующего месяца.
    window: (y, m) => [nthWorkday(y, m, 11), nthWorkday(y, m, 15)],
    hint: '11–15-й рабочий день месяца за выезды прошлого месяца',
  },
  'Bronevik': {
    label: 'Броневик',
    mode: 'monthly',
    // После 7-го числа, в течение 2–5 рабочих дней.
    window: (y, m) => [workdayAfter(isoOf(y, m, 7), 2), workdayAfter(isoOf(y, m, 7), 5)],
    hint: 'после 7-го числа, 2–5 рабочих дней, за выезды прошлого месяца (нужен подписанный реестр)',
  },
  'YandexTravel': {
    label: 'Яндекс Путешествия',
    mode: 'per_booking',
    // Через 5 рабочих дней после даты выезда.
    payDate: (endDate) => workdayAfter(endDate, 5),
    hint: 'через 5 рабочих дней после выезда гостя, по каждой брони',
  },
};

// Нерабочие праздничные дни РФ (ММ-ДД). Переносы выходных не учитываем —
// даты ориентировочные, это подписано в интерфейсе.
const RU_HOLIDAYS = new Set([
  '01-01', '01-02', '01-03', '01-04', '01-05', '01-06', '01-07', '01-08',
  '02-23', '03-08', '05-01', '05-09', '06-12', '11-04',
]);

const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_GEN = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const MONTHS_PREP = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];

const pad = (n) => String(n).padStart(2, '0');
function isoOf(y, m, d) { return `${y}-${pad(m)}-${pad(d)}`; }

function isWorkdayIso(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (wd === 0 || wd === 6) return false;
  return !RU_HOLIDAYS.has(`${pad(m)}-${pad(d)}`);
}

function addDaysIso(iso, n) {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return isoOf(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

// N-й рабочий день ПОСЛЕ даты (сама дата не считается).
function workdayAfter(iso, n) {
  let cur = iso;
  let count = 0;
  while (count < n) {
    cur = addDaysIso(cur, 1);
    if (isWorkdayIso(cur)) count += 1;
  }
  return cur;
}

// N-й рабочий день месяца (m — 1..12).
function nthWorkday(y, m, n) {
  return workdayAfter(addDaysIso(isoOf(y, m, 1), -1), n);
}

function nextMonth(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? { y: y + 1, m: 1 } : { y, m: m + 1 };
}

// Сдвиг месяца YYYY-MM на delta.
export function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1 + delta, 1));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}`;
}

export function currentMonth() {
  return todayIso().slice(0, 7);
}

// Сегодня по Москве (приложение работает в МСК).
function todayIso() {
  return new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
}

export function fmtDayMonth(iso) {
  if (!iso) return '';
  const [, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS_GEN[m - 1]}`;
}

export function fmtMonthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS_NOM[m - 1]} ${y}`;
}

export function fmtMonthPrep(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS_PREP[m - 1]} ${y}`;
}

export function getRuleHints() {
  return Object.values(PAYOUT_RULES).map((r) => `${r.label} — ${r.hint}`);
}

// Комиссия площадки: колонка platform_tax часто 0, реальное значение — в raw_payload.
function bookingCommission(b) {
  const raw = Number(b.raw_payload?.data?.booking?.platform_tax);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const col = Number(b.platform_tax);
  return Number.isFinite(col) ? col : 0;
}

/**
 * Все ожидаемые/полученные выплаты площадок.
 * Строка: { key, platform, label, mode, refLabel, bookings, gross, commission, net,
 *           windowFrom, windowTo, payMonth, status, received, items[] }
 * status: 'stay'     — гость ещё не выехал / месяц выездов ещё идёт;
 *         'waiting'  — ждём, срок ещё не наступил;
 *         'window'   — сейчас срок выплаты;
 *         'overdue'  — срок прошёл, отметки «Пришло» нет;
 *         'received' — отмечено «Пришло».
 */
export async function getPlatformPayoutsAsync() {
  const supabase = getSupabaseClient();
  const user = supabase ? await requireUser() : null;
  if (!supabase || !user) return [];
  const platforms = Object.keys(PAYOUT_RULES);
  const { data, error } = await supabase
    .from('rc_bookings')
    .select('booking_id, source, apartment_title, begin_date, end_date, amount, platform_tax, status, raw_payload')
    .eq('user_id', user.id)
    .in('source', platforms)
    .not('status', 'in', '(canceled,deleted)')
    .limit(3000);
  if (error) { console.warn('[payouts] rc_bookings fetch error:', error.message); return []; }

  const marks = getState().finance?.platformPayouts || {};
  const today = todayIso();
  const todayYm = today.slice(0, 7);

  const groups = new Map();
  (data || []).forEach((b) => {
    if (!b.end_date || Number(b.amount || 0) <= 0) return;
    const rule = PAYOUT_RULES[b.source];
    if (!rule) return;
    const end = String(b.end_date).slice(0, 10);
    let key; let windowFrom; let windowTo; let refLabel; let stay;
    if (rule.mode === 'monthly') {
      const ym = end.slice(0, 7);
      const nm = nextMonth(ym);
      [windowFrom, windowTo] = rule.window(nm.y, nm.m);
      key = `${b.source}|${ym}`;
      refLabel = `выезды за ${MONTHS_NOM[Number(ym.slice(5)) - 1].toLowerCase()}`;
      stay = ym >= todayYm;
    } else {
      windowFrom = windowTo = rule.payDate(end);
      key = `${b.source}|d:${windowFrom}`;
      refLabel = '';
      stay = end > today;
    }
    if (!groups.has(key)) {
      groups.set(key, { key, platform: b.source, label: rule.label, mode: rule.mode, refLabel, windowFrom, windowTo, stay: false, bookings: 0, gross: 0, commission: 0, items: [] });
    }
    const g = groups.get(key);
    const commission = bookingCommission(b);
    g.bookings += 1;
    g.gross += Number(b.amount || 0);
    g.commission += commission;
    g.stay = g.stay || stay;
    g.items.push({ apt: b.apartment_title || '', begin: b.begin_date, end, amount: Number(b.amount || 0), commission });
  });

  const rows = [];
  groups.forEach((g) => {
    const mark = marks[g.key] || null;
    let status;
    if (mark) status = 'received';
    else if (g.stay) status = 'stay';
    else if (today < g.windowFrom) status = 'waiting';
    else if (today <= g.windowTo) status = 'window';
    else status = 'overdue';
    if (g.mode === 'per_booking') {
      g.refLabel = g.items.length === 1 ? `выезд ${fmtDayMonth(g.items[0].end)}` : `выезды ${g.items.map((i) => fmtDayMonth(i.end)).join(', ')}`;
    }
    rows.push({ ...g, net: Math.max(0, g.gross - g.commission), payMonth: g.windowFrom.slice(0, 7), status, received: mark });
  });
  rows.sort((a, b) => (a.windowFrom < b.windowFrom ? -1 : a.windowFrom > b.windowFrom ? 1 : a.label.localeCompare(b.label)));
  return rows;
}
