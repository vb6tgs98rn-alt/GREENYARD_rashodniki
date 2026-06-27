import dom, { byId } from './dom.js';
import { normalizeRealtyCalendarBooking, syncRealtyCalendarBookings } from './api.js';
import { addFinanceEntry, addRecurringRule, deleteFinanceEntry, deleteRecurringRule, updateFinanceEntryStatus, toggleRecurringRule, ensureFinanceGeneratedForCurrentMonth, importBookingsToFinance, monthKey, createFinanceEntryDraft } from './finance.js';
import { closeDrawer, closeModal, openDrawer, openModal, render, renderAuthStatus, setStatus, setAuthMsg } from './render.js';
import { currentApartment, getDisplayApartmentName, getState, roundSmart, updateState } from './state.js';
import { persistState, exportJson, importJson } from './storage.js';
import { signInWithEmail, signUpWithEmail, signOutUser } from './supabase-client.js';
import { addApartment, addCustomItem, applyWriteoff, createPurchaseRequest, deleteApartment, deleteItem, newCheckin, renameCurrentApartment, resetAll, restockDefaults, toggleAutoRequest, toggleRequestDone, updateItemField, updateRequestItemCost } from './actions.js';

async function rerender(statusText = 'Сохранено') {
  ensureFinanceGeneratedForCurrentMonth();
  render();
  // persistState сам выберёт: облако (если вошёл) или localStorage (если не вошёл).
  // Вызываем с silent=true — своё собственное сообщение покажем ниже.
  persistState(setStatus, true).catch((e) => console.warn('[events] persistState bg error:', e));
  setStatus(statusText);
}

// ─── Drawer ────────────────────────────────────────────────────────────────
function bindDrawers() {
  dom.openDrawerSidebar?.addEventListener('click', openDrawer);
  dom.closeDrawer?.addEventListener('click', closeDrawer);
  dom.drawerBackdrop?.addEventListener('click', closeDrawer);
}

// ─── Тема ─────────────────────────────────────────────────────────────────
function bindTheme() {
  dom.drawerThemeToggle?.addEventListener('click', async () => {
    updateState((state) => { state.ui.theme = state.ui.theme === 'dark' ? 'light' : 'dark'; });
    await rerender('Тема обновлена');
  });
}

// ─── Навигация секций (только кнопки sidebar) ──────────────────────────────
function bindSectionNav() {
  dom.sidebarNavButtons.forEach((button) => {
    button.addEventListener('click', async () => {
      updateState((state) => { state.ui.activeSection = button.dataset.section; });
      await rerender();
      closeDrawer();
    });
  });
  // Кнопка финансов в drawer — открываем модальное окно
  dom.financeDrawerButton?.addEventListener('click', async () => {
    ensureFinanceGeneratedForCurrentMonth();
    render();
    openModal('financeModal');
    closeDrawer();
  });
}

// ─── Модальные окна из drawer ──────────────────────────────────────────────
function bindDrawerModals() {
  byId('openHistoryModal')?.addEventListener('click', () => { renderHistoryModal(); openModal('historyModal'); closeDrawer(); });
  byId('closeHistoryModal')?.addEventListener('click', () => closeModal('historyModal'));

  byId('openPurchaseRequestsModal')?.addEventListener('click', () => { renderPurchaseModal(); openModal('purchaseRequestsModal'); closeDrawer(); });
  byId('closePurchaseRequestsModal')?.addEventListener('click', () => closeModal('purchaseRequestsModal'));

  byId('closeFinanceModal')?.addEventListener('click', () => closeModal('financeModal'));
  byId('financeModal')?.addEventListener('click', (e) => { if (e.target === byId('financeModal')) closeModal('financeModal'); });
  byId('openFinanceSettings')?.addEventListener('click', () => openModal('financeSettingsModal'));
  byId('closeFinanceSettings')?.addEventListener('click', () => closeModal('financeSettingsModal'));
  byId('financeSettingsModal')?.addEventListener('click', (e) => { if (e.target === byId('financeSettingsModal')) closeModal('financeSettingsModal'); });
  // Табы внутри финансового модала
  byId('financeTabsNav')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-finance-tab]');
    if (!chip) return;
    const tab = chip.dataset.financeTab;
    ['entries','recurring','summary'].forEach(t => {
      const el = byId(`financeTab${t.charAt(0).toUpperCase() + t.slice(1)}`);
      if (el) el.hidden = t !== tab;
    });
    document.querySelectorAll('#financeTabsNav [data-finance-tab]').forEach(b => b.classList.toggle('active', b === chip));
  });

  byId('openKnowledgeBase')?.addEventListener('click', () => { openModal('kbModal'); closeDrawer(); });
  byId('kbClose')?.addEventListener('click', () => closeModal('kbModal'));

  byId('openGuestBotChats')?.addEventListener('click', () => { window.open('https://n8n.example.com', '_blank'); closeDrawer(); });
}

