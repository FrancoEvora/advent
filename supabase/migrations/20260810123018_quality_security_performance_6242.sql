-- Évora Gestão 6.24.2
-- Hardening incremental, RLS explícita e índices de FKs de maior uso.

-- 1) Tabelas internas: negar acesso direto de clientes e documentar intenção via RLS.
revoke all on table public.construction_code_counters from anon, authenticated;
revoke all on table public.partner_landowner_contract_statements from anon, authenticated;
revoke all on table public.signature_otp_challenges from anon, authenticated;

alter table public.construction_code_counters enable row level security;
alter table public.partner_landowner_contract_statements enable row level security;
alter table public.signature_otp_challenges enable row level security;

drop policy if exists construction_code_counters_direct_deny on public.construction_code_counters;
create policy construction_code_counters_direct_deny
on public.construction_code_counters
for all
to anon, authenticated
using (false)
with check (false);

drop policy if exists partner_landowner_contract_statements_direct_deny on public.partner_landowner_contract_statements;
create policy partner_landowner_contract_statements_direct_deny
on public.partner_landowner_contract_statements
for all
to anon, authenticated
using (false)
with check (false);

drop policy if exists signature_otp_challenges_direct_deny on public.signature_otp_challenges;
create policy signature_otp_challenges_direct_deny
on public.signature_otp_challenges
for all
to anon, authenticated
using (false)
with check (false);

-- 2) Administração: remover grants excessivos e manter somente CRUD necessário para usuários autenticados.
revoke all on table public.data_import_jobs from anon, authenticated;
grant select, insert, update, delete on table public.data_import_jobs to authenticated;

revoke all on table public.role_access_profiles from anon, authenticated;
grant select, insert, update, delete on table public.role_access_profiles to authenticated;

-- 3) Recriar políticas com auth.uid() inicializado uma vez por statement.
drop policy if exists data_import_jobs_read on public.data_import_jobs;
drop policy if exists data_import_jobs_write on public.data_import_jobs;
drop policy if exists data_import_jobs_insert on public.data_import_jobs;
drop policy if exists data_import_jobs_update on public.data_import_jobs;
drop policy if exists data_import_jobs_delete on public.data_import_jobs;

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
drop policy if exists role_access_insert on public.role_access_profiles;
drop policy if exists role_access_update on public.role_access_profiles;
drop policy if exists role_access_delete on public.role_access_profiles;

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

-- 4) Índices direcionados aos relacionamentos mais usados por CRM e pós-venda.
create index if not exists crm_contracts_source_import_job_idx
  on public.crm_contracts(source_import_job_id)
  where source_import_job_id is not null;

create index if not exists crm_proposal_installments_org_idx
  on public.crm_proposal_installments(organization_id);

create index if not exists crm_unit_reservations_org_idx
  on public.crm_unit_reservations(organization_id);
create index if not exists crm_unit_reservations_project_idx
  on public.crm_unit_reservations(project_id);
create index if not exists crm_unit_reservations_record_idx
  on public.crm_unit_reservations(crm_record_id)
  where crm_record_id is not null;
create index if not exists crm_unit_reservations_contact_idx
  on public.crm_unit_reservations(contact_id)
  where contact_id is not null;

create index if not exists post_sale_tickets_contract_idx
  on public.post_sale_tickets(contract_id)
  where contract_id is not null;
create index if not exists post_sale_tickets_contact_idx
  on public.post_sale_tickets(contact_id)
  where contact_id is not null;

create index if not exists post_sale_communications_contract_idx
  on public.post_sale_communications(contract_id)
  where contract_id is not null;
create index if not exists post_sale_communications_contact_idx
  on public.post_sale_communications(contact_id)
  where contact_id is not null;

create index if not exists portal_content_items_contract_idx
  on public.portal_content_items(contract_id)
  where contract_id is not null;

create index if not exists marketing_assets_campaign_idx
  on public.marketing_assets(campaign_id)
  where campaign_id is not null;

create index if not exists marketing_performance_channel_idx
  on public.marketing_performance_snapshots(channel_id)
  where channel_id is not null;
