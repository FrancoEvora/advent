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
  v_reason text;
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
      'settingsId',existing.recommended_settings_id,
      'warning',existing.last_error
    );
  end if;

  select setting.* into cfg
  from crm_private.bia_campaign_outreach_settings setting
  where setting.organization_id=p_organization_id
    and setting.project_id=lead.project_id
    and setting.enabled
  order by setting.created_at desc
  limit 1;

  if cfg.id is null then
    v_reason := 'BIA_CAMPAIGN_DISABLED';
  else
    v_reason := crm_private.bia_bulk_candidate_reason(cfg.id, lead.id);
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
    cfg.id,
    'staged',
    v_reason
  )
  returning * into queued;

  return jsonb_build_object(
    'ok',true,
    'queued',true,
    'alreadyQueued',false,
    'id',queued.id,
    'settingsId',queued.recommended_settings_id,
    'warning',queued.last_error,
    'queuedAt',queued.queued_at
  );
end
$function$;

revoke all on function public.bia_strategy_enqueue_lead(uuid,uuid)
  from public, anon;
grant execute on function public.bia_strategy_enqueue_lead(uuid,uuid)
  to authenticated;

comment on function public.bia_strategy_enqueue_lead(uuid,uuid) is
  'Coloca qualquer lead aberto na Fila da Bia para revisão. Guardrails de consentimento, template, opt-out, telefone e duplicidade são sinalizados no staging e revalidados de forma impeditiva somente no disparo.';
