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

/** Строки «квартира + адрес» для HTML-сообщения. */
export function placeLines(title: string | null, address: string | null): string {
  const t = htmlEscape(title || "?");
  return address ? `🏠 ${t}\n📍 Адрес: ${htmlEscape(address)}` : `📍 ${t}`;
}