// ─── История ───────────────────────────────────────────────────────────────
function renderHistoryModal() {
  const state = getState();
  const filter = state.ui.historyFilterApartmentId || 'all';
  if (!dom.historyApartmentFilter || !dom.historyModalList) return;
  dom.historyApartmentFilter.innerHTML = [
    `<button class="history-chip ${filter === 'all' ? 'active' : ''}" data-history-filter="all">Все</button>`,
    ...state.apartments.map(a => `<button class="history-chip ${filter === a.id ? 'active' : ''}" data-history-filter="${a.id}">${getDisplayApartmentName(a.name)}</button>`)
  ].join('');
  const entries = filter === 'all' ? state.history : state.history.filter(e => e.apartmentId === filter);
  dom.historyModalList.innerHTML = entries.length
    ? entries.map(e => `<div class="history-row"><div><strong>${e.action}</strong>${e.details ? `<div class="small">${e.details}</div>` : ''}</div><div class="small">${e.apartmentName ? `<span>${e.apartmentName}</span> · ` : ''}${new Date(e.createdAt).toLocaleString('ru-RU')}</div></div>`).join('')
    : '<div class="empty">Нет записей.</div>';
}
function bindHistory() {
  dom.historyApartmentFilter?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-history-filter]');
    if (!btn) return;
    updateState((s) => { s.ui.historyFilterApartmentId = btn.dataset.historyFilter; });
    renderHistoryModal();
  });
}

// ─── Поиск квартир и переключение ─────────────────────────────────────────
function bindApartmentSearch() {
  dom.apartmentSearch?.addEventListener('input', () => {
    updateState((s) => { s.ui.apartmentSearch = dom.apartmentSearch.value; });
    render();
  });
  dom.apartmentsList?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-apartment-id]');
    if (!btn) return;
    updateState((s) => { s.activeApartmentId = btn.dataset.apartmentId; });
    await rerender('Квартира переключена');
  });
}

// ─── Параметры квартиры ────────────────────────────────────────────────────
function bindApartmentParams() {
  byId('addApartment')?.addEventListener('click', async () => {
    addApartment();
    await rerender('Квартира добавлена');
  });

  dom.apartmentName?.addEventListener('input', () => {
    renameCurrentApartment(dom.apartmentName.value);
    render();
  });
  dom.apartmentName?.addEventListener('change', async () => {
    await rerender('Название сохранено');
  });

  byId('addCustomItem')?.addEventListener('click', async () => {
    const ok = addCustomItem({
      name: byId('newItemName')?.value || '',
      unit: byId('newItemUnit')?.value || 'шт',
      category: byId('newItemCategory')?.value || 'guest',
      stock: byId('newItemStock')?.value || 0,
      par: byId('newItemPar')?.value || 0
    });
    if (ok) {
      ['newItemName','newItemStock','newItemPar'].forEach(id => { const el = byId(id); if (el) el.value = id === 'newItemName' ? '' : '0'; });
      await rerender('Позиция добавлена');
    }
  });
}

// ─── Быстрые действия ─────────────────────────────────────────────────────
function bindQuickActions() {
  byId('newCheckin')?.addEventListener('click', async () => { newCheckin(); await rerender('Новый заезд зафиксирован'); });
  byId('restockDefaults')?.addEventListener('click', async () => { restockDefaults(); await rerender('Пополнено до нормы'); });
  byId('resetAll')?.addEventListener('click', async () => {
    if (confirm('Сбросить все остатки к норме? Это действие нельзя отменить.')) { resetAll(); await rerender('Остатки сброшены'); }
  });
  byId('openSettings')?.addEventListener('click', () => { renderSettingsModal(); openModal('settingsModal'); });
  byId('closeSettings')?.addEventListener('click', () => closeModal('settingsModal'));
}

// ─── Настройки списания ────────────────────────────────────────────────────
function renderSettingsModal() {
  const apartment = currentApartment();
  if (!apartment || !dom.deductionSettings || !dom.setSettings) return;
  const guestItems = apartment.items.filter(i => i.category === 'guest');
  const linenItems = apartment.items.filter(i => i.category === 'linen');
  dom.deductionSettings.innerHTML = guestItems.length
    ? guestItems.map(item => `<label><span class="small">${item.name}</span><input type="number" min="0" step="0.1" value="${item.perCheckin}" data-setting-item="${item.id}" data-setting-field="perCheckin" /></label>`).join('')
    : '<div class="empty">Нет одноразовых позиций.</div>';
  dom.setSettings.innerHTML = linenItems.length
    ? linenItems.map(item => `<label><span class="small">${item.name}</span><input type="number" min="0" step="0.1" value="${item.setAmount}" data-setting-item="${item.id}" data-setting-field="setAmount" /></label>`).join('')
    : '<div class="empty">Нет позиций.</div>';
}
function bindSettings() {
  [dom.deductionSettings, dom.setSettings].forEach(container => {
    container?.addEventListener('input', async (e) => {
      const input = e.target.closest('[data-setting-item]');
      if (!input) return;
      updateItemField(input.dataset.settingItem, input.dataset.settingField, input.value);
      await rerender('Настройки обновлены');
    });
  });
}

