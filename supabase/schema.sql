-- Europe Costs — estrutura do banco de dados (Supabase / Postgres)
-- Cole este arquivo inteiro no SQL Editor do Supabase e clique em "Run".

-- 1) Lista de e-mails autorizados (você + familiares).
--    Só quem estiver aqui consegue ler ou gravar dados, mesmo que tenha login.
create table if not exists public.allowed_users (
  email text primary key
);

-- Uma linha por pessoa autorizada:
insert into public.allowed_users (email) values
  ('pohlfelipe27@gmail.com'),
  ('patypohl@gmail.com'),
  ('pohlhenrique@gmail.com')
on conflict do nothing;

create or replace function public.is_allowed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.allowed_users
    where lower(email) = lower(auth.jwt() ->> 'email')
  );
$$;

-- 2) Viagens
create table if not exists public.trips (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  start_date  date not null,
  end_date    date not null,
  budget      numeric(12,2),
  currency    text not null default 'EUR',
  brl_rate    numeric(12,4),
  created_by  text default (auth.jwt() ->> 'email'),
  created_at  timestamptz not null default now()
);

-- 3) Gastos
create table if not exists public.expenses (
  id              uuid primary key default gen_random_uuid(),
  trip_id         uuid not null references public.trips(id) on delete cascade,
  date            date not null,
  description     text not null,
  category        text not null,
  amount          numeric(12,2) not null check (amount >= 0),
  payment_method  text,
  notes           text,
  created_by      text default (auth.jwt() ->> 'email'),
  created_at      timestamptz not null default now()
);

create index if not exists expenses_trip_idx on public.expenses (trip_id, date);

-- 4) Segurança (Row Level Security): só e-mails autorizados acessam.
alter table public.allowed_users enable row level security;
alter table public.trips         enable row level security;
alter table public.expenses      enable row level security;

drop policy if exists "allowed read own row" on public.allowed_users;
create policy "allowed read own row" on public.allowed_users
  for select to authenticated using (public.is_allowed());

drop policy if exists "family trips" on public.trips;
create policy "family trips" on public.trips
  for all to authenticated
  using (public.is_allowed()) with check (public.is_allowed());

drop policy if exists "family expenses" on public.expenses;
create policy "family expenses" on public.expenses
  for all to authenticated
  using (public.is_allowed()) with check (public.is_allowed());

-- 5) Atualização em tempo real (quando um familiar lança um gasto, aparece para todos).
do $$
begin
  alter publication supabase_realtime add table public.trips, public.expenses;
exception when others then null;
end $$;
