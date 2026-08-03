-- Designacoes formais de SDR e corretor, agenda integrada, alertas de SLA e
-- roteiros internos de abordagem. Nenhum conteudo e enviado ao lead sem
-- revisao humana; os insights personalizados sao entregues uma unica vez por
-- dia util, as 06:00 em America/Sao_Paulo.

create schema if not exists private;

do $migration$
begin
  if to_regclass('public.crm_records') is null
     or to_regclass('public.crm_actions') is null
     or to_regclass('public.crm_alerts') is null
     or to_regclass('public.user_activities') is null
     or to_regclass('public.activity_notifications') is null
     or to_regclass('public.organization_members') is null
     or to_regclass('public.role_permissions') is null
     or to_regprocedure('public.has_app_permission(uuid,text)') is null
     or to_regprocedure('private.process_evora_automations(uuid)') is null
     or to_regprocedure('private.run_scheduled_insights(text)') is null then
    raise exception
      'Pre-requisitos de CRM, agenda, permissoes ou insights nao encontrados.';
  end if;
end
$migration$;

create table public.crm_lead_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  crm_record_id uuid not null
    references public.crm_records(id) on delete cascade,
  assignment_role text not null,
  assigned_user_id uuid not null
    references auth.users(id) on delete restrict,
  assigned_by uuid
    references auth.users(id) on delete set null,
  status text not null default 'atribuida',
  priority text not null default 'normal',
  instructions text,
  assignment_source text not null default 'manual',
  assigned_at timestamptz not null default now(),
  acknowledge_by timestamptz not null,
  due_at timestamptz not null,
  acknowledged_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  cancelled_at timestamptz,
  status_updated_by uuid
    references auth.users(id) on delete set null,
  user_activity_id uuid
    references public.user_activities(id) on delete set null,
  crm_action_id uuid
    references public.crm_actions(id) on delete set null,
  guidance jsonb not null default '{}'::jsonb,
  guidance_version text not null default 'crm-assignment-guidance-v1',
  guidance_generated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_lead_assignments_role_check
    check (assignment_role in ('sdr', 'corretor')),
  constraint crm_lead_assignments_status_check
    check (status in (
      'atribuida', 'aceita', 'em_atendimento', 'concluida',
      'recusada', 'cancelada', 'substituida'
    )),
  constraint crm_lead_assignments_priority_check
    check (priority in ('normal', 'alta', 'urgente')),
  constraint crm_lead_assignments_source_check
    check (assignment_source in ('manual', 'automation', 'migration')),
  constraint crm_lead_assignments_deadline_check
    check (due_at >= assigned_at),
  constraint crm_lead_assignments_ack_deadline_check
    check (acknowledge_by between assigned_at and due_at),
  constraint crm_lead_assignments_guidance_object_check
    check (jsonb_typeof(guidance) = 'object'),
  constraint crm_lead_assignments_metadata_object_check
    check (jsonb_typeof(metadata) = 'object'),
  constraint crm_lead_assignments_instructions_length_check
    check (instructions is null or char_length(instructions) <= 4000)
);

create unique index crm_lead_assignments_active_role_uidx
  on public.crm_lead_assignments (crm_record_id, assignment_role)
  where status in ('atribuida', 'aceita', 'em_atendimento');

create index crm_lead_assignments_assignee_due_idx
  on public.crm_lead_assignments (
    organization_id, assigned_user_id, status, due_at
  );

create index crm_lead_assignments_monitor_idx
  on public.crm_lead_assignments (
    organization_id, status, priority, due_at
  );

create index crm_lead_assignments_org_assigned_idx
  on public.crm_lead_assignments (organization_id, assigned_at desc);

create index crm_lead_assignments_record_assigned_idx
  on public.crm_lead_assignments (crm_record_id, assigned_at desc);

create table public.crm_lead_assignment_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  assignment_id uuid not null
    references public.crm_lead_assignments(id) on delete cascade,
  event_type text not null,
  previous_status text,
  new_status text,
  actor_user_id uuid
    references auth.users(id) on delete set null,
  note text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint crm_lead_assignment_events_type_check
    check (event_type in (
      'assigned', 'acknowledged', 'started', 'completed', 'rejected',
      'cancelled', 'superseded', 'sla_warning', 'sla_breached',
      'daily_guidance'
    )),
  constraint crm_lead_assignment_events_metadata_object_check
    check (jsonb_typeof(metadata) = 'object')
);

create index crm_lead_assignment_events_assignment_idx
  on public.crm_lead_assignment_events (assignment_id, created_at desc);

create index crm_lead_assignment_events_org_created_idx
  on public.crm_lead_assignment_events (organization_id, created_at desc);

create unique index if not exists insights_run_crm_assignment_recipient_uidx
  on public.insights (
    run_id,
    responsible_user_id,
    related_entity_id,
    ((evidence ->> 'model'))
  )
  where area = 'vendas_crm_sdr'
    and responsible_user_id is not null
    and related_entity_type in ('crm_record', 'crm_records')
    and evidence ->> 'kind' = 'crm_assignment_daily';

comment on table public.crm_lead_assignments is
  'Historico formal das designacoes de SDR e corretor, com agenda, SLA e roteiro interno de atendimento.';
comment on column public.crm_lead_assignments.guidance is
  'Sugestao interna de abordagem. Exige revisao humana e nunca dispara comunicacao externa.';
comment on table public.crm_lead_assignment_events is
  'Trilha append-only de designacao, aceite, execucao, conclusao e alertas de SLA.';

