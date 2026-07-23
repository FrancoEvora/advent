-- Évora Gestão 6.6 — automação de agenda, reservas e alertas operacionais

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

alter table public.user_activities
  add column if not exists acknowledged_at timestamptz,
  add column if not exists acknowledged_by uuid references auth.users(id) on delete set null;

alter table public.crm_unit_reservations
  add column if not exists proposal_id uuid;

alter table public.crm_proposals drop constraint if exists crm_proposals_approval_status_check;
alter table public.crm_proposals
  add constraint crm_proposals_approval_status_check
  check (approval_status in ('nao_solicitada','pendente','aprovada','rejeitada','cancelada','expirada'));

alter table public.crm_proposal_approvals drop constraint if exists crm_proposal_approvals_status_check;
alter table public.crm_proposal_approvals
  add constraint crm_proposal_approvals_status_check
  check (status in ('pendente','aprovada','rejeitada','cancelada','expirada'));

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'crm_unit_reservations_proposal_id_fkey'
  ) then
    alter table public.crm_unit_reservations
      add constraint crm_unit_reservations_proposal_id_fkey
      foreign key (proposal_id) references public.crm_proposals(id) on delete set null;
  end if;
end $$;

update public.crm_unit_reservations reservation
set proposal_id = proposal.id
from public.crm_proposals proposal
where proposal.reservation_id = reservation.id
  and reservation.proposal_id is null;

create index if not exists user_activities_org_owner_due_idx
  on public.user_activities(organization_id, owner_user_id, due_at)
  where board_status <> 'concluida';
create index if not exists user_activities_org_assigner_due_idx
  on public.user_activities(organization_id, assigned_by, due_at)
  where board_status <> 'concluida';
create index if not exists activity_notifications_recipient_unread_idx
  on public.activity_notifications(recipient_user_id, created_at desc)
  where read_at is null;
create index if not exists crm_proposals_open_validity_idx
  on public.crm_proposals(organization_id, valid_until)
  where status in ('submetida','aprovada','enviada','aceita');
create index if not exists crm_contracts_pending_signature_idx
  on public.crm_contracts(organization_id, company_signed_at)
  where customer_signed_at is null and status <> 'cancelado';

create or replace function public.validate_activity_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := auth.uid();
  actor_role text;
begin
  if actor is null then
    return new;
  end if;

  select lower(m.role)
    into actor_role
  from public.organization_members m
  where m.organization_id = new.organization_id
    and m.user_id = actor
    and m.active
  limit 1;

  if actor_role is null then
    raise exception 'Usuário sem vínculo ativo com a organização';
  end if;

  if not exists (
    select 1
    from public.organization_members member
    where member.organization_id = new.organization_id
      and member.user_id = new.owner_user_id
      and member.active
  ) then
    raise exception 'O responsável precisa ser um usuário ativo da organização';
  end if;

  if tg_op = 'INSERT' then
    new.assigned_by := actor;
    new.updated_by := actor;
    if new.owner_user_id <> actor
       and actor_role not in ('admin','administrador','diretoria','diretor') then
      raise exception 'Apenas administrador ou diretoria pode designar outro usuário';
    end if;
  else
    if new.assigned_by is distinct from old.assigned_by then
      raise exception 'A autoria da atividade não pode ser alterada';
    end if;
    if new.owner_user_id is distinct from old.owner_user_id
       and actor_role not in ('admin','administrador','diretoria','diretor') then
      raise exception 'Apenas administrador ou diretoria pode transferir a atividade';
    end if;
    if actor_role not in ('admin','administrador','diretoria','diretor')
       and actor <> old.owner_user_id then
      raise exception 'Somente o responsável ou a diretoria pode alterar a atividade';
    end if;
    new.updated_by := actor;
  end if;

  if new.due_at is not null and new.starts_at is not null and new.due_at < new.starts_at then
    raise exception 'O prazo não pode ser anterior ao início da atividade';
  end if;
  return new;
end $$;

drop trigger if exists trg_validate_activity_assignment on public.user_activities;
create trigger trg_validate_activity_assignment
before insert or update on public.user_activities
for each row execute function public.validate_activity_assignment();

