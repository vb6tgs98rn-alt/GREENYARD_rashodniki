-- =============================================================================
-- Залоги гостей через Точку Банк (двухэтапная оплата, холд 6 дней).
--
-- Гость платит по ссылке картой → деньги замораживаются (статус AUTHORIZED).
-- Арендодатель после выезда либо возвращает залог, либо штрафует гостя
-- (Capture Payment — списание всей суммы на расчётный счёт).
--
-- Писать в таблицу может только сервер (service_role): статусы денег
-- нельзя менять из браузера. Пользователь видит только свои залоги.
-- =============================================================================

create table if not exists public.booking_deposits (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  booking_id       bigint not null,
  amount           numeric(12,2) not null check (amount > 0),
  currency         text not null default 'RUB',
  purpose          text,
  operation_id     text,
  pay_url          text,
  -- created   — ссылка создана, гость ещё не заплатил;
  -- held      — деньги заморожены на карте гостя;
  -- capturing — отправлено списание (штраф), ждём подтверждения банка;
  -- captured  — штраф списан на расчётный счёт;
  -- released  — арендодатель вернул залог (холд снимается);
  -- expired   — ссылка или холд истекли;
  -- canceled  — ссылка заменена новой;
  -- failed    — ошибка банка.
  status           text not null default 'created'
                   check (status in ('created','held','capturing','captured','released','expired','canceled','failed')),
  -- manual — ссылку создал арендодатель, bot — бот при запуске, auto — бот в день заезда.
  source           text not null default 'manual' check (source in ('manual','bot','auto')),
  link_expires_at  timestamptz,
  sent_at          timestamptz,
  held_at          timestamptz,
  hold_expires_at  timestamptz,
  released_at      timestamptz,
  captured_at      timestamptz,
  raw              jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index if not exists booking_deposits_user_status_idx on public.booking_deposits (user_id, status);
create index if not exists booking_deposits_operation_idx  on public.booking_deposits (operation_id);
-- На одну бронь — не больше одного действующего залога.
create unique index if not exists booking_deposits_one_active
  on public.booking_deposits (user_id, booking_id)
  where status in ('created','held','capturing');

drop trigger if exists booking_deposits_touch on public.booking_deposits;
create trigger booking_deposits_touch
  before update on public.booking_deposits
  for each row execute function public.touch_updated_at();

alter table public.booking_deposits enable row level security;

drop policy if exists booking_deposits_select_own on public.booking_deposits;
create policy booking_deposits_select_own on public.booking_deposits
  for select to authenticated using (auth.uid() = user_id);

revoke all on public.booking_deposits from anon, authenticated;
grant select on public.booking_deposits to authenticated;

-- Секрет для ежедневной задачи «отправить залог в день заезда».
insert into public.cron_config (key, secret, updated_at)
values ('deposit_autosend', encode(extensions.gen_random_bytes(24), 'hex'), now())
on conflict (key) do nothing;

-- Каждый день в 09:00 МСК (06:00 UTC) бот отправляет ссылки на залог гостям,
-- у которых сегодня заезд и до выезда не больше 5 дней.
select cron.unschedule('deposit-autosend-daily')
where exists (select 1 from cron.job where jobname = 'deposit-autosend-daily');

select cron.schedule(
  'deposit-autosend-daily',
  '0 6 * * *',
  $cron$
  select net.http_post(
    url := 'https://wpwuxcxmtvdxftqrrxuu.supabase.co/functions/v1/telegram-bot/deposit_autosend',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select secret from public.cron_config where key = 'deposit_autosend')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cron$
);
