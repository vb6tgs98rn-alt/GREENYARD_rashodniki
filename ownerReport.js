/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 */
// =============================================================================
// Отчёты по квартирам — PDF за цикл оплаты и отправка в Telegram.
// PDF собирается на сервере (Edge Function owner-report), токен бота хранится
// только на сервере. Здесь — скачивание отчёта и привязка Telegram по коду.
// =============================================================================

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { supabase } from './supabase-client.js';
import { openModal, closeModal } from './render.js';

const FN = `${SUPABASE_URL}/functions/v1/owner-report`;

// Заголовки запроса с JWT пользователя.
async function authHeaders() {
  const { data: s } = await supabase.auth.getSession();
  const token = s?.session?.access_token;
  if (!token) throw new Error('Нужно войти в аккаунт');
  return {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${token}`,
    'apikey': SUPABASE_ANON_KEY,
  };
}

// Вызов серверной функции (JSON-ответ).
async function callFn(payload) {
  const resp = await fetch(FN, { method: 'POST', headers: await authHeaders(), body: JSON.stringify(payload) });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json?.ok) throw new Error(json?.error || `Ошибка (${resp.status})`);
  return json;
}

/** Скачать PDF-отчёт по квартире за период [from, to]. */
export async function downloadOwnerReport(apartmentId, from, to) {
  const resp = await fetch(FN, {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify({ action: 'pdf', apartmentId, from, to }),
  });
  if (!resp.ok) {
    const j = await resp.json().catch(() => ({}));
    throw new Error(j?.error || `Ошибка (${resp.status})`);
  }
  const blob = await resp.blob();
  const name = decodeURIComponent(resp.headers.get('x-file-name') || '') || `Отчёт ${from}–${to}.pdf`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return name;
}

function el(id) { return document.getElementById(id); }

function setMsg(text, type = 'info') {
  const box = el('ownerReportMsg');
  if (!box) return;
  box.textContent = text || '';
  box.className = 'auth-dropdown-msg' + (type === 'error' ? ' error' : type === 'ok' ? ' ok' : '');
}

// Отрисовать состояние привязки Telegram.
function renderStatus(cfg, botUsername) {
  const box = el('ownerReportStatus');
  const wrap = el('ownerReportLinkWrap');
  if (!box || !wrap) return;
  const bot = botUsername ? `@${botUsername}` : 'бот отчётов';

  if (cfg?.linked) {
    box.innerHTML = `<div class="small" style="color:var(--ok,#1a7f37)">✅ Telegram привязан (${bot}). Отправка ${cfg.enabled ? 'включена' : 'выключена'}.</div>`;
    wrap.innerHTML =
      `<button class="btn btn-secondary btn-sm" id="ownerReportToggleBtn" type="button">${cfg.enabled ? 'Выключить отправку' : 'Включить отправку'}</button>` +
      `<button class="btn btn-secondary btn-sm" id="ownerReportRelinkBtn" type="button" style="margin-left:.5rem">Привязать другой чат</button>`;
    el('ownerReportToggleBtn')?.addEventListener('click', async () => {
      try { await callFn({ action: 'toggle', enabled: !cfg.enabled }); await refresh(); }
      catch (e) { setMsg(String(e.message || e), 'error'); }
    });
    el('ownerReportRelinkBtn')?.addEventListener('click', createLink);
    return;
  }

  if (cfg?.link_code && botUsername) {
    const url = `https://t.me/${botUsername}?start=${cfg.link_code}`;
    box.innerHTML = '<div class="small" style="color:var(--warn,#b26a00)">⚠️ Telegram ещё не привязан — нажмите кнопку и запустите бота.</div>';
    wrap.innerHTML =
      `<a class="btn btn-primary btn-sm" href="${url}" target="_blank" rel="noopener">Привязать Telegram</a>` +
      `<span class="small" style="margin-left:.5rem">или отправьте боту ${bot}: <code>/start ${cfg.link_code}</code></span>`;
    return;
  }

  box.innerHTML = '<div class="small">Telegram не привязан.</div>';
  wrap.innerHTML = '<button class="btn btn-primary btn-sm" id="ownerReportLinkBtn" type="button">Получить ссылку для привязки</button>';
  el('ownerReportLinkBtn')?.addEventListener('click', createLink);
}

async function createLink() {
  try {
    const res = await callFn({ action: 'link' });
    if (!res.bot_username) { setMsg('Бот отчётов ещё не настроен на сервере.', 'error'); return; }
    renderStatus({ linked: false, link_code: res.link_code }, res.bot_username);
    setMsg('');
  } catch (e) {
    setMsg(String(e.message || e), 'error');
  }
}

// Блок настройки бота (только для владельца): токен уходит на сервер и хранится в Vault.
function renderBotSetup(res) {
  const box = el('ownerReportBotSetup');
  if (!box) return;
  if (!res.can_setup_bot) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const configured = !!res.bot_configured;
  box.innerHTML = configured
    ? `<details><summary class="small">Бот: @${res.bot_username} — сменить токен</summary>${tokenForm()}</details>`
    : `<div class="small" style="margin-bottom:.4rem">Создайте бота в <b>@BotFather</b> (команда /newbot) и вставьте сюда его токен. Токен хранится в зашифрованном виде на сервере и в браузер не возвращается.</div>${tokenForm()}`;
  el('ownerReportTokenSave')?.addEventListener('click', async () => {
    const inp = el('ownerReportToken');
    const token = (inp?.value || '').trim();
    if (!token) { setMsg('Вставьте токен бота.', 'error'); return; }
    setMsg('Проверяю токен…');
    try {
      const r = await callFn({ action: 'setup_bot', token });
      if (inp) inp.value = '';
      setMsg(`Бот @${r.bot_username} подключён. Теперь привяжите Telegram.`, 'ok');
      await refresh();
    } catch (e) {
      setMsg(String(e.message || e), 'error');
    }
  });
}

function tokenForm() {
  return '<div style="display:flex;gap:.5rem;margin-top:.4rem;">' +
    '<input id="ownerReportToken" type="password" autocomplete="off" placeholder="123456789:AA…" style="flex:1" />' +
    '<button class="btn btn-primary btn-sm" id="ownerReportTokenSave" type="button">Сохранить</button></div>';
}

async function refresh() {
  const res = await callFn({ action: 'status' });
  renderBotSetup(res);
  if (!res.bot_configured) {
    const box = el('ownerReportStatus');
    const wrap = el('ownerReportLinkWrap');
    if (box) box.innerHTML = '<div class="small">Бот отчётов ещё не настроен.</div>';
    if (wrap) wrap.innerHTML = '';
    return;
  }
  renderStatus(res.config, res.bot_username);
}

export async function openOwnerReportModal() {
  const modal = el('ownerReportModal');
  if (!modal) return;
  openModal('ownerReportModal');
  setMsg('Загрузка…');
  try { await refresh(); setMsg(''); }
  catch (e) { setMsg(String(e.message || e), 'error'); }

  if (!modal.dataset.wired) {
    modal.dataset.wired = '1';
    el('closeOwnerReport')?.addEventListener('click', () => closeModal('ownerReportModal'));
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal('ownerReportModal'); });
  }
}
