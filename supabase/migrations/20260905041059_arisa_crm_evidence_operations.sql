begin;

set local lock_timeout = '5s';
set local statement_timeout = '120s';

-- Operação interna: sincroniza somente fatos comprováveis. Nenhuma função desta
-- migração enfileira atendimento, envia mensagem ou altera etapa comercial.
create or replace function crm_private.arisa_evidence_timestamp(p_value text)
returns timestamptz
language plpgsql
immutable
security invoker
set search_path = ''
as $function$
begin
  if p_value is null or length(p_value) > 40 or p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}([.][0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$' then
    return null;
  end if;
  return p_value::timestamptz;
exception when invalid_datetime_format or datetime_field_overflow then
  return null;
end
$function$;
revoke all on function crm_private.arisa_evidence_timestamp(text) from public,anon,authenticated,service_role;

create or replace function crm_private.sync_arisa_crm_record(
  p_organization_id uuid,
  p_crm_record_id uuid,
  p_previous_schedule timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  lead public.crm_records%rowtype;
  last_evidence_at timestamptz;
  last_evidence_id uuid;
  last_evidence_type text;
  next_schedule timestamptz;
  next_action_id uuid;
  effective_last_contact timestamptz;
  effective_next_action timestamptz;
  changes jsonb := '{}'::jsonb;
  audit_id uuid;
begin
  select * into lead from public.crm_records
  where organization_id = p_organization_id and id = p_crm_record_id
  for update;
  if not found or lead.record_status <> 'aberta' then
    return jsonb_build_object('changed', false, 'reason', 'record_not_open');
  end if;

  -- Conclusão de tarefa ou tentativa sem resposta não comprova contato.
  -- Rascunhos, mensagens preparadas e fila de envio também não comprovam envio.
  select evidence.occurred_at, evidence.id, evidence.source_type
  into last_evidence_at, last_evidence_id, last_evidence_type
  from (
    select a.completed_at as occurred_at, a.id, 'crm_action'::text as source_type
    from public.crm_actions a
    where a.organization_id = p_organization_id and a.crm_record_id = p_crm_record_id
      and a.action_status = 'concluida' and a.completed_at <= now()
      and a.action_type in ('contato','ligacao','whatsapp','email','reuniao','visita','mensagem_recebida')
      and a.outcome in ('atendeu','retornar','interessado','sem_interesse','visita_agendada','proposta_solicitada','cliente_respondeu')
    union all
    select case when m.direction = 'outbound' and m.channel = 'whatsapp'
      then coalesce(crm_private.arisa_evidence_timestamp(m.metadata->>'cloud_sent_at'),
        crm_private.arisa_evidence_timestamp(m.metadata->>'provider_status_at'))
      else m.occurred_at end as occurred_at, m.id, 'crm_message'::text
    from public.crm_messages m
    where m.organization_id = p_organization_id and m.crm_record_id = p_crm_record_id
      and m.channel <> 'internal'
      and (
        (m.direction = 'inbound' and m.actor_type = 'lead' and m.delivery_status in ('received','sent','delivered','read'))
        or (m.direction = 'outbound' and m.actor_type in ('ai','human') and m.delivery_status in ('sent','delivered','read'))
      )
  ) evidence
  where evidence.occurred_at <= now()
  order by evidence.occurred_at desc, evidence.id desc
  limit 1;

  select a.scheduled_at, a.id into next_schedule, next_action_id
  from public.crm_actions a
  where a.organization_id = p_organization_id and a.crm_record_id = p_crm_record_id
    and a.action_status = 'pendente' and a.scheduled_at is not null
  order by a.scheduled_at, a.id limit 1;

  effective_last_contact := greatest(lead.last_contact_at, last_evidence_at);
  effective_next_action := lead.next_action_at;
  if next_action_id is not null then
    effective_next_action := next_schedule;
  elsif lead.next_action_at is not null and (
    lead.next_action_at = p_previous_schedule
    or exists (
      select 1 from public.crm_actions a
      where a.organization_id = p_organization_id and a.crm_record_id = p_crm_record_id
        and a.action_status in ('concluida','cancelada')
        and a.scheduled_at = lead.next_action_at
    )
  ) then
    -- Preserva uma data manual se não houver vínculo comprovado à agenda.
    effective_next_action := null;
  end if;

  if lead.last_contact_at is distinct from effective_last_contact then
    changes := changes || jsonb_build_object('last_contact_at', jsonb_build_object('before',lead.last_contact_at,'after',effective_last_contact));
  end if;
  if lead.next_action_at is distinct from effective_next_action then
    changes := changes || jsonb_build_object('next_action_at', jsonb_build_object('before',lead.next_action_at,'after',effective_next_action));
  end if;
  if changes = '{}'::jsonb then return jsonb_build_object('changed', false); end if;

  update public.crm_records
  set last_contact_at = effective_last_contact,
      next_action_at = effective_next_action,
      updated_at = now()
  where organization_id = p_organization_id and id = p_crm_record_id;

  insert into public.crm_opportunity_events (
    organization_id, crm_record_id, opportunity_key, contact_id, project_id,
    product_id, lead_source_id, actor_type, actor_user_id, event_type,
    event_source, occurred_at, data
  ) values (
    p_organization_id, lead.id, lead.id, lead.contact_id, lead.project_id,
    lead.product_id, lead.lead_source_id, 'system', auth.uid(),
    'arisa.crm_synchronized', 'automation', now(),
    jsonb_build_object('changes',changes,'contact_evidence_id',last_evidence_id,
      'contact_evidence_type',last_evidence_type,'next_action_id',next_action_id,
      'external_delivery',false,'policy_version','crm_evidence_v1')
  ) returning id into audit_id;
  return jsonb_build_object('changed',true,'event_id',audit_id,'changes',changes);
end
$function$;

revoke all on function crm_private.sync_arisa_crm_record(uuid,uuid,timestamptz) from public,anon,authenticated,service_role;

create or replace function crm_private.sync_arisa_crm_evidence_trigger()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if tg_op = 'DELETE' then
    perform crm_private.sync_arisa_crm_record(old.organization_id,old.crm_record_id,
      case when tg_table_name = 'crm_actions' then nullif(to_jsonb(old)->>'scheduled_at','')::timestamptz else null end);
    return old;
  end if;
  perform crm_private.sync_arisa_crm_record(new.organization_id,new.crm_record_id,
    case when tg_op = 'UPDATE' and tg_table_name = 'crm_actions'
      then nullif(to_jsonb(old)->>'scheduled_at','')::timestamptz else null end);
  return new;
end
$function$;
revoke all on function crm_private.sync_arisa_crm_evidence_trigger() from public,anon,authenticated,service_role;

drop trigger if exists arisa_crm_actions_evidence on public.crm_actions;
create trigger arisa_crm_actions_evidence
after insert or update of action_status,completed_at,scheduled_at,outcome or delete
on public.crm_actions for each row execute function crm_private.sync_arisa_crm_evidence_trigger();

drop trigger if exists arisa_crm_messages_evidence on public.crm_messages;
create trigger arisa_crm_messages_evidence
after insert or update of delivery_status
on public.crm_messages for each row execute function crm_private.sync_arisa_crm_evidence_trigger();

create or replace function public.reconcile_arisa_crm_operations(
  p_organization_id uuid,
  p_after_id uuid default null,
  p_limit integer default 100
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  item record;
  result jsonb;
  reviewed integer := 0;
  changed integer := 0;
  last_id uuid;
  batch_limit integer := least(greatest(coalesce(p_limit,100),1),250);
begin
  if auth.uid() is null or not exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = auth.uid() and m.active
  ) or not public.has_app_permission(p_organization_id,'crm.manage') then
    raise exception 'Sem permissão para sincronizar o CRM.' using errcode = '42501';
  end if;
  for item in
    select r.id from public.crm_records r
    where r.organization_id = p_organization_id and r.record_status = 'aberta'
      and (p_after_id is null or r.id > p_after_id)
    order by r.id limit batch_limit
  loop
    result := crm_private.sync_arisa_crm_record(p_organization_id,item.id);
    reviewed := reviewed + 1;
    if (result->>'changed')::boolean then changed := changed + 1; end if;
    last_id := item.id;
  end loop;
  return jsonb_build_object('reviewed',reviewed,'changed',changed,'next_after_id',last_id,
    'has_more',exists(select 1 from public.crm_records r where r.organization_id = p_organization_id
      and r.record_status = 'aberta' and r.id > last_id),'external_delivery',false);
end
$function$;
revoke all on function public.reconcile_arisa_crm_operations(uuid,uuid,integer) from public,anon,authenticated,service_role;
grant execute on function public.reconcile_arisa_crm_operations(uuid,uuid,integer) to authenticated;

create or replace function public.get_arisa_crm_operations(p_organization_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $function$
declare result jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = auth.uid() and m.active
  ) or not public.has_app_permission(p_organization_id,'crm.view') then
    raise exception 'Sem permissão para consultar a operação do CRM.' using errcode = '42501';
  end if;
  with leads as materialized (
    select r.* from public.crm_records r
    where r.organization_id = p_organization_id and r.record_status = 'aberta'
  ), items as (
    select 'contact:'||r.id as id, r.id as lead_id, r.person_name as lead_name,
      'missing_data'::text as category, 'Completar contato'::text as title,
      'Falta telefone ou e-mail para continuar o atendimento.'::text as detail,
      r.updated_at as occurred_at, 30 as priority, null::jsonb as changes
    from leads r
    left join public.contacts c on c.organization_id = r.organization_id and c.id = r.contact_id
    where coalesce(nullif(btrim(r.phone),''),nullif(btrim(r.email),''),nullif(btrim(c.phone),''),nullif(btrim(c.email),'')) is null
    union all
    select 'handoff:'||c.id,r.id,r.person_name,'decision','Atendimento humano solicitado',
      'A Bia encaminhou a conversa para revisão. Abra o lead para ver o contexto e assumir o atendimento.',
      c.updated_at,10,null::jsonb
    from public.crm_conversations c join leads r on r.id = c.crm_record_id and r.organization_id = c.organization_id
    where c.organization_id = p_organization_id and c.status = 'human_required'
    union all
    select 'owner:'||r.id,r.id,r.person_name,'decision','Definir responsável humano',
      'Oportunidade sem responsável ativo. A designação formal cria agenda, prazo e alerta para o SDR ou corretor.',
      r.updated_at,35,null::jsonb
    from leads r
    where not exists (select 1 from public.organization_members m where m.organization_id = r.organization_id
      and m.active and m.user_id in (r.owner_user_id,r.sdr_user_id,r.broker_user_id))
      and not exists (select 1 from public.crm_conversations c where c.organization_id = r.organization_id
        and c.crm_record_id = r.id and c.ai_enabled and c.status in ('ai_active','waiting_lead'))
    union all
    select 'followup:'||r.id,r.id,r.person_name,'decision','Definir próximo atendimento',
      'Há contato registrado, mas nenhuma próxima atividade. Abra o lead para agendar o retorno com o contexto disponível.',
      r.last_contact_at,40,null::jsonb
    from leads r
    where r.last_contact_at is not null and r.next_action_at is null
      and not exists (select 1 from public.crm_actions a where a.organization_id = r.organization_id
        and a.crm_record_id = r.id and a.action_status = 'pendente')
      and not exists (select 1 from public.crm_conversations c where c.organization_id = r.organization_id
        and c.crm_record_id = r.id and c.ai_enabled and c.status in ('ai_active','waiting_lead'))
    union all
    select 'assignment:'||a.id,r.id,r.person_name,'decision','Atendimento com prazo vencido',
      'A designação segue aberta após o prazo. Revise o atendimento ou redistribua pela gestão comercial.',
      a.due_at,15,null::jsonb
    from public.crm_lead_assignments a join leads r on r.id = a.crm_record_id and r.organization_id = a.organization_id
    where a.organization_id = p_organization_id and a.status in ('atribuida','aceita','em_atendimento') and a.due_at < now()
    union all
    select 'job:'||j.id,r.id,r.person_name,'failed','Processamento da Bia interrompido',
      'A execução não foi concluída. Verifique a conversa e a configuração da Bia antes de solicitar nova análise.',
      j.updated_at,5,null::jsonb
    from public.crm_ai_jobs j join leads r on r.id = j.crm_record_id and r.organization_id = j.organization_id
    where j.organization_id = p_organization_id and j.status = 'failed'
      and not exists (select 1 from public.crm_ai_jobs later where later.organization_id = j.organization_id
        and later.crm_record_id = j.crm_record_id and later.created_at > j.created_at and later.status = 'completed')
    union all
    select 'delivery:'||m.id,r.id,r.person_name,'failed','Mensagem sem confirmação de envio',
      'O canal registrou falha. Confira a mensagem no histórico antes de qualquer nova tentativa.',
      m.occurred_at,8,null::jsonb
    from public.crm_messages m join leads r on r.id = m.crm_record_id and r.organization_id = m.organization_id
    where m.organization_id = p_organization_id and m.direction = 'outbound' and m.delivery_status = 'failed'
    union all
    select 'sync:'||e.id,r.id,r.person_name,'completed','CRM atualizado pela Arisa',
      'Último contato ou próxima atividade sincronizados com o histórico. Alterações e evidências preservadas na auditoria.',
      e.occurred_at,90,e.data->'changes'
    from public.crm_opportunity_events e
    join public.crm_records r on r.id = e.crm_record_id and r.organization_id = e.organization_id
    where e.organization_id = p_organization_id and e.event_type = 'arisa.crm_synchronized'
      and e.occurred_at >= now() - interval '30 days'
  ), visible as (
    select *, row_number() over(partition by category order by priority,occurred_at desc,id) as position
    from items
  )
  select jsonb_build_object(
    'generated_at',now(),
    'summary',jsonb_build_object(
      'decision',(select count(*) from items where category = 'decision'),
      'missing_data',(select count(*) from items where category = 'missing_data'),
      'failed',(select count(*) from items where category = 'failed'),
      'completed',(select count(*) from items where category = 'completed'),
      'processing',(select count(*) from public.crm_ai_jobs j join leads r on r.id = j.crm_record_id and r.organization_id = j.organization_id where j.organization_id = p_organization_id and j.status in ('pending','processing','retry'))
    ),
    'items',coalesce((select jsonb_agg(jsonb_build_object('id',id,'lead_id',lead_id,'lead_name',lead_name,
      'category',category,'title',title,'detail',detail,'occurred_at',occurred_at,'changes',changes)
      order by priority,occurred_at desc,id) from visible where position <= 50),'[]'::jsonb),
    'category_limit',50,
    'can_reconcile',public.has_app_permission(p_organization_id,'crm.manage')
  ) into result;
  return result;
end
$function$;
revoke all on function public.get_arisa_crm_operations(uuid) from public,anon,authenticated,service_role;
grant execute on function public.get_arisa_crm_operations(uuid) to authenticated;

create index if not exists crm_actions_arisa_pending_idx on public.crm_actions(organization_id,crm_record_id,scheduled_at,id) where action_status = 'pendente';
create index if not exists crm_actions_arisa_completed_idx on public.crm_actions(organization_id,crm_record_id,completed_at desc) where action_status = 'concluida';
create index if not exists crm_opportunity_events_arisa_sync_idx on public.crm_opportunity_events(organization_id,occurred_at desc) where event_type = 'arisa.crm_synchronized';

-- Preserve the live broker/calendar implementation. Only last_contact_at is
-- delegated to the evidence trigger; signatures and all other effects remain.
do $guard$
declare current_hash text;
begin
  select md5(btrim(pg_get_functiondef(p.oid), chr(32)||chr(10)||chr(13)||chr(9))) into current_hash
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname='create_crm_activity_with_broker'
    and p.oid=to_regprocedure('public.create_crm_activity_with_broker(uuid,text,text,text,timestamptz,boolean,text,integer,uuid,uuid,text)');
  if current_hash is null or current_hash not in ('e85d47bdce87394ac2b56371e4abaa17','df7a52bb44c3b8c7e572d80cef462b42') then
    raise exception 'create_crm_activity_with_broker changed since review; preserve the newer implementation before applying this migration.';
  end if;
end
$guard$;

CREATE OR REPLACE FUNCTION public.create_crm_activity_with_broker(p_crm_record_id uuid, p_action_type text, p_channel text, p_subject text, p_scheduled_at timestamp with time zone, p_completed boolean, p_outcome text, p_duration_minutes integer, p_assigned_to uuid, p_broker_user_id uuid, p_notes text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid(); lead public.crm_records%rowtype;
  normalized_action_type text := lower(btrim(coalesce(p_action_type,'')));
  normalized_channel text := lower(btrim(coalesce(p_channel,'')));
  normalized_subject text := btrim(coalesce(p_subject,''));
  normalized_outcome text := nullif(lower(btrim(coalesce(p_outcome,''))),'');
  normalized_notes text := nullif(btrim(coalesce(p_notes,'')),'');
  effective_completed boolean := coalesce(p_completed,false); effective_scheduled_at timestamptz;
  effective_duration integer; effective_assigned_to uuid; effective_broker uuid; appointment boolean;
  appointment_ends_at timestamptz; conflict_exists boolean := false; assignment_id uuid; action_id uuid;
  calendar_activity_id uuid; assignment_due_at timestamptz;
begin
  if actor is null then raise exception 'Autenticação obrigatória.' using errcode='42501'; end if;
  select record.* into lead from public.crm_records record where record.id=p_crm_record_id for update;
  if not found then raise exception 'Lead não localizado.'; end if;
  if not public.is_org_member(lead.organization_id) then raise exception 'Organização não autorizada.' using errcode='42501'; end if;
  if lead.record_status='arquivada' then raise exception 'O lead está arquivado e não pode receber novas atividades.'; end if;
  if normalized_action_type not in ('contato','ligacao','whatsapp','email','reuniao','visita','proposta','tarefa') then raise exception 'Tipo de atividade inválido.'; end if;
  if normalized_channel not in ('whatsapp','telefone','email','presencial','video','instagram','interno') then raise exception 'Canal de atividade inválido.'; end if;
  if char_length(normalized_subject) not between 1 and 300 then raise exception 'Informe um assunto com até 300 caracteres.'; end if;
  if normalized_notes is not null and char_length(normalized_notes)>8000 then raise exception 'As observações excedem o limite permitido.'; end if;
  if p_duration_minutes is not null and (p_duration_minutes<0 or p_duration_minutes>480) then raise exception 'A duração deve estar entre 0 e 480 minutos.'; end if;

  effective_assigned_to:=coalesce(p_assigned_to,actor);
  if not exists(select 1 from public.organization_members member where member.organization_id=lead.organization_id and member.user_id=effective_assigned_to and member.active) then raise exception 'O responsável precisa estar ativo na organização.'; end if;

  effective_broker:=coalesce(p_broker_user_id,lead.broker_user_id);
  if effective_broker is not null and not exists(
    select 1 from public.organization_members member
    where member.organization_id=lead.organization_id and member.user_id=effective_broker and member.active
      and (lower(member.role)='corretor' or exists(
        select 1 from public.crm_team_members team_member join public.crm_teams team on team.id=team_member.team_id and team.organization_id=team_member.organization_id
        where team_member.organization_id=lead.organization_id and team_member.user_id=member.user_id and team_member.active and team.active
          and (lower(team.team_type) in ('corretor','corretores','vendas','comercial') or lower(team_member.team_role) like '%corretor%')
      ))
  ) then raise exception 'O corretor selecionado não está elegível para atendimento.'; end if;

  appointment:=normalized_action_type in ('visita','reuniao') or normalized_outcome='visita_agendada';
  effective_scheduled_at:=case when effective_completed then now() else p_scheduled_at end;
  if appointment and not effective_completed and effective_scheduled_at is null then raise exception 'Defina a data e o horário da visita ou reunião.'; end if;
  if appointment and effective_broker is null then raise exception 'Atribua um corretor antes de agendar a visita ou reunião.'; end if;
  effective_duration:=nullif(coalesce(p_duration_minutes,0),0);
  if appointment then effective_duration:=greatest(coalesce(effective_duration,60),15); end if;

  if appointment and not effective_completed then
    if effective_scheduled_at <= now()+interval '15 minutes' then raise exception 'O agendamento precisa respeitar antecedência mínima de 15 minutos.'; end if;
    appointment_ends_at:=effective_scheduled_at+make_interval(mins=>effective_duration);
    perform pg_advisory_xact_lock(hashtextextended(lead.organization_id::text||':'||effective_broker::text,0));
    select exists(
      select 1 from (
        select activity.starts_at,
          case when activity.due_at is not null and activity.due_at>activity.starts_at then activity.due_at
               else activity.starts_at+make_interval(mins=>greatest(coalesce(activity.estimated_minutes,60),15)) end ends_at
        from public.user_activities activity
        where activity.organization_id=lead.organization_id and activity.owner_user_id=effective_broker and activity.starts_at is not null
          and activity.board_status<>'concluida' and activity.status<>'cancelada'
          and (activity.activity_type in ('visita','reuniao','indisponibilidade','bloqueio_agenda') or activity.tags && array['agenda-bloqueio','indisponibilidade']::text[])
        union all
        select action.scheduled_at, action.scheduled_at+make_interval(mins=>greatest(coalesce(action.duration_minutes,60),15))
        from public.crm_actions action
        where action.organization_id=lead.organization_id and action.assigned_to=effective_broker and action.scheduled_at is not null
          and action.action_status='pendente' and (action.action_type in ('visita','reuniao') or action.outcome='visita_agendada')
          and not (action.metadata ? 'calendar_user_activity_id')
      ) occupied where occupied.starts_at<appointment_ends_at and occupied.ends_at>effective_scheduled_at
    ) into conflict_exists;
    if conflict_exists then raise exception 'O corretor já possui compromisso neste horário. Selecione outro intervalo.'; end if;
  end if;

  if p_broker_user_id is not null and p_broker_user_id is distinct from lead.broker_user_id then
    if not public.has_app_permission(lead.organization_id,'crm.assign') then raise exception 'Seu perfil não possui permissão para atribuir ou substituir o corretor.' using errcode='42501'; end if;
    assignment_due_at:=greatest(now()+interval '5 minutes',least(coalesce(effective_scheduled_at,now()+interval '24 hours'),now()+interval '24 hours'));
    assignment_id:=private.create_crm_assignment(
      lead.id,'corretor',p_broker_user_id,case when appointment then 'alta' else 'normal' end,assignment_due_at,
      case when appointment and effective_scheduled_at is not null then 'Atendimento atribuído durante o agendamento de visita para '||to_char(effective_scheduled_at at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI')||'.' else 'Atendimento atribuído pela atividade comercial.' end,
      actor,'manual',true
    );
  end if;

  insert into public.crm_actions(organization_id,crm_record_id,action_type,subject,scheduled_at,completed_at,action_status,notes,created_by,channel,outcome,duration_minutes,assigned_to,metadata)
  values(lead.organization_id,lead.id,normalized_action_type,normalized_subject,effective_scheduled_at,case when effective_completed then now() else null end,
    case when effective_completed then 'concluida' else 'pendente' end,normalized_notes,actor,normalized_channel,normalized_outcome,effective_duration,effective_assigned_to,
    jsonb_build_object('materials_supported',true,'external_delivery_handoff',false,'broker_user_id',effective_broker,'broker_assignment_id',assignment_id,'calendar_managed',appointment and not effective_completed))
  returning id into action_id;

  if appointment and not effective_completed then
    insert into public.user_activities(organization_id,owner_user_id,assigned_by,updated_by,title,description,activity_type,status,board_status,priority,starts_at,due_at,related_type,related_id,project_id,reminders,checklist,tags,estimated_minutes,watchers,progress_percent)
    values(lead.organization_id,effective_broker,actor,actor,case when normalized_action_type='reuniao' then 'Reunião com ' else 'Visita com ' end||coalesce(nullif(lead.person_name,''),'lead'),normalized_notes,
      case when normalized_action_type='reuniao' then 'reuniao' else 'visita' end,'pendente','backlog','alta',effective_scheduled_at,appointment_ends_at,'crm_actions',action_id,lead.project_id,
      jsonb_build_array(jsonb_build_object('offset_minutes',60),jsonb_build_object('offset_minutes',15)),
      jsonb_build_array(jsonb_build_object('label','Confirmar presença e orientações com o cliente','done',false),jsonb_build_object('label','Registrar o resultado no CRM','done',false)),
      array['crm','agenda-bloqueio','corretor',case when normalized_action_type='reuniao' then 'reuniao' else 'visita' end]::text[],effective_duration,array_remove(array[actor,effective_assigned_to]::uuid[],null),0)
    returning id into calendar_activity_id;
    update public.crm_actions set metadata=metadata||jsonb_build_object('calendar_user_activity_id',calendar_activity_id) where id=action_id;
  end if;

  update public.crm_records set
    broker_user_id=coalesce(effective_broker,broker_user_id),
    next_action_at=case when not effective_completed and effective_scheduled_at is not null then least(coalesce(next_action_at,effective_scheduled_at),effective_scheduled_at) else next_action_at end,
    first_response_at=case when effective_completed then coalesce(first_response_at,now()) else first_response_at end,
    attempts=case when effective_completed then coalesce(attempts,0)+1 else attempts end,
    stagnation_at=case when effective_completed then now() else stagnation_at end,
    updated_at=now()
  where id=lead.id;

  return jsonb_build_object('action_id',action_id,'broker_user_id',effective_broker,'broker_assignment_id',assignment_id,'calendar_user_activity_id',calendar_activity_id,'completed',effective_completed);
end $function$;

commit;
