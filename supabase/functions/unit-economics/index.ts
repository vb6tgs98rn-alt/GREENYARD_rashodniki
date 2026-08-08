/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 *
 * Копирование, распространение, переработка и обратная разработка
 * (reverse engineering) запрещены без письменного разрешения правообладателя.
 * Условия: см. файл LICENSE. Нарушение влечёт ответственность по ст. 1252,
 * 1301 ГК РФ.
 */
// ═══════════════════════════════════════════════════════════════════════════
// unit-economics — серверный расчёт юнит-экономики.
//
// Зачем функция существует:
//   Формулы юнит-экономики (маржа, ROI, ADR, разбор комиссии площадки,
//   категоризация расходов) — это ноу-хау продукта. Раньше они целиком
//   лежали в браузерном finance.js, то есть любой пользователь мог открыть
//   DevTools и прочитать всю методику расчёта. Теперь браузер получает
//   только готовые числа, а как они посчитаны — не знает.
//
// Endpoint (POST /functions/v1/unit-economics):
//   action=reports
//     { apartmentId, periods: [{ key, startDate, endDate, filters, includeEntries }] }
//     -> { ok, reports: { <key>: { stat, entries?, period, apartment } } }
//
//   action=portfolio
//     { dateFrom?, dateTo? }
//     -> { ok, rows, totals, period }
//
// Авторизация: JWT пользователя. Данные читаются из public.app_state
// клиентом с этим же JWT, поэтому RLS работает как обычно и чужое состояние
// прочитать нельзя даже при подделке apartmentId.
// ═══════════════════════════════════════════════════════════════════════════

// deno-lint-ignore-file no-explicit-any
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL      = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// ─── Константы, продублированные с фронтенда ────────────────────────────────
const FINANCE_TYPES = { income: "income", expense: "expense" } as const;
const UNTITLED_LABEL = "Без названия";

function displayApartmentName(name: unknown): string {
  return typeof name === "string" && name.trim() ? name.trim() : UNTITLED_LABEL;
}

/** Пустой набор показателей. */
function emptyStat() {
  return {
    grossIncome: 0, platformTax: 0, netIncome: 0,
    expense: 0, cleaning: 0, rent: 0, internet: 0, utilities: 0,
    subscription: 0, otherExpense: 0,
    bookings: 0, nights: 0,
    cancelledBookings: 0, cancelledAmount: 0,
    plannedExpense: 0, confirmedExpense: 0,
    profit: 0, roi: 0, adr: 0,
  };
}

/**
 * Число ночей в брони. Считаем по датам заезда/выезда из meta.
 */
function nightsBetween(begin: unknown, end: unknown): number {
  if (!begin || !end) return 0;
  const d1 = new Date(String(begin)).getTime();
  const d2 = new Date(String(end)).getTime();
  if (Number.isNaN(d1) || Number.isNaN(d2)) return 0;
  return Math.max(0, Math.round((d2 - d1) / 86400000));
}

/** Уборочная позиция, приклеенная к брони, не считается отдельной бронью. */
function isCleaningRow(e: any): boolean {
  return String(e?.externalBookingId || "").endsWith(":cleaning");
}

/** Является ли запись доходом от брони РеалтиКалендаря. */
function isBookingIncome(e: any): boolean {
  return e?.source === "realtycalendar" && !isCleaningRow(e);
}

/**
 * Категория расхода: уборка / регулярный расход по виду правила / прочее.
 */
function expenseKindOf(e: any, ruleKindById: Map<string, string>): string {
  if (e?.category === "Уборка" || e?.meta?.kind === "cleaning") return "cleaning";
  if (e?.source === "recurring" && e?.meta?.ruleId) {
    return ruleKindById.get(e.meta.ruleId) || "other";
  }
  return "other";
}

