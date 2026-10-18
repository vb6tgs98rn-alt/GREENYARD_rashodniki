-- =============================================================================
-- PDF-отчёты по квартирам в Telegram (Edge Function owner-report)
-- =============================================================================
-- 1) owner_report_config — привязка чата отдельного бота отчётов к пользователю.
-- 2) owner_report_log    — журнал отправленных отчётов (защита от повторов).
--    Обе таблицы доступны только серверу (RLS включён, политик нет).
-- 3) Секреты в Vault: cron-секрет и владелец бота (только он может задать токен).
--    Токен бота задаётся из приложения и сразу уходит в Vault.
-- 4) pg_cron: ежедневно в 06:00 UTC = 09:00 МСК.
-- =============================================================================

create table if not exists public.owner_report_config (
  user_id          uuid primary key references auth.users(id) on delete cascade,
  telegram_chat_id bigint,
  link_code        text unique,
  enabled          boolean not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
alter table public.owner_report_config enable row level security;

create table if not exists public.owner_report_log (
  user_id      uuid not null references auth.users(id) on delete cascade,
  apartment_id text not null,
  period_from  date not null,
  period_to    date not null,
  file_name    text,
  sent_at      timestamptz not null default now(),
  primary key (user_id, apartment_id, period_from)
);
alter table public.owner_report_log enable row level security;

-- Доступ только для сервера (Edge Function работает под service_role).
grant select, insert, update, delete on public.owner_report_config to service_role;
grant select, insert, update, delete on public.owner_report_log to service_role;
revoke all on public.owner_report_config from anon, authenticated;
revoke all on public.owner_report_log from anon, authenticated;

-- Секреты (создаются один раз; повторный запуск не меняет существующие).
do $$
begin
  if public.avito_get_secret('owner_report_cron_secret') is null then
    perform public.avito_set_secret('owner_report_cron_secret', replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''));
  end if;
  if public.avito_get_secret('owner_report_admin_user') is null then
    perform public.avito_set_secret('owner_report_admin_user', '8a524105-b6c4-408a-9fe7-a611f75fbbc5');
  end if;
end $$;

-- Ежедневный запуск в 09:00 МСК.
select cron.unschedule('owner-report-daily') where exists (select 1 from cron.job where jobname = 'owner-report-daily');
select cron.schedule(
  'owner-report-daily',
  '0 6 * * *',
  $cron$
  select net.http_post(
    url := 'https://wpwuxcxmtvdxftqrrxuu.supabase.co/functions/v1/owner-report',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', public.avito_get_secret('owner_report_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $cron$
);
