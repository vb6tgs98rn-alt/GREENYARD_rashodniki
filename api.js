export const API_CONFIG = {
  realtyCalendarWebhookPath: '/api/realtycalendar/bookings',
  realtyCalendarPullPath: '/api/realtycalendar/bookings/sync'
};

async function safeJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text };
  }
}

export async function postRealtyCalendarBookings(payload, endpoint = API_CONFIG.realtyCalendarWebhookPath) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  if (!response.ok) throw new Error(`Webhook error: ${response.status}`);
  return safeJson(response);
}

export async function syncRealtyCalendarBookings(params = {}, endpoint = API_CONFIG.realtyCalendarPullPath) {
  const query = new URLSearchParams(params).toString();
  const response = await fetch(query ? `${endpoint}?${query}` : endpoint);
  if (!response.ok) throw new Error(`Sync error: ${response.status}`);
  return safeJson(response);
}

export function normalizeRealtyCalendarBooking(raw) {
  return {
    externalBookingId: String(raw.externalBookingId || raw.id || crypto.randomUUID()),
    apartmentExternalId: String(raw.apartmentExternalId || raw.unitId || ''),
    apartmentId: String(raw.apartmentId || ''),
    guestName: raw.guestName || raw.guest || 'Гость',
    checkIn: raw.checkIn || raw.arrivalDate || raw.startDate || '',
    checkOut: raw.checkOut || raw.departureDate || raw.endDate || '',
    amount: Number(raw.amount || raw.total || raw.payout || 0),
    currency: raw.currency || 'RUB',
    channel: raw.channel || raw.source || 'RealtyCalendar',
    status: raw.status || 'confirmed',
    importedAt: new Date().toISOString(),
    raw
  };
}

export function buildFinanceWebhookExample() {
  return {
    event: 'booking.created',
    bookings: [{ externalBookingId: 'rc-1001', apartmentExternalId: 'unit-101', guestName: 'Иван Петров', checkIn: '2026-06-28', checkOut: '2026-07-02', amount: 18500, currency: 'RUB', channel: 'Airbnb', status: 'confirmed' }]
  };
}