revoke execute on function public.validate_activity_assignment() from public, anon, authenticated;

drop policy if exists org_access on public.user_activities;
drop policy if exists user_activities_select on public.user_activities;
drop policy if exists user_activities_insert on public.user_activities;
drop policy if exists user_activities_update on public.user_activities;
drop policy if exists user_activities_delete on public.user_activities;

create policy user_activities_select
on public.user_activities for select to authenticated
using (
  public.is_org_member(organization_id)
  and (
    owner_user_id = (select auth.uid())
    or assigned_by = (select auth.uid())
    or (select auth.uid()) = any(watchers)
    or exists (
      select 1 from public.organization_members manager
      where manager.organization_id = user_activities.organization_id
        and manager.user_id = (select auth.uid())
        and manager.active
        and lower(manager.role) in ('admin','administrador','diretoria','diretor')
    )
  )
);

create policy user_activities_insert
on public.user_activities for insert to authenticated
with check (
  public.is_org_member(organization_id)
  and exists (
    select 1 from public.organization_members owner_member
    where owner_member.organization_id = user_activities.organization_id
      and owner_member.user_id = user_activities.owner_user_id
      and owner_member.active
  )
  and (
    owner_user_id = (select auth.uid())
    or exists (
      select 1 from public.organization_members manager
      where manager.organization_id = user_activities.organization_id
        and manager.user_id = (select auth.uid())
        and manager.active
        and lower(manager.role) in ('admin','administrador','diretoria','diretor')
    )
  )
);

create policy user_activities_update
on public.user_activities for update to authenticated
using (
  public.is_org_member(organization_id)
  and (
    owner_user_id = (select auth.uid())
    or exists (
      select 1 from public.organization_members manager
      where manager.organization_id = user_activities.organization_id
        and manager.user_id = (select auth.uid())
        and manager.active
        and lower(manager.role) in ('admin','administrador','diretoria','diretor')
    )
  )
)
with check (public.is_org_member(organization_id));

create policy user_activities_delete
on public.user_activities for delete to authenticated
using (
  assigned_by = (select auth.uid())
  or exists (
    select 1 from public.organization_members manager
    where manager.organization_id = user_activities.organization_id
      and manager.user_id = (select auth.uid())
      and manager.active
      and lower(manager.role) in ('admin','administrador','diretoria','diretor')
  )
);

drop policy if exists activity_notifications_select_own on public.activity_notifications;
drop policy if exists activity_notifications_update_own on public.activity_notifications;
create policy activity_notifications_select_own
on public.activity_notifications for select to authenticated
using (recipient_user_id = (select auth.uid()) and public.is_org_member(organization_id));
create policy activity_notifications_update_own
on public.activity_notifications for update to authenticated
using (recipient_user_id = (select auth.uid()) and public.is_org_member(organization_id))
with check (recipient_user_id = (select auth.uid()) and public.is_org_member(organization_id));

create or replace function public.notify_activity_changes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor uuid := coalesce(new.updated_by, new.assigned_by, new.owner_user_id);
  recipient uuid;
  status_label text;
