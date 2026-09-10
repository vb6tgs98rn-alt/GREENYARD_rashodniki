/*!
 * Green Yard / Расходники — проприетарное ПО.
 * Copyright (c) 2026 Гусейнов Давид. Все права защищены.
 *
 * Копирование, распространение, переработка и обратная разработка
 * (reverse engineering) запрещены без письменного разрешения правообладателя.
 * Условия: см. файл LICENSE. Нарушение влечёт ответственность по ст. 1252,
 * 1301 ГК РФ.
 */

/**
 * linen.js
 * Учёт постельного белья и полотенец.
 * Позиции и события хранятся в отдельных таблицах Supabase — не в app_state,
 * чтобы не раздувать основной стейт (см. решение А из ТЗ).
 *
 * Схема БД:
 *   linen_items(id text PK, user_id uuid, apartment_id text, type, status,
 *               stain_note, washes_count, retired_reason, retired_at,
 *               created_at, updated_at)
 *   linen_events(id uuid, user_id, item_id, apartment_id, from_status,
 *                to_status, actor, note, photo_url, booking_id, cleaning_id, ts)
 *   apartment_linen_norms(user_id, apartment_id, type, norm_qty)
 *
 * ID позиций — простые 4-значные: 0001, 0002 … внутри пары (квартира × тип).
 * Пример: наволочка №1 в квартире → id "0001", наволочка №2 → "0002".
 */

import { supabase, requireUser } from './supabase-client.js';

// Типы позиций. S — односпальный комплект (отдельная норма по числу односпальных мест).
export const LINEN_TYPES = [
  { key: 'navolochka',      label: 'Наволочка',       prefix: 'NAV'  },
  { key: 'pododeyalnik',    label: 'Пододеяльник',    prefix: 'POD'  },
  { key: 'pododeyalnik_s',  label: 'Пододеяльник S',  prefix: 'PODS' },
  { key: 'prostynya',       label: 'Простыня',        prefix: 'PRO'  },
  { key: 'prostynya_s',     label: 'Простыня S',      prefix: 'PROS' },
  { key: 'polotence_s',     label: 'Полотенце S',     prefix: 'POLS' },
  { key: 'polotence_m',     label: 'Полотенце M',     prefix: 'POLM' },
  { key: 'polotence_l',     label: 'Полотенце L',     prefix: 'POLL' },
];

export const LINEN_STATUSES = [
  { key: 'ready',   label: 'готово'          },
  { key: 'in_use',  label: 'в использовании' },
  { key: 'laundry', label: 'в стирке'        },
  { key: 'stained', label: 'пятно'           },
  { key: 'retired', label: 'списано'         },
];

export function typeLabel(typeKey) {
  const t = LINEN_TYPES.find(x => x.key === typeKey);
  return t ? t.label : typeKey;
}
export function statusLabel(statusKey) {
  const s = LINEN_STATUSES.find(x => x.key === statusKey);
  return s ? s.label : statusKey;
}
function typeMeta(typeKey) {
  return LINEN_TYPES.find(x => x.key === typeKey) || null;
}

// Извлекает числовое значение из id (поддерживает и старые "NAV-XXXX-07",
// и новые "0001"), чтобы корректно продолжить нумерацию, если что-то осталось.
function extractIdNumber(id) {
  const s = String(id || '');
  const m = s.match(/(\d+)\s*$/);
  return m ? Number(m[1]) : 0;
}

// Следующий short_id (4 цифры) внутри пары (квартира × тип).
async function generateNextShortId(userId, apartmentId, typeKey) {
  const meta = typeMeta(typeKey);
  if (!meta) throw new Error(`unknown linen type: ${typeKey}`);
  const { data, error } = await supabase
    .from('linen_items')
    .select('short_id, id')
    .eq('user_id', userId)
    .eq('apartment_id', apartmentId)
    .eq('type', typeKey);
  if (error) throw error;
  let max = 0;
  (data || []).forEach((row) => {
    const n = extractIdNumber(row.short_id || row.id);
    if (Number.isFinite(n) && n > max) max = n;
  });
  return String(max + 1).padStart(4, '0');
}

