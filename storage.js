/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 *
 * Копирование, распространение, переработка и обратная разработка
 * (reverse engineering) запрещены без письменного разрешения правообладателя.
 * Условия: см. файл LICENSE. Нарушение влечёт ответственность по ст. 1252,
 * 1301 ГК РФ.
 */
/**
 * storage.js — единственный источник истины: Supabase (public.app_state).
 *
 * Локальное хранение (localStorage) ПОЛНОСТЬЮ ОТКЛЮЧЕНО — никаких записей
 * в localStorage приложение больше не делает. При старте старый кэш очищается,
 * чтобы гарантировать чистоту данных (бывали случаи, когда старые локальные записи
 * затирали облако или выглядели как «откат» недавних правок).
 *
 * Режимы:
 *   - 'cloud' : пользователь залогинен. persistState пишет в Supabase.
 *   - 'local' : не залогинен. persistState блокируется (guest gate всё равно не пускает
 *               пользователя в UI). Режим нужен только как начальное состояние.
 *
 * Внешний контракт (без изменений названий функций):
 *   - setStorageMode(mode, user?)  — переключение режима
 *   - persistState(setStatus)      — единая точка сохранения (только cloud)
 *   - loadInitialState(setStatus)  — первая загрузка при старте
 *   - tryLoadFromApi / syncToApi / fetchCloudState — облачные вызовы
 *   - migrateLocalToCloud          — оставлен на случай вызовов из старого кода
 *                                    (теперь это просто syncToApi)
 *   - exportJson / importJson      — без изменений
 */

import {
  baseItems,
  structuredCloneSafe,
  setState,
  getState,
  STORAGE_VERSION,
  MAX_HISTORY,
} from './state.js';
import { supabase, getCurrentUser } from './supabase-client.js';
import { USER_STATES_TABLE, LOCAL_STORAGE_KEY } from './config.js';

// ─── Режим хранения ───────────────────────────────────────────────────────────

let mode = 'local';   // 'local' | 'cloud'
let cachedUser = null;

// КРИТИЧЕСКИЙ флаг: пока приложение загружает/инициализирует state из облака после входа,
// НИКАКИЕ вызовы persistState() / syncToApi() НЕ должны писать в облако —
// иначе они затрут реальные данные пользователя дефолтным или гостевым state'ом.
// Снимается в app.js после успешной инициализации облачного state.
let isHydratingFromCloud = false;

// При первой загрузке модуля — чистим старый локальный кэш.
// Старые записи могли «воскрешать» устаревшие версии state (напр. вернувшийся старый
// realtyCalendarUnitId), так что вычищаем единовременно при загрузке приложения.
try { localStorage.removeItem(LOCAL_STORAGE_KEY); } catch { /* ignore */ }

export function getStorageMode() {
  return mode;
}

export function getCachedUser() {
  return cachedUser;
}

export function isHydrating() {
  return isHydratingFromCloud;
}

/** Включить защиту от случайных записей. Обязательно выключить после завершения. */
export function setHydrating(on) {
  isHydratingFromCloud = !!on;
}

/**
 * Переключение режима. Вызывается из app.js на старте и при auth-событиях.
 * Не делает сетевых запросов. Сам по себе только меняет, КАК будет работать persistState().
 */
export function setStorageMode(nextMode, user = null) {
  mode = nextMode === 'cloud' ? 'cloud' : 'local';
  cachedUser = mode === 'cloud' ? user : null;
}

// ─── Утилиты ──────────────────────────────────────────────────────────────────

function notify(setStatus, text, silent = false) {
  if (!silent && typeof setStatus === 'function') setStatus(text);
}

function nowLabel() {
  return new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
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
    cleaningPrice: Math.max(0, Number(apartment?.cleaningPrice || 0)),
    businessModel: (apartment?.businessModel === 'trust') ? 'trust' : 'sublease',
    trustShare: Math.min(100, Math.max(0, Number(apartment?.trustShare || 0))),
    unitEcoReports: {
      active: apartment?.unitEcoReports?.active || null,
      history: Array.isArray(apartment?.unitEcoReports?.history) ? apartment.unitEcoReports.history : [],
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
        dateFrom: typeof raw?.ui?.finance?.dateFrom === 'string' ? raw.ui.finance.dateFrom : '',
        dateTo: typeof raw?.ui?.finance?.dateTo === 'string' ? raw.ui.finance.dateTo : '',
        unitDateFrom: typeof raw?.ui?.finance?.unitDateFrom === 'string' ? raw.ui.finance.unitDateFrom : '',
        unitDateTo: typeof raw?.ui?.finance?.unitDateTo === 'string' ? raw.ui.finance.unitDateTo : '',
        unitApartmentId: typeof raw?.ui?.finance?.unitApartmentId === 'string' ? raw.ui.finance.unitApartmentId : '',
        unitHistoryReportId: typeof raw?.ui?.finance?.unitHistoryReportId === 'string' ? raw.ui.finance.unitHistoryReportId : '',
        unitFilters: {
          type: raw?.ui?.finance?.unitFilters?.type || 'all',
          category: raw?.ui?.finance?.unitFilters?.category || 'all',
          source: raw?.ui?.finance?.unitFilters?.source || 'all',
          status: raw?.ui?.finance?.unitFilters?.status || 'active',
        },
      },
    },
  };
}

// ─── Локальное хранение ───────────────────────────────────────────────────────

// Функции оставлены как no-op для обратной совместимости.
// Supabase (public.app_state) — единственный источник истины, localStorage не используется.

function writeLocal() {
  return false;
}

/** @deprecated локальное хранение отключено — функция ничего не делает */
export function writeLocalCache() {
  return false;
}

function readLocal() {
  return null;
}

