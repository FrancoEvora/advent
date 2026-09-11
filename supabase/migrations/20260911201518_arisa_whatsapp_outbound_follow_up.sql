-- A continuation is an exact outbound message, never the manager's private chat.
alter table crm_private.arisa_whatsapp_reply_jobs add column if not exists follow_up_message_id uuid references public.arisa_whatsapp_messages(id) on delete set null;
alter table crm_private.arisa_whatsapp_reply_jobs add column if not exists follow_up_completed boolean not null default false;
create index if not exists arisa_reply_follow_up_idx on crm_private.arisa_whatsapp_reply_jobs(follow_up_message_id) where follow_up_message_id is not null;

create or replace function private.arisa_whatsapp_pending_follow_up(p_org uuid,p_thread uuid,p_inbound uuid)
returns jsonb language sql stable security invoker set search_path='' as $function$
  select jsonb_build_object('message_id',last_out.id,'content',last_out.metadata->>'follow_up','requested_at',last_out.occurred_at)
  from (
    -- A newer manual message replaces the old purpose, including an ordinary text or greeting.
    select m.*,o.actor_user_id,o.send_mode,o.status as operation_status
    from public.arisa_whatsapp_messages m join public.arisa_whatsapp_operations o on o.id=m.operation_id and o.organization_id=m.organization_id and o.thread_id=m.thread_id
    join public.arisa_chat_messages source on source.id=o.source_message_id and source.organization_id=o.organization_id and source.owner_user_id=o.actor_user_id and source.role='user'
    where m.organization_id=p_org and m.thread_id=p_thread and m.direction='outbound' and o.status in('prepared','queued','completed','unknown')
    order by m.occurred_at desc,m.created_at desc,m.id desc limit 1
  ) last_out
  join public.arisa_whatsapp_messages inbound on inbound.id=p_inbound and inbound.organization_id=p_org and inbound.thread_id=p_thread and inbound.direction='inbound'
  where last_out.send_mode='template' and last_out.operation_status='completed'
    and last_out.delivery_status in('accepted','sent','delivered','read')
    and private.arisa_actor_admin(p_org,last_out.actor_user_id)
    and last_out.occurred_at>now()-interval '7 days' and last_out.occurred_at<=inbound.occurred_at
    and jsonb_typeof(last_out.metadata->'follow_up')='string' and length(trim(last_out.metadata->>'follow_up')) between 1 and 3000
    and not exists(select 1 from crm_private.arisa_whatsapp_reply_jobs done where done.organization_id=p_org and done.thread_id=p_thread and done.follow_up_message_id=last_out.id and done.follow_up_completed and done.status in('sending','sent','unknown'));
$function$;
revoke all on function private.arisa_whatsapp_pending_follow_up(uuid,uuid,uuid) from public,anon,authenticated;

