// ═══════════════════════════════════════════════════════════════════════════
// consentUI.js — UI для consent-баннера, модалки и страницы настроек
// ═══════════════════════════════════════════════════════════════════════════

import {
  getStatus,
  hasConsent,
  submitConsent,
  revokeConsent,
  loadActivePolicy,
  loadUserConsent,
  isPolicyOutdated,
  onConsentChange,
  markBannerSeen,
  wasBannerSeen,
  DEFAULT_CATEGORIES,
} from './consent.js';

// ─── Стили в head (один раз) ──────────────────────────────────────────────
function ensureStyles() {
  if (document.getElementById('consent-styles')) return;
  const style = document.createElement('style');
  style.id = 'consent-styles';
  style.textContent = `
    .gy-consent-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.65); z-index: 9998; display: flex; align-items: flex-end; justify-content: center; padding: 0; }
    @media (min-width: 720px) { .gy-consent-backdrop { align-items: center; padding: 1rem; } }
    .gy-consent-banner { background: #1a1a1a; color: #eee; width: 100%; max-width: 560px; border-radius: 16px 16px 0 0; padding: 1.25rem; box-shadow: 0 -4px 24px rgba(0,0,0,.4); }
    @media (min-width: 720px) { .gy-consent-banner { border-radius: 16px; } }
    .gy-consent-title { font-size: 1.1rem; font-weight: 600; margin: 0 0 .5rem; }
    .gy-consent-text { font-size: .9rem; line-height: 1.45; opacity: .85; margin: 0 0 1rem; }
    .gy-consent-text a { color: #7fd3ff; text-decoration: underline; }
    .gy-consent-actions { display: flex; flex-wrap: wrap; gap: .5rem; }
    .gy-consent-btn { flex: 1; min-width: 120px; padding: .7rem .9rem; border-radius: 10px; border: 1px solid #333; background: #222; color: #eee; font-size: .95rem; cursor: pointer; }
    .gy-consent-btn:hover { background: #2b2b2b; }
    .gy-consent-btn.primary { background: #2d7a4f; border-color: #2d7a4f; }
    .gy-consent-btn.primary:hover { background: #338a58; }
    .gy-consent-btn.ghost { background: transparent; }

    .gy-consent-modal { background: #1a1a1a; color: #eee; width: 100%; max-width: 640px; max-height: 90vh; border-radius: 16px; padding: 1.25rem; display: flex; flex-direction: column; gap: .75rem; overflow-y: auto; -webkit-overflow-scrolling: touch; }
    .gy-consent-modal h3 { margin: 0; font-size: 1.05rem; }
    .gy-consent-modal .body { flex: 1; overflow-y: auto; padding: .5rem; background: #111; border-radius: 8px; border: 1px solid #2a2a2a; font-size: .85rem; line-height: 1.5; }
    .gy-consent-modal .body h1, .gy-consent-modal .body h2, .gy-consent-modal .body h3 { margin-top: 1em; }
    .gy-consent-cat-list { display: flex; flex-direction: column; gap: .5rem; padding: .5rem 0; }
    .gy-consent-cat { display: flex; align-items: flex-start; gap: .6rem; padding: .5rem .75rem; background: #111; border-radius: 8px; border: 1px solid #2a2a2a; cursor: pointer; }
    .gy-consent-cat > input[type=checkbox] { flex: 0 0 20px !important; width: 20px !important; height: 20px !important; max-width: 20px !important; max-height: 20px !important; min-width: 20px !important; min-height: 20px !important; margin: 2px 0 0 0; padding: 0; accent-color: #2d7a4f; cursor: pointer; -webkit-appearance: checkbox; appearance: auto; }
    .gy-consent-cat > div { flex: 1 1 auto; min-width: 0; }
    .gy-consent-cat .cat-title { font-weight: 600; }
    .gy-consent-cat .cat-desc { font-size: .8rem; opacity: .7; margin-top: .1rem; line-height: 1.4; }
    .gy-consent-cat.disabled { opacity: .6; cursor: default; }
    .gy-consent-cat.disabled > input[type=checkbox] { cursor: default; }

    .gy-consent-check { display: flex; gap: .5rem; align-items: flex-start; margin: .5rem 0; font-size: .9rem; }
    .gy-consent-check > input[type=checkbox] { flex: 0 0 auto; width: 20px; height: 20px; margin: 2px 0 0 0; padding: 0; accent-color: #2d7a4f; }
    .gy-consent-check > span { flex: 1 1 auto; min-width: 0; }
    .gy-consent-error { color: #ff7676; font-size: .85rem; margin-top: .25rem; }
  `;
  document.head.appendChild(style);
}