begin
  if tg_op = 'INSERT' then
    if new.owner_user_id is distinct from new.assigned_by then
      insert into public.activity_notifications(
        organization_id, recipient_user_id, actor_user_id, activity_id,
        notification_type, title, message, metadata
      ) values (
        new.organization_id, new.owner_user_id, new.assigned_by, new.id,
        'assignment', 'Nova atividade designada', new.title,
        jsonb_build_object('due_at',new.due_at,'priority',new.priority,'board_status',new.board_status)
      );
    end if;
    return new;
  end if;

  if new.owner_user_id is distinct from old.owner_user_id then
    insert into public.activity_notifications(
      organization_id, recipient_user_id, actor_user_id, activity_id,
      notification_type, title, message, metadata
    ) values (
      new.organization_id, new.owner_user_id, actor, new.id,
      'assignment', 'Atividade transferida para você', new.title,
      jsonb_build_object('due_at',new.due_at,'priority',new.priority)
    );
  end if;

  if new.acknowledged_at is distinct from old.acknowledged_at and new.acknowledged_at is not null then
    for recipient in
      select distinct value
      from unnest(array[new.assigned_by]) value
      where value is not null and value <> actor
    loop
      insert into public.activity_notifications(
        organization_id, recipient_user_id, actor_user_id, activity_id,
        notification_type, title, message, metadata
      ) values (
        new.organization_id, recipient, actor, new.id,
        'acknowledged', 'Designação recebida', new.title,
        jsonb_build_object('acknowledged_at',new.acknowledged_at)
      );
    end loop;
  end if;

  if new.board_status is distinct from old.board_status or new.status is distinct from old.status then
    status_label := case coalesce(new.board_status,new.status)
      when 'backlog' then 'Planejada'
      when 'em_andamento' then 'Em andamento'
      when 'aguardando' then 'Aguardando'
      when 'concluida' then 'Concluída'
      else coalesce(new.board_status,new.status)
    end;
    for recipient in
      select distinct value
      from unnest(array[new.owner_user_id,new.assigned_by]) value
      where value is not null and value <> actor
    loop
      insert into public.activity_notifications(
        organization_id, recipient_user_id, actor_user_id, activity_id,
        notification_type, title, message, metadata
      ) values (
        new.organization_id, recipient, actor, new.id,
        'status', 'Andamento atualizado', new.title || ' · ' || status_label,
        jsonb_build_object('board_status',new.board_status,'status',new.status)
      );
    end loop;
  end if;

  if new.progress_percent is distinct from old.progress_percent or new.progress_note is distinct from old.progress_note then
    for recipient in
      select distinct value
      from unnest(array[new.owner_user_id,new.assigned_by]) value
      where value is not null and value <> actor
    loop
      insert into public.activity_notifications(
        organization_id, recipient_user_id, actor_user_id, activity_id,
        notification_type, title, message, metadata
      ) values (
        new.organization_id, recipient, actor, new.id,
        'progress', 'Progresso registrado', new.title || ' · ' || new.progress_percent || '%',
        jsonb_build_object('progress_percent',new.progress_percent,'progress_note',new.progress_note)
      );
    end loop;
  end if;

  if new.due_at is distinct from old.due_at then
    for recipient in
      select distinct value
      from unnest(array[new.owner_user_id,new.assigned_by]) value
      where value is not null and value <> actor
    loop
      insert into public.activity_notifications(
        organization_id, recipient_user_id, actor_user_id, activity_id,
        notification_type, title, message, metadata
      ) values (
        new.organization_id, recipient, actor, new.id,
        'deadline', 'Prazo alterado', new.title,
        jsonb_build_object('due_at',new.due_at)
      );
    end loop;
  end if;
  return new;
end $$;

revoke execute on function public.notify_activity_changes() from public, anon, authenticated;

create or replace function public.crm_create_reservation_for_proposal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  reservation public.crm_unit_reservations%rowtype;
  reservation_expiry timestamptz;
  unit_status text;
