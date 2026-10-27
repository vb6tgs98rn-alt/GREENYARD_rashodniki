// =============================================================================
// cancel_report.ts — отменённые брони: запрос причины у менеджера и
// ежемесячный PDF «Отменённые брони» с упущенной выгодой.
// =============================================================================
// Модуль не зависит от среды (кроме рендера PDF, куда зависимости передаются).
// Связь ответа менеджера с бронью — по строке «Бронь №<id>» в исходном
// сообщении бота (Telegram присылает текст сообщения, на которое ответили).
// =============================================================================

// deno-lint-ignore-file no-explicit-any

import { money, round2, renderBlocksPdf, type Block } from "./owner_report.ts";

const MONTHS_NOM = [
  "январь", "февраль", "март", "апрель", "май", "июнь",
  "июль", "август", "сентябрь", "октябрь", "ноябрь", "декабрь",
];

/** Названия площадок для людей. */
const PLATFORM_LABELS: Record<string, string> = {
  Avito: "Авито",
  YandexTravel: "Яндекс Путешествия",
  "sutochno.ru": "Суточно.ру",
  "ostrovok.ru": "Островок",
  Cian: "ЦИАН",
  Bronevik: "Броневик",
  manual: "Вручную",
  widget: "Виджет",
};

export function platformLabel(source: string | null | undefined): string {
  const s = String(source || "").trim();
  if (!s) return "Не указана";
  return PLATFORM_LABELS[s] || s;
}

/** Комиссия площадки: как в приложении (сначала из данных RC, затем колонка). */
export function bookingCommission(b: any): number {
  const raw = Number(b?.raw_payload?.data?.booking?.platform_tax);
  if (Number.isFinite(raw) && raw > 0) return raw;
  const col = Number(b?.platform_tax);
  return Number.isFinite(col) && col > 0 ? col : 0;
}

/** Сумма брони после вычета комиссии площадки. */
export function netAmount(b: any): number {
  return round2(Math.max(0, Number(b?.amount || 0) - bookingCommission(b)));
}

/** дд.мм.гггг из ISO-даты. */
export function ddmmyyyy(iso: string | null | undefined): string {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : "?";
}

