import dom, { byId } from './dom.js';
import { fetchRealtyCalendarBookings, fetchRealtyCalendarLog, fetchRealtyCalendarIntegration, saveRealtyCalendarIntegration, disconnectRealtyCalendar, buildFinanceWebhookExample, getWebhookUrl } from './api.js';
import { addFinanceEntry, addRecurringRule, deleteFinanceEntry, deleteRecurringRule, updateFinanceEntryStatus, toggleRecurringRule, ensureFinanceGeneratedForCurrentMonth, applyRealtyCalendarBookings, monthKey, createFinanceEntryDraft, setUnitEcoActiveReport, updateUnitEcoActiveReport, advanceUnitEcoReportIfNeeded, deleteUnitEcoHistoryReport } from './finance.js';
import { closeDrawer, closeModal, openDrawer, openModal, render, renderAuthStatus, setStatus, setAuthMsg } from './render.js';
import { currentApartment, getDisplayApartmentName, getState, roundSmart, updateState } from './state.js';
import { persistState, exportJson, importJson } from './storage.js';
import { signInWithEmail, signUpWithEmail, signOutUser } from './supabase-client.js';
import { addApartment, addCustomItem, applyWriteoff, createPurchaseRequest, deleteApartment, deleteItem, newCheckin, renameCurrentApartment, resetAll, restockDefaults, toggleAutoRequest, toggleRequestDone, updateItemField, updateRequestItemCost } from './actions.js';
import { bindGuestBotEvents } from './guestBot.js';
import { bindMaidsEvents } from './maidsUI.js';
import { openOkidokiSettings } from './okidoki.js';

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
    ['entries','recurring','summary','unit'].forEach(t => {
      const el = byId(`financeTab${t.charAt(0).toUpperCase() + t.slice(1)}`);
      if (el) el.hidden = t !== tab;
    });
    document.querySelectorAll('#financeTabsNav [data-finance-tab]').forEach(b => b.classList.toggle('active', b === chip));
  });

  byId('openKnowledgeBase')?.addEventListener('click', () => { openModal('kbModal'); closeDrawer(); });
  byId('kbClose')?.addEventListener('click', () => closeModal('kbModal'));

  // Старый openGuestBotChats заменяется в bindGuestBotEvents() — там полноценный чат.

  // Okidoki — электронные договоры
  byId('openOkidokiSettings')?.addEventListener('click', () => {
    closeDrawer();
    openOkidokiSettings().catch((err) => setStatus('Ошибка Okidoki: ' + (err?.message || err)));
  });
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
      state.ui.finance.dateFrom = dom.financeDateFrom?.value || '';
      state.ui.finance.dateTo = dom.financeDateTo?.value || '';
      // Сброс легаси-фильтра по месяцу, если выбран явный диапазон
      if (state.ui.finance.dateFrom || state.ui.finance.dateTo) state.ui.finance.month = '';
      state.ui.finance.showOnlyPending = dom.financeOnlyPending?.checked || false;
    });
    await rerender('Фильтры обновлены');
  };
  [dom.financeApartmentFilter, dom.financeTypeFilter, dom.financeDateFrom, dom.financeDateTo].forEach(el => el?.addEventListener('input', updateFilters));
  dom.financeOnlyPending?.addEventListener('change', updateFilters);
  dom.financeResetFilters?.addEventListener('click', async () => {
    updateState((state) => {
      state.ui.finance.apartmentFilter = 'all';
      state.ui.finance.typeFilter = 'all';
      state.ui.finance.dateFrom = '';
      state.ui.finance.dateTo = '';
      state.ui.finance.month = '';
      state.ui.finance.showOnlyPending = false;
    });
    await rerender('Фильтры сброшены');
  });
}

