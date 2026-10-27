-- Частичный штраф по залогу.
-- Точка не умеет списывать часть холда, поэтому залог списывается целиком,
-- а остаток сразу возвращается гостю (Refund Payment Operation, частичный возврат).
--
-- penalty_amount      — сумма штрафа (null — старые записи: штраф на весь залог);
-- refund_amount       — сколько вернуть гостю после списания (null/0 — возврата нет);
-- refund_requested_at — запрос возврата отправлен в банк (защита от двойного возврата);
-- refunded_at         — банк принял возврат;
-- refund_error        — последняя ошибка возврата (для уведомления и экрана «Залог»).
alter table public.booking_deposits
  add column if not exists penalty_amount numeric(12,2),
  add column if not exists refund_amount numeric(12,2),
  add column if not exists refund_requested_at timestamptz,
  add column if not exists refunded_at timestamptz,
  add column if not exists refund_error text;

-- Штраф больше нуля и не больше залога; штраф + возврат = залог.
alter table public.booking_deposits
  drop constraint if exists booking_deposits_penalty_check;
alter table public.booking_deposits
  add constraint booking_deposits_penalty_check check (
    penalty_amount is null
    or (penalty_amount > 0 and penalty_amount <= amount
        and coalesce(refund_amount, 0) >= 0
        and penalty_amount + coalesce(refund_amount, 0) = amount)
  );
