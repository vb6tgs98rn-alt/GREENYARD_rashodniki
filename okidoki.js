// okidoki.js — интеграция с сервисом OkiDoki (электронные договоры аренды).
// Все запросы идут через Edge Function okidoki-proxy — api_key на клиенте не хранится.

import { getSupabaseClient } from './supabase-client.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { openModal, closeModal, setStatus } from './render.js';
import { getState } from './state.js';

// Логические поля Green Yard, которые можно связать с keyword'ами в шаблоне Okidoki.
export const LOGICAL_FIELDS = [
  { key: 'begin_date',            label: 'Дата заезда' },
  { key: 'end_date',              label: 'Дата выезда' },
  { key: 'nights',                label: 'Количество суток' },
  { key: 'price_per_night',       label: 'Цена в сутки' },
  { key: 'price_total',           label: 'Полная стоимость' },
  { key: 'prepaid',               label: 'Оплачено (предоплата)' },
  { key: 'remaining',             label: 'Осталось доплатить' },
  { key: 'deposit',               label: 'Обеспечительный платёж' },
  { key: 'apartment_title',       label: 'Название квартиры' },
  { key: 'apartment_address',     label: 'Адрес квартиры' },
  { key: 'apartment_description', label: 'Описание квартиры' },
];

// Читаем access_token напрямую из localStorage — так же, как в чатах (из-за iOS Safari).
function readTokenFromStorage() {
  try {
    const raw = localStorage.getItem('gy-auth-session');
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s?.currentSession?.access_token || s?.access_token || null;
  } catch { return null; }
}

async function getAccessToken() {
  const t1 = readTokenFromStorage();
  if (t1) return t1;
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || null;
  } catch { return null; }
}

// Вызов okidoki-proxy с JWT
async function callProxy(action, payload = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error('не авторизованы (войдите в аккаунт через email)');
  const res = await fetch(`${SUPABASE_URL}/functions/v1/okidoki-proxy`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action, ...payload }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

export async function validateApiKey(api_key)       { return callProxy('validate', { api_key }); }
export async function listTemplates()                { return callProxy('list_templates'); }
export async function listSignerCards()              { return callProxy('list_signer_cards'); }
export async function createContract(booking_id, e={}) { return callProxy('create_contract', { booking_id, ...e }); }
export async function listContracts(booking_id)      { return callProxy('list_contracts', { booking_id }); }

export async function listApartmentTemplates()  { return callProxy('list_apartment_templates'); }
export async function saveApartmentTemplate(p)  { return callProxy('save_apartment_template', p); }
export async function deleteApartmentTemplate(realty_id) { return callProxy('delete_apartment_template', { realty_id }); }

// Достаём user_id из JWT (decode payload) — без сетевого вызова.
function getUidFromToken(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
    return payload?.sub || null;
  } catch { return null; }
}

async function requireAuth() {
  const token = await getAccessToken();
  if (!token) throw new Error('не авторизованы (войдите в аккаунт через email)');
  const uid = getUidFromToken(token);
  if (!uid) throw new Error('не удалось прочитать user_id из сессии');
  return { token, uid };
}

