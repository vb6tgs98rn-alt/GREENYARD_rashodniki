import { createDefaultState, ensureStateShape, getState, setState } from './state.js';
import { loadFromBrowser, saveToBrowser } from './storage.js';
import { render, setStatus } from './render.js';
import { bindEvents } from './events.js';
import { ensureFinanceGeneratedForCurrentMonth } from './finance.js';

async function init() {
  if (!(await loadFromBrowser(setStatus))) {
    setState(createDefaultState());
    await saveToBrowser(setStatus, true);
  } else {
    setState(ensureStateShape(getState()));
  }
  ensureFinanceGeneratedForCurrentMonth();
  bindEvents();
  render();
}

init();
