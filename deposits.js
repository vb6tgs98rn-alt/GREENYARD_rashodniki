/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 *
 * Копирование, распространение, переработка и обратная разработка
 * (reverse engineering) запрещены без письменного разрешения правообладателя.
 * Условия: см. файл LICENSE. Нарушение влечёт ответственность по ст. 1252,
 * 1301 ГК РФ.
 */
// deposits.js — раздел «Залог»: залоги гостей, которые сейчас хранятся
// (деньги заморожены на карте гостя через Точку Банк).
//
// По каждому залогу две кнопки:
//   «Вернуть»      — залог возвращается гостю, комиссии нет;
//   «Оштрафовать»  — вся сумма списывается на расчётный счёт (частично нельзя),
//                    банк берёт комиссию 3,2 %.
// Оба действия — только после подтверждения в отдельном окне.
// Все операции с деньгами выполняет сервер (tochka-api), браузер только просит.

import { openModal, closeModal, setStatus } from './render.js';
import { fetchDeposits, releaseDeposit, captureDeposit } from './tochka.js';

const MODAL_ID = 'depositsModal';
let _items = [];
let _feePercent = 3.2;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(d) {
  const m = String(d || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : '';
}

function fmtDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtRub(n) {
  return Number(n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) + ' ₽';
}

// Понятные тексты для кодов ошибок сервера.
function humanError(err) {
  const code = String(err?.message || err || '');
  const map = {
    not_held: 'Залог уже не хранится: его вернули, списали или срок хранения закончился.',
    hold_expired: 'Срок хранения залога закончился — деньги уже разморозились, списать их нельзя.',
    not_connected: 'Точка Банк не подключена.',
    bank_refused: 'Банк не принял списание. Попробуйте позже.',
    capture_failed: 'Не удалось списать залог. Попробуйте позже.',
    not_found: 'Залог не найден.',
  };
  return map[code] || ('Ошибка: ' + code);
}

function ensureModal() {
  if (document.getElementById(MODAL_ID)) return;
  const html = `
    <div class="modal-backdrop" id="${MODAL_ID}" aria-hidden="true">
      <div class="modal" style="width:min(720px,100%);max-height:92dvh;display:flex;flex-direction:column;">
        <div class="section-head">
          <div>
            <h2 class="modal-title">Залог</h2>
            <p class="muted">Залоги, которые сейчас хранятся. Деньги заморожены на карте гостя до конца срока хранения.</p>
          </div>
          <button class="menu-toggle" id="closeDepositsModal" type="button" aria-label="Закрыть">✕</button>
        </div>
        <div style="display:flex;gap:.5rem;margin-bottom:.75rem;">
          <button class="btn btn-secondary" id="depositsReloadBtn" type="button">↻ Обновить</button>
        </div>
        <div id="depositsListBox" style="flex:1;overflow:auto;"></div>
      </div>
    </div>`;
  document.body.insertAdjacentHTML('beforeend', html);
}

export async function openDepositsModal() {
  ensureModal();
  openModal(MODAL_ID);
  await reloadDeposits();
}

async function reloadDeposits() {
  const box = document.getElementById('depositsListBox');
  if (!box) return;
  box.innerHTML = '<div class="dp-empty">Загрузка…</div>';
  try {
    const res = await fetchDeposits();
    _items = Array.isArray(res?.items) ? res.items : [];
    if (res?.capture_fee_percent != null) _feePercent = Number(res.capture_fee_percent) || _feePercent;
  } catch (e) {
    box.innerHTML = `<div class="dp-empty">Не удалось загрузить залоги: ${esc(e?.message || e)}</div>`;
    return;
  }
  renderList();
}

function renderList() {
  const box = document.getElementById('depositsListBox');
  if (!box) return;
  if (!_items.length) {
    box.innerHTML = '<div class="dp-empty">Сейчас нет залогов на хранении.</div>';
    return;
  }
  box.innerHTML = `<div class="dp-list">${_items.map(renderCard).join('')}</div>`;
}

function renderCard(d) {
  const dates = [fmtDate(d.begin_date), fmtDate(d.end_date)].filter(Boolean).join(' — ');
  const until = fmtDateTime(d.hold_expires_at);
  const actions = d.status === 'capturing'
    ? '<div class="small dp-pending">Списание в обработке у банка…</div>'
    : `<div class="dp-actions">
         <button class="btn btn-secondary" type="button" data-dp-release="${esc(d.id)}">Вернуть</button>
         <button class="btn btn-primary" type="button" data-dp-capture="${esc(d.id)}">Оштрафовать</button>
       </div>`;
  return `
    <article class="dp-card" data-dp-id="${esc(d.id)}">
      <div class="dp-head">
        <span class="dp-guest">${esc(d.guest_name || 'Без имени')}</span>
        <span class="dp-amount">${esc(fmtRub(d.amount))}</span>
      </div>
      <div class="small dp-meta">
        ${d.apartment_title ? `<span>${esc(d.apartment_title)}</span>` : ''}
        ${dates ? `<span>${esc(dates)}</span>` : ''}
        ${until ? `<span>Хранится до ${esc(until)}</span>` : ''}
      </div>
      ${actions}
    </article>`;
}

// Окно подтверждения. Возвращает управление только по кнопкам.
function openConfirm({ title, text, okLabel, onConfirm }) {
  document.getElementById('dpConfirmModal')?.remove();
  const wrap = document.createElement('div');
  wrap.id = 'dpConfirmModal';
  wrap.className = 'modal-backdrop open dp-confirm-backdrop';
  wrap.innerHTML = `
    <div class="modal dp-confirm" role="dialog" aria-modal="true" aria-labelledby="dpConfirmTitle">
      <h2 class="modal-title" id="dpConfirmTitle">${esc(title)}</h2>
      ${text.map((t) => `<p class="small">${esc(t)}</p>`).join('')}
      <div class="dp-confirm-actions">
        <button class="btn btn-secondary" type="button" data-dp-cancel>Отмена</button>
        <button class="btn btn-primary" type="button" data-dp-ok>${esc(okLabel)}</button>
      </div>
      <div class="small dp-confirm-status" role="status" aria-live="polite"></div>
    </div>`;
  document.body.appendChild(wrap);
  const status = wrap.querySelector('.dp-confirm-status');
  const okBtn = wrap.querySelector('[data-dp-ok]');
  const close = () => wrap.remove();

  wrap.addEventListener('click', async (e) => {
    if (e.target === wrap || e.target.closest('[data-dp-cancel]')) { if (!okBtn.disabled) close(); return; }
    if (e.target.closest('[data-dp-ok]')) {
      okBtn.disabled = true;
      status.classList.remove('is-error');
      status.textContent = 'Выполняю…';
      try {
        await onConfirm();
        close();
      } catch (err) {
        status.classList.add('is-error');
        status.textContent = humanError(err);
        okBtn.disabled = false;
      }
    }
  });
  wrap.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !okBtn.disabled) close(); });
  wrap.querySelector('[data-dp-cancel]')?.focus();
}

