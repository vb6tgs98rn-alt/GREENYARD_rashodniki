-- ═══════════════════════════════════════════════════════════════════════════
-- Consent Management — 152-ФЗ compliance
-- Хранение согласий пользователей + версии политики конфиденциальности
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Таблица версий политики ──────────────────────────────────────────────
create table if not exists public.privacy_policies (
  id            uuid primary key default gen_random_uuid(),
  version       text not null unique,           -- "2026-08-06" или "1.0.0"
  title         text not null,
  content_md    text not null,                  -- Markdown-текст политики
  published_at  timestamptz not null default now(),
  is_active     boolean not null default false, -- одна активная версия
  created_at    timestamptz not null default now()
);

create index if not exists privacy_policies_active_idx
  on public.privacy_policies(is_active) where is_active = true;

-- Триггер: гарантия что активная версия только одна
create or replace function public.ensure_single_active_policy()
returns trigger language plpgsql as $$
begin
  if new.is_active = true then
    update public.privacy_policies
       set is_active = false
     where id <> new.id and is_active = true;
  end if;
  return new;
end $$;

drop trigger if exists ensure_single_active_policy_trg on public.privacy_policies;
create trigger ensure_single_active_policy_trg
  before insert or update on public.privacy_policies
  for each row execute function public.ensure_single_active_policy();

-- ─── Таблица согласий пользователей ───────────────────────────────────────
-- Каждая запись = снимок согласия в момент времени.
-- История не удаляется: отзыв согласия — это новая запись с revoked_at.
create table if not exists public.user_consents (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  policy_version  text not null,          -- версия политики на момент согласия
  categories      jsonb not null,         -- { necessary: true, analytics: false, marketing: false, functional: false }
  personal_data   boolean not null default false,  -- согласие на обработку ПДн (152-ФЗ)
  ip_address      inet,                   -- IP клиента (для доказательства РКН)
  user_agent      text,                   -- UA клиента
  given_at        timestamptz not null default now(),
  revoked_at      timestamptz,            -- null = активно, timestamp = отозвано
  revoke_reason   text,
  created_at      timestamptz not null default now()
);

create index if not exists user_consents_user_idx    on public.user_consents(user_id);
create index if not exists user_consents_active_idx  on public.user_consents(user_id) where revoked_at is null;
create index if not exists user_consents_version_idx on public.user_consents(policy_version);

-- ─── RLS ──────────────────────────────────────────────────────────────────
alter table public.privacy_policies enable row level security;
alter table public.user_consents    enable row level security;

-- Политику может читать любой (в т.ч. неавторизованный, чтобы показать до signup)
drop policy if exists "privacy_policies read all"    on public.privacy_policies;
create policy "privacy_policies read all"
  on public.privacy_policies for select
  using (true);

-- consent: пользователь видит только свои записи
drop policy if exists "user_consents read own"        on public.user_consents;
create policy "user_consents read own"
  on public.user_consents for select
  using (auth.uid() = user_id);

-- consent: пользователь может создать запись только от своего имени
drop policy if exists "user_consents insert own"      on public.user_consents;
create policy "user_consents insert own"
  on public.user_consents for insert
  with check (auth.uid() = user_id);

-- consent: обновление (для отзыва) — только своих записей
drop policy if exists "user_consents update own"      on public.user_consents;
create policy "user_consents update own"
  on public.user_consents for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- Удаление запрещено: история согласий должна сохраняться (152-ФЗ)

-- ─── Helper функция: получить актуальный consent пользователя ─────────────
create or replace function public.get_active_consent(p_user_id uuid)
returns table (
  id              uuid,
  policy_version  text,
  categories      jsonb,
  personal_data   boolean,
  given_at        timestamptz
) language sql stable security definer as $$
  select id, policy_version, categories, personal_data, given_at
    from public.user_consents
   where user_id = p_user_id
     and revoked_at is null
   order by given_at desc
   limit 1;
$$;

-- ─── Первичный сид политики ──────────────────────────────────────────────
-- Версия/текст обновляются отдельным запросом при релизе.
insert into public.privacy_policies (version, title, content_md, is_active)
values (
  '2026-08-06',
  'Политика конфиденциальности Green Yard',
  '# Политика конфиденциальности Green Yard

**Версия: 2026-08-06**

Заглушка. Полный текст загружается при деплое из /docs/privacy-policy.md',
  true
)
on conflict (version) do nothing;
