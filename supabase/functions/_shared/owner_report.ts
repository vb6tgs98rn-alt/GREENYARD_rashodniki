/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 */
// =============================================================================
// owner_report.ts — расчёт и вёрстка PDF-отчёта по квартире за цикл оплаты.
// =============================================================================
// Структура и оформление повторяют согласованный эталон (A4, DejaVu Sans,
// светло-голубая шапка таблиц, тонкие серые границы).
// Все суммы считаются от одних и тех же округлённых чисел, дублирующие строки
// эталона (ADR, «Среднесуточный доход») убраны по согласованию.
// Модуль не зависит от среды: PDFDocument, rgb и fontkit передаются снаружи
// (в Edge Function — из esm.sh, в тестах — из npm).
// =============================================================================

// deno-lint-ignore-file no-explicit-any

// -----------------------------------------------------------------------------
// Вспомогательные функции дат и чисел
// -----------------------------------------------------------------------------

const MONTHS_GEN = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];

const NBSP = "\u00A0";

/** Округление до копеек без ошибок двоичной арифметики. */
export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100 + Number.EPSILON * 100) / 100;
}

/** Группировка разрядов неразрывным пробелом: 115916 → «115 916». */
function groupInt(intStr: string): string {
  return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
}

/** Сумма с копейками: 115916.5 → «115 916,50». */
export function fmt2(n: number): string {
  const v = round2(n);
  const neg = v < 0;
  const [i, f] = Math.abs(v).toFixed(2).split(".");
  return `${neg ? "−" : ""}${groupInt(i)},${f}`;
}

/** Сумма в рублях с копейками: «115 916,50 ₽». */
export function money(n: number): string {
  return `${fmt2(n)}${NBSP}₽`;
}

/** Число для строк расчёта: целое — без копеек («12 000»), дробное — с копейками. */
export function fmtCalc(n: number): string {
  const v = round2(n);
  if (Math.abs(v - Math.round(v)) < 0.005) {
    const neg = v < 0;
    return `${neg ? "−" : ""}${groupInt(String(Math.abs(Math.round(v))))}`;
  }
  return fmt2(v);
}

/** Десятичная дробь с двумя знаками без группировки: 2.333 → «2,33». */
function fmtDec(n: number): string {
  return round2(n).toFixed(2).replace(".", ",");
}

/** Склонение «день»: 1 день, 2 дня, 5 дней. */
function pluralDays(n: number): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return "дней";
  if (b === 1) return "день";
  if (b >= 2 && b <= 4) return "дня";
  return "дней";
}

function parseIso(iso: string): { y: number; m: number; d: number } {
  const [y, m, d] = String(iso).split("-").map(Number);
  return { y, m, d };
}