// ─── Карточки расходников (делегирование) ──────────────────────────────────
let writeoffContext = null;

function bindItemCards() {
  // Списать / Пополнить — открываем модал
  document.addEventListener('click', (e) => {
    const wo = e.target.closest('[data-action="open-writeoff"]');
    if (wo) {
      writeoffContext = { itemId: wo.dataset.id, mode: 'writeoff', isLinen: wo.dataset.category === 'linen', name: wo.dataset.name, unit: wo.dataset.unit };
      byId('writeoffModalTitle').textContent = 'Списать';
      byId('writeoffModalSub').textContent = wo.dataset.name;
      byId('writeoffModalLabel').textContent = `Сколько списать (${wo.dataset.unit})`;
      byId('writeoffModalQty').value = '1';
      openModal('writeoffModal');
      setTimeout(() => byId('writeoffModalQty')?.select(), 80);
      return;
    }
    const rs = e.target.closest('[data-action="open-restock"]');
    if (rs) {
      writeoffContext = { itemId: rs.dataset.id, mode: 'restock', isLinen: false, name: rs.dataset.name, unit: rs.dataset.unit };
      byId('writeoffModalTitle').textContent = 'Пополнить';
      byId('writeoffModalSub').textContent = rs.dataset.name;
      byId('writeoffModalLabel').textContent = `Сколько добавить (${rs.dataset.unit})`;
      byId('writeoffModalQty').value = '1';
      openModal('writeoffModal');
      setTimeout(() => byId('writeoffModalQty')?.select(), 80);
      return;
    }
    // Удалить расходник
    const del = e.target.closest('[data-delete-item]');
    if (del && confirm(`Удалить «${del.dataset.deleteItem}»?`)) {
      deleteItem(del.dataset.deleteItem);
      rerender('Позиция удалена');
      return;
    }
    // Удалить квартиру
    const delApt = e.target.closest('[data-delete-apartment]');
    if (delApt) {
      updateState(s => { s._pendingDeleteId = delApt.dataset.deleteApartment; });
      byId('confirmDeleteText').textContent = `Удалить квартиру «${getDisplayApartmentName(delApt.dataset.deleteApartmentName)}»? Это действие нельзя отменить.`;
      openModal('confirmDeleteModal');
      return;
    }
    // Кнопки «Заказ сделан» в заявках
    const doneBtn = e.target.closest('[data-done-request]');
    if (doneBtn) {
      const req = getState().purchaseRequests.find(r => r.id === doneBtn.dataset.doneRequest);
      if (!req) return;
      if (req.done) { req.done = false; req.pendingCost = false; req.items.forEach(i => delete i.cost); }
      else { req.pendingCost = true; }
      renderPurchaseModal();
      persistState(setStatus, true);
      return;
    }
    // Отмена ввода стоимости
    const cancelCost = e.target.closest('[data-cancel-cost]');
    if (cancelCost) {
      const req = getState().purchaseRequests.find(r => r.id === cancelCost.dataset.cancelCost);
      if (req) { req.pendingCost = false; req.items.forEach(i => delete i.cost); renderPurchaseModal(); persistState(setStatus, true); }
      return;
    }
    // Подтвердить стоимость
    const confirmCost = e.target.closest('[data-confirm-cost]');
    if (confirmCost) {
      const req = getState().purchaseRequests.find(r => r.id === confirmCost.dataset.confirmCost);
      if (!req) return;
      const inputs = document.querySelectorAll(`[data-cost-item="${req.id}"]`);
      let allFilled = true;
      inputs.forEach(input => {
        const val = parseFloat(input.value);
        if (isNaN(val) || val < 0) { allFilled = false; input.style.borderColor = 'var(--color-error)'; return; }
        input.style.borderColor = '';
        const item = req.items.find(i => (i.itemId || i.name) === input.dataset.costItemId);
        if (item) item.cost = val;
      });
      if (!allFilled) return;
      req.done = true; req.pendingCost = false;
      // ─── Синхронизация с финучётом — заносим расход по каждому расходнику ───
      const today = new Date().toISOString().slice(0, 10);
      req.items.forEach(item => {
        const cost = Number(item.cost);
        if (cost > 0) {
          addFinanceEntry({
            apartmentId: req.apartmentId,
            type: 'expense',
            category: 'Закупка',
            title: item.name,
            amount: cost,
            date: today,
            source: 'manual',
            status: 'confirmed',
            notes: `Заявка ${req.auto ? '(авто)' : ''}: ${roundSmart(item.qty)} ${item.unit}`,
            meta: { requestId: req.id, itemId: item.itemId || '' },
          });
        }
      });
      // Сохраняем ID финзаписей в заявке для возможного удаления
      req.financeLinked = true;
      renderPurchaseModal();
      render(); // обновляем финучёт
      persistState(setStatus, true);
      return;
    }
    // Удаление заявки
    const deleteReq = e.target.closest('[data-delete-request]');
    if (deleteReq) {
      const reqId = deleteReq.dataset.deleteRequest;
      const state = getState();
      const req = state.purchaseRequests.find(r => r.id === reqId);
      if (!req) return;
      if (req.financeLinked) {
        // Удаляем связанные записи из финучёта
        const linkedIds = state.finance.entries
          .filter(e => e.meta && e.meta.requestId === reqId)
          .map(e => e.id);
        linkedIds.forEach(id => deleteFinanceEntry(id));
      }
      updateState(s => { s.purchaseRequests = s.purchaseRequests.filter(r => r.id !== reqId); });
      renderPurchaseModal();
      render(); // обновляем финучёт при удалении связанной заявки
      persistState(setStatus, true);
      return;
    }
    // Навигация базы знаний
    const kbBtn = e.target.closest('[data-kb-target]');
    if (kbBtn) {
      document.querySelectorAll('.kb-section').forEach(s => s.classList.remove('active'));
      document.querySelectorAll('[data-kb-target]').forEach(b => b.classList.remove('active'));
      const target = byId(kbBtn.dataset.kbTarget);
      if (target) target.classList.add('active');
      kbBtn.classList.add('active');
      return;
    }
  });
}

