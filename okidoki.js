// okidoki.js — интеграция с сервисом OkiDoki (электронные договоры аренды).
// Все запросы идут через Edge Function okidoki-proxy — api_key на клиенте не хранится.

import { getSupabaseClient } from './supabase-client.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { openModal, closeModal, setStatus } from './render.js';

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
    // supabase-js v2 хранит в виде { currentSession: {...} } или прямо {access_token}
    return s?.currentSession?.access_token || s?.access_token || null;
  } catch { return null; }
}

async function getAccessToken() {
  // 1) прямо из localStorage (быстро, надёжно)
  const t1 = readTokenFromStorage();
  if (t1) return t1;
  // 2) fallback — через SDK
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

export async function validateApiKey(api_key) {
  return callProxy('validate', { api_key });
}
export async function listTemplates() {
  return callProxy('list_templates');
}
export async function listSignerCards() {
  return callProxy('list_signer_cards');
}
export async function createContract(booking_id, extras = {}) {
  return callProxy('create_contract', { booking_id, ...extras });
}
export async function listContracts(booking_id) {
  return callProxy('list_contracts', { booking_id });
}

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
    .select('okidoki_api_key, okidoki_template_id, okidoki_signer_card_id, okidoki_field_mapping, okidoki_auto_send, okidoki_verified_at')
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
      <div class="modal" style="width:min(720px,100%);max-height:92dvh;overflow-y:auto;padding:1rem;">
        <div class="section-head">
          <div>
            <h2 class="modal-title">Договоры (Okidoki)</h2>
            <p class="muted" style="margin:0;">Автоматическое создание договоров при новых бронях. Данные из RealtyCalendar.</p>
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
            <span class="small">Шаблон договора</span>
            <select id="okidokiTemplate" style="margin-top:.4rem;width:100%;"></select>
          </label>

          <label style="display:block;margin-bottom:.75rem;">
            <span class="small">Карточка подписанта (от чьего имени)</span>
            <select id="okidokiSigner" style="margin-top:.4rem;width:100%;"></select>
          </label>

          <div style="margin-top:1rem;">
            <div class="subsection-title" style="margin-bottom:.5rem;">
              <h3 style="margin:0;">Сопоставление полей</h3>
              <span class="small">Введите keyword из вашего шаблона Okidoki</span>
            </div>
            <div class="small" style="margin-bottom:.5rem;opacity:.7;">
              Слева — данные из брони RealtyCalendar. Справа впишите точное название поля (keyword),
              как оно называется в вашем шаблоне договора. Оставьте пустым, если поле не используется.
            </div>
            <div id="okidokiMapping" style="display:grid;gap:.5rem;"></div>
          </div>

          <label style="display:flex;align-items:center;gap:.5rem;margin-top:1rem;cursor:pointer;">
            <input id="okidokiAutoSend" type="checkbox" />
            <span>Автоматически создавать договор при новой брони и слать ссылку гостю в Telegram</span>
          </label>

          <div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:1.5rem;">
            <button class="btn btn-secondary" id="okidokiDisconnect" type="button">Отключить</button>
            <button class="btn btn-primary" id="okidokiSave" type="button">Сохранить</button>
          </div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(wrap.firstElementChild);
}

function renderMappingRows(container, mapping = {}) {
  container.innerHTML = LOGICAL_FIELDS.map(f => `
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;align-items:center;">
      <div class="small" style="opacity:.85;">${esc(f.label)}</div>
      <input type="text" data-mapping-key="${esc(f.key)}" placeholder="keyword в шаблоне" value="${esc(mapping[f.key] || '')}" />
    </div>
  `).join('');
}

