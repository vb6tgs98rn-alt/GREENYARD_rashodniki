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

import { getSupabaseClient, waitForAuthReady} from './supabase-client.js';
import { openModal, closeModal, setStatus } from './render.js';
import { BOT_FUNCTION_URL, TELEGRAM_BOT_USERNAME_DEFAULT } from './guestBot.js';

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
  await waitForAuthReady();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) return [];
  const { data: maids, error } = await sb
    .from('maids')
    .select('id, name, phone, tg_chat_id, invite_token, active, created_at')
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

async function createMaid({ name, phone, realtyIds }) {
  const sb = supabase();
  await waitForAuthReady();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error('unauthorized');
  const token = randomToken(20);
  const { data: maid, error } = await sb
    .from('maids')
    .insert({
      user_id: user.id,
      name: name.trim(),
      phone: (phone || '').trim() || null,
      invite_token: token,
      active: true,
    })
    .select('id, invite_token, name')
    .single();
  if (error) throw error;
  if (realtyIds?.length) {
    const rows = realtyIds.map(rid => ({
      maid_id: maid.id,
      user_id: user.id,
      realty_id: Number(rid),
    }));
    const { error: e2 } = await sb.from('maid_apartments').insert(rows);
    if (e2) {
      console.error('[maids] link error:', e2);
      throw new Error('Не удалось закрепить квартиры: ' + (e2.message || e2.code || 'unknown'));
    }
  }
  return maid;
}

async function updateMaidApartments(maidId, realtyIds) {
  const sb = supabase();
  await waitForAuthReady();
  const { data: { user } } = await sb.auth.getUser();
  if (!user) throw new Error('unauthorized');
  const { error: eDel } = await sb.from('maid_apartments').delete().eq('maid_id', maidId);
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
    const { error: eIns } = await sb.from('maid_apartments').insert(rows);
    if (eIns) {
      console.error('[maids] insert links error:', eIns);
      throw new Error('Не удалось сохранить квартиры: ' + (eIns.message || 'unknown'));
    }
  }
}

async function updateMaid(maidId, patch) {
  const sb = supabase();
  const { error } = await sb.from('maids').update(patch).eq('id', maidId);
  if (error) throw error;
}

async function deleteMaid(maidId) {
  const sb = supabase();
  const { error } = await sb.from('maids').delete().eq('id', maidId);
  if (error) throw error;
}

export async function fetchMaidChats() {
  const sb = supabase();
  await waitForAuthReady();
  const { data: { user } } = await sb.auth.getUser();
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
          <div>
            <div class="small" style="margin-bottom:.35rem;">Квартиры, за которыми закреплена горничная</div>
            <div id="maidEditApartments" style="display:grid;gap:.4rem;max-height:260px;overflow-y:auto;overflow-x:hidden;padding:.5rem;border:1px solid rgba(60,60,60,.15);border-radius:.75rem;"></div>
          </div>
          <div id="maidEditInviteBox" hidden style="padding:.75rem;background:var(--color-surface-2);border-radius:.75rem;">
            <div class="small" style="margin-bottom:.35rem;">Ссылка для входа горничной в Telegram-бот:</div>
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
    const connBadge = m.tg_chat_id
      ? '<span class="pill" style="background:#e6f4ea;color:#137333;">🟢 Подключена</span>'
      : '<span class="pill" style="background:#fef7e0;color:#8a6d3b;">⏳ Ожидает входа</span>';
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
            ${m.tg_chat_id ? `<button class="btn btn-primary btn-sm" data-maid-chat="${m.id}" type="button">💬 Чат</button>` : ''}
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

function renderInviteLink(token) {
  const uname = getBotUsername();
  return `https://t.me/${uname}?start=maid_${token}`;
}

let _editingMaidId = null;

function renderMaidEditForm(maid = null) {
  _editingMaidId = maid?.id || null;
  document.getElementById('maidEditTitle').textContent = maid ? `Редактировать: ${maid.name}` : 'Новая горничная';
  document.getElementById('maidEditName').value = maid?.name || '';
  document.getElementById('maidEditPhone').value = maid?.phone || '';
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
  if (maid?.invite_token) {
    inviteBox.hidden = false;
    inviteInput.value = renderInviteLink(maid.invite_token);
  } else {
    inviteBox.hidden = true;
    inviteInput.value = '';
  }
  document.getElementById('maidEditDeleteBtn').hidden = !maid;
}

function getSelectedApartmentsFromForm() {
  return Array.from(document.querySelectorAll('#maidEditApartments input[data-maid-apt]:checked'))
    .map(el => el.getAttribute('data-maid-apt'));
}

async function saveMaidFromForm() {
  const name = document.getElementById('maidEditName').value.trim();
  const phone = document.getElementById('maidEditPhone').value.trim();
  if (!name) { alert('Укажите имя'); return; }
  const realtyIds = getSelectedApartmentsFromForm();
  setStatus('Сохраняю горничную…');
  try {
    if (_editingMaidId) {
      await updateMaid(_editingMaidId, { name, phone: phone || null });
      await updateMaidApartments(_editingMaidId, realtyIds);
      setStatus('Горничная сохранена');
    } else {
      const maid = await createMaid({ name, phone, realtyIds });
      _editingMaidId = maid.id;
      // Показать инвайт
      const inviteBox = document.getElementById('maidEditInviteBox');
      const inviteInput = document.getElementById('maidEditInviteLink');
      inviteBox.hidden = false;
      inviteInput.value = renderInviteLink(maid.invite_token);
      document.getElementById('maidEditDeleteBtn').hidden = false;
      setStatus('Горничная создана. Отправьте ссылку.');
    }
    await renderMaidsList();
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

export function bindMaidsEvents(state) {
  window.__gyState = state;
  ensureMaidsModal();

  document.getElementById('openMaidsModal')?.addEventListener('click', async () => {
    document.getElementById('drawerMenu')?.classList.remove('open');
    document.getElementById('drawerBackdrop')?.classList.remove('open');
    await openMaidsModal(state);
  });

  document.body.addEventListener('click', async (e) => {
    if (e.target.closest('#closeMaidsModal')) {
      closeModal('maidsModal');
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