function confirmRelease(d) {
  const until = fmtDateTime(d.hold_expires_at);
  openConfirm({
    title: 'Вернуть залог?',
    text: [
      `${d.guest_name || 'Гость'} · ${fmtRub(d.amount)}`,
      `Залог будет возвращён гостю, комиссии нет. Деньги разморозятся на карте гостя${until ? ` не позже ${until}` : ''}.`,
      'Оштрафовать гостя после этого будет нельзя.',
    ],
    okLabel: 'Вернуть',
    onConfirm: async () => {
      await releaseDeposit(d.id);
      setStatus('Залог возвращён гостю');
      await reloadDeposits();
    },
  });
}

function confirmCapture(d) {
  const fee = Math.round(Number(d.amount || 0) * _feePercent) / 100;
  const feeText = String(_feePercent).replace('.', ',');
  openConfirm({
    title: 'Оштрафовать гостя?',
    text: [
      `${d.guest_name || 'Гость'} · ${fmtRub(d.amount)}`,
      'Вся сумма залога будет списана на ваш расчётный счёт. Списать только часть нельзя.',
      `Комиссия банка — ${feeText} % (около ${fmtRub(fee)}). Отменить списание будет нельзя.`,
    ],
    okLabel: 'Оштрафовать',
    onConfirm: async () => {
      const res = await captureDeposit(d.id);
      setStatus(res?.status === 'captured' ? 'Залог списан на расчётный счёт' : 'Списание отправлено в банк');
      await reloadDeposits();
    },
  });
}

let _bound = false;
export function bindDepositsEvents() {
  if (_bound) return;
  _bound = true;

  document.getElementById('openDepositsSection')?.addEventListener('click', async () => {
    document.getElementById('drawerMenu')?.classList.remove('open');
    document.getElementById('drawerBackdrop')?.classList.remove('open');
    await openDepositsModal();
  });

  document.body.addEventListener('click', async (e) => {
    if (e.target.closest('#closeDepositsModal')) { closeModal(MODAL_ID); return; }
    if (e.target === document.getElementById(MODAL_ID)) { closeModal(MODAL_ID); return; }
    if (e.target.closest('#depositsReloadBtn')) { await reloadDeposits(); return; }

    const rel = e.target.closest('[data-dp-release]');
    if (rel) {
      const d = _items.find((x) => String(x.id) === rel.getAttribute('data-dp-release'));
      if (d) confirmRelease(d);
      return;
    }
    const cap = e.target.closest('[data-dp-capture]');
    if (cap) {
      const d = _items.find((x) => String(x.id) === cap.getAttribute('data-dp-capture'));
      if (d) confirmCapture(d);
    }
  });
}
