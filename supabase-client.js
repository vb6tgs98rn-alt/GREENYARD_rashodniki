/**
 * supabase-client.js
 * Единственное место, где создаётся Supabase клиент.
 * Все остальные модули импортируют { supabase } отсюда.
 */
import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    // Сессия хранится в localStorage под ключом supabase.auth.token
    storageKey: 'gy-auth-session',
  },
});

// ─── Auth helpers ────────────────────────────────────────────────────────────

/**
 * Войти через magic link (OTP) — письмо с кнопкой-ссылкой.
 * @param {string} email
 * @returns {{ error: Error|null }}
 */
export async function signInWithEmail(email) {
  const { error } = await supabase.auth.signInWithOtp({
    email: email.trim().toLowerCase(),
    options: { shouldCreateUser: true },
  });
  return { error };
}

/**
 * Выйти из аккаунта.
 */
export async function signOut() {
  await supabase.auth.signOut();
}

/**
 * Получить текущего аутентифицированного пользователя или null.
 * @returns {Promise<import('@supabase/supabase-js').User|null>}
 */
export async function getCurrentUser() {
  const { data } = await supabase.auth.getUser();
  return data?.user ?? null;
}

/**
 * Получить текущую сессию или null.
 * @returns {Promise<import('@supabase/supabase-js').Session|null>}
 */
export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data?.session ?? null;
}

/**
 * Подписаться на изменения состояния авторизации.
 * @param {(event: string, session: object|null) => void} callback
 * @returns {() => void} функция отписки
 */
export function onAuthStateChange(callback) {
  const { data: { subscription } } = supabase.auth.onAuthStateChange(callback);
  return () => subscription.unsubscribe();
}
