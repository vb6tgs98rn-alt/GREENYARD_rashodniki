/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 */
// =============================================================================
// Уведомления Авито — раздел веб-приложения.
// Пользователь указывает почту и пароль приложения (сохраняются на сервере,
// пароль — в зашифрованном хранилище), затем привязывает Telegram по коду.
// Читаем ТОЛЬКО письма от avito.ru и только их заголовки — без персональных
// данных. Настройка доступна только здесь (в чате небезопасно).
// =============================================================================

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { supabase } from './supabase-client.js';
import { openModal, closeModal } from './render.js';

const FN = `${SUPABASE_URL}/functions/v1/avito-notify-config`;

// Вызов серверной функции настройки с JWT пользователя.
async function callConfig(payload) {
  const { data: s } = await supabase.auth.getSession();
  const token = s?.session?.access_token;
  if (!token) throw new Error('Нужно войти в аккаунт');
  const resp = await fetch(FN, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
      'apikey': SUPABASE_ANON_KEY,
    },
    body: JSON.stringify(payload),
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok || !json?.ok) throw new Error(json?.error || `Ошибка (${resp.status})`);
  return json;
}

function el(id) { return document.getElementById(id); }

function setMsg(text, type = 'info') {
  const box = el('avitoNotifyMsg');
  if (!box) return;
  box.textContent = text || '';
  box.className = 'auth-dropdown-msg' + (type === 'error' ? ' error' : type === 'ok' ? ' ok' : '');
}

// Отрисовать текущее состояние привязки.
function renderStatus(cfg, botUsername) {
  const box = el('avitoNotifyStatus');
  const linkWrap = el('avitoNotifyLinkWrap');
  if (!box) return;
  if (!cfg) {
    box.innerHTML = '<span class="small">Не настроено. Укажите почту и пароль приложения ниже.</span>';
    if (linkWrap) linkWrap.hidden = true;
    return;
  }
  const parts = [];
  parts.push(`<div class="small">Почта: <b>${cfg.email}</b> (${cfg.imap_host})</div>`);
  if (cfg.linked) {
    parts.push(`<div class="small" style="color:var(--ok,#1a7f37)">✅ Telegram привязан. Уведомления ${cfg.enabled ? 'включены' : 'выключены'}.</div>`);
  } else {
    parts.push('<div class="small" style="color:var(--warn,#b26a00)">⚠️ Telegram не привязан — нажмите «Привязать Telegram».</div>');
  }
  if (cfg.last_ok_at) parts.push(`<div class="small">Последняя проверка почты: ${new Date(cfg.last_ok_at).toLocaleString('ru-RU')}</div>`);
  if (cfg.last_error) parts.push(`<div class="small" style="color:var(--err,#c00)">Ошибка: ${cfg.last_error}</div>`);
  box.innerHTML = parts.join('');

  // Кнопка привязки Telegram.
  if (linkWrap) {
    if (cfg.link_code && !cfg.linked) {
      const url = `https://t.me/${botUsername}?start=${cfg.link_code}`;
      linkWrap.hidden = false;
      linkWrap.innerHTML =
        `<a class="btn btn-primary btn-sm" href="${url}" target="_blank" rel="noopener">Привязать Telegram</a>` +
        `<span class="small" style="margin-left:.5rem">или отправьте боту @${botUsername}: <code>/start ${cfg.link_code}</code></span>`;
    } else if (cfg.linked) {
      linkWrap.hidden = false;
      linkWrap.innerHTML =
        `<button class="btn btn-secondary btn-sm" id="avitoToggleBtn">${cfg.enabled ? 'Выключить уведомления' : 'Включить уведомления'}</button>` +
        `<button class="btn btn-danger btn-sm" id="avitoDeleteBtn" style="margin-left:.5rem">Удалить</button>`;
      el('avitoToggleBtn')?.addEventListener('click', async () => {
        try { await callConfig({ action: 'toggle', enabled: !cfg.enabled }); await refresh(); }
        catch (e) { setMsg(String(e.message || e), 'error'); }
      });
      el('avitoDeleteBtn')?.addEventListener('click', async () => {
        if (!confirm('Удалить настройки уведомлений Авито? Почта и пароль будут стёрты с сервера.')) return;
        try { await callConfig({ action: 'delete' }); setMsg('Удалено.', 'ok'); await refresh(); }
        catch (e) { setMsg(String(e.message || e), 'error'); }
      });
    } else {
      linkWrap.hidden = true;
    }
  }
}

let lastBotUsername = 'Avito_fast_message_bot';

async function refresh() {
  const res = await callConfig({ action: 'status' });
  lastBotUsername = res.bot_username || lastBotUsername;
  renderStatus(res.config, lastBotUsername);
  // Заполняем поле почты, если уже сохранено.
  if (res.config?.email && el('avitoEmail') && !el('avitoEmail').value) {
    el('avitoEmail').value = res.config.email;
  }
}

async function save() {
  const email = (el('avitoEmail')?.value || '').trim();
  const password = el('avitoPassword')?.value || '';
  const host = (el('avitoHost')?.value || '').trim();
  if (!email || !password) { setMsg('Укажите почту и пароль приложения.', 'error'); return; }
  setMsg('Проверяю вход в почту…');
  try {
    const res = await callConfig({ action: 'save', email, password, imap_host: host || undefined });
    if (el('avitoPassword')) el('avitoPassword').value = '';
    setMsg('Почта проверена и сохранена. ' + (res.linked ? 'Telegram уже привязан.' : 'Теперь привяжите Telegram.'), 'ok');
    await refresh();
  } catch (e) {
    setMsg(String(e.message || e), 'error');
  }
}

export async function openAvitoNotifyModal() {
  const modal = el('avitoNotifyModal');
  if (!modal) return;
  openModal('avitoNotifyModal');
  setMsg('Загрузка…');
  try { await refresh(); setMsg(''); }
  catch (e) { setMsg(String(e.message || e), 'error'); }

  // Обработчики (навешиваем один раз).
  if (!modal.dataset.wired) {
    modal.dataset.wired = '1';
    el('avitoSaveBtn')?.addEventListener('click', save);
    el('avitoPwdShow')?.addEventListener('change', (e) => {
      const inp = el('avitoPassword'); if (inp) inp.type = e.target.checked ? 'text' : 'password';
    });
    el('closeAvitoNotify')?.addEventListener('click', closeAvitoNotifyModal);
    modal.addEventListener('click', (e) => { if (e.target === modal) closeAvitoNotifyModal(); });
  }
}

export function closeAvitoNotifyModal() {
  closeModal('avitoNotifyModal');
}
