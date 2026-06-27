/**
 * app.js — единая точка входа.
 * Подключается из index.html как <script type="module" src="./app.js"></script>.
 *
 * Контракт:
 *  - init() выполняется ровно ОДИН раз после готовности DOM.
 *  - bindEvents() вызывается ровно ОДИН раз.
 *  - onAuthStateChange ТОЛЬКО переключает storage mode, грузит/мигрирует state и зовёт render().
 *    Никаких re-bindEvents — обработчики на статических кнопках живут постоянно.
 *  - Любая сетевая/Supabase-ошибка НЕ роняет UI. localStorage всегда есть как fallback.
 *
 * Поведение данных при входе/выходе:
 *  - Гость (не вошёл): данные в localStorage этого браузера.
 *  - SIGNED_IN: загружаем state ИМЕННО ЭТОГО аккаунта из облака.
 *      • если в облаке есть данные → показываем их;
 *      • если в облаке пусто (новый аккаунт) → state = default (как при первом входе),
 *        и сохраняем дефолтный state в облако под этим user_id.
 *      • локальные гостевые данные НЕ подмешиваются к чужому аккаунту.
 *  - SIGNED_OUT: state ВОЗВРАЩАЕТСЯ к default (как при первом запуске).
 *      • в localStorage гостевое содержимое тоже перезаписывается на default,
 *        чтобы при следующем входе в другой аккаунт не было утечки данных.
 */

import { createDefaultState, ensureStateShape, getState, setState } from './state.js';
import {
  loadInitialState,
  persistState,
  setStorageMode,
  tryLoadFromApi,
  syncToApi,
  getStorageMode,
} from './storage.js';
import { render, setStatus, renderAuthStatus, renderStorageBadge } from './render.js';
import { bindEvents } from './events.js';
import { ensureFinanceGeneratedForCurrentMonth } from './finance.js';
import { getCurrentUser, onAuthStateChange } from './supabase-client.js';

// ─── Защита от двойной инициализации ───────────────────────────────────────
let booted = false;
let authBusy = false;

// ─── Основная инициализация ────────────────────────────────────────────────
async function init() {
  if (booted) return;
  booted = true;

  try {
    // 1. Кто залогинен (может быть null)
    let user = null;
    try { user = await getCurrentUser(); } catch (e) { console.warn('[init] getCurrentUser:', e); }

    // 2. Первичная загрузка state
    const loaded = await loadInitialState(setStatus).catch((e) => {
      console.warn('[init] loadInitialState failed:', e);
      return false;
    });

    if (!loaded) {
      setState(createDefaultState());
    } else {
      setState(ensureStateShape(getState()));
    }

    ensureFinanceGeneratedForCurrentMonth();

    // 3. bindEvents() ровно один раз
    bindEvents();

    // 4. Первый рендер + auth UI + индикатор хранилища
    render();
    renderAuthStatus(user);
    renderStorageBadge(getStorageMode());

    // 5. Если ничего не загрузилось — сохраним дефолт локально, чтобы при перезагрузке
    //    не было пустого экрана
    if (!loaded) {
      await persistState(setStatus, true).catch(() => {});
    }

    // 6. Подписка на auth-события
    onAuthStateChange(handleAuthChange);
  } catch (e) {
    console.error('[init] fatal:', e);
    // Минимальный fallback — UI должен жить
    try {
      setState(createDefaultState());
      setStorageMode('local', null);
      bindEvents();
      render();
      renderAuthStatus(null);
      renderStorageBadge('local');
      setStatus('Ошибка инициализации, работаем локально');
    } catch (e2) {
      console.error('[init] fallback also failed:', e2);
    }
  }
}

// ─── Auth state machine ────────────────────────────────────────────────────
async function handleAuthChange(event, session) {
  // TOKEN_REFRESHED / USER_UPDATED — не наша забота, фон.
  if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') return;
  if (authBusy) return;
  authBusy = true;

  const user = session?.user ?? null;

  try {
    if (event === 'SIGNED_IN') {
      // Пользователь только что вошёл (или зарегистрировался) — переключаемся
      // в облачный режим и подгружаем state ИМЕННО ЕГО аккаунта.
      setStatus('Загружаем данные аккаунта...');
      setStorageMode('cloud', user);

      const cloudLoaded = await tryLoadFromApi(setStatus).catch(() => false);

      if (cloudLoaded) {
        // В облаке есть данные — нормализуем и показываем
        setState(ensureStateShape(getState()));
        setStatus('Данные аккаунта загружены');
      } else {
        // В облаке пусто (новый аккаунт или удалена строка) — стартуем
        // с ЧИСТОГО default state. Гостевой local НЕ заносится в этот аккаунт.
        setState(createDefaultState());
        // Сохраняем дефолтный state в облако под этим user_id, чтобы при
        // следующем входе он подтянулся, даже если пользователь ничего не менял.
        await syncToApi(setStatus, true).catch((e) => console.warn('[auth] init cloud state failed:', e));
        setStatus('Добро пожаловать. Аккаунт создан, данные пока пустые.');
      }

      ensureFinanceGeneratedForCurrentMonth();
      render();
      renderAuthStatus(user);
      renderStorageBadge('cloud');
    } else if (event === 'SIGNED_OUT') {
      // Возвращаемся в гостевой режим и сбрасываем UI к виду "первого входа":
      // state = default, localStorage тоже перезаписывается дефолтом, чтобы
      // данные предыдущего аккаунта не остались в браузере.
      setStorageMode('local', null);
      setState(createDefaultState());
      ensureFinanceGeneratedForCurrentMonth();
      // Принудительный write-through, чтобы localStorage отразил гостевой default
      await persistState(setStatus, true).catch(() => {});
      render();
      renderAuthStatus(null);
      renderStorageBadge('local');
      setStatus('Вы вышли. Данные аккаунта остались в облаке.');
    } else if (event === 'INITIAL_SESSION') {
      // Эмитится один раз при подписке. Просто синхронизируем UI auth-блока.
      renderAuthStatus(user);
      renderStorageBadge(getStorageMode());
    }
  } catch (e) {
    console.error('[auth] handler error:', e);
    setStatus('Ошибка авторизации, продолжаем локально');
  } finally {
    authBusy = false;
  }
}

// ─── Запуск ────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
