alter table public.arisa_whatsapp_threads add column if not exists human_requested boolean not null default false;
alter table public.arisa_whatsapp_operations add column if not exists request_id uuid;
create unique index if not exists arisa_whatsapp_direct_request_idx on public.arisa_whatsapp_operations(organization_id,actor_user_id,request_id) where source_message_id is null and request_id is not null;

create or replace function public.arisa_whatsapp_monitor(p_organization_id uuid,p_thread_id uuid default null,p_search text default '',p_filter text default 'all',p_offset integer default 0,p_message_offset integer default 0)
returns jsonb language plpgsql stable security definer set search_path='' as $function$
declare ch crm_private.arisa_whatsapp_channel;rt crm_private.whatsapp_runtime_settings;result jsonb;selected jsonb;messages jsonb;message_count bigint;
begin
  if not private.arisa_is_admin(p_organization_id) then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
  if p_filter is null or p_filter not in('all','human','automatic','opted_out') or p_offset is null or p_offset not between 0 and 100000 or p_message_offset is null or p_message_offset not between 0 and 1000000 or char_length(coalesce(p_search,''))>120 then raise exception 'WHATSAPP_INVALID';end if;
  select * into ch from crm_private.arisa_whatsapp_channel where organization_id=p_organization_id;
  select * into rt from crm_private.whatsapp_runtime_settings where organization_id=p_organization_id;
  if p_thread_id is not null and not exists(select 1 from public.arisa_whatsapp_threads where id=p_thread_id and organization_id=p_organization_id and phone_number_id=rt.phone_number_id) then raise exception 'WHATSAPP_NOT_FOUND';end if;
  with candidates as (
    select t.id,t.phone as peer_phone,coalesce(nullif(c.name,''),t.contact_name) as customer_name,t.human_requested,t.opted_out_at,
      (select r.id from public.crm_records r where r.organization_id=p_organization_id and r.contact_id=t.contact_id order by r.created_at desc,r.id desc limit 1) as crm_record_id,
      greatest(t.created_at,t.last_inbound_at,t.last_message_at,last_message.occurred_at) as last_activity_at,
      left(coalesce(nullif(last_message.content,''),'Mensagem sem conteúdo de texto.'),160) as last_message,last_message.delivery_status
    from public.arisa_whatsapp_threads t left join public.contacts c on c.id=t.contact_id and c.organization_id=t.organization_id
    left join lateral(select m.content,m.delivery_status,m.occurred_at from public.arisa_whatsapp_messages m where m.organization_id=p_organization_id and m.thread_id=t.id order by m.occurred_at desc,m.id desc limit 1) last_message on true
    where t.organization_id=p_organization_id and t.phone_number_id=rt.phone_number_id
      and (nullif(trim(p_search),'') is null or concat_ws(' ',c.name,t.contact_name,t.phone) ilike '%'||trim(p_search)||'%' or (regexp_replace(p_search,'[^0-9]','','g')<>'' and t.phone like '%'||regexp_replace(p_search,'[^0-9]','','g')||'%'))
      and (p_filter='all' or p_filter='human' and t.human_requested and t.opted_out_at is null or p_filter='automatic' and not t.human_requested and t.opted_out_at is null or p_filter='opted_out' and t.opted_out_at is not null)
  ), page as(select * from candidates order by last_activity_at desc,id desc limit 25 offset p_offset)
  select jsonb_build_object('threads',coalesce((select jsonb_agg(to_jsonb(p) order by p.last_activity_at desc,p.id desc) from page p),'[]'::jsonb),'total',(select count(*) from candidates)) into result;
  select jsonb_build_object('id',t.id,'peer_phone',t.phone,'customer_name',coalesce(nullif(c.name,''),t.contact_name),'human_requested',t.human_requested,'opted_out_at',t.opted_out_at,
    'crm_record_id',(select r.id from public.crm_records r where r.organization_id=p_organization_id and r.contact_id=t.contact_id order by r.created_at desc,r.id desc limit 1)) into selected
    from public.arisa_whatsapp_threads t left join public.contacts c on c.id=t.contact_id and c.organization_id=t.organization_id where t.id=p_thread_id and t.organization_id=p_organization_id and t.phone_number_id=rt.phone_number_id;
  select count(*) into message_count from public.arisa_whatsapp_messages m join public.arisa_whatsapp_threads t on t.id=m.thread_id where t.organization_id=p_organization_id and t.phone_number_id=rt.phone_number_id and m.organization_id=p_organization_id and t.id=p_thread_id;
  select coalesce(jsonb_agg(to_jsonb(page) order by page.occurred_at,page.id),'[]'::jsonb) into messages from (
    select m.id,m.direction,coalesce(nullif(m.content,''),case m.message_type when 'audio' then 'Áudio recebido' when 'image' then 'Imagem recebida' when 'video' then 'Vídeo recebido' when 'document' then 'Documento recebido' else 'Mensagem sem conteúdo de texto.' end) as content,m.message_type,m.delivery_status,coalesce(m.metadata->>'provider_error_code',m.metadata->>'error_code',o.error_code) as error_code,m.occurred_at
    from public.arisa_whatsapp_messages m join public.arisa_whatsapp_threads t on t.id=m.thread_id left join public.arisa_whatsapp_operations o on o.id=m.operation_id and o.organization_id=p_organization_id
    where t.organization_id=p_organization_id and m.organization_id=p_organization_id and t.phone_number_id=rt.phone_number_id and t.id=p_thread_id order by m.occurred_at desc,m.id desc limit 50 offset p_message_offset
  ) page;
  return result||jsonb_build_object('enabled',coalesce(ch.enabled,false) and not coalesce(rt.enabled,false),'verified',ch.webhook_verified_at is not null or ch.webhook_confirmed_at is not null,'phone',rt.display_phone_number,'selected',selected,'messages',messages,'message_total',message_count,'offset',p_offset,'message_offset',p_message_offset,'updated_at',now());