async function refreshTemplateAndSigner(currentTemplateId, currentSignerId) {
  const tplSel = document.getElementById('okidokiTemplate');
  const signSel = document.getElementById('okidokiSigner');
  tplSel.innerHTML = '<option>Загружаем шаблоны…</option>';
  signSel.innerHTML = '<option>Загружаем карточки…</option>';
  try {
    const [tplData, cardData] = await Promise.all([listTemplates(), listSignerCards()]);
    const tpls = tplData?.templates || [];
    tplSel.innerHTML = tpls.map(t =>
      `<option value="${esc(t.template_id)}" ${t.template_id === currentTemplateId ? 'selected' : ''}>${esc(t.template_full_name || t.template_name)}</option>`
    ).join('') || '<option value="">— шаблонов нет —</option>';

    const cards = cardData?.additional_user_cards || [];
    signSel.innerHTML = `<option value="">Основная карточка профиля</option>` + cards.map(c => {
      const id = c?._id?.$oid || c?._id || '';
      const name = [c.last_name, c.first_name, c.middle_name].filter(Boolean).join(' ') || c.law_name || id;
      return `<option value="${esc(id)}" ${id === currentSignerId ? 'selected' : ''}>${esc(name)}</option>`;
    }).join('');
  } catch (err) {
    tplSel.innerHTML = `<option>Ошибка: ${esc(err.message)}</option>`;
    signSel.innerHTML = '';
  }
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
  const mapCont    = document.getElementById('okidokiMapping');
  const autoSend   = document.getElementById('okidokiAutoSend');
  const saveBtn    = document.getElementById('okidokiSave');
  const disconnectBtn = document.getElementById('okidokiDisconnect');

  // Загружаем текущие настройки
  let settings = {};
  try { settings = await loadSettings(); } catch (err) { keyStatus.textContent = 'Ошибка загрузки: ' + err.message; }

  keyInput.value = settings.okidoki_api_key || '';
  autoSend.checked = !!settings.okidoki_auto_send;
  renderMappingRows(mapCont, settings.okidoki_field_mapping || {});

  if (settings.okidoki_api_key) {
    config.style.display = 'block';
    keyStatus.textContent = settings.okidoki_verified_at
      ? `✓ Ключ сохранён (проверен ${new Date(settings.okidoki_verified_at).toLocaleString('ru-RU')})`
      : '✓ Ключ сохранён';
    keyStatus.style.color = '#7fbf7f';
    await refreshTemplateAndSigner(settings.okidoki_template_id, settings.okidoki_signer_card_id);
  }

  openModal('okidokiModal');

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
          // Сохраняем ключ сразу — чтобы дальше можно было тянуть шаблоны
          await saveSettings({ okidoki_api_key: k, okidoki_verified_at: new Date().toISOString() });
          config.style.display = 'block';
          await refreshTemplateAndSigner(settings.okidoki_template_id, settings.okidoki_signer_card_id);
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
      const tplSel = document.getElementById('okidokiTemplate');
      const signSel = document.getElementById('okidokiSigner');
      const mapping = {};
      mapCont.querySelectorAll('input[data-mapping-key]').forEach(inp => {
        const k = inp.dataset.mappingKey;
        const v = inp.value.trim();
        if (v) mapping[k] = v;
      });
      try {
        await saveSettings({
          okidoki_template_id: tplSel.value || null,
          okidoki_signer_card_id: signSel.value || null,
          okidoki_field_mapping: mapping,
          okidoki_auto_send: autoSend.checked,
        });
        setStatus('Настройки Okidoki сохранены', 'success');
        closeModal('okidokiModal');
      } catch (err) {
        setStatus('Ошибка сохранения: ' + err.message, 'error');
      }
    });

    disconnectBtn.addEventListener('click', async () => {
      if (!confirm('Отключить интеграцию с Okidoki? API-ключ будет удалён.')) return;
      try {
        await saveSettings({
          okidoki_api_key: null, okidoki_template_id: null, okidoki_signer_card_id: null,
          okidoki_field_mapping: {}, okidoki_auto_send: false, okidoki_verified_at: null,
        });
        setStatus('Интеграция отключена', 'success');
        closeModal('okidokiModal');
      } catch (err) {
        setStatus('Ошибка: ' + err.message, 'error');
      }
    });
  }
}
