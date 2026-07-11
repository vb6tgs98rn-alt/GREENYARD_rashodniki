-- Добавляем адрес квартиры и депозит в шаблоны квартир для Okidoki
alter table public.apartment_contract_templates
  add column if not exists apartment_address text,
  add column if not exists deposit numeric;
