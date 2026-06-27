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

/** Текущий пользователь или null. Не бросает. */
export async function getCurrentUser() {
  try {
    const { data } = await supabase.auth.getUser();
    return data?.user ?? null;
  } catch (e) {
    console.warn('[auth] getCurrentUser error:', e);
    return null;
  }
}

/** Текущая сессия или null. Не бросает. */
export async function getSession() {
  try {
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

// Алиасы для обратной совместимости со старым кодом, если он где-то остался
export const signInWithPassword = signInWithEmail;
export const signUpWithPassword = signUpWithEmail;
export const signOut = signOutUser;
