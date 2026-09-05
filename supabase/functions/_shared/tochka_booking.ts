/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 *
 * Копирование, распространение, переработка и обратная разработка
 * (reverse engineering) запрещены без письменного разрешения правообладателя.
 * Условия: см. файл LICENSE. Нарушение влечёт ответственность по ст. 1252,
 * 1301 ГК РФ.
 */
// Оплата проживания по брони: расчёт задолженности и создание ссылки.
// Используется и ботом (отправляет ссылку вместе с договором), и приложением.
// deno-lint-ignore-file no-explicit-any

import {
  createPaymentLink,
  createSbpQr,
  loadConnection,
  type PaymentMethod,
  type PaymentRequest,
  type PaymentResult,
} from "./tochka.ts";

/** Результат подготовки оплаты по брони. */
export interface BookingPayment {
  /**
   * ok — ссылка готова; nothing_to_pay — долга нет; requisites — оплата по реквизитам;
   * need_email — для чека нужна почта гостя; error — не получилось.
   */
  kind: "ok" | "nothing_to_pay" | "requisites" | "disabled" | "error";
  amount: number;
  payUrl?: string;
  requisites?: string;
  method?: PaymentMethod;
  paymentId?: string;
  /** Причина для менеджера, гостю её не показываем. */
  reason?: string;
}

const DEFAULT_PURPOSE =
  "Оплата проживания по брони №{booking_id}, {apartment}, {begin}—{end}";

