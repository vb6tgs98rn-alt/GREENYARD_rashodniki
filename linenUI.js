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
  inventorySet, unstain, computeNorms,
} from './linen.js';
import { openModal, closeModal } from './render.js';
import { addHistory } from './actions.js';

// Короткий ID для отображения: short_id, если есть, иначе весь id.
function dispId(it) {
  return String(it && (it.short_id || it.id) || '');
}

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
      ${bedsHintHtml(apt)}
      <div class="actions"><button class="btn btn-primary" id="linenBtnStartInventory" type="button">Стартовая инвентаризация</button></div>
    `;
    document.getElementById('linenBtnStartInventory')?.addEventListener('click', () => openInventoryModal());
    return;
  }
  // Есть позиции: рендерим сводку + действия + «в стирке».
  const laundryItems = items.filter((i) => i.status === 'laundry');
  root.innerHTML = `
    ${bedsHintHtml(apt)}
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
  wireStainedButtons(summary);
}

// Список ID в статусе «пятно» — в модалке по клику на число в колонке «Пятно».
function wireStainedButtons(summary) {
  document.querySelectorAll('[data-linen-stained]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const typeKey = btn.getAttribute('data-linen-stained');
      const row = summary.find((r) => r.type === typeKey);
      if (!row) return;
      openStainedModal(row);
    });
  });
}

function openStainedModal(row) {
  const label = typeLabel(row.type);
  const list = (row.stainedIds || []).map((it) => {
    const when = it.updated_at ? new Date(it.updated_at).toLocaleString('ru-RU') : '';
    const note = it.note ? ` · ${escapeHtml(it.note)}` : '';
    return `
      <div class="history-row">
        <div><strong>${escapeHtml(it.short_id || it.id)}</strong><div class="small muted">${escapeHtml(when)}${note}</div></div>
        <div style="display:flex;gap:.35rem;">
          <button class="btn btn-secondary" data-linen-unstain="${escapeHtml(it.id)}" type="button" style="padding:.15rem .5rem;font-size:.8rem;">Отстиралось</button>
          <button class="btn btn-secondary" data-linen-retire-one="${escapeHtml(it.id)}" type="button" style="padding:.15rem .5rem;font-size:.8rem;">Списать</button>
        </div>
      </div>`;
  }).join('') || '<div class="empty">Нет позиций с пятном.</div>';
  const html = `
    <div class="modal" id="linenStainedModal" role="dialog" aria-modal="true">
      <div class="modal__backdrop" data-close></div>
      <div class="modal__card" style="max-width:520px;">
        <div class="modal__header">
          <h2>Пятно — ${escapeHtml(label)}</h2>
          <button class="modal__close" type="button" data-close aria-label="Закрыть">×</button>
        </div>
        <div class="modal__body">${list}</div>
        <div class="modal__footer"><button class="btn btn-secondary" type="button" data-close>Закрыть</button></div>
      </div>
    </div>`;
  document.getElementById('linenStainedModal')?.remove();
  document.body.insertAdjacentHTML('beforeend', html);
  const modal = document.getElementById('linenStainedModal');
  const close = () => { modal?.remove(); };
  modal?.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', close));
  modal?.querySelectorAll('[data-linen-unstain]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-linen-unstain');
      btn.setAttribute('disabled', 'disabled');
      try {
        await unstain(id);
        addHistory('Бельё отстиралось', id, 'update');
        close();
        renderLinenSection();
      } catch (e) {
        alert('Не удалось: ' + (e?.message || e));
        btn.removeAttribute('disabled');
      }
    });
  });
  modal?.querySelectorAll('[data-linen-retire-one]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.getAttribute('data-linen-retire-one');
      btn.setAttribute('disabled', 'disabled');
      try {
        await setStatus(id, 'retired', { actor: 'owner', retiredReason: 'пятно не отстиралось' });
        addHistory('Списание белья', `${id} · пятно`, 'writeoff');
        close();
        renderLinenSection();
      } catch (e) {
        alert('Не удалось: ' + (e?.message || e));
        btn.removeAttribute('disabled');
      }
    });
  });
}

// ─── Внутренние помощники: HTML ────────────────────────────────────────────────
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function bedsHintHtml(apt) {
  const beds = Array.isArray(apt?.beds) ? apt.beds : [];
  if (beds.length > 0) return '';
  return `
    <div class="hint" style="margin-bottom:.8rem;background:color-mix(in oklab,var(--color-warning) 15%,transparent);">
      <strong>Не заданы спальные места.</strong>
      <div class="small">Открой «Параметры квартиры» и добавь односпальные или двуспальные места — от этого зависит норма белья.</div>
    </div>
  `;
}

