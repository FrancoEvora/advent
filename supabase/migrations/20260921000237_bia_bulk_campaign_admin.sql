create or replace function public.bia_bulk_campaign_admin(
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
  actor uuid:=auth.uid();
  cfg crm_private.bia_campaign_outreach_settings;
  campaign crm_private.bia_bulk_campaigns;
  v_id uuid;
  v_name text;
  v_start timestamptz;
  v_pace integer;
  v_total integer;
  v_eligible integer;
  v_blocked integer;
  result jsonb;
begin
  if actor is null or not exists(
    select 1 from public.organization_members m
    join public.organizations o on o.id=m.organization_id
    where m.user_id=actor and m.organization_id=p_organization_id and m.active and m.role='admin' and o.active
  ) then raise exception 'BIA_BULK_FORBIDDEN' using errcode='42501'; end if;

  if p_action='overview' then
    update crm_private.bia_bulk_campaigns c
    set status='running',updated_at=now()
    where c.organization_id=p_organization_id and c.status='scheduled' and c.starts_at<=now()
      and exists(
        select 1 from crm_private.bia_bulk_campaign_recipients r
        join crm_private.bia_campaign_outreach_jobs j on j.source_type='bulk' and j.source_id=r.id
        where r.campaign_id=c.id and j.status in('pending','processing','sending','awaiting_template','awaiting_consent')
      );

    update crm_private.bia_bulk_campaigns c
    set status='completed',updated_at=now()
    where c.organization_id=p_organization_id and c.status in('scheduled','running')
      and c.eligible_count>0
      and not exists(
        select 1 from crm_private.bia_bulk_campaign_recipients r
        join crm_private.bia_campaign_outreach_jobs j on j.source_type='bulk' and j.source_id=r.id
        where r.campaign_id=c.id and j.status in('pending','processing','sending','awaiting_template','awaiting_consent')
      );

    select jsonb_build_object(
      'channel',coalesce((select jsonb_build_object('enabled',ch.enabled,'verified',ch.webhook_verified_at is not null)
        from crm_private.bia_whatsapp_channels ch where ch.organization_id=p_organization_id limit 1),'{}'::jsonb),
      'settings',coalesce((select jsonb_agg(jsonb_build_object(
        'id',s.id,'projectId',s.project_id,'templateName',s.template_name,'name',coalesce(s.campaign_context->>'name','Campanha WhatsApp'),'enabled',s.enabled
      ) order by s.created_at desc) from crm_private.bia_campaign_outreach_settings s where s.organization_id=p_organization_id),'[]'::jsonb),
      'campaigns',coalesce((select jsonb_agg(item order by item->>'createdAt' desc) from (
        select jsonb_build_object(
          'id',c.id,'name',c.name,'status',c.status,'startsAt',c.starts_at,'pacePerMinute',c.pace_per_minute,
          'total',c.total_count,'eligible',c.eligible_count,'blocked',c.blocked_count,'createdAt',c.created_at,
          'sent',count(*) filter(where coalesce(o.status,j.status) in('accepted','sent','delivered','read')),
          'delivered',count(*) filter(where o.status in('delivered','read')),
          'read',count(*) filter(where o.status='read'),
          'replied',count(*) filter(where t.last_inbound_at is not null and t.last_inbound_at>=o.created_at),
          'failed',count(*) filter(where coalesce(o.status,j.status) in('failed','unknown')),
          'pending',count(*) filter(where j.status in('pending','processing','sending','awaiting_template','awaiting_consent')),
          'skipped',count(*) filter(where j.status='skipped')
        ) item
        from crm_private.bia_bulk_campaigns c
        left join crm_private.bia_bulk_campaign_recipients r on r.campaign_id=c.id and r.eligibility_status='eligible'
        left join crm_private.bia_campaign_outreach_jobs j on j.source_type='bulk' and j.source_id=r.id
        left join crm_private.bia_whatsapp_outbound o on o.id=j.id
        left join crm_private.bia_whatsapp_threads t on t.id=o.thread_id
        where c.organization_id=p_organization_id
        group by c.id
        order by c.created_at desc
        limit 25
      ) q),'[]'::jsonb)
    ) into result;
    return result;
  end if;

  if p_action in('preview','create') then
    if coalesce(p_args->>'onlyUnserved','true')<>'true' then raise exception 'BIA_BULK_SCOPE_REQUIRED'; end if;
    begin v_id:=(p_args->>'settingsId')::uuid; exception when others then raise exception 'BIA_BULK_SETTINGS_REQUIRED'; end;
    select * into cfg from crm_private.bia_campaign_outreach_settings
      where id=v_id and organization_id=p_organization_id and enabled;
    if cfg.id is null then raise exception 'BIA_BULK_SETTINGS_REQUIRED'; end if;

    with base as (
      select r.*,
        case when length(regexp_replace(coalesce(r.phone,''),'[^0-9]','','g')) in(10,11)
          then '55'||regexp_replace(coalesce(r.phone,''),'[^0-9]','','g')
          else regexp_replace(coalesce(r.phone,''),'[^0-9]','','g') end normalized_phone,
        crm_private.bia_bulk_candidate_reason(cfg.id,r.id) base_reason
      from public.crm_records r
      where r.organization_id=p_organization_id and r.project_id=cfg.project_id and r.record_status='aberta'
        and not exists(select 1 from public.crm_actions a where a.crm_record_id=r.id)
    ), ranked as (
      select b.*,row_number() over(
        partition by b.normalized_phone
        order by (b.base_reason is null) desc,b.created_at desc,b.id
      ) phone_rank
      from base b
    ), classified as (
      select x.*,
        case
          when x.base_reason='BIA_PHONE_INVALID' then x.base_reason
          when x.phone_rank>1 then 'BIA_BULK_DUPLICATE_PHONE'
          else x.base_reason
        end final_reason
      from ranked x
    )
    select count(*),
      count(*) filter(where final_reason is null),
      count(*) filter(where final_reason is not null)
    into v_total,v_eligible,v_blocked
    from classified;

    if v_total>1000 then raise exception 'BIA_BULK_SCOPE_TOO_LARGE'; end if;

    if p_action='preview' then
      return jsonb_build_object(
        'total',v_total,'eligible',v_eligible,'blocked',v_blocked,
        'reasons',coalesce((
          with base as (
            select r.*,
              case when length(regexp_replace(coalesce(r.phone,''),'[^0-9]','','g')) in(10,11)
                then '55'||regexp_replace(coalesce(r.phone,''),'[^0-9]','','g')
                else regexp_replace(coalesce(r.phone,''),'[^0-9]','','g') end normalized_phone,
              crm_private.bia_bulk_candidate_reason(cfg.id,r.id) base_reason
            from public.crm_records r
            where r.organization_id=p_organization_id and r.project_id=cfg.project_id and r.record_status='aberta'
              and not exists(select 1 from public.crm_actions a where a.crm_record_id=r.id)
          ), ranked as (
            select b.*,row_number() over(
              partition by b.normalized_phone
              order by (b.base_reason is null) desc,b.created_at desc,b.id
            ) phone_rank
            from base b
          )
          select jsonb_object_agg(reason,cnt) from (
            select case
              when base_reason='BIA_PHONE_INVALID' then base_reason
              when phone_rank>1 then 'BIA_BULK_DUPLICATE_PHONE'
              else coalesce(base_reason,'ELIGIBLE')
            end reason,count(*) cnt
            from ranked group by 1
          ) z
        ),'{}'::jsonb)
      );
    end if;

    if v_eligible=0 then raise exception 'BIA_BULK_NO_ELIGIBLE_RECIPIENTS'; end if;
    v_name:=trim(coalesce(p_args->>'name',''));
    if char_length(v_name) not between 3 and 120 then raise exception 'BIA_BULK_NAME_INVALID'; end if;
    begin v_start:=(p_args->>'startsAt')::timestamptz; exception when others then raise exception 'BIA_BULK_START_INVALID'; end;
    if v_start<now()-interval '1 minute' or v_start>now()+interval '90 days' then raise exception 'BIA_BULK_START_INVALID'; end if;
    begin v_pace:=(p_args->>'pacePerMinute')::integer; exception when others then v_pace:=3; end;
    if v_pace not between 1 and 3 then raise exception 'BIA_BULK_PACE_INVALID'; end if;

    insert into crm_private.bia_bulk_campaigns(
      organization_id,settings_id,created_by,name,status,starts_at,pace_per_minute,only_unserved,total_count,eligible_count,blocked_count
    ) values(p_organization_id,cfg.id,actor,v_name,'scheduled',v_start,v_pace,true,v_total,v_eligible,v_blocked)
    returning id into v_id;

    with base as (
      select r.*,
        case when length(regexp_replace(coalesce(r.phone,''),'[^0-9]','','g')) in(10,11)
          then '55'||regexp_replace(coalesce(r.phone,''),'[^0-9]','','g')
          else regexp_replace(coalesce(r.phone,''),'[^0-9]','','g') end normalized_phone,
        crm_private.bia_bulk_candidate_reason(cfg.id,r.id) base_reason
      from public.crm_records r
      where r.organization_id=p_organization_id and r.project_id=cfg.project_id and r.record_status='aberta'
        and not exists(select 1 from public.crm_actions a where a.crm_record_id=r.id)
    ), ranked as (
      select b.*,row_number() over(
        partition by b.normalized_phone
        order by (b.base_reason is null) desc,b.created_at desc,b.id
      ) phone_rank
      from base b
    ), classified as (
      select x.*,
        case
          when x.base_reason='BIA_PHONE_INVALID' then x.base_reason
          when x.phone_rank>1 then 'BIA_BULK_DUPLICATE_PHONE'
          else x.base_reason
        end final_reason
      from ranked x
    )
    insert into crm_private.bia_bulk_campaign_recipients(
      campaign_id,crm_record_id,phone,recipient_name,consent,eligibility_status,block_reason
    )
    select v_id,x.id,x.normalized_phone,
      coalesce(nullif(trim(x.person_name),''),'tudo bem'),
      coalesce(crm_private.bia_bulk_consent_for_record(cfg.id,x.id),'{}'::jsonb),
      case when x.final_reason is null then 'eligible' else 'blocked' end,
      x.final_reason
    from classified x
    order by x.created_at,x.id;

    with ranked as (
      select rr.id,row_number() over(order by cr.created_at,rr.crm_record_id) rn
      from crm_private.bia_bulk_campaign_recipients rr
      join public.crm_records cr on cr.id=rr.crm_record_id
      where rr.campaign_id=v_id and rr.eligibility_status='eligible'
    )
    update crm_private.bia_bulk_campaign_recipients rr
    set scheduled_at=v_start + make_interval(mins => floor((ranked.rn-1)::numeric/v_pace)::integer)
    from ranked where rr.id=ranked.id;

    insert into crm_private.bia_campaign_outreach_jobs(
      settings_id,crm_record_id,source_type,source_id,phone,recipient_name,profile,consent,status,available_at
    )
    select cfg.id,rr.crm_record_id,'bulk',rr.id,rr.phone,rr.recipient_name,
      jsonb_build_object('bulkCampaignId',v_id,'bulkCampaignName',v_name),
      rr.consent,'pending',rr.scheduled_at
    from crm_private.bia_bulk_campaign_recipients rr
    where rr.campaign_id=v_id and rr.eligibility_status='eligible'
    on conflict(source_type,source_id) do nothing;

    return jsonb_build_object('id',v_id,'total',v_total,'eligible',v_eligible,'blocked',v_blocked,'startsAt',v_start,'pacePerMinute',v_pace);
  end if;

  begin v_id:=(p_args->>'id')::uuid; exception when others then raise exception 'BIA_BULK_CAMPAIGN_REQUIRED'; end;
  select * into campaign from crm_private.bia_bulk_campaigns
    where id=v_id and organization_id=p_organization_id for update;
  if campaign.id is null then raise exception 'BIA_BULK_CAMPAIGN_REQUIRED'; end if;

  if p_action='pause' then
    if campaign.status not in('scheduled','running') then return jsonb_build_object('id',campaign.id,'status',campaign.status); end if;
    update crm_private.bia_bulk_campaigns set status='paused',updated_at=now() where id=campaign.id;
    update crm_private.bia_campaign_outreach_jobs j
      set available_at='infinity'::timestamptz,updated_at=now()
      from crm_private.bia_bulk_campaign_recipients r
      where r.campaign_id=campaign.id and j.source_type='bulk' and j.source_id=r.id
        and j.status in('pending','awaiting_template','awaiting_consent');
    return jsonb_build_object('id',campaign.id,'status','paused');
  elsif p_action='resume' then
    if campaign.status<>'paused' then return jsonb_build_object('id',campaign.id,'status',campaign.status); end if;
    with ranked as (
      select j.id,row_number() over(order by r.scheduled_at,r.id) rn
      from crm_private.bia_bulk_campaign_recipients r
      join crm_private.bia_campaign_outreach_jobs j on j.source_type='bulk' and j.source_id=r.id
      where r.campaign_id=campaign.id and j.status in('pending','awaiting_template','awaiting_consent')
    ), sched as (
      select id,now()+make_interval(mins => floor((rn-1)::numeric/campaign.pace_per_minute)::integer) at_time from ranked
    )
    update crm_private.bia_campaign_outreach_jobs j
      set available_at=sched.at_time,updated_at=now()
      from sched where j.id=sched.id;
    update crm_private.bia_bulk_campaigns set status='scheduled',starts_at=now(),updated_at=now() where id=campaign.id;
    return jsonb_build_object('id',campaign.id,'status','scheduled');
  elsif p_action='cancel' then
    update crm_private.bia_bulk_campaigns set status='cancelled',updated_at=now() where id=campaign.id;
    update crm_private.bia_campaign_outreach_jobs j
      set status='skipped',error_code='BIA_BULK_CANCELLED',updated_at=now()
      from crm_private.bia_bulk_campaign_recipients r
      where r.campaign_id=campaign.id and j.source_type='bulk' and j.source_id=r.id
        and j.status in('pending','awaiting_template','awaiting_consent');
    return jsonb_build_object('id',campaign.id,'status','cancelled');
  end if;

  raise exception 'BIA_BULK_ACTION_INVALID';
end
$function$;

revoke all on function public.bia_bulk_campaign_admin(uuid,text,jsonb) from public,anon;
grant execute on function public.bia_bulk_campaign_admin(uuid,text,jsonb) to authenticated;
