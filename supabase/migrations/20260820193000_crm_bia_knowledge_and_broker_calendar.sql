begin;

create table if not exists public.crm_ai_knowledge_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  title text not null,
  description text,
  source_type text not null,
  file_name text not null,
  mime_type text not null,
  size_bytes bigint not null default 0,
  openai_file_id text,
  vector_store_id text not null,
  status text not null default 'processing',
  content_preview text,
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint crm_ai_knowledge_documents_title_check
    check (char_length(btrim(title)) between 1 and 180),
  constraint crm_ai_knowledge_documents_description_check
    check (description is null or char_length(description) <= 1000),
  constraint crm_ai_knowledge_documents_source_type_check
    check (source_type in ('file', 'text')),
  constraint crm_ai_knowledge_documents_size_check
    check (size_bytes between 0 and 10485760),
  constraint crm_ai_knowledge_documents_file_id_check
    check (openai_file_id is null or openai_file_id ~ '^file[-_][A-Za-z0-9_-]{6,}$'),
  constraint crm_ai_knowledge_documents_vector_store_check
    check (vector_store_id ~ '^vs_[A-Za-z0-9_-]{6,}$'),
  constraint crm_ai_knowledge_documents_status_check
    check (status in ('processing', 'ready', 'failed', 'deleting')),
  constraint crm_ai_knowledge_documents_preview_check
    check (content_preview is null or char_length(content_preview) <= 1000),
  constraint crm_ai_knowledge_documents_error_check
    check (error_message is null or char_length(error_message) <= 1000),
  constraint crm_ai_knowledge_documents_metadata_check
    check (jsonb_typeof(metadata) = 'object')
);

create unique index if not exists crm_ai_knowledge_documents_openai_file_uq
  on public.crm_ai_knowledge_documents (organization_id, openai_file_id)
  where openai_file_id is not null;

create index if not exists crm_ai_knowledge_documents_org_status_idx
  on public.crm_ai_knowledge_documents (organization_id, status, created_at desc);

create index if not exists user_activities_owner_calendar_idx
  on public.user_activities (organization_id, owner_user_id, starts_at)
  where board_status <> 'concluida';

create index if not exists crm_actions_assignee_calendar_idx
  on public.crm_actions (organization_id, assigned_to, scheduled_at)
  where action_status = 'pendente' and scheduled_at is not null;

alter table public.crm_ai_knowledge_documents enable row level security;

drop policy if exists crm_ai_knowledge_documents_select on public.crm_ai_knowledge_documents;
create policy crm_ai_knowledge_documents_select
  on public.crm_ai_knowledge_documents
  for select
  to authenticated
  using (
    public.is_org_member(organization_id)
    and public.has_app_permission(organization_id, 'crm.integrations.manage')
  );

drop policy if exists crm_ai_knowledge_documents_insert on public.crm_ai_knowledge_documents;
create policy crm_ai_knowledge_documents_insert
  on public.crm_ai_knowledge_documents
  for insert
  to authenticated
  with check (
    public.is_org_member(organization_id)
    and public.has_app_permission(organization_id, 'crm.integrations.manage')
    and created_by = (select auth.uid())
  );

drop policy if exists crm_ai_knowledge_documents_update on public.crm_ai_knowledge_documents;
create policy crm_ai_knowledge_documents_update
  on public.crm_ai_knowledge_documents
  for update
  to authenticated
  using (
    public.is_org_member(organization_id)
    and public.has_app_permission(organization_id, 'crm.integrations.manage')
  )
  with check (
    public.is_org_member(organization_id)
    and public.has_app_permission(organization_id, 'crm.integrations.manage')
  );

drop policy if exists crm_ai_knowledge_documents_delete on public.crm_ai_knowledge_documents;
create policy crm_ai_knowledge_documents_delete
  on public.crm_ai_knowledge_documents
  for delete
  to authenticated
  using (
    public.is_org_member(organization_id)
    and public.has_app_permission(organization_id, 'crm.integrations.manage')
  );

