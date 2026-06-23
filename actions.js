
import { getState, setState, structuredCloneSafe, baseItems, MAX_HISTORY } from './state.js';

export function addHistory(entry) {
  const state = getState();
  const historyEntry = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...entry
  };
  state.history.unshift(historyEntry);
  if (state.history.length > MAX_HISTORY) {
    state.history.length = MAX_HISTORY;
  }
  setState(state);
}

export function addApartment() {
  const state = getState();
  const newApartment = {
    id: crypto.randomUUID(),
    name: `Квартира ${state.apartments.length + 1}`,
    items: structuredCloneSafe(baseItems)
  };
  state.apartments.push(newApartment);
  state.activeApartmentId = newApartment.id;
  addHistory({ kind: 'apartment_created', apartmentId: newApartment.id });
  setState(state);
}

export function switchApartment(apartmentId) {
  const state = getState();
  if (!state.apartments.some(a => a.id === apartmentId)) return;
  state.activeApartmentId = apartmentId;
  setState(state);
}

export function deleteApartment(apartmentId) {
  const state = getState();
  const index = state.apartments.findIndex(a => a.id === apartmentId);
  if (index === -1 || state.apartments.length === 1) return;
  const [removed] = state.apartments.splice(index, 1);
  if (state.activeApartmentId === apartmentId) {
    state.activeApartmentId = state.apartments[0].id;
  }
  addHistory({ kind: 'apartment_deleted', apartmentId: removed.id, name: removed.name });
  setState(state);
}

export function renameCurrentApartment(newName) {
  const state = getState();
  const apt = state.apartments.find(a => a.id === state.activeApartmentId);
  if (!apt) return;
  apt.name = newName || '';
  setState(state);
}

export function addCustomItem({ name, unit, category, stock, par }) {
  const state = getState();
  const apt = state.apartments.find(a => a.id === state.activeApartmentId);
  if (!apt) return false;
  const trimmed = (name || '').trim();
  if (!trimmed) return false;

  const item = {
    id: crypto.randomUUID(),
    name: trimmed,
    unit: unit || 'шт',
    category: category === 'linen' ? 'linen' : 'guest',
    stock: Math.max(0, Number(stock || 0)),
    par: Math.max(0, Number(par || 0)),
    perCheckin: 0,
    setAmount: 0
  };

  apt.items.push(item);
  addHistory({
    kind: 'item_created',
    apartmentId: apt.id,
    itemId: item.id,
    name: item.name
  });
  setState(state);
  return true;
}

export function deleteItem(itemId) {
  const state = getState();
  const apt = state.apartments.find(a => a.id === state.activeApartmentId);
  if (!apt) return;
  const index = apt.items.findIndex(i => i.id === itemId);
  if (index === -1) return;
  const [removed] = apt.items.splice(index, 1);
  addHistory({
    kind: 'item_deleted',
    apartmentId: apt.id,
    itemId: removed.id,
    name: removed.name
  });
  setState(state);
}

export function updateItemField(itemId, field, value) {
  const state = getState();
  const apt = state.apartments.find(a => a.id === state.activeApartmentId);
  if (!apt) return;
  const item = apt.items.find(i => i.id === itemId);
  if (!item) return;

  if (['stock', 'par', 'perCheckin', 'setAmount'].includes(field)) {
    item[field] = Math.max(0, Number(value || 0));
  } else if (field === 'name') {
    item.name = String(value || '');
  } else if (field === 'unit') {
    item.unit = String(value || 'шт');
  } else if (field === 'category') {
    item.category = value === 'linen' ? 'linen' : 'guest';
  }

  setState(state);
}

export function applyWriteoff(itemId, rawQty, mode) {
  const state = getState();
  const apt = state.apartments.find(a => a.id === state.activeApartmentId);
  if (!apt) return;
  const item = apt.items.find(i => i.id === itemId);
  if (!item) return;

  const qty = Math.max(0, Number(rawQty || 0));
  if (!qty) return;

  if (mode === 'writeoff') {
    item.stock = Math.max(0, item.stock - qty);
    addHistory({
      kind: 'manual_writeoff',
      apartmentId: apt.id,
      itemId: item.id,
      name: item.name,
      qty
    });
  } else {
    item.stock = item.stock + qty;
    addHistory({
      kind: 'manual_restock',
      apartmentId: apt.id,
      itemId: item.id,
      name: item.name,
      qty
    });
  }

  setState(state);
}