begin
  if new.status in ('submetida','aprovada','enviada','aceita') then
    select status into unit_status
    from public.crm_inventory_units
    where id = new.unit_id
    for update;

    if unit_status is null then
      raise exception 'Unidade não encontrada';
    end if;
    if unit_status = 'vendido' then
      raise exception 'A unidade já foi vendida';
    end if;

    update public.crm_unit_reservations
       set status = 'expirada', updated_at = now()
     where unit_id = new.unit_id
       and status = 'ativa'
       and expires_at is not null
       and expires_at <= now();

    select * into reservation
    from public.crm_unit_reservations
    where unit_id = new.unit_id
      and status = 'ativa'
      and (expires_at is null or expires_at > now())
    order by created_at desc
    limit 1
    for update;

    reservation_expiry := case
      when new.status = 'aceita' then null
      else coalesce(new.valid_until, now() + interval '5 days')
    end;

    if reservation.id is not null then
      if reservation.proposal_id = new.id
         or (
           reservation.proposal_id is null
           and (
             reservation.crm_record_id = new.crm_record_id
             or reservation.contact_id = new.contact_id
             or lower(trim(reservation.customer_name)) = lower(trim(new.customer_name))
           )
         ) then
        update public.crm_unit_reservations
           set proposal_id = new.id,
               expires_at = reservation_expiry,
               customer_name = new.customer_name,
               crm_record_id = coalesce(new.crm_record_id, crm_record_id),
               contact_id = coalesce(new.contact_id, contact_id),
               updated_at = now()
         where id = reservation.id;
      else
        raise exception 'A unidade está reservada para outra negociação';
      end if;
    else
      insert into public.crm_unit_reservations(
        organization_id, project_id, unit_id, proposal_id, crm_record_id,
        contact_id, customer_name, reservation_type, status, expires_at, notes, created_by
      ) values (
        new.organization_id, new.project_id, new.unit_id, new.id, new.crm_record_id,
        new.contact_id, new.customer_name, 'comercial', 'ativa', reservation_expiry,
        'Reserva automática vinculada à proposta ' || coalesce(new.proposal_number,new.id::text),
        new.created_by
      ) returning * into reservation;
    end if;

    update public.crm_proposals
       set reservation_id = reservation.id,
           updated_at = now()
     where id = new.id
       and reservation_id is distinct from reservation.id;
  elsif new.status in ('rejeitada','recusada','cancelada','expirada') then
    update public.crm_unit_reservations
       set status = case when new.status = 'expirada' then 'expirada' else 'cancelada' end,
           updated_at = now()
     where status = 'ativa'
       and (proposal_id = new.id or id = new.reservation_id);

    update public.crm_proposal_public_snapshots
       set active = false
     where proposal_id = new.id;
  end if;
  return new;
end $$;

revoke execute on function public.crm_create_reservation_for_proposal() from public, anon, authenticated;

-- Reprocessa propostas abertas existentes e corrige reservas não vinculadas.
with matching_proposal as (
  select distinct on (reservation.id)
    reservation.id as reservation_id,
    proposal.id as proposal_id
  from public.crm_unit_reservations reservation
  join public.crm_proposals proposal
    on proposal.unit_id = reservation.unit_id
   and lower(trim(proposal.customer_name)) = lower(trim(reservation.customer_name))
   and proposal.status in ('submetida','aprovada','enviada','aceita')
  where reservation.status = 'ativa'
    and reservation.proposal_id is null
  order by reservation.id, proposal.accepted_at desc nulls last, proposal.created_at desc
)
update public.crm_unit_reservations reservation
set proposal_id = matching.proposal_id,
    updated_at = now()
from matching_proposal matching
where reservation.id = matching.reservation_id;

update public.crm_proposals proposal
set reservation_id = reservation.id,
    updated_at = now()
from public.crm_unit_reservations reservation
where reservation.proposal_id = proposal.id
  and proposal.reservation_id is distinct from reservation.id;

update public.crm_proposals proposal
set status = proposal.status
where proposal.status in ('submetida','aprovada','enviada','aceita')
  and proposal.reservation_id is null
  and exists (
    select 1 from public.crm_inventory_units unit
    where unit.id = proposal.unit_id and unit.status <> 'vendido'
  )
  and not exists (
    select 1 from public.crm_unit_reservations reservation
    where reservation.unit_id = proposal.unit_id
      and reservation.status = 'ativa'
      and (reservation.expires_at is null or reservation.expires_at > now())
  );

create unique index if not exists crm_unit_one_active_reservation_idx
  on public.crm_unit_reservations(unit_id)
  where status = 'ativa';
create unique index if not exists crm_reservation_one_proposal_idx
  on public.crm_unit_reservations(proposal_id)
  where proposal_id is not null and status = 'ativa';

