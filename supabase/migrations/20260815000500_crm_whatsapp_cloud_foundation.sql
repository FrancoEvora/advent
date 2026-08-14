begin;

create table if not exists crm_private.whatsapp_runtime_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  enabled boolean not null default false,
  mode text not null default 'supervised' check (mode in ('supervised','autonomous_replies')),
  waba_id text,
  phone_number_id text,
  graph_api_version text,
  display_phone_number text,
  access_token_vault_id uuid,
  app_secret_vault_id uuid,
  verify_token_vault_id uuid,
  created_by uuid,
  updated_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (waba_id is null or waba_id ~ '^[0-9]{1,64}$'),
  check (phone_number_id is null or phone_number_id ~ '^[0-9]{1,64}$'),
  check (graph_api_version is null or graph_api_version ~ '^v[0-9]{1,3}[.][0-9]{1,2}$'),
  check (display_phone_number is null or char_length(display_phone_number) between 5 and 40)
);

alter table crm_private.whatsapp_runtime_settings enable row level security;
revoke all on table crm_private.whatsapp_runtime_settings from public, anon, authenticated;
grant select, insert, update, delete on table crm_private.whatsapp_runtime_settings to service_role;

create unique index if not exists whatsapp_runtime_phone_number_id_uidx
  on crm_private.whatsapp_runtime_settings(phone_number_id)
  where phone_number_id is not null;

create unique index if not exists crm_messages_provider_message_uidx
  on public.crm_messages(organization_id, channel, provider_message_id)
  where provider_message_id is not null;