end $function$;
revoke all on function public.arisa_whatsapp_monitor(uuid,uuid,text,text,integer,integer) from public,anon;
grant execute on function public.arisa_whatsapp_monitor(uuid,uuid,text,text,integer,integer) to authenticated;

create or replace function public.arisa_whatsapp_inbox(p_organization_id uuid,p_thread_id uuid default null,p_action text default 'read')
returns jsonb language plpgsql security definer set search_path='' as $function$
declare t public.arisa_whatsapp_threads;
begin
  if not private.arisa_is_admin(p_organization_id) then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
  if p_action not in('read','pause','resume') or p_action is null then raise exception 'WHATSAPP_INVALID';end if;
  if p_thread_id is not null then
    select t0.* into t from public.arisa_whatsapp_threads t0 join crm_private.whatsapp_runtime_settings rt on rt.organization_id=t0.organization_id and rt.phone_number_id=t0.phone_number_id where t0.id=p_thread_id and t0.organization_id=p_organization_id for update of t0;
    if not found then raise exception 'WHATSAPP_NOT_FOUND';end if;
  end if;
  if p_action in('pause','resume') then
    if t.id is null then raise exception 'WHATSAPP_NOT_FOUND';end if;
    if p_action='resume' and t.opted_out_at is not null then raise exception 'WHATSAPP_CONTACT_BLOCKED' using errcode='42501';end if;
    -- Do not replay pending or in-progress generations after changing the operator mode.
    update crm_private.arisa_whatsapp_reply_jobs set status='skipped',error_code='WHATSAPP_OPERATOR_CHANGED_MODE',updated_at=now() where organization_id=p_organization_id and thread_id=t.id and status in('pending','processing');
    update public.arisa_whatsapp_threads set human_requested=(p_action='pause') where id=t.id and organization_id=p_organization_id;
  end if;
  return public.arisa_whatsapp_monitor(p_organization_id,p_thread_id);
