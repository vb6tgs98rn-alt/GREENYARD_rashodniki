/**
 * supabase-client.js
 * Единственное место, где создаётся Supabase клиент.
 */
import { createClient } from '@supabase/supabase-js';
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
    email: email.trim().toLowerCase(),
    password,
  });
  return { user: data?.user ?? null, error };
}

/** Зарегистрироваться по email + пароль */
export async function signUpWithPassword(email, password) {
  const { data, error } = await supabase.auth.signUp({
    email: email.trim().toLowerCase(),
    password,
  });
  return { user: data?.user ?? null, error };
}

/** Выйти */
export async function signOut() {
  await supabase.auth.signOut();
}

/** Текущий пользователь или null */
export async function getCurrentUser() {
  const { data } = await supabase.auth.getUser();
  return data?.user ?? null;
}

/** Текущая сессия или null */
export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data?.session ?? null;
}

/** Подписка на изменения auth state */
export function onAuthStateChange(callback) {
  const { data: { subscription } } = supabase.auth.onAuthStateChange(callback);
  return () => subscription.unsubscribe();
}