function bindUnitEconomicsTab() {
  // Селектор квартиры: выбор → авто-перенос истёкшего периода + ререндер
  dom.unitApartmentSelect?.addEventListener('change', async (e) => {
    const aptId = e.target.value;
    updateState((state) => { state.ui.finance.unitApartmentId = aptId; });
    advanceUnitEcoReportIfNeeded(aptId);
    await rerender();
  });

  // Создание периода
  dom.unitCreateBtn?.addEventListener('click', async () => {
    const aptId = dom.unitApartmentSelect?.value;
    if (!aptId) { setStatus('Выберите квартиру'); return; }
    const startDate = dom.unitCreateStart?.value || '';
    const endDate = dom.unitCreateEnd?.value || '';
    const cadence = dom.unitCreateCadence?.value || 'monthly';
    if (!startDate || !endDate) { setStatus('Укажите даты периода'); return; }
    try {
      setUnitEcoActiveReport(aptId, { startDate, endDate, cadence });
      await rerender('Период создан');
    } catch (err) {
      setStatus('Не удалось создать: ' + (err?.message || err));
    }
  });

  // Редактирование периода (inline-prompt)
  dom.unitEditBtn?.addEventListener('click', async () => {
    const aptId = dom.unitApartmentSelect?.value;
    if (!aptId) return;
    const state = getState();
    const apt = (state.apartments || []).find(a => a.id === aptId);
    const active = apt?.unitEcoReports?.active;
    if (!active) return;
    const newStart = prompt('Начало периода (YYYY-MM-DD):', active.startDate || '');
    if (newStart === null) return;
    const newEnd = prompt('Конец периода (YYYY-MM-DD):', active.endDate || '');
    if (newEnd === null) return;
    try {
      updateUnitEcoActiveReport(aptId, { startDate: newStart.trim(), endDate: newEnd.trim() });
      await rerender('Период обновлён');
    } catch (err) {
      setStatus('Не удалось обновить: ' + (err?.message || err));
    }
  });

  // Фильтры
  const updateFilter = async (key, value) => {
    updateState((state) => {
      if (!state.ui.finance.unitFilters) state.ui.finance.unitFilters = { type: 'all', category: 'all', source: 'all', status: 'active' };
      state.ui.finance.unitFilters[key] = value;
    });
    await rerender();
  };
  dom.unitFilterType?.addEventListener('change', (e) => updateFilter('type', e.target.value));
  dom.unitFilterCategory?.addEventListener('change', (e) => updateFilter('category', e.target.value));
  dom.unitFilterSource?.addEventListener('change', (e) => updateFilter('source', e.target.value));
  dom.unitFilterStatus?.addEventListener('change', (e) => updateFilter('status', e.target.value));

  // Удаление отчёта из истории
  dom.unitHistoryList?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-unit-history-delete]');
    if (!btn) return;
    const reportId = btn.getAttribute('data-unit-history-delete');
    const aptId = dom.unitApartmentSelect?.value;
    if (!aptId || !reportId) return;
    if (!confirm('Удалить отчёт из истории?')) return;
    deleteUnitEcoHistoryReport(aptId, reportId);
    await rerender('Отчёт удалён');
  });
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
  const updateRecurringTitleVisibility = () => {
    const kind = dom.recurringKind?.value || 'other';
    const titleField = dom.recurringTitle?.closest('label');
    if (titleField) titleField.style.display = (kind === 'other') ? '' : 'none';
  };
  dom.financeAddRecurringBtn?.addEventListener('click', () => {
    if (dom.recurringApartment) dom.recurringApartment.value = currentApartment()?.id || '';
    if (dom.recurringKind) dom.recurringKind.value = 'rent';
    if (dom.recurringTitle) dom.recurringTitle.value = '';
    if (dom.recurringCategory) dom.recurringCategory.value = '';
    if (dom.recurringAmount) dom.recurringAmount.value = '';
    if (dom.recurringDayOfMonth) dom.recurringDayOfMonth.value = '1';
    if (dom.recurringStartDate) dom.recurringStartDate.value = new Date().toISOString().slice(0,10);
    if (dom.recurringEndDate) dom.recurringEndDate.value = '';
    if (dom.recurringNotes) dom.recurringNotes.value = '';
    updateRecurringTitleVisibility();
    openModal('recurringExpenseModal');
  });
  dom.recurringKind?.addEventListener('change', updateRecurringTitleVisibility);
  dom.cancelRecurringExpense?.addEventListener('click', () => closeModal('recurringExpenseModal'));
  document.getElementById('cancelRecurringExpense2')?.addEventListener('click', () => closeModal('recurringExpenseModal'));
  dom.saveRecurringExpense?.addEventListener('click', async () => {
    const amount = Number(dom.recurringAmount?.value || 0);
    if (!amount) { setStatus('Укажите сумму'); return; }
    const kind = dom.recurringKind?.value || 'other';
    if (kind === 'other' && !dom.recurringTitle?.value) { setStatus('Укажите название'); return; }
    addRecurringRule({
      apartmentId: dom.recurringApartment?.value,
      kind,
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

    if (action === 'create-contract') {
      const bookingId = btn.dataset.bookingId;
      if (!bookingId) return;
      const orig = btn.textContent;
      btn.disabled = true; btn.textContent = 'Создаём…';
      try {
        const mod = await import('./okidoki.js');
        const r = await mod.createContract(Number(bookingId));
        setStatus('Договор создан');
        // Перетянем брони чтобы в UI обновилась ссылка
        const bookings = await fetchRealtyCalendarBookings();
        applyRealtyCalendarBookings(bookings);
        await rerender('Договор отправлен');
        if (r?.link) {
          try { await navigator.clipboard.writeText(r.link); } catch {}
        }
      } catch (err) {
        setStatus('Ошибка создания договора: ' + (err?.message || err));
        alert('Не удалось создать договор: ' + (err?.message || err) + '\n\nПроверьте: ☐ API-ключ введён, ☐ шаблон выбран, ☐ сопоставлены ключевые поля. Откройте «Договоры (Okidoki)» в меню.');
      } finally {
        btn.disabled = false; btn.textContent = orig;
      }
    }

    if (action === 'copy-contract-link') {
      const link = btn.dataset.link;
      if (!link) return;
      try {
        await navigator.clipboard.writeText(link);
        setStatus('Ссылка скопирована');
      } catch (err) {
        prompt('Скопируйте ссылку:', link);
      }
    }
  });
}

// ─── RealtyCalendar интеграция ──────────────────────────────────────────────
function showRcMsg(text, kind = 'info') {
  if (!dom.rcMsg) return;
  dom.rcMsg.textContent = text || '';
  dom.rcMsg.hidden = !text;
  dom.rcMsg.dataset.kind = kind;
}

async function refreshRcStatusAndLog() {
  // Подтягиваем интеграцию (agency_id, last_event_at)
  try {
    const integ = await fetchRealtyCalendarIntegration();
    updateState((s) => {
      s.integrations = s.integrations || {};
      s.integrations.realtycalendar = {
        ...(s.integrations.realtycalendar || {}),
        connected: !!integ?.agency_id,
        agencyId: integ?.agency_id ? String(integ.agency_id) : '',
        lastEventAt: integ?.last_event_at || s.integrations?.realtycalendar?.lastEventAt || null,
      };
    });
  } catch (err) {
    console.warn('[rc] fetch integration error:', err);
    showRcMsg(`Не удалось получить статус: ${err.message}`, 'error');
  }
  if (dom.rcWebhookUrl) dom.rcWebhookUrl.value = getWebhookUrl();

  // Журнал и применение свежих броней
  try {
    const [log, bookings] = await Promise.all([
      fetchRealtyCalendarLog(20),
      fetchRealtyCalendarBookings(500),
    ]);
    updateState((s) => {
      s.integrations = s.integrations || {};
      s.integrations.realtycalendar = s.integrations.realtycalendar || { connected: false, agencyId: '', lastEventAt: null };
      s.integrations.realtycalendar.recentLog = Array.isArray(log) ? log : [];
    });
    const result = applyRealtyCalendarBookings(bookings) || { added: 0, updated: 0, removed: 0, skipped: 0 };
    const changed = (result.added || 0) + (result.updated || 0) + (result.removed || 0);
    if (changed > 0) {
      await rerender(`RealtyCalendar: +${result.added || 0} / ±${result.updated || 0} / -${result.removed || 0}`);
    } else {
      render();
    }
  } catch (err) {
    console.warn('[rc] refresh log/bookings error:', err);
    render();
  }
}

function bindRealtyCalendarIntegration() {
  // Открытие модалки настроек
  dom.openFinanceSettings?.addEventListener('click', () => {
    openModal('financeSettingsModal');
    if (dom.rcWebhookUrl) dom.rcWebhookUrl.value = getWebhookUrl();
    const exampleEl = byId('financeWebhookExample');
    if (exampleEl) exampleEl.textContent = buildFinanceWebhookExample();
    showRcMsg('');
    refreshRcStatusAndLog();
  });
  dom.closeFinanceSettings?.addEventListener('click', () => closeModal('financeSettingsModal'));

  // Подключение: сохранить agency_id
  dom.rcSaveBtn?.addEventListener('click', async () => {
    const raw = (dom.rcAgencyIdInput?.value || '').trim();
    const agencyId = Number(raw);
    if (!agencyId || !Number.isFinite(agencyId)) {
      showRcMsg('Укажите корректный agency_id (число).', 'error');
      return;
    }
    try {
      setStatus('Подключение RealtyCalendar...');
      showRcMsg('Подключаем...', 'info');
      await saveRealtyCalendarIntegration(agencyId);
      showRcMsg('Подключено. Теперь скопируйте URL и вставьте его в RealtyCalendar.', 'success');
      await refreshRcStatusAndLog();
      setStatus('RealtyCalendar подключён');
    } catch (err) {
      showRcMsg(`Ошибка: ${err.message}`, 'error');
      setStatus(`Ошибка: ${err.message}`);
    }
  });

  // Отключение
  dom.rcDisconnectBtn?.addEventListener('click', async () => {
    if (!confirm('Отключить RealtyCalendar? Новые брони перестанут поступать.')) return;
    try {
      setStatus('Отключение...');
      await disconnectRealtyCalendar();
      showRcMsg('Интеграция отключена.', 'info');
      await refreshRcStatusAndLog();
      setStatus('RealtyCalendar отключён');
    } catch (err) {
      showRcMsg(`Ошибка: ${err.message}`, 'error');
      setStatus(`Ошибка: ${err.message}`);
    }
  });

  // Копирование webhook URL
  dom.rcCopyWebhookBtn?.addEventListener('click', async () => {
    const url = getWebhookUrl();
    try {
      await navigator.clipboard.writeText(url);
      showRcMsg('URL скопирован в буфер обмена.', 'success');
    } catch {
      dom.rcWebhookUrl?.select?.();
      showRcMsg('Скопируйте URL вручную (Ctrl+C).', 'info');
    }
  });

  // Обновить журнал вручную
  dom.rcRefreshBtn?.addEventListener('click', async () => {
    setStatus('Обновляем журнал...');
    await refreshRcStatusAndLog();
    setStatus('Журнал обновлён');
  });

  // Кнопка «Пересинхронизировать» — выводит подробный отчёт по броням и привязке квартир
  byId('rcDiagBtn')?.addEventListener('click', async () => {
    const box = byId('rcDiagBox');
    if (!box) return;
    box.innerHTML = '<div class="empty">Загружаем…</div>';
    setStatus('Пересинхронизация…');
    try {
      const bookings = await fetchRealtyCalendarBookings(500);
      const result = applyRealtyCalendarBookings(bookings) || { added: 0, updated: 0, removed: 0, skipped: 0 };
      await rerender('Синхронизация завершена');
      // Строим отчёт
      const state = getState();
      const apartments = state.apartments || [];
      const linkedIds = new Set();
      apartments.forEach((a) => {
        const rid = a.externalIds?.realtyCalendarUnitId;
        if (rid) linkedIds.add(String(rid));
      });
      const bookingRealtyIds = new Set();
      (bookings || []).forEach((b) => { if (b.realty_id != null) bookingRealtyIds.add(String(b.realty_id)); });
      const unmatched = [...bookingRealtyIds].filter((id) => !linkedIds.has(id));
      const matched = [...bookingRealtyIds].filter((id) => linkedIds.has(id));

      const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
      const aptRows = apartments.map((a) => {
        const rid = a.externalIds?.realtyCalendarUnitId || '';
        const ok = rid && bookingRealtyIds.has(String(rid));
        const color = rid ? (ok ? 'var(--color-success)' : 'var(--color-text-muted)') : 'var(--color-error)';
        const status = rid ? (ok ? 'есть брони' : 'броней пока нет') : '— ID не указан';
        return `<div class="rc-log-row" style="padding:.4rem 0;"><span>${esc(a.name || a.id)}</span> → <code>${esc(rid || '—')}</code> <span style="color:${color};margin-left:.4rem;">${status}</span></div>`;
      }).join('') || '<div class="empty">Нет квартир.</div>';

      const unmatchedRow = unmatched.length
        ? `<div class="rc-log-row" style="padding:.4rem 0;color:var(--color-error);">⚠ Брони с realty_id, к которым не привязана ни одна квартира: <code>${unmatched.map(esc).join(', ')}</code></div>`
        : '';

      // Сырой payload последних 2 броней — чтобы увидеть какие поля передаёт RealtyCalendar (комиссия, скидки и т.д.)
      const recent = (bookings || []).slice(0, 2);
      const payloadBlocks = recent.map((b, i) => {
        let pretty = '';
        try {
          pretty = JSON.stringify(b.raw_payload ?? b, null, 2);
        } catch (_e) {
          pretty = String(b.raw_payload || '');
        }
        const head = `№${i + 1} · realty_id=${esc(b.realty_id)} · amount=${esc(b.amount)} · prepayment=${esc(b.prepayment)} · status=${esc(b.status)}`;
        return `<details style="margin:.4rem 0;"><summary style="cursor:pointer;color:var(--color-text-muted);">Сырой payload брони ${head}</summary><pre style="max-height:340px;overflow:auto;background:rgba(0,0,0,.04);padding:.6rem;border-radius:8px;font-size:11px;line-height:1.4;white-space:pre-wrap;word-break:break-word;">${esc(pretty)}</pre></details>`;
      }).join('');
      const payloadSection = recent.length
        ? `<div class="rc-log-row" style="padding:.6rem 0 .25rem;color:var(--color-text-muted);"><strong>Сырые данные от RealtyCalendar (для поиска полей комиссии):</strong></div>${payloadBlocks}`
        : '';

      box.innerHTML = `
        <div class="rc-log-row" style="padding:.4rem 0;"><strong>Броней в Supabase:</strong> ${bookings.length} · уникальных realty_id: ${bookingRealtyIds.size}</div>
        <div class="rc-log-row" style="padding:.4rem 0;"><strong>Совпало по ID:</strong> ${matched.length} · <strong>Не совпало:</strong> ${unmatched.length}</div>
        <div class="rc-log-row" style="padding:.4rem 0;"><strong>Применено к финансам:</strong> +${result.added} / ±${result.updated} / -${result.removed} · <strong>Пропущено (нет привязки):</strong> ${result.skipped}</div>
        ${unmatchedRow}
        <div class="rc-log-row" style="padding:.5rem 0 .25rem;color:var(--color-text-muted);"><strong>Привязки квартир:</strong></div>
        ${aptRows}
        ${payloadSection}
      `;
      setStatus('Готово');
    } catch (err) {
      console.warn('[rc] diag error:', err);
      box.innerHTML = `<div class="empty" style="color:var(--color-error)">Ошибка: ${String(err.message || err)}</div>`;
      setStatus('Ошибка диагностики');
    }
  });
}

// ─── Синхронизация квартиры с RealtyCalendar ──────────────────────────────
let syncTargetApartmentId = null;

function setSyncMsg(text, kind = 'info') {
  const el = byId('apartmentSyncMsg');
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
  el.dataset.kind = kind;
}

async function openApartmentSyncModal(apartmentId) {
  syncTargetApartmentId = apartmentId;
  const state = getState();
  const apt = (state.apartments || []).find((a) => a.id === apartmentId);
  if (!apt) return;
  const input = byId('apartmentSyncInput');
  const title = byId('apartmentSyncTitle');
  if (title) title.textContent = `Синхронизация: ${getDisplayApartmentName(apt.name)}`;
  if (input) {
    input.value = apt?.externalIds?.realtyCalendarUnitId || '';
    setTimeout(() => input.focus(), 30);
  }
  setSyncMsg('');
  openModal('apartmentSyncModal');
}

function closeApartmentSyncModal() {
  syncTargetApartmentId = null;
  closeModal('apartmentSyncModal');
}

// Сохранение realty_id из модалки и из легаси-блока (если остался)
function bindApartmentRealtyId() {
  // Старый блок «Параметры квартиры» — сохраняем в правильное место externalIds
  const legacySave = async () => {
    const apt = currentApartment();
    if (!apt) return;
    const raw = (dom.apartmentRealtyId?.value || '').trim();
    const next = raw === '' ? '' : String(Number(raw) || raw);
    updateState((state) => {
      const a = (state.apartments || []).find((x) => x.id === apt.id);
      if (!a) return;
      if (!a.externalIds) a.externalIds = {};
      a.externalIds.realtyCalendarUnitId = next;
    });
    try {
      const bookings = await fetchRealtyCalendarBookings(500);
      applyRealtyCalendarBookings(bookings);
    } catch (err) {
      console.warn('[rc] apply on realtyId save error:', err);
    }
    await rerender(next ? 'ID объекта сохранён' : 'ID объекта очищен');
  };
  dom.saveApartmentRealtyId?.addEventListener('click', legacySave);
  dom.apartmentRealtyId?.addEventListener('change', legacySave);

  // Цена уборки квартиры — read-only паттерн: сохранить → readonly + кнопка «Редактировать»
  const saveCleaningPrice = async () => {
    const apt = currentApartment();
    if (!apt) return;
    const val = Number(dom.apartmentCleaningPrice.value || 0);
    updateState((state) => {
      const a = (state.apartments || []).find((x) => x.id === apt.id);
      if (!a) return;
      a.cleaningPrice = val > 0 ? val : 0;
    });
    try {
      const bookings = await fetchRealtyCalendarBookings(500);
      applyRealtyCalendarBookings(bookings);
    } catch (err) {
      console.warn('[cleaning] apply on cleaningPrice save error:', err);
    }
    await rerender(val > 0 ? 'Цена уборки сохранена' : 'Цена уборки очищена');
  };
  dom.apartmentCleaningPriceSaveBtn?.addEventListener('click', saveCleaningPrice);
  dom.apartmentCleaningPriceEditBtn?.addEventListener('click', () => {
    // Переводим в режим редактирования
    if (dom.apartmentCleaningPrice) {
      dom.apartmentCleaningPrice.removeAttribute('readonly');
      dom.apartmentCleaningPrice.focus();
    }
    if (dom.apartmentCleaningPriceEditBtn) dom.apartmentCleaningPriceEditBtn.hidden = true;
    if (dom.apartmentCleaningPriceSaveBtn) dom.apartmentCleaningPriceSaveBtn.hidden = false;
  });

  // Открытие модалки синхронизации по клику на кнопку в карточке квартиры
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-sync-apartment]');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    openApartmentSyncModal(btn.dataset.syncApartment);
  });

  // Закрытие
  byId('apartmentSyncClose')?.addEventListener('click', closeApartmentSyncModal);
  byId('apartmentSyncCancelBtn')?.addEventListener('click', closeApartmentSyncModal);

  // Сохранение ID из модалки
  byId('apartmentSyncSaveBtn')?.addEventListener('click', async () => {
    if (!syncTargetApartmentId) return;
    const input = byId('apartmentSyncInput');
    const raw = (input?.value || '').trim();
    if (!raw) {
      setSyncMsg('Введите ID объекта.', 'error');
      return;
    }
    const idNum = Number(raw);
    if (!Number.isFinite(idNum) || idNum <= 0 || !/^\d+$/.test(raw)) {
      setSyncMsg('ID неверный. Должно быть целое положительное число.', 'error');
      return;
    }
    const targetId = syncTargetApartmentId;
    setSyncMsg('Сохраняем и проверяем брони…', 'info');
    try {
      // 1. Сохраняем ID в правильное место в state
      updateState((state) => {
        const a = (state.apartments || []).find((x) => x.id === targetId);
        if (!a) return;
        if (!a.externalIds) a.externalIds = {};
        a.externalIds.realtyCalendarUnitId = String(idNum);
      });

      // 2. Подтягиваем все брони пользователя из Supabase
      let bookings = [];
      try {
        bookings = await fetchRealtyCalendarBookings(500);
      } catch (err) {
        console.warn('[rc] fetch after sync save:', err);
      }

      // 3. Считаем, сколько броней совпадает с введённым realty_id
      const idStr = String(idNum);
      const matching = (bookings || []).filter((b) => String(b.realty_id) === idStr);
      const activeMatching = matching.filter((b) => b.status !== 'canceled' && b.status !== 'deleted');

      // 4. Применяем брони к финансам (создаём/обновляем записи)
      let applyResult = { added: 0, updated: 0, removed: 0, skipped: 0 };
      try {
        applyResult = applyRealtyCalendarBookings(bookings) || applyResult;
      } catch (err) {
        console.warn('[rc] apply after sync save:', err);
      }

      // 5. Сохраняем state + ререндер
      await rerender('ID объекта сохранён');

      // 6. Показываем точную диагностику в модалке
      if (matching.length === 0) {
        setSyncMsg(
          `ID сохранён. Но для realty_id=${idStr} в RealtyCalendar пока нет броней. ` +
          `Создайте новую бронь в RC — она автоматически появится в финансах.`,
          'info'
        );
      } else {
        const parts = [];
        if (applyResult.added) parts.push(`добавлено ${applyResult.added}`);
        if (applyResult.updated) parts.push(`обновлено ${applyResult.updated}`);
        if (applyResult.removed) parts.push(`удалено ${applyResult.removed}`);
        const detail = parts.length ? ` (${parts.join(', ')})` : '';
        setSyncMsg(
          `Готово. Найдено броней по этому ID: ${matching.length}, активных: ${activeMatching.length}${detail}. ` +
          `Откройте «Финансовый учёт» — должны появиться доходы.`,
          'success'
        );
        // Закрываем модалку через 2.5 сек, чтобы пользователь успел прочитать
        setTimeout(() => closeApartmentSyncModal(), 2500);
      }
    } catch (err) {
      console.warn('[sync] save error:', err);
      setSyncMsg('Ошибка сохранения. Попробуйте ещё раз.', 'error');
    }
  });

  // Enter в поле — срабатывает как Сохранить
  byId('apartmentSyncInput')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') byId('apartmentSyncSaveBtn')?.click();
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
  bindAutoRequest();
  bindPurchaseModal();
  bindFinanceFilters();
  bindUnitEconomicsTab();
  bindFinanceModals();
  bindRealtyCalendarIntegration();
  bindApartmentRealtyId();
  bindAccordions();
  updateState((state) => { if (!state.ui.finance.month) state.ui.finance.month = monthKey(new Date()); });
  bindAuth();
  // — Новые разделы: брони, инструкции для гостей, чаты, настройки бота.
  //   передаём всегда актуальный state через getState() (обёртка).
  try {
    bindGuestBotEvents({ get apartments() { return getState().apartments || []; } });
  } catch (e) { console.warn('[events] bindGuestBotEvents:', e?.message || e); }
  try {
    bindMaidsEvents({
      get apartments() { return getState().apartments || []; },
      get managerSettings() { return getState().managerSettings || {}; },
    });
  } catch (e) { console.warn('[events] bindMaidsEvents:', e?.message || e); }
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
