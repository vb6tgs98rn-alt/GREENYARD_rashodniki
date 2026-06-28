/**
 * app.js — единая точка входа.
 *
 * Контракт:
 *  - init() выполняется ровно ОДИН раз после готовности DOM.
 *  - bindEvents() вызывается ровно ОДИН раз.
 *  - onAuthStateChange только переключает storage mode, грузит/инициализирует state
 *    и зовёт render(). Никаких re-bindEvents.
 *  - Любая сетевая/Supabase-ошибка НЕ роняет UI: localStorage всегда есть как fallback.
 *
 * КРИТИЧЕСКИ ВАЖНО: правильный порядок после входа (SIGNED_IN):
 *   1. setHydrating(true) — БЛОКИРУЕМ любые persistState() / syncToApi()
 *   2. setStorageMode('cloud', user) — режим переключается, но запись ВСЁ РАВНО заблокирована флагом
 *   3. fetchCloudState() — узнаём, есть ли запись в облаке для этого user_id
 *      • found=true  → setState(cloud.state); НЕ пишем ничего обратно. Просто render().
 *      • found=false → setState(createDefaultState()); только теперь — первичная миграция в облако.
 *      • ok=false (сеть/ошибка) → НЕ трогаем state в облаке, оставляем UI в default, сообщаем об ошибке.
 *   4. setHydrating(false) — разблокируем persistState() для дальнейшей нормальной работы.
 *
 * Это гарантирует, что фоновые persistState() из render/events НЕ затрут облачные
 * данные пользователя дефолтным/гостевым state'ом.
 */

import { createDefaultState, ensureStateShape, getState, setState, updateState } from './state.js';
import {
  loadInitialState,
  persistState,
  setStorageMode,
  fetchCloudState,
  syncToApi,
  getStorageMode,
  setHydrating,
  writeLocalCache,
} from './storage.js';
import { render, setStatus, renderAuthStatus, renderStorageBadge } from './render.js';
import { bindEvents } from './events.js';
import { ensureFinanceGeneratedForCurrentMonth, applyRealtyCalendarBookings } from './finance.js';
import { getCurrentUser, onAuthStateChange, getSupabaseClient } from './supabase-client.js';
import {
  fetchRealtyCalendarBookings,
  fetchRealtyCalendarLog,
  fetchRealtyCalendarIntegration,
} from './api.js';

// ─── Защита от двойной инициализации ───────────────────────────────────────
let booted = false;
let authBusy = false;
let rcRealtimeChannel = null;
let rcCurrentUserId = null;

// ─── Основная инициализация ────────────────────────────────────────────────
async function init() {
  if (booted) return;
  booted = true;

  try {
    // 1. Кто залогинен (может быть null)
    let user = null;
    try { user = await getCurrentUser(); } catch (e) { console.warn('[init] getCurrentUser:', e); }

    if (user) {
      // ── Старт ПРИ УЖЕ ВОШЕДШЕМ пользователе (страница перезагружена) ───────
      // Используем тот же безопасный бутстрап что и для SIGNED_IN.
      await bootstrapForSignedInUser(user, { firstBoot: true });
    } else {
      // ── Старт БЕЗ авторизации ─────────────────────────────────────────────
      const loaded = await loadInitialState(setStatus).catch((e) => {
        console.warn('[init] loadInitialState failed:', e);
        return false;
      });
      if (!loaded) {
        setState(createDefaultState());
      } else {
        setState(ensureStateShape(getState()));
      }
      ensureFinanceGeneratedForCurrentMonth();
      bindEvents();
      render();
      renderAuthStatus(null);
      renderStorageBadge('local');
      // Если ничего не загрузилось — сохраняем дефолт локально (mode='local',
      // флаг hydrating не выставлен — persistState отработает в локалку).
      if (!loaded) {
        await persistState(setStatus, true).catch(() => {});
      }
    }

    // 6. Подписка на дальнейшие auth-события (login/logout уже после старта)
    onAuthStateChange(handleAuthChange);
  } catch (e) {
    console.error('[init] fatal:', e);
    // Минимальный fallback — UI должен жить
    try {
      setHydrating(false);
      setState(createDefaultState());
      setStorageMode('local', null);
      bindEvents();
      render();
      renderAuthStatus(null);
      renderStorageBadge('local');
      setStatus('Ошибка инициализации, работаем локально');
    } catch (e2) {
      console.error('[init] fallback also failed:', e2);
    }
  }
}

