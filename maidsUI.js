/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 *
 * Копирование, распространение, переработка и обратная разработка
 * (reverse engineering) запрещены без письменного разрешения правообладателя.
 * Условия: см. файл LICENSE. Нарушение влечёт ответственность по ст. 1252,
 * 1301 ГК РФ.
 */
// ==================================================
// maidsUI.js — раздел «Горничные» и вкладка «Чаты с горничными»
// ==================================================
//
// Экспортирует:
//   bindMaidsEvents(state)  — привязка обработчиков (вызвать при загрузке)
//   openMaidsModal(state)   — открыть окно управления горничными
//   fetchMaids()            — список горничных с закреплёнными квартирами
//   fetchMaidChats()        — список чатов горничных для раздела «Чаты»
//
// Требует: supabase-client.js, render.js, config (BOT_FUNCTION_URL)
// ==================================================

import { getSupabaseClient, waitForAuthReady, requireUser } from './supabase-client.js';
import { openModal, closeModal, setStatus } from './render.js';
import {
  BOT_FUNCTION_URL,
  CHANNEL_TITLE,
  botAuthHeaders,
  fillChannelOptions,
  TELEGRAM_BOT_USERNAME_DEFAULT,
} from './guestBot.js';

const supabase = () => getSupabaseClient();

function htmlEscape(s = '') {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmtDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return String(iso); }
}

function randomToken(len = 24) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  return Array.from(arr, b => b.toString(16).padStart(2, '0')).join('');
}

// ---------- API ----------