/** «21.10–25.10.2026» (год один раз, если совпадает). */
export function datesRange(begin: string | null, end: string | null): string {
  const a = String(begin || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  const b = String(end || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!a || !b) return `${ddmmyyyy(begin)}–${ddmmyyyy(end)}`;
  const left = a[1] === b[1] ? `${a[3]}.${a[2]}` : `${a[3]}.${a[2]}.${a[1]}`;
  return `${left}–${b[3]}.${b[2]}.${b[1]}`;
}

/** Название объекта: из приложения по realty_id, иначе из RC. */
export function objectName(apartments: any[], b: any): string {
  const apt = (apartments || []).find(
    (a: any) => String(a?.externalIds?.realtyCalendarUnitId || "") === String(b?.realty_id ?? ""),
  );
  return String(apt?.name || b?.apartment_title || `Объект ${b?.realty_id ?? "?"}`).trim();
}

// -----------------------------------------------------------------------------
// Сообщение менеджеру
// -----------------------------------------------------------------------------

export const CANCEL_ASK_MARK = "напишите причину отмены";
export const CANCEL_IGNORE_CMD = "cxl_ignore";

function esc(s: string): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** HTML-уведомление менеджеру об отменённой/удалённой брони. */
export function cancelNoticeHtml(b: any, objName: string, deleted: boolean): string {
  const net = netAmount(b);
  const guest = String(b?.client_fio || "").trim();
  return [
    `❌ <b>Бронь ${deleted ? "удалена" : "отменена"}</b>`,
    `Бронь №${b.booking_id}`,
    `🏠 ${esc(objName)} · ${esc(platformLabel(b?.source))}`,
    `📅 ${datesRange(b?.begin_date, b?.end_date)}`,
    Number(b?.amount || 0) > 0 ? `💰 ${esc(money(net))} (после комиссии)` : `💰 сумма не передана`,
    ...(guest ? [`👤 ${esc(guest)}`] : []),
    "",
    `Ответьте на это сообщение и ${CANCEL_ASK_MARK}.`,
    `Если это дубль или техническая запись — нажмите «Игнорировать».`,
  ].join("\n");
}

/** Номер брони из сообщения бота, на которое ответил менеджер (или null). */
export function bookingIdFromNotice(text: string | null | undefined): number | null {
  const t = String(text || "");
  if (!t.toLowerCase().includes(CANCEL_ASK_MARK)) return null;
  const m = t.match(/Бронь №\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

// -----------------------------------------------------------------------------
// Ежемесячный PDF
// -----------------------------------------------------------------------------

/** Границы прошлого месяца относительно даты (МСК, ISO). */
export function previousMonth(todayIso: string): { from: string; to: string; year: number; month1: number } {
  const [y, m] = todayIso.split("-").map(Number);
  const year = m === 1 ? y - 1 : y;
  const month1 = m === 1 ? 12 : m - 1;
  const last = new Date(Date.UTC(year, month1, 0)).getUTCDate();
  const p2 = (n: number) => String(n).padStart(2, "0");
  return { from: `${year}-${p2(month1)}-01`, to: `${year}-${p2(month1)}-${p2(last)}`, year, month1 };
}

export function monthTitle(year: number, month1: number): string {
  return `${MONTHS_NOM[month1 - 1]} ${year}`;
}

export interface CancelReportData {
  year: number;
  month1: number;
  from: string;
  to: string;
  groups: { name: string; rows: { platform: string; dates: string; net: number | null; reason: string }[]; total: number }[];
  count: number;
  lost: number;
}

/** Сбор данных: брони уже отфильтрованы (отменены/удалены, заезд в месяце, не игнорируются). */
export function computeCancelReport(apartments: any[], bookings: any[], from: string, to: string): CancelReportData {
  const [y, m] = from.split("-").map(Number);
  const byObj = new Map<string, any[]>();
  for (const b of bookings) {
    const name = objectName(apartments, b);
    if (!byObj.has(name)) byObj.set(name, []);
    byObj.get(name)!.push(b);
  }
  const groups = Array.from(byObj.entries())
    .sort((a, b) => a[0].localeCompare(b[0], "ru"))
    .map(([name, list]) => {
      list.sort((a, b) => String(a.begin_date).localeCompare(String(b.begin_date)));
      const rows = list.map((b) => ({
        platform: platformLabel(b.source),
        dates: datesRange(b.begin_date, b.end_date),
        // RC обнуляет сумму у некоторых отмен (Яндекс) — тогда суммы нет, в итог не идёт.
        net: Number(b.amount || 0) > 0 ? netAmount(b) : null,
        reason: String(b.cancellation_reason || "").trim() || "Причина не указана",
      }));
      return { name, rows, total: round2(rows.reduce((s, r) => s + (r.net ?? 0), 0)) };
    });
  const lost = round2(groups.reduce((s, g) => s + g.total, 0));
  const count = groups.reduce((s, g) => s + g.rows.length, 0);
  return { year: y, month1: m, from, to, groups, count, lost };
}

export function buildCancelBlocks(d: CancelReportData): Block[] {
  const blocks: Block[] = [];
  blocks.push({ kind: "title", text: `Отменённые брони — ${monthTitle(d.year, d.month1)}` });
  blocks.push({
    kind: "para",
    lines: [
      `Брони с заездом с ${ddmmyyyy(d.from)} по ${ddmmyyyy(d.to)}.`,
      "Сумма указана после вычета комиссии площадки.",
    ],
  });
  if (d.count === 0) {
    blocks.push({ kind: "para", lines: ["Отменённых броней нет."] });
  }
  for (const g of d.groups) {
    // Заголовок объекта не отрываем от таблицы: нужно место под шапку и пару строк.
    blocks.push({ kind: "h2", text: g.name, minSpace: 130 });
    const rows = g.rows.map((r) => [r.platform, r.dates, r.net == null ? "нет данных" : money(r.net), r.reason]);
    rows.push(["", "Итого", money(g.total), ""]);
    blocks.push({
      kind: "table",
      widths: [95, 100, 95, 215],
      header: ["Площадка", "Даты", "Сумма", "Причина отмены"],
      rows,
    });
  }
  blocks.push({ kind: "h2", text: `Упущенная выгода — ${money(d.lost)}` });
  blocks.push({ kind: "para", lines: [`Отменённых броней: ${d.count}.`] });
  return blocks;
}

export async function renderCancelReportPdf(deps: any, d: CancelReportData, fontBytes: Uint8Array): Promise<Uint8Array> {
  return await renderBlocksPdf(deps, buildCancelBlocks(d), `Отменённые брони — ${monthTitle(d.year, d.month1)}`, fontBytes);
}

export function cancelReportFileName(d: CancelReportData): string {
  const t = monthTitle(d.year, d.month1);
  return `Отмены — ${t[0].toUpperCase()}${t.slice(1)}.pdf`;
}
