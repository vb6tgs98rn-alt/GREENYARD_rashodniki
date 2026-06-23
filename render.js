import { dom, byId } from './dom.js';

import { getState, currentApartment, getDisplayApartmentName, roundSmart, statusBy, ALL_APARTMENTS_FILTER } from './state.js';

export function setStatus(text) {
  const el = dom.saveStatus();
  if (el) el.textContent = text;
}

function apartmentButton(apartment) {
  const state = getState();
  const active = apartment.id === state.activeApartmentId;
  const low = apartment.items.filter(item => statusBy(item).cls === 'low').length;
  const disableDelete = state.apartments.length === 1 ? 'disabled' : '';
  return `
    <div class="apartment-row">
      <button class="apartment-btn ${active ? 'active' : ''}" data-apartment-id="${apartment.id}">
        <div class="apartment-meta">
          <strong>${getDisplayApartmentName(apartment.name)}</strong>
          <span class="small">${low ? `Низкий остаток: ${low}` : 'Без критических остатков'}</span>
        </div>
        <span class="small">${apartment.items.length} поз.</span>
      </button>
      <button class="trash-btn" data-delete-apartment-id="${apartment.id}" ${disableDelete} aria-label="Удалить квартиру">🗑</button>
    </div>`;
}

function itemCard(item) {
  const status = statusBy(item);
  const percent = item.par > 0 ? Math.max(0, Math.min(100, item.stock / item.par * 100)) : 0;
  return `
    <article class="item-card ${status.cls === 'low' ? 'highlight' : ''}">
      <div class="item-head">
        <div>
          <div class="item-name">${item.name}</div>
          <div class="small">${item.unit} · норма ${roundSmart(item.par)}</div>
        </div>
        <span class="badge ${status.cls}">${status.label}</span>
      </div>
      <div class="row">
        <div>
          <div class="small">Остаток</div>
          <div class="qty">${roundSmart(item.stock)}</div>
        </div>
        <div>
          <div class="small">Прогресс</div>
          <div class="progress"><span style="width:${percent}%"></span></div>
        </div>
      </div>
      <div class="quick-controls">
        <button class="mini-btn" data-item-action="writeoff" data-item-id="${item.id}">Списать</button>
        <button class="mini-btn" data-item-action="restock" data-item-id="${item.id}">Пополнить</button>
        <button class="mini-btn" data-delete-item-id="${item.id}">Удалить</button>
      </div>
    </article>`;
}

export function render() {
  const state = getState();
  const apartment = currentApartment();
  if (!apartment) return;

  document.documentElement.setAttribute('data-theme', state.ui.theme || 'light');
  const themeToggle = dom.drawerThemeToggle();
  themeToggle?.classList.toggle('active', state.ui.theme === 'dark');
  const label = dom.themeLabel();
  if (label) label.textContent = state.ui.theme === 'dark' ? 'Тёмная' : 'Светлая';

  dom.pageTitle().textContent = getDisplayApartmentName(apartment.name);
  dom.apartmentName().value = apartment.name || '';
  dom.apartmentSearch().value = state.ui.apartmentSearch || '';

  const filteredApartments = state.apartments.filter(a => getDisplayApartmentName(a.name).toLowerCase().includes((state.ui.apartmentSearch || '').toLowerCase()));
  dom.apartmentsList().innerHTML = filteredApartments.length ? filteredApartments.map(apartmentButton).join('') : '<div class="empty">Ничего не найдено</div>';

  const linenItems = apartment.items.filter(i => i.category === 'linen');
  const guestItems = apartment.items.filter(i => i.category === 'guest');
  dom.linenList().innerHTML = linenItems.length ? `<div class="grid">${linenItems.map(itemCard).join('')}</div>` : '<div class="empty">Нет не одноразовых позиций</div>';
  dom.guestList().innerHTML = guestItems.length ? `<div class="grid">${guestItems.map(itemCard).join('')}</div>` : '<div class="empty">Нет одноразовых позиций</div>';

  const total = apartment.items.length;
  const low = apartment.items.filter(i => statusBy(i).cls === 'low').length;
  const warn = apartment.items.filter(i => statusBy(i).cls === 'warn').length;
  const full = apartment.items.filter(i => statusBy(i).cls === 'ok').length;
  dom.statsGrid().innerHTML = `
    <article class="stat"><span>Всего позиций</span><strong>${total}</strong></article>
    <article class="stat"><span>Низкий остаток</span><strong>${low}</strong></article>
    <article class="stat"><span>Средний запас</span><strong>${warn}</strong></article>
    <article class="stat"><span>Норма</span><strong>${full}</strong></article>`;

  dom.dailyUsage().innerHTML = guestItems.length ? guestItems.map(item => `<div class="line"><span>${item.name}</span><strong>${roundSmart(item.perCheckin)} ${item.unit}</strong></div>`).join('') : '<div class="empty">Нет данных</div>';
  dom.setUsage().innerHTML = linenItems.length ? linenItems.map(item => `<div class="line"><span>${item.name}</span><strong>${roundSmart(item.setAmount)} ${item.unit}</strong></div>`).join('') : '<div class="empty">Нет данных</div>';
  dom.coverageList().innerHTML = apartment.items.map(item => {
    const coverage = item.perCheckin > 0 ? Math.floor(item.stock / item.perCheckin) : (item.setAmount > 0 ? Math.floor(item.stock / item.setAmount) : '—');
    return `<div class="line"><span>${item.name}</span><strong>${coverage}</strong></div>`;
  }).join('');

  renderHistoryModal();
  renderPurchaseRequests();
  renderPurchaseRequestDraft();
  renderSettings();
}

