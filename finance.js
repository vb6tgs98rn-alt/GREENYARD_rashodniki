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
          // Старые автоуборки НЕ перецениваем: если цена уборки в настройках изменилась,
          // у уже созданных записей оставляем прежнюю сумму. Новая цена применится только к новым броням.
          const { entry, idx } = existingByBookingId.get(cleaningId);
          state.finance.entries[idx] = {
            ...entry,
            // обновляем только отображаемые поля, без amount/netAmount:
            apartmentId: cleaningPayload.apartmentId,
            type: cleaningPayload.type,
            category: cleaningPayload.category,
            title: cleaningPayload.title,
            date: cleaningPayload.date,
            source: cleaningPayload.source,
            status: entry.status || cleaningPayload.status,
            notes: entry.notes || cleaningPayload.notes,
            externalBookingId: cleaningPayload.externalBookingId,
            meta: cleaningPayload.meta,
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
// Автосписания: аренда (субаренда) / выплата собственнику (ДУ)
// =============================================================================
// Создаёт по одной записи на каждый цикл (месяц), в котором есть день оплаты.
// - Субаренда: source='auto-rent', сумма = rentAmount, дата = день оплаты (сдвиг на конец месяца, если дня нет).
// - ДУ: source='auto-owner-payout', сумма = прибыль цикла × (100 − trustShare) / 100, дата = день выплаты.
// externalBookingId = 'auto-rent:<aptId>:<YYYY-MM>' или 'auto-owner-payout:<aptId>:<YYYY-MM>' — для дедупа.
function _clampDayToMonth(year, month1, day) {
  const last = new Date(year, month1, 0).getDate();
  return Math.min(last, day);
}

export function regenerateAutoRentEntries(apartmentId, options = {}) {
  const { removeManualDuplicates = false } = options;
  const state = getState();
  const apt = (state.apartments || []).find((a) => a.id === apartmentId);
  if (!apt) return;
  const paymentDay = Math.trunc(Number(apt.paymentDay || 0));
  const model = apt.businessModel === 'trust' ? 'trust' : 'sublease';
  const trustShare = Math.min(100, Math.max(0, Number(apt.trustShare || 0)));
  const rentAmount = Math.max(0, Number(apt.rentAmount || 0));

  // 1) Удаляем все прежние автозаписи этой квартиры (чтобы не было дублей/старых сумм).
  state.finance.entries = state.finance.entries.filter((e) => {
    if (e.apartmentId !== apartmentId) return true;
    return !(e.source === 'auto-rent' || e.source === 'auto-owner-payout');
  });

  // 1б) Опционально: удаляем ручные записи-аренды/выплаты собу (только при сохранении настроек).
  if (removeManualDuplicates) {
    state.finance.entries = state.finance.entries.filter((e) => {
      if (e.apartmentId !== apartmentId) return true;
      if (e.type !== FINANCE_TYPES.expense) return true;
      if (e.source === 'realtycalendar') return true;
      const hay = `${e.category || ''} ${e.title || ''}`.toLowerCase();
      const isRent = hay.includes('аренд');
      const isOwnerPayout = hay.includes('выплат') && hay.includes('соб');
      return !(isRent || isOwnerPayout);
    });
  }

  // 2) Если день оплаты не задан — выходим (автосписаний нет).
  if (!(paymentDay >= 1 && paymentDay <= 31)) return;

  // 3) Для субаренды: без стоимости — автосписаний нет.
  if (model === 'sublease' && !(rentAmount > 0)) return;
  // Для ДУ: без доли УК (100%) собственнику ничего не полагается (но всё равно генерим — сумму увидим 0, если что).

  // 4) Определяем месяцы: генерим автосписания только на текущий месяц
  //    (так не будет взрыва записей на старые квартиры). Прошлые месяцы — если пользователь
  //    перелистывает циклы стрелками, мы будем генерить автосписания во всех видимых месяцах отдельно.
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth() + 1; // 1..12
  _ensureAutoRentEntryForMonth(state, apt, y, m);
}

// Генерация автосписания на конкретный месяц (year, month1: 1..12). Используется из навигации по циклам.
export function ensureAutoRentEntryForMonth(apartmentId, year, month1) {
  const state = getState();
  const apt = (state.apartments || []).find((a) => a.id === apartmentId);
  if (!apt) return;
  _ensureAutoRentEntryForMonth(state, apt, year, month1);
}

// Перегенерация автосписаний для всех квартир. Безопасно вызывать в бутстрапе.
export function regenerateAutoRentEntriesForAllApartments() {
  const state = getState();
  (state.apartments || []).forEach((a) => {
    if (a.archived) return;
    regenerateAutoRentEntries(a.id);
  });
}

function _ensureAutoRentEntryForMonth(state, apt, year, month1) {
  const paymentDay = Math.trunc(Number(apt.paymentDay || 0));
  if (!(paymentDay >= 1 && paymentDay <= 31)) return;
  const model = apt.businessModel === 'trust' ? 'trust' : 'sublease';
  const rentAmount = Math.max(0, Number(apt.rentAmount || 0));
  const trustShare = Math.min(100, Math.max(0, Number(apt.trustShare || 0)));

  const monthKeyStr = `${year}-${String(month1).padStart(2, '0')}`;
  const day = _clampDayToMonth(year, month1, paymentDay);
  const date = `${year}-${String(month1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

  if (model === 'sublease') {
    if (!(rentAmount > 0)) return;
    const extId = `auto-rent:${apt.id}:${monthKeyStr}`;
    // Существует?
    const existsIdx = state.finance.entries.findIndex((e) => e.source === 'auto-rent' && String(e.externalBookingId) === extId);
    const payload = {
      apartmentId: apt.id,
      apartmentName: getDisplayApartmentName(apt.name),
      type: FINANCE_TYPES.expense,
      category: 'Аренда',
      title: `Аренда за ${monthKeyStr}`,
      amount: rentAmount,
      netAmount: rentAmount,
      currency: 'RUB',
      date,
      source: 'auto-rent',
      status: 'planned',
      notes: `Автосписание аренды (${apt.rentSchedule === 'prepay' ? 'предоплата' : 'постоплата'}).`,
      externalBookingId: extId,
      meta: { kind: 'auto-rent', month: monthKeyStr, apartmentId: apt.id },
    };
    if (existsIdx >= 0) {
      state.finance.entries[existsIdx] = { ...state.finance.entries[existsIdx], ...payload };
    } else {
      state.finance.entries.unshift(createFinanceEntryDraft(payload));
    }
    return;
  }

  if (model === 'trust') {
    // Сумму выплаты собу считаем тут же — по текущему state (включая брони в entries).
    // Цикл: [день предыдущего месяца … день выплаты включительно).
    // Но по границе цикла: [paymentDay, paymentDay) — выбрал выше [start, end).
    // Значит для месяца M цикл: [payDay месяца M-1, payDay месяца M).
    const startY = month1 === 1 ? year - 1 : year;
    const startM = month1 === 1 ? 12 : month1 - 1;
    const startDay = _clampDayToMonth(startY, startM, paymentDay);
    const cycleStart = `${startY}-${String(startM).padStart(2, '0')}-${String(startDay).padStart(2, '0')}`;
    const cycleEndExclusive = date; // текущая выплата не включает себя

    const stats = _computeCycleStatsFromEntries(apt.id, cycleStart, cycleEndExclusive);
    const rawProfit = stats.income - stats.expense;
    const ownerPayout = rawProfit * (100 - trustShare) / 100;

    const extId = `auto-owner-payout:${apt.id}:${monthKeyStr}`;
    const existsIdx = state.finance.entries.findIndex((e) => e.source === 'auto-owner-payout' && String(e.externalBookingId) === extId);
    // Если выплата ≤ 0 (убыток) — не создаём запись.
    if (!(ownerPayout > 0)) {
      if (existsIdx >= 0) state.finance.entries.splice(existsIdx, 1);
      return;
    }
    const payload = {
      apartmentId: apt.id,
      apartmentName: getDisplayApartmentName(apt.name),
      type: FINANCE_TYPES.expense,
      category: 'Выплата собственнику',
      title: `Выплата собу за цикл ${cycleStart} → ${cycleEndExclusive}`,
      amount: Math.round(ownerPayout),
      netAmount: Math.round(ownerPayout),
      currency: 'RUB',
      date,
      source: 'auto-owner-payout',
      status: 'planned',
      notes: `Автосписание выплаты собственнику (ДУ, доля УК ${trustShare}%).`,
      externalBookingId: extId,
      meta: { kind: 'auto-owner-payout', month: monthKeyStr, apartmentId: apt.id, trustShare, cycleStart, cycleEndExclusive },
    };
    if (existsIdx >= 0) {
      state.finance.entries[existsIdx] = { ...state.finance.entries[existsIdx], ...payload };
    } else {
      state.finance.entries.unshift(createFinanceEntryDraft(payload));
    }
  }
}

// Есть ли ручная запись-аренда в указанном месяце (чтобы не дублировать автосписание).
// Считаем ручной: type=expense и категория/название содержит "аренд", дата попадает в месяц, source не auto-rent и не realtycalendar.
function _hasManualRentInMonth(state, apartmentId, year, month1) {
  const prefix = `${year}-${String(month1).padStart(2, '0')}-`;
  return (state.finance.entries || []).some((e) => {
    if (e.apartmentId !== apartmentId) return false;
    if (e.type !== FINANCE_TYPES.expense) return false;
    if (e.source === 'auto-rent') return false;
    if (e.source === 'realtycalendar') return false;
    if (!e.date || !String(e.date).startsWith(prefix)) return false;
    const hay = `${e.category || ''} ${e.title || ''}`.toLowerCase();
    return hay.includes('аренд');
  });
}

function _hasManualOwnerPayoutInMonth(state, apartmentId, year, month1) {
  const prefix = `${year}-${String(month1).padStart(2, '0')}-`;
  return (state.finance.entries || []).some((e) => {
    if (e.apartmentId !== apartmentId) return false;
    if (e.type !== FINANCE_TYPES.expense) return false;
    if (e.source === 'auto-owner-payout') return false;
    if (!e.date || !String(e.date).startsWith(prefix)) return false;
    const hay = `${e.category || ''} ${e.title || ''}`.toLowerCase();
    return hay.includes('выплат') && hay.includes('соб');
  });
}

// Считает доход/расход квартиры в окне [startInclusive, endExclusive), беря строки из state.finance.entries.
// Автозаписи (авто-аренда, авто-выплата) в расчёт НЕ включаем — чтобы не было цикла.
function _computeCycleStatsFromEntries(apartmentId, startInclusive, endExclusive) {
  const state = getState();
  let income = 0;
  let expense = 0;
  (state.finance.entries || []).forEach((e) => {
    if (e.apartmentId !== apartmentId) return;
    if (e.source === 'auto-rent' || e.source === 'auto-owner-payout') return;
    if (!e.date) return;
    if (e.date < startInclusive || e.date >= endExclusive) return;
    const gross = Number(e.amount || 0);
    const net = Number(e.netAmount != null ? e.netAmount : e.amount || 0);
    if (e.type === FINANCE_TYPES.income) income += net;
    else if (e.type === FINANCE_TYPES.expense) expense += gross;
  });
  return { income, expense };
}

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
    // Авто-выплата собу в таблице учитывается отдельной колонкой — в expense не включаем.
    if (e.source === 'auto-owner-payout') return;
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
  // Система учёта: если «trust» и доля УК = N%, то:
  //   ownerPayout = исходная прибыль × (100 − N) / 100 — выплата собственнику
  //   profit в таблице = исходная прибыль − ownerPayout — что остаётся УК
  // Если «sublease» — ownerPayout = null (прочерк), profit = исходная прибыль.
  const list = Array.from(rows.values()).map((r) => {
    const apt = (state.apartments || []).find((a) => a.id === r.apartmentId);
    const model = apt?.businessModel === 'trust' ? 'trust' : 'sublease';
    const trustShare = Math.min(100, Math.max(0, Number(apt?.trustShare || 0)));
    const rawProfit = r.income - r.expense;
    let ownerPayout = null;
    let profit = rawProfit;
    if (model === 'trust') {
      ownerPayout = rawProfit * (100 - trustShare) / 100;
      profit = rawProfit - ownerPayout;
    }
    const availableNights = periodDays;
    const occupancy = availableNights > 0 ? Math.min(100, (r.soldNights / availableNights) * 100) : 0;
    const adr = r.soldNights > 0 ? r.income / r.soldNights : 0;
    const avgDaily = periodDays > 0 ? r.income / periodDays : 0;
    const avgStay = r.bookings > 0 ? r.totalNightsForStayAvg / r.bookings : 0;
    return {
      apartmentId: r.apartmentId, name: r.name,
      income: r.income, grossIncome: r.grossIncome, platformCommission: r.platformCommission,
      expense: r.expense, soldNights: r.soldNights, bookings: r.bookings,
      profit, ownerPayout, businessModel: model, trustShare,
      availableNights, occupancy, adr, avgDaily, avgStay,
    };
  });

  const totals = list.reduce(
    (acc, r) => {
      acc.income += r.income; acc.grossIncome += r.grossIncome; acc.platformCommission += r.platformCommission;
      acc.expense += r.expense; acc.profit += r.profit;
      acc.soldNights += r.soldNights; acc.bookings += r.bookings;
      // Выплата собственнику — только для объектов с ДУ (sublease даёт 0).
      if (r.businessModel === 'trust' && r.ownerPayout != null) {
        acc.ownerPayout += r.ownerPayout;
      }
      return acc;
    },
    { income: 0, grossIncome: 0, platformCommission: 0, expense: 0, profit: 0, soldNights: 0, bookings: 0, ownerPayout: 0 },
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

// ======================================================================
// Режим «Расчёт по циклам оплаты»: каждая квартира — своё окно [payDay pred, payDay tec).
// Квартиры без paymentDay — календарный месяц анкора. monthOffset: 0 = тек., -1 = прошл., +1 = буд.
// ======================================================================
export async function getFinanceCyclesSummaryAsync(offsetByApt = {}) {
  const state = getState();
  const supabase = getSupabaseClient();
  const user = supabase ? await requireUser() : null;

  const now = new Date();
  const todayY = now.getFullYear();
  const todayM = now.getMonth() + 1; // 1..12
  const todayD = now.getDate();

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

  const aptsWithCycle = [];
  const aptsNoDay = [];
  (state.apartments || []).forEach((a) => {
    if (a.archived) return;
    const pd = Math.trunc(Number(a.paymentDay || 0));
    if (pd >= 1 && pd <= 31) aptsWithCycle.push({ apt: a, paymentDay: pd });
    else aptsNoDay.push(a);
  });

  // Текущий цикл = окно, содержащее сегодня: [payDay месяца-старта, payDay след.месяца − 1 день].
  // offset 0 = тек., -1 = предыдущий, +1 = следующий.
  const _windowForApt = (paymentDay, offset) => {
    // Месяц-старт текущего цикла: если сегодня ≥ payDay текущего месяца — текущий, иначе прошлый.
    const startDayThis = _clampDayToMonth(todayY, todayM, paymentDay);
    let startY = todayY;
    let startM = todayM;
    if (todayD < startDayThis) {
      startM = todayM - 1;
      if (startM < 1) { startM = 12; startY -= 1; }
    }
    // Применяем offset — сдвиг цикла на N месяцев.
    const startDate = new Date(startY, startM - 1 + offset, 1);
    const sY = startDate.getFullYear();
    const sM = startDate.getMonth() + 1;
    const sDay = _clampDayToMonth(sY, sM, paymentDay);
    const from = `${sY}-${String(sM).padStart(2, '0')}-${String(sDay).padStart(2, '0')}`;
    // Конец = payDay следующего месяца − 1 день.
    const nextDate = new Date(sY, sM, 1);
    const nY = nextDate.getFullYear();
    const nM = nextDate.getMonth() + 1;
    const nDay = _clampDayToMonth(nY, nM, paymentDay);
    const endObj = new Date(nY, nM - 1, nDay);
    endObj.setDate(endObj.getDate() - 1);
    const to = `${endObj.getFullYear()}-${String(endObj.getMonth() + 1).padStart(2, '0')}-${String(endObj.getDate()).padStart(2, '0')}`;
    return { from, to };
  };

  // Окно «Прочих» (без payDay) = календарный месяц (текущий + offset).
  const _windowForNoDay = (offset) => {
    const d = new Date(todayY, todayM - 1 + offset, 1);
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const lastDay = new Date(y, m, 0).getDate();
    return {
      from: `${y}-${String(m).padStart(2, '0')}-01`,
      to: `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    };
  };

  const _buildRow = (apt, from, to) => {
    const row = {
      apartmentId: apt.id, name: getDisplayApartmentName(apt.name),
      income: 0, grossIncome: 0, platformCommission: 0, expense: 0,
      soldNights: 0, bookings: 0, totalNightsForStayAvg: 0,
    };
    const rc = apt.externalIds?.realtyCalendarUnitId;
    if (rc) {
      bookings.forEach((b) => {
        if (String(b.realty_id) !== String(rc)) return;
        const bd = b.begin_date, ed = b.end_date;
        const totalNights = _nightsBetween(bd, ed);
        if (totalNights <= 0) return;
        const nightsIn = _bookingNightsInPeriod(bd, ed, from, to);
        if (nightsIn <= 0) return;
        const gross = Number(b.amount || 0);
        const tax = Number(b.raw_payload?.data?.booking?.platform_tax ?? b.platform_tax ?? 0);
        const net = Math.max(0, gross - tax);
        const share = nightsIn / totalNights;
        row.grossIncome += gross * share;
        row.platformCommission += tax * share;
        row.income += net * share;
        row.soldNights += nightsIn;
        row.bookings += 1;
        row.totalNightsForStayAvg += totalNights;
      });
    }
    (state.finance?.entries || []).forEach((e) => {
      if (e.apartmentId !== apt.id) return;
      if (e.status === 'cancelled') return;
      if (e.source === 'realtycalendar' && e.type === FINANCE_TYPES.income) return;
      if (e.source === 'auto-owner-payout') return;
      if (!e.date) return;
      if (e.date < from || e.date > to) return;
      const gross = Number(e.amount || 0);
      const tax = Number(e.meta?.platform_tax || 0);
      const net = Number(e.netAmount != null ? e.netAmount : Math.max(0, gross - tax));
      if (e.type === FINANCE_TYPES.income) {
        row.grossIncome += gross;
        row.platformCommission += tax;
        row.income += net;
      } else if (e.type === FINANCE_TYPES.expense) {
        row.expense += gross;
      }
    });
    const periodDays = Math.max(1, _nightsBetween(from, to) + 1);
    const model = apt.businessModel === 'trust' ? 'trust' : 'sublease';
    const trustShare = Math.min(100, Math.max(0, Number(apt.trustShare || 0)));
    const rawProfit = row.income - row.expense;
    let ownerPayout = null;
    let profit = rawProfit;
    if (model === 'trust') {
      ownerPayout = rawProfit * (100 - trustShare) / 100;
      profit = rawProfit - ownerPayout;
    }
    const occupancy = periodDays > 0 ? Math.min(100, (row.soldNights / periodDays) * 100) : 0;
    const adr = row.soldNights > 0 ? row.income / row.soldNights : 0;
    const avgDaily = periodDays > 0 ? row.income / periodDays : 0;
    const avgStay = row.bookings > 0 ? row.totalNightsForStayAvg / row.bookings : 0;
    return {
      apartmentId: apt.id, name: row.name,
      income: row.income, grossIncome: row.grossIncome, platformCommission: row.platformCommission,
      expense: row.expense, soldNights: row.soldNights, bookings: row.bookings,
      profit, ownerPayout, businessModel: model, trustShare,
      availableNights: periodDays, occupancy, adr, avgDaily, avgStay,
      period: { from, to, days: periodDays },
    };
  };

  // Сначала гарантируем автосписания для видимых циклов (месяц-старт = месяц даты автозаписи).
  aptsWithCycle.forEach(({ apt, paymentDay }) => {
    const offset = Number(offsetByApt?.[apt.id] || 0);
    // Повторяем логику _windowForApt чтобы вычислить старт-месяц цикла.
    const startDayThis = _clampDayToMonth(todayY, todayM, paymentDay);
    let sY = todayY, sM = todayM;
    if (todayD < startDayThis) { sM = todayM - 1; if (sM < 1) { sM = 12; sY -= 1; } }
    const startDate = new Date(sY, sM - 1 + offset, 1);
    _ensureAutoRentEntryForMonth(state, apt, startDate.getFullYear(), startDate.getMonth() + 1);
  });
  const cycleRows = aptsWithCycle.map(({ apt, paymentDay }) => {
    const offset = Number(offsetByApt?.[apt.id] || 0);
    const { from, to } = _windowForApt(paymentDay, offset);
    const row = _buildRow(apt, from, to);
    row.offset = offset;
    return row;
  });
  const noDayRows = aptsNoDay.map((apt) => {
    const offset = Number(offsetByApt?.[apt.id] || 0);
    const { from, to } = _windowForNoDay(offset);
    const row = _buildRow(apt, from, to);
    row.offset = offset;
    return row;
  });

  const _totals = (list) => {
    const t = list.reduce((acc, r) => {
      acc.income += r.income; acc.grossIncome += r.grossIncome; acc.platformCommission += r.platformCommission;
      acc.expense += r.expense; acc.profit += r.profit;
      acc.soldNights += r.soldNights; acc.bookings += r.bookings;
      acc.availableNights += r.availableNights;
      if (r.businessModel === 'trust' && r.ownerPayout != null) acc.ownerPayout += r.ownerPayout;
      return acc;
    }, { income: 0, grossIncome: 0, platformCommission: 0, expense: 0, profit: 0, soldNights: 0, bookings: 0, ownerPayout: 0, availableNights: 0 });
    t.occupancy = t.availableNights > 0 ? Math.min(100, (t.soldNights / t.availableNights) * 100) : 0;
    t.adr = t.soldNights > 0 ? t.income / t.soldNights : 0;
    t.avgDaily = t.availableNights > 0 ? t.income / t.availableNights : 0;
    const totalStayNights = list.reduce((s, r) => s + (r.avgStay * r.bookings), 0);
    t.avgStay = t.bookings > 0 ? totalStayNights / t.bookings : 0;
    return t;
  };

  return {
    cycleRows,
    cycleTotals: _totals(cycleRows),
    noDayRows,
    noDayTotals: _totals(noDayRows),
  };
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