// ─── Простейший markdown → HTML (заголовки, списки, жирный, ссылки) ───────
function mdToHtml(md) {
  if (!md) return '';
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = md.split('\n');
  let html = ''; let inList = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (/^#{1,6}\s/.test(line)) {
      if (inList) { html += '</ul>'; inList = false; }
      const level = line.match(/^#+/)[0].length;
      html += `<h${level}>${esc(line.replace(/^#+\s*/, ''))}</h${level}>`;
    } else if (/^[-*]\s+/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inline(esc(line.replace(/^[-*]\s+/, '')))}</li>`;
    } else if (line.trim() === '') {
      if (inList) { html += '</ul>'; inList = false; }
      html += '';
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p>${inline(esc(line))}</p>`;
    }
  }
  if (inList) html += '</ul>';
  return html;

  function inline(s) {
    return s
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\[(.+?)\]\((.+?)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  }
}

// ─── Backdrop / cleanup ───────────────────────────────────────────────────
function backdrop() {
  const b = document.createElement('div');
  b.className = 'gy-consent-backdrop';
  return b;
}
function closeEl(el) { el?.remove(); }

// ─── Баннер согласия (краткий, при первом входе) ─────────────────────────
let _bannerEl = null;

/**
 * Показать баннер при первом входе.
 * Возвращает Promise, который резолвится когда пользователь сделал выбор.
 */
export async function showConsentBanner() {
  ensureStyles();
  await loadActivePolicy();
  const status = getStatus();
  const policy = status.activePolicy;
  if (!policy) {
    console.warn('[consent] no active policy — banner not shown');
    return;
  }

  // Если уже дано согласие на актуальную версию — не показываем
  if (status.hasConsent && status.policyVersion === policy.version) {
    return;
  }

  // Если пользователь ещё не авторизован — не показываем (баннер до auth не нужен)
  if (!(await isAuthenticated())) return;

  if (_bannerEl) closeEl(_bannerEl);

  const b = backdrop();
  b.innerHTML = `
    <div class="gy-consent-banner" role="dialog" aria-modal="true" aria-labelledby="gy-consent-title">
      <h3 class="gy-consent-title" id="gy-consent-title">Согласие на обработку данных</h3>
      <p class="gy-consent-text">
        Для работы Сервиса мы обрабатываем ваши персональные данные (email, пользовательские
        настройки, данные о бронированиях) в соответствии с
        <a href="#" data-open-policy>Политикой конфиденциальности</a> и требованиями
        152-ФЗ. Технические cookies используются только для входа и сохранения настроек.
      </p>
      <div class="gy-consent-actions">
        <button class="gy-consent-btn ghost" data-action="customize">Настроить</button>
        <button class="gy-consent-btn primary" data-action="accept">Принимаю</button>
      </div>
    </div>
  `;
  document.body.appendChild(b);
  _bannerEl = b;

  return new Promise((resolve) => {
    b.querySelector('[data-open-policy]').addEventListener('click', (e) => {
      e.preventDefault();
      showPolicyModal();
    });
    b.querySelector('[data-action=accept]').addEventListener('click', async () => {
      try {
        await submitConsent({
          categories: { analytics: false, marketing: false, functional: false },
          personalData: true,
          policyVersion: policy.version,
        });
        markBannerSeen(policy.version);
        closeEl(b); _bannerEl = null;
        resolve({ accepted: true });
      } catch (e) {
        alert('Не удалось сохранить согласие: ' + e.message);
      }
    });
    b.querySelector('[data-action=customize]').addEventListener('click', () => {
      closeEl(b); _bannerEl = null;
      showConsentSettings().then(resolve);
    });
  });
}

