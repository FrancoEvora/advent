alter table crm_private.bia_campaign_outreach_jobs
  add column if not exists template_name text;

alter table crm_private.bia_campaign_outreach_jobs
  drop constraint if exists bia_campaign_outreach_jobs_template_name_check;
alter table crm_private.bia_campaign_outreach_jobs
  add constraint bia_campaign_outreach_jobs_template_name_check
  check (template_name is null or template_name ~ '^[a-z0-9_]{1,512}$');

create or replace function crm_private.bia_campaign_reservation_valid(
  p_job uuid,
  p_lease uuid,
  p_template text,
  p_phone text,
  p_actor uuid,
  p_org uuid
)
returns boolean
language sql
security definer
set search_path=''
as $function$
  select exists(
    select 1
    from crm_private.bia_campaign_outreach_jobs j
    join crm_private.bia_campaign_outreach_settings cfg on cfg.id=j.settings_id
    where j.id=p_job
      and j.lease=p_lease
      and j.lease_until>now()
      and j.status='processing'
      and cfg.actor_user_id=p_actor
      and cfg.organization_id=p_org
      and coalesce(j.template_name,cfg.template_name)=p_template
      and j.phone=p_phone
      and crm_private.bia_campaign_block_reason(j.id) is null
  )
$function$;

do $$
declare
  ddl text;
  before text;
begin
  select pg_get_functiondef('crm_private.bia_campaign_block_reason(uuid)'::regprocedure)
  into ddl;
  before := ddl;
  ddl := replace(
    ddl,
    '  if exists(select 1 from public.crm_actions a where a.crm_record_id=lead.id and a.organization_id=cfg.organization_id and a.action_status=''pendente'' and a.metadata->>''requires_human_review''=''true'' and a.metadata->>''no_external_delivery''=''true'') then return ''BIA_CONTACT_PAUSED'';end if;'||chr(10),
    ''
  );
  if ddl=before then raise exception 'BIA_BLOCK_REASON_PATCH_NOT_FOUND'; end if;
  execute ddl;
end
$$;

do $$
declare
  ddl text;
  before text;
begin
  select pg_get_functiondef('public.bia_campaign_outreach_worker(text,jsonb)'::regprocedure)
  into ddl;
  before := ddl;

  ddl := replace(
    ddl,
    '''template_name'',cfg.template_name',
    '''template_name'',coalesce(j.template_name,cfg.template_name)'
  );
  ddl := replace(
    ddl,
    '''template'',cfg.template_name',
    '''template'',coalesce(j.template_name,cfg.template_name)'
  );

  if ddl=before then raise exception 'BIA_WORKER_TEMPLATE_PATCH_NOT_FOUND'; end if;
  execute ddl;
end
$$;

do $$
declare
  ddl text;
  before text;
begin
  select pg_get_functiondef('public.bia_strategy_queue_admin(uuid,text,jsonb)'::regprocedure)
  into ddl;
  before := ddl;

  ddl := replace(
    ddl,
    '  v_settings_id uuid;'||chr(10),
    '  v_settings_id uuid;'||chr(10)||'  v_template_name text;'||chr(10)
  );

  ddl := replace(
    ddl,
    '  if cfg.id is null then'||chr(10)||
    '    raise exception ''BIA_QUEUE_SETTINGS_REQUIRED'';'||chr(10)||
    '  end if;'||chr(10),
    '  if cfg.id is null then'||chr(10)||
    '    raise exception ''BIA_QUEUE_SETTINGS_REQUIRED'';'||chr(10)||
    '  end if;'||chr(10)||chr(10)||
    '  v_template_name:=btrim(coalesce(p_args->>''templateName'',''''));'||chr(10)||
    '  if v_template_name !~ ''^[a-z0-9_]{1,512}$'' then'||chr(10)||
    '    raise exception ''BIA_QUEUE_TEMPLATE_REQUIRED'';'||chr(10)||
    '  end if;'||chr(10)
  );

  ddl := replace(
    ddl,
    '  insert into crm_private.bia_campaign_outreach_jobs('||chr(10)||
    '    settings_id,'||chr(10)||
    '    crm_record_id,',
    '  insert into crm_private.bia_campaign_outreach_jobs('||chr(10)||
    '    settings_id,'||chr(10)||
    '    template_name,'||chr(10)||
    '    crm_record_id,'
  );

  ddl := replace(
    ddl,
    '  select'||chr(10)||
    '    cfg.id,'||chr(10)||
    '    recipient.crm_record_id,',
    '  select'||chr(10)||
    '    cfg.id,'||chr(10)||
    '    v_template_name,'||chr(10)||
    '    recipient.crm_record_id,'
  );

  ddl := replace(
    ddl,
    '''templateName'',cfg.template_name',
    '''templateName'',v_template_name'
  );

  if ddl=before then raise exception 'BIA_QUEUE_TEMPLATE_PATCH_NOT_FOUND'; end if;
  execute ddl;
end
$$;

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
        'templateName',coalesce(j.template_name,s.template_name),
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