// ─── Модал списания ────────────────────────────────────────────────────────
function bindWriteoffModal() {
  byId('writeoffModalClose')?.addEventListener('click', () => closeModal('writeoffModal'));
  byId('writeoffModalCancel')?.addEventListener('click', () => closeModal('writeoffModal'));
  byId('writeoffModal')?.addEventListener('click', (e) => { if (e.target === byId('writeoffModal')) closeModal('writeoffModal'); });
  byId('writeoffModalConfirm')?.addEventListener('click', async () => {
    if (!writeoffContext) return;
    const qty = Math.max(0.1, Number(byId('writeoffModalQty')?.value) || 1);
    applyWriteoff(writeoffContext.itemId, qty, writeoffContext.mode);
    closeModal('writeoffModal');
    writeoffContext = null;
    await rerender(writeoffContext?.mode === 'restock' ? 'Пополнено' : 'Списано');
  });
  byId('writeoffModalQty')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') byId('writeoffModalConfirm')?.click(); });
}

// ─── Удаление квартиры (подтверждение) ────────────────────────────────────
function bindDeleteApartment() {
  byId('cancelDeleteApartment')?.addEventListener('click', () => closeModal('confirmDeleteModal'));
  byId('confirmDeleteApartment')?.addEventListener('click', async () => {
    const id = getState()._pendingDeleteId;
    if (id) { deleteApartment(id); updateState(s => { delete s._pendingDeleteId; }); }
    closeModal('confirmDeleteModal');
    await rerender('Квартира удалена');
  });
}

// ─── Экспорт / Импорт JSON ────────────────────────────────────────────────
function bindJsonIo() {
  byId('exportJsonBtn')?.addEventListener('click', () => { exportJson(); setStatus('JSON экспортирован'); });
  byId('importJsonBtn')?.addEventListener('click', () => byId('importJsonInput')?.click());
  byId('importJsonInput')?.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try { await importJson(file); await rerender('Данные импортированы'); }
    catch (err) { setStatus(`Ошибка импорта: ${err.message}`); }
    e.target.value = '';
  });
}

// ─── Авто-заявка тумблер ──────────────────────────────────────────────────
function syncAutoToggleUI() {
  const on = getState().autoRequest;
  const btn = byId('autoRequestToggle');
  const lbl = byId('autoRequestLabel');
  if (btn) { btn.classList.toggle('active', on); btn.setAttribute('aria-checked', String(on)); }
  if (lbl) lbl.textContent = on ? 'Включено — авто-заявка при списании' : 'Только не одноразовые расходники';
}

function bindAutoRequest() {
  byId('autoRequestToggle')?.addEventListener('click', () => {
    toggleAutoRequest();
    syncAutoToggleUI();
    persistState(setStatus, true);
  });
}

// ─── Заявки на закупку ────────────────────────────────────────────────────
function renderPurchaseModal() {
  const state = getState();
  if (!dom.purchaseRequestsList) return;
  syncAutoToggleUI();
  dom.purchaseRequestsList.innerHTML = state.purchaseRequests.length
    ? state.purchaseRequests.map(purchaseRequestCard).join('')
    : '<div class="empty">Нет заявок.</div>';
}

