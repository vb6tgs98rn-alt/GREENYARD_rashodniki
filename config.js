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
 * config.js — конфигурация приложения Green Yard.
 * Если когда-нибудь добавите сборщик с env — замените на import.meta.env.VITE_*.
 */
export const SUPABASE_URL = 'https://wpwuxcxmtvdxftqrrxuu.supabase.co';
export const SUPABASE_ANON_KEY = 'sb_publishable_Wz2pHnvpDP0GcWZnWUOoGw_ETW8-v59';

/** Имя таблицы для хранения состояний пользователей (соответствует SQL: public.app_state) */
export const USER_STATES_TABLE = 'app_state';

/** Ключ localStorage для автосохранения */
export const LOCAL_STORAGE_KEY = 'green-yard-refactor-v2';
