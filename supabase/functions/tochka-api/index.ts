/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 *
 * Копирование, распространение, переработка и обратная разработка
 * (reverse engineering) запрещены без письменного разрешения правообладателя.
 * Условия: см. файл LICENSE. Нарушение влечёт ответственность по ст. 1252,
 * 1301 ГК РФ.
 */
// Edge Function: интеграция с Точка Банком (v1).
//
// Маршруты:
//   GET  /status      — статус подключения арендодателя (JWT приложения)
//   POST /connect     — начать подключение, вернуть ссылку подтверждения
//   GET  /callback    — возврат из Точки после подтверждения разрешений
//   POST /disconnect  — отключить Точку
//   POST /pay         — создать/получить ссылку на оплату по брони
//   GET  /payments    — платежи по брони
//   POST /refresh     — обновить справочники (счёт, ТСП) и вебхук
//   POST /poll        — сверить статусы неоплаченных ссылок
//   ANY  /webhook     — вебхук Точки (тело — JWT, подпись RS256)
//   GET  /            — пинг
//
// Секреты (client_id/client_secret приложения и токены клиентов) живут
// только на сервере: в переменных окружения и таблице tochka_connections,
// у которой нет ни одной RLS-политики, то есть доступ имеет лишь service_role.
//
// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import {
  APP_URL,
  buildAuthorizeUrl,
  collectStrings,
  createConsent,
  discoverIdentifiers,
  exchangeCode,
  getAppToken,
  getPaymentStatus,
  getQrStatus,
  loadConnection,
  mapStatus,
  type PaymentMethod,
  registerWebhook,
  TOCHKA_CLIENT_ID,
  TOCHKA_CLIENT_SECRET,
  TOCHKA_REDIRECT_URI,
  tokenPatch,
  verifyWebhook,
} from "../_shared/tochka.ts";
import { ensureBookingPayment } from "../_shared/tochka_booking.ts";
import { htmlEscape, sendMessage } from "../_shared/channels.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function json(body: any, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

