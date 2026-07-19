-- Évora Gestão — esquema financeiro inicial
create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  role text not null default 'admin' check (role in ('admin','diretoria','financeiro','engenharia','consulta')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.financial_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('entrada','saida')),
  description text not null,
  category text not null default 'Geral',
  amount numeric(15,2) not null check (amount > 0),
  due_date date not null,
  status text not null default 'pendente' check (status in ('pendente','pago','recebido')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists financial_entries_user_due_date_idx on public.financial_entries(user_id,due_date);
create index if not exists financial_entries_user_status_idx on public.financial_entries(user_id,status);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, role)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', new.email), 'admin')
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke execute on function public.handle_new_user() from public, anon, authenticated;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();

drop trigger if exists financial_entries_set_updated_at on public.financial_entries;
create trigger financial_entries_set_updated_at before update on public.financial_entries for each row execute function public.set_updated_at();

alter table public.profiles enable row level security;
alter table public.financial_entries enable row level security;

drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles for select to authenticated using ((select auth.uid()) = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles for update to authenticated using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

drop policy if exists entries_select_own on public.financial_entries;
create policy entries_select_own on public.financial_entries for select to authenticated using ((select auth.uid()) = user_id);

drop policy if exists entries_insert_own on public.financial_entries;
create policy entries_insert_own on public.financial_entries for insert to authenticated with check ((select auth.uid()) = user_id);

drop policy if exists entries_update_own on public.financial_entries;
create policy entries_update_own on public.financial_entries for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);

drop policy if exists entries_delete_own on public.financial_entries;
create policy entries_delete_own on public.financial_entries for delete to authenticated using ((select auth.uid()) = user_id);

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.financial_entries to authenticated;
grant select, update on public.profiles to authenticated;