// ─── Облачное хранение (Supabase) ─────────────────────────────────────────────

/**
 * fetchCloudState() — низкоуровневое чтение public.app_state.
 * Возвращает объект-результат вместо bool — важно различать:
 *   { ok: true,  found: true,  state }  — в облаке есть запись
 *   { ok: true,  found: false }         — запрос выполнился, записи нет (новый аккаунт)
 *   { ok: false, error }                — сеть/ошибка (пользователь НЕ должен в таком
 *                                          случае получить дефолтный state в облако!)
 * Не трогает текущий state в памяти и не пишет в localStorage.
 */
export async function fetchCloudState(setStatus) {
  let user = cachedUser;
  if (!user) {
    try { user = await getCurrentUser(); } catch { user = null; }
  }
  if (!user) return { ok: false, error: new Error('No user') };

  try {
    const { data, error } = await supabase
      .from(USER_STATES_TABLE)
      .select('state')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) {
      notify(setStatus, `Ошибка загрузки из облака: ${error.message}`);
      return { ok: false, error };
    }
    if (!data || !data.state) {
      // Запись отсутствует — это НЕ ошибка, это новый аккаунт
      return { ok: true, found: false };
    }
    return { ok: true, found: true, state: normalizeImportedState(data.state) };
  } catch (e) {
    console.warn('[storage] fetchCloudState error:', e);
    notify(setStatus, 'Ошибка чтения облачных данных');
    return { ok: false, error: e };
  }
}

/**
 * Старый API: пробует загрузить и выставить state. Сейчас это обёртка
 * над fetchCloudState. Различает «запись не найдена» и «ошибка» — во втором
 * случае возвращает false, НО НЕ выставляет default — это решает app.js.
 */
export async function tryLoadFromApi(setStatus) {
  const res = await fetchCloudState(setStatus);
  if (res.ok && res.found) {
    setState(res.state);
    notify(setStatus, `Загружено из облака в ${nowLabel()}`);
    return true;
  }
  return false;
}

/** Записать текущий state в public.app_state (upsert по user_id). */
export async function syncToApi(setStatus, silent = false) {
  // Главный замок: пока идёт бутстрап после входа — никаких записей в облако.
  // Это защищает от гонки: «событие SIGNED_IN пришло, но fetchCloudState ещё
  // не завершился — а какой-нибудь persistState() из events.js уже хочет упсертнуть
  // дефолтный state в облако». После завершения бутстрапа флаг снимется в app.js.
  if (isHydratingFromCloud) {
    console.warn('[storage] syncToApi blocked: hydrating from cloud');
    return false;
  }

  let user = cachedUser;
  if (!user) {
    try { user = await getCurrentUser(); } catch { user = null; }
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
    notify(setStatus, `Сохранено в облако в ${nowLabel()}`, silent);
    return true;
  } catch (e) {
    console.warn('[storage] syncToApi error:', e);
    // Локального fallback больше нет — честно сообщаем об ошибке.
    notify(setStatus, 'Ошибка сохранения: нет связи с облаком. Попробуйте ещё раз.', silent);
    return false;
  }
}

/**
 * Совместимость со старым кодом: локального state больше нет, так что
 * просто вызываем syncToApi — текущий in-memory state уйдёт в облако.
 */
export async function migrateLocalToCloud(setStatus) {
  return syncToApi(setStatus, true);
}

// ─── Главная функция сохранения ──────────────────────────────────────────────

/**
 * persistState() — единая точка сохранения. Пишет ТОЛЬКО в облако.
 * Если пользователь не залогинен (mode === 'local') — возвращает false
 * и просит войти. localStorage не трогаем вообще.
 */
export async function persistState(setStatus, silent = false) {
  // КРИТИЧЕСКИ: во время бутстрапа НЕ пишем — иначе затрём облако дефолтом.
  if (isHydratingFromCloud) {
    console.warn('[storage] persistState blocked: hydrating from cloud');
    return false;
  }

  if (mode === 'cloud') {
    const cloudOk = await syncToApi(setStatus, silent);
    if (!cloudOk && !silent) {
      notify(setStatus, 'Сохранение не удалось — проверьте связь и повторите');
    }
    return cloudOk;
  }

  // mode === 'local' — пользователь не вошёл. Guest gate всё равно не даёт UI.
  if (!silent) notify(setStatus, 'Войдите в аккаунт, чтобы сохранять данные');
  return false;
}

// ─── Загрузка при старте ──────────────────────────────────────────────────────

/**
 * loadInitialState() — единственная загрузка при старте. Только облако.
 *
 *  - Есть Supabase-пользователь → пробуем облако.
 *      ✓ нашлось → mode='cloud', true
 *      ✗ пусто   → mode='cloud', false (app.js поставит default и упсертнет)
 *  - Нет пользователя → mode='local', ничего не грузим (guest gate закроет UI).
 */
export async function loadInitialState(setStatus) {
  let user = null;
  try { user = await getCurrentUser(); } catch { user = null; }

  if (user) {
    setStorageMode('cloud', user);
    const cloudOk = await tryLoadFromApi(setStatus);
    if (cloudOk) return true;
    return false;
  }

  // Не залогинен → ничего не грузим. localStorage больше не читаем.
  setStorageMode('local', null);
  return false;
}

// ─── Алиасы для обратной совместимости со старым API ──────────────────────────

/** @deprecated используйте persistState() */
export function saveToBrowser(setStatus, silent = false) {
  // Возвращаем Promise — вызывающий код может await-ить или нет
  return persistState(setStatus, silent);
}

/** @deprecated используйте loadInitialState() */
export async function loadFromBrowser(setStatus) {
  return loadInitialState(setStatus);
}

// ─── Экспорт / Импорт JSON ────────────────────────────────────────────────────

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
