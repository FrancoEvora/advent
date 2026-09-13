-- Event-driven outreach. No existing leads are enrolled by this migration.
create table crm_private.bia_campaign_outreach_settings (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 campaign_id uuid not null references public.crm_campaigns(id),
 project_id uuid not null references public.projects(id),
 actor_user_id uuid not null references auth.users(id),
 notify_user_id uuid not null references auth.users(id),
 public_form_slug text references private.crm_public_forms(slug),
 meta_campaign_id text,
 meta_form_id text,
 template_name text not null check(template_name ~ '^bia_[a-z0-9_]{1,100}$'),
 campaign_context jsonb not null default '{}' check(jsonb_typeof(campaign_context)='object'),
 enabled boolean not null default false,
 activated_at timestamptz,
 created_at timestamptz not null default now(),
 unique(organization_id,campaign_id),
 check(not enabled or activated_at is not null)
);
create unique index bia_campaign_public_form_unique on crm_private.bia_campaign_outreach_settings(public_form_slug) where public_form_slug is not null;
create unique index bia_campaign_meta_form_unique on crm_private.bia_campaign_outreach_settings(organization_id,meta_campaign_id,meta_form_id) where meta_form_id is not null;

create table crm_private.bia_campaign_outreach_jobs (
 id uuid primary key default gen_random_uuid(),
 settings_id uuid not null references crm_private.bia_campaign_outreach_settings(id),
 crm_record_id uuid not null references public.crm_records(id),
 source_type text not null check(source_type in('public_form','meta')),
 source_id uuid not null,
 phone text not null,
 recipient_name text not null,
 profile jsonb not null default '{}',
 consent jsonb not null default '{}',
 status text not null default 'pending' check(status in('pending','processing','sending','awaiting_template','awaiting_consent','sent','failed','unknown','skipped')),
 lease uuid,
 lease_until timestamptz,
 available_at timestamptz not null default now(),
 attempts integer not null default 0,
 error_code text,
 result jsonb not null default '{}',
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 unique(settings_id,crm_record_id),
 unique(source_type,source_id)
);
create index bia_campaign_jobs_claim on crm_private.bia_campaign_outreach_jobs(available_at,created_at) where status in('pending','awaiting_template','awaiting_consent');
create index bia_campaign_jobs_record on crm_private.bia_campaign_outreach_jobs(crm_record_id);
alter table crm_private.bia_campaign_outreach_settings enable row level security;
alter table crm_private.bia_campaign_outreach_jobs enable row level security;
revoke all on crm_private.bia_campaign_outreach_settings,crm_private.bia_campaign_outreach_jobs from public,anon,authenticated;
grant select,insert,update on crm_private.bia_campaign_outreach_settings,crm_private.bia_campaign_outreach_jobs to service_role;

