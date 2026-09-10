/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 *
 * Копирование, распространение, переработка и обратная разработка
 * (reverse engineering) запрещены без письменного разрешения правообладателя.
 * Условия: см. файл LICENSE. Нарушение влечёт ответственность по ст. 1252,
 * 1301 ГК РФ.
 */

/**
 * linenUI.js
 * Экран учёта постельного белья и полотенец в карточке квартиры.
 *
 * Что отображает:
 *   1. Таблица-сводка по 6 типам: норма · готово · в использовании · в стирке · всего · дефицит.
 *      При дефиците — кнопка «+ заявка на закупку N».
 *   2. Кнопки быстрых действий: «Инвентаризация», «Добавить позицию», «Отметить постиранное»,
 *      «Списать позицию», «История».
 *   3. Компактный список позиций «в стирке» с чипами (кнопка «постирано» переводит в ready).
 *
 * Все данные — из Supabase через модуль linen.js.
 * Рендер делается по requestRender() c anti-race токеном (последний вызов побеждает).
 */

import dom from './dom.js';
import { currentApartment, updateState, getDisplayApartmentName } from './state.js';
import {
  LINEN_TYPES, LINEN_STATUSES, typeLabel, statusLabel,
  getSummary, listItems, createItem, bulkCreate, setStatus, markLaundered, listEvents,
} from './linen.js';
import { openModal, closeModal } from './render.js';
import { addHistory } from './actions.js';

// ─── Anti-race: только последний ререндер актуален ────────────────────────────
let _renderToken = 0;
let _lastRenderedAptId = '';

// ─── Публичный API ─────────────────────────────────────────────────────────────
export async function renderLinenSection() {
  const apt = currentApartment();
  const root = document.getElementById('linenNewRoot');
  if (!root) return;
  if (!apt) { root.innerHTML = '<div class="empty">Выберите квартиру.</div>'; return; }
  const myToken = ++_renderToken;
  _lastRenderedAptId = apt.id;
  const cap = Number(apt.sleepingCapacity || 0);
  // Загружаем сводку и позиции параллельно.
  let summary = [];
  let items = [];
  try {
    [summary, items] = await Promise.all([
      getSummary(apt.id, cap),
      listItems(apt.id),
    ]);
  } catch (e) {
    console.warn('[linenUI] load error:', e);
    if (myToken !== _renderToken || apt.id !== _lastRenderedAptId) return;
    root.innerHTML = `<div class="empty">Ошибка загрузки: ${escapeHtml(String(e?.message || e))}</div>`;
    return;
  }
  if (myToken !== _renderToken || apt.id !== _lastRenderedAptId) return;
  const total = items.length;
  // Если позиций нет — предложить мастер инвентаризации.
  if (total === 0) {
    root.innerHTML = `
      <div class="hint" style="margin-bottom:.8rem;">
        <strong>Позиций ещё нет.</strong>
        <div class="small">Заполни, сколько чего сейчас в квартире, — приложение создаст позиции с ID автоматически.</div>
      </div>
      ${capacityHintHtml(cap)}
      <div class="actions"><button class="btn btn-primary" id="linenBtnStartInventory" type="button">Стартовая инвентаризация</button></div>
    `;
    document.getElementById('linenBtnStartInventory')?.addEventListener('click', () => openInventoryModal());
    return;
  }
  // Есть позиции: рендерим сводку + действия + «в стирке».
  const laundryItems = items.filter((i) => i.status === 'laundry');
  root.innerHTML = `
    ${capacityHintHtml(cap)}
    ${summaryTableHtml(summary)}
    <div class="actions" style="margin-top:.8rem;flex-wrap:wrap;gap:.5rem;">
      <button class="btn btn-secondary" id="linenBtnInventory" type="button">Инвентаризация</button>
      <button class="btn btn-secondary" id="linenBtnAddOne" type="button">+ Одна позиция</button>
      <button class="btn btn-secondary" id="linenBtnRetire" type="button">Списать</button>
      <button class="btn btn-secondary" id="linenBtnHistory" type="button">История</button>
    </div>
    ${laundryBlockHtml(laundryItems)}
  `;
  wireSummaryButtons(summary);
  wireActionButtons();
  wireLaundryChips();
}

