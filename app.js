import { createDefaultState, setState, getState } from './state.js';
import { loadFromBrowser, saveToBrowser } from './storage.js';
import { render, setStatus } from './render.js';
import { bindEvents } from './events.js';

async function init() {
  if (!(await loadFromBrowser(setStatus))) {
    setState(createDefaultState());
    setStatus('Создано новое локальное хранилище');
    saveToBrowser(setStatus, true);
  }
  if (!getState().ui) getState().ui = { historyFilterApartmentId: 'all', theme: 'light', apartmentSearch: '' };
  bindEvents();
  render();
}

init();