end $function$;
revoke all on function public.arisa_whatsapp_inbox(uuid,uuid,text) from public,anon;
grant execute on function public.arisa_whatsapp_inbox(uuid,uuid,text) to authenticated;

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
  elsif p_action='request_status' then
    select * into op from public.arisa_whatsapp_operations where organization_id=p_org and actor_user_id=p_actor and request_id=(p_args->>'request_id')::uuid and source_message_id is null;
    if not found then return '{}'::jsonb;end if;
    return public.arisa_whatsapp_service('get',p_org,p_actor,jsonb_build_object('id',op.id));
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
    if nullif(p_args->>'message_id','') is null and nullif(p_args->>'request_id','') is not null and exists(select 1 from public.arisa_whatsapp_operations where organization_id=p_org and actor_user_id=p_actor and request_id=(p_args->>'request_id')::uuid and source_message_id is null) then raise exception 'WHATSAPP_REQUEST_CHANGED';end if;
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
    if th.opted_out_at is not null or (th.human_requested and exists(select 1 from crm_private.arisa_whatsapp_reply_jobs where id=nullif(p_args->>'request_id','')::uuid and organization_id=p_org and thread_id=th.id)) then raise exception 'WHATSAPP_CONTACT_BLOCKED' using errcode='42501';end if;
    v_window=th.last_inbound_at is not null and th.last_inbound_at>now()-interval '24 hours' and th.last_inbound_at<=now();
    v_template=nullif(trim(p_args->>'template_name'),'');v_lang=coalesce(nullif(trim(p_args->>'template_language'),''),'pt_BR');v_components=coalesce(p_args->'template_components','[]'::jsonb);
    if jsonb_typeof(v_components)<>'array' or pg_column_size(v_components)>32768 then raise exception 'WHATSAPP_INVALID';end if;
    if not v_window and v_template is null then raise exception 'WHATSAPP_TEMPLATE_REQUIRED';end if;
    if v_template is null and length(v_content)>4096 then raise exception 'WHATSAPP_INVALID';end if;
    insert into public.arisa_whatsapp_operations(request_id,organization_id,actor_user_id,source_message_id,operation_key,payload_hash,contact_id,phone,phone_number_id,thread_id,send_mode,template_name,template_language,template_components) values(nullif(p_args->>'request_id','')::uuid,p_org,p_actor,nullif(p_args->>'message_id','')::uuid,p_args->>'operation_key',p_args->>'payload_hash',ct.id,v_phone,rt.phone_number_id,th.id,case when v_template is null then 'freeform' else 'template' end,v_template,v_lang,v_components) returning * into op;
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
      if (op.contact_id is not null and (ct.id is null or not ct.active)) or ct.do_not_contact_at is not null or lower(coalesce(ct.marketing_consent_status,'')) in('denied','revoked') or th.opted_out_at is not null or (th.human_requested and exists(select 1 from crm_private.arisa_whatsapp_reply_jobs where id=op.request_id and organization_id=p_org and thread_id=th.id)) then raise exception 'WHATSAPP_CONTACT_BLOCKED' using errcode='42501';end if;
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
      elsif t.human_requested then reason='WHATSAPP_HUMAN_REQUESTED';
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
    if t.human_requested or t.opted_out_at is not null or m.occurred_at<=now()-interval '24 hours' or not exists(select 1 from crm_private.arisa_whatsapp_channel ch join crm_private.whatsapp_runtime_settings rt using(organization_id) where ch.organization_id=j.organization_id and ch.enabled and ch.auto_reply_enabled and not rt.enabled and rt.phone_number_id=t.phone_number_id)
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
CREATE OR REPLACE FUNCTION private.arisa_queue_whatsapp_reply()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare actor uuid;
begin
  if new.direction<>'inbound' or new.occurred_at<=now()-interval '24 hours' then return new;end if;
  if exists(select 1 from public.arisa_whatsapp_threads where id=new.thread_id and organization_id=new.organization_id and human_requested) then return new;end if;
  select c.updated_by into actor from crm_private.arisa_whatsapp_channel c
    join crm_private.whatsapp_runtime_settings r on r.organization_id=c.organization_id
    where c.organization_id=new.organization_id and c.enabled and c.auto_reply_enabled and not r.enabled;
  if actor is null or not private.arisa_actor_admin(new.organization_id,actor) then return new;end if;
  insert into crm_private.arisa_whatsapp_reply_jobs(id,organization_id,thread_id,actor_user_id)
    values(new.id,new.organization_id,new.thread_id,actor) on conflict(id) do nothing;
  -- pg_net starts after this transaction commits, including the thread's opt-out update.
  perform private.arisa_dispatch_whatsapp_replies();
  return new;
end $function$
;
