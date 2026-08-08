/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 *
 * Копирование, распространение, переработка и обратная разработка
 * (reverse engineering) запрещены без письменного разрешения правообладателя.
 * Условия: см. файл LICENSE. Нарушение влечёт ответственность по ст. 1252,
 * 1301 ГК РФ.
 */
// Общий модуль работы с API Точка Банка.
//
// SaaS-схема: каждый арендодатель подключает свой счёт по OAuth 2.0,
// деньги гостей идут напрямую ему. Приложение хранит только токены клиента
// (в таблице tochka_connections, доступной исключительно service_role).
// client_id и client_secret самого приложения живут в переменных окружения
// и в браузер не попадают никогда.
//
// Документация: https://developers.tochka.com/docs/tochka-api/
// deno-lint-ignore-file no-explicit-any

// ───────────────────────────────────────────────────────────────
// Окружение
// ───────────────────────────────────────────────────────────────

/** Боевой слой API. Для отладки можно подставить песочницу. */
export const TOCHKA_API_BASE =
  Deno.env.get("TOCHKA_API_BASE") ?? "https://enter.tochka.com/uapi";
/** Хост авторизации OAuth 2.0 (у песочницы отдельного нет). */
export const TOCHKA_AUTH_BASE =
  Deno.env.get("TOCHKA_AUTH_BASE") ?? "https://enter.tochka.com";

export const TOCHKA_CLIENT_ID = Deno.env.get("TOCHKA_CLIENT_ID") ?? "";
export const TOCHKA_CLIENT_SECRET = Deno.env.get("TOCHKA_CLIENT_SECRET") ?? "";

/** Адрес, куда Точка возвращает клиента после подтверждения разрешений. */
export const TOCHKA_REDIRECT_URI = Deno.env.get("TOCHKA_REDIRECT_URI") ??
  `${Deno.env.get("SUPABASE_URL") ?? ""}/functions/v1/tochka-api/callback`;

/** Адрес приложения — на него возвращаем арендодателя после подключения. */
export const APP_URL = Deno.env.get("APP_URL") ??
  "https://vb6tgs98rn-alt.github.io/GREENYARD_rashodniki/";

/** Публичные ключи Точки для проверки подписи вебхуков. */
export const TOCHKA_JWKS_URL = "https://enter.tochka.com/doc/openapi/static/keys/public";

/** Области доступа. Одинаковый набор во всех запросах одного потока OAuth. */
export const TOCHKA_SCOPE = "accounts balances customers statements sbp payments acquiring";

/** Разрешения, которые подтверждает арендодатель. */
export const TOCHKA_PERMISSIONS = [
  "ReadAccountsBasic",
  "ReadAccountsDetail",
  "ReadBalances",
  "ReadCustomerData",
  "ReadSBPData",
  "EditSBPData",
  "ReadAcquiringData",
  "MakeAcquiringOperation",
  "ManageWebhookData",
];

/** Способы оплаты, которые арендодатель выбирает в настройках. */
export type PaymentMethod = "payment_link" | "sbp_qr" | "requisites";

export interface TochkaConnection {
  user_id: string;
  status: string;
  customer_code: string | null;
  account_id: string | null;
  acquiring_merchant_id: string | null;
  sbp_merchant_id: string | null;
  sbp_legal_id: string | null;
  consent_id: string | null;
  oauth_state: string | null;
  oauth_state_at: string | null;
  scope: string | null;
  access_token: string | null;
  refresh_token: string | null;
  access_expires_at: string | null;
  refresh_expires_at: string | null;
  webhook_url: string | null;
  webhook_registered_at: string | null;
  last_error: string | null;
  connected_at: string | null;
}

// ───────────────────────────────────────────────────────────────
// Низкоуровневые запросы
// ───────────────────────────────────────────────────────────────

/** Запрос с таймаутом: висящее соединение не должно держать функцию. */
async function fetchWithTimeout(url: string, init: RequestInit, ms = 20000): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Ошибка вызова API Точки: несёт статус и текст ответа для логов. */
export class TochkaError extends Error {
  readonly status: number;
  readonly body: string;
  constructor(status: number, body: string) {
    super(`Точка API ${status}: ${body.slice(0, 500)}`);
    this.name = "TochkaError";
    this.status = status;
    this.body = body;
  }
}

