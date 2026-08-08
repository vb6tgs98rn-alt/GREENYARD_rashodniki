/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 *
 * Копирование, распространение, переработка и обратная разработка
 * (reverse engineering) запрещены без письменного разрешения правообладателя.
 * Условия: см. файл LICENSE. Нарушение влечёт ответственность по ст. 1252,
 * 1301 ГК РФ.
 */
// tochka.js — приём оплаты проживания через Точка Банк.
//
// Все обращения к банку идут через Edge Function tochka-api: токены клиента
// хранятся на сервере и в браузер не попадают. Здесь только настройки и статус.

import { getSupabaseClient } from './supabase-client.js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import { openModal, closeModal, setStatus } from './render.js';

const API = `${SUPABASE_URL}/functions/v1/tochka-api`;

function esc(s) {
  return String(s ?? '').replace(/[<>&"']/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// Токен читаем из localStorage — так же, как в остальных модулях (iOS Safari).
function readTokenFromStorage() {
  try {
    const raw = localStorage.getItem('gy-auth-session');
    if (!raw) return null;
    const s = JSON.parse(raw);
    return s?.currentSession?.access_token || s?.access_token || null;
  } catch { return null; }
}

async function getAccessToken() {
  const t = readTokenFromStorage();
  if (t) return t;
  try {
    const supabase = getSupabaseClient();
    const { data } = await supabase.auth.getSession();
    return data?.session?.access_token || null;
  } catch { return null; }
}

function uidFromToken(token) {
  try {
    const p = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return p?.sub || null;
  } catch { return null; }
}

async function callApi(route, { method = 'POST', body = null } = {}) {
  const token = await getAccessToken();
  if (!token) throw new Error('не авторизованы (войдите в аккаунт через email)');
  const res = await fetch(`${API}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: SUPABASE_ANON_KEY,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

export async function fetchStatus()          { return callApi('/status', { method: 'GET' }); }
export async function startConnect()         { return callApi('/connect'); }
export async function disconnect()           { return callApi('/disconnect'); }
export async function refreshIdentifiers()   { return callApi('/refresh'); }
export async function pollPayments()         { return callApi('/poll'); }
export async function payForBooking(booking_id, force = false) {
  return callApi('/pay', { body: { booking_id, force } });
}
export async function fetchPayments(booking_id) {
  const q = booking_id ? `?booking_id=${encodeURIComponent(booking_id)}` : '';
  return callApi(`/payments${q}`, { method: 'GET' });
}

// ─── Настройки в manager_settings ───────────────────────────────────────

const SETTINGS_FIELDS = [
  'tochka_enabled', 'tochka_payment_method', 'tochka_auto_send', 'tochka_with_receipt',
  'tochka_tax_system', 'tochka_vat_type', 'tochka_ttl_minutes',
  'tochka_purpose_template', 'tochka_requisites', 'tochka_success_url',
];

export async function loadSettings() {
  const token = await getAccessToken();
  const uid = token && uidFromToken(token);
  if (!uid) throw new Error('не авторизованы (войдите в аккаунт через email)');
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from('manager_settings')
    .select(SETTINGS_FIELDS.join(', '))
    .eq('user_id', uid)
    .maybeSingle();
  if (error) throw error;
  return data || {};
}

export async function saveSettings(patch) {
  const token = await getAccessToken();
  const uid = token && uidFromToken(token);
  if (!uid) throw new Error('не авторизованы (войдите в аккаунт через email)');
  const supabase = getSupabaseClient();
  const { error } = await supabase.from('manager_settings').upsert({
    user_id: uid,
    ...patch,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'user_id' });
  if (error) throw error;
}

// ─── Модалка ────────────────────────────────────────────────────────────

function ensureModal() {
  if (document.getElementById('tochkaModal')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="modal-backdrop" id="tochkaModal" aria-hidden="true">
      <div class="modal" style="width:min(760px,100%);max-height:92dvh;overflow-y:auto;padding:1rem;">
        <div class="section-head">
          <div>
            <h2 class="modal-title">Оплата проживания (Точка Банк)</h2>
            <p class="muted" style="margin:0;">Бот отправляет гостю ссылку на оплату остатка вместе с договором. Деньги приходят на ваш счёт в Точке.</p>
          </div>
          <button class="menu-toggle" id="tochkaClose" aria-label="Закрыть">✕</button>
        </div>

        <div id="tochkaStatus" class="small" style="margin-top:1rem;padding:.75rem;border-radius:10px;background:rgba(127,127,127,.1);">Загружаем статус…</div>

        <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.75rem;">
          <button class="btn btn-primary" id="tochkaConnect" type="button">Подключить счёт Точки</button>
          <button class="btn btn-secondary" id="tochkaRefresh" type="button">Обновить данные</button>
          <button class="btn btn-secondary" id="tochkaDisconnect" type="button">Отключить</button>
        </div>

        <div id="tochkaConfig" style="margin-top:1.25rem;display:none;">
          <label class="gy-toggle" style="margin-top:.25rem;">
            <input id="tochkaEnabled" type="checkbox" />
            <span class="gy-toggle-track" aria-hidden="true"><span class="gy-toggle-thumb"></span></span>
            <span class="gy-toggle-label">Принимать оплату от гостей</span>
          </label>

          <label class="gy-toggle" style="margin-top:.75rem;">
            <input id="tochkaAutoSend" type="checkbox" />
            <span class="gy-toggle-track" aria-hidden="true"><span class="gy-toggle-thumb"></span></span>
            <span class="gy-toggle-label">Отправлять ссылку автоматически вместе с договором</span>
          </label>

          <label style="display:block;margin-top:1rem;">
            <span class="small">Способ оплаты</span>
            <select id="tochkaMethod" style="margin-top:.4rem;width:100%;">
              <option value="payment_link">Платёжная ссылка (СБП + карта, с чеком)</option>
              <option value="sbp_qr">Динамический QR-код СБП (без чека)</option>
              <option value="requisites">Реквизиты для перевода вручную</option>
            </select>
            <span class="small" id="tochkaMethodHint" style="opacity:.75;display:block;margin-top:.35rem;"></span>
          </label>

          <div id="tochkaReceiptBox">
            <label class="gy-toggle" style="margin-top:1rem;">
              <input id="tochkaWithReceipt" type="checkbox" />
              <span class="gy-toggle-track" aria-hidden="true"><span class="gy-toggle-thumb"></span></span>
              <span class="gy-toggle-label">Формировать чек (54-ФЗ) и отправлять гостю на e-mail</span>
            </label>

            <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;margin-top:.75rem;">
              <label>
                <span class="small">Система налогообложения</span>
                <select id="tochkaTax" style="margin-top:.4rem;width:100%;">
                  <option value="usn_income">УСН «Доходы»</option>
                  <option value="usn_income_outcome">УСН «Доходы минус расходы»</option>
                  <option value="osn">Общая (ОСН)</option>
                  <option value="patent">Патент</option>
                  <option value="esn">ЕСХН</option>
                </select>
              </label>
              <label>
                <span class="small">Ставка НДС</span>
                <select id="tochkaVat" style="margin-top:.4rem;width:100%;">
                  <option value="none">Без НДС</option>
                  <option value="vat0">0%</option>
                  <option value="vat5">5%</option>
                  <option value="vat7">7%</option>
                  <option value="vat10">10%</option>
                  <option value="vat22">22%</option>
                </select>
              </label>
            </div>
          </div>

          <label style="display:block;margin-top:1rem;">
            <span class="small">Срок действия ссылки, минут</span>
            <input id="tochkaTtl" type="number" min="1" max="129600" step="1" style="margin-top:.4rem;width:100%;" />
            <span class="small" style="opacity:.7;display:block;margin-top:.25rem;">По умолчанию 4320 минут — это трое суток.</span>
          </label>

          <label style="display:block;margin-top:1rem;">
            <span class="small">Назначение платежа</span>
            <input id="tochkaPurpose" type="text" maxlength="210" style="margin-top:.4rem;width:100%;" />
            <span class="small" style="opacity:.7;display:block;margin-top:.25rem;">Подстановки: {booking_id}, {apartment}, {begin}, {end}, {fio}.</span>
          </label>

          <label style="display:block;margin-top:1rem;" id="tochkaRequisitesBox">
            <span class="small">Реквизиты для перевода вручную</span>
            <textarea id="tochkaRequisites" rows="4" style="margin-top:.4rem;width:100%;" placeholder="Например: перевод по СБП на +7 900 000-00-00, получатель Иван И."></textarea>
          </label>

          <div style="display:flex;gap:.5rem;justify-content:flex-end;margin-top:1.25rem;">
            <button class="btn btn-primary" id="tochkaSave" type="button">Сохранить настройки</button>
          </div>

          <div class="subsection-title" style="margin-top:1.75rem;margin-bottom:.5rem;display:flex;align-items:center;gap:.5rem;justify-content:space-between;">
            <h3 style="margin:0;">Платежи по броням</h3>
            <button class="btn btn-secondary" id="tochkaPoll" type="button">Сверить статусы</button>
          </div>
          <div id="tochkaPayments" class="small" style="opacity:.85;">Загружаем…</div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(wrap.children[0]);
}

const METHOD_HINTS = {
  payment_link: 'Гость платит по ссылке: СБП или картой. Чек уходит гостю на e-mail автоматически. Нужен подключённый интернет-эквайринг Точки.',
  sbp_qr: 'Динамический QR-код СБП: комиссия ниже, но чек по 54-ФЗ такой платёж не формирует — выбивать придётся отдельно.',
  requisites: 'Банк не задействуется: бот просто пришлёт гостю ваш текст с реквизитами, статус оплаты отмечаете вручную.',
};

const STATUS_LABEL = {
  created: '⏳ ожидает оплаты',
  paid: '✅ оплачен',
  expired: '⌛ истёк',
  cancelled: '✖ отменён',
  failed: '⚠ отклонён',
  refunded: '↩ возвращён',
};

function renderStatusBox(st) {
  const box = document.getElementById('tochkaStatus');
  const config = document.getElementById('tochkaConfig');
  const connectBtn = document.getElementById('tochkaConnect');
  if (!box) return;

  if (!st?.configured) {
    box.innerHTML = '⚠ Интеграция не настроена на сервере: администратору нужно зарегистрировать приложение в Точке и задать TOCHKA_CLIENT_ID и TOCHKA_CLIENT_SECRET.';
    box.style.color = '#c88';
    config.style.display = 'none';
    connectBtn.disabled = true;
    return;
  }
  connectBtn.disabled = false;

  if (st.status !== 'connected') {
    const err = st.last_error ? `<div style="margin-top:.4rem;color:#c88;">Последняя ошибка: ${esc(st.last_error)}</div>` : '';
    box.innerHTML = `Счёт Точки не подключён. Нажмите «Подключить счёт Точки» — откроется страница банка, где вы подтвердите доступ.${err}`;
    box.style.color = '';
    config.style.display = 'none';
    connectBtn.textContent = 'Подключить счёт Точки';
    return;
  }

  connectBtn.textContent = 'Переподключить';
  const parts = [
    '✅ Счёт Точки подключён',
    st.customer_code ? `клиент ${esc(st.customer_code)}` : '',
    st.has_acquiring ? 'эквайринг доступен' : '⚠ интернет-эквайринг не подключён',
    st.has_sbp ? 'СБП доступен' : '⚠ СБП не подключён',
    st.webhook_ok ? 'уведомления об оплате включены' : '⚠ вебхук не зарегистрирован',
  ].filter(Boolean);
  const err = st.last_error ? `<div style="margin-top:.4rem;color:#c88;">${esc(st.last_error)}</div>` : '';
  box.innerHTML = parts.join(' · ') + err;
  box.style.color = '';
  config.style.display = 'block';
}

function applyMethodVisibility() {
  const method = document.getElementById('tochkaMethod').value;
  document.getElementById('tochkaMethodHint').textContent = METHOD_HINTS[method] || '';
  const receipt = document.getElementById('tochkaReceiptBox');
  const req = document.getElementById('tochkaRequisitesBox');
  // hidden не скрывает label — прячем через display.
  receipt.style.display = method === 'payment_link' ? 'block' : 'none';
  req.style.display = method === 'requisites' ? 'block' : 'none';
}

async function renderPayments() {
  const box = document.getElementById('tochkaPayments');
  if (!box) return;
  box.textContent = 'Загружаем…';
  try {
    const { items } = await fetchPayments();
    if (!items?.length) {
      box.innerHTML = '<span style="opacity:.7;">Платежей пока нет.</span>';
      return;
    }
    box.innerHTML = `<table style="width:100%;border-collapse:collapse;">
      <thead><tr style="text-align:left;opacity:.7;">
        <th style="padding:.3rem .4rem;">Бронь</th><th>Сумма</th><th>Статус</th><th>Создан</th>
      </tr></thead><tbody>${items.map((p) => {
        const sum = Number(p.amount).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const when = p.created_at ? new Date(p.created_at).toLocaleString('ru-RU') : '';
        const link = p.pay_url ? ` <a href="${esc(p.pay_url)}" target="_blank" rel="noopener">ссылка</a>` : '';
        return `<tr style="border-top:1px solid rgba(127,127,127,.2);">
          <td style="padding:.35rem .4rem;">${esc(p.booking_id)}${link}</td>
          <td>${esc(sum)} ₽</td>
          <td>${esc(STATUS_LABEL[p.status] || p.status)}</td>
          <td>${esc(when)}</td>
        </tr>`;
      }).join('')}</tbody></table>`;
  } catch (err) {
    box.innerHTML = `<span style="color:#c88;">Не удалось загрузить: ${esc(err.message)}</span>`;
  }
}

/** Открывает модалку настроек оплаты. */
export async function openTochkaSettings() {
  ensureModal();
  openModal('tochkaModal');

  const modal = document.getElementById('tochkaModal');
  const closeBtn = document.getElementById('tochkaClose');
  const connectBtn = document.getElementById('tochkaConnect');
  const refreshBtn = document.getElementById('tochkaRefresh');
  const disconnectBtn = document.getElementById('tochkaDisconnect');
  const saveBtn = document.getElementById('tochkaSave');
  const pollBtn = document.getElementById('tochkaPoll');
  const methodSel = document.getElementById('tochkaMethod');

  // Сначала поднимаем рабочий интерфейс, и только потом идём в сеть:
  // если банк или база отвечают долго, модалка всё равно кликается.
  applyMethodVisibility();
  bindHandlers(modal, { closeBtn, connectBtn, refreshBtn, disconnectBtn, saveBtn, pollBtn, methodSel });

  // Статус подключения
  let st = null;
  try {
    st = await fetchStatus();
  } catch (err) {
    document.getElementById('tochkaStatus').innerHTML = `<span style="color:#c88;">Не удалось получить статус: ${esc(err.message)}</span>`;
  }
  if (st) renderStatusBox(st);

  // Настройки
  try {
    const s = await loadSettings();
    document.getElementById('tochkaEnabled').checked = Boolean(s.tochka_enabled);
    document.getElementById('tochkaAutoSend').checked = s.tochka_auto_send !== false;
    document.getElementById('tochkaWithReceipt').checked = s.tochka_with_receipt !== false;
    methodSel.value = s.tochka_payment_method || 'payment_link';
    document.getElementById('tochkaTax').value = s.tochka_tax_system || 'usn_income';
    document.getElementById('tochkaVat').value = s.tochka_vat_type || 'none';
    document.getElementById('tochkaTtl').value = s.tochka_ttl_minutes ?? 4320;
    document.getElementById('tochkaPurpose').value = s.tochka_purpose_template
      || 'Оплата проживания по брони №{booking_id}, {apartment}, {begin}—{end}';
    document.getElementById('tochkaRequisites').value = s.tochka_requisites || '';
    applyMethodVisibility();
  } catch (err) {
    setStatus('Не удалось загрузить настройки оплаты: ' + err.message, 'error');
  }

  if (st?.status === 'connected') renderPayments().catch(() => {});
}

/** Привязывает обработчики один раз за жизнь модалки. */
function bindHandlers(modal, els) {
  const { closeBtn, connectBtn, refreshBtn, disconnectBtn, saveBtn, pollBtn, methodSel } = els;
  if (modal.dataset.bound) return;
  modal.dataset.bound = '1';

  closeBtn.addEventListener('click', () => closeModal('tochkaModal'));
  methodSel.addEventListener('change', applyMethodVisibility);

  connectBtn.addEventListener('click', async () => {
    connectBtn.disabled = true;
    try {
      const r = await startConnect();
      if (r?.url) {
        // Открываем страницу банка в новой вкладке: после подтверждения
        // Точка вернёт пользователя на нашу страницу-заглушку.
        window.open(r.url, '_blank', 'noopener');
        setStatus('Подтвердите доступ в открывшейся вкладке Точки, затем нажмите «Обновить данные»', 'success');
      }
    } catch (err) {
      setStatus('Не удалось начать подключение: ' + err.message, 'error');
    } finally {
      connectBtn.disabled = false;
    }
  });

  refreshBtn.addEventListener('click', async () => {
    refreshBtn.disabled = true;
    try {
      const fresh = await fetchStatus();
      renderStatusBox(fresh);
      if (fresh.status === 'connected') {
        try { await refreshIdentifiers(); } catch { /* справочники подтянутся позже */ }
        renderStatusBox(await fetchStatus());
        await renderPayments();
      }
      setStatus('Данные обновлены', 'success');
    } catch (err) {
      setStatus('Ошибка обновления: ' + err.message, 'error');
    } finally {
      refreshBtn.disabled = false;
    }
  });

  disconnectBtn.addEventListener('click', async () => {
    if (!confirm('Отключить Точку? Приём оплаты остановится, сохранённые токены будут удалены.')) return;
    try {
      await disconnect();
      renderStatusBox(await fetchStatus());
      setStatus('Точка отключена', 'success');
    } catch (err) {
      setStatus('Ошибка: ' + err.message, 'error');
    }
  });

  saveBtn.addEventListener('click', async () => {
    const ttl = Number(document.getElementById('tochkaTtl').value || 4320);
    if (!Number.isFinite(ttl) || ttl < 1 || ttl > 129600) {
      setStatus('Срок действия ссылки должен быть от 1 до 129600 минут', 'error');
      return;
    }
    try {
      await saveSettings({
        tochka_enabled: document.getElementById('tochkaEnabled').checked,
        tochka_auto_send: document.getElementById('tochkaAutoSend').checked,
        tochka_with_receipt: document.getElementById('tochkaWithReceipt').checked,
        tochka_payment_method: methodSel.value,
        tochka_tax_system: document.getElementById('tochkaTax').value,
        tochka_vat_type: document.getElementById('tochkaVat').value,
        tochka_ttl_minutes: Math.round(ttl),
        tochka_purpose_template: document.getElementById('tochkaPurpose').value.trim() || null,
        tochka_requisites: document.getElementById('tochkaRequisites').value.trim() || null,
      });
      setStatus('Настройки оплаты сохранены', 'success');
    } catch (err) {
      setStatus('Ошибка сохранения: ' + err.message, 'error');
    }
  });

  pollBtn.addEventListener('click', async () => {
    pollBtn.disabled = true;
    try {
      const r = await pollPayments();
      await renderPayments();
      setStatus(`Проверено ${r.checked}, обновлено ${r.updated}`, 'success');
    } catch (err) {
      setStatus('Ошибка сверки: ' + err.message, 'error');
    } finally {
      pollBtn.disabled = false;
    }
  });
}
