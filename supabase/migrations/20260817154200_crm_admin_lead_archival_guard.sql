begin;

revoke delete on table public.crm_records from anon, authenticated;

drop policy if exists crm_records_delete on public.crm_records;

grant delete on table public.crm_records to authenticated;

create policy crm_records_delete
on public.crm_records
for delete
to authenticated
using (public.crm_canonical_restore_active(organization_id));

create or replace function private.guard_crm_record_archival()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if old.record_status = 'arquivada' then
    if to_jsonb(old) is distinct from to_jsonb(new) then
      raise exception 'CRM_LEAD_ARCHIVED_READ_ONLY'
        using errcode = '55000';
    end if;

    return new;
  end if;

  if old.record_status is distinct from new.record_status
     and new.record_status = 'arquivada' then
    if not exists (
       select 1
       from public.organization_members member
       where member.organization_id = new.organization_id
         and member.user_id = auth.uid()
         and member.active
         and member.role = 'admin'
    ) then
      raise exception 'CRM_LEAD_ARCHIVE_ADMIN_REQUIRED'
        using errcode = '42501';
    end if;

    if exists (
      select 1
      from public.crm_unit_reservations reservation
      where reservation.organization_id = new.organization_id
        and reservation.crm_record_id = new.id
        and reservation.status = 'ativa'
    ) or exists (
      select 1
      from public.crm_proposals proposal
      where proposal.organization_id = new.organization_id
        and proposal.crm_record_id = new.id
        and proposal.status not in (
          'rejeitada',
          'recusada',
          'expirada',
          'cancelada'
        )
    ) or exists (
      select 1
      from public.crm_contracts contract
      join public.crm_proposals proposal
        on proposal.id = contract.proposal_id
       and proposal.organization_id = contract.organization_id
      where contract.organization_id = new.organization_id
        and proposal.crm_record_id = new.id
        and contract.status <> 'cancelado'
    ) then
      raise exception 'CRM_LEAD_COMMERCIAL_LINKS_ACTIVE'
        using errcode = '55000';
    end if;
  end if;

  return new;
end
$function$;

comment on function private.guard_crm_record_archival() is
  'Restringe arquivamento ao administrador, bloqueia vinculos comerciais ativos e torna leads arquivados somente leitura.';

revoke all on function private.guard_crm_record_archival()
from public, anon, authenticated, service_role;

drop trigger if exists guard_crm_record_archival on public.crm_records;

create trigger guard_crm_record_archival
before update on public.crm_records
for each row
execute function private.guard_crm_record_archival();

create or replace function private.guard_archived_crm_record_child()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  row_value jsonb;
  linked_organization_id uuid;
  linked_record_id uuid;
  linked_record_status text;
begin
  for row_value in
    select item.value
    from jsonb_array_elements(
      case tg_op
        when 'INSERT' then jsonb_build_array(to_jsonb(new))
        when 'DELETE' then jsonb_build_array(to_jsonb(old))
        else jsonb_build_array(to_jsonb(old), to_jsonb(new))
      end
    ) item(value)
  loop
    linked_organization_id :=
      nullif(row_value ->> 'organization_id', '')::uuid;
    linked_record_id := null;

    if tg_table_name = 'crm_contracts' then
      select proposal.crm_record_id
        into linked_record_id
      from public.crm_proposals proposal
      where proposal.organization_id = linked_organization_id
        and proposal.id = nullif(row_value ->> 'proposal_id', '')::uuid;
    elsif tg_table_name = 'document_attachments' then
      if row_value ->> 'entity_type' = 'crm_record' then
        linked_record_id := nullif(row_value ->> 'entity_id', '')::uuid;
      end if;
    else
      linked_record_id := nullif(row_value ->> 'crm_record_id', '')::uuid;
    end if;

    if linked_record_id is null then
      continue;
    end if;

    if public.crm_canonical_restore_active(linked_organization_id) then
      continue;
    end if;

    select record.record_status
      into linked_record_status
    from public.crm_records record
    where record.organization_id = linked_organization_id
      and record.id = linked_record_id
    for key share;

    if linked_record_status = 'arquivada' then
      raise exception 'CRM_ARCHIVED_LEAD_CHILD_WRITE_BLOCKED'
        using errcode = '55000';
    end if;
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$function$;