/** Запрос к OAuth-эндпоинту /connect/token. */
async function connectToken(form: Record<string, string>): Promise<any> {
  const body = new URLSearchParams(form);
  const r = await fetchWithTimeout(`${TOCHKA_AUTH_BASE}/connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const text = await r.text();
  if (!r.ok) throw new TochkaError(r.status, text);
  return JSON.parse(text);
}

// ───────────────────────────────────────────────────────────────
// OAuth 2.0: подключение арендодателя
// ───────────────────────────────────────────────────────────────

/** Шаг 2: токен приложения для работы со списком разрешений. */
export async function getAppToken(): Promise<string> {
  const data = await connectToken({
    client_id: TOCHKA_CLIENT_ID,
    client_secret: TOCHKA_CLIENT_SECRET,
    grant_type: "client_credentials",
    scope: TOCHKA_SCOPE,
  });
  return String(data.access_token || "");
}

/** Шаг 3: создать список разрешений, вернуть consentId. */
export async function createConsent(appToken: string): Promise<string> {
  const r = await fetchWithTimeout(`${TOCHKA_AUTH_BASE}/uapi/v1.0/consents`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${appToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ Data: { permissions: TOCHKA_PERMISSIONS } }),
  });
  const text = await r.text();
  if (!r.ok) throw new TochkaError(r.status, text);
  const data = JSON.parse(text);
  const id = data?.Data?.consentId ?? data?.consentId ?? "";
  if (!id) throw new TochkaError(r.status, `в ответе нет consentId: ${text.slice(0, 300)}`);
  return String(id);
}

/** Шаг 4: ссылка, по которой арендодатель подтверждает разрешения. */
export function buildAuthorizeUrl(consentId: string, state: string): string {
  const p = new URLSearchParams({
    client_id: TOCHKA_CLIENT_ID,
    response_type: "code",
    state,
    redirect_uri: TOCHKA_REDIRECT_URI,
    scope: TOCHKA_SCOPE,
    consent_id: consentId,
  });
  return `${TOCHKA_AUTH_BASE}/connect/authorize?${p.toString()}`;
}

/** Шаг 5: обмен кода авторизации на пару токенов. */
export async function exchangeCode(code: string): Promise<any> {
  return await connectToken({
    client_id: TOCHKA_CLIENT_ID,
    client_secret: TOCHKA_CLIENT_SECRET,
    grant_type: "authorization_code",
    scope: TOCHKA_SCOPE,
    code,
    redirect_uri: TOCHKA_REDIRECT_URI,
  });
}

/** Шаг 6: обновление пары токенов по refresh_token. */
export async function refreshTokens(refreshToken: string): Promise<any> {
  return await connectToken({
    client_id: TOCHKA_CLIENT_ID,
    client_secret: TOCHKA_CLIENT_SECRET,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
}

// ───────────────────────────────────────────────────────────────
// Работа с подключением
// ───────────────────────────────────────────────────────────────

export async function loadConnection(sb: any, userId: string): Promise<TochkaConnection | null> {
  const { data } = await sb
    .from("tochka_connections")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();
  return (data as TochkaConnection) ?? null;
}

/**
 * Возвращает действующий access_token арендодателя.
 * Если срок истекает в ближайшие 5 минут — обновляет пару токенов
 * и сохраняет её. Если refresh_token просрочен, подключение помечается
 * как требующее повторного подтверждения.
 */
export async function ensureAccessToken(sb: any, conn: TochkaConnection): Promise<string> {
  if (!conn.access_token) throw new Error("Точка не подключена: нет токена доступа");

  const expMs = conn.access_expires_at ? new Date(conn.access_expires_at).getTime() : 0;
  if (expMs - Date.now() > 5 * 60 * 1000) return conn.access_token;

  if (!conn.refresh_token) throw new Error("Токен Точки истёк, требуется повторное подключение");

  try {
    const data = await refreshTokens(conn.refresh_token);
    const patch = tokenPatch(data);
    await sb.from("tochka_connections").update(patch).eq("user_id", conn.user_id);
    Object.assign(conn, patch);
    return String(patch.access_token);
  } catch (e) {
    await sb.from("tochka_connections").update({
      status: "error",
      last_error: `Не удалось обновить токен: ${String((e as Error).message).slice(0, 300)}`,
    }).eq("user_id", conn.user_id);
    throw e;
  }
}

/** Из ответа /connect/token собирает поля для сохранения в базу. */
export function tokenPatch(data: any): Record<string, any> {
  const expiresIn = Number(data?.expires_in || 86400);
  return {
    access_token: String(data?.access_token || ""),
    refresh_token: data?.refresh_token ? String(data.refresh_token) : undefined,
    access_expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
    // refresh_token живёт 30 суток
    refresh_expires_at: data?.refresh_token
      ? new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString()
      : undefined,
  };
}

/** Запрос к API Точки от имени арендодателя. */
export async function api(
  sb: any,
  conn: TochkaConnection,
  path: string,
  init: RequestInit = {},
): Promise<any> {
  const token = await ensureAccessToken(sb, conn);
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${token}`,
    "Accept": "application/json",
    ...(init.body ? { "Content-Type": "application/json" } : {}),
    ...(conn.customer_code ? { "customerCode": conn.customer_code } : {}),
    ...(init.headers as Record<string, string> ?? {}),
  };
  const r = await fetchWithTimeout(`${TOCHKA_API_BASE}${path}`, { ...init, headers });
  const text = await r.text();
  if (!r.ok) throw new TochkaError(r.status, text);
  return text ? JSON.parse(text) : {};
}

