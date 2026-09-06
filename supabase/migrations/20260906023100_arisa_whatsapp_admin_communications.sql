begin;
set local lock_timeout='10s';
set local statement_timeout='90s';

create table public.arisa_whatsapp_operations(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  actor_user_id uuid not null references auth.users(id),
  source_message_id uuid references public.arisa_chat_messages(id),
  operation_key text not null check(operation_key~'^[a-f0-9]{64}$'),
  payload_hash text not null check(payload_hash~'^[a-f0-9]{64}$'),
  message_id uuid references public.crm_messages(id),
  contact_id uuid references public.contacts(id),
  phone text not null,
  send_mode text not null check(send_mode in('freeform','template')),
  template_name text,
  template_language text,
  template_components jsonb not null default '[]',
  status text not null default 'prepared' check(status in('prepared','queued','completed','failed','unknown')),
  result jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(organization_id,operation_key)
);
create index arisa_whatsapp_ops_actor on public.arisa_whatsapp_operations(actor_user_id);
create index arisa_whatsapp_ops_message on public.arisa_whatsapp_operations(message_id);
create index arisa_whatsapp_ops_source on public.arisa_whatsapp_operations(source_message_id);
create index arisa_whatsapp_ops_pending on public.arisa_whatsapp_operations(status,updated_at) where status in('prepared','queued','unknown');
alter table public.arisa_whatsapp_operations enable row level security;
revoke all on public.arisa_whatsapp_operations from public,anon,authenticated,service_role;
grant select on public.arisa_whatsapp_operations to authenticated,service_role;
create policy arisa_whatsapp_ops_admin on public.arisa_whatsapp_operations for select to authenticated using(private.arisa_is_admin(organization_id));

