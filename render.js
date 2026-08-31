/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 *
 * Копирование, распространение, переработка и обратная разработка
 * (reverse engineering) запрещены без письменного разрешения правообладателя.
 * Условия: см. файл LICENSE. Нарушение влечёт ответственность по ст. 1252,
 * 1301 ГК РФ.
 */
import dom, { byId } from './dom.js';
import { getFinanceSummary, getFinanceApartmentSummary, getFinanceApartmentSummaryAsync, monthKey, STATUS_LABELS, fetchUnitEcoReports, advanceUnitEcoReportIfNeeded, REPORT_CADENCE_LABELS } from './finance.js';
import { currentApartment, getDisplayApartmentName, getState, roundSmart, statusBy } from './state.js';

export function setStatus(text = 'Готово') { if (dom.saveStatus) dom.saveStatus.textContent = text; }

function fmt(n) { return Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: 0 }); }

// Экранирование пользовательских строк перед вставкой в HTML.
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function apartmentButton(apartment, activeApartmentId) {
  const low = apartment.items.filter((item) => statusBy(item).cls === 'low').length;
  const realtyId = apartment.externalIds?.realtyCalendarUnitId || '';
  const isSynced = !!realtyId;
  const syncedTitle = isSynced
    ? `Синхронизировано с RealtyCalendar (ID ${realtyId}). Нажмите, чтобы изменить.`
    : 'Синхронизировать с RealtyCalendar';
  const syncBtn = `<button type="button" class="apt-sync-btn ${isSynced ? 'is-synced' : ''}" data-sync-apartment="${apartment.id}" title="${syncedTitle}" aria-label="${syncedTitle}">${isSynced ? '✓ Синхронизировано' : 'Синхронизация'}</button>`;
  const deleteBtn = `<button type="button" class="apt-delete-btn" data-delete-apartment="${apartment.id}" data-delete-apartment-name="${apartment.name || ''}" title="Удалить квартиру" aria-label="Удалить квартиру"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>`;
  const isActive = apartment.id === activeApartmentId;
  // Кнопка-шестерёнка: открывает модалку «Параметры объекта» для этой квартиры.
  const configureBtn = `<button type="button" class="apt-configure-btn" data-configure-apartment="${apartment.id}" title="Настроить квартиру" aria-label="Настроить квартиру"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg></button>`;
  return `<div class="apartment-row${isActive ? ' is-active' : ''}"><button class="apartment-btn ${isActive ? 'active' : ''}" data-apartment-id="${apartment.id}" aria-pressed="${isActive}"><div class="apartment-meta"><strong>${getDisplayApartmentName(apartment.name)}</strong><span class="small">${low ? `Низкий остаток: ${low}` : 'Без критичных позиций'}</span></div></button><div class="apartment-row-actions">${configureBtn}${syncBtn}${deleteBtn}</div></div>`;
}

