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
 */

import { createDefaultState, ensureStateShape, getState, setState } from './state.js';
import {
  loadInitialState,
  migrateLocalToCloud,
  persistState,
  setStorageMode,
  tryLoadFromApi,
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

    // 2. Первичная загрузка state. Внутри loadInitialState уже устанавливается mode.
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

    // 4. Первый рендер + auth UI + индикатор облака
    render();
    renderAuthStatus(user);
    renderStorageBadge(getStorageMode());

    // 5. Если только что загрузились с дефолтом и есть пользователь — сразу залить в облако
    if (!loaded && user) {
      migrateLocalToCloud(setStatus).catch((e) => console.warn('[init] migrate failed:', e));
    } else if (!loaded) {
      // Сохраним дефолт локально, чтобы при перезагрузке не было пустого экрана
      await persistState(setStatus, true).catch(() => {});
    }

    // 6. Подписка на auth-события. Только данные, без bindEvents.
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
      setStatus('Выполняется вход...');
      setStorageMode('cloud', user);

      const cloudLoaded = await tryLoadFromApi(setStatus).catch(() => false);

      if (cloudLoaded) {
        setState(ensureStateShape(getState()));
        setStatus('Данные загружены из облака');
      } else {
        // В облаке пусто — текущий локальный state становится "первой версией в облаке"
        await migrateLocalToCloud(setStatus).catch((e) =>
          console.warn('[auth] migrate failed:', e),
        );
        setStatus('Вход выполнен. Локальные данные сохранены в облако.');
      }

      ensureFinanceGeneratedForCurrentMonth();
      render();
      renderAuthStatus(user);
      renderStorageBadge('cloud');
    } else if (event === 'SIGNED_OUT') {
      // Возвращаемся в локальный режим. State НЕ обнуляем —
      // пользователь может продолжать работать офлайн с теми же данными.
      setStorageMode('local', null);
      render();
      renderAuthStatus(null);
      renderStorageBadge('local');
      setStatus('Вы вышли. Данные сохраняются локально.');
    } else if (event === 'INITIAL_SESSION') {
      // Эмитится один раз при подписке. Если ещё не отрисовали — отрисуем UI auth-блока.
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