create function public.arisa_whatsapp_service(p_action text,p_org uuid,p_actor uuid,p_args jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare
  op public.arisa_whatsapp_operations;ct public.contacts;rec public.crm_records;conv public.crm_conversations;msg public.crm_messages;
  v_phone text;v_name text;v_content text;v_mode text;v_window boolean;v_last_in timestamptz;v_result jsonb;v_fresh boolean:=false;
  v_template text;v_lang text;v_components jsonb;
begin
  if not private.arisa_actor_admin(p_org,p_actor) then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;
  if p_action='status' then
    return coalesce((select jsonb_build_object('enabled',s.enabled,'mode',s.mode,'waba_id',s.waba_id,'phone_number_id',s.phone_number_id,'graph_api_version',s.graph_api_version,'display_phone_number',s.display_phone_number,'ready',s.enabled and s.waba_id is not null and s.phone_number_id is not null and s.graph_api_version is not null and s.access_token_vault_id is not null and s.app_secret_vault_id is not null and s.verify_token_vault_id is not null) from crm_private.whatsapp_runtime_settings s where s.organization_id=p_org),'{}'::jsonb)||jsonb_build_object('webhook_path','/functions/v1/enterprise-whatsapp-webhook');
  end if;
  if p_action='prepare' then
    if p_args->>'operation_key'!~'^[a-f0-9]{64}$' or p_args->>'payload_hash'!~'^[a-f0-9]{64}$' then raise exception 'WHATSAPP_INVALID';end if;
    if nullif(p_args->>'message_id','') is not null and not exists(select 1 from public.arisa_chat_messages m where m.id=(p_args->>'message_id')::uuid and m.organization_id=p_org and m.owner_user_id=p_actor and m.role='user' and m.status='processing' and m.lease_token=(p_args->>'lease')::uuid and m.lease_expires_at>now()) then raise exception 'ARISA_LEASE_CHANGED';end if;
    v_content=trim(coalesce(p_args->>'content',''));if length(v_content) not between 1 and 12000 then raise exception 'WHATSAPP_INVALID';end if;
    v_phone=regexp_replace(coalesce(p_args->>'phone',''),'[^0-9]','','g');
    if nullif(p_args->>'contact_id','') is not null then select * into ct from public.contacts where id=(p_args->>'contact_id')::uuid and organization_id=p_org and active;if not found then raise exception 'WHATSAPP_CONTACT_NOT_FOUND';end if;v_phone=regexp_replace(coalesce(ct.phone,v_phone),'[^0-9]','','g');end if;
    if v_phone!~'^[0-9]{8,20}$' then raise exception 'WHATSAPP_PHONE_INVALID';end if;
    if ct.id is null then select * into ct from public.contacts c where c.organization_id=p_org and c.active and regexp_replace(coalesce(c.phone,''),'[^0-9]','','g')=v_phone order by c.updated_at desc limit 1;end if;
    if ct.id is null then v_name=left(coalesce(nullif(trim(p_args->>'contact_name'),''),'Contato WhatsApp'),180);insert into public.contacts(organization_id,contact_type,name,phone,preferred_channel,marketing_consent_status,data_processing_basis) values(p_org,case when p_args->>'contact_type' in('prospect','cliente','fornecedor','ambos','terrenista','colaborador','corretor','beneficiario') then p_args->>'contact_type' else 'fornecedor' end,v_name,'+'||v_phone,'whatsapp','unknown','legitimate_interest') returning * into ct;end if;
    if ct.do_not_contact_at is not null or lower(coalesce(ct.marketing_consent_status,'')) in('denied','revoked') then raise exception 'WHATSAPP_CONTACT_BLOCKED' using errcode='42501';end if;
    select * into rec from public.crm_records r where r.organization_id=p_org and r.contact_id=ct.id and r.record_status='aberta' order by r.updated_at desc nulls last,r.created_at desc limit 1;
    if rec.id is null then insert into public.crm_records(organization_id,contact_id,person_name,company_name,phone,source,source_channel,record_status,notes,created_by,tags) values(p_org,ct.id,ct.name,ct.trade_name,ct.phone,'Arisa Comunicação','whatsapp','aberta','Registro administrativo de comunicação criado pela Arisa.',p_actor,array['arisa_comunicacao']) returning * into rec;end if;
    insert into public.crm_conversations(organization_id,crm_record_id,contact_id,channel,status,ai_enabled,assigned_user_id,last_message_at) values(p_org,rec.id,ct.id,'whatsapp','ai_active',true,p_actor,now()) on conflict(organization_id,crm_record_id,channel) do update set contact_id=excluded.contact_id,assigned_user_id=coalesce(public.crm_conversations.assigned_user_id,excluded.assigned_user_id),updated_at=now() returning * into conv;
    select max(m.occurred_at) into v_last_in from public.crm_messages m join public.crm_conversations c on c.id=m.conversation_id where m.organization_id=p_org and c.contact_id=ct.id and m.channel='whatsapp' and m.direction='inbound';v_window=v_last_in is not null and v_last_in>now()-interval '24 hours';
    v_template=nullif(trim(p_args->>'template_name'),'');v_lang=coalesce(nullif(trim(p_args->>'template_language'),''),'pt_BR');v_components=coalesce(p_args->'template_components','[]'::jsonb);if jsonb_typeof(v_components)<>'array' or pg_column_size(v_components)>32768 then raise exception 'WHATSAPP_INVALID';end if;
    v_mode=case when v_template is null then 'freeform' else 'template' end;if not v_window and v_mode='freeform' then raise exception 'WHATSAPP_TEMPLATE_REQUIRED';end if;
    insert into public.arisa_whatsapp_operations(organization_id,actor_user_id,source_message_id,operation_key,payload_hash,contact_id,phone,send_mode,template_name,template_language,template_components) values(p_org,p_actor,nullif(p_args->>'message_id','')::uuid,p_args->>'operation_key',p_args->>'payload_hash',ct.id,v_phone,v_mode,v_template,v_lang,v_components) on conflict(organization_id,operation_key) do nothing returning * into op;v_fresh=found;
    if not v_fresh then select * into op from public.arisa_whatsapp_operations where organization_id=p_org and operation_key=p_args->>'operation_key' for update;if op.actor_user_id<>p_actor then raise exception 'ADMIN_REQUIRED' using errcode='42501';end if;if op.payload_hash<>p_args->>'payload_hash' then raise exception 'WHATSAPP_REQUEST_CHANGED';end if;return to_jsonb(op)||jsonb_build_object('proceed',false,'window_open',v_window,'last_inbound_at',v_last_in);end if;
    insert into public.crm_messages(organization_id,conversation_id,crm_record_id,direction,actor_type,channel,content,delivery_status,metadata,occurred_at) values(p_org,conv.id,rec.id,'outbound','ai','whatsapp',v_content,'prepared',jsonb_build_object('arisa',true,'operation_id',op.id,'send_mode',v_mode,'template_name',v_template,'template_language',v_lang,'template_components',v_components,'contact_id',ct.id),now()) returning * into msg;update public.arisa_whatsapp_operations set message_id=msg.id where id=op.id returning * into op;return to_jsonb(op)||jsonb_build_object('proceed',true,'window_open',v_window,'last_inbound_at',v_last_in,'crm_record_id',rec.id,'conversation_id',conv.id,'message_id',msg.id);
  elsif p_action='claim' then
    select * into op from public.arisa_whatsapp_operations where id=(p_args->>'id')::uuid and organization_id=p_org and actor_user_id=p_actor for update;if not found then raise exception 'WHATSAPP_NOT_FOUND';end if;if op.status='completed' then return to_jsonb(op)||jsonb_build_object('proceed',false);end if;if op.status in('queued','unknown') then return to_jsonb(op)||jsonb_build_object('proceed',false);end if;
    select * into ct from public.contacts where id=op.contact_id and organization_id=p_org;if ct.do_not_contact_at is not null or lower(coalesce(ct.marketing_consent_status,'')) in('denied','revoked') then raise exception 'WHATSAPP_CONTACT_BLOCKED' using errcode='42501';end if;
    select max(m.occurred_at) into v_last_in from public.crm_messages m join public.crm_conversations c on c.id=m.conversation_id where m.organization_id=p_org and c.contact_id=ct.id and m.channel='whatsapp' and m.direction='inbound';v_window=v_last_in is not null and v_last_in>now()-interval '24 hours';if not v_window and op.send_mode='freeform' then raise exception 'WHATSAPP_TEMPLATE_REQUIRED';end if;
    update public.arisa_whatsapp_operations set status='queued',updated_at=now() where id=op.id returning * into op;update public.crm_messages set delivery_status='queued',metadata=metadata||jsonb_build_object('cloud_send_claimed_at',now(),'cloud_send_claimed_by',p_actor) where id=op.message_id;select * into msg from public.crm_messages where id=op.message_id;return to_jsonb(op)||jsonb_build_object('proceed',true,'content',msg.content,'window_open',v_window,'last_inbound_at',v_last_in);
  elsif p_action='get' then
    select * into op from public.arisa_whatsapp_operations where id=(p_args->>'id')::uuid and organization_id=p_org and actor_user_id=p_actor;if not found then raise exception 'WHATSAPP_NOT_FOUND';end if;select * into msg from public.crm_messages where id=op.message_id;return to_jsonb(op)||jsonb_build_object('delivery_status',msg.delivery_status,'provider_message_id',msg.provider_message_id);
  elsif p_action='finish' then
    select * into op from public.arisa_whatsapp_operations where id=(p_args->>'id')::uuid and organization_id=p_org and actor_user_id=p_actor for update;if not found then raise exception 'WHATSAPP_NOT_FOUND';end if;if op.status='completed' then return op.result;end if;if coalesce(p_args->>'provider_message_id','')='' then raise exception 'WHATSAPP_INVALID';end if;
    update public.crm_messages set provider_message_id=p_args->>'provider_message_id',delivery_status='sent',metadata=metadata||jsonb_build_object('cloud_sent_at',now(),'cloud_sent_by',p_actor) where id=op.message_id and provider_message_id is null;select * into msg from public.crm_messages where id=op.message_id;if msg.provider_message_id<>p_args->>'provider_message_id' then raise exception 'WHATSAPP_REQUEST_CHANGED';end if;
    v_result=jsonb_build_object('ok',true,'operation_id',op.id,'message_id',msg.id,'provider_message_id',msg.provider_message_id,'delivery_status',msg.delivery_status,'send_mode',op.send_mode,'phone',op.phone,'template_name',op.template_name,'sent_confirmed_by_meta',true,'delivered',false,'read',false);update public.arisa_whatsapp_operations set status='completed',result=v_result,error_code=null,updated_at=now() where id=op.id;
    if op.source_message_id is not null then insert into public.arisa_chat_actions(organization_id,actor_user_id,message_id,operation_key,action,entity,record_id,summary,result) values(p_org,p_actor,op.source_message_id,op.operation_key,'send','whatsapp',msg.id::text,'WhatsApp enviado para +'||op.phone,v_result) on conflict do nothing;end if;
    perform private.arisa_archive_put(p_org,p_actor,'arisa_whatsapp_operations',op.id::text,'platform','action','arisa','whatsapp:'||msg.id,'WhatsApp','WhatsApp enviado para +'||op.phone,'Envio aceito pela Meta; entrega e leitura dependem do webhook.',v_result,now(),false);return v_result;
  elsif p_action='fail' then
    select * into op from public.arisa_whatsapp_operations where id=(p_args->>'id')::uuid and organization_id=p_org and actor_user_id=p_actor for update;if not found then return jsonb_build_object('ok',false);end if;update public.arisa_whatsapp_operations set status=case when p_args->>'status'='failed' then 'failed' else 'unknown' end,error_code=left(coalesce(p_args->>'error','WHATSAPP_SEND_FAILED'),128),updated_at=now() where id=op.id and status<>'completed';if p_args->>'status'='failed' then update public.crm_messages set delivery_status='failed',metadata=metadata||jsonb_build_object('cloud_send_last_error',left(coalesce(p_args->>'error','WHATSAPP_SEND_FAILED'),128),'cloud_send_failed_at',now()) where id=op.message_id and provider_message_id is null;end if;return jsonb_build_object('ok',true);
  end if;
  raise exception 'WHATSAPP_INVALID';
end $$;
revoke all on function public.arisa_whatsapp_service(text,uuid,uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.arisa_whatsapp_service(text,uuid,uuid,jsonb) to service_role;
notify pgrst,'reload schema';
commit;