create or replace function public.get_crm_ai_knowledge_runtime_credentials(
  p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  result_value jsonb;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'RPC restrita ao runtime da base de conhecimento da Bia.'
      using errcode = '42501';
  end if;

  select jsonb_build_object(
    'organization_id', runtime.organization_id,
    'enabled', runtime.enabled,
    'api_key', secret.decrypted_secret,
    'api_key_version', runtime.api_key_version,
    'knowledge_vector_store_id', runtime.knowledge_vector_store_id,
    'updated_at', runtime.updated_at
  )
  into result_value
  from crm_private.ai_runtime_settings runtime
  left join vault.decrypted_secrets secret
    on secret.id = runtime.openai_api_key_vault_id
  where runtime.organization_id = p_organization_id;

  return coalesce(
    result_value,
    jsonb_build_object(
      'organization_id', p_organization_id,
      'enabled', false,
      'api_key', null,
      'api_key_version', 0,
      'knowledge_vector_store_id', null,
      'updated_at', null
    )
  );
end
$function$;

revoke all on function public.get_crm_ai_knowledge_runtime_credentials(uuid)
  from public, anon, authenticated;
grant execute on function public.get_crm_ai_knowledge_runtime_credentials(uuid)
  to service_role;

create or replace function public.set_crm_ai_knowledge_vector_store(
  p_organization_id uuid,
  p_vector_store_id text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  normalized_id text := nullif(btrim(p_vector_store_id), '');
  affected integer;
begin
  if coalesce(auth.jwt() ->> 'role', '') <> 'service_role' then
    raise exception 'RPC restrita ao runtime da base de conhecimento da Bia.'
      using errcode = '42501';
  end if;

  if normalized_id is not null
     and normalized_id !~ '^vs_[A-Za-z0-9_-]{6,}$' then
    raise exception 'Vector store inválido.';
  end if;

  update crm_private.ai_runtime_settings
  set knowledge_vector_store_id = normalized_id,
      updated_at = now()
  where organization_id = p_organization_id;

  get diagnostics affected = row_count;
  if affected <> 1 then
    raise exception 'Configure a chave OpenAI da Bia antes da base de conhecimento.';
  end if;

  return jsonb_build_object(
    'organization_id', p_organization_id,
    'knowledge_vector_store_configured', normalized_id is not null,
    'updated_at', now()
  );
end
$function$;

revoke all on function public.set_crm_ai_knowledge_vector_store(uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_crm_ai_knowledge_vector_store(uuid, text)
  to service_role;

create or replace function public.get_crm_broker_availability(
  p_organization_id uuid,
  p_broker_user_id uuid,
  p_from timestamptz,
  p_to timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := auth.uid();
  busy_value jsonb;
begin
  if actor is null then
    raise exception 'Autenticação obrigatória.' using errcode = '42501';
  end if;
  if not public.is_org_member(p_organization_id) then
    raise exception 'Organização não autorizada.' using errcode = '42501';
  end if;
  if p_from is null or p_to is null or p_to <= p_from
     or p_to - p_from > interval '31 days' then
    raise exception 'Período de disponibilidade inválido.';
  end if;

  if not exists (
    select 1
    from public.organization_members member
    where member.organization_id = p_organization_id
      and member.user_id = p_broker_user_id
      and member.active
      and (
        lower(member.role) = 'corretor'
        or exists (
          select 1
          from public.crm_team_members team_member
          join public.crm_teams team
            on team.id = team_member.team_id
           and team.organization_id = team_member.organization_id
          where team_member.organization_id = p_organization_id
            and team_member.user_id = member.user_id
            and team_member.active
            and team.active
            and (
              lower(team.team_type) in ('corretor', 'corretores', 'vendas', 'comercial')
              or lower(team_member.team_role) like '%corretor%'
            )
        )
      )
  ) then
    raise exception 'Corretor não elegível para esta organização.';
  end if;

  with activity_intervals as (
    select
      activity.id::text as source_id,
      'user_activity'::text as source_type,
      activity.starts_at as starts_at,
      case
        when activity.due_at is not null and activity.due_at > activity.starts_at
          then activity.due_at
        else activity.starts_at
          + make_interval(mins => greatest(coalesce(activity.estimated_minutes, 60), 15))
      end as ends_at,
      case
        when activity.activity_type = 'visita' then 'Visita agendada'
        when activity.activity_type = 'reuniao' then 'Reunião'
        else 'Indisponível'
      end as label,
      activity.activity_type as kind
    from public.user_activities activity
    where activity.organization_id = p_organization_id
      and activity.owner_user_id = p_broker_user_id
      and activity.starts_at is not null
      and activity.board_status <> 'concluida'
      and activity.status <> 'cancelada'
      and (
        activity.activity_type in (
          'visita', 'reuniao', 'indisponibilidade', 'bloqueio_agenda'
        )
        or activity.tags && array['agenda-bloqueio', 'indisponibilidade']::text[]
      )
  ),
  action_intervals as (
    select
      action.id::text as source_id,
      'crm_action'::text as source_type,
      action.scheduled_at as starts_at,
      action.scheduled_at
        + make_interval(mins => greatest(coalesce(action.duration_minutes, 60), 15))
        as ends_at,
      case
        when action.action_type = 'visita' or action.outcome = 'visita_agendada'
          then 'Visita agendada'
        else 'Reunião'
      end as label,
      coalesce(action.action_type, 'compromisso') as kind
    from public.crm_actions action
    where action.organization_id = p_organization_id
      and action.assigned_to = p_broker_user_id
      and action.scheduled_at is not null
      and action.action_status = 'pendente'
      and (
        action.action_type in ('visita', 'reuniao')
        or action.outcome = 'visita_agendada'
      )
      and not (action.metadata ? 'calendar_user_activity_id')
  ),
  combined as (
    select * from activity_intervals
    union all
    select * from action_intervals
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'sourceId', source_id,
        'sourceType', source_type,
        'startsAt', starts_at,
        'endsAt', ends_at,
        'label', label,
        'kind', kind
      )
      order by starts_at, ends_at
    ),
    '[]'::jsonb
  )
  into busy_value
  from combined
  where starts_at < p_to
    and ends_at > p_from;

  return jsonb_build_object(
    'brokerUserId', p_broker_user_id,
    'timezone', 'America/Sao_Paulo',
    'workdayStart', '08:00',
    'workdayEnd', '18:00',
    'slotMinutes', 30,
    'busy', busy_value,
    'generatedAt', now()
  );
end
$function$;

revoke all on function public.get_crm_broker_availability(
  uuid, uuid, timestamptz, timestamptz
) from public, anon;
grant execute on function public.get_crm_broker_availability(
  uuid, uuid, timestamptz, timestamptz
) to authenticated;

create or replace function public.create_crm_activity_with_broker(
  p_crm_record_id uuid,
  p_action_type text,
  p_channel text,
  p_subject text,
  p_scheduled_at timestamptz,
  p_completed boolean,
  p_outcome text,
  p_duration_minutes integer,
  p_assigned_to uuid,
  p_broker_user_id uuid,
  p_notes text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := auth.uid();
  lead public.crm_records%rowtype;
  normalized_action_type text := lower(btrim(coalesce(p_action_type, '')));
  normalized_channel text := lower(btrim(coalesce(p_channel, '')));
  normalized_subject text := btrim(coalesce(p_subject, ''));
  normalized_outcome text := nullif(lower(btrim(coalesce(p_outcome, ''))), '');
  normalized_notes text := nullif(btrim(coalesce(p_notes, '')), '');
  effective_completed boolean := coalesce(p_completed, false);
  effective_scheduled_at timestamptz;
  effective_duration integer;
  effective_assigned_to uuid;
  effective_broker uuid;
  appointment boolean;
  appointment_ends_at timestamptz;
  conflict_exists boolean := false;
  assignment_id uuid;
  action_id uuid;
  calendar_activity_id uuid;
  assignment_due_at timestamptz;
begin
  if actor is null then
    raise exception 'Autenticação obrigatória.' using errcode = '42501';
  end if;

  select record.*
  into lead
  from public.crm_records record
  where record.id = p_crm_record_id
  for update;

  if not found then
    raise exception 'Lead não localizado.';
  end if;
  if not public.is_org_member(lead.organization_id) then
    raise exception 'Organização não autorizada.' using errcode = '42501';
  end if;
  if lead.record_status = 'arquivada' then
    raise exception 'O lead está arquivado e não pode receber novas atividades.';
  end if;

  if normalized_action_type not in (
    'contato', 'ligacao', 'whatsapp', 'email',
    'reuniao', 'visita', 'proposta', 'tarefa'
  ) then
    raise exception 'Tipo de atividade inválido.';
  end if;
  if normalized_channel not in (
    'whatsapp', 'telefone', 'email', 'presencial',
    'video', 'instagram', 'interno'
  ) then
    raise exception 'Canal de atividade inválido.';
  end if;
  if char_length(normalized_subject) not between 1 and 300 then
    raise exception 'Informe um assunto com até 300 caracteres.';
  end if;
  if normalized_notes is not null and char_length(normalized_notes) > 8000 then
    raise exception 'As observações excedem o limite permitido.';
  end if;
  if p_duration_minutes is not null
     and (p_duration_minutes < 0 or p_duration_minutes > 480) then
    raise exception 'A duração deve estar entre 0 e 480 minutos.';
  end if;

  effective_assigned_to := coalesce(p_assigned_to, actor);
  if not exists (
    select 1
    from public.organization_members member
    where member.organization_id = lead.organization_id
      and member.user_id = effective_assigned_to
      and member.active
  ) then
    raise exception 'O responsável precisa estar ativo na organização.';
  end if;

  effective_broker := coalesce(p_broker_user_id, lead.broker_user_id);
  if effective_broker is not null and not exists (
    select 1
    from public.organization_members member
    where member.organization_id = lead.organization_id
      and member.user_id = effective_broker
      and member.active
      and (
        lower(member.role) = 'corretor'
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
              lower(team.team_type) in ('corretor', 'corretores', 'vendas', 'comercial')
              or lower(team_member.team_role) like '%corretor%'
            )
        )
      )
  ) then
    raise exception 'O corretor selecionado não está elegível para atendimento.';
  end if;

  appointment :=
    normalized_action_type in ('visita', 'reuniao')
    or normalized_outcome = 'visita_agendada';

  if effective_completed then
    effective_scheduled_at := now();
  else
    effective_scheduled_at := p_scheduled_at;
  end if;

  if appointment and not effective_completed and effective_scheduled_at is null then
    raise exception 'Defina a data e o horário da visita ou reunião.';
  end if;
  if appointment and effective_broker is null then
    raise exception 'Atribua um corretor antes de agendar a visita ou reunião.';
  end if;

  effective_duration := nullif(coalesce(p_duration_minutes, 0), 0);
  if appointment then
    effective_duration := greatest(coalesce(effective_duration, 60), 15);
  end if;

  if appointment and not effective_completed then
    if effective_scheduled_at <= now() + interval '15 minutes' then
      raise exception 'O agendamento precisa respeitar antecedência mínima de 15 minutos.';
    end if;

    appointment_ends_at :=
      effective_scheduled_at + make_interval(mins => effective_duration);

    perform pg_advisory_xact_lock(
      hashtextextended(
        lead.organization_id::text || ':' || effective_broker::text,
        0
      )
    );

    select exists (
      select 1
      from (
        select
          activity.starts_at as starts_at,
          case
            when activity.due_at is not null
                 and activity.due_at > activity.starts_at
              then activity.due_at
            else activity.starts_at
              + make_interval(
                  mins => greatest(coalesce(activity.estimated_minutes, 60), 15)
                )
          end as ends_at
        from public.user_activities activity
        where activity.organization_id = lead.organization_id
          and activity.owner_user_id = effective_broker
          and activity.starts_at is not null
          and activity.board_status <> 'concluida'
          and activity.status <> 'cancelada'
          and (
            activity.activity_type in (
              'visita', 'reuniao', 'indisponibilidade', 'bloqueio_agenda'
            )
            or activity.tags && array['agenda-bloqueio', 'indisponibilidade']::text[]
          )

        union all

        select
          action.scheduled_at,
          action.scheduled_at
            + make_interval(
                mins => greatest(coalesce(action.duration_minutes, 60), 15)
              )
        from public.crm_actions action
        where action.organization_id = lead.organization_id
          and action.assigned_to = effective_broker
          and action.scheduled_at is not null
          and action.action_status = 'pendente'
          and (
            action.action_type in ('visita', 'reuniao')
            or action.outcome = 'visita_agendada'
          )
          and not (action.metadata ? 'calendar_user_activity_id')
      ) occupied
      where occupied.starts_at < appointment_ends_at
        and occupied.ends_at > effective_scheduled_at
    )
    into conflict_exists;

    if conflict_exists then
      raise exception 'O corretor já possui compromisso neste horário. Selecione outro intervalo.';
    end if;
  end if;

  if p_broker_user_id is not null
     and p_broker_user_id is distinct from lead.broker_user_id then
    if not public.has_app_permission(lead.organization_id, 'crm.assign') then
      raise exception 'Seu perfil não possui permissão para atribuir ou substituir o corretor.'
        using errcode = '42501';
    end if;

    assignment_due_at := greatest(
      now() + interval '5 minutes',
      least(
        coalesce(effective_scheduled_at, now() + interval '24 hours'),
        now() + interval '24 hours'
      )
    );

    assignment_id := private.create_crm_assignment(
      lead.id,
      'corretor',
      p_broker_user_id,
      case when appointment then 'alta' else 'normal' end,
      assignment_due_at,
      case
        when appointment and effective_scheduled_at is not null
          then 'Atendimento atribuído durante o agendamento de visita para '
            || to_char(effective_scheduled_at at time zone 'America/Sao_Paulo',
                       'DD/MM/YYYY HH24:MI') || '.'
        else 'Atendimento atribuído pela atividade comercial.'
      end,
      actor,
      'manual',
      true
    );
  end if;

  insert into public.crm_actions (
    organization_id,
    crm_record_id,
    action_type,
    subject,
    scheduled_at,
    completed_at,
    action_status,
    notes,
    created_by,
    channel,
    outcome,
    duration_minutes,
    assigned_to,
    metadata
  ) values (
    lead.organization_id,
    lead.id,
    normalized_action_type,
    normalized_subject,
    effective_scheduled_at,
    case when effective_completed then now() else null end,
    case when effective_completed then 'concluida' else 'pendente' end,
    normalized_notes,
    actor,
    normalized_channel,
    normalized_outcome,
    effective_duration,
    effective_assigned_to,
    jsonb_build_object(
      'materials_supported', true,
      'external_delivery_handoff', false,
      'broker_user_id', effective_broker,
      'broker_assignment_id', assignment_id,
      'calendar_managed', appointment and not effective_completed
    )
  )
  returning id into action_id;

  if appointment and not effective_completed then
    insert into public.user_activities (
      organization_id,
      owner_user_id,
      assigned_by,
      updated_by,
      title,
      description,
      activity_type,
      status,
      board_status,
      priority,
      starts_at,
      due_at,
      related_type,
      related_id,
      project_id,
      reminders,
      checklist,
      tags,
      estimated_minutes,
      watchers,
      progress_percent
    ) values (
      lead.organization_id,
      effective_broker,
      actor,
      actor,
      case when normalized_action_type = 'reuniao'
        then 'Reunião com '
        else 'Visita com '
      end || coalesce(nullif(lead.person_name, ''), 'lead'),
      normalized_notes,
      case when normalized_action_type = 'reuniao'
        then 'reuniao'
        else 'visita'
      end,
      'pendente',
      'backlog',
      'alta',
      effective_scheduled_at,
      appointment_ends_at,
      'crm_actions',
      action_id,
      lead.project_id,
      jsonb_build_array(
        jsonb_build_object('offset_minutes', 60),
        jsonb_build_object('offset_minutes', 15)
      ),
      jsonb_build_array(
        jsonb_build_object(
          'label', 'Confirmar presença e orientações com o cliente',
          'done', false
        ),
        jsonb_build_object(
          'label', 'Registrar o resultado no CRM',
          'done', false
        )
      ),
      array['crm', 'agenda-bloqueio', 'corretor',
        case when normalized_action_type = 'reuniao' then 'reuniao' else 'visita' end
      ]::text[],
      effective_duration,
      array_remove(array[actor, effective_assigned_to]::uuid[], null),
      0
    )
    returning id into calendar_activity_id;

    update public.crm_actions
    set metadata = metadata || jsonb_build_object(
      'calendar_user_activity_id', calendar_activity_id
    )
    where id = action_id;
  end if;

  update public.crm_records
  set broker_user_id = coalesce(effective_broker, broker_user_id),
      next_action_at = case
        when not effective_completed and effective_scheduled_at is not null
          then least(
            coalesce(next_action_at, effective_scheduled_at),
            effective_scheduled_at
          )
        else next_action_at
      end,
      last_contact_at = case
        when effective_completed then now()
        else last_contact_at
      end,
      first_response_at = case
        when effective_completed then coalesce(first_response_at, now())
        else first_response_at
      end,
      attempts = case
        when effective_completed then coalesce(attempts, 0) + 1
        else attempts
      end,
      stagnation_at = case
        when effective_completed then now()
        else stagnation_at
      end,
      updated_at = now()
  where id = lead.id;

  return jsonb_build_object(
    'action_id', action_id,
    'broker_user_id', effective_broker,
    'broker_assignment_id', assignment_id,
    'calendar_user_activity_id', calendar_activity_id,
    'completed', effective_completed
  );
end
$function$;

revoke all on function public.create_crm_activity_with_broker(
  uuid, text, text, text, timestamptz, boolean,
  text, integer, uuid, uuid, text
) from public, anon;
grant execute on function public.create_crm_activity_with_broker(
  uuid, text, text, text, timestamptz, boolean,
  text, integer, uuid, uuid, text
) to authenticated;

comment on table public.crm_ai_knowledge_documents is
  'Catálogo tenant-scoped dos documentos indexados no vector store da Bia. O conteúdo integral permanece no provedor de IA e não é exposto ao navegador.';
comment on function public.get_crm_broker_availability(
  uuid, uuid, timestamptz, timestamptz
) is
  'Retorna somente intervalos ocupados e rótulos sanitizados da agenda do corretor.';
comment on function public.create_crm_activity_with_broker(
  uuid, text, text, text, timestamptz, boolean,
  text, integer, uuid, uuid, text
) is
  'Registra atividade comercial, atribuição formal de corretor e bloqueio transacional da agenda quando aplicável.';

commit;
