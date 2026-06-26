import {
  AUTO_STORAGE_KEY,
  STORAGE_VERSION,
  MAX_HISTORY,
  baseItems,
  structuredCloneSafe,
  setState,
  getState,
  ensureStateShape,
} from './state.js';
import { supabase, getCurrentUser } from './supabase-client.js';
import { USER_STATES_TABLE } from './config.js';

// ─── normalizeImportedState ────────────────────────────────────────────────

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
    externalIds: { realtyCalendarUnitId: apartment?.externalIds?.realtyCalendarUnitId || '' },
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
    finance: raw.finance && typeof raw.finance === 'object' ? raw.finance : {
      entries: [],
      recurringRules: [],
      bookingSync: { provider: 'realtycalendar', lastSyncedAt: '', endpointUrl: '/api/realtycalendar/bookings', importMode: 'merge' },
    },
    ui: {
      historyFilterApartmentId: raw?.ui?.historyFilterApartmentId || 'all',
      theme: raw?.ui?.theme === 'dark' ? 'dark' : 'light',
      apartmentSearch: typeof raw?.ui?.apartmentSearch === 'string' ? raw.ui.apartmentSearch : '',
      activeSection: raw?.ui?.activeSection || 'inventory',
      finance: raw?.ui?.finance && typeof raw.ui.finance === 'object' ? raw.ui.finance : {
        apartmentFilter: 'all',
        typeFilter: 'all',
        month: '',
        showOnlyPending: false,
      },
    },
  };
}

// ─── Debounce helper ────────────────────────────────────────────────────────

let _syncTimer = null;
function debouncedSync(fn, delay = 1200) {
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(fn, delay);
}

// ─── tryLoadFromApi ─────────────────────────────────────────────────────────
// Загружает state из Supabase. Возвращает true если успешно.

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
    if (!data || !data.state_json) return false;

    const normalized = normalizeImportedState(data.state_json);
    setState(ensureStateShape(normalized));
    return true;
  } catch (err) {
    console.warn('[storage] tryLoadFromApi exception:', err);
    return false;
  }
}

// ─── syncToApi ──────────────────────────────────────────────────────────────
// Сохраняет текущий state в Supabase (upsert). Возвращает true если успешно.

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

// ─── Первичная миграция localStorage → Supabase ─────────────────────────────
// Вызывается после первого входа. Если в облаке нет записи, но есть локальный
// state — загружает его в Supabase чтобы не потерять данные.

export async function migrateLocalToCloud() {
  try {
    const user = await getCurrentUser();
    if (!user) return;

    // Проверяем есть ли уже запись в облаке
    const { data } = await supabase
      .from(USER_STATES_TABLE)
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle();

    if (data) return; // Запись уже есть — не трогаем

    // Есть ли в localStorage что-то ценное?
    const raw = localStorage.getItem(AUTO_STORAGE_KEY);
    if (!raw) return;

    let localState;
    try { localState = normalizeImportedState(JSON.parse(raw)); } catch { return; }

    // Загружаем локальный state в облако
    await supabase.from(USER_STATES_TABLE).upsert(
      {
        user_id: user.id,
        state_json: localState,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    );
    console.info('[storage] Локальные данные мигрированы в облако.');
  } catch (err) {
    console.warn('[storage] migrateLocalToCloud exception:', err);
  }
}

// ─── saveToBrowser ──────────────────────────────────────────────────────────
// Сохраняет в localStorage + запускает дебаунс-синхронизацию с облаком.

export function saveToBrowser(setStatus, silent = false) {
  const notify = typeof setStatus === 'function' ? setStatus : () => {};
  const time = new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  // 1. Всегда сохраняем локально (быстро, синхронно)
  try {
    localStorage.setItem(AUTO_STORAGE_KEY, JSON.stringify(getState()));
  } catch (e) {
    notify('Не удалось сохранить данные.');
    return;
  }

  if (!silent) notify(`Сохранено ${time}`);

  // 2. Дебаунс-синхронизация с облаком (1200 мс)
  debouncedSync(async () => {
    const ok = await syncToApi();
    if (!silent) {
      notify(ok
        ? `Сохранено локально и в облако · ${time}`
        : `Сохранено локально · ${time}`
      );
    }
  }, 1200);
}

// ─── loadFromBrowser ────────────────────────────────────────────────────────
// Загрузка при старте: сначала облако, потом localStorage, потом ничего.

export async function loadFromBrowser(setStatus) {
  const notify = typeof setStatus === 'function' ? setStatus : () => {};
  const time = () => new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  // 1. Пробуем облако
  const loadedFromApi = await tryLoadFromApi();
  if (loadedFromApi) {
    notify(`Загружено из облака · ${time()}`);
    return true;
  }

  // 2. Fallback: localStorage
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

// ─── exportJson / importJson ────────────────────────────────────────────────

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