// Формирует полный id (PK) из short_id и коротких частей квартиры/типа.
function makeFullId(apartmentId, typeKey, shortId) {
  const meta = typeMeta(typeKey) || { prefix: 'X' };
  const apt4 = String(apartmentId || '').replace(/-/g, '').slice(0, 4).toUpperCase();
  return `${meta.prefix}-${apt4}-${shortId}`;
}

/** Список всех позиций квартиры (кроме списанных, если includeRetired=false). */
export async function listItems(apartmentId, { includeRetired = false } = {}) {
  const user = await requireUser();
  if (!user) return [];
  let q = supabase
    .from('linen_items')
    .select('*')
    .eq('user_id', user.id)
    .eq('apartment_id', apartmentId)
    .order('type', { ascending: true })
    .order('id', { ascending: true });
  if (!includeRetired) q = q.neq('status', 'retired');
  const { data, error } = await q;
  if (error) { console.warn('[linen] listItems error:', error); return []; }
  return data || [];
}

/** Все нормы для квартиры: { type: norm_qty }. Пустые типы вернутся дефолтом на верхнем уровне. */
export async function listNorms(apartmentId) {
  const user = await requireUser();
  if (!user) return {};
  const { data, error } = await supabase
    .from('apartment_linen_norms')
    .select('type, norm_qty')
    .eq('user_id', user.id)
    .eq('apartment_id', apartmentId);
  if (error) { console.warn('[linen] listNorms error:', error); return {}; }
  const map = {};
  (data || []).forEach((row) => { map[row.type] = Number(row.norm_qty || 0); });
  return map;
}

/**
 * Расчёт нормы по типу из параметров квартиры.
 *
 * apt: { beds: [{type:'single'|'double'}], linenReserve: {pillow, bed_s, bed_full, towel} }
 *   • на каждое односпальное место:  1 гость, 1 подушка
 *   • на каждое двуспальное место:   2 гостя, 2 подушки
 *   • комплект белья (пододеяльник+простыня) отдельно S и обычный
 *   • 2 комплекта белья на спальное место, 2 комплекта полотенец на гостя
 *   • + резервы (в комплектах): pillow → +НАВ; bed_s → +ПОД S/ПРО S; bed_full → +ПОД/ПРО (по 2×резерв наволочек); towel → +полотенца
 */
export function computeNorms(apt) {
  const beds = Array.isArray(apt?.beds) ? apt.beds : [];
  const singles = beds.filter((b) => b?.type === 'single').length;
  const doubles = beds.filter((b) => b?.type === 'double').length;
  const pillows = singles + doubles * 2; // всего подушек
  const guests  = singles + doubles * 2; // макс. гостей
  const r = apt?.linenReserve || {};
  const rPillow  = Math.max(0, Math.trunc(Number(r.pillow   || 0)));
  const rBedS    = Math.max(0, Math.trunc(Number(r.bed_s    || 0)));
  const rBedFull = Math.max(0, Math.trunc(Number(r.bed_full || 0)));
  const rTowel   = Math.max(0, Math.trunc(Number(r.towel    || 0)));
  // Семантика резерва:
  //  • pillow  = N → +N наволочек
  //  • bed_s   = N → +⌈N/2⌉ комплектов S: +1 пододеяльник S на каждую пару, +1 простыня S, +1 наволочка
  //    (по твоей формуле: «резерв 2 → +1 наволочка, 1 пододеяльник s, 1 простыня s»)
  //  • bed_full = N → +⌈N/2⌉ комплектов двуспальных: +1 пододеяльник, +1 простыня, +2 наволочки
  //    («резерв 2 → +4 наволочки, 2 пододеяльника, 2 простыни» — т.е. на каждый комплект 2 наволочки)
  //  • towel   = N → +N полотенец каждого размера
  const setsS    = Math.ceil(rBedS    / 2);
  const setsFull = Math.ceil(rBedFull / 2);
  return {
    navolochka:     2 * pillows + rPillow + setsS + setsFull * 2,
    pododeyalnik:   2 * doubles + setsFull,
    pododeyalnik_s: 2 * singles + setsS,
    prostynya:      2 * doubles + setsFull,
    prostynya_s:    2 * singles + setsS,
    polotence_s:    2 * guests  + rTowel,
    polotence_m:    2 * guests  + rTowel,
    polotence_l:    2 * guests  + rTowel,
  };
}

