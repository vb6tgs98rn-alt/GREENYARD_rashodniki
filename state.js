
export const STORAGE_VERSION = 3;
export const AUTO_STORAGE_KEY = 'green-yard-refactor-v2';
export const MAX_HISTORY = 40;
export const ALL_APARTMENTS_FILTER = 'all';
export const UNTITLED_LABEL = 'Без названия';

export const baseItems = [
  { id: 'towels', name: 'Полотенца', unit: 'шт', stock: 24, par: 36, category: 'linen', perCheckin: 0, setAmount: 2 },
  { id: 'linen', name: 'Постельное бельё', unit: 'компл', stock: 12, par: 18, category: 'linen', perCheckin: 0, setAmount: 1 },
  { id: 'slippers', name: 'Тапочки', unit: 'пара', stock: 28, par: 40, category: 'guest', perCheckin: 2, setAmount: 0 },
  { id: 'toothbrush', name: 'Зубные щётки', unit: 'шт', stock: 22, par: 30, category: 'guest', perCheckin: 2, setAmount: 0 },
  { id: 'soap', name: 'Мыло', unit: 'шт', stock: 20, par: 30, category: 'guest', perCheckin: 2, setAmount: 0 },
  { id: 'shampoo', name: 'Шампунь', unit: 'бут', stock: 18, par: 28, category: 'guest', perCheckin: 2, setAmount: 0 }
];

export function structuredCloneSafe(value) {
  return JSON.parse(JSON.stringify(value));
}

export function getDisplayApartmentName(name) {
  return typeof name === 'string' && name.trim() ? name.trim() : UNTITLED_LABEL;
}

export function createDefaultState() {
  const firstApartmentId = crypto.randomUUID();
  return {
    version: STORAGE_VERSION,
    activeApartmentId: firstApartmentId,
    history: [],
    purchaseRequests: [],
    autoRequest: false,
    apartments: [{ id: firstApartmentId, name: 'Квартира 1', items: structuredCloneSafe(baseItems), externalIds: { realtyCalendarUnitId: '' } }],
    finance: {
      entries: [],
      recurringRules: [],
      bookingSync: { provider: 'realtycalendar', lastSyncedAt: '', endpointUrl: '/api/realtycalendar/bookings', importMode: 'merge' }
    },
    integrations: {
      realtycalendar: { connected: false, agencyId: '', lastEventAt: '' }
    },
    ui: {
      historyFilterApartmentId: ALL_APARTMENTS_FILTER,
      theme: 'light',
      apartmentSearch: '',
      activeSection: 'inventory',
      finance: { apartmentFilter: 'all', typeFilter: 'all', month: '', showOnlyPending: false, dateFrom: '', dateTo: '', unitDateFrom: '', unitDateTo: '' }
    }
  };
}

let state = createDefaultState();

export function ensureStateShape(rawState) {
  const next = rawState && typeof rawState === 'object' ? rawState : createDefaultState();
  if (!Array.isArray(next.history)) next.history = [];
  if (!Array.isArray(next.purchaseRequests)) next.purchaseRequests = [];
  if (!Array.isArray(next.apartments)) next.apartments = createDefaultState().apartments;
  if (!next.finance || typeof next.finance !== 'object') next.finance = {};
  if (!Array.isArray(next.finance.entries)) next.finance.entries = [];
  if (!Array.isArray(next.finance.recurringRules)) next.finance.recurringRules = [];
  if (!next.finance.bookingSync || typeof next.finance.bookingSync !== 'object') next.finance.bookingSync = { provider: 'realtycalendar', lastSyncedAt: '', endpointUrl: '/api/realtycalendar/bookings', importMode: 'merge' };
  if (!next.integrations || typeof next.integrations !== 'object') next.integrations = {};
  if (!next.integrations.realtycalendar || typeof next.integrations.realtycalendar !== 'object') next.integrations.realtycalendar = { connected: false, agencyId: '', lastEventAt: '' };
  if (typeof next.integrations.realtycalendar.agencyId !== 'string') next.integrations.realtycalendar.agencyId = String(next.integrations.realtycalendar.agencyId || '');
  // Мигрируем финансовые записи: добавляем netAmount, если его нет (по умолчанию = amount).
  next.finance.entries = next.finance.entries.map((entry) => {
    if (!entry || typeof entry !== 'object') return entry;
    if (typeof entry.netAmount !== 'number') entry.netAmount = Number(entry.amount || 0);
    return entry;
  });
  if (!next.ui || typeof next.ui !== 'object') next.ui = {};
  if (!next.ui.historyFilterApartmentId) next.ui.historyFilterApartmentId = ALL_APARTMENTS_FILTER;
  if (!next.ui.theme) next.ui.theme = 'light';
  if (typeof next.ui.apartmentSearch !== 'string') next.ui.apartmentSearch = '';
  if (!next.ui.activeSection) next.ui.activeSection = 'inventory';
  if (!next.ui.finance || typeof next.ui.finance !== 'object') next.ui.finance = {};
  if (!next.ui.finance.apartmentFilter) next.ui.finance.apartmentFilter = 'all';
  if (!next.ui.finance.typeFilter) next.ui.finance.typeFilter = 'all';
  if (typeof next.ui.finance.month !== 'string') next.ui.finance.month = '';
  if (typeof next.ui.finance.showOnlyPending !== 'boolean') next.ui.finance.showOnlyPending = false;
  if (typeof next.ui.finance.dateFrom !== 'string') next.ui.finance.dateFrom = '';
  if (typeof next.ui.finance.dateTo !== 'string') next.ui.finance.dateTo = '';
  if (typeof next.ui.finance.unitDateFrom !== 'string') next.ui.finance.unitDateFrom = '';
  if (typeof next.ui.finance.unitDateTo !== 'string') next.ui.finance.unitDateTo = '';
  next.apartments = next.apartments.map((apartment, index) => ({ ...apartment, name: apartment?.name || `Квартира ${index + 1}`, items: Array.isArray(apartment?.items) ? apartment.items : [], externalIds: { realtyCalendarUnitId: apartment?.externalIds?.realtyCalendarUnitId || '' } }));
  return next;
}

export function getState() { return state; }
export function setState(nextState) { state = nextState; return state; }
export function updateState(mutator) { mutator(state); return state; }
export function currentApartment() { return state.apartments.find(a => a.id === state.activeApartmentId) || state.apartments[0] || null; }
export function findApartmentById(id) { return state.apartments.find(a => a.id === id) || null; }
export function roundSmart(value) { return Number.isInteger(value) ? String(value) : Number(value).toFixed(1); }
export function statusBy(item) {
  const ratio = item.par <= 0 ? 0 : item.stock / item.par;
  if (ratio <= 0.35) return { label: 'Низкий', cls: 'low' };
  if (ratio <= 0.65) return { label: 'Средний', cls: 'warn' };
  return { label: 'Норма', cls: 'ok' };
}
