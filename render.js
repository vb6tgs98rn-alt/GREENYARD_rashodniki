import dom, { byId } from './dom.js';
import { getFinanceSummary, monthKey, STATUS_LABELS } from './finance.js';
import { currentApartment, getDisplayApartmentName, getState, roundSmart, statusBy } from './state.js';

export function setStatus(text = 'Готово') { if (dom.saveStatus) dom.saveStatus.textContent = text; }

function fmt(n) { return Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: 0 }); }

function apartmentButton(apartment, activeApartmentId) {
  const low = apartment.items.filter((item) => statusBy(item).cls === 'low').length;
  return `<div class="apartment-row"><button class="apartment-btn ${apartment.id === activeApartmentId ? 'active' : ''}" data-apartment-id="${apartment.id}"><div class="apartment-meta"><strong>${getDisplayApartmentName(apartment.name)}</strong><span class="small">${low ? `Низкий остаток: ${low}` : 'Без критичных позиций'}</span></div><span class="small">${apartment.items.length} поз.</span></button></div>`;
}

function itemCard(item) {
  const status = statusBy(item);
  const percent = item.par > 0 ? Math.max(0, Math.min(100, (item.stock / item.par) * 100)) : 0;
  return `<article class="item-card ${status.cls === 'low' ? 'highlight' : ''}">
    <div class="item-head">
      <div><div class="item-name">${item.name}</div><div class="small">${roundSmart(item.stock)} / ${roundSmart(item.par)} ${item.unit}</div></div>
      <span class="badge ${status.cls}">${status.label}</span>
    </div>
    <div class="row">
      <div><div class="small">Остаток</div><div class="qty">${roundSmart(item.stock)}</div></div>
      <div><div class="small">Покрытие</div><div class="progress"><span style="width:${percent}%"></span></div></div>
    </div>
    <div style="display:flex;gap:.45rem;margin-top:.6rem">
      <button class="mini-btn" style="flex:1;background:color-mix(in oklab,var(--color-error) 10%,var(--color-surface-2));border-color:color-mix(in oklab,var(--color-error) 20%,transparent);color:var(--color-error)"
        data-action="open-writeoff" data-id="${item.id}" data-name="${item.name}" data-unit="${item.unit}" data-category="${item.category}">Списать</button>
      <button class="mini-btn" style="flex:1;background:color-mix(in oklab,var(--color-success) 10%,var(--color-surface-2));border-color:color-mix(in oklab,var(--color-success) 20%,transparent);color:var(--color-success)"
        data-action="open-restock" data-id="${item.id}" data-name="${item.name}" data-unit="${item.unit}" data-category="${item.category}">Пополнить</button>
    </div>
  </article>`;
}

function renderInventory(state) {
  const apartment = currentApartment();
  if (!apartment || !dom.pageTitle) return;
  dom.pageTitle.textContent = getDisplayApartmentName(apartment.name);
  dom.apartmentName.value = apartment.name;
  // ID объекта в RealtyCalendar (редактируется внутри карточки)
  if (dom.apartmentRealtyId) dom.apartmentRealtyId.value = apartment.realtyCalendarUnitId || '';
  dom.apartmentSearch.value = state.ui.apartmentSearch || '';
  const filteredApartments = state.apartments.filter((a) =>
    getDisplayApartmentName(a.name).toLowerCase().includes((state.ui.apartmentSearch || '').toLowerCase())
  );
  dom.apartmentsList.innerHTML = filteredApartments.length
    ? filteredApartments.map((a) => apartmentButton(a, state.activeApartmentId)).join('')
    : '<div class="empty">Ничего не найдено.</div>';
  const linenItems = apartment.items.filter((i) => i.category === 'linen');
  const guestItems = apartment.items.filter((i) => i.category === 'guest');
  dom.linenList.innerHTML = linenItems.length ? `<div class="grid">${linenItems.map(itemCard).join('')}</div>` : '<div class="empty">Нет позиций.</div>';
  dom.guestList.innerHTML = guestItems.length ? `<div class="grid">${guestItems.map(itemCard).join('')}</div>` : '<div class="empty">Нет позиций.</div>';
  const total = apartment.items.length;
  const low = apartment.items.filter((i) => statusBy(i).cls === 'low').length;
  const warn = apartment.items.filter((i) => statusBy(i).cls === 'warn').length;
  const ok = apartment.items.filter((i) => statusBy(i).cls === 'ok').length;
  dom.statsGrid.innerHTML = `<article class="stat"><span>Всего позиций</span><strong>${total}</strong></article><article class="stat"><span>Низкий остаток</span><strong>${low}</strong></article><article class="stat"><span>В зоне внимания</span><strong>${warn}</strong></article><article class="stat"><span>В норме</span><strong>${ok}</strong></article>`;
  dom.dailyUsage.innerHTML = guestItems.length ? guestItems.map((item) => `<div class="line"><span>${item.name}</span><strong>${roundSmart(item.perCheckin)} ${item.unit}</strong></div>`).join('') : '<div class="empty">Нет гостевых позиций.</div>';
  dom.setUsage.innerHTML = linenItems.length ? linenItems.map((item) => `<div class="line"><span>${item.name}</span><strong>${roundSmart(item.setAmount)} ${item.unit}</strong></div>`).join('') : '<div class="empty">Нет белья.</div>';
  dom.coverageList.innerHTML = apartment.items.map((item) => `<div class="line"><span>${item.name}</span><strong>${item.perCheckin > 0 ? Math.floor(item.stock / item.perCheckin) : item.setAmount > 0 ? Math.floor(item.stock / item.setAmount) : '—'}</strong></div>`).join('');
}