function itemCard(item) {
  const status = statusBy(item);
  const isLinen = item.category === 'linen';
  // Подсказка «когда докупить»: если остаток ниже нормы — сколько не хватает.
  const deficit = Math.max(0, Number(item.par || 0) - Number(item.stock || 0));
  const hint = deficit > 0
    ? `Докупить: ${roundSmart(deficit)} ${esc(item.unit)}`
    : 'Запаса достаточно';
  // Поле тонкой настройки: для одноразовых — расход на заезд, для белья — штук в комплекте.
  const advField = isLinen
    ? `<label class="item-adv-field"><span class="small">В комплекте, шт</span><input type="number" min="0" step="1" value="${roundSmart(item.setAmount)}" data-item-field="setAmount" data-id="${item.id}"></label>`
    : `<label class="item-adv-field"><span class="small">Расход на заезд</span><input type="number" min="0" step="1" value="${roundSmart(item.perCheckin)}" data-item-field="perCheckin" data-id="${item.id}"></label>`;
  const damageBtn = isLinen
    ? `<button class="mini-btn item-damage-btn" data-action="linen-damage" data-id="${item.id}" data-name="${esc(item.name)}">Брак</button>`
    : '';
  return `<article class="item-card ${status.cls === 'low' ? 'highlight' : ''}" data-item-id="${item.id}">
    <div class="item-head">
      <div class="item-name">${esc(item.name)}</div>
      <div class="item-head-right">
        <span class="badge ${status.cls}">${status.label}</span>
        <button class="item-del-btn" data-delete-item="${item.id}" data-delete-item-name="${esc(item.name)}" title="Удалить позицию" aria-label="Удалить позицию">✕</button>
      </div>
    </div>
    <div class="item-qty-row">
      <button class="qbtn qbtn-minus" data-action="quick-writeoff" data-id="${item.id}" title="Списать 1" aria-label="Списать 1">−</button>
      <button class="item-qty" data-action="open-writeoff" data-id="${item.id}" data-name="${esc(item.name)}" data-unit="${esc(item.unit)}" data-category="${item.category}" title="Ввести точное количество">
        <strong>${roundSmart(item.stock)}</strong><span class="small">${esc(item.unit)}</span>
      </button>
      <button class="qbtn qbtn-plus" data-action="quick-restock" data-id="${item.id}" title="Добавить 1" aria-label="Добавить 1">+</button>
    </div>
    <div class="item-meta">
      <label class="item-par"><span class="small">Норма</span><input type="number" min="0" step="1" value="${roundSmart(item.par)}" data-item-field="par" data-id="${item.id}"></label>
      <span class="small item-hint ${deficit > 0 ? 'is-low' : ''}">${hint}</span>
    </div>
    <details class="item-adv">
      <summary class="small">Настройка</summary>
      <div class="item-adv-body">
        ${advField}
        <div class="item-adv-actions">
          <button class="mini-btn" data-action="open-writeoff" data-id="${item.id}" data-name="${esc(item.name)}" data-unit="${esc(item.unit)}" data-category="${item.category}">Списать…</button>
          <button class="mini-btn" data-action="open-restock" data-id="${item.id}" data-name="${esc(item.name)}" data-unit="${esc(item.unit)}" data-category="${item.category}">Пополнить…</button>
          ${damageBtn}
        </div>
      </div>
    </details>
  </article>`;
}