export function newCheckin() {
  const state = getState();
  const apt = state.apartments.find(a => a.id === state.activeApartmentId);
  if (!apt) return;

  const changed = [];

  for (const item of apt.items) {
    if (item.category === 'guest' && item.perCheckin > 0) {
      const qty = item.perCheckin;
      item.stock = Math.max(0, item.stock - qty);
      changed.push({ itemId: item.id, name: item.name, qty });
    }
  }

  if (changed.length) {
    addHistory({
      kind: 'checkin',
      apartmentId: apt.id,
      items: changed
    });
    setState(state);
  }
}

export function restockDefaults() {
  const state = getState();
  const apt = state.apartments.find(a => a.id === state.activeApartmentId);
  if (!apt) return;

  const changed = [];

  for (const item of apt.items) {
    if (item.par > 0 && item.stock < item.par) {
      const diff = item.par - item.stock;
      item.stock = item.par;
      changed.push({ itemId: item.id, name: item.name, qty: diff });
    }
  }

  if (changed.length) {
    addHistory({
      kind: 'restock_to_par',
      apartmentId: apt.id,
      items: changed
    });
    setState(state);
  }
}

export function resetAll() {
  const state = getState();
  const apt = state.apartments.find(a => a.id === state.activeApartmentId);
  if (!apt) return;

  for (const item of apt.items) {
    item.stock = 0;
  }

  addHistory({
    kind: 'reset_all',
    apartmentId: apt.id
  });
  setState(state);
}

export function toggleAutoRequest() {
  const state = getState();
  state.autoRequest = !state.autoRequest;
  addHistory({
    kind: 'auto_request_toggle',
    value: state.autoRequest
  });
  setState(state);
}

/**
 * Создание заявки на закупку.
 * Обязательно: для каждой выбранной позиции qty > 0 и cost > 0.
 */
export function createPurchaseRequest(apartmentId, items) {
  const state = getState();
  const apartment = state.apartments.find(a => a.id === apartmentId);
  if (!apartment) return false;

  const preparedItems = items
    .map(it => ({
      ...it,
      qty: Number(it.qty || 0),
      cost: Number(it.cost || 0)
    }))
    .filter(it => it.qty > 0);

  if (preparedItems.length === 0) {
    return false;
  }

  const hasMissingCost = preparedItems.some(it => !it.cost || it.cost <= 0);
  if (hasMissingCost) {
    return false;
  }

  const request = {
    id: crypto.randomUUID(),
    apartmentId,
    createdAt: new Date().toISOString(),
    done: false,
    items: preparedItems.map(it => ({
      itemId: it.itemId,
      name: it.name,
      unit: it.unit,
      qty: it.qty,
      cost: it.cost
    }))
  };

  state.purchaseRequests.unshift(request);

  addHistory({
    kind: 'purchase_request',
    apartmentId,
    requestId: request.id,
    items: preparedItems.map(it => ({
      itemId: it.itemId,
      name: it.name,
      qty: it.qty
    }))
  });

  setState(state);
  return true;
}

export function toggleRequestDone(requestId) {
  const state = getState();
  const req = state.purchaseRequests.find(r => r.id === requestId);
  if (!req) return;
  req.done = !req.done;
  addHistory({
    kind: 'purchase_request_done_toggle',
    apartmentId: req.apartmentId,
    requestId: req.id,
    done: req.done
  });
  setState(state);
}

export function updateRequestItemCost(requestId, index, rawCost) {
  const state = getState();
  const req = state.purchaseRequests.find(r => r.id === requestId);
  if (!req) return;
  if (!req.items || !req.items[index]) return;
  req.items[index].cost = Math.max(0, Number(rawCost || 0));
  setState(state);
}