export async function fetchMaids() {
  const sb = supabase();
  const user = await requireUser();
  if (!user) return [];
  const { data: maids, error } = await sb
    .from('maids')
    .select('id, name, phone, tg_chat_id, channel, channel_chat_id, invite_token, active, created_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  if (error) { console.warn('[maids] fetch:', error.message); return []; }
  if (!maids?.length) return [];
  const ids = maids.map(m => m.id);
  const { data: links } = await sb
    .from('maid_apartments')
    .select('maid_id, realty_id')
    .in('maid_id', ids);
  const byMaid = new Map();
  (links || []).forEach(l => {
    if (!byMaid.has(l.maid_id)) byMaid.set(l.maid_id, []);
    byMaid.get(l.maid_id).push(String(l.realty_id));
  });
  return maids.map(m => ({ ...m, realty_ids: byMaid.get(m.id) || [] }));
}

// ---------- Каналы (мессенджеры) ----------

/** Ссылка-приглашение для горничной в выбранном мессенджере. */
async function fetchMaidInvite(maidId, channel) {
  const r = await fetch(`${BOT_FUNCTION_URL}/maid_invite`, {
    method: 'POST',
    headers: await botAuthHeaders(),
    body: JSON.stringify({ maid_id: maidId, channel }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j?.ok) throw new Error(j?.error || 'invite_failed');
  return j.link;
}

/** Куда подключена горничная: возвращает id канала или null. */
function maidChannel(m) {
  if (m?.channel_chat_id) return m.channel || 'telegram';
  if (m?.tg_chat_id) return 'telegram';
  return null;
}

async function createMaid({ name, phone, channel, realtyIds }) {
  const sb = supabase();
  const user = await requireUser();
  if (!user) throw new Error('unauthorized');
  const token = randomToken(20);
  const { data: maid, error } = await sb
    .from('maids')
    .insert({
      user_id: user.id,
      name: name.trim(),
      phone: (phone || '').trim() || null,
      invite_token: token,
      channel: channel || 'telegram',
      active: true,
    })
    .select('id, invite_token, name, channel')
    .single();
  if (error) throw error;
  if (realtyIds?.length) {
    const rows = realtyIds.map(rid => ({
      maid_id: maid.id,
      user_id: user.id,
      realty_id: Number(rid),
    }));
    const { error: e2 } = await sb.from('maid_apartments').upsert(rows, { onConflict: 'maid_id,realty_id', ignoreDuplicates: true });
    if (e2) {
      console.error('[maids] link error:', e2);
      throw new Error('Не удалось закрепить квартиры: ' + (e2.message || e2.code || 'unknown'));
    }
  }
  return maid;
}

async function updateMaidApartments(maidId, realtyIds) {
  const sb = supabase();
  const user = await requireUser();
  if (!user) throw new Error('unauthorized');
  // Фильтр по user_id — явная изоляция арендатора помимо RLS.
  const { error: eDel } = await sb.from('maid_apartments').delete().eq('user_id', user.id).eq('maid_id', maidId);
  if (eDel) {
    console.error('[maids] delete links error:', eDel);
    throw new Error('Не удалось очистить закрепления: ' + (eDel.message || 'unknown'));
  }
  if (realtyIds?.length) {
    const rows = realtyIds.map(rid => ({
      maid_id: maidId,
      user_id: user.id,
      realty_id: Number(rid),
    }));
    const { error: eIns } = await sb.from('maid_apartments').upsert(rows, { onConflict: 'maid_id,realty_id', ignoreDuplicates: true });
    if (eIns) {
      console.error('[maids] insert links error:', eIns);
      throw new Error('Не удалось сохранить квартиры: ' + (eIns.message || 'unknown'));
    }
  }
}

async function updateMaid(maidId, patch) {
  const sb = supabase();
  const user = await requireUser();
  if (!user) throw new Error('unauthorized');
  // Без .eq('user_id') PostgREST при блокировке RLS вернёт тихие 0 строк без ошибки.
  const { error } = await sb.from('maids').update(patch).eq('user_id', user.id).eq('id', maidId);
  if (error) throw error;
}

async function deleteMaid(maidId) {
  const sb = supabase();
  const user = await requireUser();
  if (!user) throw new Error('unauthorized');
  const { error } = await sb.from('maids').delete().eq('user_id', user.id).eq('id', maidId);
  if (error) throw error;
}

export async function fetchMaidChats() {
  const sb = supabase();
  const user = await requireUser();
  if (!user) return [];
  const { data: maids } = await sb
    .from('maids')
    .select('id, name, tg_chat_id, active')
    .eq('user_id', user.id)
    .eq('active', true);
  if (!maids?.length) return [];
  // Последнее сообщение по каждой
  const results = [];
  for (const m of maids) {
    const { data: last } = await sb
      .from('maid_messages')
      .select('id, text, photo_url, direction, sender, created_at')
      .eq('maid_id', m.id)
      .order('created_at', { ascending: false })
      .limit(1);
    results.push({
      id: m.id,
      name: m.name,
      tg_chat_id: m.tg_chat_id,
      connected: !!m.tg_chat_id,
      last: last?.[0] || null,
    });
  }
  results.sort((a, b) => {
    const ta = a.last?.created_at || '';
    const tb = b.last?.created_at || '';
    return tb.localeCompare(ta);
  });
  return results;
}

export async function fetchMaidMessages(maidId, limit = 200) {
  const sb = supabase();
  const { data, error } = await sb
    .from('maid_messages')
    .select('id, text, photo_url, direction, sender, created_at, tg_message_id')
    .eq('maid_id', maidId)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) { console.warn('[maids] messages:', error.message); return []; }
  // Отбрасываем служебные маркеры типа awaiting_supply
  return (data || []).filter(m => {
    if (m.sender === 'bot' && m.direction === 'system' && (m.text || '').startsWith('awaiting_supply:')) return false;
    return true;
  });
}

export async function sendManagerMessageToMaid(maidId, text) {
  const sb = supabase();
  const { data: { session } } = await sb.auth.getSession();
  const token = session?.access_token;
  if (!token) throw new Error('unauthorized');
  const r = await fetch(`${BOT_FUNCTION_URL}/send_maid`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ maid_id: maidId, text }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j?.ok) throw new Error(j?.error || 'send_failed');
  return j;
}

// ---------- Модалка «Горничные» ----------

let _maidsModalMounted = false;

function ensureMaidsModal() {
  if (document.getElementById('maidsModal')) return;
  const html = `
    <div class="modal-backdrop" id="maidsModal" aria-hidden="true">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="maidsModalTitle">
        <div class="section-head">
          <h2 class="modal-title" id="maidsModalTitle">Горничные</h2>
          <div style="display:flex;gap:.5rem;align-items:center;">
            <button class="pill" id="maidsAddBtn" type="button">+ Добавить</button>
            <button class="btn btn-secondary" id="closeMaidsModal" type="button">✕</button>
          </div>
        </div>
        <div id="maidsList" style="display:grid;gap:.75rem;"></div>
      </div>
    </div>

    <div class="modal-backdrop" id="maidChatModal" aria-hidden="true">
      <div class="modal" role="dialog" aria-modal="true" style="max-width:760px;display:flex;flex-direction:column;height:min(85dvh,720px);">
        <div class="section-head">
          <h2 class="modal-title" id="maidChatTitle">Чат с горничной</h2>
          <button class="btn btn-secondary" id="closeMaidChatModal" type="button">✕</button>
        </div>
        <div id="maidChatBox" style="flex:1;overflow:auto;padding:.5rem;background:var(--color-surface-2);border-radius:.75rem;margin-bottom:.75rem;display:flex;flex-direction:column;gap:.4rem;"></div>
        <div style="display:flex;gap:.5rem;">
          <input type="text" id="maidChatInput" placeholder="Напишите сообщение…" style="flex:1;" />
          <button class="btn btn-primary" id="maidChatSend" type="button">Отправить</button>
        </div>
      </div>
    </div>

    <div class="modal-backdrop" id="maidEditModal" aria-hidden="true">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="maidEditTitle" style="max-width:640px;">
        <div class="section-head">
          <h2 class="modal-title" id="maidEditTitle">Новая горничная</h2>
          <button class="btn btn-secondary" id="closeMaidEditModal" type="button">✕</button>
        </div>
        <div style="display:grid;gap:.75rem;">
          <label><span class="small">Имя</span><input type="text" id="maidEditName" placeholder="Например, Марина" /></label>
          <label><span class="small">Телефон (необязательно)</span><input type="text" id="maidEditPhone" placeholder="+7…" /></label>
          <label>
            <span class="small">Мессенджер</span>
            <select id="maidEditChannel"><option value="telegram">Telegram</option></select>
            <span class="small" id="maidEditChannelHint" style="color:var(--color-text-muted);"></span>
          </label>
          <div>
            <div class="small" style="margin-bottom:.35rem;">Квартиры, за которыми закреплена горничная</div>
            <div id="maidEditApartments" style="display:grid;gap:.4rem;max-height:260px;overflow-y:auto;overflow-x:hidden;padding:.5rem;border:1px solid rgba(60,60,60,.15);border-radius:.75rem;"></div>
          </div>
          <div id="maidEditInviteBox" hidden style="padding:.75rem;background:var(--color-surface-2);border-radius:.75rem;">
            <div class="small" id="maidEditInviteLabel" style="margin-bottom:.35rem;">Ссылка для входа горничной:</div>
            <div style="display:flex;gap:.5rem;align-items:center;">
              <input type="text" id="maidEditInviteLink" readonly style="flex:1;font-family:monospace;font-size:.85rem;" />
              <button class="btn btn-secondary btn-sm" id="maidEditCopyLink" type="button">Копировать</button>
            </div>
          </div>
          <div style="display:flex;justify-content:space-between;gap:.5rem;">
            <button class="btn btn-danger" id="maidEditDeleteBtn" type="button" hidden>Удалить</button>
            <div style="display:flex;gap:.5rem;margin-left:auto;">
              <button class="btn btn-secondary" id="maidEditCancel" type="button">Отмена</button>
              <button class="btn btn-primary" id="maidEditSave" type="button">Сохранить</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  `;
  const wrap = document.createElement('div');
  wrap.innerHTML = html;
  document.body.appendChild(wrap);
}

async function renderMaidsList() {
  const list = document.getElementById('maidsList');
  if (!list) return;
  list.innerHTML = '<div class="small" style="padding:1rem;">Загрузка…</div>';
  const maids = await fetchMaids();
  if (!maids.length) {
    list.innerHTML = '<div class="small" style="padding:1rem;color:var(--color-text-muted);">Горничных пока нет. Нажмите «+ Добавить», чтобы создать первую.</div>';
    return;
  }
  const state = window.__gyState || {};
  const apartments = state.apartments || [];
  const getRid = (a) => a?.externalIds?.realtyCalendarUnitId || a?.realtyId || null;
  const titleByRid = new Map(apartments.filter(a => getRid(a)).map(a => [String(getRid(a)), a.name || `Квартира #${getRid(a)}`]));
  list.innerHTML = maids.map(m => {
    const apts = m.realty_ids.map(rid => titleByRid.get(String(rid)) || `#${rid}`).join(', ') || '<span style="color:var(--color-text-muted);">не закреплено</span>';
    const conn = maidChannel(m);
    const chTitle = CHANNEL_TITLE[m.channel || 'telegram'] || 'Telegram';
    const connBadge = conn
      ? `<span class="pill" style="background:#e6f4ea;color:#137333;">🟢 ${htmlEscape(CHANNEL_TITLE[conn] || conn)}</span>`
      : `<span class="pill" style="background:#fef7e0;color:#8a6d3b;">⏳ Ждёт входа в ${htmlEscape(chTitle)}</span>`;
    return `
      <div class="accordion-card" style="padding:1rem;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.75rem;flex-wrap:wrap;">
          <div style="flex:1;min-width:200px;">
            <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;">
              <strong style="font-size:1.05rem;">${htmlEscape(m.name)}</strong>
              ${connBadge}
              ${m.active ? '' : '<span class="pill" style="background:#fce8e6;color:#c5221f;">Отключена</span>'}
            </div>
            ${m.phone ? `<div class="small" style="margin-top:.2rem;">${htmlEscape(m.phone)}</div>` : ''}
            <div class="small" style="margin-top:.35rem;color:var(--color-text-muted);">Квартиры: ${apts}</div>
          </div>
          <div style="display:flex;gap:.4rem;flex-wrap:wrap;">
            ${conn ? `<button class="btn btn-primary btn-sm" data-maid-chat="${m.id}" type="button">💬 Чат</button>` : ''}
            <button class="btn btn-secondary btn-sm" data-maid-edit="${m.id}" type="button">Редактировать</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function getBotUsername() {
  const state = window.__gyState || {};
  return state.managerSettings?.tg_bot_username || TELEGRAM_BOT_USERNAME_DEFAULT;
}

/** Запасной вариант ссылки для Telegram, если серверный маршрут недоступен. */
function renderInviteLink(token) {
  const uname = getBotUsername();
  return `https://t.me/${uname}?start=maid_${token}`;
}

let _editingMaidId = null;
let _editingMaidToken = null;
let _editingMaidChannel = null;

/** Заполнить выпадающий список мессенджеров доступными каналами. */
async function fillChannelSelect(selectedId) {
  const sel = document.getElementById('maidEditChannel');
  if (!sel) return;
  // Если у горничной выбран канал, который сейчас выключен, всё равно его показываем.
  await fillChannelOptions(sel, selectedId || 'telegram');
  const hint = document.getElementById('maidEditChannelHint');
  if (hint) {
    hint.textContent = sel.options.length > 1
      ? ''
      : 'Пока подключён только Telegram. Другие мессенджеры появятся здесь после настройки токенов на сервере.';
  }
}

/** Обновить поле со ссылкой-приглашением под выбранный мессенджер. */
async function refreshInviteLink() {
  const box = document.getElementById('maidEditInviteBox');
  const input = document.getElementById('maidEditInviteLink');
  const label = document.getElementById('maidEditInviteLabel');
  if (!box || !input) return;
  if (!_editingMaidId) { box.hidden = true; input.value = ''; return; }
  const channel = document.getElementById('maidEditChannel')?.value || 'telegram';
  box.hidden = false;
  if (label) label.textContent = `Ссылка для входа горничной в ${CHANNEL_TITLE[channel] || channel}:`;
  input.value = 'Получаю ссылку…';
  try {
    input.value = await fetchMaidInvite(_editingMaidId, channel);
  } catch (e) {
    if (channel === 'telegram' && _editingMaidToken) {
      input.value = renderInviteLink(_editingMaidToken);
    } else {
      input.value = '';
      const msg = e?.message === 'channel_not_configured'
        ? `${CHANNEL_TITLE[channel] || channel} ещё не настроен на сервере — ссылку выдать нельзя.`
        : `Не удалось получить ссылку: ${e?.message || e}`;
      if (label) label.textContent = msg;
    }
  }
}

function renderMaidEditForm(maid = null) {
  _editingMaidId = maid?.id || null;
  document.getElementById('maidEditTitle').textContent = maid ? `Редактировать: ${maid.name}` : 'Новая горничная';
  document.getElementById('maidEditName').value = maid?.name || '';
  document.getElementById('maidEditPhone').value = maid?.phone || '';
  _editingMaidToken = maid?.invite_token || null;
  _editingMaidChannel = maid?.channel || 'telegram';
  fillChannelSelect(_editingMaidChannel);
  const state = window.__gyState || {};
  const getRid = (a) => a?.externalIds?.realtyCalendarUnitId || a?.realtyId || null;
  const apts = (state.apartments || []).filter(a => getRid(a)).map(a => ({ ...a, _rid: String(getRid(a)) }));
  const selected = new Set((maid?.realty_ids || []).map(String));
  const box = document.getElementById('maidEditApartments');
  if (!apts.length) {
    box.innerHTML = '<div class="small" style="color:var(--color-text-muted);padding:.4rem;">Нет квартир с realty_id. Добавьте realty_id в настройках квартиры.</div>';
  } else {
    box.innerHTML = apts.map(a => `
      <label class="maid-apt-row">
        <input type="checkbox" class="maid-apt-cb" data-maid-apt="${htmlEscape(a._rid)}" ${selected.has(a._rid) ? 'checked' : ''} />
        <span class="maid-apt-name">${htmlEscape(a.name || `Квартира #${a._rid}`)}</span>
        <span class="maid-apt-rid small">#${htmlEscape(a._rid)}</span>
      </label>
    `).join('');
  }
  const inviteBox = document.getElementById('maidEditInviteBox');
  const inviteInput = document.getElementById('maidEditInviteLink');
  if (maid?.id) {
    refreshInviteLink();
  } else {
    inviteBox.hidden = true;
    inviteInput.value = '';
  }
  document.getElementById('maidEditDeleteBtn').hidden = !maid;
}

function getSelectedApartmentsFromForm() {
  // Дедуплицируем: в приложении две квартиры могут иметь один realty_id.
  const ids = Array.from(document.querySelectorAll('#maidEditApartments input[data-maid-apt]:checked'))
    .map(el => el.getAttribute('data-maid-apt'));
  return [...new Set(ids)];
}

async function saveMaidFromForm() {
  const name = document.getElementById('maidEditName').value.trim();
  const phone = document.getElementById('maidEditPhone').value.trim();
  const channel = document.getElementById('maidEditChannel')?.value || 'telegram';
  if (!name) { alert('Укажите имя'); return; }
  const realtyIds = getSelectedApartmentsFromForm();
  setStatus('Сохраняю горничную…');
  try {
    if (_editingMaidId) {
      // При смене мессенджера старая привязка к чату недействительна — горничная войдёт заново.
      const patch = { name, phone: phone || null, channel };
      if (_editingMaidChannel && _editingMaidChannel !== channel) patch.channel_chat_id = null;
      await updateMaid(_editingMaidId, patch);
      _editingMaidChannel = channel;
      await updateMaidApartments(_editingMaidId, realtyIds);
      await refreshInviteLink();
      setStatus('Горничная сохранена');
    } else {
      const maid = await createMaid({ name, phone, channel, realtyIds });
      _editingMaidId = maid.id;
      _editingMaidToken = maid.invite_token || null;
      _editingMaidChannel = channel;
      await refreshInviteLink();
      const delBtn = document.getElementById('maidEditDeleteBtn');
      if (delBtn) delBtn.hidden = false;
      setStatus('Горничная создана. Отправьте ссылку.');
    }
    // Обновление списка — не критично, сетевые ошибки не должны виднеться как «Ошибка сохранения».
    try { await renderMaidsList(); } catch (rerr) { console.warn('[maids] renderMaidsList after save:', rerr?.message || rerr); }
  } catch (e) {
    console.error('[maids] save:', e);
    alert('Ошибка сохранения: ' + (e?.message || e));
    setStatus('Ошибка сохранения');
  }
}

export async function openMaidsModal(state) {
  ensureMaidsModal();
  window.__gyState = state; // для доступа из вспомогательных функций
  openModal('maidsModal');
  await renderMaidsList();
}

// ---------- Bind ----------

// ---------- Чат с горничной ----------

let _openChatMaidId = null;
let _chatChannel = null;

function renderMaidChatMessages(messages, maid) {
  const box = document.getElementById('maidChatBox');
  if (!box) return;
  if (!messages.length) {
    box.innerHTML = '<div class="small" style="color:var(--color-text-muted);padding:1rem;text-align:center;">Пока сообщений нет.</div>';
    return;
  }
  const html = messages.map(m => {
    const mine = m.sender === 'manager' || m.direction === 'out';
    const bubbleCls = mine
      ? 'background:var(--color-accent);color:#000;align-self:flex-end;'
      : 'background:var(--color-surface-3);align-self:flex-start;';
    const photo = m.photo_url ? `<img src="${m.photo_url}" alt="" style="max-width:220px;border-radius:.5rem;margin-bottom:.3rem;display:block;" />` : '';
    const text = m.text ? htmlEscape(m.text).replaceAll('\n', '<br>') : '';
    return `<div style="max-width:75%;padding:.5rem .75rem;border-radius:.75rem;${bubbleCls}">${photo}${text}<div class="small" style="opacity:.65;margin-top:.2rem;font-size:.7rem;">${fmtDate(m.created_at)}</div></div>`;
  }).join('');
  box.innerHTML = html;
  box.scrollTop = box.scrollHeight;
}

async function openMaidChatModal(maidId) {
  _openChatMaidId = maidId;
  const sb = supabase();
  const { data: maid } = await sb.from('maids').select('id, name, tg_chat_id').eq('id', maidId).maybeSingle();
  document.getElementById('maidChatTitle').textContent = maid ? `Чат: ${maid.name}` : 'Чат с горничной';
  const input = document.getElementById('maidChatInput');
  const sendBtn = document.getElementById('maidChatSend');
  const disabled = !maid?.tg_chat_id;
  if (input) { input.value = ''; input.disabled = disabled; input.placeholder = disabled ? 'Горничная ещё не подключена к боту' : 'Напишите сообщение…'; }
  if (sendBtn) sendBtn.disabled = disabled;
  openModal('maidChatModal');
  const messages = await fetchMaidMessages(maidId, 200);
  renderMaidChatMessages(messages, maid);

  // Realtime
  try {
    if (_chatChannel) { await sb.removeChannel(_chatChannel); _chatChannel = null; }
    _chatChannel = sb
      .channel(`maid_chat_${maidId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'maid_messages', filter: `maid_id=eq.${maidId}` }, async () => {
        if (_openChatMaidId !== maidId) return;
        const msgs = await fetchMaidMessages(maidId, 200);
        renderMaidChatMessages(msgs, maid);
      })
      .subscribe();
  } catch (err) { console.warn('[maids] realtime chat:', err?.message || err); }
}

async function closeMaidChatModal() {
  _openChatMaidId = null;
  if (_chatChannel) {
    try { await supabase().removeChannel(_chatChannel); } catch {}
    _chatChannel = null;
  }
  closeModal('maidChatModal');
}

async function sendMaidChatFromInput() {
  if (!_openChatMaidId) return;
  const input = document.getElementById('maidChatInput');
  const text = (input?.value || '').trim();
  if (!text) return;
  const btn = document.getElementById('maidChatSend');
  if (btn) btn.disabled = true;
  try {
    await sendManagerMessageToMaid(_openChatMaidId, text);
    if (input) input.value = '';
  } catch (err) {
    alert('Не удалось отправить: ' + (err?.message || err));
  } finally {
    if (btn) btn.disabled = false;
    if (input) input.focus();
  }
}

export function bindMaidsEvents(state) {
  window.__gyState = state;
  ensureMaidsModal();

  document.getElementById('openMaidsModal')?.addEventListener('click', async () => {
    document.getElementById('drawerMenu')?.classList.remove('open');
    document.getElementById('drawerBackdrop')?.classList.remove('open');
    await openMaidsModal(state);
  });

  // Смена мессенджера в форме горничной — перевыпускаем ссылку-приглашение.
  document.body.addEventListener('change', async (e) => {
    if (e.target?.id === 'maidEditChannel') await refreshInviteLink();
  });

  document.body.addEventListener('click', async (e) => {
    if (e.target.closest('#closeMaidsModal')) {
      closeModal('maidsModal');
      return;
    }
    const chatBtn = e.target.closest('[data-maid-chat]');
    if (chatBtn) {
      const id = chatBtn.getAttribute('data-maid-chat');
      await openMaidChatModal(id);
      return;
    }
    if (e.target.closest('#closeMaidChatModal')) {
      closeMaidChatModal();
      return;
    }
    if (e.target.closest('#maidChatSend')) {
      await sendMaidChatFromInput();
      return;
    }
    if (e.target.closest('#maidsAddBtn')) {
      renderMaidEditForm(null);
      openModal('maidEditModal');
      return;
    }
    const editBtn = e.target.closest('[data-maid-edit]');
    if (editBtn) {
      const id = editBtn.getAttribute('data-maid-edit');
      const maids = await fetchMaids();
      const maid = maids.find(m => m.id === id);
      if (maid) {
        renderMaidEditForm(maid);
        openModal('maidEditModal');
      }
      return;
    }
    if (e.target.closest('#closeMaidEditModal') || e.target.closest('#maidEditCancel')) {
      closeModal('maidEditModal');
      return;
    }
    if (e.target.closest('#maidEditSave')) {
      await saveMaidFromForm();
      return;
    }
    if (e.target.closest('#maidEditCopyLink')) {
      const inp = document.getElementById('maidEditInviteLink');
      if (!inp.value) return;
      inp.select();
      try {
        await navigator.clipboard.writeText(inp.value);
        setStatus('Ссылка скопирована');
      } catch { document.execCommand('copy'); }
      return;
    }
    if (e.target.closest('#maidEditDeleteBtn')) {
      if (!_editingMaidId) return;
      if (!confirm('Удалить горничную? Все её сообщения также будут удалены.')) return;
      try {
        await deleteMaid(_editingMaidId);
        closeModal('maidEditModal');
        await renderMaidsList();
        setStatus('Горничная удалена');
      } catch (err) {
        alert('Ошибка удаления: ' + (err?.message || err));
      }
      return;
    }
  });

  document.body.addEventListener('keydown', (e) => {
    if (e.target?.id === 'maidChatInput' && e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMaidChatFromInput();
    }
  });
}
