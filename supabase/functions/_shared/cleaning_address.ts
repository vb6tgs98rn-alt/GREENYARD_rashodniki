// Адрес квартиры для сообщений горничным.
// Берётся из инструкции для гостей (guest_instructions.full_address).
// Связь: rc realty_id → квартира в app_state (externalIds.realtyCalendarUnitId) → инструкция.
// Если адрес не заполнен или не найден — возвращаем null, сообщение уйдёт с названием квартиры.

import { htmlEscape } from "./channels.ts";

export async function cleaningAddress(sb: any, userId: string, realtyId: number | string | null): Promise<string | null> {
  if (!userId || realtyId == null || realtyId === "") return null;
  try {
    const { data: st } = await sb
      .from("app_state")
      .select("apartments:state->apartments")
      .eq("user_id", userId)
      .maybeSingle();
    const apts: any[] = Array.isArray(st?.apartments) ? st.apartments : [];
    const apt = apts.find((a) => String(a?.externalIds?.realtyCalendarUnitId || "") === String(realtyId));
    if (!apt?.id) return null;
    const { data: instr } = await sb
      .from("guest_instructions")
      .select("full_address")
      .eq("user_id", userId)
      .eq("apartment_id", apt.id)
      .maybeSingle();
    const addr = String(instr?.full_address || "").trim();
    return addr || null;
  } catch (e) {
    console.error("[cleaning_address] lookup failed:", e);
    return null;
  }
}

/**
 * Строка о времени гостей вокруг уборки: «гость выезжает в 11:00 · следующий заезд в 15:00».
 * Только время, которое менеджер указал в брони («Оформить заезд»). Нет данных — пустая строка.
 */
export async function cleaningGuestTimes(
  sb: any,
  userId: string,
  bookingId: string | number | null,
  realtyId: number | string | null,
  date: string | null,
): Promise<string> {
  if (!userId) return "";
  try {
    const parts: string[] = [];
    if (bookingId != null && bookingId !== "" && Number.isFinite(Number(bookingId))) {
      const { data: out } = await sb.from("rc_bookings")
        .select("checkout_time")
        .eq("user_id", userId)
        .eq("booking_id", Number(bookingId))
        .maybeSingle();
      if (out?.checkout_time) parts.push(`гость выезжает в ${String(out.checkout_time).slice(0, 5)}`);
    }
    if (realtyId != null && realtyId !== "" && date) {
      const { data: nxt } = await sb.from("rc_bookings")
        .select("checkin_time, status")
        .eq("user_id", userId)
        .eq("realty_id", Number(realtyId))
        .eq("begin_date", date)
        .not("checkin_time", "is", null)
        .limit(5);
      const n = (nxt || []).find((b: any) => !["cancelled", "canceled", "deleted"].includes(String(b.status || "").toLowerCase()));
      if (n?.checkin_time) parts.push(`следующий заезд в ${String(n.checkin_time).slice(0, 5)}`);
    }
    if (!parts.length) return "";
    const s = parts.join(" · ");
    return `⏱ ${s.charAt(0).toUpperCase()}${s.slice(1)}`;
  } catch (e) {
    console.error("[cleaning_address] guest times failed:", e);
    return "";
  }
}

/** Строки «квартира + адрес» для HTML-сообщения. */
export function placeLines(title: string | null, address: string | null): string {
  const t = htmlEscape(title || "?");
  return address ? `🏠 ${t}\n📍 Адрес: ${htmlEscape(address)}` : `📍 ${t}`;
}