create function crm_private.bia_enqueue_campaign_source(p_source text,p_source_id uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare cfg crm_private.bia_campaign_outreach_settings; lead public.crm_records; submission private.crm_public_form_submissions;
 attribution public.crm_opportunity_attributions; v_id uuid; v_phone text; profile jsonb:='{}'; consent jsonb:='{}'; captured timestamptz;
begin
 if p_source='public_form' then
  select * into submission from private.crm_public_form_submissions where id=p_source_id and original_created_at is null;
  if submission.id is null then return null;end if;
  select * into cfg from crm_private.bia_campaign_outreach_settings where public_form_slug=submission.form_slug and organization_id=submission.organization_id and enabled;
  select * into lead from public.crm_records where id=submission.crm_record_id;
  captured:=submission.created_at;
  profile:=jsonb_build_object('purpose',submission.purpose,'budget',submission.budget);
  consent:=jsonb_build_object('source','public_form','version',submission.consent_version,'at',submission.created_at);
 elsif p_source='meta' then
  select * into attribution from public.crm_opportunity_attributions where id=p_source_id and provider='meta' and channel='meta_lead_ads';
  if attribution.id is null then return null;end if;
  select * into cfg from crm_private.bia_campaign_outreach_settings where organization_id=attribution.organization_id and meta_campaign_id=attribution.campaign_id and meta_form_id=attribution.form_id and enabled;
  select * into lead from public.crm_records where id=attribution.crm_record_id;
  captured:=attribution.captured_at;
  consent:=jsonb_build_object('source','meta','attributionId',attribution.id,'at',captured);
 else return null;end if;
 if cfg.id is null or lead.id is null or lead.organization_id<>cfg.organization_id or lead.project_id<>cfg.project_id
  or lead.created_at<cfg.activated_at or captured is null or captured<cfg.activated_at or captured<now()-interval '24 hours' or lead.record_status<>'aberta' then return null;end if;
 v_phone:=regexp_replace(lead.phone,'[^0-9]','','g');
 if length(v_phone) in(10,11) then v_phone:='55'||v_phone;end if;
 if coalesce(v_phone,'')!~'^55[1-9][0-9]([2-9][0-9]{7}|9[0-9]{8})$' then return null;end if;
 insert into crm_private.bia_campaign_outreach_jobs(settings_id,crm_record_id,source_type,source_id,phone,recipient_name,profile,consent)
 values(cfg.id,lead.id,p_source,p_source_id,v_phone,coalesce(nullif(trim(lead.person_name),''),'tudo bem'),profile,consent)
 on conflict do nothing returning id into v_id;
 return v_id;
end $$;
revoke all on function crm_private.bia_enqueue_campaign_source(text,uuid) from public,anon,authenticated;

create function crm_private.bia_campaign_block_reason(p_job uuid)
returns text language plpgsql security definer set search_path='' as $$
declare j crm_private.bia_campaign_outreach_jobs; cfg crm_private.bia_campaign_outreach_settings; lead public.crm_records; contact public.contacts; v_phone text;
begin
 select * into j from crm_private.bia_campaign_outreach_jobs where id=p_job;
 select * into cfg from crm_private.bia_campaign_outreach_settings where id=j.settings_id;
 if j.id is null or not coalesce(cfg.enabled,false) then return 'BIA_CAMPAIGN_DISABLED';end if;
 if not private.arisa_actor_admin(cfg.organization_id,cfg.actor_user_id) then return 'BIA_CAMPAIGN_ACTOR_INACTIVE';end if;
 select * into lead from public.crm_records where id=j.crm_record_id;
 select * into contact from public.contacts where id=lead.contact_id;
 if lead.id is null or lead.organization_id<>cfg.organization_id or lead.project_id<>cfg.project_id or lead.record_status<>'aberta'
   or lead.created_at<cfg.activated_at then return 'BIA_CAMPAIGN_LEAD_INACTIVE';end if;
 if j.created_at<now()-interval '24 hours' then return 'BIA_CAMPAIGN_EXPIRED';end if;
 v_phone:=regexp_replace(lead.phone,'[^0-9]','','g');if length(v_phone) in(10,11) then v_phone:='55'||v_phone;end if;
 if v_phone is distinct from j.phone then return 'BIA_CAMPAIGN_PHONE_CHANGED';end if;
 if contact.id is not null and (not contact.active or contact.do_not_contact_at is not null or contact.marketing_consent_status in('denied','revoked')) then return 'BIA_CONTACT_PAUSED';end if;
 if j.source_type='public_form' then
  if not exists(select 1 from private.crm_public_form_submissions s where s.id=j.source_id and s.form_slug=cfg.public_form_slug and s.organization_id=cfg.organization_id and s.crm_record_id=lead.id and s.original_created_at is null and s.created_at>=cfg.activated_at and s.consent_version='solaris-whatsapp-v1' and regexp_replace(s.phone,'[^0-9]','','g')=j.phone) then return 'BIA_CAMPAIGN_CONSENT_REQUIRED';end if;
 elsif j.source_type='meta' then
  if not exists(select 1 from public.crm_opportunity_attributions a where a.id=j.source_id and a.crm_record_id=lead.id and a.organization_id=cfg.organization_id and a.provider='meta' and a.campaign_id=cfg.meta_campaign_id and a.form_id=cfg.meta_form_id and a.captured_at>=cfg.activated_at) then return 'BIA_CAMPAIGN_SOURCE_CHANGED';end if;
  if contact.marketing_consent_status is distinct from 'granted' or contact.marketing_consent_at is null or contact.marketing_consent_source not like 'meta_custom_disclaimer:%' then return 'BIA_CAMPAIGN_CONSENT_REQUIRED';end if;
 end if;
 if exists(select 1 from crm_private.bia_whatsapp_threads t join crm_private.bia_whatsapp_channels ch on ch.id=t.channel_id where ch.organization_id=cfg.organization_id and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(j.phone) and (t.opted_out_at is not null or t.human_requested)) then return 'BIA_CONTACT_PAUSED';end if;
 -- Never open a second automated conversation for an already contacted phone, even under another lead ID.
 if exists(select 1 from crm_private.bia_whatsapp_threads t join crm_private.bia_whatsapp_channels ch on ch.id=t.channel_id where ch.organization_id=cfg.organization_id and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(j.phone) and (t.last_inbound_at is not null or exists(select 1 from crm_private.bia_whatsapp_outbound o where o.thread_id=t.id and o.id<>j.id and o.status<>'failed'))) then return 'BIA_CAMPAIGN_ALREADY_CONTACTED';end if;
 return null;
end $$;
revoke all on function crm_private.bia_campaign_block_reason(uuid) from public,anon,authenticated;

create function crm_private.bia_campaign_reservation_valid(p_job uuid,p_lease uuid,p_template text,p_phone text,p_actor uuid,p_org uuid)
returns boolean language sql security definer set search_path='' as $$
 select exists(select 1 from crm_private.bia_campaign_outreach_jobs j join crm_private.bia_campaign_outreach_settings cfg on cfg.id=j.settings_id
 where j.id=p_job and j.lease=p_lease and j.lease_until>now() and j.status='processing' and cfg.actor_user_id=p_actor and cfg.organization_id=p_org and cfg.template_name=p_template and j.phone=p_phone
 and crm_private.bia_campaign_block_reason(j.id) is null)
$$;
revoke all on function crm_private.bia_campaign_reservation_valid(uuid,uuid,text,text,uuid,uuid) from public,anon,authenticated;

alter table crm_private.bia_whatsapp_outbound drop constraint bia_whatsapp_outbound_template_name_check;
alter table crm_private.bia_whatsapp_outbound add constraint bia_whatsapp_outbound_template_name_check check(template_name ~ '^bia_[a-z0-9_]{1,100}$');

-- Notices use the same inbox and WhatsApp delivery queue already configured for the owner.
create function crm_private.bia_campaign_notice(p_job uuid,p_kind text)
returns void language plpgsql security definer set search_path='' as $$
declare j crm_private.bia_campaign_outreach_jobs; cfg crm_private.bia_campaign_outreach_settings; o crm_private.bia_whatsapp_outbound; n uuid; link text; message text;
begin
 select * into j from crm_private.bia_campaign_outreach_jobs where id=p_job;
 select * into cfg from crm_private.bia_campaign_outreach_settings where id=j.settings_id;
 if cfg.id is null then return;end if;
 select * into o from crm_private.bia_whatsapp_outbound where id=j.id;
 link:=case when o.thread_id is not null then '/bia?painel=whatsapp&atendimento='||o.thread_id else '/bia?painel=whatsapp' end;
 message:=case when p_kind='started' then 'A Bia iniciou o contato com '||j.recipient_name||' pelo WhatsApp. Mensagem aceita pela Meta; acompanhe a entrega e as respostas no histórico.'
 else 'O primeiro contato da Bia com '||j.recipient_name||' aguarda atenção. Motivo: '||coalesce(j.error_code,o.error_code,j.status)||'. Nenhum reenvio automático será feito após um resultado incerto.' end;
 message:=message||E'\nCampanha: '||coalesce(cfg.campaign_context->>'name','Campanha Solaris')||E'\nTelefone final: '||right(j.phone,4);
 insert into public.activity_notifications(organization_id,recipient_user_id,actor_user_id,notification_type,title,message,metadata,dedupe_key)
 values(cfg.organization_id,cfg.notify_user_id,cfg.actor_user_id,'bia_conversation_'||p_kind,
 case when p_kind='started' then 'Bia iniciou uma conversa' else 'Contato da Bia requer atenção' end,message,
 jsonb_build_object('source','bia_whatsapp','campaign_id',cfg.campaign_id,'crm_record_id',j.crm_record_id,'outbound_id',j.id,'thread_id',o.thread_id,'href',link,'whatsapp_status','pending'),
 'bia-campaign:'||j.id||':'||p_kind)
 on conflict do nothing returning id into n;
 if n is not null then
  insert into crm_private.arisa_whatsapp_notice_jobs(id,organization_id,recipient_user_id,actor_user_id)
  values(n,cfg.organization_id,cfg.notify_user_id,cfg.actor_user_id) on conflict do nothing;
 end if;
end $$;
revoke all on function crm_private.bia_campaign_notice(uuid,text) from public,anon,authenticated;

create function crm_private.bia_campaign_outbound_changed()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if not exists(select 1 from crm_private.bia_campaign_outreach_jobs where id=new.id) then return new;end if;
 if new.status in('accepted','sent','delivered','read') and new.provider_message_id is not null then
  update crm_private.bia_campaign_outreach_jobs set status='sent',error_code=null,updated_at=now() where id=new.id;
  perform crm_private.bia_campaign_notice(new.id,'started');
 elsif new.status in('failed','unknown') then
  update crm_private.bia_campaign_outreach_jobs set status=new.status,error_code=new.error_code,updated_at=now() where id=new.id;
  perform crm_private.bia_campaign_notice(new.id,'attention');
 end if;
 return new;
end $$;
revoke all on function crm_private.bia_campaign_outbound_changed() from public,anon,authenticated;
create trigger bia_campaign_outbound_changed after update of status on crm_private.bia_whatsapp_outbound for each row execute function crm_private.bia_campaign_outbound_changed();

create function private.bia_dispatch_campaign_outreach()
returns bigint language plpgsql security definer set search_path='' as $$
declare req bigint;
begin
 if not exists(select 1 from crm_private.bia_campaign_outreach_settings where enabled) then return null;end if;
 select net.http_post(url:='https://qsdffayasuzsmngteika.supabase.co/functions/v1/bia-campaign-outreach',
 headers:=jsonb_build_object('content-type','application/json','x-arisa-worker-secret',public.arisa_background_secret()),body:='{}'::jsonb,timeout_milliseconds:=145000) into req;
 return req;
end $$;
revoke all on function private.bia_dispatch_campaign_outreach() from public,anon,authenticated;

create function crm_private.bia_campaign_source_created()
returns trigger language plpgsql security definer set search_path='' as $$
declare j uuid;
begin
 j:=crm_private.bia_enqueue_campaign_source(case when tg_table_name='crm_public_form_submissions' then 'public_form' else 'meta' end,new.id);
 if j is not null then perform private.bia_dispatch_campaign_outreach();end if;
 return new;
exception when others then
 -- Keep lead capture available. The minute worker reconciles committed source rows.
 raise warning 'Bia campaign enqueue deferred; source=%, sqlstate=%',new.id,sqlstate;return new;
end $$;
revoke all on function crm_private.bia_campaign_source_created() from public,anon,authenticated;
create trigger bia_campaign_public_form_created after insert on private.crm_public_form_submissions for each row execute function crm_private.bia_campaign_source_created();
create trigger bia_campaign_meta_lead_created after insert on public.crm_opportunity_attributions for each row execute function crm_private.bia_campaign_source_created();

create function public.bia_campaign_outreach_worker(p_action text,p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare j crm_private.bia_campaign_outreach_jobs; cfg crm_private.bia_campaign_outreach_settings; reason text; r jsonb; src record; lead public.crm_records; o crm_private.bia_whatsapp_outbound;
begin
 perform crm_private.assert_public_agent_service_role();
 if p_action='claim' then
  -- Reconcile ingestion and interrupted leases without re-sending uncertain operations.
  for src in select s.id from private.crm_public_form_submissions s join crm_private.bia_campaign_outreach_settings c on c.public_form_slug=s.form_slug and c.organization_id=s.organization_id and c.enabled where s.created_at>=c.activated_at and s.created_at>now()-interval '24 hours' and s.original_created_at is null and not exists(select 1 from crm_private.bia_campaign_outreach_jobs q where q.source_type='public_form' and q.source_id=s.id) order by s.created_at limit 100 loop
   perform crm_private.bia_enqueue_campaign_source('public_form',src.id);
  end loop;
  for src in select a.id from public.crm_opportunity_attributions a join crm_private.bia_campaign_outreach_settings c on c.organization_id=a.organization_id and c.meta_campaign_id=a.campaign_id and c.meta_form_id=a.form_id and c.enabled where a.captured_at>=c.activated_at and a.created_at>now()-interval '24 hours' and not exists(select 1 from crm_private.bia_campaign_outreach_jobs q where q.source_type='meta' and q.source_id=a.id) order by a.created_at limit 100 loop
   perform crm_private.bia_enqueue_campaign_source('meta',src.id);
  end loop;
  for j in select * from crm_private.bia_campaign_outreach_jobs where status in('sending','processing') and lease_until<now() for update skip locked loop
   select * into o from crm_private.bia_whatsapp_outbound where id=j.id;
   if o.id is not null then
    update crm_private.bia_campaign_outreach_jobs set status=case when o.status in('accepted','sent','delivered','read') then 'sent' when o.status='failed' then 'failed' else 'unknown' end,error_code=coalesce(o.error_code,'BIA_CAMPAIGN_SEND_INTERRUPTED'),updated_at=now() where id=j.id;
    if o.status in('accepted','sent','delivered','read') then perform crm_private.bia_campaign_notice(j.id,'started');else perform crm_private.bia_campaign_notice(j.id,'attention');end if;
   else update crm_private.bia_campaign_outreach_jobs set status='pending',available_at=now(),updated_at=now() where id=j.id;end if;
  end loop;
  for j in select q.* from crm_private.bia_campaign_outreach_jobs q join crm_private.bia_campaign_outreach_settings c on c.id=q.settings_id and c.enabled where q.status in('pending','awaiting_template','awaiting_consent') and q.available_at<=now() order by q.created_at limit 25 for update of q skip locked loop
   reason:=crm_private.bia_campaign_block_reason(j.id);
   if reason is not null then
    update crm_private.bia_campaign_outreach_jobs set status=case when reason='BIA_CAMPAIGN_CONSENT_REQUIRED' then 'awaiting_consent' else 'skipped' end,error_code=reason,available_at=now()+interval '5 minutes',updated_at=now() where id=j.id;
    perform crm_private.bia_campaign_notice(j.id,'attention');continue;
   end if;
   update crm_private.bia_campaign_outreach_jobs set status='processing',lease=gen_random_uuid(),lease_until=now()+interval '3 minutes',attempts=attempts+1,updated_at=now() where id=j.id returning * into j;
   select * into cfg from crm_private.bia_campaign_outreach_settings where id=j.settings_id;
   return jsonb_build_object('id',j.id,'lease',j.lease,'organization_id',cfg.organization_id,'template_name',cfg.template_name,'phone',j.phone,'recipient_name',j.recipient_name);
  end loop;
  return '{}';
 end if;
 select * into j from crm_private.bia_campaign_outreach_jobs where id=(p_args->>'id')::uuid for update;
 if j.id is null or j.lease is distinct from (p_args->>'lease')::uuid or j.lease_until<=now() then raise exception 'BIA_CAMPAIGN_LEASE_CHANGED';end if;
 select * into cfg from crm_private.bia_campaign_outreach_settings where id=j.settings_id;
 if p_action='start' and j.status='processing' then
  select * into lead from public.crm_records where id=j.crm_record_id for update;
  perform 1 from public.contacts where id=lead.contact_id for update;
  reason:=crm_private.bia_campaign_block_reason(j.id);
  if reason is not null then
   update crm_private.bia_campaign_outreach_jobs set status='skipped',error_code=reason,updated_at=now() where id=j.id;perform crm_private.bia_campaign_notice(j.id,'attention');return jsonb_build_object('proceed',false);
  end if;
  r:=public.bia_whatsapp_outbound_admin(cfg.organization_id,cfg.actor_user_id,'start',
   jsonb_build_object('id',j.id,'campaignLease',j.lease,'phone',j.phone,'consent',true,'template',cfg.template_name,'hash',p_args->>'hash','body',p_args->>'body'));
  if r->>'proceed'='true' then
   update crm_private.bia_campaign_outreach_jobs set status='sending',updated_at=now() where id=j.id;
   select * into o from crm_private.bia_whatsapp_outbound where id=j.id;
   update crm_private.public_agent_sessions s set crm_record_id=lead.id,contact_id=lead.contact_id,
    contact_capture=s.contact_capture||jsonb_build_object('name',j.recipient_name,'phone','+'||j.phone),
    captured_profile=s.captured_profile||jsonb_strip_nulls(j.profile),contact_consent_at=(j.consent->>'at')::timestamptz,consent_copy_version=coalesce(j.consent->>'version','meta_custom_disclaimer')
   from crm_private.bia_whatsapp_threads t where t.id=o.thread_id and s.id=t.session_id;
  end if;return r;
 elsif p_action='finish' then
  return public.bia_whatsapp_outbound_admin(cfg.organization_id,cfg.actor_user_id,'finish',p_args);
 elsif p_action='defer' and j.status='processing' then
  reason:=left(p_args->>'error',128);
  update crm_private.bia_campaign_outreach_jobs set status=case when reason in('BIA_TEMPLATE_NOT_APPROVED','BIA_TEMPLATE_UNAVAILABLE') then 'awaiting_template' when reason in('BIA_CHANNEL_DISABLED','BIA_SEND_RATE_LIMIT') or attempts<3 then 'pending' else 'failed' end,error_code=reason,available_at=now()+interval '1 minute',updated_at=now() where id=j.id;
  if reason not in('BIA_SEND_RATE_LIMIT') then perform crm_private.bia_campaign_notice(j.id,'attention');end if;
  return jsonb_build_object('ok',true);
 end if;
 raise exception 'BIA_CAMPAIGN_ACTION_INVALID';
end $$;
revoke all on function public.bia_campaign_outreach_worker(text,jsonb) from public,anon,authenticated;
grant execute on function public.bia_campaign_outreach_worker(text,jsonb) to service_role;
select cron.schedule('evora-bia-campaign-outreach-1m','* * * * *','select private.bia_dispatch_campaign_outreach()');

CREATE OR REPLACE FUNCTION public.bia_whatsapp_outbound_admin(p_organization_id uuid, p_actor uuid, p_action text, p_args jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare ch crm_private.bia_whatsapp_channels; op crm_private.bia_whatsapp_outbound; th crm_private.bia_whatsapp_threads;
  rid uuid; v_phone text; body text; token text; fingerprint text; sid uuid; msg uuid; slug text;
begin
  perform crm_private.assert_public_agent_service_role();
  if p_actor is null or not exists(select 1 from public.organization_members m join public.organizations o on o.id=m.organization_id
    where m.user_id=p_actor and m.organization_id=p_organization_id and m.active and m.role='admin' and o.active) then
    raise exception 'BIA_OUTBOUND_FORBIDDEN' using errcode='42501'; end if;
  select * into ch from crm_private.bia_whatsapp_channels where organization_id=p_organization_id;
  if ch.id is null then raise exception 'BIA_CHANNEL_NOT_FOUND'; end if;
  if p_action='access' then return jsonb_build_object('enabled',ch.enabled and ch.webhook_verified_at is not null); end if;
  if p_action='recipient' then
    if coalesce(p_args->>'phone','') !~ '^55[1-9][0-9][0-9]{8,9}$' then raise exception 'BIA_PHONE_INVALID'; end if;
    -- Only a unique CRM name for this organization and phone can personalize outreach.
    return jsonb_build_object('name',(select case when count(distinct trim(r.person_name))=1 then min(trim(r.person_name)) end
      from public.crm_records r where r.organization_id=p_organization_id
      and nullif(trim(r.person_name),'') is not null
      and crm_private.bia_phone_key(case when length(regexp_replace(r.phone,'[^0-9]','','g')) in(10,11)
        then '55'||regexp_replace(r.phone,'[^0-9]','','g') else regexp_replace(r.phone,'[^0-9]','','g') end)
        =crm_private.bia_phone_key(p_args->>'phone')));
  end if;
  rid:=(p_args->>'id')::uuid;
  if rid is null then raise exception 'BIA_REQUEST_INVALID'; end if;
  -- A channel lock serializes reservation and prevents simultaneous duplicate outreach.
  perform pg_advisory_xact_lock(hashtextextended('bia-outbound:'||ch.id::text,0));
  select * into op from crm_private.bia_whatsapp_outbound where id=rid for update;
  if op.id is not null and op.channel_id<>ch.id then raise exception 'BIA_OUTBOUND_FORBIDDEN' using errcode='42501'; end if;
  if p_action='status' then
    if op.id is null then return jsonb_build_object('id',rid,'status','not_found'); end if;
    return crm_private.bia_outbound_result(op);
  elsif p_action='start' then
    v_phone:=p_args->>'phone';body:=p_args->>'body';
    if coalesce(v_phone,'') !~ '^55[1-9][0-9][0-9]{8,9}$' or coalesce(length(body),0) not between 1 and 4000
      or ((p_args->>'template' is distinct from 'bia_indicacao_investimento' or exists(select 1 from crm_private.bia_campaign_outreach_jobs where id=rid))
        and not crm_private.bia_campaign_reservation_valid(rid,(p_args->>'campaignLease')::uuid,p_args->>'template',v_phone,p_actor,p_organization_id)) or coalesce(p_args->>'hash','') !~ '^[a-f0-9]{64}$'
      or p_args->'consent' is distinct from 'true'::jsonb then raise exception 'BIA_REQUEST_INVALID'; end if;
    if op.id is not null then
      if op.phone<>v_phone or op.template_hash<>p_args->>'hash' or (select content from crm_private.bia_whatsapp_messages where id=op.message_id) is distinct from body then raise exception 'BIA_REQUEST_CHANGED'; end if;
      return crm_private.bia_outbound_result(op)||jsonb_build_object('proceed',false);
    end if;
    if not ch.enabled or ch.webhook_verified_at is null then raise exception 'BIA_CHANNEL_DISABLED'; end if;
    if crm_private.bia_phone_key(v_phone)=crm_private.bia_phone_key(regexp_replace(ch.display_phone_number,'[^0-9]','','g')) then raise exception 'BIA_SELF_RECIPIENT'; end if;
    if exists(select 1 from crm_private.bia_whatsapp_outbound q where q.channel_id=ch.id
      and crm_private.bia_phone_key(q.phone)=crm_private.bia_phone_key(v_phone) and q.created_at>now()-interval '24 hours'
      and q.status<>'failed') then raise exception 'BIA_CONTACT_RECENTLY_SENT'; end if;
    if (select count(*) from crm_private.bia_whatsapp_outbound q where q.channel_id=ch.id and q.created_at>now()-interval '1 minute')>=5 then raise exception 'BIA_SEND_RATE_LIMIT'; end if;
    perform pg_advisory_xact_lock(hashtextextended('bia:'||ch.id::text||':'||crm_private.bia_phone_key(v_phone),0));
    if exists(select 1 from crm_private.bia_whatsapp_threads t where t.channel_id=ch.id
      and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(v_phone) and (t.opted_out_at is not null or t.human_requested)) then raise exception 'BIA_CONTACT_PAUSED'; end if;
    select * into th from crm_private.bia_whatsapp_threads t where t.channel_id=ch.id
      and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(v_phone) order by (t.peer_phone=v_phone) desc,t.created_at limit 1;
    if th.id is null then
      select e.slug into slug from crm_private.public_agent_experiences e where e.id=ch.experience_id and e.active;
      if slug is null then raise exception 'BIA_EXPERIENCE_INACTIVE'; end if;
      token:=encode(extensions.gen_random_bytes(32),'hex');fingerprint:=encode(extensions.gen_random_bytes(32),'hex');
      sid:=(public.open_public_agent_session(slug,token,fingerprint,jsonb_build_object('source','whatsapp'),'whatsapp',null,'Bia WhatsApp Cloud API')->>'sessionId')::uuid;
      insert into crm_private.bia_whatsapp_threads(channel_id,peer_phone,session_id,token_hash,fingerprint_hash)
        values(ch.id,v_phone,sid,token,fingerprint) returning * into th;
      -- Operator confirms existing WhatsApp opt-in; no fictitious customer reply or CRM conversion.
      update crm_private.public_agent_sessions set contact_capture=contact_capture||jsonb_build_object('phone','+'||v_phone),
        contact_consent_at=now(),consent_copy_version='operator_whatsapp_optin_v1' where id=sid;
    end if;
    if exists(select 1 from crm_private.public_agent_sessions where id=th.session_id and status in('closed','blocked')) then raise exception 'BIA_SESSION_INACTIVE'; end if;
    update crm_private.public_agent_sessions set expires_at=greatest(expires_at,now()+interval '14 days') where id=th.session_id;
    insert into crm_private.bia_whatsapp_messages(thread_id,provider_message_id,direction,content,message_type,delivery_status,metadata,occurred_at)
      values(th.id,'bia-template:'||rid,'outbound',body,'template','sending',jsonb_build_object('outbound_id',rid,'template',p_args->>'template'),now()) returning id into msg;
    insert into crm_private.bia_whatsapp_outbound(id,channel_id,actor_user_id,thread_id,message_id,phone,template_name,template_hash,status)
      values(rid,ch.id,p_actor,th.id,msg,v_phone,p_args->>'template',p_args->>'hash','sending') returning * into op;
    return crm_private.bia_outbound_result(op)||jsonb_build_object('proceed',true);
  elsif p_action='finish' and op.id is not null then
    if p_args->>'status'='accepted' then
      if not crm_private.bia_outbound_status(ch.id,jsonb_build_object('operation_id',rid,'provider_message_id',p_args->>'providerMessageId',
        'recipient_phone',p_args->>'recipientPhone','status','accepted')) then raise exception 'BIA_SEND_RESULT_INVALID'; end if;
    elsif p_args->>'status' in('failed','unknown') and op.status='sending' then
      update crm_private.bia_whatsapp_outbound set status=p_args->>'status',error_code=left(p_args->>'errorCode',80),updated_at=now() where id=rid;
      update crm_private.bia_whatsapp_messages set delivery_status=p_args->>'status',metadata=metadata||jsonb_build_object('error_code',left(p_args->>'errorCode',80)) where id=op.message_id;
    end if;
    select * into op from crm_private.bia_whatsapp_outbound where id=rid;
    return crm_private.bia_outbound_result(op);
  end if;
  raise exception 'BIA_ACTION_INVALID';
end $function$
;
CREATE OR REPLACE FUNCTION public.get_public_agent_gateway_context_v1(p_slug text, p_session_token_hash text, p_fingerprint_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  session_row crm_private.public_agent_sessions%rowtype;
  visit_row crm_private.public_agent_visit_state%rowtype;
  hold_value jsonb;
begin
  perform crm_private.assert_public_agent_service_role();

  select session.*
    into session_row
  from crm_private.public_agent_sessions session
  join crm_private.public_agent_experiences experience
    on experience.id = session.experience_id
  where experience.slug = lower(trim(p_slug))
    and experience.active
    and session.session_token_hash = p_session_token_hash
    and session.fingerprint_hash = p_fingerprint_hash;

  if not found then
    raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND';
  end if;

  select visit.*
    into visit_row
  from crm_private.public_agent_visit_state visit
  where visit.session_id = session_row.id;

  if to_regprocedure('public.get_public_agent_hold_status(text,text,text)') is not null then
    begin
      hold_value := public.get_public_agent_hold_status(
        p_slug,
        p_session_token_hash,
        p_fingerprint_hash
      );
    exception when others then
      hold_value := null;
    end;
  end if;

  return jsonb_strip_nulls(jsonb_build_object(
    'sessionId', session_row.id,
    'organizationId', session_row.organization_id,
    'crmRecordId', session_row.crm_record_id,
    'converted', session_row.crm_record_id is not null,
    'stage', session_row.stage,
    'profile', session_row.captured_profile,
    'contactCapture', session_row.contact_capture,
    'serviceConsented', session_row.contact_consent_at is not null,
    'marketingConsented', session_row.marketing_consent,
    'leadProtocol', case when session_row.crm_record_id is not null
      then upper(left(replace(session_row.crm_record_id::text, '-', ''), 10))
      else null end,
    'visitState', case when visit_row.session_id is not null then jsonb_strip_nulls(jsonb_build_object(
      'phase', visit_row.phase,
      'unitCode', visit_row.unit_code,
      'localDate', visit_row.local_date,
      'requestedAt', visit_row.requested_at,
      'updatedAt', visit_row.updated_at
    )) else null end,
    'campaignContext', (select cfg.campaign_context||jsonb_build_object('knownAnswers',j.profile)
      from crm_private.bia_campaign_outreach_jobs j join crm_private.bia_campaign_outreach_settings cfg on cfg.id=j.settings_id
      join crm_private.bia_whatsapp_outbound o on o.id=j.id join crm_private.bia_whatsapp_threads t on t.id=o.thread_id
      where t.session_id=session_row.id and cfg.organization_id=session_row.organization_id and o.status in('accepted','sent','delivered','read')
      order by j.created_at desc limit 1),
    'holdStatus', hold_value
  ));
end
$function$
;
CREATE OR REPLACE FUNCTION public.arisa_my_notifications(p_organization_id uuid, p_limit integer DEFAULT 20, p_offset integer DEFAULT 0, p_unread_only boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare v_result jsonb;v_unread bigint;v_total bigint;
begin
 if auth.uid() is null or not public.is_org_member(p_organization_id) then raise exception 'MEMBER_REQUIRED' using errcode='42501';end if;
 select count(*),count(*) filter(where read_at is null) into v_total,v_unread from public.activity_notifications
 where organization_id=p_organization_id and recipient_user_id=auth.uid() and metadata->>'source' in('arisa_whatsapp','bia_whatsapp');
 select coalesce(jsonb_agg(to_jsonb(item) order by item.created_at desc,item.id desc),'[]'::jsonb) into v_result from(
  select n.id,n.title,n.message,n.read_at,n.created_at,n.metadata,coalesce(m.occurred_at,n.created_at) as requested_at,
   jsonb_build_object(
    'today',to_char(coalesce(m.occurred_at,n.created_at) at time zone 'America/Sao_Paulo','YYYY-MM-DD'),
    'tomorrow',to_char((coalesce(m.occurred_at,n.created_at) at time zone 'America/Sao_Paulo')::date+1,'YYYY-MM-DD'),
    'yesterday',to_char((coalesce(m.occurred_at,n.created_at) at time zone 'America/Sao_Paulo')::date-1,'YYYY-MM-DD')
   ) as reference_dates
  from public.activity_notifications n left join public.arisa_whatsapp_messages m
   on m.organization_id=n.organization_id and m.id=case when n.metadata->>'source_message_id' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then (n.metadata->>'source_message_id')::uuid else null end
  where n.organization_id=p_organization_id and n.recipient_user_id=auth.uid() and n.metadata->>'source' in('arisa_whatsapp','bia_whatsapp') and (not p_unread_only or n.read_at is null)
  order by n.created_at desc,n.id desc limit least(greatest(coalesce(p_limit,20),1),100) offset greatest(coalesce(p_offset,0),0)
 )item;
 return jsonb_build_object('items',v_result,'unread_count',v_unread,'total',v_total,'as_of',now());
end $function$
;
CREATE OR REPLACE FUNCTION public.arisa_mark_notifications_read(p_organization_id uuid, p_ids uuid[])
 RETURNS integer
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare changed integer;
begin
 if auth.uid() is null or not public.is_org_member(p_organization_id) then raise exception 'MEMBER_REQUIRED' using errcode='42501';end if;
 if cardinality(p_ids)>100 then raise exception 'TOO_MANY_NOTIFICATIONS';end if;
 update public.activity_notifications set read_at=now() where id=any(p_ids) and organization_id=p_organization_id and recipient_user_id=auth.uid() and metadata->>'source' in('arisa_whatsapp','bia_whatsapp') and read_at is null;
 get diagnostics changed=row_count;return changed;
end $function$
;