/**
 * Автосписание позиций типов, которые больше не актуальны в квартире (norm=0, но позиции есть).
 * Списываем без автозаявки (тип больше не нужен).
 * Возвращает общее число списанных позиций.
 */
export async function retireIrrelevantForApt(apartmentId, apt, { actor = 'owner', reason = 'спальное место удалено' } = {}) {
  const norms = computeNorms(apt);
  const irrelevantTypes = LINEN_TYPES.filter((t) => Number(norms[t.key] || 0) === 0).map((t) => t.key);
  if (irrelevantTypes.length === 0) return 0;
  const items = await listItems(apartmentId, { includeRetired: false });
  const toRetire = items.filter((it) => irrelevantTypes.includes(it.type));
  let retired = 0;
  for (const it of toRetire) {
    // eslint-disable-next-line no-await-in-loop
    await setStatus(it.id, 'retired', { actor, note: reason, retiredReason: reason });
    retired += 1;
  }
  return retired;
}

/**
 * @deprecated Старая формула (sleepingCapacity × 3). Оставлена для обратной совместимости.
 */
export function defaultNormFor(sleepingCapacity) {
  const cap = Math.max(0, Math.trunc(Number(sleepingCapacity || 0)));
  return cap * 3;
}

/** Явно задать/обновить норму по типу. */
export async function setNorm(apartmentId, typeKey, normQty) {
  const user = await requireUser();
  if (!user) throw new Error('нет сессии');
  const qty = Math.max(0, Math.trunc(Number(normQty || 0)));
  const { error } = await supabase
    .from('apartment_linen_norms')
    .upsert({ user_id: user.id, apartment_id: apartmentId, type: typeKey, norm_qty: qty, updated_at: new Date().toISOString() },
            { onConflict: 'user_id,apartment_id,type' });
  if (error) throw error;
}

/** Записать событие в журнал (не бросает исключений на клиенте — не блокируем UI). */
async function logEvent({ userId, itemId, apartmentId, fromStatus, toStatus, actor = 'owner', note = '', photoUrl = '', bookingId = null, cleaningId = null }) {
  try {
    const payload = {
      user_id: userId,
      item_id: itemId,
      apartment_id: apartmentId,
      from_status: fromStatus || null,
      to_status: toStatus,
      actor,
      note: note || '',
      photo_url: photoUrl || '',
      booking_id: bookingId,
      cleaning_id: cleaningId,
    };
    const { error } = await supabase.from('linen_events').insert(payload);
    if (error) console.warn('[linen] logEvent error:', error);
  } catch (e) {
    console.warn('[linen] logEvent exception:', e);
  }
}

/**
 * Создать одну новую позицию (по умолчанию в статусе ready).
 * Возвращает id новой позиции.
 */
export async function createItem(apartmentId, typeKey, { status = 'ready', actor = 'owner' } = {}) {
  const user = await requireUser();
  if (!user) throw new Error('нет сессии');
  const shortId = await generateNextShortId(user.id, apartmentId, typeKey);
  const id = makeFullId(apartmentId, typeKey, shortId);
  const now = new Date().toISOString();
  const { error } = await supabase.from('linen_items').insert({
    id,
    short_id: shortId,
    user_id: user.id,
    apartment_id: apartmentId,
    type: typeKey,
    status,
    stain_note: '',
    washes_count: 0,
    retired_reason: '',
    created_at: now,
    updated_at: now,
  });
  if (error) throw error;
  await logEvent({ userId: user.id, itemId: id, apartmentId, fromStatus: null, toStatus: status, actor, note: 'создана позиция' });
  return { id, short_id: shortId };
}

