/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 *
 * Копирование, распространение, переработка и обратная разработка
 * (reverse engineering) запрещены без письменного разрешения правообладателя.
 * Условия: см. файл LICENSE. Нарушение влечёт ответственность по ст. 1252,
 * 1301 ГК РФ.
 */
/**
 * supabase-client.js
 * Единственное место, где создаётся Supabase клиент.
 * SDK тянем с ESM-CDN — сборщик не нужен.
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.2?bundle';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: false,
    storageKey: 'gy-auth-session',
  },
});

// ─── Auth readiness ────────────────────────────────────────────────────────────
// Supabase SDK поднимает сессию из localStorage асинхронно. Если UI успевает
// вызвать getUser() до того, как SDK закончил hydrate, вернётся null и запросы
// уйдут с anon-ключом. Ждём первый INITIAL_SESSION событие (или его отсутствие),
// после чего getUser() отдаёт валидное значение.
let _authReadyResolve;
const _authReadyPromise = new Promise((r) => { _authReadyResolve = r; });
let _authReady = false;
let _currentSession = null;
let _currentUser = null;

supabase.auth.onAuthStateChange((event, session) => {
  _currentSession = session ?? null;
  _currentUser = session?.user ?? null;
  if (!_authReady) {
    _authReady = true;
    _authReadyResolve(session ?? null);
  }
});

// Fallback: если SDK по какой-то причине не эмитит INITIAL_SESSION, разблокируем через 1500мс
setTimeout(() => {
  if (!_authReady) {
    _authReady = true;
    _authReadyResolve(null);
  }
}, 1500);

/** Дожидается инициализации сессии Supabase из localStorage. Разрешается ровно один раз. */
export function waitForAuthReady() {
  return _authReadyPromise;
}

/** Возвращает текущего пользователя, дождавшись готовности сессии. С ретраями. */
export async function requireUser() {
  await _authReadyPromise;
  if (_currentUser) return _currentUser;
  // Ретраим getSession() несколько раз — SDK мог ещё не закончить hydrate
  for (let i = 0; i < 5; i++) {
    const { data } = await supabase.auth.getSession();
    const u = data?.session?.user;
    if (u) { _currentUser = u; _currentSession = data.session; return u; }
    await new Promise(r => setTimeout(r, 200));
  }
  return null;
}

/** Синхронный геттер кэшированного user — после waitForAuthReady() гарантированно актуален. */
export function currentUser() {
  return _currentUser;
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────

/** Регистрация по email + password. Возвращает { user, session, error }. */
export async function signUpWithEmail(email, password) {
  try {
    const { data, error } = await supabase.auth.signUp({
      email: String(email || '').trim().toLowerCase(),
      password,
    });
    return { user: data?.user ?? null, session: data?.session ?? null, error };
  } catch (e) {
    return { user: null, session: null, error: e };
  }
}

/** Вход по email + password. Возвращает { user, session, error }. */
export async function signInWithEmail(email, password) {
  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email: String(email || '').trim().toLowerCase(),
      password,
    });
    return { user: data?.user ?? null, session: data?.session ?? null, error };
  } catch (e) {
    return { user: null, session: null, error: e };
  }
}

/** Выход. Не бросает исключений. */
export async function signOutUser() {
  try {
    const { error } = await supabase.auth.signOut();
    return { error };
  } catch (e) {
    console.warn('[auth] signOut error:', e);
    return { error: e };
  }
}

/** Текущий пользователь или null. Не бросает. Читает из локальной сессии (без HTTP). */
export async function getCurrentUser() {
  try {
    await _authReadyPromise;
    const { data } = await supabase.auth.getSession();
    return data?.session?.user ?? null;
  } catch (e) {
    console.warn('[auth] getCurrentUser error:', e);
    return null;
  }
}

/** Текущая сессия или null. Не бросает. Дожидается hydrate сессии. */
export async function getSession() {
  try {
    await _authReadyPromise;
    const { data } = await supabase.auth.getSession();
    return data?.session ?? null;
  } catch (e) {
    console.warn('[auth] getSession error:', e);
    return null;
  }
}

/**
 *  Смена пароля с обязательной проверкой текущего.
 *
 *  Supabase сам по себе НЕ требует старый пароль при updateUser({ password }) —
 *  достаточно валидной сессии. Поэтому проверяем текущий пароль вручную:
 *  повторно логинимся с ним. Если пароль неверный — Supabase вернёт ошибку,
 *  и существующая сессия при этом не рвётся (неудачный вход её не затрагивает).
 *
 *  @param {string} currentPassword текущий пароль
 *  @param {string} newPassword     новый пароль
 *  @returns {Promise<{ok: boolean, error: string|null}>}
 */
export async function changePassword(currentPassword, newPassword) {
  try {
    const user = await getCurrentUser();
    if (!user?.email) return { ok: false, error: 'Сессия не найдена. Войдите заново.' };

    // 1) Проверяем текущий пароль повторной авторизацией
    const { error: reauthError } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: currentPassword,
    });
    if (reauthError) {
      const msg = String(reauthError.message || '');
      if (/invalid login credentials/i.test(msg)) {
        return { ok: false, error: 'Текущий пароль введён неверно.' };
      }
      return { ok: false, error: `Не удалось проверить текущий пароль: ${msg}` };
    }

    // 2) Пароль подтверждён — меняем
    const { error: updateError } = await supabase.auth.updateUser({ password: newPassword });
    if (updateError) {
      const msg = String(updateError.message || '');
      if (/should be different|same as the old/i.test(msg)) {
        return { ok: false, error: 'Новый пароль совпадает с текущим. Придумайте другой.' };
      }
      if (/pwned|compromised|leaked/i.test(msg)) {
        return { ok: false, error: 'Этот пароль найден в утечках. Выберите другой.' };
      }
      if (/at least|should be at least|weak/i.test(msg)) {
        return { ok: false, error: `Пароль слишком простой: ${msg}` };
      }
      return { ok: false, error: msg || 'Не удалось сменить пароль.' };
    }

    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: `Сетевая ошибка: ${e?.message || e}` };
  }
}

/** Подписка на изменения auth state. Возвращает функцию отписки. */
export function onAuthStateChange(callback) {
  const { data } = supabase.auth.onAuthStateChange(callback);
  return () => data?.subscription?.unsubscribe?.();
}

/** Возвращает уже созданный Supabase-клиент. Удобный геттер для модулей, которым
 *  нужен прямой доступ (например, для realtime-подписок). */
export function getSupabaseClient() {
  return supabase;
}

// Алиасы для обратной совместимости со старым кодом, если он где-то остался
export const signInWithPassword = signInWithEmail;
export const signUpWithPassword = signUpWithEmail;
export const signOut = signOutUser;
