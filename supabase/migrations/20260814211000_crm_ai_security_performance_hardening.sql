-- Evora Enterprise - hardening final da fundacao IA em modo sombra.
--
-- Objetivos:
--   * deixar explicita a negacao de acesso direto de clientes às tabelas internas;
--   * adicionar indices de suporte às FKs relevantes apontadas pelo advisor;
--   * preservar service_role como unico caminho de acesso nesta etapa.

set lock_timeout = '5s';
set statement_timeout = '120s';

-- RLS já está habilitada e os grants de anon/authenticated já foram revogados.
-- Estas policies restritivas tornam a intenção de segurança inequívoca também
-- no catálogo de RLS e impedem acesso caso grants sejam alterados futuramente.
drop policy if exists crm_ai_jobs_deny_client_access on public.crm_ai_jobs;
create policy crm_ai_jobs_deny_client_access
  on public.crm_ai_jobs
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists crm_conversations_deny_client_access on public.crm_conversations;
create policy crm_conversations_deny_client_access
  on public.crm_conversations
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

drop policy if exists crm_messages_deny_client_access on public.crm_messages;
create policy crm_messages_deny_client_access
  on public.crm_messages
  as restrictive
  for all
  to anon, authenticated
  using (false)
  with check (false);

-- Índices de suporte para FKs compostas usadas na fila e nas conversas.
create index if not exists crm_ai_jobs_contact_idx
  on public.crm_ai_jobs (organization_id, contact_id)
  where contact_id is not null;

create index if not exists crm_conversations_contact_idx
  on public.crm_conversations (organization_id, contact_id)
  where contact_id is not null;

create index if not exists crm_conversations_assigned_idx
  on public.crm_conversations (organization_id, assigned_user_id)
  where assigned_user_id is not null;

-- Reafirma os privilégios server-only da etapa shadow.
revoke all on table public.crm_ai_jobs from public, anon, authenticated;
revoke all on table public.crm_conversations from public, anon, authenticated;
revoke all on table public.crm_messages from public, anon, authenticated;

grant select, insert, update, delete on table public.crm_ai_jobs to service_role;
grant select, insert, update, delete on table public.crm_conversations to service_role;
grant select, insert, update, delete on table public.crm_messages to service_role;