// ─── Внутренние помощники: HTML ────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function capacityHintHtml(cap) {
  if (Number(cap) > 0) return '';
  return `
    <div class="hint" style="margin-bottom:.8rem;background:color-mix(in oklab,var(--color-warning) 15%,transparent);">
      <strong>Не задано число спальных мест.</strong>
      <div class="small">Открой «Параметры квартиры» и укажи. Норма считается как «спальные места × 3».</div>
    </div>
  `;
}

function summaryTableHtml(summary) {
  const rows = summary.map((r) => {
    const deficit = Math.max(0, r.deficit || 0);
    const low = deficit > 0;
    const bg = low ? 'background:color-mix(in oklab,var(--color-error) 8%,transparent);' : '';
    const reqBtn = low
      ? `<button class="btn btn-secondary" data-linen-request="${r.type}" data-qty="${deficit}" type="button" style="padding:.15rem .5rem;font-size:.8rem;">+ заявка ${deficit}</button>`
      : `<span class="small muted">—</span>`;
    return `
      <tr style="${bg}">
        <td style="padding:.35rem .5rem;"><strong>${typeLabel(r.type)}</strong></td>
        <td class="num" style="padding:.35rem .5rem;">${r.norm}</td>
        <td class="num" style="padding:.35rem .5rem;color:var(--color-success);"><strong>${r.ready}</strong></td>
        <td class="num" style="padding:.35rem .5rem;">${r.in_use}</td>
        <td class="num" style="padding:.35rem .5rem;">${r.laundry}</td>
        <td class="num" style="padding:.35rem .5rem;">${r.total}</td>
        <td style="padding:.35rem .5rem;text-align:right;">${reqBtn}</td>
      </tr>
    `;
  }).join('');
  return `
    <div style="overflow-x:auto;">
      <table style="width:100%;border-collapse:collapse;font-size:.9rem;">
        <thead>
          <tr style="text-align:left;color:var(--color-text-muted);font-size:.78rem;text-transform:uppercase;letter-spacing:.03em;">
            <th style="padding:.35rem .5rem;">Тип</th>
            <th class="num" style="padding:.35rem .5rem;text-align:right;">Норма</th>
            <th class="num" style="padding:.35rem .5rem;text-align:right;">Готово</th>
            <th class="num" style="padding:.35rem .5rem;text-align:right;">В исп.</th>
            <th class="num" style="padding:.35rem .5rem;text-align:right;">В стирке</th>
            <th class="num" style="padding:.35rem .5rem;text-align:right;">Всего</th>
            <th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function laundryBlockHtml(items) {
  if (!items.length) return '';
  const chips = items.map((it) => {
    const stainMark = it.stain_note ? ' 🟡' : '';
    return `<button class="history-chip" data-linen-laundered="${escapeHtml(it.id)}" type="button" title="Отметить постиранным">${escapeHtml(it.id)}${stainMark}</button>`;
  }).join(' ');
  return `
    <div class="subsection" style="margin-top:1rem;">
      <div class="subsection-title"><h3 style="font-size:.95rem;">В стирке (${items.length})</h3><span class="small">Нажми на ID, чтобы отметить постиранным</span></div>
      <div style="display:flex;flex-wrap:wrap;gap:.35rem;">${chips}</div>
    </div>
  `;
}

// ─── Обработчики кнопок ────────────────────────────────────────────────────────
function wireSummaryButtons(summary) {
  document.querySelectorAll('[data-linen-request]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const typeKey = btn.getAttribute('data-linen-request');
      const qty = Number(btn.getAttribute('data-qty') || 0);
      if (!typeKey || qty <= 0) return;
      const row = summary.find((r) => r.type === typeKey);
      createPurchaseRequestForLinen(typeKey, qty, row?.label || typeLabel(typeKey));
    });
  });
}

function wireActionButtons() {
  document.getElementById('linenBtnInventory')?.addEventListener('click', () => openInventoryModal());
  document.getElementById('linenBtnAddOne')?.addEventListener('click', () => addOneQuickAsk());
  document.getElementById('linenBtnRetire')?.addEventListener('click', () => openRetireModal());
  document.getElementById('linenBtnHistory')?.addEventListener('click', () => openHistoryModal());
}

function wireLaundryChips() {
  document.querySelectorAll('[data-linen-laundered]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-linen-laundered');
      if (!id) return;
      btn.disabled = true;
      try {
        await markLaundered(id);
      } catch (e) {
        console.warn('[linenUI] markLaundered error:', e);
        alert('Не удалось отметить постиранным: ' + (e?.message || e));
      } finally {
        renderLinenSection();
      }
    });
  });
}

// ─── Мастер стартовой инвентаризации ──────────────────────────────────────────
function openInventoryModal() {
  const apt = currentApartment();
  if (!apt) return;
  const label = document.getElementById('linenInventoryApartmentLabel');
  if (label) label.textContent = `Квартира: ${getDisplayApartmentName(apt.name)}. Введи текущее количество, приложение создаст позиции с ID автоматически.`;
  const grid = document.getElementById('linenInventoryGrid');
  if (grid) {
    grid.innerHTML = LINEN_TYPES.map((t) => `
      <label>
        <span class="small">${t.label}</span>
        <input type="number" min="0" step="1" data-inv-type="${t.key}" placeholder="0" />
      </label>
    `).join('');
  }
  openModal('linenInventoryModal');
}

document.addEventListener('click', (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  if (target.id === 'linenInventoryClose' || target.id === 'linenInventoryCancel') {
    closeModal('linenInventoryModal');
  }
  if (target.id === 'linenRetireClose' || target.id === 'linenRetireCancel') {
    closeModal('linenRetireModal');
  }
  if (target.id === 'linenHistoryClose') {
    closeModal('linenHistoryModal');
  }
});

document.addEventListener('click', async (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  if (target.id !== 'linenInventorySave') return;
  const apt = currentApartment();
  if (!apt) return;
  const inputs = Array.from(document.querySelectorAll('#linenInventoryGrid input[data-inv-type]'));
  const plan = inputs.map((inp) => ({
    type: inp.getAttribute('data-inv-type'),
    qty: Math.max(0, Math.trunc(Number(inp.value || 0))),
  })).filter((p) => p.qty > 0);
  const total = plan.reduce((s, p) => s + p.qty, 0);
  if (total === 0) { alert('Введи хотя бы одно количество.'); return; }
  target.setAttribute('disabled', 'disabled');
  try {
    for (const p of plan) {
      // eslint-disable-next-line no-await-in-loop
      await bulkCreate(apt.id, p.type, p.qty);
    }
    addHistory('Стартовая инвентаризация белья', `Создано позиций: ${total}`, 'create');
    closeModal('linenInventoryModal');
    renderLinenSection();
  } catch (err) {
    console.warn('[linenUI] inventory error:', err);
    alert('Ошибка создания: ' + (err?.message || err));
  } finally {
    target.removeAttribute('disabled');
  }
});

// ─── Одна позиция вручную (простой prompt) ────────────────────────────────────
async function addOneQuickAsk() {
  const apt = currentApartment();
  if (!apt) return;
  const options = LINEN_TYPES.map((t, i) => `${i + 1}. ${t.label}`).join('\n');
  const raw = prompt(`Тип новой позиции (введи цифру 1–6):\n${options}`);
  if (!raw) return;
  const idx = Math.trunc(Number(raw)) - 1;
  const t = LINEN_TYPES[idx];
  if (!t) { alert('Неверный номер'); return; }
  try {
    const newId = await createItem(apt.id, t.key);
    addHistory('Добавлена позиция белья', `${t.label} · ${newId}`, 'create');
    renderLinenSection();
  } catch (e) {
    alert('Не удалось создать: ' + (e?.message || e));
  }
}

// ─── Модалка списания ─────────────────────────────────────────────────────────
async function openRetireModal() {
  const apt = currentApartment();
  if (!apt) return;
  const typeSelect = document.getElementById('linenRetireType');
  const idSelect = document.getElementById('linenRetireItemId');
  const reason = document.getElementById('linenRetireReason');
  if (!typeSelect || !idSelect || !reason) return;
  reason.value = '';
  typeSelect.innerHTML = LINEN_TYPES.map((t) => `<option value="${t.key}">${t.label}</option>`).join('');
  const fillIds = async () => {
    const typeKey = typeSelect.value;
    const items = await listItems(apt.id);
    const filtered = items.filter((it) => it.type === typeKey && it.status !== 'retired');
    idSelect.innerHTML = filtered.length
      ? filtered.map((it) => `<option value="${escapeHtml(it.id)}">${escapeHtml(it.id)} · ${statusLabel(it.status)}</option>`).join('')
      : '<option value="">— нет активных позиций —</option>';
  };
  typeSelect.onchange = fillIds;
  await fillIds();
  openModal('linenRetireModal');
}

document.addEventListener('click', async (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  if (target.id !== 'linenRetireConfirm') return;
  const apt = currentApartment();
  if (!apt) return;
  const idSelect = document.getElementById('linenRetireItemId');
  const reasonInput = document.getElementById('linenRetireReason');
  const itemId = idSelect?.value || '';
  const reason = (reasonInput?.value || '').trim();
  if (!itemId) { alert('Выбери ID позиции'); return; }
  target.setAttribute('disabled', 'disabled');
  try {
    // Определим тип позиции для читаемой заявки/истории.
    const items = await listItems(apt.id, { includeRetired: true });
    const item = items.find((it) => it.id === itemId);
    const label = item ? typeLabel(item.type) : itemId;
    await setStatus(itemId, 'retired', {
      actor: 'owner',
      retiredReason: reason,
      onAutoRequest: () => createPurchaseRequestForLinen(item?.type || '', 1, label, `Замена ${itemId}`),
    });
    addHistory('Списание белья', `${itemId} · ${label}${reason ? ' · ' + reason : ''}`, 'writeoff');
    closeModal('linenRetireModal');
    renderLinenSection();
  } catch (err) {
    console.warn('[linenUI] retire error:', err);
    alert('Не удалось списать: ' + (err?.message || err));
  } finally {
    target.removeAttribute('disabled');
  }
});

// ─── Автозаявка на закупку (пополняет state.purchaseRequests, как обычно) ─────
function createPurchaseRequestForLinen(typeKey, qty, label, comment = '') {
  const apt = currentApartment();
  if (!apt) return;
  const displayName = getDisplayApartmentName(apt.name);
  updateState((state) => {
    state.purchaseRequests = state.purchaseRequests || [];
    state.purchaseRequests.unshift({
      id: crypto.randomUUID(),
      apartmentId: apt.id,
      apartmentName: displayName,
      auto: true,
      done: false,
      createdAt: new Date().toISOString(),
      items: [{ itemId: `linen:${typeKey}`, name: label || typeLabel(typeKey), unit: 'шт', qty: Math.max(1, Math.trunc(Number(qty || 1))), cost: '' }],
      note: comment || '',
    });
  });
  addHistory('Заявка на закупку белья', `${label || typeLabel(typeKey)} × ${qty}${comment ? ' · ' + comment : ''}`, 'auto');
}

// ─── Модалка истории ──────────────────────────────────────────────────────────
async function openHistoryModal() {
  const apt = currentApartment();
  if (!apt) return;
  const label = document.getElementById('linenHistoryApartmentLabel');
  if (label) label.textContent = `Квартира: ${getDisplayApartmentName(apt.name)}. Последние 100 событий.`;
  const list = document.getElementById('linenHistoryList');
  if (list) list.innerHTML = '<div class="empty">Загрузка…</div>';
  openModal('linenHistoryModal');
  try {
    const events = await listEvents(apt.id, { limit: 100 });
    if (!list) return;
    if (!events.length) { list.innerHTML = '<div class="empty">Событий нет.</div>'; return; }
    list.innerHTML = events.map((e) => {
      const when = new Date(e.ts).toLocaleString('ru-RU');
      const actor = e.actor === 'maid' ? 'клинер' : (e.actor === 'system' ? 'система' : 'владелец');
      const from = e.from_status ? `${statusLabel(e.from_status)} → ` : '';
      const to = statusLabel(e.to_status);
      const note = e.note ? ` · ${escapeHtml(e.note)}` : '';
      const photo = e.photo_url ? ` · <a href="${escapeHtml(e.photo_url)}" target="_blank" rel="noopener">📷 фото</a>` : '';
      return `<div class="history-row"><div><strong>${escapeHtml(e.item_id)}</strong><div class="small">${from}${to}${note}${photo}</div></div><div class="small">${actor} · ${when}</div></div>`;
    }).join('');
  } catch (err) {
    if (list) list.innerHTML = `<div class="empty">Ошибка загрузки: ${escapeHtml(String(err?.message || err))}</div>`;
  }
}
