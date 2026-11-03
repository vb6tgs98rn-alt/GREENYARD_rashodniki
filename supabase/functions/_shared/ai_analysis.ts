/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 */
// =============================================================================
// ИИ-анализ финучёта: сводка по квартирам → модель Perplexity → текст разбора.
// =============================================================================
// Цифры считаем здесь сами (точно), модели отдаём только готовые агрегаты:
// суммы, ночи, заполняемость, расходы по видам и найденные несостыковки в учёте.
// Персональных данных гостей (имена, телефоны, почта) в модель не передаём (152-ФЗ).
//
// Правила расчёта (как в разборе владельцу):
//   • доход — брони RealtyCalendar за вычетом комиссии площадки, по ночам проживания
//     в месяце (бронь на стыке месяцев делится пропорционально ночам);
//   • ручные доходы — по дате записи;
//   • расходы — записи финучёта по дате (аренда, уборка, менеджер, закупки, прочее),
//     без авто-выплат собственнику и отменённых записей;
//   • субаренда: прибыль = доход − расходы;
//   • доверительное управление: прибыль = (доход − расходы) × доля УК.
// =============================================================================

// deno-lint-ignore-file no-explicit-any

export type AiBooking = {
  booking_id: number | string;
  realty_id: number | string | null;
  source: string | null;
  status: string | null;
  begin_date: string | null;
  end_date: string | null;
  amount: number | string | null;
  platform_tax: number | string | null;
  raw_tax?: number | string | null;
};

const DAY = 86400000;

function iso(d: Date): string { return d.toISOString().slice(0, 10); }
function parse(s: string): number { return Date.parse(String(s).slice(0, 10) + "T00:00:00Z"); }
function nightsBetween(a: string, b: string): number { return Math.round((parse(b) - parse(a)) / DAY); }
function r0(n: number): number { return Math.round(n || 0); }

