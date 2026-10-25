-- Сервер (service_role) создаёт и обновляет залоги. Удалять записи о деньгах
-- нельзя никому — история залогов сохраняется.
grant select, insert, update on public.booking_deposits to service_role;