/**
 * Безопасный бутстрап для уже-вошедшего пользователя:
 * - блокирует все записи через флаг hydrating;
 * - читает облако;
 * - если запись есть — использует её как источник истины;
 * - если записи нет — создаёт default и ОДИН раз делает миграцию в облако;
 * - снимает флаг только после того, как state в памяти отражает облако.
 *
 * @param {object} user
 * @param {object} opts
 * @param {boolean} opts.firstBoot - true при первой инициализации страницы,
 *                                   false при SIGNED_IN после взаимодействия.
 */
async function bootstrapForSignedInUser(user, { firstBoot = false } = {}) {
  // 1. ЖЁСТКАЯ блокировка любых сохранений до завершения бутстрапа
  setHydrating(true);
  setStorageMode('cloud', user);

  try {
    setStatus('Загружаем данные аккаунта...');
    const res = await fetchCloudState(setStatus);

    if (res.ok && res.found) {
      // 2a. В облаке есть запись — это источник истины. Просто показываем её.
      setState(ensureStateShape(res.state));
      ensureFinanceGeneratedForCurrentMonth();
      // Обновляем локальный кэш (обход флага — это безопасно, пишем ОБЛАЧНЫЕ данные)
      try { writeLocalCache(); } catch (e) { console.warn('[bootstrap] writeLocalCache:', e); }
      setStatus('Данные аккаунта загружены из облака');
    } else if (res.ok && !res.found) {
      // 2b. Запись для этого user_id отсутствует — новый аккаунт.
      //     Стартуем с чистого default. Локальный гостевой кэш НЕ подмешиваем.
      setState(createDefaultState());
      ensureFinanceGeneratedForCurrentMonth();
      setStatus('Добро пожаловать. Аккаунт пуст, начнём с чистого листа.');

      // ВРЕМЕННО снимаем флаг ТОЛЬКО ДЛЯ ОДНОЙ записи — первичной миграции —
      // и сразу возвращаем обратно. Так гарантируем, что между записью и
      // снятием флага ничто другое не успеет упсертнуть свой state.
      setHydrating(false);
      try {
        await syncToApi(setStatus, true);
      } catch (e) {
        console.warn('[bootstrap] initial cloud upsert failed:', e);
      }
      setHydrating(true);
    } else {
      // 2c. Ошибка сети/чтения. КРИТИЧЕСКИ ВАЖНО: НЕ перезаписывать облако
      //     дефолтным state'ом. Просто показываем default в UI и ждём, пока
      //     пользователь обновит страницу или сеть восстановится.
      console.warn('[bootstrap] cloud read failed, NOT touching cloud:', res.error);
      setState(createDefaultState());
      ensureFinanceGeneratedForCurrentMonth();
      setStatus('Не удалось загрузить данные из облака. Не редактируйте — обновите страницу.');
    }

    // 3. Bind events — только если ещё не сделано (при firstBoot)
    if (firstBoot) bindEvents();

    // 4. Рендер с уже корректным state
    render();
    renderAuthStatus(user);
    renderStorageBadge('cloud');
  } finally {
    // 5. Снимаем блокировку — с этого момента persistState() снова работает,
    //    и любые правки пользователя начнут сохраняться в облако (источник истины).
    setHydrating(false);
  }

  // 6. Поднимаем интеграцию с RealtyCalendar: тянем существующие брони/лог,
  //    подписываемся на realtime-обновления rc_bookings. Не блокирует UI.
  bootstrapRealtyCalendar(user).catch((e) => {
    console.warn('[bootstrap] RealtyCalendar bootstrap failed:', e);
  });
}


// ─── RealtyCalendar bootstrap ──────────────────────────────────────────────
/**
 * Подтягивает интеграцию RealtyCalendar для текущего пользователя и подписывается
 * на realtime-обновления rc_bookings. Любые ошибки гасятся в консоль —
 * это вспомогательная фича, она не должна ронять основной UI.
 *
 * @param {object} user
 */
async function bootstrapRealtyCalendar(user) {
  if (!user || !user.id) return;

  // Если для этого же пользователя уже подняли подписку — ничего не делаем.
  if (rcRealtimeChannel && rcCurrentUserId === user.id) return;

  // Если была подписка для другого пользователя — снимаем.
  await teardownRealtyCalendar();

  rcCurrentUserId = user.id;

  // 1. Первичная загрузка данных интеграции
  await refreshRealtyCalendarData();

  // 2. Подписка на realtime: любые изменения rc_bookings → перечитываем и применяем
  try {
    const supabase = getSupabaseClient();
    if (!supabase) return;

    const channelName = 'rc_bookings_user_' + user.id;
    rcRealtimeChannel = supabase
      .channel(channelName)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'rc_bookings',
          filter: 'user_id=eq.' + user.id,
        },
        () => {
          refreshRealtyCalendarData().catch((e) => {
            console.warn('[rc] realtime refresh failed:', e);
          });
        },
      )
      .subscribe();
  } catch (e) {
    console.warn('[rc] realtime subscribe failed:', e);
  }
}