comment on function private.guard_archived_crm_record_child() is
  'Torna o dossie de leads arquivados imutavel e cria fencing concorrente pelo lock do registro pai.';

revoke all on function private.guard_archived_crm_record_child()
from public, anon, authenticated, service_role;

drop trigger if exists guard_archived_lead_reservation on public.crm_unit_reservations;
create trigger guard_archived_lead_reservation
before insert or update or delete on public.crm_unit_reservations
for each row execute function private.guard_archived_crm_record_child();

drop trigger if exists guard_archived_lead_proposal on public.crm_proposals;
create trigger guard_archived_lead_proposal
before insert or update or delete on public.crm_proposals
for each row execute function private.guard_archived_crm_record_child();

drop trigger if exists guard_archived_lead_contract on public.crm_contracts;
create trigger guard_archived_lead_contract
before insert or update or delete on public.crm_contracts
for each row execute function private.guard_archived_crm_record_child();

drop trigger if exists guard_archived_lead_action on public.crm_actions;
create trigger guard_archived_lead_action
before insert or update or delete on public.crm_actions
for each row execute function private.guard_archived_crm_record_child();

drop trigger if exists guard_archived_lead_conversation on public.crm_conversations;
create trigger guard_archived_lead_conversation
before insert or update or delete on public.crm_conversations
for each row execute function private.guard_archived_crm_record_child();

drop trigger if exists guard_archived_lead_assignment on public.crm_lead_assignments;
create trigger guard_archived_lead_assignment
before insert or update or delete on public.crm_lead_assignments
for each row execute function private.guard_archived_crm_record_child();

drop trigger if exists guard_archived_lead_alert on public.crm_alerts;
create trigger guard_archived_lead_alert
before insert or update or delete on public.crm_alerts
for each row execute function private.guard_archived_crm_record_child();

drop trigger if exists guard_archived_lead_ai_job on public.crm_ai_jobs;
create trigger guard_archived_lead_ai_job
before insert or update or delete on public.crm_ai_jobs
for each row execute function private.guard_archived_crm_record_child();

drop trigger if exists guard_archived_lead_public_agent_session
on crm_private.public_agent_sessions;
create trigger guard_archived_lead_public_agent_session
before insert or update or delete on crm_private.public_agent_sessions
for each row execute function private.guard_archived_crm_record_child();

drop trigger if exists guard_archived_lead_document
on public.document_attachments;
create trigger guard_archived_lead_document
before insert or update or delete on public.document_attachments
for each row execute function private.guard_archived_crm_record_child();

