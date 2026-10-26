-- Ежедневные копии данных приложения (public.app_state) за последние 14 дней.
-- Нужны, чтобы можно было восстановить данные после случайной перезаписи.
-- Доступ только у сервера: браузер копии не видит и не меняет.

create table if not exists public.app_state_backups (
  user_id    uuid        not null references auth.users(id) on delete cascade,
  backup_day date        not null,
  state      jsonb       not null,
  state_updated_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, backup_day)
);

alter table public.app_state_backups enable row level security;
revoke all on public.app_state_backups from anon, authenticated;
grant select, insert, update, delete on public.app_state_backups to service_role;

-- Снимок за сегодняшний день (по Москве) и удаление копий старше 14 дней.
create or replace function public.app_state_backup_daily()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  d date := (now() at time zone 'Europe/Moscow')::date;
begin
  insert into public.app_state_backups (user_id, backup_day, state, state_updated_at)
  select a.user_id, d, a.state, a.updated_at
  from public.app_state a
  where a.state is not null
  on conflict (user_id, backup_day) do update
    set state = excluded.state,
        state_updated_at = excluded.state_updated_at,
        created_at = now();

  delete from public.app_state_backups where backup_day < d - 14;
end;
$$;

revoke all on function public.app_state_backup_daily() from public, anon, authenticated;

-- Каждый день в 03:00 по Москве (00:00 UTC).
select cron.unschedule('app-state-backup-daily')
where exists (select 1 from cron.job where jobname = 'app-state-backup-daily');
select cron.schedule('app-state-backup-daily', '0 0 * * *', $$select public.app_state_backup_daily()$$);

-- Первая копия — сразу.
select public.app_state_backup_daily();