function summaryTableHtml(summary) {
  // Скрываем типы, которые в квартире не актуальны: norm=0 и позиций нет.
  // Если позиции есть (have > 0) при norm=0 — показываем, чтобы пользователь видел старые запасы.
  const visible = summary.filter((r) => Number(r.norm || 0) > 0 || Number(r.have || 0) > 0);
  if (visible.length === 0) return '<div class="empty small" style="margin:.5rem 0;">Нет актуальных типов. Задай спальные места в параметрах квартиры.</div>';
  const rows = visible.map((r) => {
    // Дефицит считаем как norm − have («есть» включает всё, кроме списанных).
    const deficit = Math.max(0, Number(r.norm || 0) - Number(r.have || 0));
    const low = deficit > 0;
    const bg = low ? 'background:color-mix(in oklab,var(--color-error) 8%,transparent);' : '';
    const reqBtn = low
      ? `<button class="btn btn-secondary" data-linen-request="${r.type}" data-qty="${deficit}" type="button" style="padding:.15rem .5rem;font-size:.8rem;">+ заявка ${deficit}</button>`
      : `<span class="small muted">—</span>`;
    const stainedCell = Number(r.stained || 0) > 0
      ? `<button class="btn-link" data-linen-stained="${r.type}" type="button" style="background:none;border:0;padding:0;color:var(--color-warning);font-weight:600;cursor:pointer;text-decoration:underline;">${r.stained}</button>`
      : `<span>${r.stained || 0}</span>`;
    return `
      <tr style="${bg}">
        <td style="padding:.35rem .5rem;"><strong>${typeLabel(r.type)}</strong></td>
        <td class="num" style="padding:.35rem .5rem;">${r.norm}</td>
        <td class="num" style="padding:.35rem .5rem;color:var(--color-success);"><strong>${r.have}</strong></td>
        <td class="num" style="padding:.35rem .5rem;">${stainedCell}</td>
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
            <th class="num" style="padding:.35rem .5rem;text-align:right;">Есть</th>
            <th class="num" style="padding:.35rem .5rem;text-align:right;">Пятно</th>
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
    return `<button class="history-chip" data-linen-laundered="${escapeHtml(it.id)}" type="button" title="Отметить постиранным">${escapeHtml(dispId(it))}${stainMark}</button>`;
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
    // Показываем только актуальные для квартиры типы (норма > 0).
    const norms = computeNorms(apt);
    const relevant = LINEN_TYPES.filter((t) => Number(norms[t.key] || 0) > 0);
    const list = relevant.length ? relevant : LINEN_TYPES; // если спальные места не заданы — покажем все, чтобы не блокировать первую инвентаризацию
    grid.innerHTML = list.map((t) => `
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
    // Инвентаризация = УСТАНОВИТЬ итоговое кол-во (а не прибавлять).
    // План строим по всем типам — пустое поле = 0 (т.е. «списать всё» по этому типу).
    const fullPlan = Array.from(document.querySelectorAll('#linenInventoryGrid input[data-inv-type]')).map((inp) => ({
      type: inp.getAttribute('data-inv-type'),
      qty: Math.max(0, Math.trunc(Number(inp.value || 0))),
    }));
    let created = 0;
    let retired = 0;
    for (const p of fullPlan) {
      // eslint-disable-next-line no-await-in-loop
      const res = await inventorySet(apt.id, p.type, p.qty);
      created += res.created;
      retired += res.retired;
    }
    addHistory('Инвентаризация белья', `Создано: ${created}, списано: ${retired}`, 'update');
    closeModal('linenInventoryModal');
    renderLinenSection();
  } catch (err) {
    console.warn('[linenUI] inventory error:', err);
    alert('Ошибка сохранения: ' + (err?.message || err));
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
      ? filtered.map((it) => `<option value="${escapeHtml(it.id)}">${escapeHtml(dispId(it))} · ${statusLabel(it.status)}</option>`).join('')
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
    const shownId = item ? dispId(item) : itemId;
    await setStatus(itemId, 'retired', {
      actor: 'owner',
      retiredReason: reason,
      onAutoRequest: () => createPurchaseRequestForLinen(item?.type || '', 1, label, `Замена ${shownId}`),
    });
    addHistory('Списание белья', `${shownId} · ${label}${reason ? ' · ' + reason : ''}`, 'writeoff');
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
      // Подменим длинный item_id (NAV-XXXX-0001) на короткий для отображения.
      const shortId = String(e.item_id || '').match(/(\d+)\s*$/)?.[1] || e.item_id;
      return `<div class="history-row"><div><strong>${escapeHtml(shortId)}</strong><div class="small">${from}${to}${note}${photo}</div></div><div class="small">${actor} · ${when}</div></div>`;
    }).join('');
  } catch (err) {
    if (list) list.innerHTML = `<div class="empty">Ошибка загрузки: ${escapeHtml(String(err?.message || err))}</div>`;
  }
}
