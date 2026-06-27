import { createDefaultState, ensureStateShape, getState, setState } from './state.js';
import { loadFromBrowser, migrateLocalToCloud, saveToBrowser, tryLoadFromApi } from './storage.js';
import { render, setStatus, renderAuthStatus } from './render.js';
import { bindEvents } from './events.js';
import { ensureFinanceGeneratedForCurrentMonth } from './finance.js';
import { getCurrentUser, onAuthStateChange } from './supabase-client.js';

// ─── Основная инициализация ────────────────────────────────────────────────

async function init() {
  // 1. Восстанавливаем сессию (Supabase сам читает её из localStorage/cookie)
  //    getCurrentUser() — лёгкий вызов, не делает сетевых запросов если сессии нет
  const user = await getCurrentUser();

  // 2. Загружаем state: облако → localStorage → default
  if (!(await loadFromBrowser(setStatus))) {
    setState(createDefaultState());
    await saveToBrowser(setStatus, true);
  } else {
    setState(ensureStateShape(getState()));
  }

  // 3. Если пользователь залогинен и в облаке нет записи — мигрируем локальные данные
  if (user) {
    await migrateLocalToCloud();
  }

  ensureFinanceGeneratedForCurrentMonth();
  bindEvents();
  render();

  // 4. Обновляем auth UI в drawer
  renderAuthStatus(user);
}

// ─── Реакция на изменения сессии auth ────────────────────────────────────

onAuthStateChange(async (event, session) => {
  const user = session?.user ?? null;

  if (event === 'SIGNED_IN') {
    setStatus('Выполняется вход...');

    // Пробуем загрузить облачный state
    const cloudLoaded = await tryLoadFromApi();

    if (cloudLoaded) {
      // Облако загружено — применяем
      setState(ensureStateShape(getState()));
      setStatus('Данные загружены из облака');
    } else {
      // В облаке нет записи — мигрируем локальные данные
      await migrateLocalToCloud();
      setStatus('Вход выполнен. Данные из браузера сохранены в облако.');
    }

    ensureFinanceGeneratedForCurrentMonth();
    render();
    renderAuthStatus(user);

  } else if (event === 'SIGNED_OUT') {
    setStatus('Вы вышли. Данные сохранены локально.');
    renderAuthStatus(null);

  } else if (event === 'TOKEN_REFRESHED') {
    // Молчим — фоновое обновление токена
  }
});

// ─── Запуск ────────────────────────────────────────────────────────────────

init();