// ─── Модалка с полным текстом политики ────────────────────────────────────
export async function showPolicyModal() {
  ensureStyles();
  await loadActivePolicy();
  const policy = getStatus().activePolicy;
  if (!policy) { alert('Политика не загружена'); return; }

  const b = backdrop();
  b.innerHTML = `
    <div class="gy-consent-modal">
      <h3>${policy.title || 'Политика конфиденциальности'}</h3>
      <div class="body">${mdToHtml(policy.content_md)}</div>
      <div style="display:flex;justify-content:flex-end;gap:.5rem;">
        <button class="gy-consent-btn" data-close>Закрыть</button>
      </div>
    </div>
  `;
  b.style.alignItems = 'center';
  b.style.padding = '1rem';
  document.body.appendChild(b);
  b.querySelector('[data-close]').addEventListener('click', () => closeEl(b));
  b.addEventListener('click', (e) => { if (e.target === b) closeEl(b); });
}

// ─── Настройки категорий (полная форма) ──────────────────────────────────
export async function showConsentSettings() {
  ensureStyles();
  await Promise.all([loadActivePolicy(), loadUserConsent()]);
  const status = getStatus();
  const policy = status.activePolicy;
  if (!policy) { alert('Политика не загружена'); return; }

  const current = status.categories || { ...DEFAULT_CATEGORIES };

  const b = backdrop();
  b.style.alignItems = 'center';
  b.style.padding = '1rem';
  b.innerHTML = `
    <div class="gy-consent-modal">
      <h3>Настройки конфиденциальности</h3>
      <p class="gy-consent-text">
        Управляйте согласиями. Необходимые категории отключить нельзя — без них
        Сервис не работает. Полный текст — в
        <a href="#" data-open-policy>Политике конфиденциальности</a>.
      </p>
      <div class="gy-consent-cat-list">
        <label class="gy-consent-cat disabled">
          <input type="checkbox" checked disabled />
          <div>
            <div class="cat-title">Необходимые</div>
            <div class="cat-desc">Auth-сессия, флаг согласия, безопасность. Всегда включено.</div>
          </div>
        </label>
        <label class="gy-consent-cat">
          <input type="checkbox" data-cat="analytics" ${current.analytics ? 'checked' : ''} />
          <div>
            <div class="cat-title">Аналитические</div>
            <div class="cat-desc">Метрика посещений, отчёты об ошибках. Сейчас не подключено.</div>
          </div>
        </label>
        <label class="gy-consent-cat">
          <input type="checkbox" data-cat="marketing" ${current.marketing ? 'checked' : ''} />
          <div>
            <div class="cat-title">Маркетинговые</div>
            <div class="cat-desc">Рассылки, пиксели рекламных систем. Сейчас не подключено.</div>
          </div>
        </label>
        <label class="gy-consent-cat">
          <input type="checkbox" data-cat="functional" ${current.functional ? 'checked' : ''} />
          <div>
            <div class="cat-title">Функциональные</div>
            <div class="cat-desc">Дополнительные виджеты, чаты поддержки. Сейчас не подключено.</div>
          </div>
        </label>
      </div>
      <label class="gy-consent-check">
        <input type="checkbox" data-personal ${status.personalData ? 'checked' : ''} />
        <span>Даю согласие на обработку персональных данных в соответствии с
          <a href="#" data-open-policy>Политикой конфиденциальности</a> и 152-ФЗ.</span>
      </label>
      <div class="gy-consent-error" style="display:none;"></div>
      <div style="display:flex;gap:.5rem;justify-content:space-between;flex-wrap:wrap;">
        ${status.hasConsent
          ? '<button class="gy-consent-btn ghost" data-action="revoke" style="color:#ff7676;">Отозвать согласие</button>'
          : '<span></span>'}
        <div style="display:flex;gap:.5rem;">
          <button class="gy-consent-btn" data-action="cancel">Отмена</button>
          <button class="gy-consent-btn primary" data-action="save">Сохранить</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(b);

  const errBox = b.querySelector('.gy-consent-error');
  const showErr = (msg) => { errBox.textContent = msg; errBox.style.display = msg ? 'block' : 'none'; };

  b.querySelector('[data-open-policy]')?.addEventListener('click', (e) => {
    e.preventDefault();
    showPolicyModal();
  });
  b.querySelector('[data-action=cancel]').addEventListener('click', () => closeEl(b));

  b.querySelector('[data-action=save]').addEventListener('click', async () => {
    showErr('');
    const cats = {
      analytics:  b.querySelector('[data-cat=analytics]').checked,
      marketing:  b.querySelector('[data-cat=marketing]').checked,
      functional: b.querySelector('[data-cat=functional]').checked,
    };
    const personal = b.querySelector('[data-personal]').checked;
    if (!personal) { showErr('Согласие на обработку ПДн обязательно для работы Сервиса.'); return; }
    try {
      await submitConsent({
        categories: cats,
        personalData: personal,
        policyVersion: policy.version,
      });
      markBannerSeen(policy.version);
      closeEl(b);
    } catch (e) {
      showErr(e.message || 'Ошибка сохранения');
    }
  });

  const revokeBtn = b.querySelector('[data-action=revoke]');
  if (revokeBtn) revokeBtn.addEventListener('click', async () => {
    if (!confirm('Отозвать согласие? После этого работа с Сервисом будет ограничена, а личные данные будут удалены в течение 30 дней.')) return;
    try {
      await revokeConsent('user_request');
      alert('Согласие отозвано. Обратитесь к администратору для удаления учётной записи.');
      closeEl(b);
    } catch (e) {
      showErr(e.message);
    }
  });
}

// ─── Модалка «Политика обновлена» ─────────────────────────────────────────
export async function showPolicyUpdatedModal() {
  ensureStyles();
  const status = getStatus();
  const policy = status.activePolicy;
  if (!policy) return;

  const b = backdrop();
  b.style.alignItems = 'center';
  b.style.padding = '1rem';
  b.innerHTML = `
    <div class="gy-consent-modal">
      <h3>Политика обновлена</h3>
      <p class="gy-consent-text">
        Мы обновили Политику конфиденциальности (версия ${policy.version}).
        Пожалуйста, ознакомьтесь и подтвердите согласие, чтобы продолжить работу.
      </p>
      <div class="body">${mdToHtml(policy.content_md)}</div>
      <label class="gy-consent-check">
        <input type="checkbox" data-personal />
        <span>Я ознакомился(-ась) с обновлённой политикой и даю согласие на обработку персональных данных.</span>
      </label>
      <div class="gy-consent-error" style="display:none;"></div>
      <div style="display:flex;justify-content:flex-end;gap:.5rem;">
        <button class="gy-consent-btn primary" data-action="accept">Принимаю</button>
      </div>
    </div>
  `;
  document.body.appendChild(b);

  const errBox = b.querySelector('.gy-consent-error');
  b.querySelector('[data-action=accept]').addEventListener('click', async () => {
    const personal = b.querySelector('[data-personal]').checked;
    if (!personal) { errBox.textContent = 'Отметьте согласие'; errBox.style.display = 'block'; return; }
    try {
      // Сохраняем прежние категории (если были)
      const prev = getStatus().categories || { ...DEFAULT_CATEGORIES };
      await submitConsent({
        categories: prev,
        personalData: true,
        policyVersion: policy.version,
      });
      markBannerSeen(policy.version);
      closeEl(b);
    } catch (e) {
      errBox.textContent = e.message; errBox.style.display = 'block';
    }
  });
}

// ─── Оркестратор: вызывать после логина ───────────────────────────────────
/**
 * Проверить состояние consent для авторизованного пользователя.
 * Если согласия нет — показать баннер.
 * Если версия устарела — показать модалку обновления.
 */
export async function checkConsentAfterAuth() {
  await loadActivePolicy();
  await loadUserConsent();

  const status = getStatus();
  if (!status.activePolicy) return; // без политики баннер не показываем

  if (!status.hasConsent) {
    return await showConsentBanner();
  }
  if (isPolicyOutdated()) {
    return await showPolicyUpdatedModal();
  }
}

// ─── Утилита ──────────────────────────────────────────────────────────────
async function isAuthenticated() {
  const { supabase } = await import('./supabase-client.js');
  // getSession() — локальный, без HTTP
  const { data: { session } } = await supabase.auth.getSession();
  return !!session?.user;
}