function purchaseRequestCard(request) {
  const done = request.done === true;
  const pending = request.pendingCost === true;
  const badgeStyle = done
    ? 'background:color-mix(in oklab,var(--color-success) 15%,transparent);color:var(--color-success)'
    : 'background:color-mix(in oklab,var(--color-error) 15%,transparent);color:var(--color-error)';

  const itemsList = request.items.map(item => {
    if (done) {
      const costStr = item.cost != null && item.cost !== '' ? `${Number(item.cost).toLocaleString('ru-RU')} ₽` : '—';
      return `<div class="line"><div><strong>${item.name}</strong><div class="small">${roundSmart(item.qty)} ${item.unit}</div></div><strong style="color:var(--color-success)">${costStr}</strong></div>`;
    }
    if (pending) {
      return `<div class="purchase-cost-row">
        <div class="purchase-cost-name">
          <strong>${item.name}</strong>
          <span class="small">${roundSmart(item.qty)} ${item.unit}</span>
        </div>
        <div class="purchase-cost-input">
          <input type="number" inputmode="numeric" min="0" step="1" placeholder="0"
            value="${item.cost || ''}"
            class="cost-input-field"
            data-cost-item="${request.id}" data-cost-item-id="${item.itemId || item.name}" />
          <span class="cost-currency">₽</span>
        </div>
      </div>`;
    }
    return `<div class="line"><div><strong>${item.name}</strong><div class="small">Количество</div></div><strong>${roundSmart(item.qty)} ${item.unit}</strong></div>`;
  }).join('');

  const totalBlock = done
    ? (() => { const total = request.items.reduce((s,i) => s + (Number(i.cost) || 0), 0); return `<div style="display:flex;justify-content:space-between;align-items:center;margin-top:.6rem;padding-top:.6rem;border-top:1px solid color-mix(in oklab,var(--color-text) 8%,transparent)"><span class="small">Итого</span><strong style="color:var(--color-success)">${total} ₽</strong></div>`; })()
    : '';

  let actionBlock;
  if (done) {
    actionBlock = `<button class="btn" style="width:100%;min-height:40px;background:color-mix(in oklab,var(--color-success) 12%,var(--color-surface));border:1px solid color-mix(in oklab,var(--color-success) 30%,transparent);color:var(--color-success);font-weight:700" data-done-request="${request.id}">✓ Заказ выполнен</button>`;
  } else if (pending) {
    actionBlock = `<div style="display:flex;gap:.6rem;margin-top:.75rem">
      <button class="btn btn-secondary" style="flex:1" data-cancel-cost="${request.id}">Отмена</button>
      <button class="btn btn-primary" style="flex:1;display:flex;align-items:center;justify-content:center;gap:.5rem" data-confirm-cost="${request.id}">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>
        Подтвердить
      </button>
    </div>`;
  } else {
    actionBlock = `<button class="btn" style="width:100%;min-height:40px;background:var(--color-surface);border:1px solid color-mix(in oklab,var(--color-text) 10%,transparent);font-weight:700" data-done-request="${request.id}">Заказ сделан</button>`;
  }

  const badge2 = done ? '✓ Выполнено' : pending ? 'Ввод стоимости' : request.auto ? '⚡ Авто' : 'Заявка';

  return `<article class="request-card">
    <div class="request-card-header">
      <div><div class="request-kind" style="${badgeStyle}">${badge2}</div><strong style="display:block;margin-top:.45rem">${getDisplayApartmentName(request.apartmentName)}</strong></div>
      <div style="display:flex;align-items:center;gap:.4rem;flex-shrink:0">
        <span class="small">${new Date(request.createdAt).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
        <button data-delete-request="${request.id}" style="background:none;border:none;cursor:pointer;padding:.2rem .35rem;border-radius:var(--radius-md);color:var(--color-text-muted);font-size:1rem;line-height:1" title="Удалить заявку">🗑</button>
      </div>
    </div>
    <div class="small" style="margin-bottom:.5rem;color:var(--color-text-muted)">Позиций: ${request.items.length}${request.financeLinked ? ' · <span style=\'color:var(--color-success)\'>✓ В финучёте</span>' : ''}</div>
    <div class="list">${itemsList}</div>
    ${totalBlock}
    <div style="margin-top:.75rem">${actionBlock}</div>
  </article>`;
}

function bindPurchaseModal() {
  byId('openNewPurchaseRequest')?.addEventListener('click', () => {
    renderNewPurchaseForm();
    openModal('newPurchaseRequestModal');
  });
  byId('closeNewPurchaseRequestModal')?.addEventListener('click', () => closeModal('newPurchaseRequestModal'));
  byId('cancelNewPurchaseRequest')?.addEventListener('click', () => closeModal('newPurchaseRequestModal'));

  dom.purchaseApartmentSelect?.addEventListener('change', () => renderNewPurchaseItems());

  byId('saveNewPurchaseRequest')?.addEventListener('click', async () => {
    const apartmentId = dom.purchaseApartmentSelect?.value;
    const checkboxes = document.querySelectorAll('.purchase-item-check:checked');
    const items = [...checkboxes].map(cb => {
      const qtyInput = document.querySelector(`[data-purchase-qty="${cb.dataset.itemId}"]`);
      return { itemId: cb.dataset.itemId, name: cb.dataset.itemName, unit: cb.dataset.itemUnit, qty: Number(qtyInput?.value || 1) };
    });
    if (createPurchaseRequest(apartmentId, items)) {
      closeModal('newPurchaseRequestModal');
      renderPurchaseModal();
      await rerender('Заявка создана');
    }
  });
}