CREATE OR REPLACE FUNCTION public.arisa_whatsapp_service(p_action text, p_org uuid, p_actor uuid, p_args jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  op public.arisa_whatsapp_operations;ct public.contacts;th public.arisa_whatsapp_threads;msg public.arisa_whatsapp_messages;
  rt crm_private.whatsapp_runtime_settings;ch crm_private.arisa_whatsapp_channel;
  v_phone text;v_content text;v_template text;v_lang text;v_components jsonb;v_window boolean;v_result jsonb;v_count integer;v_limit integer;v_offset integer;v_fresh boolean;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' or not private.arisa_actor_admin(p_org,p_actor) then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
  select * into rt from crm_private.whatsapp_runtime_settings where organization_id=p_org;
  select * into ch from crm_private.arisa_whatsapp_channel where organization_id=p_org;
  if p_action='status' then
    return jsonb_build_object('enabled',coalesce(ch.enabled,false),'configured',rt.phone_number_id is not null and rt.waba_id is not null and rt.graph_api_version is not null and rt.access_token_vault_id is not null and rt.app_secret_vault_id is not null and rt.verify_token_vault_id is not null,'ready',coalesce(ch.enabled,false) and rt.phone_number_id is not null and rt.waba_id is not null and rt.graph_api_version is not null and rt.access_token_vault_id is not null and rt.app_secret_vault_id is not null and rt.verify_token_vault_id is not null and (ch.webhook_verified_at is not null or ch.webhook_confirmed_at is not null),'legacy_crm_enabled',coalesce(rt.enabled,false),'mode','administrative','waba_id',rt.waba_id,'phone_number_id',rt.phone_number_id,'graph_api_version',rt.graph_api_version,'display_phone_number',rt.display_phone_number,'access_token_configured',rt.access_token_vault_id is not null,'app_secret_configured',rt.app_secret_vault_id is not null,'verify_token_configured',rt.verify_token_vault_id is not null,'webhook_path','/api/integrations/whatsapp/webhook','webhook_confirmed',ch.webhook_confirmed_at is not null or ch.webhook_verified_at is not null,'webhook_verified_at',ch.webhook_verified_at,'last_inbound_at',(select max(last_inbound_at) from public.arisa_whatsapp_threads where organization_id=p_org),'auto_reply_enabled',coalesce(ch.auto_reply_enabled,false));
  elsif p_action='configure' then
    if jsonb_typeof(p_args->'enabled') is distinct from 'boolean' then raise exception 'WHATSAPP_INVALID';end if;
    if (p_args->>'enabled')::boolean and (rt.phone_number_id is null or rt.waba_id is null or rt.graph_api_version is null or rt.access_token_vault_id is null or rt.app_secret_vault_id is null or rt.verify_token_vault_id is null) then raise exception 'WHATSAPP_NOT_CONFIGURED';end if;
    if (p_args->>'enabled')::boolean and ch.webhook_verified_at is null and ch.webhook_confirmed_at is null and coalesce(p_args->>'webhook_confirmed','false')<>'true' then raise exception 'WHATSAPP_WEBHOOK_REQUIRED';end if;
    insert into crm_private.arisa_whatsapp_channel(organization_id,enabled,webhook_confirmed_at,updated_by) values(p_org,(p_args->>'enabled')::boolean,case when p_args->>'webhook_confirmed'='true' then now() end,p_actor) on conflict(organization_id) do update set enabled=excluded.enabled,webhook_confirmed_at=coalesce(excluded.webhook_confirmed_at,crm_private.arisa_whatsapp_channel.webhook_confirmed_at),updated_by=p_actor,updated_at=now();
    if p_args ? 'auto_reply_enabled' then
      if jsonb_typeof(p_args->'auto_reply_enabled') is distinct from 'boolean' then raise exception 'WHATSAPP_INVALID';end if;
      if (p_args->>'auto_reply_enabled')::boolean and coalesce(rt.enabled,false) then raise exception 'WHATSAPP_REPLY_DEDICATED_CHANNEL_REQUIRED';end if;
      update crm_private.arisa_whatsapp_channel set auto_reply_enabled=(p_args->>'auto_reply_enabled')::boolean where organization_id=p_org;
    end if;
    return public.arisa_whatsapp_service('status',p_org,p_actor);
  elsif p_action='list' then
    v_limit=least(greatest(coalesce((p_args->>'limit')::integer,50),1),100);v_offset=greatest(coalesce((p_args->>'offset')::integer,0),0);
    select coalesce(jsonb_agg(row_value order by occurred_at desc,id desc),'[]'::jsonb) into v_result from (
      select m.id,m.occurred_at,jsonb_build_object('id',m.id,'thread_id',m.thread_id,'operation_id',m.operation_id,'direction',m.direction,'content',m.content,'message_type',m.message_type,'contact_id',t.contact_id,'contact_name',coalesce(c.name,t.contact_name),'phone',t.phone,'occurred_at',m.occurred_at,'status',o.status,'delivery_status',m.delivery_status,'template_name',o.template_name,'provider_message_id',m.provider_message_id,'metadata',m.metadata) row_value
      from public.arisa_whatsapp_messages m join public.arisa_whatsapp_threads t on t.id=m.thread_id left join public.contacts c on c.id=t.contact_id left join public.arisa_whatsapp_operations o on o.id=m.operation_id
      where m.organization_id=p_org and (nullif(p_args->>'thread_id','') is null or t.id=(p_args->>'thread_id')::uuid) and (nullif(p_args->>'contact_id','') is null or t.contact_id=(p_args->>'contact_id')::uuid) and (nullif(p_args->>'phone','') is null or t.phone=regexp_replace(p_args->>'phone','[^0-9]','','g'))
      order by m.occurred_at desc,m.id desc limit v_limit+1 offset v_offset
    ) rows;
    return jsonb_build_object('messages',case when jsonb_array_length(v_result)>v_limit then v_result-v_limit else v_result end,'has_more',jsonb_array_length(v_result)>v_limit,'next_offset',v_offset+v_limit);
  elsif p_action='resolve' then
    v_phone=regexp_replace(coalesce(p_args->>'phone',''),'[^0-9]','','g');
    if nullif(p_args->>'contact_id','') is not null then
      select * into ct from public.contacts where id=(p_args->>'contact_id')::uuid and organization_id=p_org and active;
      if not found then raise exception 'WHATSAPP_CONTACT_NOT_FOUND';end if;
      if v_phone<>'' and v_phone<>regexp_replace(coalesce(ct.phone,''),'[^0-9]','','g') then raise exception 'WHATSAPP_CONTACT_PHONE_MISMATCH';end if;
      v_phone=regexp_replace(coalesce(ct.phone,''),'[^0-9]','','g');
    end if;
    if v_phone!~'^[1-9][0-9]{7,14}$' then raise exception 'WHATSAPP_PHONE_INVALID';end if;
    if ct.id is null then
      select count(*) into v_count from public.contacts c where c.organization_id=p_org and c.active and regexp_replace(coalesce(c.phone,''),'[^0-9]','','g')=v_phone;
      if v_count>1 then raise exception 'WHATSAPP_CONTACT_AMBIGUOUS';end if;
      select * into ct from public.contacts c where c.organization_id=p_org and c.active and regexp_replace(coalesce(c.phone,''),'[^0-9]','','g')=v_phone;
    end if;
    if ct.do_not_contact_at is not null or lower(coalesce(ct.marketing_consent_status,'')) in('denied','revoked') then raise exception 'WHATSAPP_CONTACT_BLOCKED' using errcode='42501';end if;
    return jsonb_build_object('phone',v_phone,'contact_id',ct.id,'contact_name',ct.name);
  elsif p_action='prepare' then
    if not coalesce(ch.enabled,false) or rt.phone_number_id is null then raise exception 'WHATSAPP_NOT_CONFIGURED';end if;
    if coalesce(p_args->>'operation_key','')!~'^[a-f0-9]{64}$' or coalesce(p_args->>'payload_hash','')!~'^[a-f0-9]{64}$' then raise exception 'WHATSAPP_INVALID';end if;
    perform pg_advisory_xact_lock(hashtextextended('arisa-whatsapp:'||p_org::text||':'||(p_args->>'operation_key'),0));
    select * into op from public.arisa_whatsapp_operations where organization_id=p_org and operation_key=p_args->>'operation_key' for update;
    if found then
      if op.actor_user_id<>p_actor then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
      if op.payload_hash<>p_args->>'payload_hash' then raise exception 'WHATSAPP_REQUEST_CHANGED';end if;
      return to_jsonb(op)||jsonb_build_object('proceed',false);
    end if;
    if nullif(p_args->>'message_id','') is not null and not exists(select 1 from public.arisa_chat_messages m where m.id=(p_args->>'message_id')::uuid and m.organization_id=p_org and m.owner_user_id=p_actor and m.role='user' and m.status='processing' and m.lease_token=(p_args->>'lease')::uuid and m.lease_expires_at>now()) then raise exception 'ARISA_LEASE_CHANGED';end if;
    if p_args ? 'follow_up' and (jsonb_typeof(p_args->'follow_up') is distinct from 'string' or length(p_args->>'follow_up')>3000) then raise exception 'WHATSAPP_INVALID';end if;
    if nullif(trim(p_args->>'follow_up'),'') is not null and (nullif(p_args->>'message_id','') is null or nullif(p_args->>'template_name','') is null) then raise exception 'WHATSAPP_INVALID';end if;
    v_content=trim(coalesce(p_args->>'content',''));if length(v_content) not between 1 and 12000 then raise exception 'WHATSAPP_INVALID';end if;
    v_phone=regexp_replace(coalesce(p_args->>'phone',''),'[^0-9]','','g');
    if nullif(p_args->>'contact_id','') is not null then
      select * into ct from public.contacts where id=(p_args->>'contact_id')::uuid and organization_id=p_org and active;
      if not found then raise exception 'WHATSAPP_CONTACT_NOT_FOUND';end if;
      if v_phone<>'' and v_phone<>regexp_replace(coalesce(ct.phone,''),'[^0-9]','','g') then raise exception 'WHATSAPP_CONTACT_PHONE_MISMATCH';end if;
      v_phone=regexp_replace(coalesce(ct.phone,''),'[^0-9]','','g');
    end if;
    if v_phone!~'^[1-9][0-9]{7,14}$' then raise exception 'WHATSAPP_PHONE_INVALID';end if;
    if ct.id is null then
      select count(*) into v_count from public.contacts c where c.organization_id=p_org and c.active and regexp_replace(coalesce(c.phone,''),'[^0-9]','','g')=v_phone;
      if v_count>1 then raise exception 'WHATSAPP_CONTACT_AMBIGUOUS';end if;
      select * into ct from public.contacts c where c.organization_id=p_org and c.active and regexp_replace(coalesce(c.phone,''),'[^0-9]','','g')=v_phone;
    end if;
    if ct.do_not_contact_at is not null or lower(coalesce(ct.marketing_consent_status,'')) in('denied','revoked') then raise exception 'WHATSAPP_CONTACT_BLOCKED' using errcode='42501';end if;
    insert into public.arisa_whatsapp_threads(organization_id,phone_number_id,phone,contact_id,contact_name,created_by) values(p_org,rt.phone_number_id,v_phone,ct.id,coalesce(ct.name,nullif(left(trim(p_args->>'contact_name'),180),'')),p_actor) on conflict(organization_id,phone_number_id,phone) do update set contact_id=coalesce(excluded.contact_id,public.arisa_whatsapp_threads.contact_id),contact_name=coalesce(excluded.contact_name,public.arisa_whatsapp_threads.contact_name) returning * into th;
    if th.opted_out_at is not null then raise exception 'WHATSAPP_CONTACT_BLOCKED' using errcode='42501';end if;
    v_window=th.last_inbound_at is not null and th.last_inbound_at>now()-interval '24 hours' and th.last_inbound_at<=now();
    v_template=nullif(trim(p_args->>'template_name'),'');v_lang=coalesce(nullif(trim(p_args->>'template_language'),''),'pt_BR');v_components=coalesce(p_args->'template_components','[]'::jsonb);
    if jsonb_typeof(v_components)<>'array' or pg_column_size(v_components)>32768 then raise exception 'WHATSAPP_INVALID';end if;
    if not v_window and v_template is null then raise exception 'WHATSAPP_TEMPLATE_REQUIRED';end if;
    if v_template is null and length(v_content)>4096 then raise exception 'WHATSAPP_INVALID';end if;
    insert into public.arisa_whatsapp_operations(organization_id,actor_user_id,source_message_id,operation_key,payload_hash,contact_id,phone,phone_number_id,thread_id,send_mode,template_name,template_language,template_components) values(p_org,p_actor,nullif(p_args->>'message_id','')::uuid,p_args->>'operation_key',p_args->>'payload_hash',ct.id,v_phone,rt.phone_number_id,th.id,case when v_template is null then 'freeform' else 'template' end,v_template,v_lang,v_components) returning * into op;
    insert into public.arisa_whatsapp_messages(organization_id,thread_id,operation_id,direction,content,metadata) values(p_org,th.id,op.id,'outbound',v_content,jsonb_build_object('send_mode',op.send_mode,'template_name',v_template,'template_components',v_components,'requested_content',p_args->>'requested_content','follow_up',nullif(trim(p_args->>'follow_up'),'' ))) returning * into msg;
    update public.arisa_whatsapp_operations set channel_message_id=msg.id where id=op.id returning * into op;
    return to_jsonb(op)||jsonb_build_object('proceed',true,'window_open',v_window,'last_inbound_at',th.last_inbound_at);
  elsif p_action in('get','claim','finish','fail') then
    select * into op from public.arisa_whatsapp_operations where id=(p_args->>'id')::uuid and organization_id=p_org and actor_user_id=p_actor for update;
    if not found then raise exception 'WHATSAPP_NOT_FOUND';end if;
    select * into msg from public.arisa_whatsapp_messages where id=op.channel_message_id and organization_id=p_org;
    if p_action='get' then return to_jsonb(op)||jsonb_build_object('delivery_status',msg.delivery_status,'provider_message_id',msg.provider_message_id,'content',msg.content);end if;
    if p_action='claim' then
      if op.status<>'prepared' then return to_jsonb(op)||jsonb_build_object('proceed',false);end if;
      if not coalesce(ch.enabled,false) or rt.phone_number_id is distinct from op.phone_number_id then raise exception 'WHATSAPP_NOT_CONFIGURED';end if;
      select * into th from public.arisa_whatsapp_threads where id=op.thread_id and organization_id=p_org for update;
      select * into ct from public.contacts where id=op.contact_id and organization_id=p_org;
      if (op.contact_id is not null and (ct.id is null or not ct.active)) or ct.do_not_contact_at is not null or lower(coalesce(ct.marketing_consent_status,'')) in('denied','revoked') or th.opted_out_at is not null then raise exception 'WHATSAPP_CONTACT_BLOCKED' using errcode='42501';end if;
      if ct.id is not null and regexp_replace(coalesce(ct.phone,''),'[^0-9]','','g')<>op.phone then raise exception 'WHATSAPP_CONTACT_PHONE_MISMATCH';end if;
      v_window=th.last_inbound_at is not null and th.last_inbound_at>now()-interval '24 hours' and th.last_inbound_at<=now();
      if op.send_mode='freeform' and not v_window then raise exception 'WHATSAPP_TEMPLATE_REQUIRED';end if;
      update public.arisa_whatsapp_operations set status='queued',updated_at=now() where id=op.id returning * into op;
      update public.arisa_whatsapp_messages set delivery_status='queued' where id=msg.id;
      return to_jsonb(op)||jsonb_build_object('proceed',true,'content',msg.content,'window_open',v_window,'last_inbound_at',th.last_inbound_at);
    elsif p_action='finish' then
      if op.status='completed' then return op.result||jsonb_build_object('delivery_status',msg.delivery_status,'provider_message_id',msg.provider_message_id);end if;
      if length(coalesce(p_args->>'provider_message_id','')) not between 8 and 512 then raise exception 'WHATSAPP_INVALID';end if;
      if msg.provider_message_id is not null and msg.provider_message_id<>p_args->>'provider_message_id' then raise exception 'WHATSAPP_REQUEST_CHANGED';end if;
      update public.arisa_whatsapp_messages set provider_message_id=p_args->>'provider_message_id',delivery_status=case when delivery_status in('sent','delivered','read','failed') then delivery_status else 'accepted' end,metadata=metadata||jsonb_build_object('accepted_at',now()) where id=msg.id returning * into msg;
      v_result=jsonb_build_object('ok',true,'operation_id',op.id,'message_id',msg.id,'provider_message_id',msg.provider_message_id,'delivery_status',msg.delivery_status,'send_mode',op.send_mode,'phone',op.phone,'content',msg.content,'template_name',op.template_name,'accepted_by_meta',true,'delivered',msg.delivery_status in('delivered','read'),'read',msg.delivery_status='read');
      update public.arisa_whatsapp_operations set status='completed',result=v_result,error_code=null,updated_at=now() where id=op.id;
      update public.arisa_whatsapp_threads set last_message_at=greatest(last_message_at,now()) where id=op.thread_id;
      if op.source_message_id is not null then insert into public.arisa_chat_actions(organization_id,actor_user_id,message_id,operation_key,action,entity,record_id,summary,result) values(p_org,p_actor,op.source_message_id,op.operation_key,'send','whatsapp',msg.id::text,'WhatsApp aceito pela Meta para +'||op.phone,v_result) on conflict do nothing;end if;
      perform private.arisa_archive_put(p_org,p_actor,'arisa_whatsapp_operations',op.id::text,'platform','action','arisa','whatsapp:'||msg.id,'WhatsApp','WhatsApp para +'||op.phone,msg.content,v_result,now(),false);
      return v_result;
    else
      if op.status='completed' then return jsonb_build_object('ok',true,'status','completed');end if;
      update public.arisa_whatsapp_operations set status=case when p_args->>'status'='failed' then 'failed' else 'unknown' end,error_code=left(coalesce(p_args->>'error','WHATSAPP_UNAVAILABLE'),128),updated_at=now() where id=op.id;
      update public.arisa_whatsapp_messages set delivery_status=case when p_args->>'status'='failed' then 'failed' else 'unknown' end,metadata=metadata||jsonb_build_object('error_code',left(coalesce(p_args->>'error','WHATSAPP_UNAVAILABLE'),128)) where id=msg.id and provider_message_id is null;
      return jsonb_build_object('ok',true);
    end if;
  end if;
  raise exception 'WHATSAPP_INVALID';
end $function$
;
CREATE OR REPLACE FUNCTION public.arisa_whatsapp_reply_worker(p_action text, p_args jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare j crm_private.arisa_whatsapp_reply_jobs;t public.arisa_whatsapp_threads;c public.contacts;m public.arisa_whatsapp_messages;history jsonb;reason text;v_result jsonb;follow_up jsonb;resolution text;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'SERVICE_REQUIRED' using errcode='42501';end if;
  if p_action='claim' then
    update crm_private.arisa_whatsapp_reply_jobs set status='unknown',error_code='WHATSAPP_REPLY_SEND_INTERRUPTED',updated_at=now() where status='sending' and lease_until<now();
    update crm_private.arisa_whatsapp_reply_jobs set status=case when attempts<3 then 'pending' else 'failed' end,available_at=now(),lease=null,lease_until=null,updated_at=now() where status='processing' and lease_until<now();
    for j in select q.* from crm_private.arisa_whatsapp_reply_jobs q where q.status='pending' and q.available_at<=now()
      and not exists(select 1 from crm_private.arisa_whatsapp_reply_jobs other where other.thread_id=q.thread_id and other.status in('processing','sending') and other.lease_until>=now())
      order by q.created_at,q.id limit 30 for update skip locked loop
      -- Serialize claims per conversation even when two different jobs are claimed concurrently.
      if not pg_try_advisory_xact_lock(hashtextextended('arisa-whatsapp-reply:'||j.thread_id::text,0)) then continue;end if;
      if exists(select 1 from crm_private.arisa_whatsapp_reply_jobs other where other.thread_id=j.thread_id and other.id<>j.id and other.status in('processing','sending') and other.lease_until>=now()) then continue;end if;
      select * into t from public.arisa_whatsapp_threads where id=j.thread_id and organization_id=j.organization_id;
      select * into c from public.contacts where id=t.contact_id and organization_id=j.organization_id;
      select * into m from public.arisa_whatsapp_messages where id=j.id;
      reason=null;
      if not exists(select 1 from crm_private.arisa_whatsapp_channel ch join crm_private.whatsapp_runtime_settings rt using(organization_id) where ch.organization_id=j.organization_id and ch.enabled and ch.auto_reply_enabled and not rt.enabled and rt.phone_number_id=t.phone_number_id) or not private.arisa_actor_admin(j.organization_id,j.actor_user_id) then reason='WHATSAPP_REPLY_DISABLED';
      elsif t.opted_out_at is not null or (t.contact_id is not null and (c.id is null or not c.active)) or c.do_not_contact_at is not null or lower(coalesce(c.marketing_consent_status,'')) in('denied','revoked') then reason='WHATSAPP_CONTACT_BLOCKED';
      elsif m.occurred_at<=now()-interval '24 hours' then reason='WHATSAPP_REPLY_EXPIRED';
      elsif exists(select 1 from public.arisa_whatsapp_messages newer where newer.thread_id=j.thread_id and newer.direction='inbound' and (newer.occurred_at,newer.created_at,newer.id)>(m.occurred_at,m.created_at,m.id)) then reason='WHATSAPP_REPLY_SUPERSEDED';end if;
      if reason is not null then update crm_private.arisa_whatsapp_reply_jobs set status='skipped',error_code=reason,updated_at=now() where id=j.id;continue;end if;
      follow_up=private.arisa_whatsapp_pending_follow_up(j.organization_id,j.thread_id,j.id);
      update crm_private.arisa_whatsapp_reply_jobs set follow_up_message_id=nullif(follow_up->>'message_id','')::uuid,follow_up_completed=false,status='processing',attempts=attempts+1,lease=gen_random_uuid(),lease_until=now()+interval '3 minutes',updated_at=now() where id=j.id returning * into j;
      select coalesce(jsonb_agg(jsonb_build_object('id',h.id,'direction',h.direction,'content',h.content,'occurred_at',h.occurred_at) order by h.occurred_at,h.created_at,h.id),'[]') into history from (
        select h.id,h.direction,h.content,h.occurred_at,h.created_at from public.arisa_whatsapp_messages h
        where h.organization_id=j.organization_id and h.thread_id=j.thread_id and (h.direction='inbound' or h.delivery_status in('accepted','sent','delivered','read'))
        order by h.occurred_at desc,h.created_at desc,h.id desc limit 20
      ) h;
      return jsonb_build_object('id',j.id,'lease',j.lease,'organization_id',j.organization_id,'actor_user_id',j.actor_user_id,'phone',t.phone,'contact_id',t.contact_id,'history',history,'follow_up',follow_up);
    end loop;
    return '{}'::jsonb;
  end if;
  select * into j from crm_private.arisa_whatsapp_reply_jobs where id=(p_args->>'id')::uuid for update;
  if j.id is null or j.lease is distinct from (p_args->>'lease')::uuid or j.lease_until<=now() then raise exception 'WHATSAPP_REPLY_LEASE_CHANGED';end if;
  if p_action='send' then
    if j.status<>'processing' then return jsonb_build_object('proceed',false);end if;
    select * into t from public.arisa_whatsapp_threads where id=j.thread_id;
    select * into m from public.arisa_whatsapp_messages where id=j.id;
    if t.opted_out_at is not null or m.occurred_at<=now()-interval '24 hours' or not exists(select 1 from crm_private.arisa_whatsapp_channel ch join crm_private.whatsapp_runtime_settings rt using(organization_id) where ch.organization_id=j.organization_id and ch.enabled and ch.auto_reply_enabled and not rt.enabled and rt.phone_number_id=t.phone_number_id)
      or exists(select 1 from public.arisa_whatsapp_messages newer where newer.thread_id=j.thread_id and newer.direction='inbound' and (newer.occurred_at,newer.created_at,newer.id)>(m.occurred_at,m.created_at,m.id)) then
      update crm_private.arisa_whatsapp_reply_jobs set status='skipped',error_code='WHATSAPP_REPLY_CONTEXT_CHANGED',updated_at=now() where id=j.id;return jsonb_build_object('proceed',false);
    end if;
    follow_up=private.arisa_whatsapp_pending_follow_up(j.organization_id,j.thread_id,j.id);
    if j.follow_up_message_id is distinct from nullif(follow_up->>'message_id','')::uuid then
      update crm_private.arisa_whatsapp_reply_jobs set status='skipped',error_code='WHATSAPP_REPLY_CONTEXT_CHANGED',updated_at=now() where id=j.id;return jsonb_build_object('proceed',false);
    end if;
    resolution=nullif(p_args->>'follow_up_resolution','');
    if resolution is not null and (j.follow_up_message_id is null or resolution not in('continue','wait','decline','answered')) then raise exception 'WHATSAPP_REPLY_INVALID';end if;
    if resolution='continue' and p_args->>'content' is distinct from follow_up->>'content' then raise exception 'WHATSAPP_REPLY_INVALID';end if;
    if exists(select 1 from crm_private.arisa_whatsapp_finance_events where message_id=j.id and disclosed) and not private.arisa_finance_valid(j.thread_id,j.organization_id) then
      update crm_private.arisa_whatsapp_reply_jobs set status='skipped',error_code='WHATSAPP_FINANCE_IDENTITY_CHANGED',updated_at=now() where id=j.id;return jsonb_build_object('proceed',false);
    end if;
    if length(trim(coalesce(p_args->>'content',''))) not between 1 and 4096 or pg_column_size(p_args)>32768 then raise exception 'WHATSAPP_REPLY_INVALID';end if;
    update crm_private.arisa_whatsapp_reply_jobs set follow_up_completed=coalesce(resolution in('continue','decline','answered'),false),status='sending',generated_content=p_args->>'content',response_id=left(p_args->>'response_id',200),model=left(p_args->>'model',100),usage=p_args->'usage',updated_at=now() where id=j.id;
    return jsonb_build_object('proceed',true);
  elsif p_action='finish' and j.status='sending' then
    v_result=p_args->'result';
    update crm_private.arisa_whatsapp_reply_jobs set status=case when v_result->>'accepted_by_meta'='true' then 'sent' when v_result->>'status'='failed' then 'failed' else 'unknown' end,result=v_result,updated_at=now() where id=j.id;
    update public.arisa_whatsapp_messages set metadata=metadata||jsonb_build_object('auto_reply',true,'reply_to_message_id',j.id) where id=nullif(v_result->>'message_id','')::uuid and organization_id=j.organization_id and thread_id=j.thread_id;
    return jsonb_build_object('ok',true);
  elsif p_action='fail' and j.status in('processing','sending') then
    update crm_private.arisa_whatsapp_reply_jobs set status=case when j.status='sending' then 'unknown' when attempts>=3 then 'failed' else 'pending' end,available_at=now()+interval '1 minute'*greatest(attempts,1),error_code=left(p_args->>'error',128),updated_at=now() where id=j.id;
    return jsonb_build_object('ok',true);
  end if;
  raise exception 'WHATSAPP_REPLY_INVALID';
end $function$
;