// ───────────────────────────────────────────────────────────────
// Справочные методы: клиент, счёт, торговые точки
// ───────────────────────────────────────────────────────────────

/** Подтягивает customerCode, accountId и merchantId после подключения. */
export async function discoverIdentifiers(
  sb: any,
  conn: TochkaConnection,
): Promise<Partial<TochkaConnection>> {
  const patch: Partial<TochkaConnection> = {};

  // customerCode — берём компанию (customerType = Business)
  try {
    const cust = await api(sb, conn, "/open-banking/v1.0/customers");
    const list: any[] = cust?.Data?.Customer ?? [];
    const biz = list.find((c) => String(c?.customerType) === "Business") ?? list[0];
    if (biz?.customerCode) {
      patch.customer_code = String(biz.customerCode);
      conn.customer_code = patch.customer_code;
    }
  } catch (e) {
    console.error("[tochka] не удалось получить список клиентов:", (e as Error).message);
  }

  // accountId — первый активный рублёвый счёт
  try {
    const acc = await api(sb, conn, "/open-banking/v1.0/accounts");
    const list: any[] = acc?.Data?.Account ?? [];
    const rub = list.find((a) =>
      String(a?.currency) === "RUB" && String(a?.status) === "Enabled"
    ) ?? list[0];
    if (rub?.accountId) patch.account_id = String(rub.accountId);
  } catch (e) {
    console.error("[tochka] не удалось получить список счетов:", (e as Error).message);
  }

  // merchantId интернет-эквайринга — только точка в статусе REG и активная
  if (patch.customer_code || conn.customer_code) {
    const cc = patch.customer_code ?? conn.customer_code;
    try {
      const ret = await api(
        sb,
        conn,
        `/acquiring/v1.0/retailers?customerCode=${encodeURIComponent(String(cc))}`,
      );
      const list: any[] = ret?.Data?.Retailer ?? [];
      const active = list.find((r) => String(r?.status) === "REG" && r?.isActive === true);
      if (active?.merchantId) patch.acquiring_merchant_id = String(active.merchantId);
    } catch (e) {
      console.error("[tochka] не удалось получить торговые точки:", (e as Error).message);
    }
  }

  // merchantId СБП — через юрлицо в СБП
  try {
    const sbp = await findSbpMerchant(sb, conn);
    if (sbp) {
      patch.sbp_legal_id = sbp.legalId;
      patch.sbp_merchant_id = sbp.merchantId;
    }
  } catch (e) {
    console.error("[tochka] не удалось получить ТСП СБП:", (e as Error).message);
  }

  return patch;
}