function fmtDate(d: string | null | undefined): string {
  if (!d) return "";
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${dt.getFullYear()}`;
}

/** Подставляет данные брони в шаблон назначения платежа. */
function buildPurpose(tpl: string, bk: any): string {
  return tpl
    .replaceAll("{booking_id}", String(bk.booking_id ?? ""))
    .replaceAll("{apartment}", String(bk.apartment_title ?? ""))
    .replaceAll("{begin}", fmtDate(bk.begin_date))
    .replaceAll("{end}", fmtDate(bk.end_date))
    .replaceAll("{fio}", String(bk.client_fio ?? ""))
    .trim()
    .slice(0, 210);
}

/**
 * Готовит оплату остатка по брони.
 *
 * Сумма к оплате — задолженность: полная стоимость минус уже внесённая
 * предоплата (те же поля, что идут в договор). Если долга нет, ссылка не
 * создаётся. Если по брони уже есть неоплаченная действующая ссылка, она
 * переиспользуется — гость не получит два разных счёта на одну бронь.
 */
export async function ensureBookingPayment(
  sb: any,
  userId: string,
  bookingId: number | string,
  opts: { force?: boolean } = {},
): Promise<BookingPayment> {
  const { data: bk } = await sb
    .from("rc_bookings")
    .select("*")
    .eq("user_id", userId)
    .eq("booking_id", bookingId)
    .maybeSingle();
  if (!bk) return { kind: "error", amount: 0, reason: "Бронь не найдена" };

  const total = Number(bk.amount || 0);
  const prepaid = Number(bk.prepayment || 0);
  const debt = Math.round((total - prepaid) * 100) / 100;

  const { data: ms } = await sb
    .from("manager_settings")
    .select(
      "tochka_enabled, tochka_payment_method, tochka_auto_send, tochka_with_receipt, " +
        "tochka_tax_system, tochka_vat_type, tochka_ttl_minutes, tochka_purpose_template, " +
        "tochka_requisites, tochka_success_url",
    )
    .eq("user_id", userId)
    .maybeSingle();

  if (!ms?.tochka_enabled) return { kind: "disabled", amount: debt };
  if (debt <= 0) return { kind: "nothing_to_pay", amount: 0 };

  const purposeTpl = String(ms.tochka_purpose_template || DEFAULT_PURPOSE);
  const purpose = buildPurpose(purposeTpl, bk);
  // Способ оплаты: по умолчанию — платёжная ссылка Точки. Она сама предлагает
  // гостю и СБП, и карту (paymentMode=["sbp","card"]) через интернет-эквайринг —
  // отдельная регистрация ТСП в СБП не нужна.
  // Отдельный СБП QR используем только если менеджер явно выбрал sbp_qr
  // И у подключения Точки есть sbp_merchant_id (иначе Точка вернёт ошибку).
  const savedMethod = String(ms.tochka_payment_method || "payment_link") as PaymentMethod;
  const method: PaymentMethod = savedMethod === "sbp_qr" ? "sbp_qr" : "payment_link";

  // Переиспользуем действующую ссылку, если сумма и способ не поменялись.
  if (!opts.force) {
    const { data: existing } = await sb
      .from("tochka_payments")
      .select("*")
      .eq("user_id", userId)
      .eq("booking_id", bookingId)
      .eq("status", "created")
      .maybeSingle();
    if (existing) {
      const notExpired = !existing.expires_at ||
        new Date(existing.expires_at).getTime() > Date.now();
      const sameAmount = Math.abs(Number(existing.amount) - debt) < 0.01;
      if (notExpired && sameAmount && existing.method === method && existing.pay_url) {
        return {
          kind: "ok",
          amount: debt,
          payUrl: String(existing.pay_url),
          method,
          paymentId: String(existing.id),
        };
      }
      // Условия изменились — старую ссылку закрываем, чтобы не путать гостя.
      await sb.from("tochka_payments")
        .update({ status: "canceled" })
        .eq("id", existing.id);
    }
  }

  const conn = await loadConnection(sb, userId);
  if (!conn || conn.status !== "connected") {
    return { kind: "error", amount: debt, reason: "Точка Банк не подключена" };
  }

  // Чек по 54-ФЗ — только для payment_link и только если менеджер включил эту опцию.
  // Если email гостя нет — Точка сама попросит его на странице оплаты (emailSource=buyer).
  const clientEmail = String(bk.client_email || "").trim();
  const withReceipt = method === "payment_link" && Boolean(ms.tochka_with_receipt);

  const req: PaymentRequest = {
    amount: debt,
    purpose,
    ttlMinutes: Number(ms.tochka_ttl_minutes || 4320),
    withReceipt,
    taxSystem: String(ms.tochka_tax_system || "usn_income"),
    vatType: String(ms.tochka_vat_type || "none"),
    clientName: bk.client_fio ?? null,
    clientPhone: bk.client_phone ?? null,
    clientEmail: clientEmail || null,
    successUrl: ms.tochka_success_url ? String(ms.tochka_success_url) : null,
  };

  let res: PaymentResult;
  try {
    res = method === "sbp_qr"
      ? await createSbpQr(sb, conn, req)
      : await createPaymentLink(sb, conn, req);
  } catch (e) {
    const reason = String((e as Error).message || e).slice(0, 400);
    console.error("[tochka] не удалось создать платёж:", reason);
    return { kind: "error", amount: debt, reason };
  }

  const { data: saved } = await sb.from("tochka_payments").insert({
    user_id: userId,
    booking_id: Number(bookingId),
    method: res.method,
    amount: debt,
    currency: "RUB",
    purpose,
    operation_id: res.operationId,
    qrc_id: res.qrcId,
    pay_url: res.payUrl,
    status: "created",
    expires_at: res.expiresAt,
    raw: res.raw,
  }).select("id").maybeSingle();

  return {
    kind: "ok",
    amount: debt,
    payUrl: res.payUrl,
    method: res.method,
    paymentId: saved?.id ? String(saved.id) : undefined,
  };
}

/** Текст сообщения гостю об оплате. HTML — как во всех сообщениях бота. */
export function paymentMessage(p: BookingPayment, escape: (s: string) => string): string | null {
  const sum = p.amount.toLocaleString("ru-RU", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (p.kind === "ok" && p.payUrl) {
    const hint = p.method === "sbp_qr"
      ? "Оплата через СБП — ссылка откроет приложение вашего банка."
      : "На странице оплаты можно выбрать СБП или банковскую карту.";
    return `💳 <b>Оплата проживания</b>\n\nК оплате: <b>${escape(sum)} ₽</b>\n${hint}\n\n${escape(p.payUrl)}\n\nПосле оплаты мы автоматически увидим платёж — подтверждать ничего не нужно.`;
  }
  return null;
}
