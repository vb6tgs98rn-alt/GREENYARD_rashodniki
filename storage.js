import { AUTO_STORAGE_KEY, STORAGE_VERSION, MAX_HISTORY, baseItems, structuredCloneSafe, setState, getState } from './state.js';

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
  // API-загрузка не подключена — всегда возвращаем false, используем localStorage
  return false;
}

export function saveToBrowser(setStatus, silent = false) {
  const notify = typeof setStatus === 'function' ? setStatus : () => {};
  try {
    localStorage.setItem(AUTO_STORAGE_KEY, JSON.stringify(getState()));
    if (!silent) notify(`Сохранено в ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`);
  } catch {
    notify('Не удалось сохранить данные.');
  }
}

export async function syncToApi() {
  // API-синхронизация не подключена
  return false;
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