export function renderHistoryModal() {
  const state = getState();
  const filterWrap = dom.historyApartmentFilter();
  const list = dom.historyModalList();
  const buttons = [{ id: ALL_APARTMENTS_FILTER, label: 'Все' }, ...state.apartments.map(a => ({ id: a.id, label: getDisplayApartmentName(a.name) }))];
  filterWrap.innerHTML = buttons.map(btn => `<button class="history-chip ${state.ui.historyFilterApartmentId === btn.id ? 'active' : ''}" data-history-filter="${btn.id}">${btn.label}</button>`).join('');
  const records = state.history.filter(entry => state.ui.historyFilterApartmentId === ALL_APARTMENTS_FILTER || entry.apartmentId === state.ui.historyFilterApartmentId);
  list.innerHTML = records.length ? records.map(entry => `
    <article class="history-card">
      <div class="history-card-header">
        <div>
          <div class="history-kind">${entry.action}</div>
          <strong>${entry.apartmentName}</strong>
        </div>
        <div class="small">${new Date(entry.createdAt).toLocaleString('ru-RU')}</div>
      </div>
      <div>${entry.details || '—'}</div>
    </article>`).join('') : '<div class="empty">История пока пуста</div>';
}

export function renderPurchaseRequests() {
  const state = getState();
  const wrap = dom.purchaseRequestsList();
  const toggle = dom.autoRequestToggle();
  toggle?.classList.toggle('active', state.autoRequest);
  wrap.innerHTML = state.purchaseRequests.length ? state.purchaseRequests.map(req => {
    const totalCost = req.items.reduce((sum, item) => sum + Number(item.cost || 0), 0);
    return `
      <article class="request-card">
        <div class="request-card-header">
          <div>
            <div class="request-kind">${req.done ? '✓ Выполнено' : (req.auto ? 'Авто-заявка' : 'Заявка')}</div>
            <strong>${req.apartmentName}</strong>
          </div>
          <div class="small">${new Date(req.createdAt).toLocaleString('ru-RU')}</div>
        </div>
        <div class="request-list">
          ${req.items.map((item, idx) => `
            <div class="request-item">
              <input class="request-check" type="checkbox" ${req.done ? 'checked' : ''} data-request-done="${req.id}" />
              <div>
                <strong>${item.name}</strong>
                <div class="small">${roundSmart(item.qty)} ${item.unit}</div>
              </div>
              <input type="number" min="0" step="0.01" placeholder="Стоимость" value="${item.cost || ''}" data-request-cost="${req.id}:${idx}" />
            </div>`).join('')}
        </div>
        <div class="small">Итого: ${totalCost ? totalCost.toFixed(2) + ' ₽' : '—'}</div>
      </article>`;
  }).join('') : '<div class="empty">Пока нет заявок</div>';
}

export function renderPurchaseRequestDraft() {
  const state = getState();
  const select = dom.purchaseApartmentSelect();
  const hint = dom.purchaseApartmentHint();
  const itemsWrap = dom.purchaseItemsWrap();
  if (!select || !itemsWrap) return;
  select.innerHTML = state.apartments.map(a => `<option value="${a.id}" ${a.id === state.activeApartmentId ? 'selected' : ''}>${getDisplayApartmentName(a.name)}</option>`).join('');
  const apartment = state.apartments.find(a => a.id === select.value) || currentApartment();
  if (!apartment) return;
  hint.textContent = `Выбрана квартира: ${getDisplayApartmentName(apartment.name)}`;
  itemsWrap.innerHTML = `<div class="grid">${apartment.items.map(item => `
    <div class="line">
      <span>${item.name}</span>
      <div style="display:flex;gap:.75rem;align-items:center;">
        <span class="small">${item.unit}</span>
        <input type="number" min="0" step="0.1" value="0" data-purchase-qty="${item.id}" style="width:110px;" />
      </div>
    </div>`).join('')}</div>`;
}

export function renderSettings() {
  const apartment = currentApartment();
  if (!apartment) return;
  const deduction = dom.deductionSettings();
  const set = dom.setSettings();
  deduction.innerHTML = apartment.items.filter(i => i.category === 'guest').map(item => `
    <label>
      <span class="small">${item.name}</span>
      <input type="number" min="0" step="0.1" value="${item.perCheckin}" data-field="perCheckin" data-id="${item.id}" />
    </label>`).join('') || '<div class="empty">Нет одноразовых позиций</div>';
  set.innerHTML = apartment.items.filter(i => i.category === 'linen').map(item => `
    <label>
      <span class="small">${item.name}</span>
      <input type="number" min="0" step="0.1" value="${item.setAmount}" data-field="setAmount" data-id="${item.id}" />
    </label>`).join('') || '<div class="empty">Нет не одноразовых позиций</div>';
}

export function openModal(id) { const el = byId(id); if (el) { el.classList.add('open'); el.setAttribute('aria-hidden', 'false'); } }
export function closeModal(id) { const el = byId(id); if (el) { el.classList.remove('open'); el.setAttribute('aria-hidden', 'true'); } }
export function openDrawer() { document.getElementById('drawerMenu')?.classList.add('open'); document.getElementById('drawerBackdrop')?.classList.add('open'); }
export function closeDrawer() { document.getElementById('drawerMenu')?.classList.remove('open'); document.getElementById('drawerBackdrop')?.classList.remove('open'); }
