-- Кнопка «Указать причину» в сообщении об отмене брони:
-- запоминаем, какой чат менеджера ждёт ввода причины и до какого времени.
alter table public.rc_bookings
  add column if not exists cancel_wait_rcpt text,
  add column if not exists cancel_wait_until timestamptz;
comment on column public.rc_bookings.cancel_wait_rcpt is 'Чат менеджера (канал:chat_id), который нажал «Указать причину» и ждёт ввода';
comment on column public.rc_bookings.cancel_wait_until is 'До какого времени следующее сообщение из этого чата считается причиной отмены';
