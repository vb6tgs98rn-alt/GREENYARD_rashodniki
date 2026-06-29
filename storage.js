/**
 * storage.js — слой хранения с двумя режимами:
 *   - 'local'  : пользователь не залогинен. Источник истины = localStorage.
 *   - 'cloud'  : пользователь залогинен. Источник истины = Supabase (public.app_state).
 *                localStorage используется только как write-through кэш и offline fallback.
 *
 * Внешний контракт:
 *   - setStorageMode(mode, user?)  — переключение режима (вызывается из app.js при auth-событиях)
 *   - persistState(setStatus)      — ЕДИНАЯ ФУНКЦИЯ сохранения. Сама выбирает облако или локалку.
 *   - loadInitialState(setStatus)  — первая загрузка при старте приложения
 *   - tryLoadFromApi(setStatus)    — принудительно загрузить state из облака
 *   - syncToApi(setStatus, silent) — принудительно записать state в облако
 *   - migrateLocalToCloud(setStatus) — после регистрации/первого логина
 *   - exportJson() / importJson(file) — без изменений
 *
 * Старые имена saveToBrowser / loadFromBrowser оставлены как алиасы persistState/loadInitialState
 * для обратной совместимости — весь код приложения зовёт их.
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
// НИКАКИЕ вызовы persistState() / syncToApi() / writeLocal() НЕ должны
// писать в облако или в localStorage — иначе они затрут реальные данные пользователя дефолтным
// или гостевым state'ом. Снимается в app.js после успешной инициализации облачного state.
let isHydratingFromCloud = false;

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
      },
    },
  };
}

// ─── Локальное хранение ───────────────────────────────────────────────────────

function writeLocal() {
  try {
    localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(getState()));
    return true;
  } catch (e) {
    console.warn('[storage] writeLocal error:', e);
    return false;
  }
}

/**
 * Безопасный вызов writeLocal() в обход флага hydrating — используется только
 * после успешной загрузки state из облака, чтобы синхронизировать локальный кэш.
 * localStorage — всегда кэш, его содержимое не является источником истины в cloud-режиме.
 */
export function writeLocalCache() {
  return writeLocal();
}

function readLocal() {
  try {
    const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
    if (!raw) return null;
    return normalizeImportedState(JSON.parse(raw));
  } catch (e) {
    console.warn('[storage] readLocal error:', e);
    return null;
  }
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
    // Локальный write-through, чтобы офлайн-перезагрузка тоже что-то показала
    writeLocal();
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
    notify(setStatus, 'Сетевая ошибка, сохранено только локально', silent);
    return false;
  }
}

/** После первого логина: льём локальный state в облако. */
export async function migrateLocalToCloud(setStatus) {
  const synced = await syncToApi(setStatus, true);
  if (synced) notify(setStatus, 'Локальные данные перенесены в облако');
  return synced;
}

// ─── Главная функция сохранения ──────────────────────────────────────────────

/**
 * persistState() — единая точка сохранения для всего приложения.
 * После каждого действия пользователя вызывается ИМЕННО ЭТА функция.
 *
 * Режим 'cloud':
 *   - основное сохранение = Supabase (await)
 *   - localStorage обновляется СИНХРОННО как write-through cache / offline fallback
 *   - при сетевой ошибке: данные остаются в localStorage и попадут в облако при следующем сохранении
 *
 * Режим 'local':
 *   - сохранение только в localStorage
 *   - облака нет, не пытаемся
 */
export async function persistState(setStatus, silent = false) {
  // КРИТИЧЕСКИ: во время бутстрапа (загрузка state из облака после входа)
  // НЕ разрешаем НИКАКОГО сохранения — ни в локалку, ни в облако.
  // Иначе фоновые persistState() (от render/events) затрут облачные данные
  // дефолтом или гостевым state'ом.
  if (isHydratingFromCloud) {
    console.warn('[storage] persistState blocked: hydrating from cloud');
    return false;
  }

  // Локальный write-through всегда — он быстрый, синхронный, не сетевой
  const localOk = writeLocal();

  if (mode === 'cloud') {
    const cloudOk = await syncToApi(setStatus, silent);
    if (!cloudOk && !silent) {
      notify(setStatus, `Сохранено локально (нет связи) в ${nowLabel()}`);
    }
    return cloudOk;
  }

  // mode === 'local'
  if (localOk && !silent) notify(setStatus, `Сохранено локально в ${nowLabel()}`);
  return localOk;
}

// ─── Загрузка при старте ──────────────────────────────────────────────────────

/**
 * loadInitialState() — единственная загрузка при инициализации приложения.
 *
 *  - Если есть Supabase-пользователь → пробуем облако.
 *      ✓ облако нашлось   → ставим mode='cloud', возвращаем true
 *      ✗ облако пустое    → mode='cloud', но НЕ подмешиваем чужие локальные данные.
 *        Возвращаем false → app.js поставит createDefaultState() и сохранит его в облако.
 *  - Если пользователя нет → читаем локалку, mode='local'.
 */
export async function loadInitialState(setStatus) {
  let user = null;
  try { user = await getCurrentUser(); } catch { user = null; }

  if (user) {
    setStorageMode('cloud', user);

    const cloudOk = await tryLoadFromApi(setStatus);
    if (cloudOk) return true;

    // В облаке для этого user_id пусто. Не подмешиваем сюда локальный кэш —
    // он мог быть оставлен другим аккаунтом или гостевым сеансом. Возвращаем
    // false, чтобы app.js явно поставил default state для нового аккаунта.
    return false;
  }

  // Не залогинен → локальный режим
  setStorageMode('local', null);
  const local = readLocal();
  if (!local) return false;
  setState(local);
  notify(setStatus, `Загружено локально в ${nowLabel()}`);
  return true;
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