function sourceIcon(source) {
  if (source === 'realtycalendar') return '🔗';
  if (source === 'recurring') return '🔄';
  return '✏️';
}

function sourceLabel(source) {
  if (source === 'realtycalendar') return 'RealtyCalendar';
  if (source === 'recurring') return 'Регулярный';
  return 'Вручную';
}

function financeEntryCard(entry) {
  const isIncome = entry.type === 'income';
  const st = STATUS_LABELS[entry.status] || { label: entry.status, cls: 'planned' };
  const canConfirm = entry.status === 'planned' || entry.status === 'pending';
  const gross = Number(entry.amount || 0);
  const net = Number(entry.netAmount != null ? entry.netAmount : gross);
  const showTwoSums = isIncome && net !== gross;
  return `<article class="finance-card ${entry.type}" data-entry-id="${entry.id}">
    <div class="finance-card-top">
      <div class="finance-card-left">
        <div class="finance-card-title">${entry.title || entry.category || (isIncome ? 'Доход' : 'Расход')}</div>
        <div class="finance-card-meta">
          <span>${entry.apartmentName}</span>
          <span class="sep">·</span>
          <span>${entry.date}</span>
          <span class="sep">·</span>
          <span>${sourceIcon(entry.source)} ${sourceLabel(entry.source)}</span>
        </div>
        ${entry.category ? `<div class="finance-card-cat">${entry.category}</div>` : ''}
        ${entry.notes ? `<div class="finance-card-notes">${entry.notes}</div>` : ''}
      </div>
      <div class="finance-card-right">
        <div class="finance-amount ${entry.type}">${isIncome ? '+' : '−'}${fmt(showTwoSums ? net : gross)} ₽</div>
        ${showTwoSums ? `<div class="small" style="margin-top:.15rem;color:var(--color-text-muted)">валовый: ${fmt(gross)} ₽</div>` : ''}
        <span class="finance-status ${st.cls}">${st.label}</span>
      </div>
    </div>
    <div class="finance-card-actions">
      ${canConfirm ? `<button class="btn-chip btn-confirm" data-action="confirm-entry" data-id="${entry.id}" title="Подтвердить">✓ Подтвердить</button>` : ''}
      <button class="btn-chip btn-del" data-action="delete-entry" data-id="${entry.id}" title="Удалить">✕</button>
    </div>
  </article>`;
}