-- Replica a hierarquia de permissoes do aplicativo para um usuario arbitrario.
-- A funcao fica em schema nao exposto e e usada apenas pelas rotinas internas.
create or replace function private.member_has_app_permission(
  p_organization_id uuid,
  p_user_id uuid,
  p_permission_key text
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select coalesce(exists (
    select 1
    from public.organization_members member
    where member.organization_id = p_organization_id
      and member.user_id = p_user_id
      and member.active
      and (
        lower(member.role) = 'admin'
        or case
          when member.permissions ? p_permission_key then
            coalesce((member.permissions ->> p_permission_key)::boolean, false)
          else exists (
            select 1
            from public.role_permissions permission
            where permission.organization_id = p_organization_id
              and permission.role = member.role
              and permission.permission_key = p_permission_key
              and permission.allowed
          )
        end
      )
  ), false)
$function$;

revoke all on function private.member_has_app_permission(uuid, uuid, text)
  from public, anon, authenticated;

-- Roteiro deterministico baseado somente em fatos registrados no CRM. Ele e
-- deliberadamente um rascunho: disponibilidade, preco e condicoes devem ser
-- confirmados antes de qualquer contato.
create or replace function private.build_crm_assignment_guidance(
  p_crm_record_id uuid,
  p_assignment_role text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  lead public.crm_records%rowtype;
  first_name text;
  interest_label text;
  suggested_channel text;
  objective text;
  opening_suggestion text;
  questions jsonb;
  next_steps jsonb;
begin
  select record.* into lead
  from public.crm_records record
  where record.id = p_crm_record_id;

  if not found then
    raise exception 'Lead nao localizado.';
  end if;

  first_name := split_part(
    coalesce(nullif(trim(lead.person_name), ''),
             nullif(trim(lead.company_name), ''), 'contato'),
    ' ', 1
  );
  interest_label := coalesce(
    nullif(trim(lead.preferred_city), ''),
    nullif(trim(lead.utm_campaign), ''),
    'um empreendimento da Evora Urbanismo'
  );
  suggested_channel := case
    when lead.phone is not null
         and lower(coalesce(lead.source_channel, lead.source, '')) like '%whats%'
      then 'WhatsApp'
    when lead.phone is not null then 'Telefone'
    when lead.email is not null then 'E-mail'
    else 'Completar dados de contato antes da abordagem'
  end;

  objective := case
    when p_assignment_role = 'corretor' then
      'Converter o contexto ja qualificado em uma proxima acao comercial objetiva.'
    when lead.first_response_at is null then
      'Realizar o primeiro contato, confirmar interesse e registrar a proxima acao.'
    when coalesce(lead.attempts, 0) > 0 then
      'Retomar o contato com contexto, validar o momento de compra e combinar um proximo passo.'
    else
      'Qualificar necessidade, prazo, capacidade e aderencia ao empreendimento.'
  end;

  opening_suggestion := case
    when p_assignment_role = 'corretor' then
      format(
        'Ola, %s. Aqui e [seu nome], da Evora Urbanismo. Recebi o contexto do seu interesse e gostaria de alinhar as opcoes e o proximo passo com voce.',
        first_name
      )
    else
      format(
        'Ola, %s. Aqui e [seu nome], da Evora Urbanismo. Recebemos seu interesse em %s. Posso fazer algumas perguntas rapidas para orientar o melhor atendimento?',
        first_name, interest_label
      )
  end;

  questions := case
    when p_assignment_role = 'corretor' then jsonb_build_array(
      'Qual configuracao de lote ou unidade atende melhor a sua necessidade?',
      'Qual prazo de decisao e condicao de pagamento fazem sentido neste momento?',
      'Voce prefere uma apresentacao detalhada, simulacao ou visita?'
    )
    else jsonb_build_array(
      'O que motivou a busca por este empreendimento agora?',
      'Qual faixa de investimento e prazo de decisao voce considera?',
      case when lead.financing_interest
        then 'Como pretende estruturar o financiamento e qual parcela mensal seria confortavel?'
        else 'Pretende avaliar financiamento ou outra condicao de pagamento?'
      end,
      'Qual e o melhor canal e horario para o proximo contato?'
    )
  end;

  next_steps := case
    when p_assignment_role = 'corretor' then jsonb_build_array(
      'Revisar historico, interesse e restricoes antes do contato.',
      'Confirmar disponibilidade e condicoes comerciais vigentes.',
      'Registrar resultado, objeções e proxima acao no CRM.'
    )
    else jsonb_build_array(
      'Validar telefone, e-mail e consentimentos registrados.',
      'Executar a abordagem no canal sugerido e registrar o resultado.',
      'Qualificar ou encaminhar ao corretor com contexto completo.'
    )
  end;

  return jsonb_build_object(
    'headline', case
      when p_assignment_role = 'corretor' then 'Conduzir proximo passo comercial'
      else 'Abordagem consultiva orientada por contexto'
    end,
    'objective', objective,
    'recommended_channel', suggested_channel,
    'opening_suggestion', opening_suggestion,
    'questions', questions,
    'next_steps', next_steps,
    'cautions', jsonb_build_array(
      'Confirmar disponibilidade, preco e condicoes comerciais antes de informar o lead.',
      'Adaptar o texto ao historico e nao prometer prazo ou condicao nao aprovada.',
      'Conteudo interno sujeito a revisao humana; nenhum envio externo e automatico.'
    ),
    'context', jsonb_build_object(
      'stage', lead.stage,
      'temperature', lead.temperature,
      'priority', lead.priority,
      'attempts', lead.attempts,
      'last_contact_at', lead.last_contact_at,
      'source', coalesce(lead.source_channel, lead.source)
    ),
    'requires_human_review', true,
    'no_external_delivery', true,
    'generated_at', now()
  );
end
$function$;

revoke all on function private.build_crm_assignment_guidance(uuid, text)
  from public, anon, authenticated;

-- A agenda ja suportava atividades atribuidas, mas bloqueava gestores
-- comerciais mesmo quando possuissem alcada explicita. Preserva as validacoes
-- existentes e passa a respeitar activities.assign/crm.assign/crm.monitor_team.
create or replace function public.validate_activity_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := auth.uid();
  actor_role text;
  can_assign boolean := false;
  can_manage_team boolean := false;
begin
  if actor is null then
    return new;
  end if;

  select lower(member.role)
    into actor_role
  from public.organization_members member
  where member.organization_id = new.organization_id
    and member.user_id = actor
    and member.active
  limit 1;

  if actor_role is null then
    raise exception 'Usuario sem vinculo ativo com a organizacao';
  end if;

  can_assign := actor_role in ('admin', 'administrador', 'diretoria', 'diretor')
    or public.has_app_permission(new.organization_id, 'activities.assign')
    or public.has_app_permission(new.organization_id, 'crm.assign');
  can_manage_team := can_assign
    or public.has_app_permission(new.organization_id, 'activities.manage_team')
    or public.has_app_permission(new.organization_id, 'crm.monitor_team');

  if not exists (
    select 1
    from public.organization_members member
    where member.organization_id = new.organization_id
      and member.user_id = new.owner_user_id
      and member.active
  ) then
    raise exception 'O responsavel precisa ser um usuario ativo da organizacao';
  end if;

  if tg_op = 'INSERT' then
    new.assigned_by := actor;
    new.updated_by := actor;
    if new.owner_user_id <> actor and not can_assign then
      raise exception 'Sem permissao para designar outro usuario';
    end if;
  else
    if new.assigned_by is distinct from old.assigned_by then
      raise exception 'A autoria da atividade nao pode ser alterada';
    end if;
    if new.owner_user_id is distinct from old.owner_user_id
       and not can_assign then
      raise exception 'Sem permissao para transferir a atividade';
    end if;
    if not can_manage_team and actor <> old.owner_user_id then
      raise exception 'Somente o responsavel ou um gestor autorizado pode alterar a atividade';
    end if;
    new.updated_by := actor;
  end if;

  if new.due_at is not null
     and new.starts_at is not null
     and new.due_at < new.starts_at then
    raise exception 'O prazo nao pode ser anterior ao inicio da atividade';
  end if;

  return new;
end
$function$;

revoke all on function public.validate_activity_assignment()
  from public, anon, authenticated;

-- Nucleo atomico reutilizado pela RPC e pela captura de atribuicoes feitas
-- pelas automacoes internas legadas.
create or replace function private.create_crm_assignment(
  p_crm_record_id uuid,
  p_assignment_role text,
  p_assigned_user_id uuid,
  p_priority text,
  p_due_at timestamptz,
  p_instructions text,
  p_actor_user_id uuid,
  p_assignment_source text,
  p_sync_record boolean default true
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $function$
declare
  lead public.crm_records%rowtype;
  prior_assignment public.crm_lead_assignments%rowtype;
  assignment_id uuid := gen_random_uuid();
  activity_id uuid;
  action_id uuid;
  effective_due_at timestamptz;
  effective_acknowledge_by timestamptz;
  v_guidance jsonb;
  activity_description text;
  checklist jsonb;
begin
  select record.* into lead
  from public.crm_records record
  where record.id = p_crm_record_id
  for update;

  if not found then
    raise exception 'Lead nao localizado.';
  end if;

  if p_assignment_role not in ('sdr', 'corretor') then
    raise exception 'Papel de designacao invalido.';
  end if;
  if p_priority not in ('normal', 'alta', 'urgente') then
    raise exception 'Prioridade de designacao invalida.';
  end if;
  if p_assignment_source not in ('manual', 'automation', 'migration') then
    raise exception 'Origem de designacao invalida.';
  end if;

  if not exists (
    select 1
    from public.organization_members member
    where member.organization_id = lead.organization_id
      and member.user_id = p_assigned_user_id
      and member.active
      and (
        p_assignment_source in ('automation', 'migration')
        or (p_assignment_role = 'sdr' and lower(member.role) = 'sdr')
        or (p_assignment_role = 'corretor' and lower(member.role) = 'corretor')
        or exists (
          select 1
          from public.crm_team_members team_member
          join public.crm_teams team
            on team.id = team_member.team_id
           and team.organization_id = team_member.organization_id
          where team_member.organization_id = lead.organization_id
            and team_member.user_id = member.user_id
            and team_member.active
            and team.active
            and (
              (p_assignment_role = 'sdr' and lower(team.team_type) in (
                'sdr', 'pre_vendas', 'pre-vendas'
              ))
              or (p_assignment_role = 'corretor' and lower(team.team_type) in (
                'corretor', 'corretores', 'vendas', 'comercial'
              ))
            )
        )
      )
  ) then
    raise exception
      'O designado precisa estar ativo e vinculado a equipe ou perfil compativel.';
  end if;

  effective_due_at := coalesce(
    p_due_at,
    now() + case when p_assignment_role = 'sdr'
      then interval '2 hours' else interval '24 hours' end
  );
  if effective_due_at < now() then
    -- Backfills preservam prazos historicos sem violar a consistencia da linha.
    if p_assignment_source = 'migration' then
      effective_due_at := now();
    else
      raise exception 'O prazo da designacao precisa estar no futuro.';
    end if;
  end if;
  effective_acknowledge_by := least(
    effective_due_at,
    now() + case
      when p_priority = 'urgente' then interval '15 minutes'
      when p_priority = 'alta' then interval '30 minutes'
      else interval '2 hours'
    end
  );

  for prior_assignment in
    select assignment.*
    from public.crm_lead_assignments assignment
    where assignment.crm_record_id = lead.id
      and assignment.assignment_role = p_assignment_role
      and assignment.status in ('atribuida', 'aceita', 'em_atendimento')
    for update
  loop
    update public.crm_lead_assignments
    set status = 'substituida',
      cancelled_at = now(),
      status_updated_by = p_actor_user_id,
      updated_at = now()
    where id = prior_assignment.id;

    if prior_assignment.user_activity_id is not null then
      update public.user_activities
      set status = 'cancelada', board_status = 'concluida',
        completed_at = now(), progress_note = 'Designacao substituida.',
        updated_by = p_actor_user_id, updated_at = now()
      where id = prior_assignment.user_activity_id;
    end if;
    if prior_assignment.crm_action_id is not null then
      update public.crm_actions
      set action_status = 'cancelada', completed_at = now(),
        outcome = 'designacao_substituida'
      where id = prior_assignment.crm_action_id;
    end if;

    update public.crm_alerts
    set status = 'resolvido', resolved_at = now()
    where crm_record_id = lead.id
      and alert_type like 'crm_assignment:' || prior_assignment.id::text || ':%'
      and status = 'aberto';

    insert into public.crm_lead_assignment_events (
      organization_id, assignment_id, event_type,
      previous_status, new_status, actor_user_id, note
    ) values (
      lead.organization_id, prior_assignment.id, 'superseded',
      prior_assignment.status, 'substituida', p_actor_user_id,
      'Nova designacao registrada para o mesmo papel.'
    );
  end loop;

  v_guidance := private.build_crm_assignment_guidance(
    lead.id, p_assignment_role
  );

  insert into public.crm_lead_assignments (
    id, organization_id, crm_record_id, assignment_role,
    assigned_user_id, assigned_by, status, priority, instructions,
    assignment_source, assigned_at, acknowledge_by, due_at,
    guidance, guidance_generated_at, metadata
  ) values (
    assignment_id, lead.organization_id, lead.id, p_assignment_role,
    p_assigned_user_id, p_actor_user_id, 'atribuida', p_priority,
    nullif(trim(coalesce(p_instructions, '')), ''), p_assignment_source,
    now(), effective_acknowledge_by, effective_due_at, v_guidance, now(),
    jsonb_build_object(
      'requires_human_review', true,
      'no_external_delivery', true
    )
  );

  activity_description := concat_ws(E'\n\n',
    nullif(trim(coalesce(p_instructions, '')), ''),
    'Objetivo sugerido: ' || coalesce(v_guidance ->> 'objective', ''),
    'Abertura sugerida: ' || coalesce(v_guidance ->> 'opening_suggestion', ''),
    'Roteiro interno sujeito a revisao humana. Nenhuma mensagem foi enviada automaticamente.'
  );
  checklist := case when p_assignment_role = 'sdr' then
    jsonb_build_array(
      jsonb_build_object('label', 'Revisar contexto e dados de contato', 'done', false),
      jsonb_build_object('label', 'Realizar e registrar a abordagem', 'done', false),
      jsonb_build_object('label', 'Definir proxima acao ou encaminhar ao corretor', 'done', false)
    )
  else
    jsonb_build_array(
      jsonb_build_object('label', 'Revisar qualificacao e historico', 'done', false),
      jsonb_build_object('label', 'Confirmar disponibilidade e condicoes', 'done', false),
      jsonb_build_object('label', 'Contatar e registrar o proximo passo', 'done', false)
    )
  end;

  insert into public.user_activities (
    organization_id, owner_user_id, assigned_by, title, description,
    activity_type, status, priority, starts_at, due_at, related_type,
    related_id, project_id, reminders, checklist, board_status, tags,
    estimated_minutes, watchers, updated_by
  ) values (
    lead.organization_id, p_assigned_user_id, p_actor_user_id,
    case when p_assignment_role = 'sdr'
      then 'Atender lead como SDR: '
      else 'Atender oportunidade como corretor: ' end ||
      coalesce(nullif(lead.person_name, ''), nullif(lead.company_name, ''), 'Sem nome'),
    activity_description, 'crm', 'pendente', p_priority,
    now(), effective_due_at, 'crm_records', lead.id, lead.project_id,
    jsonb_build_array(jsonb_build_object(
      'offset_minutes', case when p_priority = 'urgente' then 15 else 30 end
    )),
    checklist, 'backlog', array['crm', p_assignment_role, 'designacao'],
    case when p_assignment_role = 'sdr' then 30 else 45 end,
    array_remove(array[p_actor_user_id]::uuid[], null), p_actor_user_id
  ) returning id into activity_id;

  insert into public.crm_actions (
    organization_id, crm_record_id, action_type, subject, scheduled_at,
    action_status, notes, created_by, channel, assigned_to, metadata
  ) values (
    lead.organization_id, lead.id, 'tarefa',
    case when p_assignment_role = 'sdr'
      then 'Designacao para atendimento SDR'
      else 'Designacao para atendimento comercial' end,
    now(), 'pendente', activity_description, p_actor_user_id,
    'interno', p_assigned_user_id,
    jsonb_build_object(
      'crm_assignment_id', assignment_id,
      'assignment_role', p_assignment_role,
      'user_activity_id', activity_id,
      'requires_human_review', true,
      'no_external_delivery', true
    )
  ) returning id into action_id;

  update public.crm_lead_assignments
  set user_activity_id = activity_id,
      crm_action_id = action_id,
      updated_at = now()
  where id = assignment_id;

  if p_sync_record then
    update public.crm_records
    set sdr_user_id = case when p_assignment_role = 'sdr'
          then p_assigned_user_id else sdr_user_id end,
        broker_user_id = case when p_assignment_role = 'corretor'
          then p_assigned_user_id else broker_user_id end,
        owner_user_id = coalesce(owner_user_id, p_assigned_user_id),
        next_action_at = least(
          coalesce(next_action_at, effective_due_at), effective_due_at
        ),
        updated_at = now()
    where id = lead.id;
  end if;

  update public.crm_team_members team_member
  set last_assigned_at = now()
  where team_member.organization_id = lead.organization_id
    and team_member.user_id = p_assigned_user_id
    and team_member.active;

  insert into public.crm_lead_assignment_events (
    organization_id, assignment_id, event_type, new_status,
    actor_user_id, note, metadata
  ) values (
    lead.organization_id, assignment_id, 'assigned', 'atribuida',
    p_actor_user_id, nullif(trim(coalesce(p_instructions, '')), ''),
    jsonb_build_object(
      'assignment_source', p_assignment_source,
      'due_at', effective_due_at,
      'acknowledge_by', effective_acknowledge_by
    )
  );

  return assignment_id;
end
$function$;

revoke all on function private.create_crm_assignment(
  uuid, text, uuid, text, timestamptz, text, uuid, text, boolean
) from public, anon, authenticated;

create or replace function public.assign_crm_record(
  p_crm_record_id uuid,
  p_assignment_role text,
  p_assigned_user_id uuid,
  p_priority text default 'normal',
  p_due_at timestamptz default null,
  p_instructions text default null
)
returns public.crm_lead_assignments
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := auth.uid();
  organization_id uuid;
  assignment_id uuid;
  result public.crm_lead_assignments%rowtype;
begin
  if actor is null then
    raise exception 'Autenticacao obrigatoria.';
  end if;

  select record.organization_id into organization_id
  from public.crm_records record
  where record.id = p_crm_record_id;

  if organization_id is null then
    raise exception 'Lead nao localizado.';
  end if;
  if not public.is_org_member(organization_id)
     or not public.has_app_permission(organization_id, 'crm.assign') then
    raise exception 'Sem permissao para designar SDR ou corretor.';
  end if;
  if p_due_at is not null and p_due_at < now() then
    raise exception 'O prazo da designacao precisa estar no futuro.';
  end if;

  assignment_id := private.create_crm_assignment(
    p_crm_record_id, lower(trim(p_assignment_role)), p_assigned_user_id,
    lower(trim(coalesce(p_priority, 'normal'))), p_due_at,
    p_instructions, actor, 'manual', true
  );

  select assignment.* into result
  from public.crm_lead_assignments assignment
  where assignment.id = assignment_id;

  return result;
end
$function$;

revoke all on function public.assign_crm_record(
  uuid, text, uuid, text, timestamptz, text
) from public, anon, authenticated;
grant execute on function public.assign_crm_record(
  uuid, text, uuid, text, timestamptz, text
) to authenticated, service_role;

create or replace function public.set_crm_assignment_status(
  p_assignment_id uuid,
  p_status text
)
returns public.crm_lead_assignments
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := auth.uid();
  assignment public.crm_lead_assignments%rowtype;
  requested_status text := lower(trim(p_status));
  can_manage boolean;
  event_type text;
  result public.crm_lead_assignments%rowtype;
begin
  if actor is null then
    raise exception 'Autenticacao obrigatoria.';
  end if;

  select item.* into assignment
  from public.crm_lead_assignments item
  where item.id = p_assignment_id
  for update;

  if not found then
    raise exception 'Designacao nao localizada.';
  end if;
  if not public.is_org_member(assignment.organization_id) then
    raise exception 'Acesso negado.';
  end if;

  can_manage := public.has_app_permission(
      assignment.organization_id, 'crm.assign'
    ) or public.has_app_permission(
      assignment.organization_id, 'crm.monitor_team'
    );

  if actor <> assignment.assigned_user_id and not can_manage then
    raise exception 'Somente o designado ou um gestor autorizado pode alterar a designacao.';
  end if;
  if requested_status not in (
    'aceita', 'em_atendimento', 'concluida', 'recusada', 'cancelada'
  ) then
    raise exception 'Status de designacao invalido.';
  end if;
  if not can_manage and not (
    (assignment.status = 'atribuida' and requested_status in ('aceita', 'recusada'))
    or (assignment.status = 'aceita' and requested_status in ('em_atendimento', 'concluida'))
    or (assignment.status = 'em_atendimento' and requested_status = 'concluida')
  ) then
    raise exception 'Transicao de status nao permitida.';
  end if;
  if assignment.status in ('concluida', 'recusada', 'cancelada', 'substituida') then
    raise exception 'A designacao ja foi encerrada.';
  end if;
  if requested_status = assignment.status then
    return assignment;
  end if;

  event_type := case requested_status
    when 'aceita' then 'acknowledged'
    when 'em_atendimento' then 'started'
    when 'concluida' then 'completed'
    when 'recusada' then 'rejected'
    when 'cancelada' then 'cancelled'
  end;

  update public.crm_lead_assignments
  set status = requested_status,
      acknowledged_at = case when requested_status in (
        'aceita', 'em_atendimento', 'concluida'
      ) then coalesce(acknowledged_at, now()) else acknowledged_at end,
      started_at = case when requested_status in (
        'em_atendimento', 'concluida'
      ) then coalesce(started_at, now()) else started_at end,
      completed_at = case when requested_status = 'concluida'
        then now() else completed_at end,
      cancelled_at = case when requested_status in ('recusada', 'cancelada')
        then now() else cancelled_at end,
      status_updated_by = actor,
      updated_at = now()
  where id = assignment.id
  returning * into result;

  if assignment.user_activity_id is not null then
    update public.user_activities
    set status = case
          when requested_status = 'aceita' then 'pendente'
          when requested_status = 'em_atendimento' then 'em_andamento'
          when requested_status = 'concluida' then 'concluida'
          else 'cancelada' end,
        board_status = case
          when requested_status = 'aceita' then 'backlog'
          when requested_status = 'em_atendimento' then 'em_andamento'
          else 'concluida' end,
        acknowledged_at = case when requested_status in (
          'aceita', 'em_atendimento', 'concluida'
        ) then coalesce(acknowledged_at, now()) else acknowledged_at end,
        acknowledged_by = case when requested_status in (
          'aceita', 'em_atendimento', 'concluida'
        ) then coalesce(acknowledged_by, actor) else acknowledged_by end,
        progress_percent = case
          when requested_status = 'aceita' then greatest(progress_percent, 10)
          when requested_status = 'em_atendimento' then greatest(progress_percent, 40)
          when requested_status = 'concluida' then 100
          else progress_percent end,
        progress_note = case
          when requested_status = 'recusada' then 'Designacao recusada pelo responsavel.'
          when requested_status = 'cancelada' then 'Designacao cancelada pelo gestor.'
          else progress_note end,
        completed_at = case when requested_status in (
          'concluida', 'recusada', 'cancelada'
        ) then now() else completed_at end,
        last_progress_at = now(), updated_by = actor, updated_at = now()
    where id = assignment.user_activity_id;
  end if;

  if assignment.crm_action_id is not null then
    update public.crm_actions
    set action_status = case
          when requested_status in ('concluida', 'recusada', 'cancelada')
            then 'concluida'
          else 'pendente' end,
        completed_at = case when requested_status in (
          'concluida', 'recusada', 'cancelada'
        ) then now() else completed_at end,
        outcome = case
          when requested_status = 'concluida' then 'atendimento_concluido'
          when requested_status = 'recusada' then 'designacao_recusada'
          when requested_status = 'cancelada' then 'designacao_cancelada'
          else outcome end
    where id = assignment.crm_action_id;
  end if;

  if requested_status in ('recusada', 'cancelada') then
    update public.crm_records
    set sdr_user_id = case
          when assignment.assignment_role = 'sdr'
               and sdr_user_id = assignment.assigned_user_id then null
          else sdr_user_id end,
        broker_user_id = case
          when assignment.assignment_role = 'corretor'
               and broker_user_id = assignment.assigned_user_id then null
          else broker_user_id end,
        updated_at = now()
    where id = assignment.crm_record_id;
  end if;

  if requested_status in ('concluida', 'recusada', 'cancelada') then
    update public.crm_alerts
    set status = 'resolvido', resolved_at = now()
    where crm_record_id = assignment.crm_record_id
      and alert_type like 'crm_assignment:' || assignment.id::text || ':%'
      and status = 'aberto';
  end if;

  insert into public.crm_lead_assignment_events (
    organization_id, assignment_id, event_type, previous_status,
    new_status, actor_user_id
  ) values (
    assignment.organization_id, assignment.id, event_type,
    assignment.status, requested_status, actor
  );

  return result;
end
$function$;

revoke all on function public.set_crm_assignment_status(uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_crm_assignment_status(uuid, text)
  to authenticated, service_role;

-- Impede que clientes contornem a trilha atomica alterando diretamente os
-- campos de responsavel. Funcoes SECURITY DEFINER e jobs internos executam
-- como papeis privilegiados e permanecem compativeis.
create or replace function private.guard_direct_crm_assignment()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
begin
  if (
    new.sdr_user_id is distinct from old.sdr_user_id
    or new.broker_user_id is distinct from old.broker_user_id
  ) and current_user not in ('postgres', 'service_role', 'supabase_admin') then
    raise exception
      'Use assign_crm_record ou set_crm_assignment_status para alterar responsaveis.';
  end if;
  return new;
end
$function$;

revoke all on function private.guard_direct_crm_assignment()
  from public, anon, authenticated;

create or replace function private.capture_internal_crm_assignment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.sdr_user_id is distinct from old.sdr_user_id
     and new.sdr_user_id is not null
     and not exists (
       select 1 from public.crm_lead_assignments assignment
       where assignment.crm_record_id = new.id
         and assignment.assignment_role = 'sdr'
         and assignment.assigned_user_id = new.sdr_user_id
         and assignment.status in ('atribuida', 'aceita', 'em_atendimento')
     ) then
    perform private.create_crm_assignment(
      new.id, 'sdr', new.sdr_user_id,
      case when new.priority = 'baixa' then 'normal' else coalesce(new.priority, 'normal') end,
      greatest(coalesce(new.sla_due_at, new.next_action_at, now() + interval '2 hours'), now()),
      'Designacao capturada de automacao interna do CRM.',
      coalesce(auth.uid(), new.created_by, new.sdr_user_id),
      'automation', false
    );
  end if;

  if new.broker_user_id is distinct from old.broker_user_id
     and new.broker_user_id is not null
     and not exists (
       select 1 from public.crm_lead_assignments assignment
       where assignment.crm_record_id = new.id
         and assignment.assignment_role = 'corretor'
         and assignment.assigned_user_id = new.broker_user_id
         and assignment.status in ('atribuida', 'aceita', 'em_atendimento')
     ) then
    perform private.create_crm_assignment(
      new.id, 'corretor', new.broker_user_id,
      case when new.priority = 'baixa' then 'normal' else coalesce(new.priority, 'normal') end,
      greatest(coalesce(new.next_action_at, now() + interval '24 hours'), now()),
      'Designacao capturada de automacao interna do CRM.',
      coalesce(auth.uid(), new.created_by, new.broker_user_id),
      'automation', false
    );
  end if;

  return new;
end
$function$;

revoke all on function private.capture_internal_crm_assignment()
  from public, anon, authenticated;

-- Cria agenda para atribuicoes preexistentes sem disparar uma tempestade de
-- notificacoes: no backfill, o proprio designado figura como autor historico.
do $backfill$
declare
  lead record;
begin
  for lead in
    select record.*
    from public.crm_records record
    where record.sdr_user_id is not null
      and exists (
        select 1
        from public.organization_members member
        where member.organization_id = record.organization_id
          and member.user_id = record.sdr_user_id
          and member.active
      )
      and not exists (
        select 1 from public.crm_lead_assignments assignment
        where assignment.crm_record_id = record.id
          and assignment.assignment_role = 'sdr'
          and assignment.status in ('atribuida', 'aceita', 'em_atendimento')
      )
  loop
    perform private.create_crm_assignment(
      lead.id, 'sdr', lead.sdr_user_id,
      case when lead.priority in ('alta', 'urgente') then lead.priority else 'normal' end,
      greatest(
        coalesce(lead.sla_due_at, lead.next_action_at, now() + interval '2 hours'),
        now()
      ),
      'Designacao preexistente conciliada na implantacao da trilha formal.',
      lead.sdr_user_id, 'migration', false
    );
  end loop;

  for lead in
    select record.*
    from public.crm_records record
    where record.broker_user_id is not null
      and exists (
        select 1
        from public.organization_members member
        where member.organization_id = record.organization_id
          and member.user_id = record.broker_user_id
          and member.active
      )
      and not exists (
        select 1 from public.crm_lead_assignments assignment
        where assignment.crm_record_id = record.id
          and assignment.assignment_role = 'corretor'
          and assignment.status in ('atribuida', 'aceita', 'em_atendimento')
      )
  loop
    perform private.create_crm_assignment(
      lead.id, 'corretor', lead.broker_user_id,
      case when lead.priority in ('alta', 'urgente') then lead.priority else 'normal' end,
      greatest(coalesce(lead.next_action_at, now() + interval '24 hours'), now()),
      'Designacao preexistente conciliada na implantacao da trilha formal.',
      lead.broker_user_id, 'migration', false
    );
  end loop;
end
$backfill$;

drop trigger if exists guard_direct_crm_assignment
  on public.crm_records;
create trigger guard_direct_crm_assignment
before update of sdr_user_id, broker_user_id on public.crm_records
for each row execute function private.guard_direct_crm_assignment();

drop trigger if exists capture_internal_crm_assignment
  on public.crm_records;
create trigger capture_internal_crm_assignment
after update of sdr_user_id, broker_user_id on public.crm_records
for each row execute function private.capture_internal_crm_assignment();

-- O ciclo de 10 minutos gera somente alertas operacionais e de SLA. As chaves
-- de deduplicacao impedem repeticao para o mesmo marco e destinatario.
create or replace function private.process_crm_assignment_monitoring(
  p_organization_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  assignment record;
  supervisor record;
  local_day text := timezone('America/Sao_Paulo', now())::date::text;
  notification_count integer := 0;
  alert_count integer := 0;
  affected integer;
begin
  for assignment in
    select item.*
    from public.crm_lead_assignments item
    where item.status in ('atribuida', 'aceita', 'em_atendimento')
      and (p_organization_id is null or item.organization_id = p_organization_id)
    order by item.due_at, item.id
  loop
    if assignment.status = 'atribuida'
       and assignment.acknowledge_by <= now() then
      insert into public.crm_alerts (
        organization_id, crm_record_id, alert_type, severity, title,
        message, assigned_to, due_at, status
      ) values (
        assignment.organization_id, assignment.crm_record_id,
        'crm_assignment:' || assignment.id::text || ':ack',
        case when assignment.priority = 'urgente' then 'critica' else 'alta' end,
        'Designacao ainda nao reconhecida',
        'O responsavel ainda nao confirmou o recebimento da designacao.',
        assignment.assigned_user_id, assignment.acknowledge_by, 'aberto'
      ) on conflict (crm_record_id, alert_type, status) do nothing;
      get diagnostics affected = row_count;
      alert_count := alert_count + affected;

      insert into public.activity_notifications (
        organization_id, recipient_user_id, actor_user_id, activity_id,
        notification_type, title, message, metadata, dedupe_key
      ) values (
        assignment.organization_id, assignment.assigned_user_id,
        assignment.assigned_by, assignment.user_activity_id,
        'crm_assignment_sla', 'Confirme a designacao recebida',
        'A designacao ultrapassou o prazo de aceite. Abra a atividade e confirme o atendimento.',
        jsonb_build_object(
          'crm_assignment_id', assignment.id,
          'crm_record_id', assignment.crm_record_id,
          'sla', 'acknowledgement', 'due_at', assignment.acknowledge_by
        ),
        'crm-assignment:ack:' || assignment.id::text || ':' || local_day
      ) on conflict (dedupe_key) where dedupe_key is not null do nothing;
      get diagnostics affected = row_count;
      notification_count := notification_count + affected;
    end if;

    if assignment.due_at <= now() then
      insert into public.crm_alerts (
        organization_id, crm_record_id, alert_type, severity, title,
        message, assigned_to, due_at, status
      ) values (
        assignment.organization_id, assignment.crm_record_id,
        'crm_assignment:' || assignment.id::text || ':due',
        case when assignment.priority = 'urgente' then 'critica' else 'alta' end,
        'Prazo de atendimento vencido',
        'A designacao exige tratamento e atualizacao de status.',
        assignment.assigned_user_id, assignment.due_at, 'aberto'
      ) on conflict (crm_record_id, alert_type, status) do nothing;
      get diagnostics affected = row_count;
      alert_count := alert_count + affected;

      insert into public.activity_notifications (
        organization_id, recipient_user_id, actor_user_id, activity_id,
        notification_type, title, message, metadata, dedupe_key
      ) values (
        assignment.organization_id, assignment.assigned_user_id,
        assignment.assigned_by, assignment.user_activity_id,
        'crm_assignment_overdue', 'Atendimento em atraso',
        'O prazo da designacao venceu. Registre o andamento ou conclua a atividade.',
        jsonb_build_object(
          'crm_assignment_id', assignment.id,
          'crm_record_id', assignment.crm_record_id,
          'due_at', assignment.due_at
        ),
        'crm-assignment:overdue:' || assignment.id::text || ':' || local_day ||
          ':' || assignment.assigned_user_id::text
      ) on conflict (dedupe_key) where dedupe_key is not null do nothing;
      get diagnostics affected = row_count;
      notification_count := notification_count + affected;

      for supervisor in
        select member.user_id
        from public.organization_members member
        where member.organization_id = assignment.organization_id
          and member.active
          and member.user_id <> assignment.assigned_user_id
          and (
            member.user_id = assignment.assigned_by
            or private.member_has_app_permission(
              assignment.organization_id, member.user_id, 'crm.monitor_team'
            )
          )
      loop
        insert into public.activity_notifications (
          organization_id, recipient_user_id, actor_user_id, activity_id,
          notification_type, title, message, metadata, dedupe_key
        ) values (
          assignment.organization_id, supervisor.user_id,
          assignment.assigned_user_id, assignment.user_activity_id,
          'crm_assignment_monitor', 'Designacao da equipe em atraso',
          'Uma designacao de CRM venceu sem conclusao. Revise o responsavel e o proximo passo.',
          jsonb_build_object(
            'crm_assignment_id', assignment.id,
            'crm_record_id', assignment.crm_record_id,
            'assigned_user_id', assignment.assigned_user_id,
            'due_at', assignment.due_at
          ),
          'crm-assignment:monitor:' || assignment.id::text || ':' || local_day ||
            ':' || supervisor.user_id::text
        ) on conflict (dedupe_key) where dedupe_key is not null do nothing;
        get diagnostics affected = row_count;
        notification_count := notification_count + affected;
      end loop;
    elsif assignment.due_at <= now() + interval '2 hours' then
      insert into public.activity_notifications (
        organization_id, recipient_user_id, actor_user_id, activity_id,
        notification_type, title, message, metadata, dedupe_key
      ) values (
        assignment.organization_id, assignment.assigned_user_id,
        assignment.assigned_by, assignment.user_activity_id,
        'crm_assignment_due_soon', 'Prazo de atendimento proximo',
        'A designacao vence em ate duas horas. Priorize a proxima acao.',
        jsonb_build_object(
          'crm_assignment_id', assignment.id,
          'crm_record_id', assignment.crm_record_id,
          'due_at', assignment.due_at
        ),
        'crm-assignment:due-soon:' || assignment.id::text || ':' ||
          assignment.due_at::text
      ) on conflict (dedupe_key) where dedupe_key is not null do nothing;
      get diagnostics affected = row_count;
      notification_count := notification_count + affected;
    end if;
  end loop;

  return jsonb_build_object(
    'alerts_created', alert_count,
    'notifications_created', notification_count,
    'personalized_insights_created', 0,
    'processed_at', now()
  );
end
$function$;

revoke all on function private.process_crm_assignment_monitoring(uuid)
  from public, anon, authenticated;

-- Entrega o roteiro personalizado exatamente na rotina de Insights das 06:00.
-- Nao cria comunicacao externa e nao roda no ciclo operacional de 10 minutos.
create or replace function private.process_crm_assignment_daily_insights(
  p_organization_id uuid,
  p_run_id uuid,
  p_scheduled_for timestamptz
)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  assignment record;
  v_guidance jsonb;
  v_insight_id uuid;
  local_date date := timezone('America/Sao_Paulo', p_scheduled_for)::date;
  created_count integer := 0;
  affected integer;
begin
  if extract(isodow from timezone('America/Sao_Paulo', p_scheduled_for))
       not between 1 and 5
     or timezone('America/Sao_Paulo', p_scheduled_for)::time <> time '06:00' then
    return 0;
  end if;
  if not exists (
    select 1
    from public.insight_runs run
    where run.id = p_run_id
      and run.organization_id = p_organization_id
  ) then
    raise exception 'Execucao de insights nao localizada para a organizacao.';
  end if;

  for assignment in
    select item.*,
      coalesce(
        nullif(record.person_name, ''),
        nullif(record.company_name, ''),
        'Lead sem nome'
      ) as lead_name
    from public.crm_lead_assignments item
    join public.crm_records record
      on record.id = item.crm_record_id
     and record.organization_id = item.organization_id
    where item.organization_id = p_organization_id
      and item.status in ('atribuida', 'aceita', 'em_atendimento')
    order by item.priority desc, item.due_at, item.id
  loop
    v_guidance := private.build_crm_assignment_guidance(
      assignment.crm_record_id, assignment.assignment_role
    );

    update public.crm_lead_assignments
    set guidance = v_guidance,
        guidance_generated_at = p_scheduled_for,
        updated_at = now()
    where id = assignment.id;

    v_insight_id := null;
    insert into public.insights (
      organization_id, run_id, area, title, summary, evidence, impact,
      recommendation, severity, priority, status, due_at, confidence_pct,
      responsible_user_id, related_view, related_entity_type,
      related_entity_id, created_at
    ) values (
      assignment.organization_id, p_run_id, 'vendas_crm_sdr',
      case when assignment.assignment_role = 'sdr'
        then 'Proxima abordagem SDR para ' else 'Proxima acao comercial para ' end ||
        assignment.lead_name,
      assignment.lead_name || ': ' || coalesce(
        v_guidance ->> 'objective', 'Revisar contexto e definir proxima acao.'
      ),
      jsonb_build_object(
        'kind', 'crm_assignment_daily',
        'model', 'crm-assignment-daily-v1-' || assignment.assignment_role,
        'crm_assignment_id', assignment.id,
        'assignment_role', assignment.assignment_role,
        'assignment_status', assignment.status,
        'recommended_channel', v_guidance ->> 'recommended_channel',
        'questions', coalesce(v_guidance -> 'questions', '[]'::jsonb),
        'generated_for', local_date,
        'requires_human_review', true,
        'no_external_delivery', true
      ),
      jsonb_build_object(
        'due_at', assignment.due_at,
        'priority', assignment.priority,
        'overdue', assignment.due_at < p_scheduled_for,
        'operational_scope', 'assigned_user_only'
      ),
      concat_ws(E'\n\n',
        coalesce(v_guidance ->> 'objective', ''),
        'Sugestao de abertura: ' || coalesce(
          v_guidance ->> 'opening_suggestion', ''
        ),
        'Confirme disponibilidade e condicoes antes do contato e registre o resultado no CRM.'
      ),
      case
        when assignment.due_at < p_scheduled_for then 'critical'
        when assignment.priority = 'urgente' then 'high'
        when assignment.priority = 'alta' then 'warning'
        else 'info'
      end,
      case
        when assignment.due_at < p_scheduled_for
          or assignment.priority = 'urgente' then 'urgent'
        when assignment.priority = 'alta' then 'high'
        else 'medium'
      end,
      'novo', assignment.due_at, 88,
      assignment.assigned_user_id, 'crm', 'crm_records',
      assignment.crm_record_id, p_scheduled_for
    ) on conflict do nothing
    returning id into v_insight_id;

    if v_insight_id is not null then
      created_count := created_count + 1;
    else
      select insight.id into v_insight_id
      from public.insights insight
      where insight.run_id = p_run_id
        and insight.responsible_user_id = assignment.assigned_user_id
        and insight.related_entity_type = 'crm_records'
        and insight.related_entity_id = assignment.crm_record_id
        and insight.evidence ->> 'model' =
          'crm-assignment-daily-v1-' || assignment.assignment_role
      limit 1;
    end if;

    insert into public.activity_notifications (
      organization_id, recipient_user_id, actor_user_id, activity_id,
      notification_type, title, message, metadata, dedupe_key
    ) values (
      assignment.organization_id, assignment.assigned_user_id,
      assignment.assigned_by, assignment.user_activity_id,
      'crm_assignment_daily_insight',
      'Insight diario para este atendimento',
      coalesce(v_guidance ->> 'objective', 'Revise o contexto e defina a proxima acao.'),
      jsonb_build_object(
        'crm_assignment_id', assignment.id,
        'crm_record_id', assignment.crm_record_id,
        'insight_id', v_insight_id,
        'guidance', v_guidance,
        'generated_for', local_date,
        'requires_human_review', true,
        'no_external_delivery', true
      ),
      'crm-assignment:daily-insight:' || assignment.id::text || ':' ||
        local_date::text
    ) on conflict (dedupe_key) where dedupe_key is not null do nothing;
    get diagnostics affected = row_count;

    if affected > 0 then
      insert into public.crm_lead_assignment_events (
        organization_id, assignment_id, event_type, new_status,
        actor_user_id, metadata, created_at
      ) values (
        assignment.organization_id, assignment.id, 'daily_guidance',
        assignment.status, null,
        jsonb_build_object('generated_for', local_date), p_scheduled_for
      );
    end if;
  end loop;

  return created_count;
end
$function$;

revoke all on function private.process_crm_assignment_daily_insights(
  uuid, uuid, timestamptz
) from public, anon, authenticated;

-- Mantem o mesmo entrypoint do cron de automacoes e acrescenta apenas o
-- monitoramento operacional das designacoes.
create or replace function private.process_evora_automations(
  p_organization_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  core_result jsonb;
  crm_result jsonb;
  assignment_result jsonb;
begin
  core_result := private.process_evora_core_automations(p_organization_id);
  crm_result := private.process_crm_automations(p_organization_id);
  assignment_result :=
    private.process_crm_assignment_monitoring(p_organization_id);

  return coalesce(core_result, '{}'::jsonb) || jsonb_build_object(
    'crm_automations', crm_result,
    'crm_assignment_monitoring', assignment_result
  );
end
$function$;

revoke all on function private.process_evora_automations(uuid)
  from public, anon, authenticated;

-- Preserva a rotina unica de segunda a sexta as 06:00 e conecta os insights
-- individuais depois da analise gerencial de cada organizacao habilitada.
create or replace function private.run_scheduled_insights(p_local_slot text)
returns integer
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_setting public.insight_settings%rowtype;
  v_scheduled_for timestamptz;
  v_run_id uuid;
  v_run_status text;
  v_count integer := 0;
begin
  if p_local_slot is distinct from '06:00' then
    raise exception 'Horario de execucao invalido.';
  end if;

  if extract(isodow from timezone('America/Sao_Paulo', now()))
       not between 1 and 5 then
    return 0;
  end if;

  for v_setting in
    select *
    from public.insight_settings setting
    where setting.enabled and p_local_slot = any(setting.run_times)
    order by setting.organization_id
  loop
    v_scheduled_for := (
      timezone(v_setting.timezone, now())::date + p_local_slot::time
    ) at time zone v_setting.timezone;

    v_run_id := private.run_insights_cycle(
      v_setting.organization_id,
      'scheduled:' || timezone(
        v_setting.timezone, v_scheduled_for
      )::date::text || ':' || p_local_slot,
      'scheduled', v_scheduled_for, null,
      v_scheduled_for - interval '30 days', v_scheduled_for
    );

    perform private.process_crm_assignment_daily_insights(
      v_setting.organization_id, v_run_id, v_scheduled_for
    );

    select run.status into v_run_status
    from public.insight_runs run
    where run.id = v_run_id;

    update public.insight_settings
    set next_run_at = private.next_insight_run(
        run_times, timezone,
        greatest(now(), v_scheduled_for) + interval '1 minute'
      ),
      updated_at = now()
    where organization_id = v_setting.organization_id;

    if v_run_status = 'completed' then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end
$function$;

revoke all on function private.run_scheduled_insights(text)
  from public, anon, authenticated;

-- Permissoes configuraveis. Defaults concedem a designacao e o monitoramento
-- apenas a administracao, diretoria e lideranca formal de CRM. O papel
-- comercial generico pode receber alcada individual sem herdar este poder.
insert into public.role_permissions (
  organization_id, role, permission_key, allowed, updated_by, updated_at
)
select organization.id, role_name.role, permission.permission_key,
  true, null, now()
from public.organizations organization
cross join (values
  ('admin'), ('diretoria'), ('gestor_crm')
) as role_name(role)
cross join (values
  ('crm.assign'), ('crm.monitor_team'),
  ('activities.assign'), ('activities.manage_team')
) as permission(permission_key)
where organization.active
on conflict (organization_id, role, permission_key) do nothing;

-- Atualiza a agenda para que a alcada configuravel substitua o antigo filtro
-- hardcoded por cargo, sem ampliar o acesso de usuarios comuns.
drop policy if exists user_activities_insert on public.user_activities;
create policy user_activities_insert
on public.user_activities
for insert
to authenticated
with check (
  public.is_org_member(organization_id)
  and exists (
    select 1
    from public.organization_members owner_member
    where owner_member.organization_id = user_activities.organization_id
      and owner_member.user_id = user_activities.owner_user_id
      and owner_member.active
  )
  and (
    owner_user_id = (select auth.uid())
    or public.has_app_permission(organization_id, 'activities.assign')
    or public.has_app_permission(organization_id, 'crm.assign')
  )
);

drop policy if exists user_activities_select on public.user_activities;
create policy user_activities_select
on public.user_activities
for select
to authenticated
using (
  public.is_org_member(organization_id)
  and (
    owner_user_id = (select auth.uid())
    or assigned_by = (select auth.uid())
    or (select auth.uid()) = any(watchers)
    or public.has_app_permission(organization_id, 'activities.manage_team')
    or public.has_app_permission(organization_id, 'crm.monitor_team')
  )
);

drop policy if exists user_activities_update on public.user_activities;
create policy user_activities_update
on public.user_activities
for update
to authenticated
using (
  public.is_org_member(organization_id)
  and (
    owner_user_id = (select auth.uid())
    or public.has_app_permission(organization_id, 'activities.manage_team')
    or public.has_app_permission(organization_id, 'crm.monitor_team')
  )
)
with check (
  public.is_org_member(organization_id)
  and exists (
    select 1
    from public.organization_members owner_member
    where owner_member.organization_id = user_activities.organization_id
      and owner_member.user_id = user_activities.owner_user_id
      and owner_member.active
  )
  and (
    owner_user_id = (select auth.uid())
    or public.has_app_permission(organization_id, 'activities.manage_team')
    or public.has_app_permission(organization_id, 'crm.monitor_team')
  )
);

drop policy if exists user_activities_delete on public.user_activities;
create policy user_activities_delete
on public.user_activities
for delete
to authenticated
using (
  public.is_org_member(organization_id)
  and (
    assigned_by = (select auth.uid())
    or public.has_app_permission(organization_id, 'activities.assign')
    or public.has_app_permission(organization_id, 'crm.assign')
  )
);

alter table public.crm_lead_assignments enable row level security;
alter table public.crm_lead_assignment_events enable row level security;

create policy crm_lead_assignments_select
on public.crm_lead_assignments
for select
to authenticated
using (
  public.is_org_member(organization_id)
  and (
    assigned_user_id = (select auth.uid())
    or assigned_by = (select auth.uid())
    or public.has_app_permission(organization_id, 'crm.assign')
    or public.has_app_permission(organization_id, 'crm.monitor_team')
  )
);

create policy crm_lead_assignment_events_select
on public.crm_lead_assignment_events
for select
to authenticated
using (
  public.is_org_member(organization_id)
  and exists (
    select 1
    from public.crm_lead_assignments assignment
    where assignment.id = crm_lead_assignment_events.assignment_id
      and assignment.organization_id = crm_lead_assignment_events.organization_id
      and (
        assignment.assigned_user_id = (select auth.uid())
        or assignment.assigned_by = (select auth.uid())
        or public.has_app_permission(
          assignment.organization_id, 'crm.assign'
        )
        or public.has_app_permission(
          assignment.organization_id, 'crm.monitor_team'
        )
      )
  )
);

-- O designado recebe apenas os insights CRM cujo responsavel e ele proprio.
-- A visao gerencial continua exigindo insights.view e, para CRM, crm.view.
drop policy if exists insights_select on public.insights;
create policy insights_select
on public.insights
for select
to authenticated
using (
  public.is_org_member(organization_id)
  and (
    (
      responsible_user_id = (select auth.uid())
      and area = 'vendas_crm_sdr'
      and coalesce(related_entity_type, '') in ('crm_record', 'crm_records')
    )
    or (
      public.has_app_permission(organization_id, 'insights.view')
      and (
        coalesce(related_entity_type, '') not in ('crm_record', 'crm_records')
        or public.has_app_permission(organization_id, 'crm.view')
      )
    )
  )
);

revoke all on table public.crm_lead_assignments
  from public, anon, authenticated;
revoke all on table public.crm_lead_assignment_events
  from public, anon, authenticated;
grant select on table public.crm_lead_assignments to authenticated;
grant select on table public.crm_lead_assignment_events to authenticated;
grant all on table public.crm_lead_assignments to service_role;
grant all on table public.crm_lead_assignment_events to service_role;

comment on function public.assign_crm_record(
  uuid, text, uuid, text, timestamptz, text
) is 'Designa SDR ou corretor de forma atomica, criando historico, agenda e tarefa CRM.';
comment on function public.set_crm_assignment_status(uuid, text) is
  'Registra aceite, inicio, conclusao, recusa ou cancelamento da designacao e sincroniza agenda/CRM.';
comment on function private.process_crm_assignment_monitoring(uuid) is
  'Gera somente alertas operacionais/SLA deduplicados no ciclo de automacoes.';
comment on function private.process_crm_assignment_daily_insights(
  uuid, uuid, timestamptz
) is 'Entrega um roteiro personalizado por designacao uma vez por dia util, na rotina das 06:00, sem envio externo.';
