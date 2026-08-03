-- Endurece tabelas internas sem alterar os fluxos públicos baseados em RPC/token.
-- Remove privilégios amplos de anon e limita authenticated às operações usadas pelo ERP.

revoke all on table public.data_import_jobs from anon, authenticated;
grant select, insert, update, delete on table public.data_import_jobs to authenticated;

revoke all on table public.role_access_profiles from anon, authenticated;
grant select, insert, update, delete on table public.role_access_profiles to authenticated;

-- Desafios OTP são manipulados apenas por funções controladas.
revoke all on table public.signature_otp_challenges from anon, authenticated;

drop policy if exists data_import_jobs_read on public.data_import_jobs;
drop policy if exists data_import_jobs_write on public.data_import_jobs;

create policy data_import_jobs_read
on public.data_import_jobs
for select
to authenticated
using (
  exists (
    select 1
    from public.organization_members member
    where member.organization_id = data_import_jobs.organization_id
      and member.user_id = (select auth.uid())
      and member.active
  )
);

create policy data_import_jobs_insert
on public.data_import_jobs
for insert
to authenticated
with check (
  exists (
    select 1
    from public.organization_members member
    where member.organization_id = data_import_jobs.organization_id
      and member.user_id = (select auth.uid())
      and member.active
      and member.role = any (array['admin'::text, 'diretoria'::text])
  )
);

create policy data_import_jobs_update
on public.data_import_jobs
for update
to authenticated
using (
  exists (
    select 1
    from public.organization_members member
    where member.organization_id = data_import_jobs.organization_id
      and member.user_id = (select auth.uid())
      and member.active
      and member.role = any (array['admin'::text, 'diretoria'::text])
  )
)
with check (
  exists (
    select 1
    from public.organization_members member
    where member.organization_id = data_import_jobs.organization_id
      and member.user_id = (select auth.uid())
      and member.active
      and member.role = any (array['admin'::text, 'diretoria'::text])
  )
);

create policy data_import_jobs_delete
on public.data_import_jobs
for delete
to authenticated
using (
  exists (
    select 1
    from public.organization_members member
    where member.organization_id = data_import_jobs.organization_id
      and member.user_id = (select auth.uid())
      and member.active
      and member.role = any (array['admin'::text, 'diretoria'::text])
  )
);

drop policy if exists role_access_read on public.role_access_profiles;
drop policy if exists role_access_admin_write on public.role_access_profiles;

create policy role_access_read
on public.role_access_profiles
for select
to authenticated
using (
  exists (
    select 1
    from public.organization_members member
    where member.organization_id = role_access_profiles.organization_id
      and member.user_id = (select auth.uid())
      and member.active
  )
);

create policy role_access_insert
on public.role_access_profiles
for insert
to authenticated
with check (
  exists (
    select 1
    from public.organization_members member
    where member.organization_id = role_access_profiles.organization_id
      and member.user_id = (select auth.uid())
      and member.active
      and member.role = any (array['admin'::text, 'diretoria'::text])
  )
);

create policy role_access_update
on public.role_access_profiles
for update
to authenticated
using (
  exists (
    select 1
    from public.organization_members member
    where member.organization_id = role_access_profiles.organization_id
      and member.user_id = (select auth.uid())
      and member.active
      and member.role = any (array['admin'::text, 'diretoria'::text])
  )
)
with check (
  exists (
    select 1
    from public.organization_members member
    where member.organization_id = role_access_profiles.organization_id
      and member.user_id = (select auth.uid())
      and member.active
      and member.role = any (array['admin'::text, 'diretoria'::text])
  )
);

create policy role_access_delete
on public.role_access_profiles
for delete
to authenticated
using (
  exists (
    select 1
    from public.organization_members member
    where member.organization_id = role_access_profiles.organization_id
      and member.user_id = (select auth.uid())
      and member.active
      and member.role = any (array['admin'::text, 'diretoria'::text])
  )
);
