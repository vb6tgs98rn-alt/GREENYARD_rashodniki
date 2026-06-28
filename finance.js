import { currentApartment, findApartmentById, getDisplayApartmentName, getState, updateState } from './state.js';

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

export function createRecurringRuleDraft(data = {}) {
  const apartment = findApartmentById(data.apartmentId) || currentApartment();
  return {
    id: crypto.randomUUID(),
    apartmentId: apartment?.id || '',
    apartmentName: getDisplayApartmentName(apartment?.name || '—'),
    title: data.title || '',
    category: data.category || '',
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
export function applyRealtyCalendarBookings(bookings = []) {
  const result = { added: 0, updated: 0, removed: 0, skipped: 0 };
  updateState((state) => {
    const existingByBookingId = new Map();
    state.finance.entries.forEach((entry, idx) => {
      if (entry.source === 'realtycalendar' && entry.externalBookingId) {
        existingByBookingId.set(String(entry.externalBookingId), { entry, idx });
      }
    });

    bookings.forEach((b) => {
      const bookingId = String(b.booking_id);
      const apartment = findApartmentByRealtyId(state, b.realty_id);

      // Отменённые/удалённые — убираем из финучёта
      if (b.status === 'canceled' || b.status === 'deleted') {
        if (existingByBookingId.has(bookingId)) {
          state.finance.entries = state.finance.entries.filter(
            (e) => !(e.source === 'realtycalendar' && String(e.externalBookingId) === bookingId)
          );
          existingByBookingId.delete(bookingId);
          result.removed++;
        }
        return;
      }

      // Квартира не привязана — пропускаем
      if (!apartment) { result.skipped++; return; }

      // Активная бронь — обновляем или создаём
      const date = (b.rc_created_at ? String(b.rc_created_at).slice(0, 10) : '') || b.begin_date || new Date().toISOString().slice(0, 10);
      const title = `Бронь #${b.booking_id}${b.client_fio ? ' · ' + b.client_fio : ''}`;
      const notes = [
        formatRange(b.begin_date, b.end_date),
        b.client_phone || '',
        b.source ? `Источник: ${b.source}` : '',
        b.booking_url || ''
      ].filter(Boolean).join(' · ');

      const payload = {
        apartmentId: apartment.id,
        type: FINANCE_TYPES.income,
        category: 'Бронирование',
        title,
        amount: Number(b.amount || 0),
        netAmount: Number(b.prepayment || 0),
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
          booking_url: b.booking_url,
          rc_status: b.status,
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

export function getFilteredFinanceEntries() {
  const state = getState();
  const filter = state.ui.finance || {};
  return state.finance.entries
    .filter((entry) => {
      if (filter.apartmentFilter && filter.apartmentFilter !== 'all' && entry.apartmentId !== filter.apartmentFilter) return false;
      if (filter.typeFilter && filter.typeFilter !== 'all' && entry.type !== filter.typeFilter) return false;
      if (filter.month && monthKey(entry.date) !== filter.month) return false;
      if (filter.showOnlyPending && !['planned', 'pending'].includes(entry.status)) return false;
      return true;
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
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