/** Итоговые производные показатели: маржа, ROI, ADR. */
function finalizeStat(stat: any) {
  stat.profit = stat.netIncome - stat.expense;
  stat.roi = stat.expense > 0 ? (stat.profit / stat.expense) * 100 : 0;
  stat.adr = stat.nights > 0 ? stat.netIncome / stat.nights : 0;
  return stat;
}

function buildRuleKindMap(state: any): Map<string, string> {
  const map = new Map<string, string>();
  (state?.finance?.recurringRules || []).forEach((r: any) => {
    map.set(r.id, r.kind || "other");
  });
  return map;
}

// ─── Отчёт по одной квартире за период ──────────────────────────────────────
function computeReport(
  state: any,
  apartmentId: string,
  startDate: string,
  endDate: string,
  filters: any = {},
  includeEntries = false,
) {
  const apt = (state?.apartments || []).find((a: any) => a.id === apartmentId);
  if (!apt || !startDate || !endDate) return null;

  const type     = filters.type     || "all";
  const category = filters.category || "all";
  const source   = filters.source   || "all";
  const status   = filters.status   || "active";

  const ruleKindById = buildRuleKindMap(state);
  const stat = emptyStat();
  const entries: any[] = [];

  (state?.finance?.entries || []).forEach((e: any) => {
    if (e.apartmentId !== apartmentId) return;
    const date = e.date || "";
    if (!date || date < startDate || date > endDate) return;

    // Отменённые брони считаем отдельно — они нужны для блока «отменено».
    if (e.status === "cancelled") {
      if (e.type === FINANCE_TYPES.income && isBookingIncome(e)) {
        stat.cancelledBookings += 1;
        stat.cancelledAmount += Number(e.amount || 0);
      }
      if (status !== "all" && status !== "cancelled") return;
    } else {
      if (status !== "active" && status !== "all" && e.status !== status) return;
    }

    if (type !== "all" && e.type !== type) return;
    if (source !== "all" && e.source !== source) return;

    const kind = e.type === FINANCE_TYPES.expense
      ? expenseKindOf(e, ruleKindById)
      : "other";
    if (category !== "all" && e.type === FINANCE_TYPES.expense && kind !== category) return;

    if (includeEntries) entries.push(e);

    const gross = Number(e.amount || 0);
    const net = Number(e.netAmount != null ? e.netAmount : gross);

    if (e.type === FINANCE_TYPES.income) {
      if (e.status !== "cancelled") {
        stat.grossIncome += gross;
        stat.netIncome += net;
        // Комиссия площадки — разница между валом и тем, что реально дошло.
        stat.platformTax += Math.max(0, gross - net);
        if (isBookingIncome(e)) {
          stat.bookings += 1;
          stat.nights += nightsBetween(e.meta?.begin_date, e.meta?.end_date);
        }
      }
    } else if (e.type === FINANCE_TYPES.expense && e.status !== "cancelled") {
      stat.expense += gross;
      if (kind === "cleaning") stat.cleaning += gross;
      else if (kind === "rent") stat.rent += gross;
      else if (kind === "internet") stat.internet += gross;
      else if (kind === "utilities") stat.utilities += gross;
      else if (kind === "subscription") stat.subscription += gross;
      else stat.otherExpense += gross;

      if (e.status === "planned") stat.plannedExpense += gross;
      else if (e.status === "confirmed") stat.confirmedExpense += gross;
    }
  });

  finalizeStat(stat);
  return {
    stat,
    entries,
    period: { startDate, endDate },
    apartment: { id: apt.id, name: displayApartmentName(apt.name) },
  };
}

