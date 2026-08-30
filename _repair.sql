-- Полностью пересобираем массив state.finance.entries:
--   1) оставляем все не-realtycalendar записи как есть
--   2) для realtycalendar: строим ровно по одной записи на booking из rc_bookings
-- Отменённые/удалённые брони отбрасываем (в state они и так должны быть 'cancelled').
WITH s AS (
  SELECT state FROM app_state WHERE user_id = '8a524105-b6c4-408a-9fe7-a611f75fbbc5'
),
apt_map AS (
  SELECT (a->'externalIds'->>'realtyCalendarUnitId')::bigint AS rc_id,
         a->>'id' AS apt_id,
         a->>'name' AS apt_name
  FROM s, jsonb_array_elements(s.state->'apartments') a
  WHERE a->'externalIds'->>'realtyCalendarUnitId' IS NOT NULL
),
non_rc AS (
  -- Всё что не realtycalendar — оставляем.
  SELECT el FROM s, jsonb_array_elements(s.state->'finance'->'entries') el
  WHERE (el->>'source') IS DISTINCT FROM 'realtycalendar'
),
-- Уборки (:cleaning) — сохраняем дедуплицированно.
rc_cleaning AS (
  SELECT DISTINCT ON (el->>'externalBookingId') el
  FROM s, jsonb_array_elements(s.state->'finance'->'entries') el
  WHERE el->>'source' = 'realtycalendar'
    AND el->>'externalBookingId' LIKE '%:cleaning'
),
-- Существующие записи о бронях, чтобы сохранить их id, а не рожать новые.
rc_existing AS (
  SELECT DISTINCT ON (el->>'externalBookingId') el->>'externalBookingId' AS bid, el
  FROM s, jsonb_array_elements(s.state->'finance'->'entries') el
  WHERE el->>'source' = 'realtycalendar'
    AND (el->>'externalBookingId') NOT LIKE '%:cleaning'
),
rc_final AS (
  SELECT
    COALESCE(rc_existing.el->>'id', gen_random_uuid()::text) AS id,
    r.booking_id::text AS bid,
    r.begin_date::text AS bd,
    r.end_date::text AS ed,
    r.amount::numeric AS gross,
    COALESCE(
      (r.raw_payload->'data'->'booking'->>'platform_tax')::numeric,
      r.platform_tax::numeric,
      0
    ) AS ptax,
    r.client_fio,
    r.booking_url,
    r.status AS rc_status,
    r.okidoki_contract_id AS contract_id,
    r.okidoki_link AS contract_link,
    r.contract_status,
    r.contract_status_internal,
    r.realty_id,
    r.apartment_title,
    apt_map.apt_id,
    apt_map.apt_name
  FROM rc_bookings r
  JOIN apt_map ON apt_map.rc_id = r.realty_id
  LEFT JOIN rc_existing ON rc_existing.bid = r.booking_id::text
  WHERE r.user_id = '8a524105-b6c4-408a-9fe7-a611f75fbbc5'
    AND r.status NOT IN ('canceled','deleted')
),
rc_entries AS (
  SELECT jsonb_build_object(
    'id', rf.id,
    'date', rf.bd,
    'type', 'income',
    'category', 'Бронирование',
    'title', rf.bd || ' → ' || rf.ed || COALESCE(' · ' || rf.client_fio, ''),
    'notes', '',
    'amount', rf.gross,
    'netAmount', GREATEST(0, rf.gross - rf.ptax),
    'currency', 'RUB',
    'source', 'realtycalendar',
    'status', 'confirmed',
    'apartmentId', rf.apt_id,
    'apartmentName', rf.apt_name,
    'externalBookingId', rf.bid,
    'meta', jsonb_build_object(
      'realty_id', rf.realty_id,
      'apartment_title', rf.apartment_title,
      'begin_date', rf.bd,
      'end_date', rf.ed,
      'client_fio', COALESCE(rf.client_fio,''),
      'booking_url', rf.booking_url,
      'rc_status', rf.rc_status,
      'platform_tax', rf.ptax,
      'contract_id', COALESCE(rf.contract_id, ''),
      'contract_link', COALESCE(rf.contract_link, ''),
      'contract_status', COALESCE(rf.contract_status, ''),
      'contract_status_internal', rf.contract_status_internal
    )
  ) AS el
  FROM rc_final rf
),
merged AS (
  SELECT el FROM rc_entries
  UNION ALL SELECT el FROM rc_cleaning
  UNION ALL SELECT el FROM non_rc
)
UPDATE app_state
SET state = jsonb_set(
  state,
  '{finance,entries}',
  (SELECT jsonb_agg(el) FROM merged)
),
updated_at = NOW()
WHERE user_id = '8a524105-b6c4-408a-9fe7-a611f75fbbc5'
RETURNING jsonb_array_length(state->'finance'->'entries') AS new_count;