create or replace function crm_private.whatsapp_status_internal(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare s crm_private.whatsapp_runtime_settings%rowtype;
begin
  if auth.uid() is null
     or p_organization_id is null
     or not public.has_app_permission(p_organization_id,'crm.integrations.manage') then
    raise exception 'Seu perfil nao pode gerenciar o WhatsApp.' using errcode='42501';
  end if;
  select * into s from crm_private.whatsapp_runtime_settings where organization_id=p_organization_id;
  if not found then
    return jsonb_build_object(
      'organization_id',p_organization_id,'enabled',false,'mode','supervised',
      'waba_id',null,'phone_number_id',null,'graph_api_version',null,'display_phone_number',null,
      'access_token_configured',false,'app_secret_configured',false,'verify_token_configured',false,
      'ready',false,'updated_at',null
    );
  end if;
  return jsonb_build_object(
    'organization_id',s.organization_id,'enabled',s.enabled,'mode',s.mode,
    'waba_id',s.waba_id,'phone_number_id',s.phone_number_id,'graph_api_version',s.graph_api_version,
    'display_phone_number',s.display_phone_number,
    'access_token_configured',s.access_token_vault_id is not null,
    'app_secret_configured',s.app_secret_vault_id is not null,
    'verify_token_configured',s.verify_token_vault_id is not null,
    'ready',s.enabled and s.waba_id is not null and s.phone_number_id is not null
      and s.graph_api_version is not null and s.access_token_vault_id is not null
      and s.app_secret_vault_id is not null and s.verify_token_vault_id is not null,
    'updated_at',s.updated_at
  );
end
$function$;

create or replace function crm_private.configure_whatsapp_runtime_internal(
  p_organization_id uuid,
  p_waba_id text default null,
  p_phone_number_id text default null,
  p_graph_api_version text default null,
  p_display_phone_number text default null,
  p_access_token text default null,
  p_app_secret text default null,
  p_verify_token text default null,
  p_enabled boolean default null,
  p_mode text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  actor_id uuid:=auth.uid();
  s crm_private.whatsapp_runtime_settings%rowtype;
  secret_id uuid;
  normalized_mode text;
  normalized_waba text;
  normalized_phone_id text;
  normalized_version text;
begin
  if actor_id is null or p_organization_id is null
     or not public.has_app_permission(p_organization_id,'crm.integrations.manage') then
    raise exception 'Seu perfil nao pode gerenciar o WhatsApp.' using errcode='42501';
  end if;
  normalized_mode:=case when p_mode is null then null else lower(trim(p_mode)) end;
  if normalized_mode is not null and normalized_mode not in ('supervised','autonomous_replies') then raise exception 'Modo WhatsApp invalido.'; end if;
  normalized_waba:=case when p_waba_id is null then null else trim(p_waba_id) end;
  normalized_phone_id:=case when p_phone_number_id is null then null else trim(p_phone_number_id) end;
  normalized_version:=case when p_graph_api_version is null then null else trim(p_graph_api_version) end;
  if normalized_waba is not null and normalized_waba !~ '^[0-9]{1,64}$' then raise exception 'WABA ID invalido.'; end if;
  if normalized_phone_id is not null and normalized_phone_id !~ '^[0-9]{1,64}$' then raise exception 'Phone Number ID invalido.'; end if;
  if normalized_version is not null and normalized_version !~ '^v[0-9]{1,3}[.][0-9]{1,2}$' then raise exception 'Versao Graph API invalida.'; end if;
  if p_access_token is not null and (p_access_token<>btrim(p_access_token) or char_length(p_access_token) not between 32 and 8192 or p_access_token ~ '[[:space:]]') then raise exception 'Access token invalido.'; end if;
  if p_app_secret is not null and (p_app_secret<>btrim(p_app_secret) or char_length(p_app_secret) not between 24 and 512 or p_app_secret ~ '[[:space:]]') then raise exception 'App secret invalido.'; end if;
  if p_verify_token is not null and (p_verify_token<>btrim(p_verify_token) or char_length(p_verify_token) not between 24 and 512 or p_verify_token ~ '[[:space:]]') then raise exception 'Verify token invalido.'; end if;

  perform pg_advisory_xact_lock(hashtextextended('evora-whatsapp-runtime:'||p_organization_id::text,0));
  insert into crm_private.whatsapp_runtime_settings(organization_id,created_by,updated_by)
  values(p_organization_id,actor_id,actor_id) on conflict(organization_id) do nothing;
  select * into s from crm_private.whatsapp_runtime_settings where organization_id=p_organization_id for update;

  if p_access_token is not null then
    if s.access_token_vault_id is null then
      secret_id:=vault.create_secret(p_access_token,'evora_whatsapp_'||replace(p_organization_id::text,'-','')||'_access_'||encode(extensions.gen_random_bytes(8),'hex'),'Evora WhatsApp Cloud access token',null);
    else
      secret_id:=s.access_token_vault_id; perform vault.update_secret(secret_id,p_access_token,null,null,null);
    end if;
    update crm_private.whatsapp_runtime_settings set access_token_vault_id=secret_id where organization_id=p_organization_id;
  end if;
  if p_app_secret is not null then
    if s.app_secret_vault_id is null then
      secret_id:=vault.create_secret(p_app_secret,'evora_whatsapp_'||replace(p_organization_id::text,'-','')||'_app_'||encode(extensions.gen_random_bytes(8),'hex'),'Evora WhatsApp webhook app secret',null);
    else secret_id:=s.app_secret_vault_id; perform vault.update_secret(secret_id,p_app_secret,null,null,null); end if;
    update crm_private.whatsapp_runtime_settings set app_secret_vault_id=secret_id where organization_id=p_organization_id;
  end if;
  if p_verify_token is not null then
    if s.verify_token_vault_id is null then
      secret_id:=vault.create_secret(p_verify_token,'evora_whatsapp_'||replace(p_organization_id::text,'-','')||'_verify_'||encode(extensions.gen_random_bytes(8),'hex'),'Evora WhatsApp webhook verify token',null);
    else secret_id:=s.verify_token_vault_id; perform vault.update_secret(secret_id,p_verify_token,null,null,null); end if;
    update crm_private.whatsapp_runtime_settings set verify_token_vault_id=secret_id where organization_id=p_organization_id;
  end if;

  update crm_private.whatsapp_runtime_settings runtime
  set waba_id=coalesce(normalized_waba,runtime.waba_id),
      phone_number_id=coalesce(normalized_phone_id,runtime.phone_number_id),
      graph_api_version=coalesce(normalized_version,runtime.graph_api_version),
      display_phone_number=coalesce(nullif(trim(p_display_phone_number),''),runtime.display_phone_number),
      mode=coalesce(normalized_mode,runtime.mode), enabled=coalesce(p_enabled,runtime.enabled),
      updated_by=actor_id,updated_at=now()
  where organization_id=p_organization_id;

  select * into s from crm_private.whatsapp_runtime_settings where organization_id=p_organization_id;
  if s.enabled and (s.waba_id is null or s.phone_number_id is null or s.graph_api_version is null
      or s.access_token_vault_id is null or s.app_secret_vault_id is null or s.verify_token_vault_id is null) then
    raise exception 'Complete WABA, numero, versao e credenciais antes de ativar o WhatsApp.';
  end if;
  return crm_private.whatsapp_status_internal(p_organization_id);
end
$function$;

create or replace function public.get_whatsapp_runtime_status(p_organization_id uuid)
returns jsonb language sql security definer set search_path=''
as $function$ select crm_private.whatsapp_status_internal(p_organization_id) $function$;
create or replace function public.configure_whatsapp_runtime(
  p_organization_id uuid,p_waba_id text default null,p_phone_number_id text default null,
  p_graph_api_version text default null,p_display_phone_number text default null,
  p_access_token text default null,p_app_secret text default null,p_verify_token text default null,
  p_enabled boolean default null,p_mode text default null)
returns jsonb language sql security definer set search_path=''
as $function$ select crm_private.configure_whatsapp_runtime_internal(p_organization_id,p_waba_id,p_phone_number_id,p_graph_api_version,p_display_phone_number,p_access_token,p_app_secret,p_verify_token,p_enabled,p_mode) $function$;

create or replace function public.get_whatsapp_runtime_credentials(p_organization_id uuid)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare r jsonb;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'RPC restrita ao runtime WhatsApp.' using errcode='42501'; end if;
  select jsonb_build_object('organization_id',s.organization_id,'enabled',s.enabled,'mode',s.mode,'waba_id',s.waba_id,
    'phone_number_id',s.phone_number_id,'graph_api_version',s.graph_api_version,'display_phone_number',s.display_phone_number,
    'access_token',a.decrypted_secret,'app_secret',x.decrypted_secret,'verify_token',v.decrypted_secret)
  into r from crm_private.whatsapp_runtime_settings s
  left join vault.decrypted_secrets a on a.id=s.access_token_vault_id
  left join vault.decrypted_secrets x on x.id=s.app_secret_vault_id
  left join vault.decrypted_secrets v on v.id=s.verify_token_vault_id
  where s.organization_id=p_organization_id;
  return r;
end
$function$;

create or replace function public.get_whatsapp_runtime_by_phone_number_id(p_phone_number_id text)
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare r jsonb;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'RPC restrita ao runtime WhatsApp.' using errcode='42501'; end if;
  select jsonb_build_object('organization_id',s.organization_id,'enabled',s.enabled,'mode',s.mode,'waba_id',s.waba_id,
    'phone_number_id',s.phone_number_id,'graph_api_version',s.graph_api_version,'access_token',a.decrypted_secret,
    'app_secret',x.decrypted_secret,'verify_token',v.decrypted_secret)
  into r from crm_private.whatsapp_runtime_settings s
  left join vault.decrypted_secrets a on a.id=s.access_token_vault_id
  left join vault.decrypted_secrets x on x.id=s.app_secret_vault_id
  left join vault.decrypted_secrets v on v.id=s.verify_token_vault_id
  where s.phone_number_id=trim(p_phone_number_id) and s.enabled=true;
  return r;
end
$function$;

create or replace function public.ingest_whatsapp_inbound_message(
  p_organization_id uuid,p_provider_message_id text,p_from_phone text,p_profile_name text,
  p_content text,p_occurred_at timestamptz,p_phone_number_id text,p_message_type text default 'text')
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare
  normalized_phone text; contact_key uuid; record_key uuid; conversation_key uuid; message_key uuid;
  job_key uuid; job_inserted boolean:=false; open_count integer:=0;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'RPC restrita ao webhook WhatsApp.' using errcode='42501'; end if;
  if p_provider_message_id is null or char_length(trim(p_provider_message_id)) not between 8 and 512 then raise exception 'Message ID invalido.'; end if;
  if p_content is null or char_length(trim(p_content)) not between 1 and 12000 then raise exception 'Conteudo inbound invalido.'; end if;
  normalized_phone:=regexp_replace(coalesce(p_from_phone,''),'[^0-9]','','g');
  if char_length(normalized_phone) not between 8 and 20 then raise exception 'Telefone inbound invalido.'; end if;
  if not exists(select 1 from crm_private.whatsapp_runtime_settings s where s.organization_id=p_organization_id and s.enabled and s.phone_number_id=trim(p_phone_number_id)) then raise exception 'Runtime WhatsApp nao corresponde ao numero receptor.' using errcode='42501'; end if;

  select m.id into message_key from public.crm_messages m where m.organization_id=p_organization_id and m.channel='whatsapp' and m.provider_message_id=trim(p_provider_message_id) limit 1;
  if message_key is not null then return jsonb_build_object('message_id',message_key,'inserted',false,'duplicate',true); end if;

  select c.id into contact_key from public.contacts c
  where c.organization_id=p_organization_id and regexp_replace(coalesce(c.phone,''),'[^0-9]','','g')=normalized_phone
  order by c.updated_at desc nulls last,c.created_at desc,c.id limit 1;

  if contact_key is null then
    insert into public.contacts(organization_id,contact_type,name,phone,preferred_channel,marketing_consent_status)
    values(p_organization_id,'cliente',left(coalesce(nullif(trim(p_profile_name),''),'Contato WhatsApp'),180),'+'||normalized_phone,'whatsapp','unknown')
    returning id into contact_key;
  end if;

  select count(*),max(r.id) filter(where true) into open_count,record_key
  from public.crm_records r where r.organization_id=p_organization_id and r.contact_id=contact_key and r.record_status='aberta';
  if open_count>1 then
    select c.crm_record_id into record_key from public.crm_conversations c
    where c.organization_id=p_organization_id and c.contact_id=contact_key and c.channel='whatsapp' and c.status<>'closed'
    order by c.last_message_at desc nulls last,c.updated_at desc limit 1;
    if record_key is null then raise exception 'MULTIPLE_OPEN_OPPORTUNITIES_FOR_WHATSAPP'; end if;
  elsif open_count=0 then
    insert into public.crm_records(organization_id,contact_id,person_name,phone,source,source_channel,record_status,notes)
    select p_organization_id,contact_key,c.name,c.phone,'WhatsApp Cloud API','whatsapp_inbound','aberta','Criado automaticamente a partir de mensagem inbound do WhatsApp.' from public.contacts c where c.id=contact_key
    returning id into record_key;
  end if;

  insert into public.crm_conversations(organization_id,crm_record_id,contact_id,channel,status,ai_enabled,last_message_at)
  values(p_organization_id,record_key,contact_key,'whatsapp','ai_active',true,coalesce(p_occurred_at,now()))
  on conflict(organization_id,crm_record_id,channel) do update
    set contact_id=excluded.contact_id,last_message_at=greatest(coalesce(public.crm_conversations.last_message_at,'epoch'::timestamptz),excluded.last_message_at),
        status=case when public.crm_conversations.status='human_active' then 'human_active' else 'ai_active' end,
        ai_enabled=case when public.crm_conversations.status='human_active' then false else public.crm_conversations.ai_enabled end,
        updated_at=now()
  returning id into conversation_key;

  insert into public.crm_messages(organization_id,conversation_id,crm_record_id,direction,actor_type,channel,content,delivery_status,provider_message_id,metadata,occurred_at)
  values(p_organization_id,conversation_key,record_key,'inbound','lead','whatsapp',trim(p_content),'delivered',trim(p_provider_message_id),
    jsonb_build_object('provider','meta_whatsapp_cloud','phone_number_id',trim(p_phone_number_id),'message_type',coalesce(p_message_type,'text'),'from_phone_normalized',normalized_phone),coalesce(p_occurred_at,now()))
  returning id into message_key;

  if exists(select 1 from public.crm_conversations c where c.id=conversation_key and c.ai_enabled=true and c.status<>'human_active') then
    select q.job_id,q.inserted into job_key,job_inserted from public.enqueue_crm_ai_job(p_organization_id,record_key,contact_key,'message_received','whatsapp-inbound:'||trim(p_provider_message_id),'shadow') q;
    if job_inserted then begin perform crm_private.dispatch_crm_ai_worker(); exception when others then raise warning 'WhatsApp AI dispatch fail-open; job=%, sqlstate=%',job_key,sqlstate; end; end if;
  end if;
  return jsonb_build_object('message_id',message_key,'conversation_id',conversation_key,'crm_record_id',record_key,'contact_id',contact_key,'job_id',job_key,'job_inserted',job_inserted,'inserted',true,'duplicate',false);
end
$function$;

-- WhatsApp inbound-created leads must wait for the inbound message before the AI job.
create or replace function crm_private.enqueue_vitoria_after_crm_record_insert()
returns trigger language plpgsql security definer set search_path=''
as $function$
declare runtime_ready boolean:=false; was_inserted boolean:=false; created_job_id uuid;
begin
  if coalesce(new.source_channel,'') in ('meta_lead_ads','whatsapp_inbound') or coalesce(new.source,'') ilike 'Meta Lead Ads%' then return new; end if;
  if new.record_status<>'aberta' then return new; end if;
  select (s.enabled and s.mode='shadow' and s.openai_api_key_vault_id is not null) into runtime_ready from crm_private.ai_runtime_settings s where s.organization_id=new.organization_id;
  if not coalesce(runtime_ready,false) then return new; end if;
  begin select q.job_id,q.inserted into created_job_id,was_inserted from public.enqueue_crm_ai_job(new.organization_id,new.id,new.contact_id,'lead_created','lead-created:'||new.id::text,'shadow') q;
  exception when others then raise warning 'CRM AI enqueue fail-open; crm_record=%, sqlstate=%',new.id,sqlstate; return new; end;
  if was_inserted then begin perform crm_private.dispatch_crm_ai_worker(); exception when others then raise warning 'CRM AI immediate dispatch fail-open; job=%, sqlstate=%',created_job_id,sqlstate; end; end if;
  return new;
end
$function$;

revoke all on function public.get_whatsapp_runtime_status(uuid) from public,anon;
grant execute on function public.get_whatsapp_runtime_status(uuid) to authenticated,service_role;
revoke all on function public.configure_whatsapp_runtime(uuid,text,text,text,text,text,text,text,boolean,text) from public,anon;
grant execute on function public.configure_whatsapp_runtime(uuid,text,text,text,text,text,text,text,boolean,text) to authenticated,service_role;
revoke all on function public.get_whatsapp_runtime_credentials(uuid) from public,anon,authenticated;
grant execute on function public.get_whatsapp_runtime_credentials(uuid) to service_role;
revoke all on function public.get_whatsapp_runtime_by_phone_number_id(text) from public,anon,authenticated;
grant execute on function public.get_whatsapp_runtime_by_phone_number_id(text) to service_role;
revoke all on function public.ingest_whatsapp_inbound_message(uuid,text,text,text,text,timestamptz,text,text) from public,anon,authenticated;
grant execute on function public.ingest_whatsapp_inbound_message(uuid,text,text,text,text,timestamptz,text,text) to service_role;
revoke all on function crm_private.enqueue_vitoria_after_crm_record_insert() from public,anon,authenticated;
grant execute on function crm_private.enqueue_vitoria_after_crm_record_insert() to service_role;

commit;
