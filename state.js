
export const STORAGE_VERSION = 1;
export const AUTO_STORAGE_KEY = 'green-yard-refactor-v1';
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
    apartments: [{ id: firstApartmentId, name: 'Квартира 1', items: structuredCloneSafe(baseItems) }],
    ui: { historyFilterApartmentId: ALL_APARTMENTS_FILTER, theme: 'light', apartmentSearch: '' }
  };
}

let state = createDefaultState();

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