/**
 * Снимает realtime-подписку и сбрасывает локальные ссылки.
 */
async function teardownRealtyCalendar() {
  if (!rcRealtimeChannel) {
    rcCurrentUserId = null;
    return;
  }
  try {
    const supabase = getSupabaseClient();
    if (supabase && rcRealtimeChannel) {
      await supabase.removeChannel(rcRealtimeChannel);
    }
  } catch (e) {
    console.warn('[rc] removeChannel failed:', e);
  } finally {
    rcRealtimeChannel = null;
    rcCurrentUserId = null;
  }
}

/**
 * Загружает свежие данные RC из Supabase и применяет к state:
 *  - integrations.realtycalendar = настройки интеграции (agency_id, last_event_at)
 *  - rcBookings = массив броней
 *  - rcLog = последние записи webhook log
 * После обновления state — финансы пересчитываются через applyRealtyCalendarBookings,
 * затем выполняется render().
 */
async function refreshRealtyCalendarData() {
  try {
    const [integration, bookings, log] = await Promise.all([
      fetchRealtyCalendarIntegration().catch(() => null),
      fetchRealtyCalendarBookings(500).catch(() => []),
      fetchRealtyCalendarLog(50).catch(() => []),
    ]);

    updateState((s) => {
      if (!s.integrations) s.integrations = {};
      const prev = s.integrations.realtycalendar || { connected: false, agencyId: '', lastEventAt: null };
      if (integration && integration.agency_id) {
        s.integrations.realtycalendar = {
          ...prev,
          connected: true,
          agencyId: String(integration.agency_id),
          lastEventAt: integration.last_event_at || prev.lastEventAt || null,
          recentLog: Array.isArray(log) ? log : [],
        };
      } else {
        s.integrations.realtycalendar = {
          ...prev,
          connected: false,
          agencyId: '',
          lastEventAt: null,
          recentLog: Array.isArray(log) ? log : [],
        };
      }
    });

    // Пересчитываем финансовые записи из RC-броней
    try {
      applyRealtyCalendarBookings(Array.isArray(bookings) ? bookings : []);
    } catch (e) {
      console.warn('[rc] applyRealtyCalendarBookings failed:', e);
    }

    render();
  } catch (e) {
    console.warn('[rc] refresh failed:', e);
  }
}

// ─── Auth state machine ────────────────────────────────────────────────────
async function handleAuthChange(event, session) {
  // TOKEN_REFRESHED / USER_UPDATED — фон, нас не касается
  if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') return;
  if (authBusy) return;
  authBusy = true;

  const user = session?.user ?? null;

  try {
    if (event === 'SIGNED_IN') {
      await bootstrapForSignedInUser(user, { firstBoot: false });
    } else if (event === 'SIGNED_OUT') {
      // Возвращаемся в гостевой режим и сбрасываем UI к виду "первого входа":
      // state = default, localStorage перезаписывается дефолтом, чтобы данные
      // предыдущего аккаунта не остались в браузере. ОБЛАЧНЫЕ данные пользователя
      // остаются нетронутыми — они подтянутся при следующем входе в этот аккаунт.
      await teardownRealtyCalendar().catch(() => {});
      setStorageMode('local', null);
      setState(createDefaultState());
      ensureFinanceGeneratedForCurrentMonth();
      // persistState теперь пишет ТОЛЬКО локально (mode='local', user=null),
      // и упсерта в облако точно не случится.
      await persistState(setStatus, true).catch(() => {});
      render();
      renderAuthStatus(null);
      renderStorageBadge('local');
      setStatus('Вы вышли. Данные аккаунта остались в облаке.');
    } else if (event === 'INITIAL_SESSION') {
      // Эмитится один раз при подписке. UI уже выставлен init()'ом —
      // просто синхронизируем визуальные индикаторы.
      renderAuthStatus(user);
      renderStorageBadge(getStorageMode());
    }
  } catch (e) {
    console.error('[auth] handler error:', e);
    setStatus('Ошибка авторизации, продолжаем локально');
  } finally {
    authBusy = false;
  }
}

// ─── Запуск ────────────────────────────────────────────────────────────────
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
