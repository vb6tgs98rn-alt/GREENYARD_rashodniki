/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 *
 * Копирование, распространение, переработка и обратная разработка
 * (reverse engineering) запрещены без письменного разрешения правообладателя.
 * Условия: см. файл LICENSE. Нарушение влечёт ответственность по ст. 1252,
 * 1301 ГК РФ.
 */
// Залог гостя через Точку Банк — двухэтапная оплата (холд).
//
// Как это работает (по документации API Точки):
//   1. Создаём платёжную ссылку с "preAuthorization": true — только карта,
//      СБП холд не поддерживает.
//   2. Гость платит — деньги замораживаются, статус операции AUTHORIZED.
//   3. Штраф: метод Capture Payment списывает всю сумму (частично нельзя),
//      статус становится APPROVED, деньги приходят на расчётный счёт.
//      Если штраф меньше залога, после списания остаток сразу возвращаем гостю
//      методом Refund Payment Operation (частичный возврат допустим для APPROVED).
//      Если возврат не прошёл, он повторяется при следующей сверке.
//   4. Возврат: в документации нет метода снятия холда, поэтому залог
//      отмечается возвращённым, а деньги размораживаются сами, когда
//      закончится срок холда (6 дней с оплаты). Списать его после этого
//      из приложения уже нельзя.
//
// Чек по 54-ФЗ на залог не формируем: обеспечительный платёж — не расчёт
// за услугу, ссылка создаётся без фискализации.
//
// Используется и ботом (автоотправка), и приложением (ручная ссылка).
// deno-lint-ignore-file no-explicit-any

import {
  capturePayment,
  refundPayment,
  createPaymentLink,
  getPaymentStatus,
  loadConnection,
  mapDepositStatus,
  type TochkaConnection,
} from "./tochka.ts";

/** Срок холда у Точки — 6 дней с момента оплаты. */
export const HOLD_DAYS = 6;
/** Запас на случай задержек: залог должен жить минимум на день дольше выезда. */
export const HOLD_RESERVE_DAYS = 1;
/** Бот отправляет залог сам, только если до выезда не больше 5 дней. */
export const AUTO_MAX_DAYS = HOLD_DAYS - HOLD_RESERVE_DAYS;
/** Комиссия банка при списании залога (штрафе), %. При возврате комиссии нет. */
export const CAPTURE_FEE_PERCENT = 3.2;

/** Статусы залога, при которых он считается действующим. */
export const ACTIVE_DEPOSIT_STATUSES = ["created", "held", "capturing"];

export interface BookingDeposit {
  /**
   * ok — ссылка готова; already_held — залог уже внесён;
   * no_amount — у квартиры не указан залог; disabled — оплата через Точку выключена;
   * error — не получилось.
   */
  kind: "ok" | "already_held" | "no_amount" | "disabled" | "error";
  amount: number;
  payUrl?: string;
  depositId?: string;
  /** Сколько дней до выезда (по московскому времени). */
  daysToCheckout?: number | null;
  /** Причина для менеджера, гостю её не показываем. */
  reason?: string;
}

/** Сегодняшняя дата по Москве в формате ГГГГ-ММ-ДД. */
export function todayMsk(now = new Date()): string {
  const msk = new Date(now.getTime() + 3 * 3600_000);
  return msk.toISOString().slice(0, 10);
}