/**
 * Ищет действующее ТСП в СБП. Юрлицо в СБП регистрируется отдельно;
 * если оно ещё не заведено, метод вернёт null — тогда QR СБП недоступен,
 * и арендодателю нужно зарегистрировать ТСП (см. регистрацию в интернет-банке).
 */
async function findSbpMerchant(
  sb: any,
  conn: TochkaConnection,
): Promise<{ legalId: string; merchantId: string } | null> {
  let legalId = conn.sbp_legal_id ?? "";
  if (!legalId) {
    // Регистрация юрлица идемпотентна: если оно уже есть, вернётся тот же legalId.
    const reg = await api(sb, conn, "/sbp/v1.0/register-sbp-legal-entity", {
      method: "POST",
      body: JSON.stringify({
        Data: { customerCode: conn.customer_code, bankCode: "044525104" },
      }),
    });
    legalId = String(reg?.Data?.legalId || "");
  }
  if (!legalId) return null;

  const merch = await api(sb, conn, `/sbp/v1.0/merchant/legal-entity/${encodeURIComponent(legalId)}`);
  const list: any[] = merch?.Data?.MerchantList ?? [];
  const active = list.find((m) => String(m?.status) === "Active") ?? list[0];
  if (!active?.merchantId) return null;
  return { legalId, merchantId: String(active.merchantId) };
}

// ───────────────────────────────────────────────────────────────
// Создание платежей
// ───────────────────────────────────────────────────────────────

export interface PaymentRequest {
  amount: number;            // рубли
  purpose: string;           // назначение, видит гость
  ttlMinutes: number;        // срок жизни ссылки/QR
  withReceipt: boolean;      // фискальный чек по 54-ФЗ
  taxSystem: string;         // osn | usn_income | usn_income_outcome | esn | patent
  vatType: string;           // none | vat0 | vat5 | vat7 | vat10 | vat22
  clientName?: string | null;
  clientPhone?: string | null;
  clientEmail?: string | null;
  successUrl?: string | null;
  supplierName?: string | null;
  supplierInn?: string | null;
}

export interface PaymentResult {
  method: PaymentMethod;
  payUrl: string;
  operationId: string | null;
  qrcId: string | null;
  expiresAt: string | null;
  raw: any;
}

/** Приводит телефон к формату +7XXXXXXXXXX. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("8")) d = "7" + d.slice(1);
  if (d.length === 10) d = "7" + d;
  if (d.length !== 11) return null;
  return `+${d}`;
}

/** Платёжная ссылка Точки: карта + СБП, при необходимости с чеком. */
export async function createPaymentLink(
  sb: any,
  conn: TochkaConnection,
  req: PaymentRequest,
): Promise<PaymentResult> {
  if (!conn.customer_code) throw new Error("Не определён customerCode — переподключите Точку");
  if (!conn.acquiring_merchant_id) {
    throw new Error(
      "Интернет-эквайринг не подключён: нет активной торговой точки. " +
        "Подайте заявку в интернет-банке Точки («Сервисы» → «Интернет-эквайринг»).",
    );
  }

  const amount = req.amount.toFixed(2);
  const Data: Record<string, any> = {
    customerCode: conn.customer_code,
    amount,
    purpose: req.purpose,
    paymentMode: ["sbp", "card"],
    merchantId: conn.acquiring_merchant_id,
    preAuthorization: false,
    ttl: req.ttlMinutes,
  };
  if (req.successUrl) {
    Data.redirectUrl = req.successUrl;
    Data.failRedirectUrl = req.successUrl;
  }

  let path = "/acquiring/v1.0/payments";
  if (req.withReceipt) {
    path = "/acquiring/v1.0/payments_with_receipt";
    Data.taxSystemCode = req.taxSystem;
    const client: Record<string, string> = {};
    if (req.clientName) client.name = req.clientName;
    if (req.clientEmail) client.email = req.clientEmail;
    const phone = normalizePhone(req.clientPhone);
    if (phone) client.phone = phone;
    if (Object.keys(client).length) Data.Client = client;

    const supplier: Record<string, string> = {};
    if (req.supplierName) supplier.name = req.supplierName;
    if (req.supplierInn) supplier.taxCode = req.supplierInn;
    const supplierPhone = normalizePhone(req.clientPhone);
    if (Object.keys(supplier).length && supplierPhone) supplier.phone = supplierPhone;

    Data.Items = [{
      name: req.purpose.slice(0, 128),
      amount,
      quantity: 1,
      vatType: req.vatType,
      paymentMethod: "full_payment",
      paymentObject: "service",
      measure: "усл.",
      ...(Object.keys(supplier).length ? { Supplier: supplier } : {}),
    }];
    if (Object.keys(supplier).length) Data.Supplier = supplier;
  }

  const res = await api(sb, conn, path, { method: "POST", body: JSON.stringify({ Data }) });
  const d = res?.Data ?? {};
  const link = String(d.paymentLink || "");
  if (!link) throw new Error("Точка не вернула ссылку на оплату");

  return {
    method: "payment_link",
    payUrl: link,
    operationId: d.operationId ? String(d.operationId) : null,
    qrcId: null,
    expiresAt: new Date(Date.now() + req.ttlMinutes * 60 * 1000).toISOString(),
    raw: res,
  };
}

