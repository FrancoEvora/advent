create table if not exists crm_private.bia_strategy_queue (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  crm_record_id uuid not null references public.crm_records(id) on delete cascade,
  queued_by uuid not null references auth.users(id) on delete restrict,
  recommended_settings_id uuid references crm_private.bia_campaign_outreach_settings(id) on delete set null,
  dispatched_settings_id uuid references crm_private.bia_campaign_outreach_settings(id) on delete set null,
  campaign_id uuid references crm_private.bia_bulk_campaigns(id) on delete set null,
  status text not null default 'staged'
    check (status in ('staged','dispatched','cancelled')),
  last_error text,
  queued_at timestamptz not null default now(),
  dispatched_at timestamptz,
  updated_at timestamptz not null default now()
);

alter table crm_private.bia_strategy_queue enable row level security;
revoke all on table crm_private.bia_strategy_queue from public, anon, authenticated;

create unique index if not exists bia_strategy_queue_staged_unique
  on crm_private.bia_strategy_queue(organization_id, crm_record_id)
  where status='staged';

create index if not exists bia_strategy_queue_org_status_created
  on crm_private.bia_strategy_queue(organization_id, status, queued_at desc);

create index if not exists bia_strategy_queue_record
  on crm_private.bia_strategy_queue(crm_record_id);

