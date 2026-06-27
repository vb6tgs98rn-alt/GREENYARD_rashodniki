import createDefaultState, { ensureStateShape, getState, setState } from './state.js';
import {
  loadFromBrowser,
  migrateLocalToCloud,
  saveToBrowser,
  tryLoadFromApi,
} from './storage.js';
import render, { setStatus, renderAuthStatus } from './render.js';
import bindEvents from './events.js';
import ensureFinanceGeneratedForCurrentMonth from './finance.js';
import { getCurrentUser, onAuthStateChange } from './supabase-client.js';

let eventsBound = false;

async function bootstrapLocalState() {
  if (!(await loadFromBrowser())) {
    setStatus('Создано локальное хранилище');
    setState(createDefaultState());
    await saveToBrowser();
    setStatus('Локальные данные сохранены', true);
  } else {
    setState(ensureStateShape(getState()));
  }
}

async function syncForUser(user) {
  if (!user) return;

  const cloudLoaded = await tryLoadFromApi();
  if (cloudLoaded) {
    setState(ensureStateShape(getState()));
    setStatus('Данные загружены из облака', true);
  } else {
    await migrateLocalToCloud();
    setStatus('Локальные данные отправлены в облако', true);
  }
}

async function init() {
  const user = await getCurrentUser();

  await bootstrapLocalState();

  if (user) {
    await syncForUser(user);
  }

  ensureFinanceGeneratedForCurrentMonth();

  if (!eventsBound) {
    bindEvents();
    eventsBound = true;
  }

  render();
  renderAuthStatus(user);
}

onAuthStateChange(async (event, session) => {
  const user = session?.user ?? null;

  if (event === 'SIGNED_IN') {
    setStatus('Вход выполнен');
    const cloudLoaded = await tryLoadFromApi();

    if (cloudLoaded) {
      setState(ensureStateShape(getState()));
      setStatus('Данные загружены из облака', true);
    } else {
      await migrateLocalToCloud();
      setStatus('Локальные данные отправлены в облако', true);
    }

    ensureFinanceGeneratedForCurrentMonth();
    render();
    renderAuthStatus(user);
    return;
  }

  if (event === 'SIGNED_OUT') {
    setStatus('Выход выполнен', true);
    render();
    renderAuthStatus(null);
    return;
  }

  if (event === 'TOKEN_REFRESHED') {
    renderAuthStatus(user);
  }
});

init();