function renderInventory(state) {
  const apartment = currentApartment();
  if (!apartment || !dom.pageTitle) return;
  dom.pageTitle.textContent = getDisplayApartmentName(apartment.name);
  dom.apartmentName.value = apartment.name;
  // ID объекта в RealtyCalendar (легаси-поле в «Параметры квартиры», если осталось)
  if (dom.apartmentRealtyId) dom.apartmentRealtyId.value = apartment.externalIds?.realtyCalendarUnitId || '';
  if (dom.apartmentCleaningPrice) {
    const hasPrice = Number(apartment.cleaningPrice) > 0;
    dom.apartmentCleaningPrice.value = hasPrice ? String(apartment.cleaningPrice) : '';
    // Read-only паттерн: если цена введена — блокируем поле и показываем «Редактировать»
    if (hasPrice) {
      dom.apartmentCleaningPrice.setAttribute('readonly', '');
      if (dom.apartmentCleaningPriceEditBtn) dom.apartmentCleaningPriceEditBtn.hidden = false;
      if (dom.apartmentCleaningPriceSaveBtn) dom.apartmentCleaningPriceSaveBtn.hidden = true;
    } else {
      dom.apartmentCleaningPrice.removeAttribute('readonly');
      if (dom.apartmentCleaningPriceEditBtn) dom.apartmentCleaningPriceEditBtn.hidden = true;
      if (dom.apartmentCleaningPriceSaveBtn) dom.apartmentCleaningPriceSaveBtn.hidden = false;
    }
  }
  // Система учёта: субаренда / доверительное управление.
  if (dom.apartmentBusinessModel) {
    const model = apartment.businessModel === 'trust' ? 'trust' : 'sublease';
    dom.apartmentBusinessModel.value = model;
    // Доля УК видна только при ДУ.
    if (dom.apartmentTrustShareRow) dom.apartmentTrustShareRow.hidden = (model !== 'trust');
    if (dom.apartmentTrustShare) {
      dom.apartmentTrustShare.value = Number(apartment.trustShare || 0) > 0 ? String(apartment.trustShare) : '';
    }
    // День оплаты — всегда виден.
    if (dom.apartmentPaymentDay) {
      dom.apartmentPaymentDay.value = Number(apartment.paymentDay || 0) > 0 ? String(apartment.paymentDay) : '';
    }
    // Тип оплаты аренды и стоимость — только для субаренды.
    if (dom.apartmentRentScheduleRow) dom.apartmentRentScheduleRow.hidden = (model !== 'sublease');
    if (dom.apartmentRentAmountRow) dom.apartmentRentAmountRow.hidden = (model !== 'sublease');
    if (dom.apartmentRentSchedule) {
      dom.apartmentRentSchedule.value = apartment.rentSchedule === 'prepay' ? 'prepay' : 'postpay';
    }
    if (dom.apartmentRentAmount) {
      dom.apartmentRentAmount.value = Number(apartment.rentAmount || 0) > 0 ? String(apartment.rentAmount) : '';
    }
  }
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
  // Блоки «Ежедневный расход», «Комплекты» и «Покрытие запасов» убраны:
  // расход на заезд и размер комплекта теперь правятся прямо в карточке позиции.
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

  // Нормализация для RC-броней (не уборка): одинаковый формат на всех карточках.
  // Заголовок = «YYYY-MM-DD → YYYY-MM-DD · Имя», notes скрываем (телефон/источник/ссылка не показываем).
  const _bidRaw = String(entry.externalBookingId || '');
  const _isRcBooking = isIncome && entry.source === 'realtycalendar' && _bidRaw && !_bidRaw.endsWith(':cleaning');
  let displayTitle = entry.title || entry.category || (isIncome ? 'Доход' : 'Расход');
  let displayNotes = entry.notes || '';
  let displayDate = entry.date || '';
  if (_isRcBooking) {
    const bd = entry.meta?.begin_date || '';
    const ed = entry.meta?.end_date || '';
    // Пытаемся вытащить имя гостя: сначала meta, затем из старого title «Бронь #… · Имя».
    let guest = entry.meta?.client_fio || '';
    if (!guest && typeof entry.title === 'string') {
      const parts = entry.title.split(' · ');
      if (parts.length >= 2 && /^Бронь #/i.test(parts[0])) guest = parts.slice(1).join(' · ').trim();
    }
    const range = (bd && ed) ? `${bd} → ${ed}` : (bd || ed || '');
    if (range) {
      displayTitle = guest ? `${range} · ${guest}` : range;
      if (bd) displayDate = bd;
    } else if (guest) {
      displayTitle = guest;
    }
    displayNotes = '';
  }

  // Блок «Договор»: только для доходных броней RC (не уборка)
  let contractBlock = '';
  const bookingIdRaw = String(entry.externalBookingId || '');
  const isBooking = isIncome && entry.source === 'realtycalendar' && bookingIdRaw && !bookingIdRaw.endsWith(':cleaning');
  if (isBooking) {
    const m = entry.meta || {};
    const status = m.contract_status || '';
    const link = m.contract_link || '';
    const si = m.contract_status_internal;
    let icon = '📄';
    if (si === 2) icon = '✅'; else if (si === 3 || si === 5) icon = '⚠️'; else if (si === 1) icon = '📨';
    const statusHtml = status
      ? `<span class="small" style="color:var(--color-text-muted)">${icon} Договор: ${status}</span>`
      : `<span class="small" style="color:var(--color-text-muted)">Договор не создан</span>`;
    const btnCreate = !link
      ? `<button class="btn-chip" data-action="create-contract" data-booking-id="${bookingIdRaw}">Отправить договор</button>`
      : '';
    const btnOpen = link
      ? `<a class="btn-chip" href="${link}" target="_blank" rel="noopener" style="text-decoration:none;">Открыть</a>`
      : '';
    const btnCopy = link
      ? `<button class="btn-chip" data-action="copy-contract-link" data-link="${link}">Копировать ссылку</button>`
      : '';
    contractBlock = `
      <div class="finance-card-contract" style="display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;padding:.4rem .6rem;margin-top:.5rem;border-radius:var(--radius-md);background:var(--color-surface-2);">
        ${statusHtml}
        <div style="display:flex;gap:.35rem;margin-left:auto;flex-wrap:wrap;">${btnCreate}${btnOpen}${btnCopy}</div>
      </div>`;
  }

  // Компактные иконки в правом верхнем углу: карандаш (редактировать) + корзина (удалить).
  // Системные брони из RealtyCalendar не редактируем. Автосписания (auto-rent/auto-owner-payout/cleaning) — редактируем и удаляем.
  const isSystem = entry.source === 'realtycalendar';
  const iconsHtml = isSystem ? '' : `
    <div class="finance-card-icons">
      <button class="finance-icon-btn" data-action="edit-entry" data-id="${entry.id}" title="Редактировать" aria-label="Редактировать">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
      </button>
      <button class="finance-icon-btn" data-action="delete-entry" data-id="${entry.id}" title="Удалить" aria-label="Удалить">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>
      </button>
    </div>`;

  return `<article class="finance-card ${entry.type}" data-entry-id="${entry.id}">
    ${iconsHtml}
    <div class="finance-card-top">
      <div class="finance-card-left">
        <div class="finance-card-title">${displayTitle}</div>
        <div class="finance-card-meta">
          <span>${entry.apartmentName}</span>
          <span class="sep">·</span>
          <span>${displayDate}</span>
          <span class="sep">·</span>
          <span>${sourceIcon(entry.source)} ${sourceLabel(entry.source)}</span>
        </div>
        ${(!_isRcBooking && entry.category) ? `<div class="finance-card-cat">${entry.category}</div>` : ''}
        ${displayNotes ? `<div class="finance-card-notes">${displayNotes}</div>` : ''}
      </div>
      <div class="finance-card-right">
        <div class="finance-amount ${entry.type}">${isIncome ? '+' : '−'}${fmt(showTwoSums ? net : gross)} ₽</div>
        ${showTwoSums ? `<div class="small" style="margin-top:.15rem;color:var(--color-text-muted)">валовый: ${fmt(gross)} ₽</div>` : ''}
        <span class="finance-status ${st.cls}">${st.label}</span>
      </div>
    </div>
    ${contractBlock}
    ${canConfirm ? `<div class="finance-card-actions">
      <button class="btn-chip btn-confirm" data-action="confirm-entry" data-id="${entry.id}" title="Подтвердить">✓ Подтвердить</button>
    </div>` : ''}
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
  if (dom.financeMonthFilter) dom.financeMonthFilter.value = filter.month || '';
  if (dom.financeDateFrom) dom.financeDateFrom.value = filter.dateFrom || '';
  if (dom.financeDateTo) dom.financeDateTo.value = filter.dateTo || '';
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
  `;

  // По квартирам — таблица как в референсе «Реалти»
  // Синк видимых полей периода на вкладке «Итоги по квартирам»
  const summaryFromEl = byId('summaryDateFrom');
  const summaryToEl = byId('summaryDateTo');
  if (summaryFromEl) summaryFromEl.value = filter.dateFrom || '';
  if (summaryToEl) summaryToEl.value = filter.dateTo || '';
  if (dom.financeByApartment) {
    dom.financeByApartment.innerHTML = '<div class="empty">Загрузка…</div>';
    _renderFinanceByApartmentAsync().catch((e) => {
      console.warn('[finance] apt summary async error:', e);
      dom.financeByApartment.innerHTML = '<div class="empty">Ошибка загрузки.</div>';
    });
  }

  // Список проводок
  dom.financeEntriesList.innerHTML = entries.length
    ? entries.map(financeEntryCard).join('')
    : '<div class="empty">Нет записей по фильтрам.</div>';

  // Регулярные расходы
  dom.recurringExpensesList.innerHTML = state.finance.recurringRules.length
    ? state.finance.recurringRules.map(recurringRuleCard).join('')
    : '<div class="empty">Регулярные расходы ещё не настроены.</div>';

  renderRcIntegration(state);
  renderUnitEconomicsSection(state);
}

// Отдельный async-рендер таблицы «Итоги по квартирам» — читает rc_bookings.
let _financeAptSummaryToken = 0;
async function _renderFinanceByApartmentAsync() {
  const myToken = ++_financeAptSummaryToken;
  const apt = await getFinanceApartmentSummaryAsync();
  // Устаревший вызов — выходим.
  if (myToken !== _financeAptSummaryToken) return;
  if (!dom.financeByApartment) return;
  if (!apt.rows.length) {
    dom.financeByApartment.innerHTML = '<div class="empty">Нет данных.</div>';
    return;
  }
  const fmt2 = (n) => Number(n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const pct = (n) => `${Number(n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
      const stay = (n) => Number(n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      const money = (n) => `${fmt2(n)} ₽`;
      const periodLabel = apt.period.from && apt.period.to
        ? `${apt.period.from} — ${apt.period.to} (${apt.period.days} сут.)`
        : 'без периода';
      const BUILD_VERSION = 'v.2026-08-31.11';
      const profitColor = (v) => v >= 0 ? 'var(--color-success)' : 'var(--color-error)';
      // Выплата собственнику: для субаренды — прочерк; для ДУ — сумма.
      const payoutCell = (r) => {
        if (r.businessModel !== 'trust' || r.ownerPayout == null) return '<td class="num muted">—</td>';
        return `<td class="num">${money(r.ownerPayout)}</td>`;
      };
      const rowsHtml = apt.rows.map((r) => `
        <tr>
          <td class="fin-tbl-name">${r.name}</td>
          <td class="num" style="color:${profitColor(r.profit)};font-weight:600">${r.profit >= 0 ? '' : '−'}${money(Math.abs(r.profit))}</td>
          ${payoutCell(r)}
          <td class="num">${money(r.income)}</td>
          <td class="num">${money(r.expense)}</td>
          <td class="num">${money(r.platformCommission)}</td>
          <td class="num">${money(r.avgDaily)}</td>
          <td class="num">${money(r.adr)}</td>
          <td class="num">${pct(r.occupancy)}</td>
          <td class="num">${stay(r.avgStay)}</td>
        </tr>
      `).join('');
      const t = apt.totals;
      dom.financeByApartment.innerHTML = `
        <div class="fin-tbl-period small muted" style="margin-bottom:.5rem;display:flex;justify-content:space-between;gap:.5rem;flex-wrap:wrap;"><span>Период: ${periodLabel}</span><span style="opacity:.6">${BUILD_VERSION}</span></div>
        <div class="fin-tbl-wrap">
          <table class="fin-tbl">
            <thead>
              <tr>
                <th>Объект</th>
                <th class="num">Прибыль</th>
                <th class="num">Выплата собственнику</th>
                <th class="num">Доходы</th>
                <th class="num">Расходы</th>
                <th class="num">Комиссии площадок</th>
                <th class="num">Среднесуточный доход</th>
                <th class="num">ADR (средняя цена проданной ночи)</th>
                <th class="num">Загрузка</th>
                <th class="num">Средняя длит. проживания</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
            <tfoot>
              <tr class="fin-tbl-total">
                <td>Итого:</td>
                <td class="num" style="color:${profitColor(t.profit)}">${t.profit >= 0 ? '' : '−'}${money(Math.abs(t.profit))}</td>
                <td class="num">${(t.ownerPayout && t.ownerPayout > 0) ? money(t.ownerPayout) : '<span class="muted">—</span>'}</td>
                <td class="num">${money(t.income)}</td>
                <td class="num">${money(t.expense)}</td>
                <td class="num">${money(t.platformCommission)}</td>
                <td class="num">${money(t.avgDaily)}</td>
                <td class="num">${money(t.adr)}</td>
                <td class="num">${pct(t.occupancy)}</td>
                <td class="num">${stay(t.avgStay)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      `;
}

// Заглушки-остатки от старого renderFinance — вынесены в renderUnitEconomicsSection.
function renderUnitEconomicsSection(state) {
  void renderUnitEconomics(state);

  // Селекты квартир в модалках
  [dom.financeEntryApartment, dom.recurringApartment].forEach((el) => {
    if (!el) return;
    el.innerHTML = state.apartments.map((a) => `<option value="${a.id}">${getDisplayApartmentName(a.name)}</option>`).join('');
    if (!el.value) el.value = state.activeApartmentId;
  });
  if (dom.financeEntryDate && !dom.financeEntryDate.value) dom.financeEntryDate.value = new Date().toISOString().slice(0, 10);
  if (dom.recurringStartDate && !dom.recurringStartDate.value) dom.recurringStartDate.value = new Date().toISOString().slice(0, 10);
}

// ─── Юнит экономика: селектор квартиры + активный отчёт + история ─────
function _escUnit(s) {
  return String(s).replace(/[&<>"\']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function renderCancelledBlock(stat) {
  const c = Number(stat.cancelledBookings || 0);
  const sum = Number(stat.cancelledAmount || 0);
  if (!c) return '<div class="small muted">Отменённых броней в периоде нет.</div>';
  return `<div class="cancelled-card" style="padding:.6rem .8rem;border-radius:var(--radius-lg);background:rgba(200,60,60,.08);border:1px solid rgba(200,60,60,.18);">
    <span class="small" style="font-weight:600;">Отменённые брони:</span>
    <span class="small" style="margin-left:.5rem;">${c} шт. · ${fmt(sum)} ₽</span>
  </div>`;
}

function renderUnitEntries(entries) {
  if (!entries.length) return '<div class="empty">По текущим фильтрам записей нет.</div>';
  const rows = entries.slice(0, 200).map((e) => {
    const sign = e.type === 'income' ? '+' : '−';
    const color = e.type === 'income' ? 'var(--color-success)' : 'var(--color-error)';
    const st = STATUS_LABELS[e.status] || { label: e.status, cls: 'planned' };
    return `<tr>
      <td class="small">${e.date || ''}</td>
      <td>${_escUnit(e.title || e.category || '')}</td>
      <td class="small muted">${_escUnit(e.category || '')}</td>
      <td class="small muted">${_escUnit(e.source || '')}</td>
      <td class="small"><span class="chip chip-${st.cls}">${st.label}</span></td>
      <td class="num" style="color:${color};font-weight:600">${sign}${fmt(e.amount)}</td>
    </tr>`;
  }).join('');
  return `<div class="unit-eco-table-scroll"><table class="unit-eco-table"><thead><tr>
    <th>Дата</th><th>Название</th><th>Категория</th><th>Источник</th><th>Статус</th><th class="num">Сумма</th>
  </tr></thead><tbody>${rows}</tbody></table>${entries.length > 200 ? '<div class="small muted" style="margin-top:.4rem;">Показаны первые 200 записей.</div>' : ''}</div>`;
}

// Счётчик запросов: рендер может быть вызван несколько раз подряд, и ответ
// от старого запроса не должен затирать более свежий результат.
let _unitEcoSeq = 0;

async function renderUnitEconomics(state) {
  if (!dom.financeTabUnit) return;
  const filter = state.ui?.finance || {};
  const apts = state.apartments || [];

  // 1) Селектор квартиры
  let aptId = filter.unitApartmentId || apts[0]?.id || '';
  if (apts.length && !apts.find(a => a.id === aptId)) aptId = apts[0].id;
  if (dom.unitApartmentSelect) {
    dom.unitApartmentSelect.innerHTML = apts.length
      ? apts.map(a => `<option value="${a.id}">${_escUnit(getDisplayApartmentName(a.name))}</option>`).join('')
      : '<option value="">Нет квартир</option>';
    dom.unitApartmentSelect.value = aptId;
  }

  if (!apts.length) {
    if (dom.unitNoReportBlock) dom.unitNoReportBlock.hidden = true;
    if (dom.unitActiveBlock) dom.unitActiveBlock.hidden = true;
    return;
  }

  // 2) Авто-перенос истекшего периода
  try { advanceUnitEcoReportIfNeeded(aptId); } catch (err) { console.warn('[unit-eco] advance error', err); }
  const apt = (state.apartments || []).find(a => a.id === aptId);
  const active = apt?.unitEcoReports?.active;

  // 3) Нет активного отчёта → форма создания
  if (!active) {
    if (dom.unitNoReportBlock) dom.unitNoReportBlock.hidden = false;
    if (dom.unitActiveBlock) dom.unitActiveBlock.hidden = true;
    if (dom.unitCreateStart && !dom.unitCreateStart.value) {
      dom.unitCreateStart.value = new Date().toISOString().slice(0, 10);
    }
    if (dom.unitCreateEnd && !dom.unitCreateEnd.value) {
      const s = dom.unitCreateStart.value ? new Date(dom.unitCreateStart.value) : new Date();
      const e = new Date(s); e.setMonth(e.getMonth() + 1); e.setDate(e.getDate() - 1);
      dom.unitCreateEnd.value = e.toISOString().slice(0, 10);
    }
    return;
  }

  // 4) Активный отчёт
  if (dom.unitNoReportBlock) dom.unitNoReportBlock.hidden = true;
  if (dom.unitActiveBlock) dom.unitActiveBlock.hidden = false;

  const cadenceLabel = REPORT_CADENCE_LABELS[active.cadence] || active.cadence;
  if (dom.unitActiveTitle) dom.unitActiveTitle.textContent = `Отчётный период · ${cadenceLabel}`;
  if (dom.unitActiveDates) dom.unitActiveDates.textContent = `${active.startDate} — ${active.endDate}`;

  // 5) Один запрос на сервер: справочный срез, отчёт с фильтрами и вся история.
  const unitFilters = filter.unitFilters || { type: 'all', category: 'all', source: 'all', status: 'active' };
  const history = apt?.unitEcoReports?.history || [];
  const seq = ++_unitEcoSeq;

  const periods = [
    { key: 'all', startDate: active.startDate, endDate: active.endDate,
      filters: { type: 'all', category: 'all', source: 'all', status: 'all' }, includeEntries: true },
    { key: 'filtered', startDate: active.startDate, endDate: active.endDate,
      filters: unitFilters, includeEntries: true },
    ...history.map((h) => ({
      key: `h:${h.id}`, startDate: h.startDate, endDate: h.endDate,
      filters: { type: 'all', category: 'all', source: 'all', status: 'active' }, includeEntries: false,
    })),
  ];

  let reports;
  try {
    reports = await fetchUnitEcoReports(aptId, periods);
  } catch (err) {
    console.warn('[unit-eco] расчёт недоступен:', err?.message || err);
    if (seq !== _unitEcoSeq) return; // пришёл более свежий рендер
    const msg = `<div class="empty" style="color:var(--color-error);">Не удалось получить расчёт: ${_escUnit(err?.message || 'нет связи с сервером')}</div>`;
    if (dom.unitEcoSummary) dom.unitEcoSummary.innerHTML = msg;
    if (dom.unitEcoTableWrap) dom.unitEcoTableWrap.innerHTML = '';
    if (dom.unitCancelledBlock) dom.unitCancelledBlock.innerHTML = '';
    if (dom.unitHistoryList) dom.unitHistoryList.innerHTML = '';
    return;
  }
  if (seq !== _unitEcoSeq) return; // ответ устарел — рисует более свежий вызов

  const allInPeriod = reports['all'];
  const report = reports['filtered'];
  if (!allInPeriod || !report) {
    if (dom.unitEcoSummary) dom.unitEcoSummary.innerHTML = '<div class="empty">Нет данных за период.</div>';
    if (dom.unitEcoTableWrap) dom.unitEcoTableWrap.innerHTML = '';
    if (dom.unitCancelledBlock) dom.unitCancelledBlock.innerHTML = '';
    if (dom.unitHistoryList) dom.unitHistoryList.innerHTML = '';
    return;
  }

  // Справочники категорий/источников строим из полного среза за период.
  const categories = Array.from(new Set(allInPeriod.entries.map(e => e.category).filter(Boolean))).sort();
  const sources = Array.from(new Set(allInPeriod.entries.map(e => e.source).filter(Boolean))).sort();

  if (dom.unitFilterCategory) {
    dom.unitFilterCategory.innerHTML = '<option value="all">Все</option>' + categories.map(c => `<option value="${_escUnit(c)}">${_escUnit(c)}</option>`).join('');
    dom.unitFilterCategory.value = categories.includes(unitFilters.category) ? unitFilters.category : 'all';
  }
  if (dom.unitFilterSource) {
    dom.unitFilterSource.innerHTML = '<option value="all">Все</option>' + sources.map(s => `<option value="${_escUnit(s)}">${_escUnit(s)}</option>`).join('');
    dom.unitFilterSource.value = sources.includes(unitFilters.source) ? unitFilters.source : 'all';
  }
  if (dom.unitFilterType) dom.unitFilterType.value = unitFilters.type || 'all';
  if (dom.unitFilterStatus) dom.unitFilterStatus.value = unitFilters.status || 'active';

  // 6) Показатели за период (посчитаны на сервере)
  const s = report.stat;
  const profitColor = s.profit >= 0 ? 'var(--color-success)' : 'var(--color-error)';

  if (dom.unitEcoSummary) {
    dom.unitEcoSummary.innerHTML = `
      <article class="stat"><span>Чистый доход</span><strong style="color:var(--color-success)">${fmt(s.netIncome)} ₽</strong><span class="small" style="color:var(--color-text-muted)">вал: ${fmt(s.grossIncome)} ₽</span></article>
      <article class="stat"><span>Комиссия</span><strong style="color:var(--color-error)">${fmt(s.platformTax)} ₽</strong></article>
      <article class="stat"><span>Расходы</span><strong style="color:var(--color-error)">${fmt(s.expense)} ₽</strong><span class="small" style="color:var(--color-text-muted)">подтв.: ${fmt(s.confirmedExpense || 0)} · план: ${fmt(s.plannedExpense || 0)}</span></article>
      <article class="stat"><span>Маржа</span><strong style="color:${profitColor}">${s.profit >= 0 ? '+' : ''}${fmt(s.profit)} ₽</strong><span class="small" style="color:var(--color-text-muted)">ROI: ${s.roi.toFixed(0)}%</span></article>
      <article class="stat"><span>Брони · Ночи</span><strong>${s.bookings} · ${s.nights}</strong><span class="small" style="color:var(--color-text-muted)">ADR: ${fmt(s.adr)} ₽</span></article>`;
  }

  if (dom.unitCancelledBlock) dom.unitCancelledBlock.innerHTML = renderCancelledBlock(s);
  if (dom.unitEcoTableWrap) dom.unitEcoTableWrap.innerHTML = renderUnitEntries(report.entries);

  // 7) История отчётов — берём из того же ответа, без дополнительных запросов.
  if (dom.unitHistoryList) {
    if (!history.length) {
      dom.unitHistoryList.innerHTML = '';
    } else {
      const items = history.map(h => {
        const hRep = reports[`h:${h.id}`];
        if (!hRep) return '';
        const hs = hRep.stat;
        const hc = hs.profit >= 0 ? 'var(--color-success)' : 'var(--color-error)';
        const hLabel = REPORT_CADENCE_LABELS[h.cadence] || h.cadence;
        return `<div class="history-card" style="padding:.6rem .8rem;border-radius:var(--radius-lg);background:var(--color-surface-2);margin-bottom:.5rem;display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;justify-content:space-between;">
          <div><div style="font-weight:600;">${hLabel} · ${h.startDate} — ${h.endDate}</div><div class="small muted">Чист. доход: ${fmt(hs.netIncome)} ₽ · Расходы: ${fmt(hs.expense)} ₽ · Маржа: <span style="color:${hc};font-weight:600;">${hs.profit >= 0 ? '+' : ''}${fmt(hs.profit)} ₽</span></div></div>
          <button type="button" class="btn btn-icon" data-unit-history-delete="${_escUnit(h.id)}" title="Удалить" style="background:transparent;border:none;color:var(--color-text-muted);cursor:pointer;font-size:1.1rem;line-height:1;padding:.3rem .5rem;">×</button>
        </div>`;
      }).join('');
      dom.unitHistoryList.innerHTML = `<h3 style="margin:.75rem 0 .5rem;font-size:.95rem;">История отчётов</h3>${items}`;
    }
  }
}

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
  // Переключаем видимость всего приложения: для гостя (user===null) показываем только экран входа.
  try {
    if (user) document.body.classList.remove('is-guest');
    else document.body.classList.add('is-guest');
  } catch {}
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