// Прямой доступ к настройкам пользователя (для UI формы)
export async function loadSettings() {
  const { uid } = await requireAuth();
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('manager_settings')
    .select('okidoki_api_key, okidoki_signer_card_id, okidoki_auto_send, okidoki_verified_at, okidoki_field_mapping')
    .eq('user_id', uid)
    .maybeSingle();
  if (error) throw error;
  return data || {};
}
export async function saveSettings(patch) {
  const { uid } = await requireAuth();
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('manager_settings').upsert({
    user_id: uid,
    ...patch,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (error) throw error;
}

// ────────────────────────────────────────────────────────────────────────
// UI: модалка «Договоры (Okidoki)»
// ────────────────────────────────────────────────────────────────────────

function esc(s) { return String(s ?? '').replace(/[<>&"']/g, c => ({ '<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&#39;' }[c])); }

function ensureModal() {
  if (document.getElementById('okidokiModal')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="modal-backdrop" id="okidokiModal" aria-hidden="true">
      <div class="modal" style="width:min(760px,100%);max-height:92dvh;overflow-y:auto;padding:1rem;">
        <div class="section-head">
          <div>
            <h2 class="modal-title">Договоры (Okidoki)</h2>
            <p class="muted" style="margin:0;">Автоматическое создание договоров при первом заходе гостя в бота. Шаблон задаётся отдельно для каждой квартиры.</p>
          </div>
          <button class="menu-toggle" id="okidokiClose" aria-label="Закрыть">✕</button>
        </div>

        <div style="margin-top:1rem;">
          <label>
            <span class="small">API-ключ Okidoki</span>
            <div style="display:flex;gap:.5rem;margin-top:.4rem;">
              <input id="okidokiKey" type="password" autocomplete="off" placeholder="Вставьте api_key из настроек Okidoki" style="flex:1;" />
              <button class="btn btn-secondary" id="okidokiKeyToggle" type="button">👁</button>
              <button class="btn btn-primary" id="okidokiValidate" type="button">Проверить</button>
            </div>
            <div id="okidokiKeyStatus" class="small" style="margin-top:.4rem;opacity:.8;"></div>
          </label>
        </div>

        <div id="okidokiConfig" style="margin-top:1rem;display:none;">
          <label style="display:block;margin-bottom:.75rem;">
            <span class="small">Карточка подписанта (от чьего имени)</span>
            <select id="okidokiSigner" style="margin-top:.4rem;width:100%;"></select>
          </label>

          <label class="gy-toggle" style="margin-top:.75rem;">
            <input id="okidokiAutoSend" type="checkbox" />
            <span class="gy-toggle-track" aria-hidden="true"><span class="gy-toggle-thumb"></span></span>
            <span class="gy-toggle-label">Автоматически отправлять ссылку на договор гостю при первом заходе в бот</span>
          </label>

          <div class="subsection-title" style="margin-top:1.5rem;margin-bottom:.5rem;">
            <h3 style="margin:0;">Шаблоны по квартирам</h3>
            <span class="small">Выберите квартиру и привяжите к ней шаблон Okidoki.</span>
          </div>
          <div style="display:flex;gap:.5rem;align-items:center;">
            <select id="okidokiAptPicker" style="flex:1;">
              <option value="">— выберите квартиру —</option>
            </select>
            <button class="btn btn-primary" id="okidokiAptConfigure" type="button" disabled>Настроить</button>
          </div>
          <div id="okidokiAptCurrent" class="small" style="margin-top:.5rem;opacity:.85;"></div>

          <div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:1.5rem;">
            <button class="btn btn-secondary" id="okidokiDisconnect" type="button">Отключить</button>
            <button class="btn btn-primary" id="okidokiSave" type="button">Сохранить общие настройки</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Дочерняя модалка привязки шаблона к квартире -->
    <div class="modal-backdrop" id="okidokiAptModal" aria-hidden="true" style="z-index:40;">
      <div class="modal" style="width:min(640px,100%);max-height:92dvh;overflow-y:auto;padding:1rem;">
        <div class="section-head">
          <div>
            <h2 class="modal-title" id="okidokiAptTitle">Шаблон для квартиры</h2>
            <p class="muted" id="okidokiAptSubtitle" style="margin:0;"></p>
          </div>
          <button class="menu-toggle" id="okidokiAptClose" aria-label="Закрыть">✕</button>
        </div>

        <label style="display:block;margin-top:1rem;margin-bottom:.75rem;">
          <span class="small">Шаблон договора для этой квартиры</span>
          <select id="okidokiAptTemplate" style="margin-top:.4rem;width:100%;"></select>
        </label>

        <div class="small" style="margin-top:.5rem;opacity:.7;">
          Сопоставление keyword'ов берётся из общих настроек Okidoki. Здесь настраивается только выбор шаблона.
        </div>

        <div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:1.5rem;">
          <button class="btn btn-secondary" id="okidokiAptDelete" type="button">Удалить привязку</button>
          <button class="btn btn-primary" id="okidokiAptSave" type="button">Сохранить</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(wrap.children[0]);
  document.body.appendChild(wrap.children[0]);
}

let cachedTemplates = null;
let cachedCards = null;

async function loadTemplatesAndCards(force = false) {
  if (!force && cachedTemplates && cachedCards) return { templates: cachedTemplates, cards: cachedCards };
  const [tplData, cardData] = await Promise.all([listTemplates(), listSignerCards()]);
  cachedTemplates = tplData?.templates || [];
  cachedCards = cardData?.additional_user_cards || [];
  return { templates: cachedTemplates, cards: cachedCards };
}

async function refreshSignerSelect(currentSignerId) {
  const signSel = document.getElementById('okidokiSigner');
  signSel.innerHTML = '<option>Загружаем карточки…</option>';
  try {
    const { cards } = await loadTemplatesAndCards();
    signSel.innerHTML = `<option value="">Основная карточка профиля</option>` + cards.map(c => {
      const id = c?._id?.$oid || c?._id || '';
      const name = [c.last_name, c.first_name, c.middle_name].filter(Boolean).join(' ') || c.law_name || id;
      return `<option value="${esc(id)}" ${id === currentSignerId ? 'selected' : ''}>${esc(name)}</option>`;
    }).join('');
  } catch (err) {
    signSel.innerHTML = `<option>Ошибка: ${esc(err.message)}</option>`;
  }
}

// ─── Список квартир с их привязками ─────────────────────────────────────
// Собирает список квартир (с любыми externalIds или без них), возвращает только те, что связаны с RC.
function getRcApartments() {
  const st = getState();
  return (st?.apartments || [])
    .map(a => ({
      realty_id: String(a?.externalIds?.realtyCalendarUnitId || '').trim(),
      name: (a?.name || a?.title || '').trim(),
    }))
    .filter(a => a.realty_id);
}

async function renderApartmentPicker() {
  const sel = document.getElementById('okidokiAptPicker');
  const btn = document.getElementById('okidokiAptConfigure');
  const cur = document.getElementById('okidokiAptCurrent');
  if (!sel) return;

  const apartments = getRcApartments();
  if (!apartments.length) {
    sel.innerHTML = '<option value="">— нет квартир, связанных с RealtyCalendar —</option>';
    btn.disabled = true;
    cur.innerHTML = '<span style="opacity:.75;">Сначала синхронизируйте квартиры с RC через «Управление» → «Синхронизация квартир».</span>';
    return;
  }

  // Подгружаем привязки и шаблоны (для индикатора в опциях)
  let bindings = [];
  try { bindings = (await listApartmentTemplates())?.items || []; } catch {}
  const byRealty = new Map(bindings.map(b => [String(b.realty_id), b]));
  const templates = cachedTemplates || [];
  const tplNameById = new Map(templates.map(t => [t.template_id, t.template_full_name || t.template_name]));

  sel.innerHTML = '<option value="">— выберите квартиру —</option>' +
    apartments.map((a, i) => {
      const bound = byRealty.has(a.realty_id);
      const nameLabel = a.name || `Квартира ${i + 1}`;
      const marker = bound ? '✓ ' : '⚠ ';
      return `<option value="${esc(a.realty_id)}" data-name="${esc(nameLabel)}">${marker}${esc(nameLabel)}</option>`;
    }).join('');

  const updateCur = () => {
    const rid = sel.value;
    btn.disabled = !rid;
    if (!rid) { cur.innerHTML = ''; return; }
    const b = byRealty.get(rid);
    if (!b) {
      cur.innerHTML = `<span style="color:#c88;">⚠ Шаблон не выбран.</span>`;
    } else {
      const nm = tplNameById.get(b.okidoki_template_id) || b.okidoki_template_id;
      cur.innerHTML = `<span style="color:#7fbf7f;">✓ Шаблон: <b>${esc(nm)}</b></span>`;
    }
  };
  updateCur();

  // Навешиваем обработчики только один раз (через dataset-флаг)
  if (!sel.dataset.bound) {
    sel.dataset.bound = '1';
    sel.addEventListener('change', updateCur);
  }
  if (!btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', () => {
      const rid = sel.value;
      console.log('[okidoki] configure click, rid=', rid);
      if (!rid) return;
      const opt = sel.options[sel.selectedIndex];
      const name = opt?.dataset?.name || '';
      openApartmentTemplateModal(rid, name);
    });
  }
}

async function openApartmentTemplateModal(realtyId, apartmentName) {
  const modal = document.getElementById('okidokiAptModal');
  const titleEl = document.getElementById('okidokiAptTitle');
  const subEl   = document.getElementById('okidokiAptSubtitle');
  const tplSel  = document.getElementById('okidokiAptTemplate');
  const saveBtn = document.getElementById('okidokiAptSave');
  const delBtn  = document.getElementById('okidokiAptDelete');
  const closeBtn = document.getElementById('okidokiAptClose');

  titleEl.textContent = `Шаблон: ${apartmentName}`;
  subEl.textContent = `realty_id = ${realtyId}`;

  // Достаём текущую привязку
  let current = null;
  try {
    const r = await listApartmentTemplates();
    current = (r?.items || []).find(x => String(x.realty_id) === String(realtyId)) || null;
  } catch (e) {
    setStatus('Ошибка загрузки: ' + e.message, 'error');
  }

  // Шаблоны
  tplSel.innerHTML = '<option>Загружаем…</option>';
  try {
    const { templates } = await loadTemplatesAndCards();
    tplSel.innerHTML = '<option value="">— не выбрано —</option>' + templates.map(t =>
      `<option value="${esc(t.template_id)}" ${t.template_id === current?.okidoki_template_id ? 'selected' : ''}>${esc(t.template_full_name || t.template_name)}</option>`
    ).join('');
  } catch (e) {
    tplSel.innerHTML = `<option>Ошибка: ${esc(e.message)}</option>`;
  }

  delBtn.style.display = current ? 'inline-flex' : 'none';

  openModal('okidokiAptModal');

  const close = () => closeModal('okidokiAptModal');

  // Reset handlers (навешиваем каждый раз, но снимаем через cloneNode)
  const rebind = (el, fn) => {
    const c = el.cloneNode(true);
    el.parentNode.replaceChild(c, el);
    c.addEventListener('click', fn);
    return c;
  };

  rebind(closeBtn, close);
  rebind(saveBtn, async () => {
    const template_id = document.getElementById('okidokiAptTemplate').value;
    if (!template_id) { setStatus('Выберите шаблон', 'error'); return; }
    try {
      await saveApartmentTemplate({
        realty_id: Number(realtyId),
        apartment_name: apartmentName,
        okidoki_template_id: template_id,
        field_mapping: {},
      });
      setStatus('Шаблон квартиры сохранён', 'success');
      close();
      await renderApartmentPicker();
    } catch (e) {
      setStatus('Ошибка сохранения: ' + e.message, 'error');
    }
  });
  rebind(delBtn, async () => {
    if (!confirm(`Удалить привязку шаблона для квартиры «${apartmentName}»?`)) return;
    try {
      await deleteApartmentTemplate(Number(realtyId));
      setStatus('Привязка удалена', 'success');
      close();
      await renderApartmentPicker();
    } catch (e) {
      setStatus('Ошибка: ' + e.message, 'error');
    }
  });
}

export async function openOkidokiSettings() {
  ensureModal();
  const modal = document.getElementById('okidokiModal');
  const keyInput   = document.getElementById('okidokiKey');
  const keyToggle  = document.getElementById('okidokiKeyToggle');
  const keyStatus  = document.getElementById('okidokiKeyStatus');
  const validateBtn = document.getElementById('okidokiValidate');
  const closeBtn   = document.getElementById('okidokiClose');
  const config     = document.getElementById('okidokiConfig');
  const autoSend   = document.getElementById('okidokiAutoSend');
  const saveBtn    = document.getElementById('okidokiSave');
  const disconnectBtn = document.getElementById('okidokiDisconnect');

  // Сбрасываем кэш и сразу открываем модалку (без ожидания сети)
  cachedTemplates = null; cachedCards = null;
  keyStatus.textContent = 'Загружаем…';
  keyStatus.style.color = '';
  openModal('okidokiModal');

  // Загружаем текущие настройки асинхронно
  let settings = {};
  try { settings = await loadSettings(); } catch (err) { keyStatus.textContent = 'Ошибка загрузки: ' + err.message; keyStatus.style.color = '#c66'; }

  keyInput.value = settings.okidoki_api_key || '';
  autoSend.checked = !!settings.okidoki_auto_send;

  if (settings.okidoki_api_key) {
    config.style.display = 'block';
    keyStatus.textContent = settings.okidoki_verified_at
      ? `✓ Ключ сохранён (проверен ${new Date(settings.okidoki_verified_at).toLocaleString('ru-RU')})`
      : '✓ Ключ сохранён';
    keyStatus.style.color = '#7fbf7f';
    refreshSignerSelect(settings.okidoki_signer_card_id).catch(() => {});
    renderApartmentPicker().catch(() => {});
  } else {
    keyStatus.textContent = '';
  }

  // Handlers (только один раз)
  if (!modal.dataset.bound) {
    modal.dataset.bound = '1';

    closeBtn.addEventListener('click', () => closeModal('okidokiModal'));

    keyToggle.addEventListener('click', () => {
      keyInput.type = keyInput.type === 'password' ? 'text' : 'password';
    });

    validateBtn.addEventListener('click', async () => {
      const k = keyInput.value.trim();
      if (!k) { keyStatus.textContent = 'Введите ключ'; keyStatus.style.color = '#c66'; return; }
      keyStatus.textContent = 'Проверяем…'; keyStatus.style.color = '';
      try {
        const r = await validateApiKey(k);
        if (r?.valid) {
          keyStatus.textContent = `✓ Ключ работает (oki user_id: ${r.oki_user_id})`;
          keyStatus.style.color = '#7fbf7f';
          await saveSettings({ okidoki_api_key: k, okidoki_verified_at: new Date().toISOString() });
          config.style.display = 'block';
          cachedTemplates = null; cachedCards = null;
          await refreshSignerSelect(settings.okidoki_signer_card_id);
          await renderApartmentPicker();
        } else {
          keyStatus.textContent = `⚠ Ключ не работает (${r?.status || 'error'}): ${JSON.stringify(r?.data || '')}`;
          keyStatus.style.color = '#c66';
        }
      } catch (err) {
        keyStatus.textContent = '⚠ ' + err.message;
        keyStatus.style.color = '#c66';
      }
    });

    saveBtn.addEventListener('click', async () => {
      const signSel = document.getElementById('okidokiSigner');
      try {
        await saveSettings({
          okidoki_signer_card_id: signSel.value || null,
          okidoki_auto_send: autoSend.checked,
        });
        setStatus('Общие настройки Okidoki сохранены', 'success');
      } catch (err) {
        setStatus('Ошибка сохранения: ' + err.message, 'error');
      }
    });

    disconnectBtn.addEventListener('click', async () => {
      if (!confirm('Отключить интеграцию с Okidoki? API-ключ будет удалён.')) return;
      try {
        await saveSettings({
          okidoki_api_key: null, okidoki_signer_card_id: null,
          okidoki_auto_send: false, okidoki_verified_at: null,
          okidoki_field_mapping: {},
        });
        setStatus('Интеграция отключена', 'success');
        closeModal('okidokiModal');
      } catch (err) {
        setStatus('Ошибка: ' + err.message, 'error');
      }
    });
  }
}
