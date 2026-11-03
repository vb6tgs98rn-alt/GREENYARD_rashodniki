-- Контроль качества: оценки гостей и состояние цепочки сообщений бота.
-- Изменение только добавляет таблицу и поля, существующие данные не меняются
-- (кроме заполнения arrived_at/left_at по уже нажатым кнопкам гостей).

-- Оценки и отзывы гостей. Одна строка на бронь.
create table if not exists public.guest_reviews (
  id               bigserial primary key,
  user_id          uuid not null,
  booking_id       bigint not null,
  session_id       uuid,
  realty_id        bigint,
  apartment_title  text,
  guest_name       text,
  begin_date       date,
  end_date         date,
  source           text,
  channel          text,
  rating           smallint check (rating between 1 and 5),
  comment          text,
  checkin_comment  text,
  rated_at         timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (user_id, booking_id)
);
create index if not exists guest_reviews_user_realty_idx on public.guest_reviews (user_id, realty_id);

alter table public.guest_reviews enable row level security;
drop policy if exists guest_reviews_select_own on public.guest_reviews;
create policy guest_reviews_select_own on public.guest_reviews
  for select to authenticated using (auth.uid() = user_id);
grant select on public.guest_reviews to authenticated;

-- Состояние цепочки «заселение → вопрос → оценка» в сессии гостя.
alter table public.guest_sessions
  add column if not exists arrived_at               timestamptz,
  add column if not exists left_at                  timestamptz,
  add column if not exists checkin_ask_due_at       timestamptz,
  add column if not exists checkin_ask_sent_at      timestamptz,
  add column if not exists arrival_reminder_sent_at timestamptz,
  add column if not exists review_ask_sent_at       timestamptz,
  add column if not exists awaiting_feedback        text,
  add column if not exists awaiting_feedback_until  timestamptz;

-- Гости, которые уже нажали «Я приехал» / «Я уезжаю», не должны получить напоминание.
update public.guest_sessions s set arrived_at = e.at
  from (select session_id, min(created_at) at from public.guest_events where event_type = 'checkin' group by session_id) e
 where s.id = e.session_id and s.arrived_at is null;
update public.guest_sessions s set left_at = e.at
  from (select session_id, min(created_at) at from public.guest_events where event_type = 'checkout' group by session_id) e
 where s.id = e.session_id and s.left_at is null;

-- Секрет и расписание: каждые 10 минут бот проверяет, кому пора написать.
insert into public.cron_config (key, secret)
values ('quality_tick', md5(random()::text || clock_timestamp()::text) || md5(random()::text))
on conflict (key) do nothing;

select cron.unschedule('guest-quality-tick') where exists (select 1 from cron.job where jobname = 'guest-quality-tick');
select cron.schedule('guest-quality-tick', '*/10 * * * *', $$
  select net.http_post(
    url := 'https://wpwuxcxmtvdxftqrrxuu.supabase.co/functions/v1/telegram-bot/quality_tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select secret from public.cron_config where key = 'quality_tick')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
$$);

-- Боту (service_role) нужны права на запись в таблицу оценок.
grant select, insert, update, delete on public.guest_reviews to service_role;
grant usage, select on sequence public.guest_reviews_id_seq to service_role;
