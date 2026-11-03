-- ИИ-разборы финучёта: сервер (owner-report) пишет результат сюда, приложение забирает его,
-- даже если пользователь сворачивал приложение и соединение обрывалось.
-- Хранятся 30 дней (старые удаляет сама функция при создании нового разбора).
create table if not exists public.ai_analysis_results (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  month text not null,
  question text,
  status text not null default 'pending' check (status in ('pending', 'done', 'error')),
  text text,
  error text,
  model text,
  cost_usd numeric,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index if not exists ai_analysis_results_user_created_idx
  on public.ai_analysis_results (user_id, created_at desc);

alter table public.ai_analysis_results enable row level security;

-- Пользователь видит только свои разборы; запись — только сервер (service_role).
drop policy if exists ai_analysis_results_select_own on public.ai_analysis_results;
create policy ai_analysis_results_select_own on public.ai_analysis_results
  for select to authenticated using (user_id = auth.uid());

revoke all on public.ai_analysis_results from anon, authenticated;
grant select on public.ai_analysis_results to authenticated;
grant all on public.ai_analysis_results to service_role;
