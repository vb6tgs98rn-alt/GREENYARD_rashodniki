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

export function computeUnitEcoReport(apartmentId, { startDate, endDate }, filters = {}) {
  const state = getState();
  const apt = (state.apartments || []).find((a) => a.id === apartmentId);
  if (!apt || !startDate || !endDate) return null;

  const type = filters.type || 'all';
  const category = filters.category || 'all';
  const source = filters.source || 'all';
  const status = filters.status || 'active';

  const ruleKindById = new Map();
  (state.finance.recurringRules || []).forEach((r) => ruleKindById.set(r.id, r.kind || 'other'));

  const stat = {
    grossIncome: 0, platformTax: 0, netIncome: 0,
    expense: 0, cleaning: 0, rent: 0, internet: 0, utilities: 0, subscription: 0, otherExpense: 0,
    bookings: 0, nights: 0,
    cancelledBookings: 0, cancelledAmount: 0,
    plannedExpense: 0, confirmedExpense: 0,
    profit: 0, roi: 0, adr: 0,
  };
  const entries = [];

  (state.finance.entries || []).forEach((e) => {
    if (e.apartmentId !== apartmentId) return;
    const date = e.date || '';
    if (!date || date < startDate || date > endDate) return;

    if (e.status === 'cancelled') {
      if (e.type === FINANCE_TYPES.income && e.source === 'realtycalendar' && !String(e.externalBookingId || '').endsWith(':cleaning')) {
        stat.cancelledBookings += 1;
        stat.cancelledAmount += Number(e.amount || 0);
      }
      if (status !== 'all' && status !== 'cancelled') return;
    } else {
      if (status !== 'active' && status !== 'all' && e.status !== status) return;
    }

    if (type !== 'all' && e.type !== type) return;
    if (source !== 'all' && e.source !== source) return;

    let expenseKind = 'other';
    if (e.type === FINANCE_TYPES.expense) {
      if (e.category === 'Уборка' || e.meta?.kind === 'cleaning') expenseKind = 'cleaning';
      else if (e.source === 'recurring' && e.meta?.ruleId) expenseKind = ruleKindById.get(e.meta.ruleId) || 'other';
    }
    if (category !== 'all' && e.type === FINANCE_TYPES.expense && expenseKind !== category) return;

    entries.push(e);
    const gross = Number(e.amount || 0);
    const net = Number(e.netAmount != null ? e.netAmount : gross);

    if (e.type === FINANCE_TYPES.income) {
      if (e.status !== 'cancelled') {
        stat.grossIncome += gross;
        stat.netIncome += net;
        stat.platformTax += Math.max(0, gross - net);
        if (e.source === 'realtycalendar' && !String(e.externalBookingId || '').endsWith(':cleaning')) {
          stat.bookings += 1;
          const bd = e.meta?.begin_date; const ed = e.meta?.end_date;
          if (bd && ed) stat.nights += Math.max(0, Math.round((new Date(ed) - new Date(bd)) / 86400000));
        }
      }
    } else if (e.type === FINANCE_TYPES.expense && e.status !== 'cancelled') {
      stat.expense += gross;
      if (expenseKind === 'cleaning') stat.cleaning += gross;
      else if (expenseKind === 'rent') stat.rent += gross;
      else if (expenseKind === 'internet') stat.internet += gross;
      else if (expenseKind === 'utilities') stat.utilities += gross;
      else if (expenseKind === 'subscription') stat.subscription += gross;
      else stat.otherExpense += gross;
      if (e.status === 'planned') stat.plannedExpense += gross;
      else if (e.status === 'confirmed') stat.confirmedExpense += gross;
    }
  });

  stat.profit = stat.netIncome - stat.expense;
  stat.roi = stat.expense > 0 ? (stat.profit / stat.expense) * 100 : 0;
  stat.adr = stat.nights > 0 ? stat.netIncome / stat.nights : 0;
  return { stat, entries, period: { startDate, endDate }, apartment: { id: apt.id, name: getDisplayApartmentName(apt.name) } };
}

