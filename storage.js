import {
  AUTO_STORAGE_KEY,
  STORAGE_VERSION,
  MAX_HISTORY,
  baseItems,
  structuredCloneSafe,
  setState,
  getState,
} from './state.js';

import { supabase, getCurrentUser } from './supabase-client.js';
import { USER_STATES_TABLE } from './config.js';

function debounce(fn, delay = 1200) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

const debouncedSync = debounce(async () => {
  await syncToApi();
}, 1200);

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
          setAmount: Math.max(0, Number(item.setAmount || 0)),
        }))
      : structuredCloneSafe(baseItems),
  }));

  return {
    version: STORAGE_VERSION,
    activeApartmentId: apartments.some(a => a.id === raw.activeApartmentId)
      ? raw.activeApartmentId
      : apartments[0].id,
    history: Array.isArray(raw.history) ? raw.history.slice(0, MAX_HISTORY) : [],
    purchaseRequests: Array.isArray(raw.purchaseRequests) ? raw.purchaseRequests : [],
    autoRequest: raw.autoRequest === true,
    apartments,
    ui: {
      historyFilterApartmentId: raw?.ui?.historyFilterApartmentId || 'all',
      theme: raw?.ui?.theme === 'dark' ? 'dark' : 'light',
      apartmentSearch: typeof raw?.ui?.apartmentSearch === 'string' ? raw.ui.apartmentSearch : '',
    },
  };
}

export async function tryLoadFromApi() {
  try {
    const user = await getCurrentUser();
    if (!user) return false;

    const { data, error } = await supabase
      .from(USER_STATES_TABLE)
      .select('state_json')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) {
      console.warn('[storage] tryLoadFromApi error:', error.message);
      return false;
    }

    if (!data?.state_json) return false;

    setState(normalizeImportedState(data.state_json));
    return true;
  } catch (err) {
    console.warn('[storage] tryLoadFromApi exception:', err);
    return false;
  }
}

export async function syncToApi() {
  try {
    const user = await getCurrentUser();
    if (!user) return false;

    const { error } = await supabase
      .from(USER_STATES_TABLE)
      .upsert(
        {
          user_id: user.id,
          state_json: getState(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      );

    if (error) {
      console.warn('[storage] syncToApi error:', error.message);
      return false;
    }

    return true;
  } catch (err) {
    console.warn('[storage] syncToApi exception:', err);
    return false;
  }
}

export async function migrateLocalToCloud() {
  try {
    const user = await getCurrentUser();
    if (!user) return;

    const { data, error } = await supabase
      .from(USER_STATES_TABLE)
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) {
      console.warn('[storage] migrateLocalToCloud check error:', error.message);
      return;
    }

    if (data) return;

    const raw = localStorage.getItem(AUTO_STORAGE_KEY);
    if (!raw) return;

    let localState;
    try {
      localState = normalizeImportedState(JSON.parse(raw));
    } catch {
      return;
    }

    const { error: upsertError } = await supabase
      .from(USER_STATES_TABLE)
      .upsert(
        {
          user_id: user.id,
          state_json: localState,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' }
      );

    if (upsertError) {
      console.warn('[storage] migrateLocalToCloud upsert error:', upsertError.message);
      return;
    }

    console.info('[storage] Локальные данные мигрированы в облако.');
  } catch (err) {
    console.warn('[storage] migrateLocalToCloud exception:', err);
  }
}

export function saveToBrowser(setStatus, silent = false) {
  const notify = typeof setStatus === 'function' ? setStatus : () => {};
  const time = new Date().toLocaleTimeString('ru-RU', {
    hour: '2-digit',
    minute: '2-digit',
  });

  try {
    localStorage.setItem(AUTO_STORAGE_KEY, JSON.stringify(getState()));
  } catch (e) {
    notify('Не удалось сохранить данные.');
    return;
  }

  if (!silent) {
    notify(`Сохранено ${time}`);
  }

  debouncedSync(async () => {
    const ok = await syncToApi();
    if (!silent) {
      notify(
        ok
          ? `Сохранено локально и в облако · ${time}`
          : `Сохранено локально · ${time}`
      );
    }
  });
}

export async function loadFromBrowser(setStatus) {
  const notify = typeof setStatus === 'function' ? setStatus : () => {};
  const time = () =>
    new Date().toLocaleTimeString('ru-RU', {
      hour: '2-digit',
      minute: '2-digit',
    });

  const loadedFromApi = await tryLoadFromApi();
  if (loadedFromApi) {
    notify(`Загружено из облака · ${time()}`);
    return true;
  }

  try {
    const raw = localStorage.getItem(AUTO_STORAGE_KEY);
    if (!raw) return false;
    setState(normalizeImportedState(JSON.parse(raw)));
    notify(`Загружено локально · ${time()}`);
    return true;
  } catch {
    notify('Ошибка чтения локальных данных.');
    return false;
  }
}

export function exportJson() {
  const blob = new Blob([JSON.stringify(getState(), null, 2)], {
    type: 'application/json',
  });
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