create or replace function public.crm_decide_unaccepted_proposal(
  p_proposal_id uuid,
  p_action text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  proposal public.crm_proposals%rowtype;
  member_role text;
begin
  select * into proposal from public.crm_proposals where id = p_proposal_id for update;
  if proposal.id is null then raise exception 'Proposta não encontrada'; end if;

  select lower(role) into member_role
  from public.organization_members
  where organization_id = proposal.organization_id and user_id = auth.uid() and active
  limit 1;
  if coalesce(member_role,'') not in ('admin','administrador','diretoria','diretor') then
    raise exception 'Apenas administrador ou diretoria pode executar esta ação';
  end if;
  if proposal.accepted_at is not null or proposal.status in ('aceita','contratada') then
    raise exception 'A proposta já foi aceita e não pode ser rejeitada ou cancelada por este fluxo';
  end if;
  if p_action not in ('rejeitada','cancelada') then raise exception 'Ação inválida'; end if;
  if length(trim(coalesce(p_reason,''))) < 3 then raise exception 'Informe o motivo da decisão'; end if;

  update public.crm_proposals
     set status = p_action,
         approval_status = p_action,
         rejection_reason = trim(p_reason),
         declined_at = now(),
         updated_at = now()
   where id = proposal.id;

  update public.crm_proposal_approvals
     set status = p_action,
         decided_at = now(),
         decision_notes = trim(p_reason)
   where proposal_id = proposal.id and status = 'pendente';

  return jsonb_build_object('ok',true,'proposal_id',proposal.id,'status',p_action);
end $$;

revoke execute on function public.crm_decide_unaccepted_proposal(uuid,text,text) from public, anon;
grant execute on function public.crm_decide_unaccepted_proposal(uuid,text,text) to authenticated;

create or replace function public.crm_cancel_unsigned_contract(p_contract_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  contract public.crm_contracts%rowtype;
  proposal public.crm_proposals%rowtype;
  member_role text;
begin
  select * into contract from public.crm_contracts where id = p_contract_id for update;
  if contract.id is null then raise exception 'Contrato não encontrado'; end if;

  select lower(role) into member_role
  from public.organization_members
  where organization_id = contract.organization_id and user_id = auth.uid() and active
  limit 1;
  if coalesce(member_role,'') not in ('admin','administrador','diretoria','diretor') then
    raise exception 'Apenas administrador ou diretoria pode cancelar o contrato';
  end if;
  if contract.customer_signed_at is not null or contract.status = 'assinado' or contract.signature_status = 'concluida' then
    raise exception 'Contrato já assinado pelo comprador; utilize o fluxo jurídico de distrato';
  end if;
  if length(trim(coalesce(p_reason,''))) < 3 then raise exception 'Informe o motivo do cancelamento'; end if;

  select * into proposal from public.crm_proposals where id = contract.proposal_id for update;
  update public.crm_contracts
     set status = 'cancelado', signature_status = 'cancelado', canceled_at = now(),
         canceled_by = auth.uid(), cancellation_reason = trim(p_reason), updated_at = now()
   where id = contract.id;
  update public.crm_contract_public_snapshots set active = false where contract_id = contract.id;

  if proposal.id is not null then
    update public.crm_proposals
       set status = 'cancelada', approval_status = 'cancelada', rejection_reason = trim(p_reason),
           declined_at = now(), updated_at = now()
     where id = proposal.id;
  end if;
  return jsonb_build_object('ok',true,'contract_id',contract.id,'status','cancelado');
end $$;

revoke execute on function public.crm_cancel_unsigned_contract(uuid,text) from public, anon;
grant execute on function public.crm_cancel_unsigned_contract(uuid,text) to authenticated;

create or replace function private.process_evora_automations(p_organization_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  expired_reservations integer := 0;
  expired_proposals integer := 0;
  notifications_created integer := 0;
  affected integer := 0;
begin
  update public.crm_unit_reservations
     set status = 'expirada', updated_at = now()
   where status = 'ativa'
     and expires_at is not null
     and expires_at <= now()
     and (p_organization_id is null or organization_id = p_organization_id);
  get diagnostics expired_reservations = row_count;

  update public.crm_proposals
     set status = 'expirada', approval_status = 'expirada',
         rejection_reason = coalesce(rejection_reason,'Validade encerrada automaticamente'),
         declined_at = coalesce(declined_at,now()), updated_at = now()
   where status in ('submetida','aprovada','enviada')
     and accepted_at is null
     and valid_until is not null
     and valid_until <= now()
     and (p_organization_id is null or organization_id = p_organization_id);
  get diagnostics expired_proposals = row_count;

  insert into public.activity_notifications(
    organization_id,recipient_user_id,actor_user_id,activity_id,
    notification_type,title,message,metadata,dedupe_key
  )
  select distinct
    activity.organization_id, recipient.user_id, activity.assigned_by, activity.id,
    'due_soon','Prazo próximo',activity.title || ' · vence em breve',
    jsonb_build_object('due_at',activity.due_at,'priority',activity.priority),
    'due-soon:' || activity.id || ':' || recipient.user_id || ':' || to_char(activity.due_at,'YYYYMMDDHH24MI')
  from public.user_activities activity
  cross join lateral (
    select distinct value as user_id
    from unnest(array[activity.owner_user_id,activity.assigned_by]) as users(value)
    where value is not null
  ) recipient
  where coalesce(activity.board_status,activity.status) <> 'concluida'
    and activity.due_at > now() and activity.due_at <= now() + interval '24 hours'
    and (p_organization_id is null or activity.organization_id = p_organization_id)
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics affected = row_count;
  notifications_created := notifications_created + affected;

  insert into public.activity_notifications(
    organization_id,recipient_user_id,actor_user_id,activity_id,
    notification_type,title,message,metadata,dedupe_key
  )
  select distinct
    activity.organization_id, recipient.user_id, activity.assigned_by, activity.id,
    'overdue','Atividade em atraso',activity.title || ' · prazo ' || to_char(activity.due_at at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI'),
    jsonb_build_object('due_at',activity.due_at,'priority',activity.priority),
    'overdue:' || activity.id || ':' || recipient.user_id || ':' || current_date
  from public.user_activities activity
  cross join lateral (
    select distinct value as user_id
    from unnest(array[activity.owner_user_id,activity.assigned_by]) as users(value)
    where value is not null
  ) recipient
  where coalesce(activity.board_status,activity.status) <> 'concluida'
    and activity.due_at is not null and activity.due_at < now()
    and (p_organization_id is null or activity.organization_id = p_organization_id)
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics affected = row_count;
  notifications_created := notifications_created + affected;

  insert into public.activity_notifications(
    organization_id,recipient_user_id,actor_user_id,activity_id,
    notification_type,title,message,metadata,dedupe_key
  )
  select distinct
    activity.organization_id, recipient.user_id, activity.owner_user_id, activity.id,
    'stale','Atividade sem atualização',activity.title || ' · registre o andamento',
    jsonb_build_object('progress_percent',activity.progress_percent,'last_progress_at',activity.last_progress_at),
    'stale:' || activity.id || ':' || recipient.user_id || ':' || current_date
  from public.user_activities activity
  cross join lateral (
    select distinct value as user_id
    from unnest(array[activity.owner_user_id,activity.assigned_by]) as users(value)
    where value is not null
  ) recipient
  where activity.board_status = 'em_andamento'
    and coalesce(activity.last_progress_at,activity.updated_at) < now() - interval '48 hours'
    and (p_organization_id is null or activity.organization_id = p_organization_id)
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics affected = row_count;
  notifications_created := notifications_created + affected;

  insert into public.activity_notifications(
    organization_id,recipient_user_id,actor_user_id,activity_id,
    notification_type,title,message,metadata,dedupe_key
  )
  select distinct
    proposal.organization_id, recipient.user_id, proposal.created_by, null::uuid,
    'proposal_expiring','Proposta próxima do vencimento',
    coalesce(proposal.proposal_number,'Proposta') || ' · ' || proposal.customer_name,
    jsonb_build_object('proposal_id',proposal.id,'valid_until',proposal.valid_until,'unit_id',proposal.unit_id),
    'proposal-expiring:' || proposal.id || ':' || recipient.user_id || ':' || to_char(proposal.valid_until,'YYYYMMDD')
  from public.crm_proposals proposal
  cross join lateral (
    select proposal.created_by as user_id
    union
    select member.user_id from public.organization_members member
    where member.organization_id = proposal.organization_id and member.active
      and lower(member.role) in ('admin','administrador','diretoria','diretor')
  ) recipient
  where proposal.status in ('submetida','aprovada','enviada')
    and proposal.valid_until > now() and proposal.valid_until <= now() + interval '24 hours'
    and recipient.user_id is not null
    and (p_organization_id is null or proposal.organization_id = p_organization_id)
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics affected = row_count;
  notifications_created := notifications_created + affected;

  insert into public.activity_notifications(
    organization_id,recipient_user_id,actor_user_id,activity_id,
    notification_type,title,message,metadata,dedupe_key
  )
  select distinct
    contract.organization_id, recipient.user_id, contract.company_signed_by, null::uuid,
    'contract_waiting','Contrato aguardando assinatura do comprador',
    coalesce(contract.contract_number,'Contrato') || ' · pendente há mais de 48 horas',
    jsonb_build_object('contract_id',contract.id,'company_signed_at',contract.company_signed_at,'unit_id',contract.unit_id),
    'contract-waiting:' || contract.id || ':' || recipient.user_id || ':' || current_date
  from public.crm_contracts contract
  cross join lateral (
    select coalesce(contract.company_signed_by,contract.created_by) as user_id
    union
    select member.user_id from public.organization_members member
    where member.organization_id = contract.organization_id and member.active
      and lower(member.role) in ('admin','administrador','diretoria','diretor')
  ) recipient
  where contract.status <> 'cancelado'
    and contract.company_signed_at is not null
    and contract.customer_signed_at is null
    and contract.company_signed_at < now() - interval '48 hours'
    and recipient.user_id is not null
    and (p_organization_id is null or contract.organization_id = p_organization_id)
  on conflict (dedupe_key) where dedupe_key is not null do nothing;
  get diagnostics affected = row_count;
  notifications_created := notifications_created + affected;

  return jsonb_build_object(
    'expired_reservations',expired_reservations,
    'expired_proposals',expired_proposals,
    'notifications_created',notifications_created,
    'processed_at',now()
  );
end $$;

revoke all on function private.process_evora_automations(uuid) from public, anon, authenticated;

create or replace function public.run_my_automations(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_org_member(p_organization_id) then raise exception 'Acesso negado'; end if;
  return private.process_evora_automations(p_organization_id);
end $$;

revoke execute on function public.run_my_automations(uuid) from public, anon;
grant execute on function public.run_my_automations(uuid) to authenticated;

create or replace function public.generate_my_overdue_activity_notifications(p_organization_id uuid)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  before_count integer;
  after_count integer;
begin
  if not public.is_org_member(p_organization_id) then raise exception 'Acesso negado'; end if;
  select count(*) into before_count
  from public.activity_notifications
  where organization_id = p_organization_id and recipient_user_id = auth.uid();
  perform private.process_evora_automations(p_organization_id);
  select count(*) into after_count
  from public.activity_notifications
  where organization_id = p_organization_id and recipient_user_id = auth.uid();
  return greatest(after_count - before_count,0);
end $$;

revoke execute on function public.generate_my_overdue_activity_notifications(uuid) from public, anon;
grant execute on function public.generate_my_overdue_activity_notifications(uuid) to authenticated;

-- Agenda o ciclo no próprio Postgres. Se pg_cron não estiver disponível no plano,
-- a aplicação continua invocando run_my_automations a cada atualização automática.
do $$
begin
  begin
    execute 'create extension if not exists pg_cron';
  exception when others then
    raise notice 'pg_cron indisponível; usando execução pela aplicação: %', sqlerrm;
  end;

  if to_regnamespace('cron') is not null then
    execute 'select cron.unschedule(jobid) from cron.job where jobname = ''evora-automation-cycle''';
    execute 'select cron.schedule(''evora-automation-cycle'',''*/10 * * * *'',''select private.process_evora_automations();'')';
  end if;
end $$;