create or replace function public.bia_strategy_enqueue_lead(
  p_organization_id uuid,
  p_crm_record_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  actor uuid := auth.uid();
  lead public.crm_records%rowtype;
  cfg crm_private.bia_campaign_outreach_settings%rowtype;
  v_settings_id uuid;
  v_reason text := 'BIA_CAMPAIGN_DISABLED';
  existing crm_private.bia_strategy_queue%rowtype;
  queued crm_private.bia_strategy_queue%rowtype;
begin
  if actor is null or not exists (
    select 1
    from public.organization_members member
    join public.organizations organization
      on organization.id=member.organization_id
    where member.user_id=actor
      and member.organization_id=p_organization_id
      and member.active
      and lower(member.role)='admin'
      and organization.active
  ) then
    raise exception 'BIA_QUEUE_FORBIDDEN' using errcode='42501';
  end if;

  select record.* into lead
  from public.crm_records record
  where record.id=p_crm_record_id
    and record.organization_id=p_organization_id;

  if not found or lead.record_status<>'aberta' then
    return jsonb_build_object('ok',false,'reason','BIA_CAMPAIGN_LEAD_INACTIVE');
  end if;

  select * into existing
  from crm_private.bia_strategy_queue q
  where q.organization_id=p_organization_id
    and q.crm_record_id=p_crm_record_id
    and q.status='staged'
  order by q.queued_at desc
  limit 1;

  if existing.id is not null then
    return jsonb_build_object(
      'ok',true,
      'queued',true,
      'alreadyQueued',true,
      'id',existing.id,
      'settingsId',existing.recommended_settings_id
    );
  end if;

  for cfg in
    select setting.*
    from crm_private.bia_campaign_outreach_settings setting
    where setting.organization_id=p_organization_id
      and setting.project_id=lead.project_id
      and setting.enabled
    order by setting.created_at desc
  loop
    v_reason := crm_private.bia_bulk_candidate_reason(cfg.id, lead.id);
    if v_reason is null then
      v_settings_id := cfg.id;
      exit;
    end if;
  end loop;

  if v_settings_id is null then
    return jsonb_build_object('ok',false,'reason',coalesce(v_reason,'BIA_CAMPAIGN_DISABLED'));
  end if;

  insert into crm_private.bia_strategy_queue(
    organization_id,
    crm_record_id,
    queued_by,
    recommended_settings_id,
    status,
    last_error
  )
  values(
    p_organization_id,
    p_crm_record_id,
    actor,
    v_settings_id,
    'staged',
    null
  )
  returning * into queued;

  return jsonb_build_object(
    'ok',true,
    'queued',true,
    'alreadyQueued',false,
    'id',queued.id,
    'settingsId',queued.recommended_settings_id,
    'queuedAt',queued.queued_at
  );
end
$function$;

revoke all on function public.bia_strategy_enqueue_lead(uuid,uuid)
  from public, anon;
grant execute on function public.bia_strategy_enqueue_lead(uuid,uuid)
  to authenticated;

create or replace function public.bia_strategy_queue_admin(
  p_organization_id uuid,
  p_action text,
  p_args jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  actor uuid := auth.uid();
  cfg crm_private.bia_campaign_outreach_settings%rowtype;
  v_settings_id uuid;
  v_ids uuid[];
  v_selected integer := 0;
  v_eligible integer := 0;
  v_blocked integer := 0;
  v_campaign_id uuid;
  v_campaign_name text;
  result jsonb;
begin
  if actor is null or not exists (
    select 1
    from public.organization_members member
    join public.organizations organization
      on organization.id=member.organization_id
    where member.user_id=actor
      and member.organization_id=p_organization_id
      and member.active
      and lower(member.role)='admin'
      and organization.active
  ) then
    raise exception 'BIA_QUEUE_FORBIDDEN' using errcode='42501';
  end if;

  if p_action='overview' then
    select jsonb_build_object(
      'channel',
        coalesce((
          select jsonb_build_object(
            'enabled',channel.enabled,
            'verified',channel.webhook_verified_at is not null,
            'phone',channel.display_phone_number
          )
          from crm_private.bia_whatsapp_channels channel
          where channel.organization_id=p_organization_id
          limit 1
        ), '{}'::jsonb),
      'settings',
        coalesce((
          select jsonb_agg(
            jsonb_build_object(
              'id',setting.id,
              'projectId',setting.project_id,
              'templateName',setting.template_name,
              'name',coalesce(setting.campaign_context->>'name',setting.template_name),
              'openingIntent',setting.campaign_context->>'openingIntent',
              'enabled',setting.enabled
            )
            order by setting.created_at desc
          )
          from crm_private.bia_campaign_outreach_settings setting
          where setting.organization_id=p_organization_id
            and setting.enabled
        ), '[]'::jsonb),
      'counts',
        jsonb_build_object(
          'staged',(select count(*) from crm_private.bia_strategy_queue q where q.organization_id=p_organization_id and q.status='staged'),
          'dispatched',(select count(*) from crm_private.bia_strategy_queue q where q.organization_id=p_organization_id and q.status='dispatched'),
          'cancelled',(select count(*) from crm_private.bia_strategy_queue q where q.organization_id=p_organization_id and q.status='cancelled'),
          'alerts',(select count(*) from crm_private.bia_strategy_queue q where q.organization_id=p_organization_id and q.status='staged' and q.last_error is not null)
        ),
      'items',
        coalesce((
          select jsonb_agg(item order by
            case item->>'status' when 'staged' then 0 when 'dispatched' then 1 else 2 end,
            item->>'queuedAt' desc
          )
          from (
            select jsonb_build_object(
              'id',q.id,
              'crmRecordId',q.crm_record_id,
              'name',coalesce(nullif(trim(r.person_name),''),'Lead sem nome'),
              'phone',r.phone,
              'projectId',r.project_id,
              'projectName',p.name,
              'source',coalesce(r.utm_campaign,r.source,r.source_channel,'Origem não informada'),
              'temperature',r.temperature,
              'score',coalesce(r.lead_score,0),
              'status',q.status,
              'lastError',q.last_error,
              'recommendedSettingsId',q.recommended_settings_id,
              'dispatchedSettingsId',q.dispatched_settings_id,
              'campaignId',q.campaign_id,
              'queuedAt',q.queued_at,
              'dispatchedAt',q.dispatched_at
            ) item
            from crm_private.bia_strategy_queue q
            join public.crm_records r
              on r.id=q.crm_record_id
             and r.organization_id=q.organization_id
            left join public.projects p
              on p.id=r.project_id
             and p.organization_id=q.organization_id
            where q.organization_id=p_organization_id
            order by
              case q.status when 'staged' then 0 when 'dispatched' then 1 else 2 end,
              q.queued_at desc
            limit 1000
          ) rows
        ), '[]'::jsonb)
    ) into result;
    return result;
  end if;

  if p_action='cancel' then
    if jsonb_typeof(p_args->'queueIds')<>'array' then
      raise exception 'BIA_QUEUE_SELECTION_INVALID';
    end if;
    begin
      select array_agg(distinct value::uuid)
      into v_ids
      from jsonb_array_elements_text(p_args->'queueIds');
    exception when others then
      raise exception 'BIA_QUEUE_SELECTION_INVALID';
    end;
    if coalesce(cardinality(v_ids),0)=0 or cardinality(v_ids)>1000 then
      raise exception 'BIA_QUEUE_SELECTION_INVALID';
    end if;
    update crm_private.bia_strategy_queue q
    set status='cancelled',updated_at=now()
    where q.organization_id=p_organization_id
      and q.status='staged'
      and q.id=any(v_ids);
    return jsonb_build_object('ok',true,'cancelled',found);
  end if;

  if p_action<>'fire' then
    raise exception 'BIA_QUEUE_ACTION_INVALID';
  end if;

  begin
    v_settings_id := (p_args->>'settingsId')::uuid;
  exception when others then
    raise exception 'BIA_QUEUE_SETTINGS_REQUIRED';
  end;

  select * into cfg
  from crm_private.bia_campaign_outreach_settings setting
  where setting.id=v_settings_id
    and setting.organization_id=p_organization_id
    and setting.enabled;

  if cfg.id is null then
    raise exception 'BIA_QUEUE_SETTINGS_REQUIRED';
  end if;

  if jsonb_typeof(p_args->'queueIds')<>'array' then
    raise exception 'BIA_QUEUE_SELECTION_INVALID';
  end if;

  begin
    select array_agg(distinct value::uuid)
    into v_ids
    from jsonb_array_elements_text(p_args->'queueIds');
  exception when others then
    raise exception 'BIA_QUEUE_SELECTION_INVALID';
  end;

  if coalesce(cardinality(v_ids),0)=0 or cardinality(v_ids)>1000 then
    raise exception 'BIA_QUEUE_SELECTION_INVALID';
  end if;

  with classified as (
    select
      q.id as queue_id,
      r.id as crm_record_id,
      r.project_id,
      case
        when r.project_id is distinct from cfg.project_id
          then 'BIA_TEMPLATE_PROJECT_MISMATCH'
        else crm_private.bia_bulk_candidate_reason(cfg.id,r.id)
      end as reason
    from crm_private.bia_strategy_queue q
    join public.crm_records r
      on r.id=q.crm_record_id
     and r.organization_id=q.organization_id
    where q.organization_id=p_organization_id
      and q.status='staged'
      and q.id=any(v_ids)
  )
  select
    count(*),
    count(*) filter(where reason is null),
    count(*) filter(where reason is not null)
  into v_selected,v_eligible,v_blocked
  from classified;

  if v_selected=0 then
    raise exception 'BIA_QUEUE_SELECTION_INVALID';
  end if;

  update crm_private.bia_strategy_queue q
  set last_error=classified.reason,
      updated_at=now()
  from (
    select
      q2.id as queue_id,
      case
        when r.project_id is distinct from cfg.project_id
          then 'BIA_TEMPLATE_PROJECT_MISMATCH'
        else crm_private.bia_bulk_candidate_reason(cfg.id,r.id)
      end as reason
    from crm_private.bia_strategy_queue q2
    join public.crm_records r
      on r.id=q2.crm_record_id
     and r.organization_id=q2.organization_id
    where q2.organization_id=p_organization_id
      and q2.status='staged'
      and q2.id=any(v_ids)
  ) classified
  where q.id=classified.queue_id
    and classified.reason is not null;

  if v_eligible=0 then
    return jsonb_build_object(
      'ok',false,
      'selected',v_selected,
      'eligible',0,
      'blocked',v_blocked,
      'reason','BIA_QUEUE_NO_ELIGIBLE_RECIPIENTS'
    );
  end if;

  v_campaign_name := left(
    coalesce(cfg.campaign_context->>'name',cfg.template_name)
      || ' · Fila IA · '
      || to_char(now() at time zone 'America/Sao_Paulo','DD/MM HH24:MI'),
    120
  );

  insert into crm_private.bia_bulk_campaigns(
    organization_id,
    settings_id,
    created_by,
    name,
    status,
    starts_at,
    pace_per_minute,
    only_unserved,
    total_count,
    eligible_count,
    blocked_count
  )
  values(
    p_organization_id,
    cfg.id,
    actor,
    v_campaign_name,
    'scheduled',
    now(),
    3,
    false,
    v_selected,
    v_eligible,
    v_blocked
  )
  returning id into v_campaign_id;

  with eligible as (
    select
      q.id as queue_id,
      r.id as crm_record_id,
      r.created_at,
      case
        when length(regexp_replace(coalesce(r.phone,''),'[^0-9]','','g')) in(10,11)
          then '55'||regexp_replace(coalesce(r.phone,''),'[^0-9]','','g')
        else regexp_replace(coalesce(r.phone,''),'[^0-9]','','g')
      end as normalized_phone,
      coalesce(nullif(trim(r.person_name),''),'tudo bem') as recipient_name,
      crm_private.bia_bulk_consent_for_record(cfg.id,r.id) as consent
    from crm_private.bia_strategy_queue q
    join public.crm_records r
      on r.id=q.crm_record_id
     and r.organization_id=q.organization_id
    where q.organization_id=p_organization_id
      and q.status='staged'
      and q.id=any(v_ids)
      and r.project_id=cfg.project_id
      and crm_private.bia_bulk_candidate_reason(cfg.id,r.id) is null
  )
  insert into crm_private.bia_bulk_campaign_recipients(
    campaign_id,
    crm_record_id,
    phone,
    recipient_name,
    consent,
    eligibility_status,
    block_reason
  )
  select
    v_campaign_id,
    eligible.crm_record_id,
    eligible.normalized_phone,
    eligible.recipient_name,
    coalesce(eligible.consent,'{}'::jsonb),
    'eligible',
    null
  from eligible
  order by eligible.created_at,eligible.crm_record_id;

  with ranked as (
    select
      recipient.id,
      row_number() over(order by record.created_at,recipient.crm_record_id) as rn
    from crm_private.bia_bulk_campaign_recipients recipient
    join public.crm_records record
      on record.id=recipient.crm_record_id
    where recipient.campaign_id=v_campaign_id
      and recipient.eligibility_status='eligible'
  )
  update crm_private.bia_bulk_campaign_recipients recipient
  set scheduled_at=now()
    + make_interval(mins => floor((ranked.rn-1)::numeric/3)::integer)
  from ranked
  where recipient.id=ranked.id;

  insert into crm_private.bia_campaign_outreach_jobs(
    settings_id,
    crm_record_id,
    source_type,
    source_id,
    phone,
    recipient_name,
    profile,
    consent,
    status,
    available_at
  )
  select
    cfg.id,
    recipient.crm_record_id,
    'bulk',
    recipient.id,
    recipient.phone,
    recipient.recipient_name,
    jsonb_build_object(
      'bulkCampaignId',v_campaign_id,
      'bulkCampaignName',v_campaign_name,
      'source','crm_strategy_queue'
    ),
    recipient.consent,
    'pending',
    recipient.scheduled_at
  from crm_private.bia_bulk_campaign_recipients recipient
  where recipient.campaign_id=v_campaign_id
    and recipient.eligibility_status='eligible'
  on conflict(source_type,source_id) do nothing;

  update crm_private.bia_strategy_queue q
  set status='dispatched',
      dispatched_settings_id=cfg.id,
      campaign_id=v_campaign_id,
      dispatched_at=now(),
      last_error=null,
      updated_at=now()
  from crm_private.bia_bulk_campaign_recipients recipient
  where recipient.campaign_id=v_campaign_id
    and recipient.crm_record_id=q.crm_record_id
    and q.organization_id=p_organization_id
    and q.status='staged';

  perform private.bia_dispatch_campaign_outreach();

  return jsonb_build_object(
    'ok',true,
    'campaignId',v_campaign_id,
    'selected',v_selected,
    'eligible',v_eligible,
    'blocked',v_blocked,
    'pacePerMinute',3,
    'templateName',cfg.template_name
  );
end
$function$;

revoke all on function public.bia_strategy_queue_admin(uuid,text,jsonb)
  from public, anon;
grant execute on function public.bia_strategy_queue_admin(uuid,text,jsonb)
  to authenticated;

comment on function public.bia_strategy_enqueue_lead(uuid,uuid) is
  'Coloca um lead elegível em staging da Fila da Bia. Nenhum WhatsApp é enviado até disparo explícito.';
comment on function public.bia_strategy_queue_admin(uuid,text,jsonb) is
  'Lista e dispara leads selecionados da Fila da Bia usando somente configuração/template aprovado e revalidando elegibilidade antes do envio.';