function recurringRuleCard(rule) {
  const typeLabel = rule.type === 'income' ? 'Доход' : 'Расход';
  const typeClass = rule.type === 'income' ? 'income' : 'expense';
  return `<article class="recurring-card ${rule.active ? '' : 'inactive'}" data-rule-id="${rule.id}">
    <div class="recurring-card-top">
      <div>
        <div class="recurring-title">${rule.title || 'Правило'}</div>
        <div class="finance-card-meta">
          <span>${rule.apartmentName}</span>
          <span class="sep">·</span>
          <span>${rule.dayOfMonth} число</span>
          ${rule.category ? `<span class="sep">·</span><span>${rule.category}</span>` : ''}
        </div>
      </div>
      <div style="text-align:right;flex-shrink:0">
        <div class="finance-amount ${typeClass}" style="font-size:var(--text-base)">${typeLabel === 'Доход' ? '+' : '−'}${fmt(rule.amount)} ₽</div>
        <div class="small" style="margin-top:.2rem">${rule.active ? '● Активно' : '○ Отключено'}</div>
      </div>
    </div>
    <div class="finance-card-actions">
      <button class="btn-chip" data-action="toggle-recurring" data-id="${rule.id}">${rule.active ? 'Отключить' : 'Включить'}</button>
      <button class="btn-chip btn-del" data-action="delete-recurring" data-id="${rule.id}">✕ Удалить</button>
    </div>
  </article>`;
}

function renderFinance(state) {
  if (!dom.financeApartmentFilter) return;
  const filter = state.ui?.finance || {};
  const summary = getFinanceSummary();
  const entries = summary.entries;

  // Фильтры
  const apartmentOptions = [
    `<option value="all">Все квартиры</option>`,
    ...state.apartments.map((a) => `<option value="${a.id}">${getDisplayApartmentName(a.name)}</option>`),
  ].join('');
  dom.financeApartmentFilter.innerHTML = apartmentOptions;
  dom.financeApartmentFilter.value = filter.apartmentFilter || 'all';
  dom.financeTypeFilter.value = filter.typeFilter || 'all';
  dom.financeMonthFilter.value = filter.month || monthKey(new Date());
  dom.financeOnlyPending.checked = !!filter.showOnlyPending;

  // Итоговые статы: валовый и чистый доход / прибыль
  const netProfitColor = summary.netProfit >= 0 ? 'var(--color-success)' : 'var(--color-error)';
  const showGross = summary.income !== summary.netIncome;
  dom.financeSummary.innerHTML = `
    <article class="stat">
      <span>Чистый доход</span>
      <strong style="color:var(--color-success)">${fmt(summary.netIncome)} ₽</strong>
      ${showGross ? `<span class="small" style="color:var(--color-text-muted)">валовый: ${fmt(summary.income)} ₽</span>` : ''}
    </article>
    <article class="stat">
      <span>Расходы</span>
      <strong style="color:var(--color-error)">${fmt(summary.expense)} ₽</strong>
    </article>
    <article class="stat">
      <span>Чистая прибыль</span>
      <strong style="color:${netProfitColor}">${summary.netProfit >= 0 ? '+' : ''}${fmt(summary.netProfit)} ₽</strong>
      ${showGross ? `<span class="small" style="color:var(--color-text-muted)">валовая: ${summary.profit >= 0 ? '+' : ''}${fmt(summary.profit)} ₽</span>` : ''}
    </article>
    <article class="stat">
      <span>Проводок</span>
      <strong>${entries.length}</strong>
    </article>`;

  // По квартирам (мини-блок) — чистая прибыль в приоритете
  const aptEntries = Object.values(summary.byApartment);
  if (dom.financeByApartment) {
    dom.financeByApartment.innerHTML = aptEntries.length
      ? aptEntries.map((apt) => {
          const netIncome = Number(apt.netIncome != null ? apt.netIncome : apt.income || 0);
          const grossIncome = Number(apt.income || 0);
          const expense = Number(apt.expense || 0);
          const netProfit = netIncome - expense;
          const pc = netProfit >= 0 ? 'var(--color-success)' : 'var(--color-error)';
          const hasGross = grossIncome !== netIncome;
          return `<div class="apt-finance-row">
            <div class="apt-finance-name">${apt.name}</div>
            <div class="apt-finance-nums">
              <span style="color:var(--color-success)" title="Чистый доход">+${fmt(netIncome)}${hasGross ? ` <span class="small" style="color:var(--color-text-muted)">(вал. ${fmt(grossIncome)})</span>` : ''}</span>
              <span style="color:var(--color-error)">−${fmt(expense)}</span>
              <span style="color:${pc};font-weight:700">${netProfit >= 0 ? '+' : ''}${fmt(netProfit)} ₽</span>
            </div>
          </div>`;
        }).join('')
      : '<div class="empty">Нет данных.</div>';
  }

  // Список проводок
  dom.financeEntriesList.innerHTML = entries.length
    ? entries.map(financeEntryCard).join('')
    : '<div class="empty">Нет записей по фильтрам.</div>';

  // Регулярные расходы
  dom.recurringExpensesList.innerHTML = state.finance.recurringRules.length
    ? state.finance.recurringRules.map(recurringRuleCard).join('')
    : '<div class="empty">Регулярные расходы ещё не настроены.</div>';

  // RealtyCalendar интеграция — статус + журнал в financeSettingsModal
  renderRcIntegration(state);

  // Селекты квартир в модалках
  [dom.financeEntryApartment, dom.recurringApartment].forEach((el) => {
    if (!el) return;
    el.innerHTML = state.apartments.map((a) => `<option value="${a.id}">${getDisplayApartmentName(a.name)}</option>`).join('');
    if (!el.value) el.value = state.activeApartmentId;
  });
  if (dom.financeEntryDate && !dom.financeEntryDate.value) dom.financeEntryDate.value = new Date().toISOString().slice(0, 10);
  if (dom.recurringStartDate && !dom.recurringStartDate.value) dom.recurringStartDate.value = new Date().toISOString().slice(0, 10);
}