/**
 * Пакетное создание N позиций одного типа (мастер стартовой инвентаризации).
 * Возвращает массив созданных id.
 */
export async function bulkCreate(apartmentId, typeKey, count, { actor = 'owner' } = {}) {
  const n = Math.max(0, Math.trunc(Number(count || 0)));
  const ids = [];
  for (let i = 0; i < n; i++) {
    // eslint-disable-next-line no-await-in-loop
    const rec = await createItem(apartmentId, typeKey, { actor });
    ids.push(rec.id);
  }
  return ids;
}

/**
 * Инвентаризация = УСТАНОВИТЬ итог по типу как `targetQty`.
 * Сейчас больше — лишние списываем (retired, причина в note — «инвентаризация»).
 * Меньше — дозаводим ready.
 * Порядок списания: stained → laundry → ready → in_use.
 */
export async function inventorySet(apartmentId, typeKey, targetQty, { actor = 'owner' } = {}) {
  const user = await requireUser();
  if (!user) throw new Error('нет сессии');
  const target = Math.max(0, Math.trunc(Number(targetQty || 0)));
  const { data: current, error } = await supabase
    .from('linen_items')
    .select('id, status')
    .eq('user_id', user.id)
    .eq('apartment_id', apartmentId)
    .eq('type', typeKey)
    .neq('status', 'retired');
  if (error) throw error;
  const list = current || [];
  const now = list.length;
  let created = 0;
  let retired = 0;
  if (target > now) {
    const need = target - now;
    for (let i = 0; i < need; i++) {
      // eslint-disable-next-line no-await-in-loop
      await createItem(apartmentId, typeKey, { actor });
      created += 1;
    }
  } else if (target < now) {
    const rank = { stained: 0, laundry: 1, ready: 2, in_use: 3 };
    const ordered = [...list].sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));
    const toRetire = ordered.slice(0, now - target);
    for (const it of toRetire) {
      // eslint-disable-next-line no-await-in-loop
      await setStatus(it.id, 'retired', { actor, note: 'инвентаризация' });
      retired += 1;
    }
  }
  return { created, retired };
}

/**
 * Обновить статус позиции. Если из in_use → laundry, увеличиваем washes_count.
 * Для retired проставляем retired_at и retired_reason.
 * Если предоставлен onAutoRequest(item) — вызовется при retired для авто-заявки на закупку.
 */
export async function setStatus(itemId, toStatus, { actor = 'owner', note = '', photoUrl = '', bookingId = null, cleaningId = null, stainNote = '', retiredReason = '', onAutoRequest = null } = {}) {
  const user = await requireUser();
  if (!user) throw new Error('нет сессии');
  // Читаем текущее состояние, чтобы правильно оформить переход.
  const { data: current, error: readErr } = await supabase
    .from('linen_items').select('*').eq('id', itemId).eq('user_id', user.id).single();
  if (readErr) throw readErr;
  if (!current) throw new Error('позиция не найдена');
  const patch = { status: toStatus };
  if (current.status === 'in_use' && toStatus === 'laundry') {
    patch.washes_count = Number(current.washes_count || 0) + 1;
  }
  if (toStatus === 'laundry' && stainNote) patch.stain_note = stainNote;
  if (toStatus === 'ready') patch.stain_note = ''; // после стирки пятна больше нет
  if (toStatus === 'retired') {
    patch.retired_at = new Date().toISOString();
    patch.retired_reason = retiredReason || note || '';
  }
  const { error: updErr } = await supabase
    .from('linen_items').update(patch).eq('id', itemId).eq('user_id', user.id);
  if (updErr) throw updErr;
  await logEvent({
    userId: user.id, itemId, apartmentId: current.apartment_id,
    fromStatus: current.status, toStatus, actor, note, photoUrl, bookingId, cleaningId,
  });
  // Автозаявка на замену при списании.
  if (toStatus === 'retired' && typeof onAutoRequest === 'function') {
    try { onAutoRequest({ ...current, ...patch }); } catch (e) { console.warn('[linen] onAutoRequest failed:', e); }
  }
  return true;
}