function svc() {
  return createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Определяет пользователя по его JWT из приложения. */
async function userIdFromJwt(req: Request): Promise<string | null> {
  const auth = req.headers.get("authorization") || req.headers.get("Authorization");
  if (!auth) return null;
  try {
    const client = createClient(SUPABASE_URL, SERVICE_ROLE, {
      global: { headers: { Authorization: auth } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data, error } = await client.auth.getUser();
    if (error || !data?.user) return null;
    return data.user.id;
  } catch (_e) {
    return null;
  }
}

/** Уведомление арендодателю в его мессенджер. */
async function notifyManager(sb: any, userId: string, text: string): Promise<void> {
  try {
    const { data: ms } = await sb
      .from("manager_settings")
      .select("manager_tg_chat_id, manager_channel, manager_channel_chat_id")
      .eq("user_id", userId)
      .maybeSingle();
    if (!ms) return;
    const channel = String(ms.manager_channel || "telegram");
    const chatId = ms.manager_channel_chat_id ||
      (channel === "telegram" ? ms.manager_tg_chat_id : null);
    if (!chatId) return;
    await sendMessage({ channel: channel as any, chatId: String(chatId) }, text);
  } catch (e) {
    console.error("[tochka] не удалось уведомить менеджера:", (e as Error).message);
  }
}

// ───────────────────────────────────────────────────────────────
// Подключение по OAuth 2.0
// ───────────────────────────────────────────────────────────────

async function handleConnect(req: Request): Promise<Response> {
  const userId = await userIdFromJwt(req);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 401);
  if (!TOCHKA_CLIENT_ID || !TOCHKA_CLIENT_SECRET) {
    return json({
      ok: false,
      error: "not_configured",
      message: "Не заданы TOCHKA_CLIENT_ID и TOCHKA_CLIENT_SECRET приложения.",
    }, 503);
  }

  const sb = svc();
  try {
    const appToken = await getAppToken();
    const consentId = await createConsent(appToken);
    const state = crypto.randomUUID();

    await sb.from("tochka_connections").upsert({
      user_id: userId,
      status: "pending",
      consent_id: consentId,
      oauth_state: state,
      oauth_state_at: new Date().toISOString(),
      last_error: null,
    }, { onConflict: "user_id" });

    return json({ ok: true, url: buildAuthorizeUrl(consentId, state), consent_id: consentId });
  } catch (e) {
    const message = String((e as Error).message || e).slice(0, 500);
    console.error("[tochka] connect:", message);
    await sb.from("tochka_connections").upsert({
      user_id: userId,
      status: "error",
      last_error: message,
    }, { onConflict: "user_id" });
    return json({ ok: false, error: "connect_failed", message }, 502);
  }
}

/** Страница-заглушка после возврата из Точки. */
function callbackPage(title: string, text: string, ok: boolean): Response {
  const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${htmlEscape(title)}</title>
<style>
 body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#f6f7f9;margin:0;
      display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
 .card{background:#fff;border-radius:16px;padding:32px;max-width:420px;box-shadow:0 6px 24px rgba(0,0,0,.08);text-align:center}
 h1{font-size:20px;margin:0 0 12px;color:${ok ? "#0f7b3f" : "#b3261e"}}
 p{color:#444;line-height:1.5;margin:0 0 20px}
 a{display:inline-block;background:#0f7b3f;color:#fff;text-decoration:none;padding:10px 20px;border-radius:10px}
</style></head><body><div class="card">
<h1>${htmlEscape(title)}</h1><p>${htmlEscape(text)}</p>
<a href="${htmlEscape(APP_URL)}">Вернуться в приложение</a>
</div></body></html>`;
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

async function handleCallback(url: URL): Promise<Response> {
  const code = url.searchParams.get("code") || "";
  const state = url.searchParams.get("state") || "";
  if (!code || !state) {
    return callbackPage("Подключение не завершено", "Точка не передала код авторизации.", false);
  }

  const sb = svc();
  const { data: conn } = await sb
    .from("tochka_connections")
    .select("*")
    .eq("oauth_state", state)
    .maybeSingle();

  if (!conn) {
    return callbackPage("Подключение не завершено", "Ссылка устарела. Начните подключение заново.", false);
  }
  // state живёт 15 минут — этого хватает на подтверждение разрешений.
  const stateAge = conn.oauth_state_at ? Date.now() - new Date(conn.oauth_state_at).getTime() : Infinity;
  if (stateAge > 15 * 60 * 1000) {
    return callbackPage("Подключение не завершено", "Время подтверждения истекло. Начните заново.", false);
  }

  try {
    const tokens = await exchangeCode(code);
    const patch = tokenPatch(tokens);
    await sb.from("tochka_connections").update({
      ...patch,
      status: "connected",
      scope: tokens?.scope ?? null,
      oauth_state: null,
      oauth_state_at: null,
      last_error: null,
      connected_at: new Date().toISOString(),
    }).eq("user_id", conn.user_id);

    // Справочники и подписка на вебхук — уже от имени клиента.
    const fresh = await loadConnection(sb, conn.user_id);
    if (fresh) {
      const ids = await discoverIdentifiers(sb, fresh);
      if (Object.keys(ids).length) {
        await sb.from("tochka_connections").update(ids).eq("user_id", conn.user_id);
        Object.assign(fresh, ids);
      }
      const hookUrl = `${SUPABASE_URL}/functions/v1/tochka-api/webhook`;
      try {
        await registerWebhook(sb, fresh, hookUrl);
        await sb.from("tochka_connections").update({
          webhook_url: hookUrl,
          webhook_registered_at: new Date().toISOString(),
        }).eq("user_id", conn.user_id);
      } catch (e) {
        const message = String((e as Error).message || e).slice(0, 300);
        console.error("[tochka] вебхук не зарегистрирован:", message);
        await sb.from("tochka_connections").update({
          last_error: `Вебхук не зарегистрирован: ${message}`,
        }).eq("user_id", conn.user_id);
      }
    }

    await notifyManager(sb, conn.user_id, "✅ Точка Банк подключена. Теперь бот сможет отправлять гостям ссылку на оплату.");
    return callbackPage("Точка Банк подключена", "Можно вернуться в приложение и включить отправку оплаты гостям.", true);
  } catch (e) {
    const message = String((e as Error).message || e).slice(0, 400);
    console.error("[tochka] callback:", message);
    await sb.from("tochka_connections").update({
      status: "error",
      last_error: message,
      oauth_state: null,
    }).eq("user_id", conn.user_id);
    return callbackPage("Подключение не удалось", "Банк отклонил обмен кода на токен. Попробуйте ещё раз.", false);
  }
}

async function handleStatus(req: Request): Promise<Response> {
  const userId = await userIdFromJwt(req);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 401);

  const sb = svc();
  const conn = await loadConnection(sb, userId);
  if (!conn) {
    return json({ ok: true, status: "disconnected", configured: Boolean(TOCHKA_CLIENT_ID) });
  }
  // Токены наружу не отдаём никогда — только признаки готовности.
  return json({
    ok: true,
    configured: Boolean(TOCHKA_CLIENT_ID),
    status: conn.status,
    customer_code: conn.customer_code,
    account_id: conn.account_id,
    has_acquiring: Boolean(conn.acquiring_merchant_id),
    has_sbp: Boolean(conn.sbp_merchant_id),
    webhook_ok: Boolean(conn.webhook_registered_at),
    connected_at: conn.connected_at,
    token_valid_until: conn.access_expires_at,
    last_error: conn.last_error,
  });
}

async function handleDisconnect(req: Request): Promise<Response> {
  const userId = await userIdFromJwt(req);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 401);
  const sb = svc();
  await sb.from("tochka_connections").delete().eq("user_id", userId);
  await sb.from("manager_settings").update({ tochka_enabled: false }).eq("user_id", userId);
  return json({ ok: true });
}

/** Пересобирает справочники и переподписывает вебхук. */
async function handleRefresh(req: Request): Promise<Response> {
  const userId = await userIdFromJwt(req);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 401);

  const sb = svc();
  const conn = await loadConnection(sb, userId);
  if (!conn || conn.status !== "connected") {
    return json({ ok: false, error: "not_connected" }, 409);
  }
  try {
    const ids = await discoverIdentifiers(sb, conn);
    if (Object.keys(ids).length) {
      await sb.from("tochka_connections").update(ids).eq("user_id", userId);
      Object.assign(conn, ids);
    }
    const hookUrl = `${SUPABASE_URL}/functions/v1/tochka-api/webhook`;
    await registerWebhook(sb, conn, hookUrl);
    await sb.from("tochka_connections").update({
      webhook_url: hookUrl,
      webhook_registered_at: new Date().toISOString(),
      last_error: null,
    }).eq("user_id", userId);
    return json({
      ok: true,
      has_acquiring: Boolean(conn.acquiring_merchant_id),
      has_sbp: Boolean(conn.sbp_merchant_id),
    });
  } catch (e) {
    const message = String((e as Error).message || e).slice(0, 400);
    return json({ ok: false, error: "refresh_failed", message }, 502);
  }
}

// ───────────────────────────────────────────────────────────────
// Оплата
// ───────────────────────────────────────────────────────────────

async function handlePay(req: Request): Promise<Response> {
  const userId = await userIdFromJwt(req);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 401);

  let body: any = {};
  try {
    body = await req.json();
  } catch (_e) { /* пустое тело допустимо */ }
  const bookingId = Number(body?.booking_id || 0);
  if (!bookingId) return json({ ok: false, error: "booking_id_required" }, 400);

  const sb = svc();
  const res = await ensureBookingPayment(sb, userId, bookingId, { force: Boolean(body?.force) });
  const status = res.kind === "error" ? 502 : 200;
  return json({ ok: res.kind !== "error", ...res }, status);
}

async function handlePayments(req: Request, url: URL): Promise<Response> {
  const userId = await userIdFromJwt(req);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 401);

  const sb = svc();
  let q = sb.from("tochka_payments")
    .select("id, booking_id, method, amount, status, pay_url, paid_at, expires_at, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(200);
  const bookingId = url.searchParams.get("booking_id");
  if (bookingId) q = q.eq("booking_id", Number(bookingId));
  const { data, error } = await q;
  if (error) {
    console.error("[tochka] список платежей:", error.message);
    return json({ ok: false, error: "query_failed", message: error.message }, 500);
  }
  return json({ ok: true, items: data ?? [] });
}

/** Отмечает платёж оплаченным и уведомляет арендодателя. */
async function markPaid(sb: any, payment: any, source: string): Promise<void> {
  if (payment.status === "paid") return;
  await sb.from("tochka_payments").update({
    status: "paid",
    paid_at: new Date().toISOString(),
  }).eq("id", payment.id);

  const sum = Number(payment.amount).toLocaleString("ru-RU", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  await notifyManager(
    sb,
    payment.user_id,
    `💰 Гость оплатил проживание: <b>${htmlEscape(sum)} ₽</b>\nБронь: <code>${htmlEscape(String(payment.booking_id))}</code>`,
  );
  console.log(`[tochka] платёж ${payment.id} оплачен (${source})`);
}

/**
 * Вебхук Точки. Тело — строка JWT с подписью RS256.
 * Отвечаем 200 всегда, когда запрос корректно разобран: иначе банк будет
 * повторять доставку 30 раз. При создании вебхука Точка проверяет
 * доступность URL тестовым запросом — на него тоже отвечаем 200.
 */
async function handleWebhook(req: Request): Promise<Response> {
  const raw = (await req.text()).trim();
  if (!raw) return json({ ok: true, note: "пустое тело (проверка доступности)" });

  const claims = await verifyWebhook(raw);
  if (!claims) {
    console.error("[tochka] подпись вебхука не сошлась — запрос отклонён");
    return json({ ok: false, error: "bad_signature" }, 401);
  }

  const sb = svc();
  try {
    // В теле события приходят идентификаторы операции. Ищем среди них те,
    // что мы сохранили при создании платежа: так платёж привязывается
    // к брони и арендодателю независимо от имён полей в событии.
    const values = Array.from(collectStrings(claims));
    if (!values.length) return json({ ok: true, note: "нет идентификаторов" });

    const { data: byOperation } = await sb
      .from("tochka_payments")
      .select("*")
      .in("operation_id", values)
      .limit(1);
    const { data: byQrc } = await sb
      .from("tochka_payments")
      .select("*")
      .in("qrc_id", values)
      .limit(1);

    const payment = byOperation?.[0] ?? byQrc?.[0] ?? null;
    if (!payment) {
      console.log("[tochka] вебхук не сопоставлен с платежом");
      return json({ ok: true, note: "платёж не найден" });
    }

    // Не доверяем событию на слово: подтверждаем статус запросом в банк.
    const conn = await loadConnection(sb, payment.user_id);
    if (conn && conn.status === "connected") {
      try {
        const external = payment.operation_id
          ? await getPaymentStatus(sb, conn, payment.operation_id)
          : await getQrStatus(sb, conn, payment.qrc_id);
        const mapped = mapStatus(payment.method as PaymentMethod, external);
        if (mapped === "paid") {
          await markPaid(sb, payment, "вебхук+проверка");
        } else if (mapped !== "created" && mapped !== payment.status) {
          await sb.from("tochka_payments").update({ status: mapped }).eq("id", payment.id);
        }
        return json({ ok: true, status: mapped });
      } catch (e) {
        console.error("[tochka] проверка статуса не удалась:", (e as Error).message);
      }
    }
    // Если сверка недоступна, доверяем событию: банк присылает вебхуки
    // только об успешных операциях.
    await markPaid(sb, payment, "вебхук");
    return json({ ok: true, status: "paid" });
  } catch (e) {
    console.error("[tochka] обработка вебхука:", (e as Error).message);
    // 200, чтобы банк не долбил повторами — событие уже в логах.
    return json({ ok: true, note: "ошибка обработки записана в логи" });
  }
}

/** Сверяет статусы всех неоплаченных ссылок пользователя. */
async function handlePoll(req: Request): Promise<Response> {
  const userId = await userIdFromJwt(req);
  if (!userId) return json({ ok: false, error: "unauthorized" }, 401);

  const sb = svc();
  const conn = await loadConnection(sb, userId);
  if (!conn || conn.status !== "connected") return json({ ok: false, error: "not_connected" }, 409);

  const { data: list } = await sb
    .from("tochka_payments")
    .select("*")
    .eq("user_id", userId)
    .eq("status", "created")
    .limit(100);

  let updated = 0;
  for (const p of list ?? []) {
    try {
      const external = p.operation_id
        ? await getPaymentStatus(sb, conn, p.operation_id)
        : p.qrc_id
        ? await getQrStatus(sb, conn, p.qrc_id)
        : "";
      if (!external) continue;
      const mapped = mapStatus(p.method as PaymentMethod, external);
      if (mapped === "paid") {
        await markPaid(sb, p, "сверка");
        updated++;
      } else if (mapped !== "created") {
        await sb.from("tochka_payments").update({ status: mapped }).eq("id", p.id);
        updated++;
      }
    } catch (e) {
      console.error("[tochka] сверка платежа:", (e as Error).message);
    }
  }
  return json({ ok: true, checked: (list ?? []).length, updated });
}

// ───────────────────────────────────────────────────────────────
// Маршрутизация
// ───────────────────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
  try {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

    const url = new URL(req.url);
    // Путь вида /functions/v1/tochka-api/<маршрут>
    const route = url.pathname.replace(/^.*\/tochka-api/, "").replace(/\/+$/, "") || "/";

    switch (route) {
      case "/webhook":
        return await handleWebhook(req);
      case "/callback":
        return await handleCallback(url);
      case "/status":
        return await handleStatus(req);
      case "/connect":
        return await handleConnect(req);
      case "/disconnect":
        return await handleDisconnect(req);
      case "/refresh":
        return await handleRefresh(req);
      case "/pay":
        return await handlePay(req);
      case "/payments":
        return await handlePayments(req, url);
      case "/poll":
        return await handlePoll(req);
      case "/":
        return json({
          ok: true,
          service: "tochka-api",
          version: 1,
          configured: Boolean(TOCHKA_CLIENT_ID && TOCHKA_CLIENT_SECRET),
          redirect_uri: TOCHKA_REDIRECT_URI,
        });
      default:
        return json({ ok: false, error: "not_found", route }, 404);
    }
  } catch (e) {
    // Наружу — без деталей; подробности только в серверном логе.
    console.error("[tochka] необработанная ошибка:", (e as Error).message);
    return json({ ok: false, error: "internal_error" }, 500);
  }
});