// ─── RealtyCalendar: статус + журнал ─────────────────────────────────────
function rcStatusLabelText(action, status, errorText) {
  if (errorText && errorText === 'agency_not_registered') return 'не найдено агентство';
  if (errorText && errorText === 'integration_disabled') return 'интеграция отключена';
  if (errorText && errorText === 'skipped_request_status') return 'заявка (пропущено)';
  if (errorText && errorText.startsWith('upsert_failed')) return 'ошибка записи';
  if (action === 'create_booking') return 'новая бронь';
  if (action === 'update_booking') return 'изменение брони';
  if (action === 'cancel_booking') return 'отмена брони';
  if (action === 'delete_booking') return 'удаление брони';
  return action || status || '—';
}

function renderRcIntegration(state) {
  const rc = state.integrations?.realtycalendar || { connected: false, agencyId: '', lastEventAt: null, recentLog: [] };

  // Статусный бэдж
  if (dom.rcStatusBox) {
    if (rc.connected) {
      const last = rc.lastEventAt ? new Date(rc.lastEventAt).toLocaleString('ru-RU') : 'событий ещё не было';
      dom.rcStatusBox.textContent = `Подключено · ${last}`;
      dom.rcStatusBox.dataset.kind = 'connected';
    } else {
      dom.rcStatusBox.textContent = 'Не подключено';
      dom.rcStatusBox.dataset.kind = 'disconnected';
    }
  }

  // Поле agency_id
  if (dom.rcAgencyIdInput && dom.rcAgencyIdInput.value !== (rc.agencyId || '')) {
    dom.rcAgencyIdInput.value = rc.agencyId || '';
  }
  if (dom.rcAgencyIdInput) dom.rcAgencyIdInput.disabled = !!rc.connected;
  if (dom.rcSaveBtn) dom.rcSaveBtn.hidden = !!rc.connected;
  if (dom.rcDisconnectBtn) dom.rcDisconnectBtn.hidden = !rc.connected;

  // Журнал: источник — rc.recentLog (заполняется в app.js / events.js)
  if (dom.rcLogList) {
    const log = Array.isArray(rc.recentLog) ? rc.recentLog : [];
    if (!log.length) {
      dom.rcLogList.innerHTML = '<div class="empty">Пока пусто. После подключения и вставки URL в RC здесь появятся входящие события.</div>';
    } else {
      dom.rcLogList.innerHTML = log.map((row) => {
        const when = row.received_at ? new Date(row.received_at).toLocaleString('ru-RU') : '';
        const label = rcStatusLabelText(row.action, row.status, row.error_text);
        const ok = !row.error_text || row.error_text === 'skipped_request_status';
        const color = ok ? 'var(--color-text)' : 'var(--color-error)';
        const idStr = row.booking_id ? ` <span class="small" style="color:var(--color-text-muted)">#${row.booking_id}</span>` : '';
        return `<div class="rc-log-row" style="display:flex;justify-content:space-between;gap:.5rem;padding:.4rem 0;border-bottom:1px dashed var(--color-border)"><div style="color:${color}">${label}${idStr}</div><div class="small" style="color:var(--color-text-muted)">${when}</div></div>`;
      }).join('');
    }
  }
}

