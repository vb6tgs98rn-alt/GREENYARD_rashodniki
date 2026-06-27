import { createDefaultState, ensureStateShape, getState, setState } from './state.js';
import { loadFromBrowser, migrateLocalToCloud, saveToBrowser, tryLoadFromApi } from './storage.js';
import { render, setStatus, renderAuthStatus } from './render.js';
import { bindEvents } from './events.js';
import { ensureFinanceGeneratedForCurrentMonth } from './finance.js';
import { getCurrentUser, onAuthStateChange } from './supabase-client.js';

async function init() {
  const user = await getCurrentUser();

  if (!(await loadFromBrowser(setStatus))) {
    setState(createDefaultState());
    await saveToBrowser(setStatus, true);
  } else {
    setState(ensureStateShape(getState()));
  }

  if (user) {
    await migrateLocalToCloud();
  }

  ensureFinanceGeneratedForCurrentMonth();
  bindEvents();
  render();
  renderAuthStatus(user);

  onAuthStateChange(async (event, session) => {
    const authUser = session?.user ?? null;

    if (event === 'SIGNED_IN') {
      setStatus('Выполняется вход...');

      const cloudLoaded = await tryLoadFromApi();

      if (cloudLoaded) {
        setState(ensureStateShape(getState()));
        setStatus('Данные загружены из облака');
      } else {
        await migrateLocalToCloud();
        setStatus('Вход выполнен. Данные из браузера сохранены в облако.');
      }

      ensureFinanceGeneratedForCurrentMonth();
      render();
      renderAuthStatus(authUser);
      return;
    }

    if (event === 'SIGNED_OUT') {
      setStatus('Вы вышли. Данные сохранены локально.');
      renderAuthStatus(null);
      render();
      return;
    }
  });
}

init();
