-- Evora Enterprise - hardening final do runtime tenant da Vitoria.
--
-- A tabela permanece em schema privado e acessivel somente ao service_role.
-- A policy restritiva explicita a negacao de cliente no catalogo de RLS e os
-- indices cobrem as FKs de auditoria do runtime.

set lock_timeout = '5s';
set statement_timeout = '120s';

alter table crm_private.ai_runtime_settings enable row level security;

drop policy if exists ai_runtime_settings_deny_client_access
  on crm_private.ai_runtime_settings;
create policy ai_runtime_settings_deny_client_access
  on crm_private.ai_runtime_settings
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

create index if not exists ai_runtime_settings_created_by_idx
  on crm_private.ai_runtime_settings (created_by)
  where created_by is not null;

create index if not exists ai_runtime_settings_updated_by_idx
  on crm_private.ai_runtime_settings (updated_by)
  where updated_by is not null;

revoke all on schema crm_private from public, anon, authenticated;
revoke all on table crm_private.ai_runtime_settings
  from public, anon, authenticated;
grant usage on schema crm_private to service_role;
grant select, insert, update, delete on table crm_private.ai_runtime_settings
  to service_role;
