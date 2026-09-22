create or replace function crm_private.bia_bulk_candidate_reason(
  p_settings uuid,
  p_record uuid
)
returns text
language plpgsql
security definer
set search_path=''
as $function$
declare
  cfg crm_private.bia_campaign_outreach_settings;
  lead public.crm_records;
  contact public.contacts;
  v_phone text;
begin
  select * into cfg
  from crm_private.bia_campaign_outreach_settings
  where id=p_settings;

  select * into lead
  from public.crm_records
  where id=p_record;

  if cfg.id is null or not cfg.enabled then
    return 'BIA_CAMPAIGN_DISABLED';
  end if;

  if lead.id is null
     or lead.organization_id<>cfg.organization_id
     or lead.project_id<>cfg.project_id
     or lead.record_status<>'aberta' then
    return 'BIA_CAMPAIGN_LEAD_INACTIVE';
  end if;

  v_phone:=regexp_replace(coalesce(lead.phone,''),'[^0-9]','','g');
  if length(v_phone) in(10,11) then
    v_phone:='55'||v_phone;
  end if;

  if coalesce(v_phone,'') !~ '^55[1-9][0-9]([2-9][0-9]{7}|9[0-9]{8})$' then
    return 'BIA_PHONE_INVALID';
  end if;

  select * into contact
  from public.contacts
  where id=lead.contact_id;

  if contact.id is not null
     and (
       not contact.active
       or contact.do_not_contact_at is not null
       or contact.marketing_consent_status in('denied','revoked')
     ) then
    return 'BIA_CONTACT_PAUSED';
  end if;

  if exists(
    select 1
    from crm_private.bia_whatsapp_threads t
    join crm_private.bia_whatsapp_channels ch on ch.id=t.channel_id
    where ch.organization_id=cfg.organization_id
      and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(v_phone)
      and (t.opted_out_at is not null or t.human_requested)
  ) then
    return 'BIA_CONTACT_PAUSED';
  end if;

  if exists(
    select 1
    from crm_private.bia_whatsapp_threads t
    join crm_private.bia_whatsapp_channels ch on ch.id=t.channel_id
    where ch.organization_id=cfg.organization_id
      and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(v_phone)
      and (
        t.last_inbound_at is not null
        or exists(
          select 1
          from crm_private.bia_whatsapp_outbound o
          where o.thread_id=t.id
            and o.status<>'failed'
        )
      )
  ) then
    return 'BIA_CAMPAIGN_ALREADY_CONTACTED';
  end if;

  if crm_private.bia_bulk_consent_for_record(p_settings,p_record) is null then
    return 'BIA_BULK_CONSENT_REQUIRED';
  end if;

  return null;
end
$function$;

update crm_private.bia_strategy_queue q
set last_error=crm_private.bia_bulk_candidate_reason(q.recommended_settings_id,q.crm_record_id),
    updated_at=now()
where q.status='staged'
  and q.recommended_settings_id is not null;

create or replace function public.bia_strategy_queue_preview(
  p_organization_id uuid,
  p_settings_id uuid,
  p_queue_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  actor uuid:=auth.uid();
  cfg crm_private.bia_campaign_outreach_settings%rowtype;
  result jsonb;
begin
  if actor is null or not exists(
    select 1
    from public.organization_members m
    join public.organizations o on o.id=m.organization_id
    where m.user_id=actor
      and m.organization_id=p_organization_id
      and m.active
      and lower(m.role)='admin'
      and o.active
  ) then
    raise exception 'BIA_QUEUE_FORBIDDEN' using errcode='42501';
  end if;

  if p_queue_ids is null
     or coalesce(cardinality(p_queue_ids),0)=0
     or cardinality(p_queue_ids)>1000 then
    raise exception 'BIA_QUEUE_SELECTION_INVALID';
  end if;

  select * into cfg
  from crm_private.bia_campaign_outreach_settings s
  where s.id=p_settings_id
    and s.organization_id=p_organization_id
    and s.enabled;

  if cfg.id is null then
    raise exception 'BIA_QUEUE_SETTINGS_REQUIRED';
  end if;

  with selected as (
    select
      q.id as queue_id,
      q.crm_record_id,
      r.person_name,
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
      and q.id=any(p_queue_ids)
  )
  select jsonb_build_object(
    'selected',count(*),
    'eligible',count(*) filter(where reason is null),
    'blocked',count(*) filter(where reason is not null),
    'items',coalesce(
      jsonb_agg(
        jsonb_build_object(
          'queueId',queue_id,
          'crmRecordId',crm_record_id,
          'name',coalesce(nullif(trim(person_name),''),'Lead sem nome'),
          'ready',reason is null,
          'reason',reason
        )
        order by person_name
      ),
      '[]'::jsonb
    )
  )
  into result
  from selected;

  return result;
end
$function$;

revoke all on function public.bia_strategy_queue_preview(uuid,uuid,uuid[]) from public,anon;
grant execute on function public.bia_strategy_queue_preview(uuid,uuid,uuid[]) to authenticated;

create or replace function public.bia_strategy_queue_delivery(
  p_organization_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  actor uuid:=auth.uid();
  result jsonb;
begin
  if actor is null or not exists(
    select 1
    from public.organization_members m
    join public.organizations o on o.id=m.organization_id
    where m.user_id=actor
      and m.organization_id=p_organization_id
      and m.active
      and lower(m.role)='admin'
      and o.active
  ) then
    raise exception 'BIA_QUEUE_FORBIDDEN' using errcode='42501';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'queueId',q.id,
        'queueStatus',q.status,
        'campaignId',q.campaign_id,
        'campaignStatus',c.status,
        'templateName',s.template_name,
        'jobStatus',j.status,
        'deliveryStatus',o.status,
        'errorCode',coalesce(o.error_code,j.error_code),
        'providerMessageId',o.provider_message_id,
        'dispatchedAt',q.dispatched_at,
        'outboundAt',o.created_at
      )
      order by q.queued_at desc
    ),
    '[]'::jsonb
  )
  into result
  from crm_private.bia_strategy_queue q
  left join crm_private.bia_bulk_campaigns c
    on c.id=q.campaign_id
   and c.organization_id=q.organization_id
  left join crm_private.bia_campaign_outreach_settings s
    on s.id=q.dispatched_settings_id
  left join crm_private.bia_bulk_campaign_recipients r
    on r.campaign_id=q.campaign_id
   and r.crm_record_id=q.crm_record_id
  left join crm_private.bia_campaign_outreach_jobs j
    on j.source_type='bulk'
   and j.source_id=r.id
  left join crm_private.bia_whatsapp_outbound o
    on o.id=j.id
  where q.organization_id=p_organization_id
    and q.status='dispatched';

  return result;
end
$function$;

revoke all on function public.bia_strategy_queue_delivery(uuid) from public,anon;
grant execute on function public.bia_strategy_queue_delivery(uuid) to authenticated;