/** Динамический QR-код СБП. Сумма передаётся в копейках. Чек не формируется. */
export async function createSbpQr(
  sb: any,
  conn: TochkaConnection,
  req: PaymentRequest,
): Promise<PaymentResult> {
  if (!conn.sbp_merchant_id || !conn.account_id) {
    throw new Error(
      "СБП не настроен: нет торговой точки или счёта. Зарегистрируйте ТСП в СБП и переподключите Точку.",
    );
  }
  // ttl QR СБП: от 1 до 129600 минут
  const ttl = Math.min(129600, Math.max(1, Math.round(req.ttlMinutes)));
  const Data: Record<string, any> = {
    amount: Math.round(req.amount * 100), // копейки
    currency: "RUB",
    paymentPurpose: req.purpose.slice(0, 140),
    qrcType: "02", // динамический — оплата ровно один раз
    imageParams: { width: 300, height: 300, mediaType: "image/png" },
    sourceName: "GreenYard",
    ttl,
  };
  if (req.successUrl && req.successUrl.startsWith("https://")) Data.redirectUrl = req.successUrl;

  const path = `/sbp/v1.0/qr-code/merchant/${encodeURIComponent(conn.sbp_merchant_id)}/${
    encodeURIComponent(conn.account_id)
  }`;
  const res = await api(sb, conn, path, { method: "POST", body: JSON.stringify({ Data }) });
  const d = res?.Data ?? {};
  const payload = String(d.payload || "");
  if (!payload) throw new Error("Точка не вернула ссылку QR-кода");

  // Картинку QR не храним: гостю отправляем ссылку payload, она открывает
  // приложение банка. Так надёжнее в мессенджерах и легче для базы.
  const raw = { ...res };
  if (raw?.Data?.image) raw.Data = { ...raw.Data, image: { ...raw.Data.image, content: "<не сохраняем>" } };

  return {
    method: "sbp_qr",
    payUrl: payload,
    operationId: null,
    qrcId: d.qrcId ? String(d.qrcId) : null,
    expiresAt: new Date(Date.now() + ttl * 60 * 1000).toISOString(),
    raw,
  };
}

// ───────────────────────────────────────────────────────────────
// Проверка статуса оплаты
// ───────────────────────────────────────────────────────────────

/** Статус платёжной ссылки. Возвращает статус Точки (APPROVED, EXPIRED и т.д.). */
export async function getPaymentStatus(
  sb: any,
  conn: TochkaConnection,
  operationId: string,
): Promise<string> {
  const res = await api(sb, conn, `/acquiring/v1.0/payments/${encodeURIComponent(operationId)}`);
  const op = res?.Data?.Operation?.[0] ?? res?.Data ?? {};
  return String(op?.status || "");
}

/** Статус оплаты QR СБП: NotStarted, Received, InProgress, Accepted, Rejected. */
export async function getQrStatus(
  sb: any,
  conn: TochkaConnection,
  qrcId: string,
): Promise<string> {
  const res = await api(
    sb,
    conn,
    `/sbp/v1.0/qr-codes/${encodeURIComponent(qrcId)}/payment-status`,
  );
  const list: any[] = res?.Data?.paymentList ?? [];
  return String(list[0]?.status || "");
}

