/**
 * app.js — единственная точка входа приложения.
 * Подключается из index.html как <script type="module" src="./app.js"></script>.
 *
 * Архитектурный контракт:
 *  - init() выполняется ровно ОДИН раз после готовности DOM.
 *  - bindEvents() вызывается ровно ОДИН раз. Никогда больше.
 *  - onAuthStateChange ТОЛЬКО мутирует state и зовёт render(). Не биндит обработчики.
 *  - Любая сетевая ошибка Supabase НЕ должна ломать UI — есть localStorage fallback.
 */

import { createDefaultState, ensureStateShape, getState, setState } from './state.js';
import {
  loadFromBrowser,
  migrateLocalToCloud,
  saveToBrowser,
  tryLoadFromApi,
} from './storage.js';
import { render, setStatus, renderAuthStatus } from './render.js';
import { bindEvents } from './events.js';
import { ensureFinanceGeneratedForCurrentMonth } from './finance.js';
import { getCurrentUser, onAuthStateChange } from './supabase-client.js';

// ─── Защита от двойной инициализации ───────────────────────────────────────
let booted = false;
let authBusy = false;
let lastAuthEvent = null;

// ─── Основная инициализация ────────────────────────────────────────────────
async function init() {
  if (booted) return;
  booted = true;

  try {
    // 1. Параллельно: сессия + первичная загрузка state
    let user = null;
    try {
      user = await getCurrentUser();
    } catch (e) {
      console.warn('[init] getCurrentUser failed:', e);
    }

    // 2. Загружаем state: облако (если есть юзер) → localStorage → default
    const loaded = await loadFromBrowser(setStatus).catch((e) => {
      console.warn('[init] loadFromBrowser failed:', e);
      return false;
    });

    if (!loaded) {
      setState(createDefaultState());
      // не запускаем cloud sync здесь — он сам сработает после bindEvents,
      // а сейчас просто кладём в localStorage.
      try {
        localStorage.setItem(
          'green-yard-refactor-v2',
          JSON.stringify(getState()),
        );
      } catch {}
    } else {
      setState(ensureStateShape(getState()));
    }

    // 3. Если пользователь залогинен и в облаке нет записи — мигрируем
    if (user) {
      migrateLocalToCloud(setStatus).catch((e) =>
        console.warn('[init] migrate failed:', e),
      );
    }

    ensureFinanceGeneratedForCurrentMonth();

    // 4. ВАЖНО: bindEvents() вызывается ровно один раз за жизнь страницы.
    bindEvents();

    // 5. Первый рендер + auth UI
    render();
    renderAuthStatus(user);

    // 6. Подписка на auth-события. Не биндит обработчики — только обновляет данные.
    onAuthStateChange(handleAuthChange);
  } catch (e) {
    console.error('[init] fatal:', e);
    // Минимальный fallback: показываем default state, чтобы UI был живым.
    try {
      setState(createDefaultState());
      bindEvents();
      render();
      renderAuthStatus(null);
      setStatus('Ошибка инициализации, работаем локально');
    } catch (e2) {
      console.error('[init] fallback also failed:', e2);
    }
  }
}

// ─── Обработчик auth-событий ───────────────────────────────────────────────
async function handleAuthChange(event, session) {
  // Игнорируем мусорные/повторные события
  if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') return;
  if (event === lastAuthEvent && event !== 'SIGNED_IN' && event !== 'SIGNED_OUT') return;
  lastAuthEvent = event;

  // Защита от реентрантности: Supabase иногда стреляет несколько событий подряд
  if (authBusy) return;
  authBusy = true;

  try {
    const user = session?.user ?? null;

    if (event === 'SIGNED_IN') {
      setStatus('Выполняется вход...');

      const cloudLoaded = await tryLoadFromApi(setStatus).catch(() => false);

      if (cloudLoaded) {
        setState(ensureStateShape(getState()));
        setStatus('Данные загружены из облака');
      } else {
        // В облаке нет записи — отправляем туда текущий локальный state
        await migrateLocalToCloud(setStatus).catch((e) =>
          console.warn('[auth] migrate failed:', e),
        );
        setStatus('Вход выполнен. Данные сохранены в облако.');
      }

      ensureFinanceGeneratedForCurrentMonth();
      // ВНИМАНИЕ: НИКАКОГО bindEvents() здесь. Только render — он лишь перерисует
      // innerHTML внутри контейнеров. Слушатели на статических кнопках живут.
      render();
      renderAuthStatus(user);
    } else if (event === 'SIGNED_OUT') {
      // НЕ обнуляем state — пользователь может продолжать работать локально
      setStatus('Вы вышли. Данные сохранены локально.');
      render();
      renderAuthStatus(null);
    } else if (event === 'INITIAL_SESSION') {
      // Эмитится один раз при подписке. Если есть сессия — синхронизируем UI.
      renderAuthStatus(user);
    }
  } catch (e) {
    console.error('[auth] handler error:', e);
    // Даже если что-то упало — приложение должно продолжать работать.
    setStatus('Ошибка авторизации, продолжаем локально');
  } finally {
    authBusy = false;
  }
}

// ─── Запуск ────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  // DOM уже готов (module-скрипты defer-style, обычно DOM уже распарсен)
  init();
}