/** Удобная обёртка «отметить постиранное» — все переданные id переводит в ready. */
export async function markLaundered(itemIds, { actor = 'owner' } = {}) {
  const ids = Array.isArray(itemIds) ? itemIds : [itemIds];
  for (const id of ids) {
    // eslint-disable-next-line no-await-in-loop
    await setStatus(id, 'ready', { actor, note: 'из стирки' });
  }
}

/**
 * Загрузить последние события журнала (с пагинацией; по умолчанию последние 50).
 * apartmentId — обязателен.
 */
export async function listEvents(apartmentId, { limit = 50 } = {}) {
  const user = await requireUser();
  if (!user) return [];
  const { data, error } = await supabase
    .from('linen_events')
    .select('*')
    .eq('user_id', user.id)
    .eq('apartment_id', apartmentId)
    .order('ts', { ascending: false })
    .limit(Math.max(1, Math.min(500, limit)));
  if (error) { console.warn('[linen] listEvents error:', error); return []; }
  return data || [];
}

/**
 * Свод по квартире: массив { type, label, norm, have, stained, stainedIds }.
 * norm — из apartment_linen_norms (если задана явно) или computeNorms(apt) по параметрам квартиры.
 * Передавать можно либо объект apt (новый API), либо sleepingCapacity (старый вызов).
 */
export async function getSummary(apartmentId, aptOrCap) {
  const [items, norms] = await Promise.all([
    listItems(apartmentId, { includeRetired: false }),
    listNorms(apartmentId),
  ]);
  const buckets = {};
  LINEN_TYPES.forEach((t) => { buckets[t.key] = { have: 0, stained: 0, stainedIds: [] }; });
  items.forEach((it) => {
    const b = buckets[it.type];
    if (!b) return;
    b.have += 1;
    if (it.status === 'stained') {
      b.stained += 1;
      b.stainedIds.push({
        id: it.id,
        short_id: it.short_id || it.id,
        note: it.stain_note || '',
        updated_at: it.updated_at || null,
      });
    }
  });
  // Нормы: если передан apt-объект — считаем по computeNorms; если число — старая формула.
  const perType = (typeof aptOrCap === 'object' && aptOrCap !== null)
    ? computeNorms(aptOrCap)
    : null;
  const legacyNorm = defaultNormFor(aptOrCap);
  return LINEN_TYPES.map((t) => {
    const b = buckets[t.key];
    const explicit = Object.prototype.hasOwnProperty.call(norms, t.key)
      ? Number(norms[t.key] || 0)
      : null;
    const norm = explicit != null
      ? explicit
      : (perType ? Number(perType[t.key] || 0) : legacyNorm);
    return { type: t.key, label: t.label, norm, have: b.have, stained: b.stained, stainedIds: b.stainedIds };
  });
}

// ─── Обёртки над статусом «пятно» ───────────────────────────────────────

/** Пометить позицию как «пятно» (временно выводится из оборота). */
export async function markStained(itemId, { actor = 'owner', note = '', photoUrl = '' } = {}) {
  return setStatus(itemId, 'stained', { actor, note, photoUrl, stainNote: note });
}

/** Снять пятно (отстиралось) → ready. */
export async function unstain(itemId, { actor = 'owner' } = {}) {
  return setStatus(itemId, 'ready', { actor, note: 'пятно отстиралось' });
}

/** Найти позицию по (apartmentId, type, shortId) — вернёт объект или null. */
export async function findByShortId(apartmentId, typeKey, shortId) {
  const user = await requireUser();
  if (!user) return null;
  const norm = String(shortId || '').trim();
  if (!norm) return null;
  const { data, error } = await supabase
    .from('linen_items')
    .select('*')
    .eq('user_id', user.id)
    .eq('apartment_id', apartmentId)
    .eq('type', typeKey)
    .or(`short_id.eq.${norm},id.like.%-${norm}`)
    .limit(1)
    .maybeSingle();
  if (error) { console.warn('[linen] findByShortId error:', error); return null; }
  return data || null;
}