export function computeUnitEconomics({ dateFrom = '', dateTo = '' } = {}) {
  const state = getState();
  const apartments = state.apartments || [];
  const entries = state.finance.entries || [];

  const inRange = (date) => {
    if (!date) return false;
    if (dateFrom && date < dateFrom) return false;
    if (dateTo && date > dateTo) return false;
    return true;
  };

  const empty = () => ({
    grossIncome: 0,
    platformTax: 0,
    netIncome: 0,
    cleaning: 0,
    rent: 0,
    internet: 0,
    utilities: 0,
    subscription: 0,
    otherExpense: 0,
    expense: 0,
    profit: 0,
    roi: 0,
    bookings: 0,
    nights: 0,
  });

  // Карта правил → kind (для регулярных расходов).
  const ruleKindById = new Map();
  (state.finance.recurringRules || []).forEach((r) => ruleKindById.set(r.id, r.kind || 'other'));

  const byApartment = new Map();
  apartments.forEach((apt) => {
    byApartment.set(apt.id, { id: apt.id, name: getDisplayApartmentName(apt.name), ...empty() });
  });

  entries.forEach((e) => {
    if (!inRange(e.date)) return;
    if (e.status === 'cancelled') return;
    const apt = byApartment.get(e.apartmentId);
    if (!apt) return;

    const gross = Number(e.amount || 0);
    const net = Number(e.netAmount != null ? e.netAmount : gross);

    if (e.type === FINANCE_TYPES.income) {
      apt.grossIncome += gross;
      apt.netIncome += net;
      apt.platformTax += Math.max(0, gross - net);
      if (e.source === 'realtycalendar' && !String(e.externalBookingId || '').endsWith(':cleaning')) {
        apt.bookings += 1;
        const begin = e.meta?.begin_date;
        const end = e.meta?.end_date;
        if (begin && end) {
          const d1 = new Date(begin); const d2 = new Date(end);
          const n = Math.max(0, Math.round((d2 - d1) / 86400000));
          apt.nights += n;
        }
      }
    } else if (e.type === FINANCE_TYPES.expense) {
      // Категоризация расходов
      let kind = 'other';
      if (e.category === 'Уборка' || e.meta?.kind === 'cleaning') kind = 'cleaning';
      else if (e.source === 'recurring' && e.meta?.ruleId) {
        kind = ruleKindById.get(e.meta.ruleId) || 'other';
      }
      apt.expense += gross;
      if (kind === 'cleaning') apt.cleaning += gross;
      else if (kind === 'rent') apt.rent += gross;
      else if (kind === 'internet') apt.internet += gross;
      else if (kind === 'utilities') apt.utilities += gross;
      else if (kind === 'subscription') apt.subscription += gross;
      else apt.otherExpense += gross;
    }
  });

  const rows = Array.from(byApartment.values()).map((r) => {
    r.profit = r.netIncome - r.expense;
    r.roi = r.expense > 0 ? (r.profit / r.expense) * 100 : 0;
    r.adr = r.nights > 0 ? r.netIncome / r.nights : 0;
    return r;
  }).sort((a, b) => b.profit - a.profit);

  const totals = rows.reduce((acc, r) => {
    acc.grossIncome += r.grossIncome;
    acc.platformTax += r.platformTax;
    acc.netIncome += r.netIncome;
    acc.cleaning += r.cleaning;
    acc.rent += r.rent;
    acc.internet += r.internet;
    acc.utilities += r.utilities;
    acc.subscription += r.subscription;
    acc.otherExpense += r.otherExpense;
    acc.expense += r.expense;
    acc.bookings += r.bookings;
    acc.nights += r.nights;
    return acc;
  }, empty());
  totals.profit = totals.netIncome - totals.expense;
  totals.roi = totals.expense > 0 ? (totals.profit / totals.expense) * 100 : 0;
  totals.adr = totals.nights > 0 ? totals.netIncome / totals.nights : 0;

  return { rows, totals, period: { dateFrom, dateTo } };
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