function renderNewPurchaseForm() {
  const state = getState();
  if (!dom.purchaseApartmentSelect) return;
  dom.purchaseApartmentSelect.innerHTML = state.apartments.map(a => `<option value="${a.id}">${getDisplayApartmentName(a.name)}</option>`).join('');
  renderNewPurchaseItems();
}

function renderNewPurchaseItems() {
  const apartmentId = dom.purchaseApartmentSelect?.value;
  const state = getState();
  const apartment = state.apartments.find(a => a.id === apartmentId);
  if (!dom.purchaseItemsWrap) return;
  if (!apartment) { dom.purchaseItemsWrap.innerHTML = '<div class="empty">Выбери квартиру.</div>'; return; }
  dom.purchaseItemsWrap.innerHTML = apartment.items.map(item => {
    const needed = Math.max(0, item.par - item.stock);
    return `<div class="purchase-new-row">
      <label class="purchase-new-label">
        <input type="checkbox" class="purchase-item-check purchase-item-checkbox" data-item-id="${item.id}" data-item-name="${item.name}" data-item-unit="${item.unit}" />
        <span class="purchase-new-info">
          <strong class="purchase-new-name">${item.name}</strong>
          <span class="small purchase-new-sub">Остаток: ${roundSmart(item.stock)} / ${roundSmart(item.par)} ${item.unit}</span>
        </span>
      </label>
      <input type="number" inputmode="numeric" min="0.1" step="0.1" value="${needed > 0 ? roundSmart(needed) : 1}" data-purchase-qty="${item.id}" class="purchase-new-qty" />
    </div>`;
  }).join('');
}

// ─── Финансы ──────────────────────────────────────────────────────────────
function bindFinanceFilters() {
  const updateFilters = async () => {
    updateState((state) => {
      state.ui.finance.apartmentFilter = dom.financeApartmentFilter?.value || 'all';
      state.ui.finance.typeFilter = dom.financeTypeFilter?.value || 'all';
      state.ui.finance.month = dom.financeMonthFilter?.value || monthKey(new Date());
      state.ui.finance.showOnlyPending = dom.financeOnlyPending?.checked || false;
    });
    await rerender('Фильтры обновлены');
  };
  [dom.financeApartmentFilter, dom.financeTypeFilter, dom.financeMonthFilter].forEach(el => el?.addEventListener('input', updateFilters));
  dom.financeOnlyPending?.addEventListener('change', updateFilters);
}

function bindFinanceModals() {
  // Открытие модалки добавления записи
  dom.financeAddEntryBtn?.addEventListener('click', () => {
    if (dom.financeEntryApartment) dom.financeEntryApartment.value = currentApartment()?.id || '';
    if (dom.financeEntryType) dom.financeEntryType.value = 'expense';
    if (dom.financeEntryDate) dom.financeEntryDate.value = new Date().toISOString().slice(0,10);
    // Очищаем поля
    if (dom.financeEntryTitle) dom.financeEntryTitle.value = '';
    if (dom.financeEntryCategory) dom.financeEntryCategory.value = '';
    if (dom.financeEntryAmount) dom.financeEntryAmount.value = '';
    if (dom.financeEntryNotes) dom.financeEntryNotes.value = '';
    openModal('financeEntryModal');
  });
  dom.cancelFinanceEntry?.addEventListener('click', () => closeModal('financeEntryModal'));
  document.getElementById('cancelFinanceEntry2')?.addEventListener('click', () => closeModal('financeEntryModal'));
  dom.saveFinanceEntry?.addEventListener('click', async () => {
    const amount = Number(dom.financeEntryAmount?.value || 0);
    if (!amount) { setStatus('Укажите сумму'); return; }
    addFinanceEntry({
      apartmentId: dom.financeEntryApartment?.value,
      type: dom.financeEntryType?.value,
      category: dom.financeEntryCategory?.value,
      title: dom.financeEntryTitle?.value,
      amount,
      date: dom.financeEntryDate?.value,
      notes: dom.financeEntryNotes?.value,
      source: 'manual',
      status: dom.financeEntryType?.value === 'income' ? 'confirmed' : 'planned',
    });
    closeModal('financeEntryModal');
    await rerender('Запись добавлена');
  });

  // Регулярные расходы
  dom.financeAddRecurringBtn?.addEventListener('click', () => {
    if (dom.recurringApartment) dom.recurringApartment.value = currentApartment()?.id || '';
    if (dom.recurringTitle) dom.recurringTitle.value = '';
    if (dom.recurringCategory) dom.recurringCategory.value = '';
    if (dom.recurringAmount) dom.recurringAmount.value = '';
    if (dom.recurringDayOfMonth) dom.recurringDayOfMonth.value = '1';
    if (dom.recurringStartDate) dom.recurringStartDate.value = new Date().toISOString().slice(0,10);
    if (dom.recurringEndDate) dom.recurringEndDate.value = '';
    if (dom.recurringNotes) dom.recurringNotes.value = '';
    openModal('recurringExpenseModal');
  });
  dom.cancelRecurringExpense?.addEventListener('click', () => closeModal('recurringExpenseModal'));
  document.getElementById('cancelRecurringExpense2')?.addEventListener('click', () => closeModal('recurringExpenseModal'));
  dom.saveRecurringExpense?.addEventListener('click', async () => {
    const amount = Number(dom.recurringAmount?.value || 0);
    if (!amount) { setStatus('Укажите сумму'); return; }
    if (!dom.recurringTitle?.value) { setStatus('Укажите название'); return; }
    addRecurringRule({
      apartmentId: dom.recurringApartment?.value,
      title: dom.recurringTitle?.value,
      category: dom.recurringCategory?.value,
      amount,
      dayOfMonth: Number(dom.recurringDayOfMonth?.value || 1),
      startDate: dom.recurringStartDate?.value,
      endDate: dom.recurringEndDate?.value,
      notes: dom.recurringNotes?.value,
      type: dom.recurringType?.value || 'expense',
    });
    closeModal('recurringExpenseModal');
    await rerender('Регулярное правило создано');
  });

  // Webhook/API info
  dom.financeOpenWebhookHelpBtn?.addEventListener('click', () => openModal('financeWebhookModal'));
  dom.closeFinanceWebhookModal?.addEventListener('click', () => closeModal('financeWebhookModal'));

  // Делегированные клики по карточкам проводок и правил
  document.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;

    if (action === 'delete-entry') {
      const id = btn.dataset.id;
      if (!id) return;
      deleteFinanceEntry(id);
      await rerender('Запись удалена');
    }

    if (action === 'confirm-entry') {
      const id = btn.dataset.id;
      if (!id) return;
      updateFinanceEntryStatus(id, 'confirmed');
      await rerender('Статус обновлён');
    }

    if (action === 'delete-recurring') {
      const id = btn.dataset.id;
      if (!id) return;
      deleteRecurringRule(id);
      await rerender('Правило удалено');
    }

    if (action === 'toggle-recurring') {
      const id = btn.dataset.id;
      if (!id) return;
      toggleRecurringRule(id);
      await rerender('Правило обновлено');
    }
  });
}