export function openModal(id) { document.getElementById(id)?.classList.add('open'); }
export function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }
export function openDrawer() { dom.drawerMenu?.classList.add('open'); dom.drawerBackdrop?.classList.add('open'); }
export function closeDrawer() { dom.drawerMenu?.classList.remove('open'); dom.drawerBackdrop?.classList.remove('open'); }

export function render() {
  const state = getState();
  document.documentElement.setAttribute('data-theme', state.ui.theme || 'light');
  if (dom.drawerThemeToggle) dom.drawerThemeToggle.classList.toggle('active', state.ui.theme === 'dark');
  if (dom.themeLabel) dom.themeLabel.textContent = state.ui.theme === 'dark' ? 'Темная тема' : 'Светлая тема';
  dom.sidebarNavButtons.forEach((btn) => btn.classList.toggle('active', btn.dataset.section === state.ui.activeSection));
  if (dom.inventorySection) dom.inventorySection.hidden = false; // инвентарь всегда виден, финансы — в модале
  renderInventory(state);
  renderFinance(state);
}

// ─── Auth UI ───────────────────────────────────────────────────────────────

/**
 * Обновляет компактный auth-виджет в правом верхнем углу.
 *  - Гость: кнопка-слово показывает "Меню", класс .signed-in снят, dropdown доступен.
 *  - Вошёл: кнопка-слово показывает "Выход", класс .signed-in выставлен, dropdown скрыт.
 * @param {object|null} user
 */
export function renderAuthStatus(user) {
  const btn = dom.authCornerBtn;
  const drop = dom.authDropdown;
  if (!btn) return;

  if (user) {
    btn.textContent = 'Выход';
    btn.classList.add('signed-in');
    btn.setAttribute('aria-label', `Выйти из аккаунта ${user.email || ''}`);
    btn.setAttribute('aria-expanded', 'false');
    // Прячем dropdown — он не нужен в режиме "вошёл"
    if (drop) drop.hidden = true;
    if (dom.authBarUserEmail) dom.authBarUserEmail.textContent = user.email || '';
  } else {
    btn.textContent = 'Меню';
    btn.classList.remove('signed-in');
    btn.setAttribute('aria-label', 'Открыть меню входа');
    btn.setAttribute('aria-expanded', 'false');
    if (drop) drop.hidden = true;
    if (dom.authBarUserEmail) dom.authBarUserEmail.textContent = '';
    // Очищаем сообщение, чтобы при следующем открытии было пусто
    if (dom.authBarMsg) { dom.authBarMsg.textContent = ''; dom.authBarMsg.className = 'auth-dropdown-msg'; }
  }
}

/** Индикатор режима хранения в выпадающем окошке: 'Облако' / 'Локально'. */
export function renderStorageBadge(mode) {
  if (!dom.authBarStorageBadge) return;
  const cloud = mode === 'cloud';
  dom.authBarStorageBadge.textContent = cloud ? '☁ Облако' : '■ Локально';
  dom.authBarStorageBadge.className = 'auth-dropdown-badge' + (cloud ? ' cloud' : '');
  dom.authBarStorageBadge.title = cloud
    ? 'Данные сохраняются в облаке и доступны на других устройствах'
    : 'Данные хранятся только в этом браузере. Войдите для синхронизации';
}

/** Показать сообщение в выпадающем окошке. type: 'error' | 'success' | '' */
export function setAuthMsg(text, type = '') {
  if (!dom.authBarMsg) return;
  dom.authBarMsg.textContent = text || '';
  dom.authBarMsg.className = 'auth-dropdown-msg' + (type ? ' ' + type : '');
}
