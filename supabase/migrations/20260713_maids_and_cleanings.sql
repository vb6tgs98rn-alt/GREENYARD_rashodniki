-- ═══════════════════════════════════════════════════════════════════
-- Горничные, уборки, чаты, заказ расходников
-- ═══════════════════════════════════════════════════════════════════

-- 1. Горничные -------------------------------------------------------
create table if not exists public.maids (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users(id) on delete cascade,
  tg_chat_id    bigint,             -- заполняется, когда горничная жмёт /start
  invite_token  text unique,        -- одноразовый токен для ссылки-инвайта
  name          text not null,
  phone         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_maids_user_id on public.maids(user_id);
create index if not exists idx_maids_tg_chat_id on public.maids(tg_chat_id);
alter table public.maids enable row level security;
drop policy if exists "maids own" on public.maids;
create policy "maids own" on public.maids
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- 2. Закрепление квартир за горничными (M2M) -------------------------
create table if not exists public.maid_apartments (
  maid_id     uuid not null references public.maids(id) on delete cascade,
  user_id     uuid not null references auth.users(id) on delete cascade,
  realty_id   bigint not null,
  created_at  timestamptz not null default now(),
  primary key (maid_id, realty_id)
);
create index if not exists idx_maid_apartments_realty on public.maid_apartments(user_id, realty_id);
alter table public.maid_apartments enable row level security;
drop policy if exists "maid_apts own" on public.maid_apartments;
create policy "maid_apts own" on public.maid_apartments
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- 3. Уборки ----------------------------------------------------------
create table if not exists public.cleanings (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  booking_id         text,           -- rc_bookings.booking_id (может быть null для ручных)
  realty_id          bigint not null,
  apartment_title    text,
  maid_id            uuid references public.maids(id) on delete set null,
  scheduled_date     date not null,
  scheduled_time     time not null default '12:00',
  status             text not null default 'pending_response',
    -- pending_response | accepted | declined | on_site | completed | cancelled
  offered_to         jsonb default '[]'::jsonb,   -- список maid_id, кому разослано
  accepted_at        timestamptz,
  declined_at        timestamptz,
  on_site_at         timestamptz,
  completed_at       timestamptz,
  reminded_at        timestamptz,
  tg_message_id      bigint,         -- id сообщения у горничной (для editReplyMarkup)
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists idx_cleanings_user on public.cleanings(user_id);
create index if not exists idx_cleanings_booking on public.cleanings(booking_id);
create index if not exists idx_cleanings_date on public.cleanings(user_id, scheduled_date);
create index if not exists idx_cleanings_status on public.cleanings(status);
alter table public.cleanings enable row level security;
drop policy if exists "cleanings own" on public.cleanings;
create policy "cleanings own" on public.cleanings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- 4. Чаты с горничными -----------------------------------------------
create table if not exists public.maid_messages (
  id             bigserial primary key,
  user_id        uuid not null references auth.users(id) on delete cascade,
  maid_id        uuid not null references public.maids(id) on delete cascade,
  tg_chat_id     bigint not null,
  tg_message_id  bigint,
  direction      text not null check (direction in ('inbound','outbound','system')),
  sender         text not null check (sender in ('maid','bot','manager')),
  text           text,
  photo_url      text,
  created_at     timestamptz not null default now()
);
create index if not exists idx_maid_msgs_thread on public.maid_messages(user_id, maid_id, created_at desc);
alter table public.maid_messages enable row level security;
drop policy if exists "maid_msgs own" on public.maid_messages;
create policy "maid_msgs own" on public.maid_messages
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
alter publication supabase_realtime add table public.maid_messages;


-- 5. Заявки на расходники --------------------------------------------
create table if not exists public.supply_requests (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  maid_id      uuid references public.maids(id) on delete set null,
  realty_id    bigint,
  text         text,
  photo_url    text,
  status       text not null default 'new',   -- new | in_progress | done | rejected
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_supply_user on public.supply_requests(user_id, status, created_at desc);
alter table public.supply_requests enable row level security;
drop policy if exists "supply own" on public.supply_requests;
create policy "supply own" on public.supply_requests
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);


-- 6. Настройки уборок в manager_settings -----------------------------
alter table public.manager_settings
  add column if not exists cleaning_default_time time not null default '12:00',
  add column if not exists cleaning_reminder_time time not null default '09:00',
  add column if not exists notify_on_cleaning_response boolean not null default true,
  add column if not exists notify_on_supply_request boolean not null default true;