/** Количество дней от сегодняшнего дня (МСК) до даты ГГГГ-ММ-ДД. */
export function daysFromToday(dateStr: string | null | undefined, now = new Date()): number | null {
  const d = String(dateStr || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return null;
  const a = Date.parse(`${todayMsk(now)}T00:00:00Z`);
  const b = Date.parse(`${d}T00:00:00Z`);
  return Math.round((b - a) / 86400_000);
}

function fmtDate(d: string | null | undefined): string {
  const s = String(d || "").slice(0, 10);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : s;
}

/** Сумма залога из настроек квартиры (поле «Обеспечительный платёж»). */
export async function depositAmountFor(sb: any, userId: string, realtyId: number | null): Promise<number> {
  if (realtyId == null) return 0;
  const { data } = await sb
    .from("apartment_contract_templates")
    .select("deposit")
    .eq("user_id", userId)
    .eq("realty_id", realtyId)
    .maybeSingle();
  const n = Math.round(Number(data?.deposit || 0) * 100) / 100;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Готовит ссылку на залог по брони.
 * Если по брони уже есть действующая неоплаченная ссылка на ту же сумму,
 * она переиспользуется — у гостя не будет двух разных залогов.
 */
export async function ensureBookingDeposit(
  sb: any,
  userId: string,
  bookingId: number | string,
  opts: { source?: "manual" | "bot" | "auto" } = {},
): Promise<BookingDeposit> {
  const { data: bk } = await sb
    .from("rc_bookings")
    .select("booking_id, realty_id, apartment_title, begin_date, end_date, client_fio")
    .eq("user_id", userId)
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (!bk) return { kind: "error", amount: 0, reason: "Бронь не найдена" };

  const daysToCheckout = daysFromToday(bk.end_date);
  const amount = await depositAmountFor(sb, userId, bk.realty_id ?? null);
  if (!amount) return { kind: "no_amount", amount: 0, daysToCheckout };

  const { data: ms } = await sb
    .from("manager_settings")
    .select("tochka_enabled, tochka_success_url")
    .eq("user_id", userId)
    .maybeSingle();
  if (!ms?.tochka_enabled) return { kind: "disabled", amount, daysToCheckout };

  // Действующий залог по брони
  const { data: active } = await sb
    .from("booking_deposits")
    .select("*")
    .eq("user_id", userId)
    .eq("booking_id", Number(bookingId))
    .in("status", ACTIVE_DEPOSIT_STATUSES)
    .maybeSingle();
  if (active) {
    if (active.status !== "created") {
      return { kind: "already_held", amount: Number(active.amount), depositId: String(active.id), daysToCheckout };
    }
    const notExpired = !active.link_expires_at || new Date(active.link_expires_at).getTime() > Date.now();
    const sameAmount = Math.abs(Number(active.amount) - amount) < 0.01;
    if (notExpired && sameAmount && active.pay_url) {
      return { kind: "ok", amount, payUrl: String(active.pay_url), depositId: String(active.id), daysToCheckout };
    }
    // Ссылка устарела или сумма в настройках изменилась — закрываем её.
    await sb.from("booking_deposits").update({ status: "canceled" }).eq("id", active.id).eq("status", "created");
  }

  const conn = await loadConnection(sb, userId);
  if (!conn || conn.status !== "connected") {
    return { kind: "error", amount, daysToCheckout, reason: "Точка Банк не подключена" };
  }

  // Ссылка действует до конца дня выезда, но не дольше 7 дней (предел Точки).
  const untilCheckoutMin = daysToCheckout != null ? (daysToCheckout + 1) * 24 * 60 : 7 * 24 * 60;
  const ttlMinutes = Math.max(60, Math.min(7 * 24 * 60, untilCheckoutMin));

  const purpose = `Залог (обеспечительный платёж) по брони №${bk.booking_id}, ${
    String(bk.apartment_title || "").trim()
  }, ${fmtDate(bk.begin_date)}—${fmtDate(bk.end_date)}`.slice(0, 210);

  let res;
  try {
    res = await createPaymentLink(sb, conn, {
      amount,
      purpose,
      ttlMinutes,
      withReceipt: false,
      taxSystem: "",
      vatType: "none",
      successUrl: ms.tochka_success_url ? String(ms.tochka_success_url) : null,
      preAuthorization: true,
    });
  } catch (e) {
    const reason = String((e as Error).message || e).slice(0, 400);
    console.error("[deposit] не удалось создать ссылку:", reason);
    return { kind: "error", amount, daysToCheckout, reason };
  }

  const { data: saved, error } = await sb.from("booking_deposits").insert({
    user_id: userId,
    booking_id: Number(bookingId),
    amount,
    currency: "RUB",
    purpose,
    operation_id: res.operationId,
    pay_url: res.payUrl,
    status: "created",
    source: opts.source || "manual",
    link_expires_at: res.expiresAt,
    raw: res.raw,
  }).select("id").maybeSingle();
  if (error) {
    console.error("[deposit] не удалось сохранить залог:", error.message);
    return { kind: "error", amount, daysToCheckout, reason: "Не удалось сохранить залог" };
  }

  return { kind: "ok", amount, payUrl: res.payUrl, depositId: saved?.id ? String(saved.id) : undefined, daysToCheckout };
}

/** Текст сообщения гостю о залоге. HTML — как во всех сообщениях бота. */
export function depositMessage(d: BookingDeposit, escape: (s: string) => string): string | null {
  if (d.kind !== "ok" || !d.payUrl) return null;
  const sum = d.amount.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `🔒 <b>Залог</b>\n\nСумма: <b>${escape(sum)} ₽</b>\n` +
    `Деньги не списываются, а только замораживаются на вашей карте. ` +
    `После выезда залог будет возвращён, если с квартирой всё в порядке.\n` +
    `Оплата — только банковской картой.\n\n${escape(d.payUrl)}`;
}

/**
 * Сверяет залог с банком и применяет новый статус.
 * Возвращает обновлённую запись (или исходную, если ничего не поменялось).
 * onHeld вызывается один раз, когда гость внёс залог.
 */
export async function syncDeposit(
  sb: any,
  conn: TochkaConnection,
  dep: any,
  hooks: DepositHooks = {},
): Promise<any> {
  if (!dep?.operation_id) return dep;
  // Списанный залог с невозвращённым остатком — доводим возврат.
  if (dep.status === "captured" && refundPending(dep)) return await refundRemainder(sb, conn, dep, hooks);
  // Возвращённый, списанный и заменённый залоги больше не трогаем.
  if (["released", "captured", "canceled"].includes(dep.status)) return dep;

  const external = await getPaymentStatus(sb, conn, dep.operation_id);
  const next = mapDepositStatus(external);
  if (!next || next === dep.status) return dep;

  const now = new Date();
  const patch: Record<string, any> = { status: next };
  if (next === "held") {
    if (dep.status !== "created") return dep;
    patch.held_at = now.toISOString();
    patch.hold_expires_at = new Date(now.getTime() + HOLD_DAYS * 86400_000).toISOString();
  }
  if (next === "captured") patch.captured_at = now.toISOString();
  if (next === "released") patch.released_at = now.toISOString();

  const { data: upd } = await sb.from("booking_deposits")
    .update(patch)
    .eq("id", dep.id)
    .eq("status", dep.status) // защита от гонок: меняем, только если статус не успел измениться
    .select("*")
    .maybeSingle();
  if (!upd) return dep;

  try {
    if (next === "held" && hooks.onHeld) await hooks.onHeld(upd);
    if (next === "captured" && hooks.onCaptured) await hooks.onCaptured(upd);
  } catch (e) {
    console.error("[deposit] уведомление:", (e as Error).message);
  }
  if (next === "captured" && refundPending(upd)) return await refundRemainder(sb, conn, upd, hooks);
  return upd;
}

/** Уведомления о смене статуса залога. */
export interface DepositHooks {
  onHeld?: (dep: any) => Promise<void>;
  onCaptured?: (dep: any) => Promise<void>;
  /** Остаток после штрафа возвращён (ok) или банк не принял возврат (впервые для этой ошибки). */
  onRefund?: (dep: any, ok: boolean) => Promise<void>;
}

/** Нужно ли ещё вернуть гостю остаток после частичного штрафа. */
export function refundPending(dep: any): boolean {
  return Number(dep?.refund_amount || 0) > 0 && !dep?.refunded_at;
}

/** Статусы Точки, при которых возврат уже оформлен. */
const REFUND_DONE_STATUSES = ["ON-REFUND", "REFUNDED", "REFUNDED_PARTIALLY"];

/**
 * Возвращает гостю остаток списанного залога (refund_amount).
 * Защита от двойного возврата:
 *   — перед запросом смотрим статус в банке: если возврат уже есть, только отмечаем;
 *   — запрос делает тот, кто первым поставил refund_requested_at (атомарно);
 *   — захват снимается (и возможен повтор) только при явном отказе банка (ответ 4xx)
 *     и если в банке платёж всё ещё APPROVED. При тайм-ауте или ошибке 5xx деньги могли
 *     уже уйти — автоматически не повторяем, сверка только отмечает возврат, когда
 *     банк его покажет, а арендодатель получает уведомление.
 */
export async function refundRemainder(sb: any, conn: TochkaConnection, dep: any, hooks: DepositHooks = {}): Promise<any> {
  if (!refundPending(dep) || dep.status !== "captured" || !dep.operation_id) return dep;
  const opId = String(dep.operation_id);
  const markDone = async () => {
    const { data: done } = await sb.from("booking_deposits")
      .update({ refunded_at: new Date().toISOString(), refund_error: null })
      .eq("id", dep.id).is("refunded_at", null).select("*").maybeSingle();
    if (done && hooks.onRefund) {
      try { await hooks.onRefund(done, true); } catch (e) { console.error("[deposit] уведомление:", (e as Error).message); }
    }
    return done ?? dep;
  };

  // 1. Возврат уже есть в банке?
  let bankStatus = "";
  try {
    bankStatus = String(await getPaymentStatus(sb, conn, opId)).toUpperCase();
  } catch (e) {
    console.error("[deposit] статус перед возвратом:", (e as Error).message);
    return dep; // без статуса не рискуем — попробуем при следующей сверке
  }
  if (REFUND_DONE_STATUSES.includes(bankStatus)) return await markDone();
  if (bankStatus !== "APPROVED") return dep; // возврат возможен только из APPROVED

  // 2. Захватываем право на запрос.
  const { data: claimed } = await sb.from("booking_deposits")
    .update({ refund_requested_at: new Date().toISOString() })
    .eq("id", dep.id)
    .is("refunded_at", null)
    .is("refund_requested_at", null)
    .select("*")
    .maybeSingle();
  if (!claimed) return dep; // возврат уже делает другой запрос

  // 3. Запрос возврата.
  try {
    await refundPayment(sb, conn, opId, Number(claimed.refund_amount));
    console.log(`[deposit] залог ${dep.id}: возврат остатка ${claimed.refund_amount} ₽ принят банком`);
    return await markDone();
  } catch (e) {
    const msg = String((e as Error).message || e).slice(0, 300);
    console.error("[deposit] Refund Payment Operation:", msg);
    const firstError = !dep.refund_error;
    // Сперва сверяемся с банком: возврат мог пройти, даже если ответ не дошёл.
    let st = "";
    try {
      st = String(await getPaymentStatus(sb, conn, opId)).toUpperCase();
    } catch (_e) { /* статус недоступен */ }
    if (REFUND_DONE_STATUSES.includes(st)) return await markDone();

    // Явный отказ банка и платёж всё ещё APPROVED — деньги точно не ушли, повтор безопасен.
    const code = Number((e as any)?.status || 0);
    const refused = code >= 400 && code < 500 && st === "APPROVED";
    const { data: failed } = await sb.from("booking_deposits")
      .update(refused ? { refund_requested_at: null, refund_error: msg } : { refund_error: msg })
      .eq("id", dep.id).is("refunded_at", null).select("*").maybeSingle();
    if (firstError && hooks.onRefund) {
      try { await hooks.onRefund(failed ?? claimed, false); } catch (e2) { console.error("[deposit] уведомление:", (e2 as Error).message); }
    }
    return failed ?? claimed;
  }
}

/**
 * Штраф: списывает весь залог на расчётный счёт (Capture Payment).
 * penalty — сумма штрафа (по умолчанию весь залог). Если она меньше залога,
 * после списания остаток возвращается гостю (refundRemainder).
 * Сначала переводим залог в capturing — так повторное нажатие и
 * одновременный «Вернуть» не пройдут.
 * captured=true — именно этот вызов отметил списание (для уведомления без дублей).
 */
export async function captureDeposit(
  sb: any,
  conn: TochkaConnection,
  dep: any,
  penalty?: number,
  hooks: DepositHooks = {},
): Promise<{ ok: boolean; error?: string; dep?: any; captured?: boolean }> {
  const amount = Number(dep.amount);
  const pen = penalty == null ? amount : Math.round(Number(penalty) * 100) / 100;
  if (!(pen > 0) || pen > amount) return { ok: false, error: "bad_penalty" };
  const rest = Math.round((amount - pen) * 100) / 100;

  const { data: locked } = await sb.from("booking_deposits")
    .update({
      status: "capturing",
      penalty_amount: pen,
      refund_amount: rest > 0 ? rest : null,
      refund_requested_at: null,
      refunded_at: null,
      refund_error: null,
    })
    .eq("id", dep.id)
    .eq("status", "held")
    .select("*")
    .maybeSingle();
  if (!locked) return { ok: false, error: "not_held" };

  // Откат блокировки: залог снова хранится, сумма штрафа сброшена.
  const unlock = () =>
    sb.from("booking_deposits")
      .update({ status: "held", penalty_amount: null, refund_amount: null })
      .eq("id", locked.id).eq("status", "capturing");

  // Отмечает списание (если его ещё не отметил вебхук) и возвращает остаток.
  const finish = async (): Promise<{ ok: boolean; dep: any; captured: boolean }> => {
    const { data: done } = await sb.from("booking_deposits")
      .update({ status: "captured", captured_at: new Date().toISOString() })
      .eq("id", locked.id).eq("status", "capturing").select("*").maybeSingle();
    let cur = done;
    // Сначала уведомление о штрафе, потом — о возврате остатка.
    if (done && hooks.onCaptured) {
      try { await hooks.onCaptured(done); } catch (e) { console.error("[deposit] уведомление:", (e as Error).message); }
    }
    if (!cur) {
      const { data: again } = await sb.from("booking_deposits").select("*").eq("id", locked.id).maybeSingle();
      cur = again ?? locked;
    }
    if (cur.status === "captured" && refundPending(cur)) cur = await refundRemainder(sb, conn, cur, hooks);
    return { ok: true, dep: cur, captured: !!done };
  };

  try {
    const ok = await capturePayment(sb, conn, String(locked.operation_id));
    if (!ok) {
      await unlock();
      return { ok: false, error: "bank_refused" };
    }
  } catch (e) {
    const msg = String((e as Error).message || e).slice(0, 300);
    console.error("[deposit] Capture Payment:", msg);
    // Ответ банка неоднозначен — сверяем статус, а не гадаем.
    try {
      const st = mapDepositStatus(await getPaymentStatus(sb, conn, String(locked.operation_id)));
      if (st === "captured") return await finish();
    } catch (_e) { /* статус недоступен — откатываем блокировку ниже */ }
    await unlock();
    return { ok: false, error: "capture_failed" };
  }

  // Команда принята — уточняем итог у банка (APPROVED может прийти чуть позже, вебхуком;
  // тогда остаток вернёт syncDeposit).
  try {
    const st = mapDepositStatus(await getPaymentStatus(sb, conn, String(locked.operation_id)));
    if (st === "captured") return await finish();
  } catch (_e) { /* подтвердится вебхуком */ }
  return { ok: true, dep: locked, captured: false };
}

/**
 * Возврат залога. Метода снятия холда в документации Точки нет, поэтому
 * отмечаем залог возвращённым: списать его больше нельзя, а деньги
 * размораживаются сами по окончании холда.
 */
export async function releaseDeposit(sb: any, dep: any): Promise<{ ok: boolean; error?: string; dep?: any }> {
  const { data: upd } = await sb.from("booking_deposits")
    .update({ status: "released", released_at: new Date().toISOString() })
    .eq("id", dep.id)
    .eq("status", "held")
    .select("*")
    .maybeSingle();
  if (!upd) return { ok: false, error: "not_held" };
  return { ok: true, dep: upd };
}
