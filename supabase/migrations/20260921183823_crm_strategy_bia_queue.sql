create or replace function public.bia_strategy_enqueue_lead(
  p_organization_id uuid,
  p_crm_record_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor uuid := auth.uid();
  lead public.crm_records%rowtype;
  cfg crm_private.bia_campaign_outreach_settings%rowtype;
  v_reason text;
  v_phone text;
  v_consent jsonb;
  v_campaign_id uuid;
  v_recipient_id uuid;
  v_job_id uuid;
  v_name text;
begin
  if actor is null or not exists (
    select 1
    from public.organization_members member
    join public.organizations organization
      on organization.id = member.organization_id
    where member.user_id = actor
      and member.organization_id = p_organization_id
      and member.active
      and lower(member.role) = 'admin'
      and organization.active
  ) then
    raise exception 'BIA_QUEUE_FORBIDDEN' using errcode = '42501';
  end if;

  select record.*
    into lead
    from public.crm_records record
   where record.id = p_crm_record_id
     and record.organization_id = p_organization_id;

  if not found or lead.record_status <> 'aberta' then
    return jsonb_build_object('ok', false, 'reason', 'BIA_CAMPAIGN_LEAD_INACTIVE');
  end if;

  select setting.*
    into cfg
    from crm_private.bia_campaign_outreach_settings setting
   where setting.organization_id = p_organization_id
     and setting.project_id = lead.project_id
     and setting.enabled
   order by setting.created_at desc
   limit 1;

  if cfg.id is null then
    return jsonb_build_object('ok', false, 'reason', 'BIA_CAMPAIGN_DISABLED');
  end if;

  if exists (
    select 1
    from crm_private.bia_campaign_outreach_jobs job
    where job.settings_id = cfg.id
      and job.crm_record_id = lead.id
      and job.source_type = 'bulk'
      and job.status in (
        'pending', 'processing', 'sending',
        'awaiting_template', 'awaiting_consent'
      )
  ) then
    return jsonb_build_object('ok', false, 'reason', 'BIA_ALREADY_QUEUED');
  end if;

  v_reason := crm_private.bia_bulk_candidate_reason(cfg.id, lead.id);
  if v_reason is not null then
    return jsonb_build_object('ok', false, 'reason', v_reason);
  end if;

  v_phone := regexp_replace(coalesce(lead.phone, ''), '[^0-9]', '', 'g');
  if length(v_phone) in (10, 11) then
    v_phone := '55' || v_phone;
  end if;

  v_consent := crm_private.bia_bulk_consent_for_record(cfg.id, lead.id);
  if v_consent is null then
    return jsonb_build_object('ok', false, 'reason', 'BIA_BULK_CONSENT_REQUIRED');
  end if;

  v_name := left(
    'Estratégia IA · ' || coalesce(nullif(trim(lead.person_name), ''), 'Lead'),
    120
  );

  insert into crm_private.bia_bulk_campaigns (
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
  values (
    p_organization_id,
    cfg.id,
    actor,
    v_name,
    'scheduled',
    now(),
    1,
    false,
    1,
    1,
    0
  )
  returning id into v_campaign_id;

  insert into crm_private.bia_bulk_campaign_recipients (
    campaign_id,
    crm_record_id,
    phone,
    recipient_name,
    consent,
    eligibility_status,
    block_reason,
    scheduled_at
  )
  values (
    v_campaign_id,
    lead.id,
    v_phone,
    coalesce(nullif(trim(lead.person_name), ''), 'tudo bem'),
    v_consent,
    'eligible',
    null,
    now()
  )
  returning id into v_recipient_id;

  insert into crm_private.bia_campaign_outreach_jobs (
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
  values (
    cfg.id,
    lead.id,
    'bulk',
    v_recipient_id,
    v_phone,
    coalesce(nullif(trim(lead.person_name), ''), 'tudo bem'),
    jsonb_build_object(
      'bulkCampaignId', v_campaign_id,
      'bulkCampaignName', v_name,
      'source', 'crm_strategy_ai',
      'queuedBy', actor
    ),
    v_consent,
    'pending',
    now()
  )
  returning id into v_job_id;

  return jsonb_build_object(
    'ok', true,
    'campaignId', v_campaign_id,
    'recipientId', v_recipient_id,
    'jobId', v_job_id,
    'queuedAt', now()
  );
end
$function$;

revoke all on function public.bia_strategy_enqueue_lead(uuid, uuid)
  from public, anon;
grant execute on function public.bia_strategy_enqueue_lead(uuid, uuid)
  to authenticated;

comment on function public.bia_strategy_enqueue_lead(uuid, uuid) is
  'Encaminha um único lead aberto da Estratégia IA para a fila controlada da Bia, revalidando consentimento, opt-out, duplicidade, canal e configuração ativa.';
