-- Приложению (роль authenticated) разрешаем читать снимки выплат площадок.
-- Видимость строк по-прежнему ограничена RLS-политикой rc_payout_snapshots_select_own (auth.uid() = user_id).
grant select on public.rc_payout_snapshots to authenticated;