/** Первый и последний день месяца 'ГГГГ-ММ'; to — включительно. */
export function monthRange(ym: string): { from: string; to: string; days: number } {
  const [y, m] = ym.split("-").map(Number);
  const from = `${ym}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from, to: `${ym}-${String(last).padStart(2, "0")}`, days: last };
}

/** Сдвиг месяца 'ГГГГ-ММ' на n. */
export function shiftMonth(ym: string, n: number): string {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

/** Ночи брони внутри [from, to] (to — включительно). */
function nightsIn(begin: string, end: string, from: string, to: string): number {
  const s = Math.max(parse(begin), parse(from));
  const e = Math.min(parse(end), parse(to) + DAY);
  return Math.max(0, Math.round((e - s) / DAY));
}

function bookingTax(b: AiBooking): number {
  const raw = Number(b.raw_tax);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const col = Number(b.platform_tax);
  return Number.isFinite(col) ? col : 0;
}

const PLATFORM_LABELS: Record<string, string> = {
  avito: "Авито", "sutochno.ru": "Суточно", sutochno: "Суточно", "ostrovok.ru": "Островок", ostrovok: "Островок",
  yandextravel: "Яндекс Путешествия", yandex_travel: "Яндекс Путешествия", bronevik: "Броневик", cian: "Циан",
  domclick: "Домклик", otello: "Отелло", manual: "Напрямую", tvil: "Твил", "101hotels": "101 Hotels",
};
function platformLabel(s: string | null): string {
  const k = String(s || "").toLowerCase();
  return PLATFORM_LABELS[k] || (k ? k : "не указана");
}

// Вид расхода по записи финучёта.
function expenseKind(e: any): string {
  if (e.source === "auto-rent") return "аренда";
  if (e.meta?.kind === "cleaning") return "уборка";
  const hay = `${e.category || ""} ${e.title || ""}`.toLowerCase();
  if (hay.includes("аренд")) return "аренда";
  if (hay.includes("уборк")) return "уборка";
  if (hay.includes("менеджер")) return "менеджер";
  if (hay.includes("закуп") || e.category === "Закупка") return "закупки";
  if (hay.includes("коммун") || hay.includes("жкх") || hay.includes("свет") || hay.includes("интернет")) return "коммуналка и связь";
  return "прочее";
}

/** Свободные промежутки (≥1 ночи) квартиры в окне [from, to). */
function freeGaps(busy: Array<[string, string]>, from: string, to: string): Array<{ from: string; to: string; nights: number }> {
  const sorted = busy
    .map(([a, b]) => [Math.max(parse(a), parse(from)), Math.min(parse(b), parse(to))] as [number, number])
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  const out: Array<{ from: string; to: string; nights: number }> = [];
  let cur = parse(from);
  for (const [a, b] of sorted) {
    if (a > cur) out.push({ from: iso(new Date(cur)), to: iso(new Date(a)), nights: Math.round((a - cur) / DAY) });
    cur = Math.max(cur, b);
  }
  if (parse(to) > cur) out.push({ from: iso(new Date(cur)), to: to, nights: Math.round((parse(to) - cur) / DAY) });
  return out;
}

/**
 * Сводка для модели. months — месяцы 'ГГГГ-ММ' по порядку (последний — главный).
 * today — сегодняшняя дата по Москве.
 */
export function buildAnalyticsData(state: any, bookings: AiBooking[], months: string[], today: string) {
  const apts = (state?.apartments || []).filter((a: any) => !a.archived);
  const entries: any[] = state?.finance?.entries || [];
  const active = bookings.filter((b) => b.status !== "canceled" && b.status !== "deleted");
  const cancelled = bookings.filter((b) => b.status === "canceled" || b.status === "deleted");
  const issues: string[] = [];

  const apartments = apts.map((apt: any) => {
    const model = apt.businessModel === "trust" ? "trust" : "sublease";
    const share = Math.min(100, Math.max(0, Number(apt.trustShare || 0)));
    const rentSetting = Math.max(0, Number(apt.rentAmount || 0));
    const rcId = apt.externalIds?.realtyCalendarUnitId ? String(apt.externalIds.realtyCalendarUnitId) : "";
    const name = String(apt.name || "—");
    const aptBookings = rcId ? active.filter((b) => String(b.realty_id) === rcId) : [];
    const aptCancelled = rcId ? cancelled.filter((b) => String(b.realty_id) === rcId) : [];
    const aptEntries = entries.filter((e) => e.apartmentId === apt.id && e.status !== "cancelled");

    if (!rcId) issues.push(`${name}: квартира не привязана к RealtyCalendar — брони не попадают в доход.`);
    if (!(Number(apt.cleaningPrice || 0) > 0)) issues.push(`${name}: в настройках не задана цена уборки — автоуборки не создаются.`);
    if (model === "sublease" && !(rentSetting > 0)) issues.push(`${name}: субаренда без суммы аренды в настройках.`);

    const perMonth = months.map((ym) => {
      const { from, to, days } = monthRange(ym);
      const monthStarted = from <= today;
      const monthOver = to < today;
      let nights = 0, gross = 0, commission = 0, net = 0, count = 0;
      const byPlatform: Record<string, { nights: number; gross: number }> = {};
      for (const b of aptBookings) {
        if (!b.begin_date || !b.end_date) continue;
        const total = nightsBetween(b.begin_date, b.end_date);
        if (total <= 0) continue;
        const n = nightsIn(b.begin_date, b.end_date, from, to);
        if (n <= 0) continue;
        const g = Number(b.amount || 0);
        const t = bookingTax(b);
        const k = n / total;
        nights += n; count += 1;
        gross += g * k; commission += t * k; net += Math.max(0, g - t) * k;
        const pl = platformLabel(b.source);
        byPlatform[pl] = byPlatform[pl] || { nights: 0, gross: 0 };
        byPlatform[pl].nights += n; byPlatform[pl].gross += g * k;
      }
      // Выезды (= уборки) в месяце — база для расхода на один заезд.
      const checkouts = aptBookings.filter((b) => b.end_date && b.end_date >= from && b.end_date <= to && b.end_date <= today).length;
      let manualIncome = 0;
      const expenses: Record<string, number> = {};
      let rentRecorded = false;
      for (const e of aptEntries) {
        if (!e.date || String(e.date).slice(0, 7) !== ym) continue;
        if (e.type === "income") {
          if (e.source === "realtycalendar") continue; // уже учтено через брони
          manualIncome += Number(e.netAmount ?? e.amount ?? 0);
          continue;
        }
        if (e.type !== "expense") continue;
        if (e.source === "auto-owner-payout") continue;
        const k = expenseKind(e);
        if (k === "аренда") rentRecorded = true;
        expenses[k] = (expenses[k] || 0) + Number(e.amount || 0);
      }
      const cancelledNights = aptCancelled.reduce((s, b) => {
        if (!b.begin_date || !b.end_date) return s;
        return s + nightsIn(b.begin_date, b.end_date, from, to);
      }, 0);
      // Нет записи аренды за месяц — подставляем сумму из настроек, чтобы прибыль не была завышена.
      let rentImputed = false;
      if (model === "sublease" && rentSetting > 0 && !rentRecorded && monthStarted && (nights > 0 || monthOver)) {
        expenses["аренда"] = (expenses["аренда"] || 0) + rentSetting;
        rentImputed = true;
        issues.push(`${name}: за ${ym} нет записи аренды в финучёте — в расчёте подставлена сумма из настроек ${r0(rentSetting)} ₽.`);
      }
      const income = net + manualIncome;
      const expenseTotal = Object.values(expenses).reduce((s, v) => s + v, 0);
      const raw = income - expenseTotal;
      const profit = model === "trust" ? raw * share / 100 : raw;
      return {
        month: ym,
        status: monthOver ? "закрыт" : (monthStarted ? `идёт (данные на ${today})` : "будущий"),
        nights_sold: nights,
        days_in_month: days,
        occupancy_pct: r0((nights / days) * 100),
        bookings: count,
        adr_gross: nights ? r0(gross / nights) : 0,
        revenue_gross: r0(gross),
        platform_commission: r0(commission),
        income_net: r0(income),
        expenses: Object.fromEntries(Object.entries(expenses).map(([k, v]) => [k, r0(v)])),
        expenses_total: r0(expenseTotal),
        rent_from_settings: rentImputed,
        profit_before_split: r0(raw),
        my_profit: r0(profit),
        cancelled_nights: cancelledNights,
        checkouts,
        purchases_per_checkout: checkouts ? r0((expenses["закупки"] || 0) / checkouts) : null,
        platforms: Object.fromEntries(Object.entries(byPlatform).map(([k, v]) => [k, { nights: v.nights, gross: r0(v.gross) }])),
      };
    });

    // Ближайшие 30 дней: занятость и свободные окна.
    const horizonTo = iso(new Date(parse(today) + 30 * DAY));
    const busy = aptBookings.filter((b) => b.begin_date && b.end_date).map((b) => [b.begin_date!, b.end_date!] as [string, string]);
    const gaps = freeGaps(busy, today, horizonTo);
    const freeNights = gaps.reduce((s, g) => s + g.nights, 0);

    // Уборки: брони с выездом в прошлом без записи уборки (если цена задана).
    if (Number(apt.cleaningPrice || 0) > 0) {
      const cleaningIds = new Set(aptEntries.filter((e) => e.meta?.kind === "cleaning").map((e) => String(e.meta?.booking_id)));
      const first = monthRange(months[0]).from;
      const missing = aptBookings.filter((b) => b.end_date && b.end_date >= first && b.end_date < today && !cleaningIds.has(String(b.booking_id)));
      if (missing.length) issues.push(`${name}: ${missing.length} брон. с выездом без записи уборки (брони ${missing.slice(0, 5).map((b) => b.booking_id).join(", ")}${missing.length > 5 ? "…" : ""}).`);
    }

    return {
      name,
      model: model === "trust" ? `доверительное управление, доля УК ${share}%` : `субаренда, аренда ${r0(rentSetting)} ₽/мес, день оплаты ${apt.paymentDay || "—"}`,
      cleaning_price: r0(Number(apt.cleaningPrice || 0)),
      months: perMonth,
      next_30_days: { free_nights: freeNights, occupancy_pct: r0(((30 - freeNights) / 30) * 100), free_gaps: gaps.filter((g) => g.nights >= 1).slice(0, 8) },
    };
  });

  // Дубли и подозрительные записи.
  const firstFrom = monthRange(months[0]).from;
  const seen = new Map<string, number>();
  for (const e of entries) {
    if (!e.date || e.date < firstFrom || e.type !== "expense") continue;
    if (e.status === "cancelled") continue;
    const amt = Number(e.amount || 0);
    const apt = apts.find((a: any) => a.id === e.apartmentId);
    const nm = apt?.name || "без квартиры";
    if (!(amt > 0)) issues.push(`${nm}: расход «${e.title || e.category || "без названия"}» от ${e.date} с нулевой суммой.`);
    if (!e.apartmentId) issues.push(`Расход «${e.title || "без названия"}» от ${e.date} на ${r0(amt)} ₽ без квартиры.`);
    if (e.source === "manual" && amt >= 50000 && !/аренд|выплат/i.test(`${e.title} ${e.category}`)) {
      issues.push(`${nm}: крупный ручной расход «${e.title || e.category}» ${r0(amt)} ₽ от ${e.date} — проверьте.`);
    }
    const key = `${e.apartmentId}|${e.date}|${amt}|${String(e.title || "").trim().toLowerCase()}`;
    seen.set(key, (seen.get(key) || 0) + 1);
  }
  for (const [key, n] of seen) {
    if (n < 2) continue;
    const [aptId, date, amt, title] = key.split("|");
    const nm = apts.find((a: any) => a.id === aptId)?.name || "без квартиры";
    issues.push(`${nm}: возможный дубль — «${title || "без названия"}» ${amt} ₽ от ${date} записан ${n} раза.`);
  }
  for (const b of active) {
    if (Number(b.amount || 0) <= 0 && b.end_date && b.end_date >= firstFrom) {
      issues.push(`Бронь ${b.booking_id} (${b.begin_date}–${b.end_date}) с нулевой суммой.`);
    }
  }

  // --- Закупки: частота, расход на выезд, разброс цен (за последние 6 месяцев) ---
  const purchases = buildPurchaseStats(state, apts, active, today, issues);

  // Крупнейшие расходы главного месяца, кроме аренды и уборок.
  const mainYm = months[months.length - 1];
  const topExpenses = entries
    .filter((e) => e.type === "expense" && e.status !== "cancelled" && e.date && String(e.date).slice(0, 7) === mainYm
      && e.source !== "auto-owner-payout" && !["аренда", "уборка"].includes(expenseKind(e)))
    .map((e) => ({
      apartment: apts.find((a: any) => a.id === e.apartmentId)?.name || "без квартиры",
      title: String(e.title || e.category || "без названия").slice(0, 60),
      kind: expenseKind(e),
      date: e.date,
      amount: r0(Number(e.amount || 0)),
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 15);

  const totals = months.map((ym) => {
    let gross = 0, income = 0, expenses = 0, mine = 0, nights = 0, days = 0;
    for (const a of apartments) {
      const m = a.months.find((x: any) => x.month === ym)!;
      gross += m.revenue_gross; income += m.income_net; expenses += m.expenses_total; mine += m.my_profit;
      nights += m.nights_sold; days += m.days_in_month;
    }
    return { month: ym, revenue_gross: gross, income_net: income, expenses_total: expenses, my_profit: mine, occupancy_pct: days ? r0((nights / days) * 100) : 0 };
  });

  return {
    today,
    currency: "RUB",
    notes: [
      "my_profit — заработок владельца бизнеса до налогов (для ДУ — его доля).",
      "В учёте нет налогов; коммуналка и прочие расходы — только если записаны.",
    ],
    totals,
    apartments,
    top_expenses_main_month: topExpenses,
    purchases,
    accounting_issues: Array.from(new Set(issues)).slice(0, 40),
  };
}

// --- Закупки -----------------------------------------------------------------

function normName(s: unknown): string {
  return String(s || "").toLowerCase().replace(/ё/g, "е").replace(/\s+/g, " ").trim();
}

/**
 * Статистика заявок на закупку за 6 месяцев по каждой позиции в каждой квартире:
 * сколько раз и через сколько дней заказывали, сколько выездов прошло между первым
 * и последним заказом (= сколько заездов «съела» закупка), цена за единицу.
 */
function buildPurchaseStats(state: any, apts: any[], active: AiBooking[], today: string, issues: string[]) {
  const since = iso(new Date(parse(today) - 183 * DAY));
  const reqs: any[] = (state?.purchaseRequests || []).filter((r: any) => String(r?.createdAt || "").slice(0, 10) >= since);
  const groups = new Map<string, any>();
  let openCount = 0;
  for (const r of reqs) {
    const date = String(r.createdAt || "").slice(0, 10);
    const apt = apts.find((a: any) => a.id === r.apartmentId);
    const aptName = apt?.name || r.apartmentName || "без квартиры";
    if (!r.done) {
      openCount += 1;
      const age = nightsBetween(date, today);
      if (age > 7) issues.push(`${aptName}: заявка на закупку от ${date} не выполнена уже ${age} дн.`);
      continue;
    }
    const noCost = (r.items || []).filter((i: any) => !(Number(i.cost) > 0));
    if (noCost.length) issues.push(`${aptName}: в выполненной заявке от ${date} нет цены у ${noCost.length} поз. (${noCost.slice(0, 3).map((i: any) => i.name).join(", ")}) — расход не попал в учёт.`);
    for (const it of r.items || []) {
      const key = `${r.apartmentId}|${normName(it.name)}`;
      const g = groups.get(key) || { apartmentId: r.apartmentId, apartment: aptName, item: String(it.name || "").slice(0, 60), unit: it.unit || "шт", orders: [] as any[] };
      g.orders.push({ date, qty: Number(it.qty || 0), cost: Number(it.cost || 0) });
      groups.set(key, g);
    }
  }
  const checkoutsBetween = (aptId: string, from: string, to: string) => {
    const apt = apts.find((a: any) => a.id === aptId);
    const rcId = apt?.externalIds?.realtyCalendarUnitId ? String(apt.externalIds.realtyCalendarUnitId) : "";
    if (!rcId) return null;
    return active.filter((b) => String(b.realty_id) === rcId && b.end_date && b.end_date > from && b.end_date <= to).length;
  };
  const items = Array.from(groups.values()).map((g) => {
    g.orders.sort((a: any, b: any) => (a.date < b.date ? -1 : 1));
    const first = g.orders[0], last = g.orders[g.orders.length - 1];
    const totalQty = g.orders.reduce((s: number, o: any) => s + o.qty, 0);
    const totalCost = g.orders.reduce((s: number, o: any) => s + o.cost, 0);
    const unitPrices = g.orders.filter((o: any) => o.qty > 0 && o.cost > 0).map((o: any) => o.cost / o.qty);
    const n = g.orders.length;
    // Явная ошибка ввода: сотни единиц по 1–5 ₽ (скорее всего, сумму вписали в количество).
    for (const o of g.orders) {
      if (o.qty >= 100 && o.cost > 0 && o.cost / o.qty <= 5) {
        issues.push(`${g.apartment}: в заявке от ${o.date} «${g.item}» — ${o.qty} ${g.unit} за ${r0(o.cost)} ₽ (≈${Math.round((o.cost / o.qty) * 100) / 100} ₽ за шт), похоже на ошибку в количестве.`);
      }
    }
    const span = nightsBetween(first.date, last.date);
    // Между первым и последним заказом израсходовано всё, кроме последней партии.
    const usedQty = totalQty - last.qty;
    const coBetween = n >= 2 ? checkoutsBetween(g.apartmentId, first.date, last.date) : null;
    const coSinceLast = checkoutsBetween(g.apartmentId, last.date, today);
    const apt = apts.find((a: any) => a.id === g.apartmentId);
    // Норма расхода на заезд из инвентаря квартиры (если позиция там заведена).
    const inv = (apt?.items || []).find((i: any) => normName(i.name) === normName(g.item));
    return {
      apartment: g.apartment,
      guests_capacity: Number(apt?.sleepingCapacity || 0) || null,
      norm_per_checkout: inv && Number(inv.perCheckin) > 0 ? Number(inv.perCheckin) : null,
      item: g.item,
      unit: g.unit,
      orders: n,
      dates: g.orders.map((o: any) => o.date),
      qty_per_order: g.orders.map((o: any) => o.qty),
      total_qty: totalQty,
      total_cost: r0(totalCost),
      avg_days_between_orders: n >= 2 ? r0(span / (n - 1)) : null,
      checkouts_between_first_and_last: coBetween,
      qty_used_per_checkout: n >= 2 && coBetween ? Math.round((usedQty / coBetween) * 100) / 100 : null,
      checkouts_since_last_order: coSinceLast,
      unit_price_min: unitPrices.length ? r0(Math.min(...unitPrices)) : null,
      unit_price_max: unitPrices.length ? r0(Math.max(...unitPrices)) : null,
    };
  });
  // Сравнение одной позиции между квартирами (цена за единицу).
  const byItem = new Map<string, any[]>();
  for (const it of items) {
    const k = normName(it.item);
    byItem.set(k, [...(byItem.get(k) || []), it]);
  }
  const crossApartment = Array.from(byItem.values())
    .filter((list) => list.length >= 2)
    .map((list) => ({
      item: list[0].item,
      by_apartment: list.map((x) => ({ apartment: x.apartment, orders: x.orders, total_qty: x.total_qty, total_cost: x.total_cost, unit_price_max: x.unit_price_max, qty_used_per_checkout: x.qty_used_per_checkout })),
    }));
  const totalCost = items.reduce((s, x) => s + x.total_cost, 0);
  return {
    period_from: since,
    requests_done: reqs.filter((r) => r.done).length,
    requests_open: openCount,
    total_cost: r0(totalCost),
    // Сначала повторяющиеся позиции и самые дорогие.
    items: items.sort((a, b) => (b.orders - a.orders) || (b.total_cost - a.total_cost)).slice(0, 60),
    same_item_across_apartments: crossApartment.slice(0, 20),
    // Остатки расходников по инвентарю: норма на заезд, остаток, желаемый запас.
    inventory: apts.map((a: any) => ({
      apartment: a.name,
      items: (a.items || [])
        .filter((i: any) => Number(i.perCheckin) > 0 || Number(i.par) > 0)
        .slice(0, 25)
        .map((i: any) => ({ name: String(i.name || "").slice(0, 40), stock: Number(i.stock || 0), par: Number(i.par || 0), norm_per_checkout: Number(i.perCheckin || 0) || null })),
    })).filter((x: any) => x.items.length),
  };
}

// --- Модель ---------------------------------------------------------------

export const AI_ANALYSIS_INSTRUCTIONS = [
  "Ты финансовый аналитик бизнеса посуточной аренды квартир в Москве (бренд Green Yard / А-Смена).",
  "Тебе дают точные цифры в JSON: по каждой квартире по месяцам — ночи, заполняемость, средняя цена ночи (adr_gross),",
  "выручка, комиссия площадок, чистый доход, расходы по видам, прибыль владельца (my_profit), отменённые ночи,",
  "площадки, свободные окна на ближайшие 30 дней и список несостыковок в учёте.",
  "Сам ничего не пересчитывай по-другому и не придумывай цифр, которых нет в данных.",
  "rent_from_settings=true значит, что записи аренды за месяц в учёте нет и в расчёт подставлена сумма из настроек квартиры.",
  "Пиши по-русски, коротко и по делу, обычным текстом без Markdown (без *, #, таблиц), суммы в формате «296 тыс. ₽».",
  "Структура ответа строго такая:",
  "ИТОГ — сколько заработано в главном (последнем) месяце и сравнение с прошлым; если месяц ещё идёт — так и скажи и дай грубый прогноз по уже полученным броням.",
  "ПО КВАРТИРАМ — по строке на квартиру: прибыль, заполняемость, средняя цена ночи, главная причина роста или падения.",
  "ЗАПОЛНЯЕМОСТЬ И ЦЕНЫ — где пустые даты в ближайшие 30 дней, где заполняемость низкая и что сделать с ценой (снизить/поднять, на сколько примерно и на какие даты); опирайся на сравнение квартир между собой и по месяцам.",
  "РАСХОДЫ И ЗАКУПКИ — главный раздел про потери денег. Посмотри структуру расходов по квартирам (expenses, purchases_per_checkout,",
  "top_expenses_main_month) и обязательно заявки на закупку (purchases): по каждой позиции даны даты заказов, количество,",
  "среднее число дней между заказами, выезды между первым и последним заказом, расход на один выезд (qty_used_per_checkout),",
  "цена за единицу и сравнение одной позиции между квартирами. Ищи, где теряются деньги: позиция заказывается слишком часто",
  "для своего объёма (например, средство для пола 5 л раз в месяц — странно, его должно хватать надолго; 100 пар тапочек",
  "закончились за 2 месяца — проверь, сколько пар уходит на выезд по сравнению с числом гостей guests_capacity),",
  "расход на выезд сильно выше, чем в других квартирах, цена за единицу выросла или в одной квартире дороже, чем в другой.",
  "Если norm_per_checkout задан — сравнивай фактический расход с этой нормой; guests_capacity=null — считай 2 гостя.",
  "Количество «1 шт» часто означает упаковку (тапочки, бумага, таблетки) — тогда суди по сумме и частоте заказов, а не по штукам.",
  "Если заказов по позиции пока по одному и сравнивать не с чем — скажи, что истории закупок мало, и что станет видно через 1–2 месяца.",
  "Оценивай здраво, с примерной нормой на один заезд для посуточной квартиры; называй позицию, квартиру, цифры и возможную",
  "причину (уносят гости, перерасход горничной, лишние заказы, дорогой поставщик). Если подозрительного нет — так и скажи.",
  "ОШИБКИ В УЧЁТЕ — перечисли несостыковки из accounting_issues своими словами; если их нет — напиши, что ошибок не найдено.",
  "ЧТО СДЕЛАТЬ — 3–5 конкретных действий по важности.",
  "Общий объём — до 3500 знаков.",
].join("\n");

export const AI_FOLLOWUP_INSTRUCTIONS = [
  "Ты финансовый аналитик бизнеса посуточной аренды квартир в Москве (Green Yard / А-Смена).",
  "Отвечай на вопрос владельца по данным JSON и своему прошлому разбору. Не придумывай цифр, которых нет в данных;",
  "если данных не хватает — так и скажи. По-русски, коротко, обычным текстом без Markdown, до 1500 знаков.",
].join("\n");

export const AI_MODELS = ["anthropic/claude-sonnet-5-5", "anthropic/claude-haiku-5-5", "openai/gpt-6-luna"];

/** Запрос к Perplexity Agent API. Пробует модели по очереди. */
export async function askAi(apiKey: string, instructions: string, input: string, maxTokens = 3000): Promise<{ text: string; model: string; costUsd: number | null }> {
  const errors: string[] = [];
  for (const model of AI_MODELS) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 55000);
    try {
      const r = await fetch("https://api.perplexity.ai/v1/agent", {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        // Рассуждения модели тоже расходуют лимит токенов — просим минимальные.
        body: JSON.stringify({ model, instructions, input, max_output_tokens: maxTokens, reasoning: { effort: "low" } }),
        signal: ctrl.signal,
      });
      const bodyText = await r.text();
      if (!r.ok) {
        errors.push(`${model}: http_${r.status} ${bodyText.slice(0, 150)}`);
        console.warn(`[ai] ${model} http_${r.status}: ${bodyText.slice(0, 300)}`);
        continue;
      }
      const data: any = JSON.parse(bodyText);
      const out = (Array.isArray(data?.output) ? data.output : [])
        .filter((o: any) => o?.type === "message")
        .flatMap((o: any) => (Array.isArray(o?.content) ? o.content : []))
        .filter((c: any) => c?.type === "output_text" && typeof c?.text === "string")
        .map((c: any) => c.text).join("").trim();
      const cost = Number(data?.usage?.cost?.total_cost);
      if (data?.status === "incomplete" || !out) {
        errors.push(`${model}: ${data?.status || "empty"}`);
        console.warn(`[ai] ${model} ${data?.status || "empty"}: ${JSON.stringify(data?.incomplete_details ?? null)}`);
        continue;
      }
      console.log(`[ai] ${model} ok in=${data?.usage?.input_tokens ?? "?"} out=${data?.usage?.output_tokens ?? "?"}`);
      return { text: out, model, costUsd: Number.isFinite(cost) ? cost : null };
    } catch (e) {
      errors.push(`${model}: ${String((e as Error)?.message || e)}`);
      console.warn(`[ai] ${model} exception: ${String((e as Error)?.message || e)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(`ИИ не ответил: ${errors.join("; ").slice(0, 400)}`);
}

/** Убирает остатки Markdown, если модель всё же его вставила. */
export function plainText(s: string): string {
  return String(s || "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*]\s+/gm, "• ")
    .trim();
}

/** Делит длинный текст на части для Telegram (лимит 4096). */
export function splitForTelegram(s: string, limit = 3900): string[] {
  const parts: string[] = [];
  let rest = s;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}