/** Переводит статусы Точки в наши: created / paid / expired / failed / refunded. */
export function mapStatus(method: PaymentMethod, external: string): string {
  const s = String(external).toUpperCase();
  if (method === "sbp_qr") {
    if (s === "ACCEPTED") return "paid";
    if (s === "REJECTED") return "failed";
    return "created";
  }
  if (s === "APPROVED") return "paid";
  if (s === "REFUNDED" || s === "REFUNDED_PARTIALLY") return "refunded";
  if (s === "EXPIRED") return "expired";
  return "created";
}

// ───────────────────────────────────────────────────────────────
// Вебхуки: подписка и проверка подписи
// ───────────────────────────────────────────────────────────────

/**
 * Подписывает арендодателя на вебхуки об оплатах.
 * На один client_id Точка разрешает один URL, но с любым набором событий —
 * поэтому URL у всех клиентов один: наша функция tochka-api/webhook.
 */
export async function registerWebhook(
  sb: any,
  conn: TochkaConnection,
  url: string,
): Promise<void> {
  const body = JSON.stringify({
    webhooksList: ["acquiringInternetPayment", "incomingSbpPayment", "incomingPayment"],
    url,
  });
  await api(sb, conn, `/webhook/v1.0/${encodeURIComponent(TOCHKA_CLIENT_ID)}`, {
    method: "PUT",
    body,
  });
}

let jwksCache: { keys: CryptoKey[]; at: number } | null = null;

/** Загружает публичные ключи Точки (с кешем на час). */
async function loadJwks(): Promise<CryptoKey[]> {
  if (jwksCache && Date.now() - jwksCache.at < 3600_000) return jwksCache.keys;

  const r = await fetchWithTimeout(TOCHKA_JWKS_URL, { headers: { Accept: "application/json" } });
  const text = await r.text();
  if (!r.ok) throw new TochkaError(r.status, text);
  const parsed = JSON.parse(text);
  const raw: any[] = Array.isArray(parsed?.keys) ? parsed.keys : [parsed];

  const keys: CryptoKey[] = [];
  for (const jwk of raw) {
    try {
      keys.push(
        await crypto.subtle.importKey(
          "jwk",
          { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
          { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
          false,
          ["verify"],
        ),
      );
    } catch (e) {
      console.error("[tochka] не удалось разобрать публичный ключ:", (e as Error).message);
    }
  }
  if (!keys.length) throw new Error("Не удалось загрузить публичные ключи Точки");
  jwksCache = { keys, at: Date.now() };
  return keys;
}

function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Проверяет подпись RS256 и возвращает содержимое вебхука.
 * Если подпись не сошлась — возвращает null, запрос обрабатывать нельзя.
 */
export async function verifyWebhook(jwtString: string): Promise<Record<string, any> | null> {
  const parts = String(jwtString).trim().split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;

  const signed = `${h}.${p}`;
  const data = new Uint8Array(new ArrayBuffer(signed.length));
  for (let i = 0; i < signed.length; i++) data[i] = signed.charCodeAt(i);
  const sig = b64urlToBytes(s);

  let keys: CryptoKey[];
  try {
    keys = await loadJwks();
  } catch (e) {
    console.error("[tochka] JWKS недоступен:", (e as Error).message);
    return null;
  }

  for (const key of keys) {
    try {
      const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, sig, data);
      if (ok) return JSON.parse(new TextDecoder().decode(b64urlToBytes(p)));
    } catch (_e) { /* пробуем следующий ключ */ }
  }
  return null;
}

/** Собирает все строковые значения из вложенного объекта — для поиска идентификаторов. */
export function collectStrings(obj: any, out: Set<string> = new Set(), depth = 0): Set<string> {
  if (depth > 6 || obj == null) return out;
  if (typeof obj === "string") {
    if (obj.length >= 8) out.add(obj);
    return out;
  }
  if (typeof obj === "object") {
    for (const v of Object.values(obj)) collectStrings(v, out, depth + 1);
  }
  return out;
}
