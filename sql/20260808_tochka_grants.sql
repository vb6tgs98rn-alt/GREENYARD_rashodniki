-- Права на таблицы интеграции с Точка Банком.
-- Сервисной роли — полный доступ (edge-функции работают только через неё),
-- пользователю приложения — чтение своих платежей (ограничивает RLS-политика
-- tochka_payments_select_own). К tochka_connections доступа из браузера нет:
-- там лежат токены банка.
grant all on table public.tochka_connections to service_role;
grant all on table public.tochka_payments   to service_role;
grant select on table public.tochka_payments to authenticated;