create or replace function public.crm_document_storage_write_allowed(p_name text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $function$
declare
  path_parts text[] := storage.foldername(p_name);
  organization_key uuid;
  record_key uuid;
  record_status_value text;
begin
  if coalesce(array_length(path_parts, 1), 0) < 1
     or path_parts[1] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;

  organization_key := path_parts[1]::uuid;
  if not public.is_org_member(organization_key) then
    return false;
  end if;

  if public.crm_canonical_restore_active(organization_key) then
    return true;
  end if;

  if coalesce(path_parts[2], '') <> 'crm_record' then
    return true;
  end if;

  if coalesce(path_parts[3], '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;
  record_key := path_parts[3]::uuid;

  select record.record_status
    into record_status_value
  from public.crm_records record
  where record.organization_id = organization_key
    and record.id = record_key
  for key share;

  return found and record_status_value <> 'arquivada';
end
$function$;

comment on function public.crm_document_storage_write_allowed(text) is
  'Autoriza escrita no bucket ERP somente a membros e impede mudancas nos documentos de leads arquivados.';

revoke all on function public.crm_document_storage_write_allowed(text)
from public, anon, authenticated, service_role;
grant execute on function public.crm_document_storage_write_allowed(text)
to authenticated;

drop policy if exists erp_documents_insert on storage.objects;
create policy erp_documents_insert
on storage.objects
for insert
to authenticated
with check (
  bucket_id = 'erp-documents'
  and public.crm_document_storage_write_allowed(name)
);

drop policy if exists erp_documents_delete on storage.objects;
create policy erp_documents_delete
on storage.objects
for delete
to authenticated
using (
  bucket_id = 'erp-documents'
  and public.crm_document_storage_write_allowed(name)
);

create or replace function public.archive_crm_lead_v1(
  p_organization_id uuid,
  p_crm_record_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_id uuid := auth.uid();
  record_row public.crm_records%rowtype;
  closed_conversations integer := 0;
  closed_sessions integer := 0;
  cancelled_actions integer := 0;
  cancelled_assignments integer := 0;
  cancelled_ai_jobs integer := 0;
  resolved_alerts integer := 0;
  archived_at timestamptz := now();
begin
  if actor_id is null then
    raise exception 'CRM_LEAD_ARCHIVE_SESSION_REQUIRED'
      using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.organization_members member
    where member.organization_id = p_organization_id
      and member.user_id = actor_id
      and member.active
      and member.role = 'admin'
  ) then
    raise exception 'CRM_LEAD_ARCHIVE_ADMIN_REQUIRED'
      using errcode = '42501';
  end if;

  select record.*
    into record_row
  from public.crm_records record
  where record.organization_id = p_organization_id
    and record.id = p_crm_record_id
  for update;

  if not found then
    raise exception 'CRM_LEAD_NOT_FOUND'
      using errcode = 'P0002';
  end if;

  if record_row.record_status = 'arquivada' then
    return jsonb_build_object(
      'archived', true,
      'alreadyArchived', true,
      'closedConversations', 0,
      'closedSessions', 0,
      'cancelledActions', 0,
      'cancelledAssignments', 0,
      'cancelledAiJobs', 0,
      'resolvedAlerts', 0
    );
  end if;

  if exists (
    select 1
    from public.crm_unit_reservations reservation
    where reservation.organization_id = p_organization_id
      and reservation.crm_record_id = p_crm_record_id
      and reservation.status = 'ativa'
  ) or exists (
    select 1
    from public.crm_proposals proposal
    where proposal.organization_id = p_organization_id
      and proposal.crm_record_id = p_crm_record_id
      and proposal.status not in (
        'rejeitada',
        'recusada',
        'expirada',
        'cancelada'
      )
  ) or exists (
    select 1
    from public.crm_contracts contract
    join public.crm_proposals proposal
      on proposal.id = contract.proposal_id
     and proposal.organization_id = contract.organization_id
    where contract.organization_id = p_organization_id
      and proposal.crm_record_id = p_crm_record_id
      and contract.status <> 'cancelado'
  ) then
    raise exception 'CRM_LEAD_COMMERCIAL_LINKS_ACTIVE'
      using errcode = '55000';
  end if;

  update public.crm_actions action
  set action_status = 'cancelada',
      metadata = coalesce(action.metadata, '{}'::jsonb) || jsonb_build_object(
        'cancelled_by_lead_archive', true,
        'cancelled_at', archived_at,
        'cancelled_by', actor_id
      )
  where action.organization_id = p_organization_id
    and action.crm_record_id = p_crm_record_id
    and action.action_status = 'pendente';
  get diagnostics cancelled_actions = row_count;

  update public.crm_lead_assignments assignment
  set status = 'cancelada',
      cancelled_at = coalesce(assignment.cancelled_at, archived_at),
      status_updated_by = actor_id,
      metadata = coalesce(assignment.metadata, '{}'::jsonb) || jsonb_build_object(
        'cancelled_by_lead_archive', true,
        'cancelled_at', archived_at
      ),
      updated_at = archived_at
  where assignment.organization_id = p_organization_id
    and assignment.crm_record_id = p_crm_record_id
    and assignment.status in ('atribuida', 'aceita', 'em_atendimento');
  get diagnostics cancelled_assignments = row_count;

  update public.crm_alerts alert
  set status = 'resolvido',
      resolved_at = coalesce(alert.resolved_at, archived_at)
  where alert.organization_id = p_organization_id
    and alert.crm_record_id = p_crm_record_id
    and alert.status = 'aberto';
  get diagnostics resolved_alerts = row_count;

  update public.crm_ai_jobs job
  set status = 'cancelled',
      locked_at = null,
      lock_token = null,
      worker_id = null,
      completed_at = coalesce(job.completed_at, archived_at),
      last_error_code = 'LEAD_ARCHIVED',
      last_error_message = 'Processamento cancelado porque o lead foi arquivado.',
      updated_at = archived_at
  where job.organization_id = p_organization_id
    and job.crm_record_id = p_crm_record_id
    and job.status in ('pending', 'processing', 'retry');
  get diagnostics cancelled_ai_jobs = row_count;

  update public.crm_conversations conversation
  set status = 'closed',
      ai_enabled = false,
      closed_at = coalesce(conversation.closed_at, archived_at),
      updated_at = archived_at
  where conversation.organization_id = p_organization_id
    and conversation.crm_record_id = p_crm_record_id
    and conversation.status <> 'closed';
  get diagnostics closed_conversations = row_count;

  update crm_private.public_agent_sessions session
  set status = 'closed',
      stage = 'completed',
      expires_at = least(session.expires_at, archived_at),
      updated_at = archived_at
  where session.organization_id = p_organization_id
    and session.crm_record_id = p_crm_record_id
    and session.status <> 'closed';
  get diagnostics closed_sessions = row_count;

  update public.crm_records record
  set record_status = 'arquivada',
      next_action_at = null,
      sla_due_at = null,
      stagnation_at = null,
      updated_at = archived_at
  where record.organization_id = p_organization_id
    and record.id = p_crm_record_id;

  return jsonb_build_object(
    'archived', true,
    'alreadyArchived', false,
    'closedConversations', closed_conversations,
    'closedSessions', closed_sessions,
    'cancelledActions', cancelled_actions,
    'cancelledAssignments', cancelled_assignments,
    'cancelledAiJobs', cancelled_ai_jobs,
    'resolvedAlerts', resolved_alerts
  );
end
$function$;

comment on function public.archive_crm_lead_v1(uuid, uuid) is
  'Arquiva lead sem vinculos comerciais ativos e encerra atomica e definitivamente seus canais de atendimento.';

revoke all on function public.archive_crm_lead_v1(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.archive_crm_lead_v1(uuid, uuid)
to authenticated;

create or replace function crm_private.capture_whatsapp_inbound_context()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  updated_records integer := 0;
begin
  if new.channel <> 'whatsapp'
     or new.direction <> 'inbound'
     or new.actor_type <> 'lead' then
    return new;
  end if;

  update public.crm_records
  set first_response_at = coalesce(first_response_at, new.occurred_at),
      last_contact_at = greatest(
        coalesce(last_contact_at, 'epoch'::timestamptz),
        new.occurred_at
      ),
      source_channel = case
        when source_channel is null or source_channel = ''
          then 'whatsapp_inbound'
        else source_channel
      end,
      updated_at = now()
  where organization_id = new.organization_id
    and id = new.crm_record_id
    and record_status <> 'arquivada';
  get diagnostics updated_records = row_count;

  if updated_records = 0 then
    return new;
  end if;

  insert into public.crm_actions(
    organization_id,
    crm_record_id,
    action_type,
    subject,
    completed_at,
    action_status,
    channel,
    outcome,
    metadata
  ) values (
    new.organization_id,
    new.crm_record_id,
    'mensagem_recebida',
    left('Mensagem recebida no WhatsApp: ' || new.content, 1200),
    new.occurred_at,
    'concluida',
    'whatsapp',
    'cliente_respondeu',
    jsonb_build_object(
      'provider_message_id', new.provider_message_id,
      'crm_message_id', new.id,
      'actor', 'lead'
    )
  );

  return new;
end
$function$;

revoke all on function crm_private.capture_whatsapp_inbound_context()
from public, anon, authenticated;
grant execute on function crm_private.capture_whatsapp_inbound_context()
to service_role;

commit;