function bindRealtyCalendarSync() {
  dom.financePullBookingsBtn?.addEventListener('click', async () => {
    try {
      setStatus('Синхронизация...');
      const data = await syncRealtyCalendarBookings();
      const bookings = Array.isArray(data?.bookings) ? data.bookings.map(normalizeRealtyCalendarBooking) : [];
      const added = importBookingsToFinance(bookings);
      await rerender(added.length ? `Импортировано бронирований: ${added.length}` : 'Новых бронирований нет');
    } catch (err) {
      setStatus(`Ошибка синхронизации: ${err.message}`);
    }
  });
}

// ─── Аккордеоны (универсальные) ────────────────────────────────────────────
function bindAccordions() {
  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-toggle-target]');
    if (!trigger) return;
    const targetId = trigger.dataset.toggleTarget;
    const body = byId(targetId);
    if (!body) return;
    const isOpen = body.classList.contains('open');
    body.classList.toggle('open', !isOpen);
    trigger.setAttribute('aria-expanded', String(!isOpen));
    const chevron = trigger.querySelector('.accordion-chevron');
    chevron?.classList.toggle('open', !isOpen);
  });
}

// ─── Публичный init ───────────────────────────────────────────────────────
let __eventsBound = false;
export function bindEvents() {
  if (__eventsBound) {
    console.warn('[events] bindEvents() called twice — ignored to prevent duplicate listeners');
    return;
  }
  __eventsBound = true;
  bindDrawers();
  bindTheme();
  bindSectionNav();
  bindDrawerModals();
  bindHistory();
  bindApartmentSearch();
  bindApartmentParams();
  bindQuickActions();
  bindSettings();
  bindItemCards();
  bindWriteoffModal();
  bindDeleteApartment();
  bindJsonIo();
  bindAutoRequest();
  bindPurchaseModal();
  bindFinanceFilters();
  bindFinanceModals();
  bindRealtyCalendarSync();
  bindAccordions();
  updateState((state) => { if (!state.ui.finance.month) state.ui.finance.month = monthKey(new Date()); });
  bindAuth();
}

// ─── Auth UI ──────────────────────────────────────────────────────────────
// Все обработчики работают на ОДНОМ наборе элементов внутри auth-dropdown.
// Никаких дублирующих блоков в drawer больше нет.

function authReadFields() {
  return {
    email: dom.authBarEmail?.value?.trim() ?? '',
    password: dom.authBarPassword?.value ?? '',
  };
}

function authValidate(email, password) {
  if (!email) return 'Введите email.';
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return 'Неверный формат email.';
  if (!password) return 'Введите пароль.';
  if (password.length < 6) return 'Пароль минимум 6 символов.';
  return null;
}

