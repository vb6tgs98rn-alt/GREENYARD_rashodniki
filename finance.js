import { currentApartment, findApartmentById, getDisplayApartmentName, getState, updateState } from './state.js';

export const FINANCE_TYPES = { income: 'income', expense: 'expense' };

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
  return { id: crypto.randomUUID(), apartmentId: apartment?.id || '', apartmentName: getDisplayApartmentName(apartment?.name || '—'), type: data.type || FINANCE_TYPES.expense, category: data.category || '', title: data.title || '', amount: Number(data.amount || 0), currency: data.currency || 'RUB', date: data.date || new Date().toISOString().slice(0, 10), source: data.source || 'manual', status: data.status || 'planned', notes: data.notes || '', externalBookingId: data.externalBookingId || '', meta: data.meta || {} };
}

export function createRecurringRuleDraft(data = {}) {
  const apartment = findApartmentById(data.apartmentId) || currentApartment();
  return { id: crypto.randomUUID(), apartmentId: apartment?.id || '', apartmentName: getDisplayApartmentName(apartment?.name || '—'), title: data.title || '', category: data.category || '', amount: Number(data.amount || 0), currency: data.currency || 'RUB', type: data.type || FINANCE_TYPES.expense, dayOfMonth: Number(data.dayOfMonth || 1), startDate: data.startDate || new Date().toISOString().slice(0, 10), endDate: data.endDate || '', notes: data.notes || '', active: data.active ?? true };
}

export function addFinanceEntry(entry) {
  const normalized = createFinanceEntryDraft(entry);
  updateState((state) => { state.finance.entries.unshift(normalized); });
  return normalized;
}

export function addRecurringRule(rule) {
  const normalized = createRecurringRuleDraft(rule);
  updateState((state) => { state.finance.recurringRules.unshift(normalized); });
  return normalized;
}

export function generateRecurringEntriesForMonth(month) {
  if (!month) return [];
  const created = [];
  updateState((state) => {
    const existingKeys = new Set(state.finance.entries.filter((entry) => entry.source === 'recurring').map((entry) => `${entry.meta?.ruleId || ''}:${entry.date}`));
    state.finance.recurringRules.forEach((rule) => {
      if (!rule.active) return;
      const dueDate = `${month}-${String(Math.min(Math.max(rule.dayOfMonth || 1, 1), 28)).padStart(2, '0')}`;
      if (rule.startDate && dueDate < rule.startDate) return;
      if (rule.endDate && dueDate > rule.endDate) return;
      const key = `${rule.id}:${dueDate}`;
      if (existingKeys.has(key)) return;
      const entry = createFinanceEntryDraft({ apartmentId: rule.apartmentId, type: rule.type, category: rule.category, title: rule.title, amount: rule.amount, currency: rule.currency, date: dueDate, source: 'recurring', status: 'planned', notes: rule.notes, meta: { ruleId: rule.id } });
      state.finance.entries.push(entry);
      created.push(entry);
      existingKeys.add(key);
    });
  });
  return created;
}

export function importBookingsToFinance(bookings = []) {
  const added = [];
  updateState((state) => {
    const existing = new Set(state.finance.entries.filter((entry) => entry.externalBookingId).map((entry) => entry.externalBookingId));
    bookings.forEach((booking) => {
      if (!booking.externalBookingId || existing.has(booking.externalBookingId)) return;
      let apartment = state.apartments.find((item) => item.externalIds?.realtyCalendarUnitId && item.externalIds.realtyCalendarUnitId === booking.apartmentExternalId);
      if (!apartment && booking.apartmentId) apartment = state.apartments.find((item) => item.id === booking.apartmentId);
      if (!apartment) return;
      const entry = createFinanceEntryDraft({ apartmentId: apartment.id, type: FINANCE_TYPES.income, category: 'Бронирование', title: `${booking.channel || 'RealtyCalendar'} · ${booking.guestName || 'Гость'}`, amount: booking.amount, currency: booking.currency || 'RUB', date: booking.checkIn || new Date().toISOString().slice(0, 10), source: 'realtycalendar', status: booking.status === 'cancelled' ? 'cancelled' : 'confirmed', notes: `${booking.checkIn || '—'} → ${booking.checkOut || '—'}`, externalBookingId: booking.externalBookingId, meta: booking });
      state.finance.entries.unshift(entry);
      added.push(entry);
      existing.add(booking.externalBookingId);
    });
    state.finance.bookingSync.lastSyncedAt = new Date().toISOString();
  });
  return added;
}

export function getFilteredFinanceEntries() {
  const state = getState();
  const filter = state.ui.finance || {};
  return state.finance.entries.filter((entry) => {
    if (filter.apartmentFilter && filter.apartmentFilter !== 'all' && entry.apartmentId !== filter.apartmentFilter) return false;
    if (filter.typeFilter && filter.typeFilter !== 'all' && entry.type !== filter.typeFilter) return false;
    if (filter.month && monthKey(entry.date) !== filter.month) return false;
    if (filter.showOnlyPending && !['planned', 'pending'].includes(entry.status)) return false;
    return true;
  }).sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export function getFinanceSummary() {
  const entries = getFilteredFinanceEntries();
  const totals = entries.reduce((acc, entry) => { if (entry.type === FINANCE_TYPES.income) acc.income += Number(entry.amount || 0); if (entry.type === FINANCE_TYPES.expense) acc.expense += Number(entry.amount || 0); return acc; }, { income: 0, expense: 0 });
  return { income: totals.income, expense: totals.expense, profit: totals.income - totals.expense, entries, recurring: getState().finance.recurringRules };
}
