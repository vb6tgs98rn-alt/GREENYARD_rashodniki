-- Ссылка на канал для гостей больше не подставляется по умолчанию (раньше стоял канал Green Yard).
alter table public.manager_settings alter column guest_channel_url drop default;
