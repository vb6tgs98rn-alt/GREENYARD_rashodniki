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
    detectSessionInUrl: true,
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

/** Возвращает текущего пользователя, дождавшись готовности сессии. */
export async function requireUser() {
  await _authReadyPromise;
  if (_currentUser) return _currentUser;
  const { data } = await supabase.auth.getSession();
  return data?.session?.user ?? null;
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
