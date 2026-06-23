import { dom, byId } from './dom.js';
import { getState } from './state.js';
import { saveToBrowser, exportJson, importJson, syncToApi } from './storage.js';
import { render, renderPurchaseRequestDraft, setStatus, openModal, closeModal, openDrawer, closeDrawer } from './render.js';
import { addApartment, switchApartment, deleteApartment, renameCurrentApartment, addCustomItem, deleteItem, updateItemField, applyWriteoff, newCheckin, restockDefaults, resetAll, toggleAutoRequest, createPurchaseRequest, toggleRequestDone, updateRequestItemCost } from './actions.js';

let pendingRemovalTarget = null;
let pendingStockAction = null;

async function persistAndRender() {
  render();
  saveToBrowser(setStatus);
  await syncToApi();
}

function queueRemoval(targetType, targetId) {
  pendingRemovalTarget = { targetType, targetId };
  openModal('confirmDeleteModal');
}

function clearPendingRemoval() {
  pendingRemovalTarget = null;
}

function openStockActionModal(itemId, mode) {
  pendingStockAction = { itemId, mode };
  const title = dom.writeoffModalTitle();
  const label = dom.writeoffModalLabel();
  if (title) title.textContent = mode === 'writeoff' ? 'Списание' : 'Пополнение';
  if (label) label.textContent = mode === 'writeoff' ? 'Сколько списать' : 'Сколько добавить';
  const qtyInput = dom.writeoffModalQty();
  if (qtyInput) qtyInput.value = '1';
  openModal('writeoffModal');
}

function bindGlobalUiEvents() {
  document.getElementById('openDrawerSidebar')?.addEventListener('click', openDrawer);
  document.getElementById('closeDrawer')?.addEventListener('click', closeDrawer);
  dom.drawerBackdrop()?.addEventListener('click', closeDrawer);
  document.getElementById('cancelDeleteApartment')?.addEventListener('click', () => {
    clearPendingRemoval();
    closeModal('confirmDeleteModal');
  });
  document.getElementById('writeoffModalClose')?.addEventListener('click', () => closeModal('writeoffModal'));
  document.getElementById('writeoffModalCancel')?.addEventListener('click', () => closeModal('writeoffModal'));
  document.getElementById('confirmDeleteApartment')?.addEventListener('click', async () => {
    if (!pendingRemovalTarget) return;
    if (pendingRemovalTarget.targetType === 'item') deleteItem(pendingRemovalTarget.targetId);
    if (pendingRemovalTarget.targetType === 'apartment') deleteApartment(pendingRemovalTarget.targetId);
    clearPendingRemoval();
    closeModal('confirmDeleteModal');
    await persistAndRender();
  });
  document.getElementById('writeoffModalConfirm')?.addEventListener('click', async () => {
    if (!pendingStockAction) return;
    const qty = dom.writeoffModalQty()?.value;
    applyWriteoff(pendingStockAction.itemId, qty, pendingStockAction.mode);
    closeModal('writeoffModal');
    await persistAndRender();
  });
  document.getElementById('exportJsonBtn')?.addEventListener('click', exportJson);
  document.getElementById('importJsonBtn')?.addEventListener('click', () => dom.importJsonInput()?.click());
  dom.importJsonInput()?.addEventListener('change', async e => {
    const file = e.target.files?.[0];
    if (!file) return;
    await importJson(file);
    await persistAndRender();
  });
  document.getElementById('openGuestBotChats')?.addEventListener('click', () => {
    const url = 'https://app.n8nbuzzer.ru';
    try {
      if (window.Telegram?.WebApp?.openLink) window.Telegram.WebApp.openLink(url, { try_instant_view: false });
      else window.location.href = url;
    } catch {
      window.location.href = url;
    }
  });
  document.querySelectorAll('.modal-backdrop').forEach(backdrop => {
    backdrop.addEventListener('click', e => {
      if (e.target === backdrop) backdrop.classList.remove('open');
    });
  });
  document.addEventListener('click', e => {
    const trigger = e.target.closest('[data-toggle-target]');
    if (!trigger) return;
    const body = document.getElementById(trigger.dataset.toggleTarget);
    const expanded = trigger.getAttribute('aria-expanded') === 'true';
    trigger.setAttribute('aria-expanded', String(!expanded));
    body?.classList.toggle('open', !expanded);
  });
}

