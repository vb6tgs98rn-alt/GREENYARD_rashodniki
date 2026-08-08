/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 *
 * Копирование, распространение, переработка и обратная разработка
 * (reverse engineering) запрещены без письменного разрешения правообладателя.
 * Условия: см. файл LICENSE. Нарушение влечёт ответственность по ст. 1252,
 * 1301 ГК РФ.
 */
// ═══════════════════════════════════════════════════════════════════════════
// consent.js — Consent Manager (152-ФЗ)
//
// Единственная точка правды для согласий пользователя.
// НИКОГДА не вызывайте функции трекинга/аналитики/маркетинга напрямую —
// используйте runIfConsent(category, callback).
//
// Категории:
//   - necessary   — всегда true, не отключаемая (auth, безопасность)
//   - analytics   — метрика, Sentry, счётчики
//   - marketing   — пиксели, ретаргетинг, рассылки
//   - functional  — чат-виджеты, embed'ы карт и т.п.
//
// personal_data — отдельный флаг согласия на обработку ПДн (152-ФЗ),
//                 обязателен для регистрации.
// ═══════════════════════════════════════════════════════════════════════════

import { supabase } from './supabase-client.js';

// ─── Ключи localStorage (только строго необходимое) ────────────────────────
const LS_CONSENT_CACHE = 'gy_consent_cache_v1';
const LS_POLICY_SEEN   = 'gy_policy_seen_version';

// ─── Значения по умолчанию (privacy by default) ────────────────────────────
export const DEFAULT_CATEGORIES = Object.freeze({
  necessary:  true,   // всегда включено
  analytics:  false,
  marketing:  false,
  functional: false,
});

const NON_ESSENTIAL_CATEGORIES = ['analytics', 'marketing', 'functional'];

// ─── Внутреннее состояние ─────────────────────────────────────────────────
let _state = {
  loaded:         false,
  hasConsent:     false,    // есть ли активное согласие в БД
  policyVersion:  null,     // версия политики, на которую было дано согласие
  categories:     { ...DEFAULT_CATEGORIES },
  personalData:   false,
  givenAt:        null,
  activePolicy:   null,     // { version, title, content_md }
};

const _listeners = new Set();

function _emit() {
  for (const cb of _listeners) {
    try { cb(getStatus()); } catch (e) { console.error('[consent] listener error', e); }
  }
}

// ─── Публичное API ────────────────────────────────────────────────────────

/** Подписаться на изменения consent. Возвращает функцию отписки. */
export function onConsentChange(cb) {
  _listeners.add(cb);
  return () => _listeners.delete(cb);
}

/** Текущий статус consent. */
export function getStatus() {
  return {
    loaded:        _state.loaded,
    hasConsent:    _state.hasConsent,
    policyVersion: _state.policyVersion,
    categories:    { ..._state.categories },
    personalData:  _state.personalData,
    givenAt:       _state.givenAt,
    activePolicy:  _state.activePolicy,
  };
}

/**
 * Проверка: разрешена ли категория.
 * ЭТО ГЛАВНЫЙ GUARD. Всегда используйте перед любой не-necessary операцией.
 */
export function hasConsent(category = 'necessary') {
  if (category === 'necessary') return true;
  if (!_state.hasConsent) return false;
  return _state.categories?.[category] === true;
}

/**
 * Выполнить callback только при наличии согласия для категории.
 * ГЛАВНАЯ обёртка для всех вызовов аналитики/маркетинга.
 *
 * Пример:
 *   runIfConsent('analytics', () => window.ym(counterId, 'hit', url));
 */
export function runIfConsent(category, callback) {
  if (!hasConsent(category)) {
    if (typeof console !== 'undefined' && console.debug) {
      console.debug(`[consent] blocked call for category="${category}" — no consent`);
    }
    return undefined;
  }
  try {
    return callback();
  } catch (e) {
    console.error(`[consent] callback error for category="${category}"`, e);
  }
}

/** Требуется ли согласие на обработку ПДн (для форм с ПДн). */
export function hasPersonalDataConsent() {
  return !!_state.personalData;
}

/** Активная политика (объект {version, title, content_md}) или null. */
export function getActivePolicy() {
  return _state.activePolicy;
}

// ─── Загрузка / инициализация ─────────────────────────────────────────────

/**
 * Загрузить активную версию политики из БД.
 * Публичный SELECT, работает даже без авторизации (RLS allow all read).
 */
export async function loadActivePolicy() {
  const { data, error } = await supabase
    .from('privacy_policies')
    .select('id, version, title, content_md, published_at')
    .eq('is_active', true)
    .order('published_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.error('[consent] failed to load policy', error);
    return null;
  }
  _state.activePolicy = data || null;
  _emit();
  return data;
}

/**
 * Загрузить актуальный consent авторизованного пользователя из БД.
 * Если пользователь не авторизован — no-op.
 */