/** Количество ночей между датами (выезд не включается). */
export function nightsBetween(fromIso: string, toIso: string): number {
  if (!fromIso || !toIso) return 0;
  const a = Date.parse(fromIso + "T00:00:00Z");
  const b = Date.parse(toIso + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return 0;
  return Math.round((b - a) / 86400000);
}

/** Ночи брони [заезд, выезд), попавшие в период [from, to] включительно. */
export function bookingNightsInPeriod(begin: string, end: string, from: string, to: string): number {
  if (!begin || !end || !from || !to) return 0;
  const day = 86400000;
  const a1 = Date.parse(begin + "T00:00:00Z");
  const a2 = Date.parse(end + "T00:00:00Z");
  const b1 = Date.parse(from + "T00:00:00Z");
  const b2 = Date.parse(to + "T00:00:00Z") + day;
  if (!Number.isFinite(a1) || !Number.isFinite(a2) || a2 <= a1) return 0;
  const lo = Math.max(a1, b1);
  const hi = Math.min(a2, b2);
  if (hi <= lo) return 0;
  return Math.round((hi - lo) / day);
}

/** День месяца с поправкой на короткие месяцы (31 → 30/28). */
export function clampDay(year: number, month1: number, day: number): number {
  const last = new Date(Date.UTC(year, month1, 0)).getUTCDate();
  return Math.min(last, day);
}

function isoOf(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/**
 * Цикл оплаты, который закончился накануне дня выплаты payIso.
 * Пример: день выплаты 17, payIso = 2026-10-17 → 2026-09-17 … 2026-10-16.
 */
export function cycleEndingBefore(payIso: string, paymentDay: number): { from: string; to: string } {
  const p = parseIso(payIso);
  let sy = p.y, sm = p.m - 1;
  if (sm < 1) { sm = 12; sy -= 1; }
  const from = isoOf(sy, sm, clampDay(sy, sm, paymentDay));
  const endMs = Date.parse(payIso + "T00:00:00Z") - 86400000;
  const e = new Date(endMs);
  const to = isoOf(e.getUTCFullYear(), e.getUTCMonth() + 1, e.getUTCDate());
  return { from, to };
}

/** Является ли дата днём выплаты квартиры (с учётом коротких месяцев). */
export function isPaymentDay(iso: string, paymentDay: number): boolean {
  const p = parseIso(iso);
  return p.d === clampDay(p.y, p.m, paymentDay);
}

/** «17 сентября — 16 октября 2026 года» (год у начала — только если отличается). */
function periodText(from: string, to: string): string {
  const a = parseIso(from);
  const b = parseIso(to);
  const left = a.y === b.y ? `${a.d} ${MONTHS_GEN[a.m - 1]}` : `${a.d} ${MONTHS_GEN[a.m - 1]} ${a.y} года`;
  return `${left} — ${b.d} ${MONTHS_GEN[b.m - 1]} ${b.y} года`;
}

function ddmmyyyy(iso: string): string {
  const p = parseIso(iso);
  return `${String(p.d).padStart(2, "0")}.${String(p.m).padStart(2, "0")}.${p.y}`;
}

/** Нормализация названия расхода: «Жку» → «ЖКУ», первая буква — заглавная. */
function normLabel(s: string): string {
  const t = String(s || "").trim().replace(/\s+/g, " ");
  if (!t) return "Прочее";
  if (/^жк[ухс]$/i.test(t)) return t.toUpperCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// -----------------------------------------------------------------------------
// Расчёт данных отчёта
// -----------------------------------------------------------------------------

export interface ReportExpense {
  date: string;
  label: string;      // текст в «Детализации расходов»
  group: string;      // группа в первой таблице
  amount: number;
  isCleaning: boolean;
}

export interface ReportData {
  apartmentName: string;
  businessModel: "trust" | "sublease";
  from: string;
  to: string;
  days: number;
  revenue: number;
  expenses: ReportExpense[];
  expenseTotal: number;
  profit: number;
  soldNights: number;
  bookingsCount: number;
  stayNightsTotal: number;
  managerPct: number;  // доля управляющего (trustShare)
  ownerPct: number;    // доля собственника
}

/**
 * Собирает цифры отчёта по тем же правилам, что и таблица «По циклам оплаты»
 * в приложении: выручка — брони RC пропорционально ночам в периоде за вычетом
 * комиссии площадки + ручные доходы; расходы — все расходы квартиры за период
 * (кроме автозаписи «Выплата собственнику»).
 */
export function computeReport(state: any, bookings: any[], apt: any, from: string, to: string): ReportData {
  const days = Math.max(1, nightsBetween(from, to) + 1);
  let revenue = 0;
  let soldNights = 0;
  let bookingsCount = 0;
  let stayNightsTotal = 0;

  const rc = apt?.externalIds?.realtyCalendarUnitId;
  if (rc) {
    for (const b of bookings || []) {
      if (String(b.realty_id) !== String(rc)) continue;
      const st = String(b.status || "");
      if (st === "canceled" || st === "deleted") continue;
      const total = nightsBetween(b.begin_date, b.end_date);
      if (total <= 0) continue;
      const inside = bookingNightsInPeriod(b.begin_date, b.end_date, from, to);
      if (inside <= 0) continue;
      const gross = Number(b.amount || 0);
      const tax = Number(b.raw_payload?.data?.booking?.platform_tax ?? b.platform_tax ?? 0);
      const net = Math.max(0, gross - tax);
      revenue += net * (inside / total);
      soldNights += inside;
      bookingsCount += 1;
      stayNightsTotal += total;
    }
  }

  const expenses: ReportExpense[] = [];
  const entries: any[] = state?.finance?.entries || [];
  const model: "trust" | "sublease" = apt?.businessModel === "trust" ? "trust" : "sublease";
  let hasRentEntry = false;

  for (const e of entries) {
    if (e.apartmentId !== apt.id) continue;
    if (e.status === "cancelled") continue;
    if (e.source === "auto-owner-payout") continue;
    if (!e.date || e.date < from || e.date > to) continue;
    if (e.type === "income") {
      if (e.source === "realtycalendar") continue; // брони уже учтены из rc_bookings
      const gross = Number(e.amount || 0);
      const tax = Number(e.meta?.platform_tax || 0);
      const net = Number(e.netAmount != null ? e.netAmount : Math.max(0, gross - tax));
      revenue += net;
      continue;
    }
    if (e.type !== "expense") continue;
    const amount = round2(Number(e.amount || 0));
    const isCleaning = e.meta?.kind === "cleaning" || /:cleaning$/.test(String(e.externalBookingId || ""));
    if (e.source === "auto-rent") hasRentEntry = true;
    if (isCleaning) {
      const bid = e.meta?.booking_id ?? String(e.externalBookingId || "").split(":")[0];
      expenses.push({
        date: e.date,
        label: bid ? `Уборка · бронь №${bid}` : "Уборка",
        group: "Уборки",
        amount,
        isCleaning: true,
      });
    } else {
      const group = normLabel(e.category || e.title);
      const label = normLabel(e.title || e.category);
      expenses.push({ date: e.date, label, group, amount, isCleaning: false });
    }
  }

  // Субаренда: если автозапись аренды за этот цикл ещё не создана приложением —
  // добавляем аренду по условиям квартиры (дата — день оплаты, начало цикла).
  if (model === "sublease" && !hasRentEntry) {
    const rent = round2(Math.max(0, Number(apt.rentAmount || 0)));
    const pd = Math.trunc(Number(apt.paymentDay || 0));
    if (rent > 0 && pd >= 1 && pd <= 31) {
      const p = parseIso(from);
      const rentDate = isoOf(p.y, p.m, clampDay(p.y, p.m, pd));
      if (rentDate >= from && rentDate <= to) {
        const ym = rentDate.slice(0, 7);
        expenses.push({ date: rentDate, label: `Аренда за ${ym}`, group: "Аренда", amount: rent, isCleaning: false });
      }
    }
  }

  expenses.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  revenue = round2(revenue);
  const expenseTotal = round2(expenses.reduce((s, x) => s + x.amount, 0));
  const profit = round2(revenue - expenseTotal);
  const managerPct = Math.min(100, Math.max(0, Number(apt.trustShare || 0)));

  return {
    apartmentName: String(apt.name || "Квартира").trim(),
    businessModel: model,
    from, to, days,
    revenue, expenses, expenseTotal, profit,
    soldNights, bookingsCount, stayNightsTotal,
    managerPct, ownerPct: 100 - managerPct,
  };
}

// -----------------------------------------------------------------------------
// Вёрстка PDF
// -----------------------------------------------------------------------------

// Геометрия снята с эталона (точки, отсчёт сверху страницы).
const PAGE_W = 595.2756;
const PAGE_H = 841.8898;
const TEXT_X = 51.0236;        // заголовки и абзацы
const TABLE_X = 45.1378;       // левая граница таблиц
const TABLE_W = 505;
const CELL_PAD = 6;
const ROW_H = 23.05;
const ROW_TEXT_TOP = 9.2;      // от верха строки до верха глифа (9 pt)
const EXTRA_LINE = 11;         // доп. высота строки на каждую перенесённую строку
const BOTTOM_LIMIT = PAGE_H - 45;
const DESC = 0.236;            // нижний вынос DejaVu Sans (доля кегля)

const SIZE_TITLE = 18;
const SIZE_H2 = 13;
const SIZE_TEXT = 10;
const SIZE_CELL = 9;

// Отступы между элементами (верх глифа предыдущего → верх следующего).
const GAP = {
  firstTitle: 45.3,
  titleToPara: 34.2,
  paraToTable: 22.05,
  tableToH2: 18.15,
  h2ToPara: 28.1,
  paraLine: 14.5,
  paraToH2: 25.2,
  titleToTable: 31.8,
  h2ToTable: 25.7,
};

type Block =
  | { kind: "title"; text: string; newPage?: boolean }
  | { kind: "h2"; text: string }
  | { kind: "para"; lines: string[] }
  | { kind: "table"; widths: number[]; header: string[]; rows: string[][] };

/** Строит список блоков отчёта по данным. */
export function buildBlocks(d: ReportData): Block[] {
  const blocks: Block[] = [];
  const isTrust = d.businessModel === "trust";

  // --- Страница 1: итог периода ---
  blocks.push({ kind: "title", text: `${d.apartmentName} — финансовый отчёт` });
  blocks.push({ kind: "para", lines: [`Период: ${periodText(d.from, d.to)} (${d.days} ${pluralDays(d.days)}).`] });

  // Группы расходов в порядке первого появления; уборки — первыми.
  const cleanings = d.expenses.filter((x) => x.isCleaning);
  const groups: { name: string; sum: number }[] = [];
  for (const x of d.expenses) {
    if (x.isCleaning) continue;
    const g = groups.find((y) => y.name.toLowerCase() === x.group.toLowerCase());
    if (g) g.sum = round2(g.sum + x.amount);
    else groups.push({ name: x.group, sum: x.amount });
  }
  const cleanSum = round2(cleanings.reduce((s, x) => s + x.amount, 0));
  const cleanPrices = Array.from(new Set(cleanings.map((x) => x.amount)));
  const samePrice = cleanPrices.length === 1;
  const cleanRowLabel = samePrice
    ? `Уборки: ${cleanings.length} × ${fmtCalc(cleanPrices[0])}${NBSP}₽`
    : `Уборки: ${cleanings.length} шт.`;

  const occPct = d.days > 0 ? Math.min(100, Math.round((d.soldNights / d.days) * 100)) : 0;
  const profitLabel = isTrust ? "Прибыль до распределения" : "Прибыль";

  const sumRows: string[][] = [["Выручка по исходным данным", money(d.revenue)]];
  if (cleanings.length) sumRows.push([cleanRowLabel, money(cleanSum)]);
  for (const g of groups) sumRows.push([g.name, money(g.sum)]);
  sumRows.push(["Всего расходов", money(d.expenseTotal)]);
  sumRows.push([profitLabel, money(d.profit)]);
  sumRows.push(["Загрузка", `${occPct}%`]);
  blocks.push({ kind: "table", widths: [325, 180], header: ["Показатель", "Сумма"], rows: sumRows });

  // Детальный расчёт
  const calc: string[] = [];
  if (cleanings.length) {
    calc.push(samePrice
      ? `Уборки: ${cleanings.length} × ${fmtCalc(cleanPrices[0])} = ${fmtCalc(cleanSum)}${NBSP}₽.`
      : `Уборки: ${cleanings.map((x) => fmtCalc(x.amount)).join(" + ")} = ${fmtCalc(cleanSum)}${NBSP}₽.`);
  }
  const parts = [...(cleanings.length ? [cleanSum] : []), ...groups.map((g) => g.sum)];
  if (parts.length > 1) {
    calc.push(`Расходы: ${parts.map(fmtCalc).join(" + ")} = ${fmtCalc(d.expenseTotal)}${NBSP}₽.`);
  } else {
    calc.push(`Расходы: ${fmtCalc(d.expenseTotal)}${NBSP}₽.`);
  }
  calc.push(`Прибыль: ${fmtCalc(d.revenue)} − ${fmtCalc(d.expenseTotal)} = ${fmtCalc(d.profit)}${NBSP}₽.`);
  blocks.push({ kind: "h2", text: "Детальный расчёт" });
  blocks.push({ kind: "para", lines: calc });

  // Доверительное управление — только для квартир на ДУ.
  if (isTrust) {
    const base = d.profit;
    const owner = round2(base * d.ownerPct / 100);
    const manager = round2(base - owner);
    blocks.push({ kind: "h2", text: `Доверительное управление — ${d.ownerPct}/${d.managerPct}%` });
    blocks.push({ kind: "para", lines: [`${d.ownerPct}% прибыли — собственнику; ${d.managerPct}% — управляющему.`] });
    blocks.push({
      kind: "table",
      widths: [180, 205, 120],
      header: ["Показатель", "Расчёт", "Сумма"],
      rows: [
        ["База распределения", `${fmt2(owner)} + ${fmt2(manager)}`, money(base)],
        [`Собственнику — ${d.ownerPct}%`, `${fmt2(base)} × ${d.ownerPct}%`, money(owner)],
        [`Управляющему — ${d.managerPct}%`, `${fmt2(base)} × ${d.managerPct}%`, money(manager)],
      ],
    });
  }

  // --- Страница 2: детализация ---
  blocks.push({ kind: "title", text: "Детализация расходов", newPage: true });
  const expRows: string[][] = d.expenses.map((x) => [ddmmyyyy(x.date), x.label, money(x.amount)]);
  expRows.push(["", "Итого", money(d.expenseTotal)]);
  blocks.push({ kind: "table", widths: [90, 290, 125], header: ["Дата", "Расход", "Сумма"], rows: expRows });

  const free = Math.max(0, d.days - d.soldNights);
  const perDay = d.days > 0 ? d.revenue / d.days : 0;
  const perNight = d.soldNights > 0 ? d.revenue / d.soldNights : 0;
  const profitPerDay = d.days > 0 ? d.profit / d.days : 0;
  const avgStay = d.bookingsCount > 0 ? d.stayNightsTotal / d.bookingsCount : 0;
  blocks.push({ kind: "h2", text: "Показатели загрузки и доходности" });
  blocks.push({
    kind: "table",
    widths: [365, 140],
    header: ["Показатель", "Значение"],
    rows: [
      [`Занятые ночи: ${d.days} × ${occPct}%`, String(d.soldNights)],
      [`Незанятые ночи: ${d.days} − ${d.soldNights}`, String(free)],
      [`Выручка на календарный день: ${fmtCalc(d.revenue)} / ${d.days}`, money(perDay)],
      [`Выручка на занятую ночь: ${fmtCalc(d.revenue)} / ${d.soldNights}`, money(perNight)],
      [`Средняя прибыль квартиры за календарный день: ${fmtCalc(d.profit)} / ${d.days}`, money(profitPerDay)],
      ["Средняя длительность проживания", fmtDec(avgStay)],
    ],
  });
  return blocks;
}

/** Перенос текста по ширине (по словам). */
function wrapText(font: any, text: string, size: number, maxW: number): string[] {
  const words = String(text).split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const probe = cur ? `${cur} ${w}` : w;
    if (font.widthOfTextAtSize(probe, size) <= maxW || !cur) cur = probe;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

/**
 * Рендер PDF. deps = { PDFDocument, rgb, fontkit }; fontBytes — DejaVuSans.ttf.
 * Возвращает байты PDF.
 */
export async function renderReportPdf(deps: any, data: ReportData, fontBytes: Uint8Array): Promise<Uint8Array> {
  const { PDFDocument, rgb, fontkit } = deps;
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(fontBytes, { subset: true });
  doc.setTitle(`${data.apartmentName} — финансовый отчёт`);
  doc.setCreator("Green Yard");
  doc.setProducer("Green Yard");

  const black = rgb(0, 0, 0);
  const headFill = rgb(0.894118, 0.92549, 0.952941);
  const border = rgb(0.827451, 0.827451, 0.827451);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  // Курсор: верх глифа следующего элемента (для таблиц — верх таблицы).
  let cursor = 0;
  let prev: string = "start";

  // Текст по «верху глифа» (как в pdfplumber): baseline = top + size × (1 − DESC).
  const drawText = (text: string, x: number, top: number, size: number) => {
    page.drawText(text, { x, y: PAGE_H - (top + size * (1 - DESC)), size, font, color: black });
  };
  const hline = (x1: number, x2: number, top: number) => {
    page.drawLine({ start: { x: x1, y: PAGE_H - top }, end: { x: x2, y: PAGE_H - top }, thickness: 0.4, color: border });
  };
  const vline = (x: number, t1: number, t2: number) => {
    page.drawLine({ start: { x, y: PAGE_H - t1 }, end: { x, y: PAGE_H - t2 }, thickness: 0.4, color: border });
  };

  const gapFor = (kind: string): number => {
    if (prev === "start") return GAP.firstTitle;
    if (kind === "para") return prev === "title" ? GAP.titleToPara : prev === "h2" ? GAP.h2ToPara : GAP.paraLine;
    if (kind === "h2") return prev === "table" ? GAP.tableToH2 : GAP.paraToH2;
    if (kind === "table") return prev === "title" ? GAP.titleToTable : prev === "h2" ? GAP.h2ToTable : GAP.paraToTable;
    return GAP.paraToH2;
  };

  const newPage = () => {
    page = doc.addPage([PAGE_W, PAGE_H]);
    cursor = 0;
    prev = "start";
  };

  // Таблица с переносом строк и продолжением на следующей странице.
  const drawTable = (widths: number[], header: string[], rows: string[][], top: number): number => {
    const xs: number[] = [TABLE_X];
    for (const w of widths) xs.push(xs[xs.length - 1] + w);
    const layout = (cells: string[]) => {
      const lines = cells.map((c, i) => wrapText(font, c, SIZE_CELL, widths[i] - CELL_PAD * 2));
      const n = Math.max(...lines.map((l) => l.length));
      return { lines, h: ROW_H + (n - 1) * EXTRA_LINE };
    };
    const drawRow = (cells: string[], y: number, isHead: boolean): number => {
      const { lines, h } = layout(cells);
      if (isHead) {
        page.drawRectangle({ x: TABLE_X, y: PAGE_H - (y + h), width: TABLE_W, height: h, color: headFill });
      }
      lines.forEach((ls, i) => ls.forEach((ln, k) => drawText(ln, xs[i] + CELL_PAD, y + ROW_TEXT_TOP + k * EXTRA_LINE, SIZE_CELL)));
      return h;
    };
    // Сетка рисуется по завершённому фрагменту таблицы на странице.
    const drawGrid = (rowTops: number[], bottom: number) => {
      for (const t of rowTops) hline(TABLE_X, TABLE_X + TABLE_W, t);
      hline(TABLE_X, TABLE_X + TABLE_W, bottom);
      for (const x of xs) vline(x, rowTops[0], bottom);
    };

    let y = top;
    let rowTops: number[] = [y];
    y += drawRow(header, y, true);
    for (const r of rows) {
      const { h } = layout(r);
      if (y + h > BOTTOM_LIMIT) {
        drawGrid(rowTops, y);
        newPage();
        y = GAP.firstTitle;
        rowTops = [y];
        y += drawRow(header, y, true);
      }
      rowTops.push(y);
      y += drawRow(r, y, false);
    }
    drawGrid(rowTops, y);
    return y;
  };

  for (const b of buildBlocks(data)) {
    if (b.kind === "title") {
      if (b.newPage) newPage();
      cursor += gapFor("title");
      drawText(b.text, TEXT_X, cursor, SIZE_TITLE);
      prev = "title";
    } else if (b.kind === "h2") {
      if (cursor + 60 > BOTTOM_LIMIT) newPage();
      cursor += prev === "start" ? GAP.firstTitle : gapFor("h2");
      drawText(b.text, TEXT_X, cursor, SIZE_H2);
      prev = "h2";
    } else if (b.kind === "para") {
      for (const line of b.lines) {
        cursor += gapFor("para");
        drawText(line, TEXT_X, cursor, SIZE_TEXT);
        prev = "para";
      }
    } else if (b.kind === "table") {
      cursor += gapFor("table");
      if (cursor + ROW_H * 2 > BOTTOM_LIMIT) { newPage(); cursor = GAP.firstTitle; }
      cursor = drawTable(b.widths, b.header, b.rows, cursor);
      prev = "table";
    }
  }

  return await doc.save();
}

/** Имя файла отчёта: «Симфония 34 — отчёт 17.09–16.10.2026.pdf». */
export function reportFileName(d: ReportData): string {
  const a = parseIso(d.from), b = parseIso(d.to);
  const p2 = (n: number) => String(n).padStart(2, "0");
  const left = a.y === b.y ? `${p2(a.d)}.${p2(a.m)}` : `${p2(a.d)}.${p2(a.m)}.${a.y}`;
  const safe = d.apartmentName.replace(/[\\/:*?"<>|]+/g, " ").trim();
  return `${safe} — отчёт ${left}–${p2(b.d)}.${p2(b.m)}.${b.y}.pdf`;
}
