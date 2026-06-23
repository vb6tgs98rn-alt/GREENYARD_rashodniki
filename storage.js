import { AUTO_STORAGE_KEY, STORAGE_VERSION, MAX_HISTORY, baseItems, structuredCloneSafe, setState, getState } from './state.js';
import { api } from './api.js';

export function normalizeImportedState(raw) {
  if (!raw || !Array.isArray(raw.apartments) || raw.apartments.length === 0) {
    throw new Error('Некорректный JSON');
  }
  const apartments = raw.apartments.map((apartment, index) => ({
    id: apartment.id || crypto.randomUUID(),
    name: typeof apartment.name === 'string' ? apartment.name : `Квартира ${index + 1}`,
    items: Array.isArray(apartment.items) && apartment.items.length
      ? apartment.items.map(item => ({
          id: item.id || crypto.randomUUID(),
          name: item.name || 'Без названия',
          unit: item.unit || 'шт',
          stock: Math.max(0, Number(item.stock || 0)),
          par: Math.max(0, Number(item.par || 0)),
          category: item.category === 'linen' ? 'linen' : 'guest',
          perCheckin: Math.max(0, Number(item.perCheckin || 0)),
          setAmount: Math.max(0, Number(item.setAmount || 0))
        }))
      : structuredCloneSafe(baseItems)
  }));
  return {
    version: STORAGE_VERSION,
    activeApartmentId: apartments.some(a => a.id === raw.activeApartmentId) ? raw.activeApartmentId : apartments[0].id,
    history: Array.isArray(raw.history) ? raw.history.slice(0, MAX_HISTORY) : [],
    purchaseRequests: Array.isArray(raw.purchaseRequests) ? raw.purchaseRequests : [],
    autoRequest: raw.autoRequest === true,
    apartments,
    ui: {
      historyFilterApartmentId: raw?.ui?.historyFilterApartmentId || 'all',
      theme: raw?.ui?.theme === 'dark' ? 'dark' : 'light',
      apartmentSearch: typeof raw?.ui?.apartmentSearch === 'string' ? raw.ui.apartmentSearch : ''
    }
  };
}

export async function tryLoadFromApi() {
  try {
    const result = await api.loadAppState();
    if (!result.ok || result.offline || !result.data) return false;
    setState(normalizeImportedState(result.data));
    return true;
  } catch {
    return false;
  }
}

export function saveToBrowser(setStatus, silent = false) {
  try {
    localStorage.setItem(AUTO_STORAGE_KEY, JSON.stringify(getState()));
    if (!silent) setStatus(`Сохранено в ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`);
  } catch {
    setStatus('Не удалось сохранить JSON-резервную копию.');
  }
}

export async function syncToApi() {
  try {
    await api.saveAppState(getState());
    return true;
  } catch {
    return false;
  }
}

export async function loadFromBrowser(setStatus) {
  const loadedFromApi = await tryLoadFromApi();
  if (loadedFromApi) {
    setStatus(`Загружено через API в ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`);
    return true;
  }
  try {
    const raw = localStorage.getItem(AUTO_STORAGE_KEY);
    if (!raw) return false;
    setState(normalizeImportedState(JSON.parse(raw)));
    setStatus(`Загружено в ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`);
    return true;
  } catch {
    setStatus('Ошибка чтения локальных данных.');
    return false;
  }
}

export function exportJson() {
  const blob = new Blob([JSON.stringify(getState(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `green-yard-backup-${Date.now()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export async function importJson(file) {
  const text = await file.text();
  setState(normalizeImportedState(JSON.parse(text)));
}
