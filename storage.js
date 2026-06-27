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

function notify(setStatus, text, silent = false) {
  if (!silent && typeof setStatus === 'function') setStatus(text);
}

export function normalizeImportedState(raw) {
  if (!raw || !Array.isArray(raw.apartments) || raw.apartments.length === 0) {
    throw new Error('Некорректный JSON');
  }

  const apartments = raw.apartments.map((apartment, index) => ({
    id: apartment.id || crypto.randomUUID(),
    name: typeof apartment.name === 'string' ? apartment.name : `Квартира ${index + 1}`,
    items:
      Array.isArray(apartment.items) && apartment.items.length
        ? apartment.items.map((item) => ({
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
    externalIds: {
      realtyCalendarUnitId: apartment?.externalIds?.realtyCalendarUnitId || '',
    },
  }));

  return {
    version: STORAGE_VERSION,
    activeApartmentId: apartments.some((a) => a.id === raw.activeApartmentId)
      ? raw.activeApartmentId
      : apartments[0].id,
    history: Array.isArray(raw.history) ? raw.history.slice(0, MAX_HISTORY) : [],
    purchaseRequests: Array.isArray(raw.purchaseRequests) ? raw.purchaseRequests : [],
    autoRequest: raw.autoRequest === true,
    apartments,
    finance: {
      entries: Array.isArray(raw?.finance?.entries) ? raw.finance.entries : [],
      recurringRules: Array.isArray(raw?.finance?.recurringRules) ? raw.finance.recurringRules : [],
      bookingSync: {
        provider: raw?.finance?.bookingSync?.provider || 'realtycalendar',
        lastSyncedAt: raw?.finance?.bookingSync?.lastSyncedAt || '',
        endpointUrl: raw?.finance?.bookingSync?.endpointUrl || '/api/realtycalendar/bookings',
        importMode: raw?.finance?.bookingSync?.importMode || 'merge',
      },
    },
    ui: {
      historyFilterApartmentId: raw?.ui?.historyFilterApartmentId || 'all',
      theme: raw?.ui?.theme === 'dark' ? 'dark' : 'light',
      apartmentSearch: typeof raw?.ui?.apartmentSearch === 'string' ? raw.ui.apartmentSearch : '',
      activeSection: raw?.ui?.activeSection || 'inventory',
      finance: {
        apartmentFilter: raw?.ui?.finance?.apartmentFilter || 'all',
        typeFilter: raw?.ui?.finance?.typeFilter || 'all',
        month: typeof raw?.ui?.finance?.month === 'string' ? raw.ui.finance.month : '',
        showOnlyPending: raw?.ui?.finance?.showOnlyPending === true,
      },
    },
  };
}

// ─── Cloud (Supabase) ─────────────────────────────────────────────────────────

export async function tryLoadFromApi(setStatus) {
  let user = null;
  try {
    user = await getCurrentUser();
  } catch {
    return false;
  }
  if (!user) return false;

  try {
    const { data, error } = await supabase
      .from(USER_STATES_TABLE)
      .select('state')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) {
      notify(setStatus, `Ошибка загрузки из облака: ${error.message}`);
      return false;
    }
    if (!data?.state) return false;

    setState(normalizeImportedState(data.state));
    notify(
      setStatus,
      `Загружено из облака в ${new Date().toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
      })}`,
    );
    return true;
  } catch (e) {
    console.warn('[storage] tryLoadFromApi error:', e);
    notify(setStatus, 'Ошибка чтения облачных данных');
    return false;
  }
}

export async function syncToApi(setStatus, silent = false) {
  let user = null;
  try {
    user = await getCurrentUser();
  } catch {
    return false;
  }
  if (!user) return false;

  try {
    const payload = {
      user_id: user.id,
      state: getState(),
      updated_at: new Date().toISOString(),
    };
    const { error } = await supabase
      .from(USER_STATES_TABLE)
      .upsert(payload, { onConflict: 'user_id' });

    if (error) {
      notify(setStatus, `Ошибка сохранения в облако: ${error.message}`, silent);
      return false;
    }

    notify(
      setStatus,
      `Сохранено в облако в ${new Date().toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
      })}`,
      silent,
    );
    return true;
  } catch (e) {
    console.warn('[storage] syncToApi error:', e);
    return false;
  }
}

export async function migrateLocalToCloud(setStatus) {
  const synced = await syncToApi(setStatus, true);
  if (synced) {
    notify(setStatus, 'Локальные данные перенесены в облако');
  }
  return synced;
}

// ─── Local storage ────────────────────────────────────────────────────────────

export function saveToBrowser(setStatus, silent = false) {
  try {
    localStorage.setItem(AUTO_STORAGE_KEY, JSON.stringify(getState()));
    if (!silent && typeof setStatus === 'function') {
      setStatus(
        `Сохранено локально в ${new Date().toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        })}`,
      );
    }
    // Облачный sync — fire-and-forget. Если упадёт — не ломаем UI.
    syncToApi(setStatus, true).catch((e) => console.warn('[storage] syncToApi bg error:', e));
  } catch (e) {
    console.warn('[storage] saveToBrowser error:', e);
    if (typeof setStatus === 'function') {
      setStatus('Не удалось сохранить данные');
    }
  }
}

export async function loadFromBrowser(setStatus) {
  // 1) Пробуем облако (если пользователь залогинен и сессия есть)
  try {
    const loadedFromApi = await tryLoadFromApi(setStatus);
    if (loadedFromApi) return true;
  } catch (e) {
    console.warn('[storage] cloud load failed, fallback to local:', e);
  }

  // 2) Локально
  try {
    const raw = localStorage.getItem(AUTO_STORAGE_KEY);
    if (!raw) return false;
    setState(normalizeImportedState(JSON.parse(raw)));
    if (typeof setStatus === 'function') {
      setStatus(
        `Загружено локально в ${new Date().toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        })}`,
      );
    }
    return true;
  } catch (e) {
    console.warn('[storage] loadFromBrowser local error:', e);
    if (typeof setStatus === 'function') {
      setStatus('Ошибка чтения локальных данных');
    }
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