export async function loadUserConsent() {
  // getSession() — локальный, не делает HTTP-вызовов (в отличие от getUser())
  const { data: { session } } = await supabase.auth.getSession();
  const user = session?.user || null;
  if (!user) {
    _state.loaded = true;
    _state.hasConsent = false;
    _emit();
    return null;
  }

  const { data, error } = await supabase
    .from('user_consents')
    .select('id, policy_version, categories, personal_data, given_at, revoked_at')
    .eq('user_id', user.id)
    .is('revoked_at', null)
    .order('given_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  _state.loaded = true;

  if (error || !data) {
    _state.hasConsent = false;
    _state.categories = { ...DEFAULT_CATEGORIES };
    _state.personalData = false;
    _state.policyVersion = null;
    _state.givenAt = null;
    _emit();
    return null;
  }

  _state.hasConsent    = true;
  _state.policyVersion = data.policy_version;
  _state.categories    = { ...DEFAULT_CATEGORIES, ...(data.categories || {}) };
  _state.personalData  = !!data.personal_data;
  _state.givenAt       = data.given_at;

  // Кэш для быстрого старта в следующей сессии
  try {
    localStorage.setItem(LS_CONSENT_CACHE, JSON.stringify({
      version:     data.policy_version,
      categories:  _state.categories,
      personal:    _state.personalData,
      givenAt:     data.given_at,
    }));
  } catch { /* localStorage disabled — не критично */ }

  _emit();
  return data;
}

/**
 * Проверить, устарела ли версия политики.
 * true = пользователь дал согласие на СТАРУЮ версию, нужно переспросить.
 */
export function isPolicyOutdated() {
  if (!_state.hasConsent || !_state.activePolicy) return false;
  return _state.policyVersion !== _state.activePolicy.version;
}

// ─── Запись согласия ──────────────────────────────────────────────────────

/**
 * Сохранить согласие пользователя.
 *
 * ВАЖНО: до вызова этой функции — никакой персональной обработки не должно
 * быть. Функция сама пишет ip/ua на сервере через edge-функцию, чтобы
 * клиент не отправлял свой IP явно.
 *
 * @param {object} opts
 * @param {object} opts.categories   { analytics, marketing, functional }
 * @param {boolean} opts.personalData  согласие на обработку ПДн (обязательно для signup)
 * @param {string}  opts.policyVersion версия принятой политики
 */
export async function submitConsent({ categories = {}, personalData = false, policyVersion }) {
  // getSession() — локальный, не делает HTTP-вызовов
  const { data: { session } } = await supabase.auth.getSession();
  const user = session?.user || null;
  if (!user) {
    throw new Error('Нельзя записать согласие: пользователь не авторизован');
  }
  const version = policyVersion || _state.activePolicy?.version;
  if (!version) throw new Error('Нет активной версии политики');

  const cats = {
    necessary:  true,
    analytics:  !!categories.analytics,
    marketing:  !!categories.marketing,
    functional: !!categories.functional,
  };

  // Пишем через edge-функцию, чтобы IP/UA логировались на сервере.
  // Функция сама подставит user_id из JWT.
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;

  const resp = await fetch(
    `${supabase.supabaseUrl}/functions/v1/consent-api`,
    {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey':        supabase.supabaseKey,
      },
      body: JSON.stringify({
        action:         'submit',
        policy_version: version,
        categories:     cats,
        personal_data:  !!personalData,
        user_agent:     navigator.userAgent, // передаём явно для доказательства
      }),
    }
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Не удалось сохранить согласие: ${err || resp.status}`);
  }

  await loadUserConsent();
  return _state;
}

/**
 * Отозвать текущее согласие.
 * После отзыва все non-essential категории становятся false.
 */
export async function revokeConsent(reason = '') {
  const { data: sessionData } = await supabase.auth.getSession();
  const token = sessionData?.session?.access_token;
  if (!token) throw new Error('Нужна авторизация');

  const resp = await fetch(
    `${supabase.supabaseUrl}/functions/v1/consent-api`,
    {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${token}`,
        'apikey':        supabase.supabaseKey,
      },
      body: JSON.stringify({ action: 'revoke', reason }),
    }
  );

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Не удалось отозвать согласие: ${err || resp.status}`);
  }

  // Удаляем несущественные cookies/LS-ключи (пока их нет, но задел на будущее)
  cleanupNonEssential();

  await loadUserConsent();
  return _state;
}

/**
 * Удаление non-essential cookies и LS-ключей при отзыве.
 * Расширять при добавлении аналитики: добавьте сюда очистку YM/GA/pixel cookies.
 */
function cleanupNonEssential() {
  try {
    localStorage.removeItem(LS_CONSENT_CACHE);
  } catch {}
  // Placeholder: при появлении Метрики — очистить _ym_uid, _ym_d и т.д.
  // Пример:
  // ['_ym_uid', '_ym_d', '_ym_isad'].forEach(name => {
  //   document.cookie = `${name}=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT`;
  // });
}

// ─── Утилита: пометить, что баннер показан (чтобы не показывать повторно) ─
export function markBannerSeen(version) {
  try { localStorage.setItem(LS_POLICY_SEEN, version); } catch {}
}
export function wasBannerSeen(version) {
  try { return localStorage.getItem(LS_POLICY_SEEN) === version; } catch { return false; }
}
