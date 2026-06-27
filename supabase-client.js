/**
 * supabase-client.js
 * Единственное место, где создаётся Supabase клиент.
 * Загружаем SDK прямо с ESM CDN — никакого бандлера не требуется.
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

// ─── Auth helpers ─────────────────────────────────────────────────────────────

/** Войти по email + пароль */
export async function signInWithPassword(email, password) {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: String(email || '').trim().toLowerCase(),
    password,
  });
  return { user: data?.user ?? null, error };
}

/** Зарегистрироваться по email + пароль */
export async function signUpWithPassword(email, password) {
  const { data, error } = await supabase.auth.signUp({
    email: String(email || '').trim().toLowerCase(),
    password,
  });
  return { user: data?.user ?? null, error };
}

/** Выйти */
export async function signOut() {
  try {
    await supabase.auth.signOut();
  } catch (e) {
    // глушим сетевые ошибки, локальный режим должен жить дальше
    console.warn('[auth] signOut error:', e);
  }
}

/** Текущий пользователь или null. Не бросает исключений. */
export async function getCurrentUser() {
  try {
    const { data } = await supabase.auth.getUser();
    return data?.user ?? null;
  } catch (e) {
    console.warn('[auth] getCurrentUser error:', e);
    return null;
  }
}

/** Текущая сессия или null. Не бросает исключений. */
export async function getSession() {
  try {
    const { data } = await supabase.auth.getSession();
    return data?.session ?? null;
  } catch (e) {
    console.warn('[auth] getSession error:', e);
    return null;
  }
}

/** Подписка на изменения auth state */
export function onAuthStateChange(callback) {
  const { data } = supabase.auth.onAuthStateChange(callback);
  return () => data?.subscription?.unsubscribe?.();
}
