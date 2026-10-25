-- Серверная роль читает секреты ежедневных задач (проверка x-cron-secret
-- в telegram-bot/deposit_autosend). Браузеру таблица по-прежнему недоступна.
grant select on public.cron_config to service_role;