// ─── Сводка по всем квартирам (портфель) ────────────────────────────────────
function computePortfolio(state: any, dateFrom = "", dateTo = "") {
  const apartments = state?.apartments || [];
  const ruleKindById = buildRuleKindMap(state);

  const inRange = (date: string) => {
    if (!date) return false;
    if (dateFrom && date < dateFrom) return false;
    if (dateTo && date > dateTo) return false;
    return true;
  };

  const byApartment = new Map<string, any>();
  apartments.forEach((apt: any) => {
    byApartment.set(apt.id, {
      id: apt.id,
      name: displayApartmentName(apt.name),
      ...emptyStat(),
    });
  });

  (state?.finance?.entries || []).forEach((e: any) => {
    if (!inRange(e.date)) return;
    if (e.status === "cancelled") return;
    const apt = byApartment.get(e.apartmentId);
    if (!apt) return;

    const gross = Number(e.amount || 0);
    const net = Number(e.netAmount != null ? e.netAmount : gross);

    if (e.type === FINANCE_TYPES.income) {
      apt.grossIncome += gross;
      apt.netIncome += net;
      apt.platformTax += Math.max(0, gross - net);
      if (isBookingIncome(e)) {
        apt.bookings += 1;
        apt.nights += nightsBetween(e.meta?.begin_date, e.meta?.end_date);
      }
    } else if (e.type === FINANCE_TYPES.expense) {
      const kind = expenseKindOf(e, ruleKindById);
      apt.expense += gross;
      if (kind === "cleaning") apt.cleaning += gross;
      else if (kind === "rent") apt.rent += gross;
      else if (kind === "internet") apt.internet += gross;
      else if (kind === "utilities") apt.utilities += gross;
      else if (kind === "subscription") apt.subscription += gross;
      else apt.otherExpense += gross;
    }
  });

  const rows = Array.from(byApartment.values())
    .map((r) => finalizeStat(r))
    .sort((a, b) => b.profit - a.profit);

  const totals: any = { ...emptyStat() };
  rows.forEach((r) => {
    totals.grossIncome  += r.grossIncome;
    totals.platformTax  += r.platformTax;
    totals.netIncome    += r.netIncome;
    totals.cleaning     += r.cleaning;
    totals.rent         += r.rent;
    totals.internet     += r.internet;
    totals.utilities    += r.utilities;
    totals.subscription += r.subscription;
    totals.otherExpense += r.otherExpense;
    totals.expense      += r.expense;
    totals.bookings     += r.bookings;
    totals.nights       += r.nights;
  });
  finalizeStat(totals);

  return { rows, totals, period: { dateFrom, dateTo } };
}

// ─── HTTP ───────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  const authHeader = req.headers.get("Authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "unauthorized" }, 401);

  // Клиент с JWT пользователя: RLS на app_state работает штатно,
  // поэтому чужое состояние прочитать нельзя.
  const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  const user = userData?.user;
  if (userErr || !user) return json({ error: "unauthorized" }, 401);

  let body: any = {};
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_json" }, 400);
  }

  // Читаем состояние пользователя.
  const { data: row, error: stateErr } = await userClient
    .from("app_state")
    .select("state")
    .eq("user_id", user.id)
    .maybeSingle();

  if (stateErr) return json({ error: "state_read_failed", detail: stateErr.message }, 500);
  const state = row?.state || null;
  if (!state) return json({ ok: true, empty: true, reports: {}, rows: [], totals: emptyStat() });

  const action = body.action || "reports";

  if (action === "portfolio") {
    const res = computePortfolio(state, body.dateFrom || "", body.dateTo || "");
    return json({ ok: true, ...res });
  }

  if (action === "reports") {
    const apartmentId = String(body.apartmentId || "");
    if (!apartmentId) return json({ error: "apartment_required" }, 400);

    const periods = Array.isArray(body.periods) ? body.periods : [];
    // Ограничение сверху — защита от запроса на тысячу периодов разом.
    if (periods.length > 60) return json({ error: "too_many_periods" }, 400);

    const reports: Record<string, unknown> = {};
    for (const p of periods) {
      const key = String(p?.key ?? "");
      if (!key) continue;
      reports[key] = computeReport(
        state,
        apartmentId,
        String(p.startDate || ""),
        String(p.endDate || ""),
        p.filters || {},
        p.includeEntries === true,
      );
    }
    return json({ ok: true, reports });
  }

  return json({ error: "unknown_action" }, 400);
});
