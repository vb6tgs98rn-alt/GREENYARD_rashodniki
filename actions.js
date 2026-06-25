
import { getState, updateState, currentApartment, getDisplayApartmentName, roundSmart } from './state.js';

export function addHistory(action, details = '', type = 'info') {
  const state = getState();
  const apartment = currentApartment();
  state.history.unshift({
    id: crypto.randomUUID(),
    apartmentId: apartment?.id || '',
    apartmentName: getDisplayApartmentName(apartment?.name),
    action,
    details,
    type,
    createdAt: new Date().toISOString()
  });
  state.history = state.history.slice(0, 40);
}

export function addApartment() {
  updateState(state => {
    const id = crypto.randomUUID();
    state.apartments.push({ id, name: `Квартира ${state.apartments.length + 1}`, items: JSON.parse(JSON.stringify(state.apartments[0].items)) });
    state.activeApartmentId = id;
  });
  addHistory('Добавлена квартира', '', 'create');
}

export function renameCurrentApartment(name) {
  const apartment = currentApartment();
  if (!apartment) return;
  apartment.name = name;
}

export function switchApartment(id) {
  updateState(state => { state.activeApartmentId = id; });
}

export function deleteApartment(id) {
  updateState(state => {
    if (state.apartments.length <= 1) return;
    const target = state.apartments.find(a => a.id === id);
    state.apartments = state.apartments.filter(a => a.id !== id);
    state.purchaseRequests = state.purchaseRequests.filter(r => r.apartmentId !== id);
    if (state.activeApartmentId === id) state.activeApartmentId = state.apartments[0].id;
    if (target) addHistory('Удалена квартира', getDisplayApartmentName(target.name), 'delete');
  });
}

export function addCustomItem(payload) {
  const apartment = currentApartment();
  if (!apartment || !payload.name.trim()) return false;
  const item = {
    id: `${payload.category}-${Date.now()}`,
    name: payload.name.trim(),
    unit: payload.unit,
    stock: Math.max(0, Number(payload.stock || 0)),
    par: Math.max(0, Number(payload.par || 0)),
    category: payload.category === 'linen' ? 'linen' : 'guest',
    perCheckin: 0,
    setAmount: 0
  };
  apartment.items.push(item);
  addHistory('Добавлен расходник', `${item.name}, ${roundSmart(item.stock)} ${item.unit}`, 'create');
  return true;
}

export function deleteItem(itemId) {
  const apartment = currentApartment();
  if (!apartment) return;
  const item = apartment.items.find(i => i.id === itemId);
  apartment.items = apartment.items.filter(i => i.id !== itemId);
  if (item) addHistory('Удалён расходник', item.name, 'delete');
}

export function updateItemField(itemId, field, value) {
  const apartment = currentApartment();
  if (!apartment) return;
  const item = apartment.items.find(i => i.id === itemId);
  if (!item) return;
  if (['stock','par','perCheckin','setAmount'].includes(field)) item[field] = Math.max(0, Number(value || 0));
  if (field === 'name' || field === 'unit') item[field] = value;
}

export function applyWriteoff(itemId, qty, mode) {
  const apartment = currentApartment();
  if (!apartment) return;
  const item = apartment.items.find(i => i.id === itemId);
  if (!item) return;
  const amount = Math.max(0.1, Number(qty || 1));
  if (mode === 'writeoff') {
    item.stock = Math.max(0, Number(item.stock) - amount);
    addHistory('Списание', `${item.name}: -${roundSmart(amount)} ${item.unit}`, 'writeoff');
    if (getState().autoRequest && item.category === 'linen') {
      getState().purchaseRequests.unshift({
        id: crypto.randomUUID(), apartmentId: apartment.id, apartmentName: getDisplayApartmentName(apartment.name), auto: true, done: false, createdAt: new Date().toISOString(),
        items: [{ itemId: item.id, name: item.name, unit: item.unit, qty: amount, cost: '' }]
      });
      addHistory('Авто-заявка на закупку', `${item.name}: ${roundSmart(amount)} ${item.unit}`, 'auto');
    }
  } else {
    item.stock = Number(item.stock) + amount;
    addHistory('Пополнение', `${item.name}: +${roundSmart(amount)} ${item.unit}`, 'restock');
  }
}

export function newCheckin() {
  const apartment = currentApartment();
  if (!apartment) return;
  apartment.items.forEach(item => {
    if (item.category === 'guest' && item.perCheckin > 0) {
      item.stock = Math.max(0, Number(item.stock) - Number(item.perCheckin));
    }
  });
  addHistory('Новый заезд', 'Автосписание одноразовых расходников', 'checkin');
}

export function restockDefaults() {
  const apartment = currentApartment();
  if (!apartment) return;
  apartment.items.forEach(item => { item.stock = Math.max(item.stock, item.par); });
  addHistory('Пополнение до нормы', '', 'restock');
}

export function resetAll() {
  const apartment = currentApartment();
  if (!apartment) return;
  apartment.items.forEach(item => { item.stock = item.par; });
  addHistory('Сброс остатков', 'Все позиции приведены к норме', 'reset');
}

export function toggleAutoRequest() {
  updateState(state => { state.autoRequest = !state.autoRequest; });
}

export function createPurchaseRequest(apartmentId, items) {
  const apartment = getState().apartments.find(a => a.id === apartmentId);
  if (!apartment) return false;
  const normalized = items.filter(i => Number(i.qty) > 0).map(i => ({ ...i, qty: Number(i.qty), cost: '' }));
  if (!normalized.length) return false;
  getState().purchaseRequests.unshift({
    id: crypto.randomUUID(), apartmentId, apartmentName: getDisplayApartmentName(apartment.name), auto: false, done: false, createdAt: new Date().toISOString(), items: normalized
  });
  addHistory('Создана заявка на закупку', `${normalized.length} поз.`, 'request');
  return true;
}

export function toggleRequestDone(id) {
  const req = getState().purchaseRequests.find(r => r.id === id);
  if (!req) return;
  req.done = !req.done;
  addHistory(req.done ? 'Заказ выполнен' : 'Заказ снова открыт', req.apartmentName, 'request');
}

export function updateRequestItemCost(requestId, itemIndex, cost) {
  const req = getState().purchaseRequests.find(r => r.id === requestId);
  if (!req || !req.items[itemIndex]) return;
  req.items[itemIndex].cost = cost;
}
