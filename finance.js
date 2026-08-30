/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 *
 * Копирование, распространение, переработка и обратная разработка
 * (reverse engineering) запрещены без письменного разрешения правообладателя.
 * Условия: см. файл LICENSE. Нарушение влечёт ответственность по ст. 1252,
 * 1301 ГК РФ.
 */
import { currentApartment, findApartmentById, getDisplayApartmentName, getState, updateState } from './state.js';
import { getSupabaseClient, requireUser } from './supabase-client.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const FINANCE_TYPES = { income: 'income', expense: 'expense' };

export const STATUS_LABELS = {
  planned:   { label: 'Запланировано', cls: 'planned' },
  confirmed: { label: 'Подтверждено',  cls: 'confirmed' },
  pending:   { label: 'В ожидании',    cls: 'pending' },
  cancelled: { label: 'Отменено',      cls: 'cancelled' },
};

export function monthKey(dateLike) {
  if (!dateLike) return '';
  const d = new Date(dateLike);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function ensureFinanceGeneratedForCurrentMonth() {
  const state = getState();
  const month = state.ui?.finance?.month || monthKey(new Date());
  generateRecurringEntriesForMonth(month);
}

export function createFinanceEntryDraft(data = {}) {
  const apartment = findApartmentById(data.apartmentId) || currentApartment();
  const amount = Number(data.amount || 0);
  // Чистая прибыль: если явно не указана — равна полной сумме (для ручных записей комиссии нет).
  const netAmount = data.netAmount != null ? Number(data.netAmount) : amount;
  return {
    id: crypto.randomUUID(),
    apartmentId: apartment?.id || '',
    apartmentName: getDisplayApartmentName(apartment?.name || '—'),
    type: data.type || FINANCE_TYPES.expense,
    category: data.category || '',
    title: data.title || '',
    amount,                            // оборот (валовая сумма, включая комиссию площадки)
    netAmount,                         // чистая прибыль (без комиссии)
    currency: data.currency || 'RUB',
    date: data.date || new Date().toISOString().slice(0, 10),
    source: data.source || 'manual',
    status: data.status || 'planned',
    notes: data.notes || '',
    externalBookingId: data.externalBookingId || '',
    meta: data.meta || {},
  };
}

export const RECURRING_KIND_LABELS = {
  rent: 'Аренда',
  internet: 'Интернет',
  utilities: 'Коммуналка',
  subscription: 'Подписка',
  other: 'Другое',
};

export function createRecurringRuleDraft(data = {}) {
  const apartment = findApartmentById(data.apartmentId) || currentApartment();
  const kind = data.kind || 'other';
  // Если выбран конкретный вид — подставляем лейбл как title, иначе берём введённый текст.
  const titleFromKind = (kind !== 'other' && RECURRING_KIND_LABELS[kind]) ? RECURRING_KIND_LABELS[kind] : '';
  const title = (kind === 'other')
    ? (data.title || 'Правило')
    : (titleFromKind || data.title || 'Правило');
  return {
    id: crypto.randomUUID(),
    apartmentId: apartment?.id || '',
    apartmentName: getDisplayApartmentName(apartment?.name || '—'),
    title,
    kind,
    category: data.category || (kind !== 'other' ? RECURRING_KIND_LABELS[kind] : ''),
    amount: Number(data.amount || 0),
    currency: data.currency || 'RUB',
    type: data.type || FINANCE_TYPES.expense,
    dayOfMonth: Number(data.dayOfMonth || 1),
    startDate: data.startDate || new Date().toISOString().slice(0, 10),
    endDate: data.endDate || '',
    notes: data.notes || '',
    active: data.active ?? true,
  };
}

export function addFinanceEntry(entry) {
  const normalized = createFinanceEntryDraft(entry);
  updateState((state) => { state.finance.entries.unshift(normalized); });
  return normalized;
}

export function deleteFinanceEntry(id) {
  updateState((state) => {
    state.finance.entries = state.finance.entries.filter((e) => e.id !== id);
  });
}

export function updateFinanceEntryStatus(id, status) {
  updateState((state) => {
    const entry = state.finance.entries.find((e) => e.id === id);
    if (entry) entry.status = status;
  });
}

// Частичное обновление ручной записи (тип, название, сумма, дата, квартира, комментарий).
// Системные записи (RC/уборка) не трогаем — они перезапишутся при следующем синке.
export function updateFinanceEntry(id, patch = {}) {
  updateState((state) => {
    const entry = state.finance.entries.find((e) => e.id === id);
    if (!entry) return;
    if (patch.apartmentId != null) entry.apartmentId = patch.apartmentId;
    if (patch.type != null) entry.type = patch.type;
    if (patch.title != null) entry.title = patch.title;
    if (patch.amount != null) {
      const n = Number(patch.amount) || 0;
      entry.amount = n;
      entry.netAmount = n;
    }
    if (patch.date != null) entry.date = patch.date;
    if (patch.notes != null) entry.notes = patch.notes;
    if (patch.status != null) entry.status = patch.status;
  });
}

export function addRecurringRule(rule) {
  const normalized = createRecurringRuleDraft(rule);
  updateState((state) => { state.finance.recurringRules.unshift(normalized); });
  return normalized;
}

export function deleteRecurringRule(id) {
  updateState((state) => {
    state.finance.recurringRules = state.finance.recurringRules.filter((r) => r.id !== id);
    // Удаляем сгенерированные записи этого правила со статусом planned
    state.finance.entries = state.finance.entries.filter(
      (e) => !(e.source === 'recurring' && e.meta?.ruleId === id && e.status === 'planned')
    );
  });
}

export function toggleRecurringRule(id) {
  updateState((state) => {
    const rule = state.finance.recurringRules.find((r) => r.id === id);
    if (rule) rule.active = !rule.active;
  });
}

export function generateRecurringEntriesForMonth(month) {
  if (!month) return [];
  const created = [];
  updateState((state) => {
    const existingKeys = new Set(
      state.finance.entries
        .filter((entry) => entry.source === 'recurring')
        .map((entry) => `${entry.meta?.ruleId || ''}:${entry.date}`)
    );
    state.finance.recurringRules.forEach((rule) => {
      if (!rule.active) return;
      const dueDate = `${month}-${String(Math.min(Math.max(rule.dayOfMonth || 1, 1), 28)).padStart(2, '0')}`;
      if (rule.startDate && dueDate < rule.startDate) return;
      if (rule.endDate && dueDate > rule.endDate) return;
      const key = `${rule.id}:${dueDate}`;
      if (existingKeys.has(key)) return;
      const entry = createFinanceEntryDraft({
        apartmentId: rule.apartmentId,
        type: rule.type,
        category: rule.category,
        title: rule.title,
        amount: rule.amount,
        currency: rule.currency,
        date: dueDate,
        source: 'recurring',
        status: 'planned',
        notes: rule.notes,
        meta: { ruleId: rule.id },
      });
      state.finance.entries.push(entry);
      created.push(entry);
      existingKeys.add(key);
    });
  });
  return created;
}

// =============================================================================
// Синхронизация бронирований RealtyCalendar в финучёт
// =============================================================================
// Правила:
//   • 1 бронь = 1 запись в финучете (тип: доход)
//   • Дата = дата создания брони в RC (rc_created_at)
//   • amount = booking.amount (валовая сумма, с комиссией площадки)
//   • netAmount = booking.prepayment (чистая прибыль)
//   • Отмена/удаление в RC → удаляем запись
//   • Изменение в RC → обновляем существующую запись (по externalBookingId)
//   • Если в карточке квартиры не указан realtyCalendarUnitId — бронь пропускается
// =============================================================================

function findApartmentByRealtyId(state, realtyId) {
  if (realtyId == null || realtyId === '') return null;
  const target = String(realtyId);
  return state.apartments.find(
    (a) => a.externalIds?.realtyCalendarUnitId && String(a.externalIds.realtyCalendarUnitId) === target
  ) || null;
}

function formatRange(beginDate, endDate) {
  if (!beginDate && !endDate) return '';
  return `${beginDate || '—'} → ${endDate || '—'}`;
}

/**
 * Приводит финансовые записи к текущему состоянию RC-бронирований из Supabase.
 * Идемпотентна: можно вызывать многократно — результат одинаковый.
 * @param {Array} bookings — ряды из таблицы rc_bookings
 * @returns {{ added:number, updated:number, removed:number, skipped:number }}
 */
// Самолечение: убирает дубли записей с одинаковым externalBookingId (оставляет первую).
// Вызывается перед каждым синком и после загрузки состояния.
export function dedupeFinanceEntriesByExternalId() {
  let removed = 0;
  updateState((state) => {
    const seen = new Set();
    const kept = [];
    for (const e of state.finance.entries) {
      if (e.source === 'realtycalendar' && e.externalBookingId) {
        const key = `${e.source}:${String(e.externalBookingId)}`;
        if (seen.has(key)) { removed++; continue; }
        seen.add(key);
      }
      kept.push(e);
    }
    if (removed) state.finance.entries = kept;
  });
  return removed;
}

export function applyRealtyCalendarBookings(bookings = []) {
  const result = { added: 0, updated: 0, removed: 0, skipped: 0 };
  // Сначала чистим возможные дубли от старых багов синхронизации.
  dedupeFinanceEntriesByExternalId();
  updateState((state) => {
    const existingByBookingId = new Map();
    state.finance.entries.forEach((entry, idx) => {
      if (entry.source === 'realtycalendar' && entry.externalBookingId) {
        existingByBookingId.set(String(entry.externalBookingId), { entry, idx });
      }
    });

    bookings.forEach((b) => {
      const bookingId = String(b.booking_id);
      const cleaningId = `${bookingId}:cleaning`;
      const apartment = findApartmentByRealtyId(state, b.realty_id);

      // Отменённые/удалённые — убираем из финучёта и связанный расход уборки
      if (b.status === 'canceled' || b.status === 'deleted') {
        if (existingByBookingId.has(bookingId) || existingByBookingId.has(cleaningId)) {
          state.finance.entries = state.finance.entries.filter(
            (e) => !(e.source === 'realtycalendar' && (String(e.externalBookingId) === bookingId || String(e.externalBookingId) === cleaningId))
          );
          existingByBookingId.delete(bookingId);
          existingByBookingId.delete(cleaningId);
          result.removed++;
        }
        return;
      }

      // Квартира не привязана — пропускаем
      if (!apartment) { result.skipped++; return; }

      // Активная бронь — обновляем или создаём
      // Дата в карточке — дата заезда, а не создания брони.
      const date = b.begin_date || (b.rc_created_at ? String(b.rc_created_at).slice(0, 10) : '') || new Date().toISOString().slice(0, 10);
      // В заголовке — только имя гостя (если есть) и даты заселения.
      const range = formatRange(b.begin_date, b.end_date);
      const guest = b.client_fio ? ` · ${b.client_fio}` : '';
      const title = range ? `${range}${guest}` : `Бронь #${b.booking_id}${guest}`;
      // Пользователь просил не показывать подробности в фин учёте.
      const notes = '';

      // Комиссия площадки (Avito/ЦИАН/Суточно и т.п.) приходит в platform_tax.
      // Для ручных броней (source=manual) это поле null → комиссия = 0 → netAmount = amount.
      // Колонки platform_tax в rc_bookings пока нет — берём из raw_payload.data.booking.
      const grossAmount = Number(b.amount || 0);
      const rawBooking = b.raw_payload?.data?.booking || {};
      const platformTax = Number(rawBooking.platform_tax || 0);
      const netAmount = Math.max(0, grossAmount - platformTax);

      const payload = {
        apartmentId: apartment.id,
        type: FINANCE_TYPES.income,
        category: 'Бронирование',
        title,
        amount: grossAmount,
        netAmount,
        currency: 'RUB',
        date,
        source: 'realtycalendar',
        status: 'confirmed',
        notes,
        externalBookingId: bookingId,
        meta: {
          realty_id: b.realty_id,
          apartment_title: b.apartment_title,
          begin_date: b.begin_date,
          end_date: b.end_date,
          client_fio: b.client_fio || '',
          booking_url: b.booking_url,
          rc_status: b.status,
          platform_tax: platformTax,
          // Okidoki — текущее состояние договора для этой брони
          contract_id: b.okidoki_contract_id || '',
          contract_link: b.okidoki_link || '',
          contract_status: b.contract_status || '',
          contract_status_internal: b.contract_status_internal ?? null,
        },
      };

      if (existingByBookingId.has(bookingId)) {
        const { entry, idx } = existingByBookingId.get(bookingId);
        state.finance.entries[idx] = {
          ...entry,
          ...payload,
          apartmentName: getDisplayApartmentName(apartment.name),
          id: entry.id,
        };
        result.updated++;
      } else {
        const entry = createFinanceEntryDraft(payload);
        state.finance.entries.unshift(entry);
        result.added++;
      }

      // Автоуборка: если у квартиры задана cleaningPrice > 0 — создаём/обновляем расход на дату создания брони
      const cleaningPrice = Number(apartment.cleaningPrice || 0);
      if (cleaningPrice > 0) {
        const cleaningPayload = {
          apartmentId: apartment.id,
          type: FINANCE_TYPES.expense,
          category: 'Уборка',
          title: `Уборка после брони #${b.booking_id}`,
          amount: cleaningPrice,
          netAmount: cleaningPrice,
          currency: 'RUB',
          date,
          source: 'realtycalendar',
          status: 'planned',
          notes: `Автоматический расход. Связан с бронью #${b.booking_id}.`,
          externalBookingId: cleaningId,
          meta: { booking_id: b.booking_id, kind: 'cleaning' },
        };
        if (existingByBookingId.has(cleaningId)) {
          const { entry, idx } = existingByBookingId.get(cleaningId);
          state.finance.entries[idx] = {
            ...entry,
            ...cleaningPayload,
            apartmentName: getDisplayApartmentName(apartment.name),
            id: entry.id,
          };
        } else {
          const entry = createFinanceEntryDraft(cleaningPayload);
          state.finance.entries.unshift(entry);
        }
      } else if (existingByBookingId.has(cleaningId)) {
        // cleaningPrice убрали — удаляем вручную связанную запись
        state.finance.entries = state.finance.entries.filter(
          (e) => !(e.source === 'realtycalendar' && String(e.externalBookingId) === cleaningId)
        );
      }
    });

    state.finance.bookingSync.lastSyncedAt = new Date().toISOString();
    if (state.integrations?.realtycalendar) {
      state.integrations.realtycalendar.lastEventAt = new Date().toISOString();
    }
  });
  return result;
}

// Совместимость со старым кодом, который мог импортировать importBookingsToFinance.
export function importBookingsToFinance() { return []; }

// =============================================================================
// Юнит-экономика по квартирам
// =============================================================================
// За выбранный период (dateFrom..dateTo, по умолчанию — текущий месяц) считаем
// для каждой квартиры: брутто-доход, комиссию площадки, чистый доход, уборку,
// регулярные расходы (по kind), прочие расходы, маржу, ROI и количество броней.
// Источник истины — state.finance.entries (как и весь остальной финансовый учёт).
// =============================================================================
// =============================================================================
// Отчётные периоды юнит-экономики: привязка к квартире + автопродление
// =============================================================================
export const REPORT_CADENCE_LABELS = {
  monthly: 'Месяц',
  quarterly: 'Квартал',
  yearly: 'Год',
  custom: 'Свой',
};

function _lastDayOfMonthIso(year, month1) {
  const last = new Date(year, month1, 0).getDate();
  return `${year}-${String(month1).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

function _nextPeriod(prevEndDateIso, cadence) {
  const [y, m, d] = prevEndDateIso.split('-').map(Number);
  const start = new Date(y, m - 1, d);
  start.setDate(start.getDate() + 1);
  const startIso = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-${String(start.getDate()).padStart(2, '0')}`;
  let endIso = startIso;
  if (cadence === 'monthly') {
    endIso = _lastDayOfMonthIso(start.getFullYear(), start.getMonth() + 1);
  } else if (cadence === 'quarterly') {
    const e = new Date(start); e.setMonth(e.getMonth() + 3); e.setDate(e.getDate() - 1);
    endIso = `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, '0')}-${String(e.getDate()).padStart(2, '0')}`;
  } else if (cadence === 'yearly') {
    const e = new Date(start); e.setFullYear(e.getFullYear() + 1); e.setDate(e.getDate() - 1);
    endIso = `${e.getFullYear()}-${String(e.getMonth() + 1).padStart(2, '0')}-${String(e.getDate()).padStart(2, '0')}`;
  }
  return { startDate: startIso, endDate: endIso };
}

export function setUnitEcoActiveReport(apartmentId, { startDate, endDate, cadence = 'monthly' }) {
  if (!apartmentId || !startDate || !endDate) return null;
  let created = null;
  updateState((state) => {
    const apt = (state.apartments || []).find((a) => a.id === apartmentId);
    if (!apt) return;
    if (!apt.unitEcoReports) apt.unitEcoReports = { active: null, history: [] };
    created = { id: crypto.randomUUID(), startDate, endDate, cadence, createdAt: new Date().toISOString() };
    apt.unitEcoReports.active = created;
  });
  return created;
}

export function updateUnitEcoActiveReport(apartmentId, patch = {}) {
  updateState((state) => {
    const apt = (state.apartments || []).find((a) => a.id === apartmentId);
    if (!apt || !apt.unitEcoReports?.active) return;
    const a = apt.unitEcoReports.active;
    if (typeof patch.startDate === 'string' && patch.startDate) a.startDate = patch.startDate;
    if (typeof patch.endDate === 'string' && patch.endDate) a.endDate = patch.endDate;
    if (typeof patch.cadence === 'string' && patch.cadence) a.cadence = patch.cadence;
    if (a.endDate < a.startDate) a.endDate = a.startDate;
  });
}

export function advanceUnitEcoReportIfNeeded(apartmentId) {
  const todayIso = new Date().toISOString().slice(0, 10);
  let advanced = false;
  updateState((state) => {
    const apt = (state.apartments || []).find((a) => a.id === apartmentId);
    if (!apt) return;
    if (!apt.unitEcoReports) apt.unitEcoReports = { active: null, history: [] };
    let safety = 36;
    while (safety-- > 0) {
      const cur = apt.unitEcoReports.active;
      if (!cur || !cur.endDate || cur.endDate >= todayIso) break;
      if (cur.cadence === 'custom') break;
      apt.unitEcoReports.history.unshift({ ...cur, closedAt: new Date().toISOString() });
      const np = _nextPeriod(cur.endDate, cur.cadence);
      apt.unitEcoReports.active = { id: crypto.randomUUID(), startDate: np.startDate, endDate: np.endDate, cadence: cur.cadence, createdAt: new Date().toISOString() };
      advanced = true;
    }
  });
  return advanced;
}

export function deleteUnitEcoHistoryReport(apartmentId, reportId) {
  updateState((state) => {
    const apt = (state.apartments || []).find((a) => a.id === apartmentId);
    if (!apt || !apt.unitEcoReports?.history) return;
    apt.unitEcoReports.history = apt.unitEcoReports.history.filter((r) => r.id !== reportId);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Юнит-экономика считается НА СЕРВЕРЕ (edge-функция unit-economics).
//
// Формулы (маржа, ROI, ADR, разбор комиссии площадки, категоризация расходов)
// намеренно вынесены из браузера: раньше их можно было прочитать в DevTools.
// Здесь остаётся только транспорт — отправить периоды, получить готовые числа.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Запрашивает готовые отчёты по юнит-экономике одним запросом.
 *
 * @param {string} apartmentId
 * @param {Array<{key:string,startDate:string,endDate:string,filters?:object,includeEntries?:boolean}>} periods
 * @returns {Promise<Record<string, {stat:object,entries:Array,period:object,apartment:object}|null>>}
 * @throws {Error} при сетевой ошибке или отказе сервера — вызывающий код показывает сообщение.
 */
export async function fetchUnitEcoReports(apartmentId, periods) {
  if (!apartmentId || !Array.isArray(periods) || !periods.length) return {};
  const supabase = getSupabaseClient();
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) throw new Error('Нет активной сессии');

  const resp = await fetch(`${SUPABASE_URL}/functions/v1/unit-economics`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify({ action: 'reports', apartmentId, periods }),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`Расчёт недоступен (${resp.status})${text ? ': ' + text.slice(0, 200) : ''}`);
  }
  const json = await resp.json();
  if (!json?.ok) throw new Error(json?.error || 'Расчёт не удался');
  return json.reports || {};
}

export function getFilteredFinanceEntries() {
  const state = getState();
  const filter = state.ui.finance || {};
  return state.finance.entries
    .filter((entry) => {
      if (filter.apartmentFilter && filter.apartmentFilter !== 'all' && entry.apartmentId !== filter.apartmentFilter) return false;
      if (filter.typeFilter && filter.typeFilter !== 'all' && entry.type !== filter.typeFilter) return false;
      // Диапазон дат явный
      const date = entry.date || '';
      if (filter.dateFrom && date && date < filter.dateFrom) return false;
      if (filter.dateTo && date && date > filter.dateTo) return false;
      // Легаси: filter.month — если явный диапазон не выбран
      if (!filter.dateFrom && !filter.dateTo && filter.month && monthKey(entry.date) !== filter.month) return false;
      if (filter.showOnlyPending && !['planned', 'pending'].includes(entry.status)) return false;
      return true;
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function lastDateOfMonthIso(monthIso) {
  // monthIso в формате 'YYYY-MM' → 'YYYY-MM-DD' (последний день)
  if (!monthIso) return '';
  const [y, m] = monthIso.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

export function monthToDateRange(monthIso) {
  if (!monthIso) return { from: '', to: '' };
  return { from: `${monthIso}-01`, to: lastDateOfMonthIso(monthIso) };
}

// Итоги «по квартирам» для табличного вида на вкладке «Итоги по квартирам».
// Расчёты идут ЛОКАЛЬНО из state.finance.entries с учётом активных фильтров
// (квартира, тип, диапазон дат) — чтобы данные согласовывались со списком проводок.
//
// По каждой квартире считаем:
//   income            — валовые доходы (сумма amount по entry.type=income)
//   platformCommission — комиссии площадок (сумма meta.platform_tax по entry.type=income)
//   netIncome         — чистый доход (income − platformCommission)
//   expense           — прочие расходы (сумма amount по entry.type=expense)
//   profit            — прибыль (netIncome − expense)  ← как в референсе «Реалти»
//   soldNights        — проданных ночей (сумма ночей по бронированиям в периоде)
//   bookings          — количество броней в периоде
//   availableNights   — доступных ночей = длина периода (или число активных дней)
//   avgDaily          — среднесуточный доход = income / periodDays
//   adr               — средняя цена проданной ночи = income / soldNights
//   occupancy         — загрузка, % = soldNights / availableNights
//   avgStay           — средняя длит. проживания = soldNights / bookings
function _nightsBetween(fromIso, toIso) {
  if (!fromIso || !toIso) return 0;
  const a = new Date(fromIso + 'T00:00:00Z').getTime();
  const b = new Date(toIso + 'T00:00:00Z').getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.round((b - a) / 86400000);
}

// Пересечение отрезка [aFrom, aTo) с периодом [bFrom, bTo] (обе границы включительно).
// Для броней: aFrom=begin_date (день заезда), aTo=end_date (день выезда, в этот день ночи нет).
// Возвращает количество ночей, входящих в выбранный период [bFrom, bTo] (включительно).
function _bookingNightsInPeriod(beginDate, endDate, periodFrom, periodTo) {
  if (!beginDate || !endDate || !periodFrom || !periodTo) return 0;
  const day = 86400000;
  const a1 = new Date(beginDate + 'T00:00:00Z').getTime();
  const a2 = new Date(endDate + 'T00:00:00Z').getTime();
  const b1 = new Date(periodFrom + 'T00:00:00Z').getTime();
  // Период включительно → сдвигаем верхнюю границу на сутки вперёд (ночь с 30 на 31 — это ещё 30 авг).
  const b2 = new Date(periodTo + 'T00:00:00Z').getTime() + day;
  if (!Number.isFinite(a1) || !Number.isFinite(a2) || a2 <= a1) return 0;
  const lo = Math.max(a1, b1);
  const hi = Math.min(a2, b2);
  if (hi <= lo) return 0;
  return Math.round((hi - lo) / day);
}

// Возвращает границы периода (from, to) для расчёта загрузки, среднесуточного и т.п.
// Приоритет: явный dateFrom/dateTo → месяц → крайние даты в проводках.
function _resolvePeriodBounds(filter, allEntries) {
  let from = filter.dateFrom || '';
  let to = filter.dateTo || '';
  if ((!from || !to) && filter.month) {
    const r = monthToDateRange(filter.month);
    from = from || r.from;
    to = to || r.to;
  }
  if (!from || !to) {
    const dates = allEntries.map((e) => e.date).filter(Boolean).sort();
    if (dates.length) {
      from = from || dates[0];
      to = to || dates[dates.length - 1];
    }
  }
  return { from, to };
}

// Итоги по квартирам для таблицы в референсе «Реалти».
// Логика:
//   • Период = filter.dateFrom – filter.dateTo (включительно).
//   • Для брони берём ТОЛЬКО ночи, попавшие в период.
//     → income и platformCommission берутся ПРОПОРЦИОНАЛЬНО (nightsInPeriod / totalNights).
//   • Если у брони нет begin/end — fallback: включаем целиком, если entry.date внутри периода
//     (ручные доходы), ночи не считаются.
//   • Расходы — по entry.date внутри периода (т.е. когда расход был совершён).
//   • Итоговая прибыль = доход (чистый) − все расходы (вкл. уборку, аренду и т.п.).
//   • Загрузка = проданных ночей в периоде / длина периода.
//   • ADR = чистый доход / проданные ночи.
//   • Среднесуточный доход = чистый доход / длина периода.
//   • Средняя длит. проживания — по ЦЕЛЫМ броням, чьи ночи попали в период,
//     как total_nights / число_броней — чтобы отражать реальную длину бронирований.

// =============================================================================
// АСИНХРОННАЯ версия: читает брони НАПРЯМУЮ из rc_bookings
// в Supabase, минуя кешированный state.finance.entries.
// Это единственный надёжный способ — локальный синк в прошлом терял
// брони и делал дубли. Расходы по-прежнему берём из state.finance.entries.
// =============================================================================
export async function getFinanceApartmentSummaryAsync() {
  const state = getState();
  const filter = state.ui?.finance || {};
  const supabase = getSupabaseClient();
  const user = supabase ? await requireUser() : null;

  // 1) Определяем период (так же как в синхронной версии).
  const rawEntries = state.finance?.entries || [];
  const { from, to } = _resolvePeriodBounds(filter, rawEntries);
  const periodDays = from && to ? Math.max(1, _nightsBetween(from, to) + 1) : 0;

  // 2) Загружаем брони из rc_bookings напрямую.
  let bookings = [];
  if (supabase && user) {
    const { data, error } = await supabase
      .from('rc_bookings')
      .select('booking_id, realty_id, apartment_title, begin_date, end_date, amount, status, raw_payload, platform_tax')
      .eq('user_id', user.id)
      .not('status', 'in', '(canceled,deleted)')
      .limit(2000);
    if (error) console.warn('[finance] rc_bookings fetch error:', error.message);
    else bookings = data || [];
  }

  // 3) Строим строки по квартирам.
  const rows = new Map();
  const ensureRow = (id, name) => {
    if (!rows.has(id)) {
      rows.set(id, {
        apartmentId: id, name: name || '—',
        income: 0, grossIncome: 0, platformCommission: 0, expense: 0,
        soldNights: 0, bookings: 0, totalNightsForStayAvg: 0,
      });
    }
    return rows.get(id);
  };

  const aptFilter = filter.apartmentFilter && filter.apartmentFilter !== 'all' ? filter.apartmentFilter : '';
  // Карта realty_id → apartment.
  const rcMap = new Map();
  (state.apartments || []).forEach((a) => {
    if (a.archived) return;
    if (aptFilter && a.id !== aptFilter) return;
    ensureRow(a.id, getDisplayApartmentName(a.name));
    const rc = a.externalIds?.realtyCalendarUnitId;
    if (rc) rcMap.set(String(rc), a);
  });

  // 4) Доход от броней — из rc_bookings.
  bookings.forEach((b) => {
    const apt = rcMap.get(String(b.realty_id));
    if (!apt) return;
    if (aptFilter && apt.id !== aptFilter) return;
    const bd = b.begin_date;
    const ed = b.end_date;
    const totalNights = _nightsBetween(bd, ed);
    if (totalNights <= 0) return;
    const nightsIn = _bookingNightsInPeriod(bd, ed, from, to);
    if (nightsIn <= 0) return;
    const gross = Number(b.amount || 0);
    const tax = Number(b.raw_payload?.data?.booking?.platform_tax ?? b.platform_tax ?? 0);
    const net = Math.max(0, gross - tax);
    const share = nightsIn / totalNights;
    const row = ensureRow(apt.id, getDisplayApartmentName(apt.name));
    row.grossIncome += gross * share;
    row.platformCommission += tax * share;
    row.income += net * share;
    row.soldNights += nightsIn;
    row.bookings += 1;
    row.totalNightsForStayAvg += totalNights;
  });

  // 5) Расходы и ручные доходы — из state.finance.entries.
  rawEntries.forEach((e) => {
    if (!e.apartmentId) return;
    if (aptFilter && e.apartmentId !== aptFilter) return;
    if (e.status === 'cancelled') return;
    // Брони realtycalendar уже взяты из rc_bookings — пропускаем их здесь.
    if (e.source === 'realtycalendar' && e.type === FINANCE_TYPES.income) return;
    const gross = Number(e.amount || 0);
    const tax = Number(e.meta?.platform_tax || 0);
    const net = Number(e.netAmount != null ? e.netAmount : Math.max(0, gross - tax));
    const row = ensureRow(e.apartmentId, e.apartmentName);
    if (e.type === FINANCE_TYPES.income) {
      // Ручной доход без дат заезда.
      if (from && to && e.date && (e.date < from || e.date > to)) return;
      row.grossIncome += gross;
      row.platformCommission += tax;
      row.income += net;
    } else if (e.type === FINANCE_TYPES.expense) {
      if (from && to && e.date && (e.date < from || e.date > to)) return;
      row.expense += gross;
    }
  });

  // 6) Формируем вывод (тот же шейп, что в синхронной версии).
  const list = Array.from(rows.values()).map((r) => {
    const profit = r.income - r.expense;
    const availableNights = periodDays;
    const occupancy = availableNights > 0 ? Math.min(100, (r.soldNights / availableNights) * 100) : 0;
    const adr = r.soldNights > 0 ? r.income / r.soldNights : 0;
    const avgDaily = periodDays > 0 ? r.income / periodDays : 0;
    const avgStay = r.bookings > 0 ? r.totalNightsForStayAvg / r.bookings : 0;
    return {
      apartmentId: r.apartmentId, name: r.name,
      income: r.income, grossIncome: r.grossIncome, platformCommission: r.platformCommission,
      expense: r.expense, soldNights: r.soldNights, bookings: r.bookings,
      profit, availableNights, occupancy, adr, avgDaily, avgStay,
    };
  });

  const totals = list.reduce(
    (acc, r) => {
      acc.income += r.income; acc.grossIncome += r.grossIncome; acc.platformCommission += r.platformCommission;
      acc.expense += r.expense; acc.profit += r.profit;
      acc.soldNights += r.soldNights; acc.bookings += r.bookings;
      return acc;
    },
    { income: 0, grossIncome: 0, platformCommission: 0, expense: 0, profit: 0, soldNights: 0, bookings: 0 },
  );
  const totalAvailable = periodDays * list.length;
  totals.availableNights = totalAvailable;
  totals.occupancy = totalAvailable > 0 ? Math.min(100, (totals.soldNights / totalAvailable) * 100) : 0;
  totals.adr = totals.soldNights > 0 ? totals.income / totals.soldNights : 0;
  totals.avgDaily = totalAvailable > 0 ? totals.income / totalAvailable : 0;
  const totalStayNights = list.reduce((s, r) => s + (r.avgStay * r.bookings), 0);
  totals.avgStay = totals.bookings > 0 ? totalStayNights / totals.bookings : 0;

  return { rows: list, totals, period: { from, to, days: periodDays } };
}

export function getFinanceApartmentSummary() {
  const state = getState();
  const filter = state.ui?.finance || {};
  const rawEntries = state.finance?.entries || [];
  // Защита от дублей: отбрасываем повторные realtycalendar-проводки с одинаковым externalBookingId.
  const _seenExt = new Set();
  const allEntries = [];
  for (const e of rawEntries) {
    if (e?.source === 'realtycalendar' && e?.externalBookingId) {
      const key = String(e.externalBookingId);
      if (_seenExt.has(key)) continue;
      _seenExt.add(key);
    }
    allEntries.push(e);
  }
  const { from, to } = _resolvePeriodBounds(filter, allEntries);
  const periodDays = from && to ? Math.max(1, _nightsBetween(from, to) + 1) : 0;

  const rows = new Map();
  const ensureRow = (id, name) => {
    if (!rows.has(id)) {
      rows.set(id, {
        apartmentId: id,
        name: name || '—',
        income: 0,               // чистый доход в периоде (валовый − комиссия площадки)
        grossIncome: 0,          // валовый доход в периоде (опорно для ADR/среднесуточного если что)
        platformCommission: 0,   // комиссия площадки в периоде (пропорционально)
        expense: 0,              // все расходы в периоде (уборка, аренда и т.п.)
        soldNights: 0,           // проданные ночи в периоде
        bookings: 0,             // броней в периоде (чьи ночи частично/полностью попадают)
        totalNightsForStayAvg: 0,// полные ночи этих броней (для средней длит. проживания)
      });
    }
    return rows.get(id);
  };

  // Статус фильтра по квартире — если выбрана одна, остальные в таблице не показываем.
  const aptFilter = filter.apartmentFilter && filter.apartmentFilter !== 'all' ? filter.apartmentFilter : '';
  // Сначала добавляем ВСЕ (не архивные) квартиры — чтобы квартиры без броней тоже попадали в таблицу.
  (state.apartments || []).forEach((a) => {
    if (a.archived) return;
    if (aptFilter && a.id !== aptFilter) return;
    ensureRow(a.id, getDisplayApartmentName(a.name));
  });

  // Теперь идём по ВСЕМ записям финучёта (без фильтра по дате в проводке) — для броней
  // мы сами вычислим пересечение ночей с периодом.
  allEntries.forEach((e) => {
    if (!e.apartmentId) return;
    if (aptFilter && e.apartmentId !== aptFilter) return;

    // Мелкий фильтр по типу (если пользователь выбрал «только доходы» или «только расходы»).
    const typeFilter = filter.typeFilter && filter.typeFilter !== 'all' ? filter.typeFilter : '';
    if (typeFilter && e.type !== typeFilter) return;

    // Исключаем отменённые/удалённые брони (не считаются как доход).
    if (e.status === 'cancelled') return;

    const row = ensureRow(e.apartmentId, e.apartmentName);
    const gross = Number(e.amount || 0);
    const tax = Number(e.meta?.platform_tax || 0);
    const net = Number(e.netAmount != null ? e.netAmount : Math.max(0, gross - tax));

    if (e.type === FINANCE_TYPES.income) {
      const bd = e.meta?.begin_date;
      const ed = e.meta?.end_date;
      const totalNights = _nightsBetween(bd, ed);
      if (totalNights > 0) {
        // Реальная бронь: берём пересечение с периодом.
        const nightsIn = _bookingNightsInPeriod(bd, ed, from, to);
        if (nightsIn <= 0) return;
        const share = nightsIn / totalNights;
        row.grossIncome += gross * share;
        row.platformCommission += tax * share;
        row.income += net * share;
        row.soldNights += nightsIn;
        row.bookings += 1;
        row.totalNightsForStayAvg += totalNights;
      } else {
        // Ручная запись без дат заезда/выезда — считаем по entry.date.
        if (from && to && e.date && (e.date < from || e.date > to)) return;
        row.grossIncome += gross;
        row.platformCommission += tax;
        row.income += net;
      }
    } else if (e.type === FINANCE_TYPES.expense) {
      if (from && to && e.date && (e.date < from || e.date > to)) return;
      row.expense += gross;
    }
  });

  const list = Array.from(rows.values()).map((r) => {
    const profit = r.income - r.expense; // Прибыль = чистый доход − все расходы
    const availableNights = periodDays; // 1 квартира × дней периода
    const occupancy = availableNights > 0 ? Math.min(100, (r.soldNights / availableNights) * 100) : 0;
    const adr = r.soldNights > 0 ? r.income / r.soldNights : 0;
    const avgDaily = periodDays > 0 ? r.income / periodDays : 0;
    const avgStay = r.bookings > 0 ? r.totalNightsForStayAvg / r.bookings : 0;
    return {
      apartmentId: r.apartmentId,
      name: r.name,
      income: r.income,
      grossIncome: r.grossIncome,
      platformCommission: r.platformCommission,
      expense: r.expense,
      soldNights: r.soldNights,
      bookings: r.bookings,
      profit,
      availableNights,
      occupancy,
      adr,
      avgDaily,
      avgStay,
    };
  });

  // Итоги: суммы + агрегатные показатели.
  const totals = list.reduce(
    (acc, r) => {
      acc.income += r.income;
      acc.grossIncome += r.grossIncome;
      acc.platformCommission += r.platformCommission;
      acc.expense += r.expense;
      acc.profit += r.profit;
      acc.soldNights += r.soldNights;
      acc.bookings += r.bookings;
      return acc;
    },
    { income: 0, grossIncome: 0, platformCommission: 0, expense: 0, profit: 0, soldNights: 0, bookings: 0 },
  );
  const totalAvailable = periodDays * list.length;
  totals.availableNights = totalAvailable;
  totals.occupancy = totalAvailable > 0 ? Math.min(100, (totals.soldNights / totalAvailable) * 100) : 0;
  totals.adr = totals.soldNights > 0 ? totals.income / totals.soldNights : 0;
  totals.avgDaily = totalAvailable > 0 ? totals.income / totalAvailable : 0;
  const totalStayNights = list.reduce((s, r) => s + (r.avgStay * r.bookings), 0);
  totals.avgStay = totals.bookings > 0 ? totalStayNights / totals.bookings : 0;

  return { rows: list, totals, period: { from, to, days: periodDays } };
}

export function getFinanceSummary() {
  const entries = getFilteredFinanceEntries();
  const totals = entries.reduce(
    (acc, entry) => {
      const gross = Number(entry.amount || 0);
      const net = Number(entry.netAmount != null ? entry.netAmount : entry.amount || 0);
      if (entry.type === FINANCE_TYPES.income) { acc.income += gross; acc.netIncome += net; }
      if (entry.type === FINANCE_TYPES.expense) { acc.expense += gross; }
      return acc;
    },
    { income: 0, netIncome: 0, expense: 0 }
  );
  // Итоги по квартирам (из всего массива, без фильтра)
  const state = getState();
  const byApartment = {};
  state.finance.entries.forEach((entry) => {
    if (!byApartment[entry.apartmentId]) {
      byApartment[entry.apartmentId] = { name: entry.apartmentName, income: 0, netIncome: 0, expense: 0 };
    }
    const gross = Number(entry.amount || 0);
    const net = Number(entry.netAmount != null ? entry.netAmount : entry.amount || 0);
    if (entry.type === 'income') { byApartment[entry.apartmentId].income += gross; byApartment[entry.apartmentId].netIncome += net; }
    if (entry.type === 'expense') byApartment[entry.apartmentId].expense += gross;
  });
  return {
    income: totals.income,
    netIncome: totals.netIncome,
    expense: totals.expense,
    profit: totals.income - totals.expense,
    netProfit: totals.netIncome - totals.expense,
    entries,
    recurring: state.finance.recurringRules,
    byApartment,
  };
}
