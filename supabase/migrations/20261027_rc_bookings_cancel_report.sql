-- Отчёт по отменённым броням.
-- cancel_ignored  — менеджер нажал «Игнорировать» (дубль/техническая запись): бронь не попадает в PDF.
-- cancel_asked_at — когда менеджеру отправлен запрос причины (чтобы не спрашивать повторно,
--                   например если после отмены RC пришлёт ещё и удаление).
alter table public.rc_bookings
  add column if not exists cancel_ignored boolean not null default false,
  add column if not exists cancel_asked_at timestamptz;
