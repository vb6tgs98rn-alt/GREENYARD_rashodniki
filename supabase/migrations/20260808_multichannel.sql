-- Мультиканальность: Telegram, MAX, WhatsApp.
--
-- Идея: вместо привязки к tg_chat_id везде появляется пара
--   channel          — какой мессенджер ('telegram' | 'max' | 'whatsapp')
--   channel_chat_id  — идентификатор чата в этом мессенджере, всегда text
-- потому что в WhatsApp это номер телефона, а не число.
--
-- Старые колонки tg_chat_id сохраняются: их продолжает заполнять
-- Telegram-канал, ничего из существующего не ломается.

-- ─── Гости ───────────────────────────────────────────────────────────
alter table public.guest_sessions
  add column if not exists channel text not null default 'telegram',
  add column if not exists channel_chat_id text;

-- ─── Горничные ───────────────────────────────────────────────────────
alter table public.maids
  add column if not exists channel text not null default 'telegram',
  add column if not exists channel_chat_id text;

-- ─── Переписка с горничными ──────────────────────────────────────────
alter table public.maid_messages
  add column if not exists channel text not null default 'telegram',
  add column if not exists channel_chat_id text;

-- tg_chat_id был обязательным — для сообщений из MAX и WhatsApp его нет.
alter table public.maid_messages
  alter column tg_chat_id drop not null;

-- ─── Настройки менеджера ─────────────────────────────────────────────
alter table public.manager_settings
  add column if not exists manager_channel text not null default 'telegram',
  add column if not exists manager_channel_chat_id text,
  -- Каналы, которые менеджер разрешил использовать для приглашений.
  add column if not exists enabled_channels jsonb not null default '["telegram"]'::jsonb;

-- ─── Уборки ──────────────────────────────────────────────────────────
-- Идентификатор сообщения с кнопками «Принять / Отказаться»,
-- чтобы потом его отредактировать в том же канале, где оно отправлено.
alter table public.cleanings
  add column if not exists channel text,
  add column if not exists channel_message_id text;

-- ─── Ограничения на допустимые значения ──────────────────────────────
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'guest_sessions_channel_chk') then
    alter table public.guest_sessions
      add constraint guest_sessions_channel_chk
      check (channel in ('telegram', 'max', 'whatsapp'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'maids_channel_chk') then
    alter table public.maids
      add constraint maids_channel_chk
      check (channel in ('telegram', 'max', 'whatsapp'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'maid_messages_channel_chk') then
    alter table public.maid_messages
      add constraint maid_messages_channel_chk
      check (channel in ('telegram', 'max', 'whatsapp'));
  end if;

  if not exists (select 1 from pg_constraint where conname = 'manager_settings_channel_chk') then
    alter table public.manager_settings
      add constraint manager_settings_channel_chk
      check (manager_channel in ('telegram', 'max', 'whatsapp'));
  end if;
end $$;

-- ─── Перенос существующих данных ─────────────────────────────────────
-- Все, кто уже общается через Telegram, получают channel_chat_id
-- из своего tg_chat_id, чтобы новый код нашёл их так же, как старый.
update public.guest_sessions
   set channel_chat_id = tg_chat_id::text
 where channel_chat_id is null and tg_chat_id is not null;

update public.maids
   set channel_chat_id = tg_chat_id::text
 where channel_chat_id is null and tg_chat_id is not null;

update public.maid_messages
   set channel_chat_id = tg_chat_id::text
 where channel_chat_id is null and tg_chat_id is not null;

update public.manager_settings
   set manager_channel_chat_id = manager_tg_chat_id::text
 where manager_channel_chat_id is null and manager_tg_chat_id is not null;

update public.cleanings
   set channel = 'telegram', channel_message_id = tg_message_id::text
 where channel is null and tg_message_id is not null;

-- ─── Индексы для поиска собеседника по входящему сообщению ───────────
create index if not exists idx_guest_sessions_channel_chat
  on public.guest_sessions (channel, channel_chat_id);

create index if not exists idx_maids_channel_chat
  on public.maids (channel, channel_chat_id);

create index if not exists idx_maid_messages_maid_created
  on public.maid_messages (maid_id, created_at desc);

-- ─── Комментарии к колонкам ──────────────────────────────────────────
comment on column public.guest_sessions.channel is 'Мессенджер, через который общается гость';
comment on column public.guest_sessions.channel_chat_id is 'Идентификатор чата гостя в этом мессенджере (в WhatsApp — номер телефона)';
comment on column public.maids.channel is 'Мессенджер, через который общается горничная';
comment on column public.maids.channel_chat_id is 'Идентификатор чата горничной в этом мессенджере';
comment on column public.manager_settings.enabled_channels is 'Каналы, разрешённые менеджером для приглашений';
