/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 */
// =============================================================================
// Оценки гостей на карточках квартир.
//
// Оценки ставит бот гостя накануне выезда и складывает в таблицу guest_reviews.
// Здесь: звёздочка со средней оценкой справа от названия квартиры и окно
// со списком отзывов (имя гостя, даты проживания, оценка, текст).
//
// Таблица читается одним небольшим запросом уже после того, как список квартир
// нарисован, и кэшируется на 5 минут — на скорость загрузки приложения это не влияет.
// =============================================================================

import { supabase } from './supabase-client.js';

const CACHE_MS = 5 * 60000;
const MODAL_ID = 'guestReviewsModal';

let cache = null;        // { at, rows }
let inflight = null;     // общий запрос, если звёздочки просят несколько раз подряд
let wired = false;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtDate(iso) {
  if (!iso) return '';
  const [y, m, d] = String(iso).slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}

function fmtAvg(n) {
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
}

async function loadReviews(force = false) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.rows;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const { data: s } = await supabase.auth.getSession();
      if (!s?.session) return [];
      const { data, error } = await supabase
        .from('guest_reviews')
        .select('booking_id, realty_id, apartment_title, guest_name, begin_date, end_date, source, rating, comment, checkin_comment, rated_at, created_at')
        .order('end_date', { ascending: false })
        .limit(2000);
      if (error) { console.warn('[reviews] загрузка:', error.message); return cache?.rows || []; }
      cache = { at: Date.now(), rows: data || [] };
      return cache.rows;
    } catch (e) {
      console.warn('[reviews] загрузка:', e?.message || e);
      return cache?.rows || [];
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

/** Отзывы одной квартиры (по ID объекта в RealtyCalendar). */
function rowsFor(rows, realtyId) {
  return rows.filter((r) => String(r.realty_id ?? '') === String(realtyId) && (r.rating || r.comment || r.checkin_comment));
}

function summary(list) {
  const rated = list.filter((r) => r.rating);
  const avg = rated.length ? rated.reduce((s, r) => s + Number(r.rating), 0) / rated.length : null;
  return { avg, count: rated.length };
}

/** Проставляет звёздочки на уже нарисованных карточках квартир. */
export async function paintApartmentRatings() {
  wire();
  const nodes = document.querySelectorAll('[data-apt-rating]');
  if (!nodes.length) return;
  const rows = await loadReviews();
  document.querySelectorAll('[data-apt-rating]').forEach((el) => {
    const list = rowsFor(rows, el.dataset.aptRating);
    if (!list.length) { el.hidden = true; return; }
    const { avg, count } = summary(list);
    el.innerHTML = `<span class="apt-rating-star" aria-hidden="true">★</span>${avg == null ? '—' : fmtAvg(avg)}`;
    el.title = avg == null ? 'Отзывы гостей' : `Средняя оценка гостей: ${fmtAvg(avg)} (оценок: ${count})`;
    el.setAttribute('aria-label', el.title);
    el.hidden = false;
  });
}

function stars(n) {
  const k = Math.max(0, Math.min(5, Number(n) || 0));
  return `<span class="rv-stars" aria-label="Оценка ${k} из 5">${'★'.repeat(k)}<span class="rv-stars-off">${'★'.repeat(5 - k)}</span></span>`;
}

function ensureModal() {
  let el = document.getElementById(MODAL_ID);
  if (el) return el;
  el = document.createElement('div');
  el.className = 'modal-backdrop';
  el.id = MODAL_ID;
  el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<div class="modal" style="width:min(640px,100%);max-height:90dvh;overflow:auto;">
    <div class="section-head">
      <div><h2 class="modal-title" id="guestReviewsTitle">Отзывы гостей</h2><p class="muted" id="guestReviewsSub"></p></div>
      <button class="menu-toggle" type="button" data-close-reviews aria-label="Закрыть">✕</button>
    </div>
    <div id="guestReviewsList" class="rv-list"></div>
  </div>`;
  document.body.appendChild(el);
  el.addEventListener('click', (e) => {
    if (e.target === el || e.target.closest('[data-close-reviews]')) closeReviews();
  });
  return el;
}

function closeReviews() {
  const el = document.getElementById(MODAL_ID);
  if (!el) return;
  el.classList.remove('open');
  el.setAttribute('aria-hidden', 'true');
}

async function openReviews(realtyId, aptName) {
  const el = ensureModal();
  const listEl = el.querySelector('#guestReviewsList');
  el.querySelector('#guestReviewsTitle').textContent = aptName ? `Отзывы гостей · ${aptName}` : 'Отзывы гостей';
  el.querySelector('#guestReviewsSub').textContent = 'Загружаю…';
  listEl.innerHTML = '';
  el.classList.add('open');
  el.setAttribute('aria-hidden', 'false');

  const rows = rowsFor(await loadReviews(true), realtyId);
  const { avg, count } = summary(rows);
  el.querySelector('#guestReviewsSub').textContent = count
    ? `Средняя оценка ${fmtAvg(avg)} из 5 · оценок: ${count}`
    : 'Оценок пока нет';
  if (!rows.length) {
    listEl.innerHTML = '<div class="empty">Отзывов пока нет.</div>';
    return;
  }
  listEl.innerHTML = rows.map((r) => {
    const dates = r.begin_date && r.end_date ? `${fmtDate(r.begin_date)} – ${fmtDate(r.end_date)}` : '';
    const text = r.comment ? `<div class="rv-text">${esc(r.comment)}</div>` : '';
    const checkin = r.checkin_comment ? `<div class="rv-text rv-checkin"><span class="small">После заселения:</span> ${esc(r.checkin_comment)}</div>` : '';
    return `<article class="rv-item">
      <div class="rv-head">
        <div><strong>${esc(r.guest_name || 'Гость')}</strong><div class="small rv-dates">${esc(dates)}</div></div>
        ${r.rating ? stars(r.rating) : '<span class="small rv-dates">без оценки</span>'}
      </div>
      ${text}${checkin}
    </article>`;
  }).join('');
}

function wire() {
  if (wired) return;
  wired = true;
  // Перехватываем клик раньше обработчика карточки, чтобы не переключать квартиру.
  const handler = (e) => {
    const el = e.target.closest?.('[data-apt-rating]');
    if (!el) return;
    if (e.type === 'keydown' && e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    openReviews(el.dataset.aptRating, el.dataset.aptName || '');
  };
  document.addEventListener('click', handler, true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById(MODAL_ID)?.classList.contains('open')) { closeReviews(); return; }
    handler(e);
  }, true);
}