function authSetLoading(on) {
  [dom.authBarSignIn, dom.authBarSignUp].forEach((btn) => {
    if (btn) btn.disabled = on;
  });
}

function clearPasswordInputs() {
  if (dom.authBarPassword) dom.authBarPassword.value = '';
}

function closeAuthDropdown() {
  if (dom.authDropdown) dom.authDropdown.hidden = true;
  if (dom.authCornerBtn) dom.authCornerBtn.setAttribute('aria-expanded', 'false');
}

function openAuthDropdown() {
  if (dom.authDropdown) dom.authDropdown.hidden = false;
  if (dom.authCornerBtn) dom.authCornerBtn.setAttribute('aria-expanded', 'true');
  // Авто-фокус на email
  setTimeout(() => dom.authBarEmail?.focus(), 60);
}

async function doSignIn() {
  const { email, password } = authReadFields();
  const err = authValidate(email, password);
  if (err) { setAuthMsg(err, 'error'); return; }
  authSetLoading(true);
  setAuthMsg('Выполняется вход...');
  try {
    const { error } = await signInWithEmail(email, password);
    if (error) {
      const msg = error.message && (error.message.includes('Invalid login') || error.message.includes('invalid_credentials'))
        ? 'Неверный email или пароль.'
        : `Ошибка: ${error.message || error}`;
      setAuthMsg(msg, 'error');
    } else {
      setAuthMsg('Вход выполнен', 'success');
      clearPasswordInputs();
      // Закрываем dropdown — дальше всё подхватит onAuthStateChange в app.js
      closeAuthDropdown();
    }
  } catch (e) {
    setAuthMsg(`Сетевая ошибка: ${e?.message || e}`, 'error');
  } finally {
    authSetLoading(false);
  }
}

async function doSignUp() {
  const { email, password } = authReadFields();
  const err = authValidate(email, password);
  if (err) { setAuthMsg(err, 'error'); return; }
  authSetLoading(true);
  setAuthMsg('Создаём аккаунт...');
  try {
    const { user, session, error } = await signUpWithEmail(email, password);
    if (error) {
      const msg = error.message && (error.message.includes('already registered') || error.message.includes('already exists'))
        ? 'Этот email уже зарегистрирован. Попробуйте войти.'
        : `Ошибка: ${error.message || error}`;
      setAuthMsg(msg, 'error');
      return;
    }
    if (session) {
      // Email confirmation отключён — пользователь сразу залогинен
      setAuthMsg('Аккаунт создан, выполняется вход...', 'success');
      clearPasswordInputs();
      closeAuthDropdown();
    } else if (user && !user.confirmed_at) {
      setAuthMsg(`Аккаунт создан. Проверьте почту ${email} для подтверждения.`, 'success');
    } else {
      setAuthMsg('Аккаунт создан', 'success');
      clearPasswordInputs();
    }
  } catch (e) {
    setAuthMsg(`Сетевая ошибка: ${e?.message || e}`, 'error');
  } finally {
    authSetLoading(false);
  }
}

async function doSignOut() {
  try {
    await signOutUser();
    // Дальнейшую очистку UI и state делает onAuthStateChange в app.js
  } catch (e) {
    setAuthMsg(`Ошибка выхода: ${e?.message || e}`, 'error');
  }
}

function bindAuth() {
  // ─── Главная кнопка-слово ────────────────────────────────────────────────
  // Поведение зависит от текущего состояния (signed-in / signed-out).
  // Состояние определяется по наличию класса .signed-in на кнопке (выставляется в render.js).
  dom.authCornerBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    const signedIn = dom.authCornerBtn.classList.contains('signed-in');
    if (signedIn) {
      // Вошёл → клик по "Выход" сразу разлогинивает
      doSignOut();
    } else {
      // Гость → клик по "Меню" открывает/закрывает dropdown
      const isOpen = dom.authDropdown && !dom.authDropdown.hidden;
      if (isOpen) closeAuthDropdown();
      else openAuthDropdown();
    }
  });

  // Закрытие dropdown по клику вне его
  document.addEventListener('click', (e) => {
    if (!dom.authDropdown || dom.authDropdown.hidden) return;
    if (dom.authCorner && !dom.authCorner.contains(e.target)) {
      closeAuthDropdown();
    }
  });

  // Esc → закрыть dropdown
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && dom.authDropdown && !dom.authDropdown.hidden) {
      closeAuthDropdown();
    }
  });

  // Кнопки внутри dropdown
  dom.authBarSignIn?.addEventListener('click', () => doSignIn());
  dom.authBarSignUp?.addEventListener('click', () => doSignUp());

  // Показать/скрыть пароль
  dom.authBarToggle?.addEventListener('click', () => {
    const inp = dom.authBarPassword;
    if (!inp) return;
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  // Enter в полях → войти
  [dom.authBarEmail, dom.authBarPassword].forEach((inp) => {
    inp?.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSignIn(); });
  });
}
