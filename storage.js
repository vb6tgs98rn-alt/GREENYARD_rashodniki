import {
  AUTOSTORAGEKEY,
  STORAGEVERSION,
  MAXHISTORY,
  baseItems,
  structuredCloneSafe,
  setState,
  getState,
} from './state.js';
import { supabase, getCurrentUser } from './supabase-client.js';

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
    version: STORAGEVERSION,
    activeApartmentId: apartments.some((a) => a.id === raw.activeApartmentId)
      ? raw.activeApartmentId
      : apartments[0].id,
    history: Array.isArray(raw.history) ? raw.history.slice(0, MAXHISTORY) : [],
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

export async function tryLoadFromApi(setStatus) {
  const user = await getCurrentUser();
  if (!user) return false;

  const { data, error } = await supabase
    .from('app_state')
    .select('state')
    .eq('user_id', user.id)
    .maybeSingle();

  if (error) {
    notify(setStatus, `Ошибка загрузки из облака: ${error.message}`);
    return false;
  }

  if (!data?.state) return false;

  try {
    setState(normalizeImportedState(data.state));
    notify(
      setStatus,
      `Загружено из облака в ${new Date().toLocaleTimeString('ru-RU', {
        hour: '2-digit',
        minute: '2-digit',
      })}`,
      false,
    );
    return true;
  } catch {
    notify(setStatus, 'Ошибка чтения облачных данных');
    return false;
  }
}

export async function syncToApi(setStatus, silent = false) {
  const user = await getCurrentUser();
  if (!user) return false;

  const payload = {
    user_id: user.id,
    state: getState(),
    updated_at: new Date().toISOString(),
  };

  const { error } = await supabase.from('app_state').upsert(payload, { onConflict: 'user_id' });

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
}

export async function migrateLocalToCloud(setStatus) {
  const synced = await syncToApi(setStatus, true);
  if (synced) {
    notify(setStatus, 'Локальные данные перенесены в облако');
  }
  return synced;
}

export function saveToBrowser(setStatus, silent = false) {
  try {
    localStorage.setItem(AUTOSTORAGEKEY, JSON.stringify(getState()));
    if (!silent && typeof setStatus === 'function') {
      setStatus(
        `Сохранено локально в ${new Date().toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit',
        })}`,
      );
    }
    syncToApi(setStatus, true);
  } catch {
    if (typeof setStatus === 'function') {
      setStatus('Не удалось сохранить данные');
    }
  }
}

export async function loadFromBrowser(setStatus) {
  const loadedFromApi = await tryLoadFromApi(setStatus);
  if (loadedFromApi) return true;

  try {
    const raw = localStorage.getItem(AUTOSTORAGEKEY);
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
  } catch {
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