function bindApartmentEvents() {
  document.getElementById('addApartment')?.addEventListener('click', async () => {
    addApartment();
    await persistAndRender();
  });
  document.getElementById('apartmentSearch')?.addEventListener('input', e => {
    getState().ui.apartmentSearch = e.target.value;
    render();
  });
  document.getElementById('apartmentName')?.addEventListener('input', async e => {
    renameCurrentApartment(e.target.value);
    await persistAndRender();
  });
  document.getElementById('addCustomItem')?.addEventListener('click', async () => {
    const ok = addCustomItem({
      name: dom.newItemName()?.value || '',
      unit: dom.newItemUnit()?.value || 'шт',
      category: dom.newItemCategory()?.value || 'guest',
      stock: dom.newItemStock()?.value || 0,
      par: dom.newItemPar()?.value || 0
    });
    if (!ok) return setStatus('Заполни название расходника.');
    if (dom.newItemName()) dom.newItemName().value = '';
    if (dom.newItemStock()) dom.newItemStock().value = '0';
    if (dom.newItemPar()) dom.newItemPar().value = '0';
    await persistAndRender();
  });
  document.getElementById('newCheckin')?.addEventListener('click', async () => {
    newCheckin();
    await persistAndRender();
  });
  document.getElementById('restockDefaults')?.addEventListener('click', async () => {
    restockDefaults();
    await persistAndRender();
  });
  document.getElementById('resetAll')?.addEventListener('click', async () => {
    resetAll();
    await persistAndRender();
  });
  document.addEventListener('click', async e => {
    const apartmentButton = e.target.closest('[data-apartment-id]');
    if (apartmentButton) {
      switchApartment(apartmentButton.dataset.apartmentId);
      await persistAndRender();
      return;
    }
    const apartmentRemovalButton = e.target.closest('[data-delete-apartment-id]');
    if (apartmentRemovalButton && !apartmentRemovalButton.disabled) {
      queueRemoval('apartment', apartmentRemovalButton.dataset.deleteApartmentId);
      return;
    }
    const itemRemovalButton = e.target.closest('[data-delete-item-id]');
    if (itemRemovalButton) {
      queueRemoval('item', itemRemovalButton.dataset.deleteItemId);
      return;
    }
    const itemActionButton = e.target.closest('[data-item-action]');
    if (itemActionButton) {
      openStockActionModal(itemActionButton.dataset.itemId, itemActionButton.dataset.itemAction);
    }
  });
  document.addEventListener('input', async e => {
    const itemFieldInput = e.target.closest('[data-field]');
    if (!itemFieldInput) return;
    updateItemField(itemFieldInput.dataset.id, itemFieldInput.dataset.field, itemFieldInput.value);
    await persistAndRender();
  });
}

function bindPurchaseEvents() {
  document.getElementById('openPurchaseRequestsModal')?.addEventListener('click', () => openModal('purchaseRequestsModal'));
  document.getElementById('closePurchaseRequestsModal')?.addEventListener('click', () => closeModal('purchaseRequestsModal'));
  document.getElementById('openNewPurchaseRequest')?.addEventListener('click', () => {
    renderPurchaseRequestDraft();
    openModal('newPurchaseRequestModal');
  });
  document.getElementById('closeNewPurchaseRequestModal')?.addEventListener('click', () => closeModal('newPurchaseRequestModal'));
  document.getElementById('cancelNewPurchaseRequest')?.addEventListener('click', () => closeModal('newPurchaseRequestModal'));
  document.getElementById('autoRequestToggle')?.addEventListener('click', async () => {
    toggleAutoRequest();
    await persistAndRender();
  });
  dom.purchaseApartmentSelect()?.addEventListener('change', renderPurchaseRequestDraft);
  document.getElementById('saveNewPurchaseRequest')?.addEventListener('click', async () => {
    const apartmentId = dom.purchaseApartmentSelect()?.value;
    const apartment = getState().apartments.find(a => a.id === apartmentId);
    if (!apartment) return setStatus('Квартира не найдена.');
    const items = apartment.items.map(item => ({
      itemId: item.id,
      name: item.name,
      unit: item.unit,
      qty: document.querySelector(`[data-purchase-qty="${item.id}"]`)?.value || 0
    }));
    const ok = createPurchaseRequest(apartmentId, items);
    if (!ok) return setStatus('Укажи количество хотя бы для одной позиции.');
    closeModal('newPurchaseRequestModal');
    await persistAndRender();
  });
  document.addEventListener('click', async e => {
    const requestDoneCheckbox = e.target.closest('[data-request-done]');
    if (!requestDoneCheckbox) return;
    toggleRequestDone(requestDoneCheckbox.dataset.requestDone);
    await persistAndRender();
  });
  document.addEventListener('input', async e => {
    const requestCostInput = e.target.closest('[data-request-cost]');
    if (!requestCostInput) return;
    const [requestId, idx] = requestCostInput.dataset.requestCost.split(':');
    updateRequestItemCost(requestId, Number(idx), requestCostInput.value);
    await persistAndRender();
  });
}

function bindHistoryEvents() {
  document.getElementById('openHistoryModal')?.addEventListener('click', () => openModal('historyModal'));
  document.getElementById('closeHistoryModal')?.addEventListener('click', () => closeModal('historyModal'));
  document.addEventListener('click', e => {
    const historyFilterButton = e.target.closest('[data-history-filter]');
    if (!historyFilterButton) return;
    getState().ui.historyFilterApartmentId = historyFilterButton.dataset.historyFilter;
    render();
  });
}

function bindSettingsEvents() {
  document.getElementById('openSettings')?.addEventListener('click', () => openModal('settingsModal'));
  document.getElementById('closeSettings')?.addEventListener('click', () => closeModal('settingsModal'));
  document.getElementById('drawerThemeToggle')?.addEventListener('click', async () => {
    getState().ui.theme = getState().ui.theme === 'dark' ? 'light' : 'dark';
    await persistAndRender();
  });
}

function bindKnowledgeBaseEvents() {
  document.getElementById('openKnowledgeBase')?.addEventListener('click', () => openModal('kbModal'));
  document.getElementById('kbClose')?.addEventListener('click', () => closeModal('kbModal'));
  document.addEventListener('click', e => {
    const knowledgeBaseTabButton = e.target.closest('[data-kb-target]');
    if (!knowledgeBaseTabButton) return;
    document.querySelectorAll('#kbNav .history-chip').forEach(button => button.classList.toggle('active', button === knowledgeBaseTabButton));
    document.querySelectorAll('.kb-section').forEach(section => section.classList.toggle('active', section.id === knowledgeBaseTabButton.dataset.kbTarget));
  });
}

export function bindEvents() {
  bindGlobalUiEvents();
  bindApartmentEvents();
  bindPurchaseEvents();
  bindHistoryEvents();
  bindSettingsEvents();
  bindKnowledgeBaseEvents();
}
