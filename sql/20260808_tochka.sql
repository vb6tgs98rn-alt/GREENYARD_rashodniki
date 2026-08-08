-- Интеграция с Точка Банком: приём оплаты проживания (СБП / платёжная ссылка / реквизиты).
-- SaaS-схема: каждый арендодатель подключает свой счёт по OAuth 2.0,
-- деньги идут напрямую ему. Токены хранятся только на сервере.

-- ───────────────────────────────────────────────────────────────
-- 1. Подключения к Точке (по одному на арендодателя)
-- ───────────────────────────────────────────────────────────────
create table if not exists public.tochka_connections (
  user_id                uuid primary key references auth.users(id) on delete cascade,

  -- 'disconnected' | 'pending' (ждём подтверждения клиента) | 'connected' | 'error'
  status                 text not null default 'disconnected',

  -- Идентификаторы в API Точки
  customer_code          text,          -- customerCode компании (customerType = Business)
  account_id             text,          -- accountId вида 40817810802000000008/044525104
  acquiring_merchant_id  text,          -- merchantId интернет-эквайринга (15 цифр)
  sbp_merchant_id        text,          -- merchantId СБП (MA/MB/MF + цифры)
  sbp_legal_id           text,          -- legalId юрлица в СБП

  -- OAuth
  consent_id             text,          -- идентификатор списка разрешений
  oauth_state            text,          -- одноразовый state, защищает от подмены
  oauth_state_at         timestamptz,   -- когда выдан state (живёт 15 минут)
  scope                  text,
  access_token           text,          -- живёт 24 часа
  refresh_token          text,          -- живёт 30 дней
  access_expires_at      timestamptz,
  refresh_expires_at     timestamptz,

  -- Вебхук
  webhook_url            text,
  webhook_registered_at  timestamptz,

  last_error             text,
  connected_at           timestamptz,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.tochka_connections is
  'Подключения арендодателей к Точка Банку по OAuth 2.0. Токены доступны только service_role.';

-- RLS включён, политик нет: читать и писать может только service_role (edge-функции).
-- В браузер токены не попадают никогда — статус подключения отдаёт edge-функция.
alter table public.tochka_connections enable row level security;

-- ───────────────────────────────────────────────────────────────
-- 2. Платежи по броням
-- ───────────────────────────────────────────────────────────────
create table if not exists public.tochka_payments (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users(id) on delete cascade,
  booking_id     bigint not null,

  -- 'payment_link' (карта + СБП, с чеком) | 'sbp_qr' (динамический QR СБП) | 'requisites'
  method         text not null,
  amount         numeric not null,
  currency       text not null default 'RUB',
  purpose        text,

  -- Идентификаторы операции в Точке
  operation_id   text,     -- для платёжных ссылок
  qrc_id         text,     -- для QR СБП
  pay_url        text,     -- ссылка, которую отправляем гостю (paymentLink или payload)

  -- 'created' | 'paid' | 'expired' | 'failed' | 'refunded' | 'canceled'
  status         text not null default 'created',
  paid_at        timestamptz,
  expires_at     timestamptz,

  sent_at        timestamptz,   -- когда ссылка отправлена гостю
  raw            jsonb,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.tochka_payments is
  'Платежи гостей за проживание через Точка Банк. Создаются ботом вместе с договором.';

create index if not exists tochka_payments_user_booking_idx
  on public.tochka_payments (user_id, booking_id);
create unique index if not exists tochka_payments_operation_id_key
  on public.tochka_payments (operation_id) where operation_id is not null;
create unique index if not exists tochka_payments_qrc_id_key
  on public.tochka_payments (qrc_id) where qrc_id is not null;
-- По одной активной ссылке на бронь: повторный вызов переиспользует её.
create unique index if not exists tochka_payments_active_key
  on public.tochka_payments (user_id, booking_id) where status = 'created';

alter table public.tochka_payments enable row level security;

drop policy if exists "tochka_payments_select_own" on public.tochka_payments;
create policy "tochka_payments_select_own" on public.tochka_payments
  for select using (auth.uid() = user_id);

-- Писать может только сервер (edge-функции через service_role).

-- ───────────────────────────────────────────────────────────────
-- 3. Настройки оплаты в manager_settings
-- ───────────────────────────────────────────────────────────────
alter table public.manager_settings
  add column if not exists tochka_enabled          boolean not null default false,
  -- 'payment_link' | 'sbp_qr' | 'requisites'
  add column if not exists tochka_payment_method   text    not null default 'payment_link',
  add column if not exists tochka_auto_send        boolean not null default true,
  add column if not exists tochka_with_receipt     boolean not null default true,
  -- 'osn' | 'usn_income' | 'usn_income_outcome' | 'esn' | 'patent'
  add column if not exists tochka_tax_system       text    not null default 'usn_income',
  -- 'none' | 'vat0' | 'vat5' | 'vat7' | 'vat10' | 'vat22'
  add column if not exists tochka_vat_type         text    not null default 'none',
  add column if not exists tochka_ttl_minutes      integer not null default 4320,
  add column if not exists tochka_purpose_template text,
  add column if not exists tochka_requisites       text,
  add column if not exists tochka_success_url      text;

comment on column public.manager_settings.tochka_payment_method is
  'Способ оплаты: payment_link — ссылка Точки (карта + СБП, чек на e-mail); sbp_qr — динамический QR СБП без чека; requisites — реквизиты текстом.';
comment on column public.manager_settings.tochka_ttl_minutes is
  'Срок жизни ссылки/QR в минутах. Для QR СБП допустимо 1–129600, по умолчанию 4320 (3 суток).';

-- ───────────────────────────────────────────────────────────────
-- 4. Автообновление updated_at
-- ───────────────────────────────────────────────────────────────
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists tochka_connections_touch on public.tochka_connections;
create trigger tochka_connections_touch before update on public.tochka_connections
  for each row execute function public.touch_updated_at();

drop trigger if exists tochka_payments_touch on public.tochka_payments;
create trigger tochka_payments_touch before update on public.tochka_payments
  for each row execute function public.touch_updated_at();
