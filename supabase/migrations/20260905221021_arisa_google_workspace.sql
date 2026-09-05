begin;
set local lock_timeout='10s';
set local statement_timeout='120s';

create table public.arisa_mail_settings (
  organization_id uuid primary key references public.organizations(id),
  sender_email text not null default 'arisa@evoraurbanismo.com.br' check(sender_email='arisa@evoraurbanismo.com.br'),
  connected_email text, enabled boolean not null default false,
  configured_by uuid references auth.users(id), connected_at timestamptz,
  last_sync_at timestamptz, sync_error text, updated_at timestamptz not null default now()
);
create index arisa_mail_settings_actor on public.arisa_mail_settings(configured_by);
create unique index arisa_mail_connected_account on public.arisa_mail_settings(lower(connected_email)) where enabled and connected_email is not null;
create table private.arisa_mail_credentials (
  organization_id uuid primary key references public.arisa_mail_settings(organization_id),
  client_id text not null, client_secret_id uuid not null references vault.secrets(id),
  refresh_secret_id uuid references vault.secrets(id), scopes text[] not null default '{}',
  sync_cursor jsonb not null default '{}', sync_lease uuid, sync_lease_until timestamptz
);
create index arisa_mail_client_secret on private.arisa_mail_credentials(client_secret_id);
create index arisa_mail_refresh_secret on private.arisa_mail_credentials(refresh_secret_id);
create table private.arisa_mail_oauth_states (
  state_hash text primary key, organization_id uuid not null references public.arisa_mail_settings(organization_id),
  actor_user_id uuid not null references auth.users(id), verifier_secret_id uuid references vault.secrets(id),
  expires_at timestamptz not null default now()+interval '10 minutes', used_at timestamptz, completed_at timestamptz
);
create index arisa_mail_states_org on private.arisa_mail_oauth_states(organization_id);
create index arisa_mail_states_actor on private.arisa_mail_oauth_states(actor_user_id);
create index arisa_mail_states_secret on private.arisa_mail_oauth_states(verifier_secret_id);
alter table public.arisa_mail_settings enable row level security;
alter table private.arisa_mail_credentials enable row level security;
alter table private.arisa_mail_oauth_states enable row level security;
revoke all on public.arisa_mail_settings,private.arisa_mail_credentials,private.arisa_mail_oauth_states from public,anon,authenticated,service_role;
grant select on public.arisa_mail_settings to authenticated,service_role;
create policy arisa_mail_settings_read on public.arisa_mail_settings for select to authenticated using(private.arisa_is_admin(organization_id));

create table public.arisa_mail_messages (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  created_by uuid references auth.users(id), source_message_id uuid references public.arisa_chat_messages(id),
  operation_key text, direction text not null check(direction in ('inbound','outbound')),
  sender text not null, recipients text[] not null default '{}', cc text[] not null default '{}',
  subject text not null, body text not null default '', attachments jsonb not null default '[]', raw_path text,
  provider_message_id text, provider_thread_id text, rfc_message_id text,
  crm_record_id uuid references public.crm_records(id),
  status text not null check(status in ('draft','sending','sent','received','failed','unknown','archive_pending')),
  error_code text, sent_at timestamptz, occurred_at timestamptz not null default now(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(organization_id,operation_key), unique(organization_id,provider_message_id)
);
create index arisa_mail_messages_org on public.arisa_mail_messages(organization_id,occurred_at desc,id);
create index arisa_mail_messages_actor on public.arisa_mail_messages(created_by);
create index arisa_mail_messages_source on public.arisa_mail_messages(source_message_id);
create index arisa_mail_messages_lead on public.arisa_mail_messages(crm_record_id);
create index arisa_mail_messages_pending on public.arisa_mail_messages(status,updated_at) where status in ('sending','unknown');
alter table public.arisa_mail_messages enable row level security;
revoke all on public.arisa_mail_messages from public,anon,authenticated,service_role;
grant select on public.arisa_mail_messages to authenticated;
grant select,insert,update on public.arisa_mail_messages to service_role;
create policy arisa_mail_messages_read on public.arisa_mail_messages for select to authenticated using(private.arisa_is_admin(organization_id));

insert into storage.buckets(id,name,public,file_size_limit) values('arisa-mail','arisa-mail',false,52428800);
create policy arisa_mail_files_read on storage.objects for select to authenticated using(
  bucket_id='arisa-mail' and exists(select 1 from public.arisa_mail_messages m where private.arisa_is_admin(m.organization_id) and
    (m.raw_path=name or exists(select 1 from jsonb_array_elements(m.attachments) a where a->>'bucket'='arisa-mail' and a->>'path'=name)))
);

create function private.arisa_mail_capture() returns trigger language plpgsql security definer set search_path='' as $$
declare subject_key text; label text; matches integer; lead uuid;
begin
  -- Only one exact CRM e-mail match can join channels. Names never establish identity.
  if new.crm_record_id is not null then
    select 'crm:'||id,person_name into subject_key,label from public.crm_records where id=new.crm_record_id and organization_id=new.organization_id;
  elsif new.direction='inbound' then
    select count(*),(array_agg(id))[1] into matches,lead from public.crm_records where organization_id=new.organization_id and lower(btrim(email))=lower(new.sender);
    if matches=1 then select 'crm:'||id,person_name into subject_key,label from public.crm_records where id=lead; end if;
  end if;
  subject_key:=coalesce(subject_key,case when new.direction='inbound' and position('@' in new.sender)>0 then 'email:'||lower(new.sender) else 'mail:'||new.id end);
  perform private.arisa_archive_put(new.organization_id,null,'arisa_mail_messages',new.id::text,'email','email',case when new.direction='inbound' then 'external' else 'arisa' end,
    subject_key,coalesce(label,case when new.direction='inbound' then new.sender else array_to_string(new.recipients,', ') end),new.subject,new.body,to_jsonb(new)-'updated_at',new.occurred_at,
    new.status in ('sent','received') and (tg_op='INSERT' or old.status is distinct from new.status));
  return new;
end $$;
create trigger arisa_mail_archive after insert or update on public.arisa_mail_messages for each row execute function private.arisa_mail_capture();

create function private.arisa_actor_admin(p_org uuid,p_actor uuid) returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.organization_members m join public.organizations o on o.id=m.organization_id where m.organization_id=p_org and m.user_id=p_actor and m.active and m.role='admin' and o.active);
$$;

-- This API is intentionally service-only. The Edge Function authenticates each
-- interactive request before accessing it; scheduled sync uses its own secret.
create function public.arisa_mail_service(p_action text,p_org uuid,p_actor uuid default null,p_args jsonb default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare cfg private.arisa_mail_credentials; settings public.arisa_mail_settings; state private.arisa_mail_oauth_states;
  m public.arisa_mail_messages; secret_id uuid; result jsonb; lease uuid:=gen_random_uuid(); source public.arisa_chat_messages;
begin
  if p_action not in ('runtime','sync_claim','sync_finish') and not private.arisa_actor_admin(p_org,p_actor) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  if not exists(select 1 from public.organizations where id=p_org and active) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  select * into settings from public.arisa_mail_settings where organization_id=p_org;
  select * into cfg from private.arisa_mail_credentials where organization_id=p_org;
  if p_action='status' then
    return jsonb_build_object('sender_email','arisa@evoraurbanismo.com.br','configured',cfg.client_id is not null,'client_id',cfg.client_id,'connected',coalesce(settings.enabled,false) and cfg.refresh_secret_id is not null,'connected_email',settings.connected_email,'last_sync_at',settings.last_sync_at,'sync_error',settings.sync_error,'redirect_uri','https://advent-tau.vercel.app/arisa/email/callback');
  elsif p_action='configure' then
    if p_args->>'client_id' !~ '^[0-9]+-[a-zA-Z0-9_-]+\.apps\.googleusercontent\.com$' or length(coalesce(p_args->>'client_secret','')) not between 12 and 500 then raise exception 'GOOGLE_CLIENT_INVALID'; end if;
    insert into public.arisa_mail_settings(organization_id,configured_by) values(p_org,p_actor) on conflict(organization_id) do update set configured_by=p_actor,updated_at=now();
    if cfg.client_secret_id is null then secret_id:=vault.create_secret(p_args->>'client_secret','arisa-google-client-'||p_org);
    else secret_id:=cfg.client_secret_id; perform vault.update_secret(secret_id,p_args->>'client_secret'); end if;
    insert into private.arisa_mail_credentials(organization_id,client_id,client_secret_id) values(p_org,p_args->>'client_id',secret_id)
      on conflict(organization_id) do update set client_id=excluded.client_id,client_secret_id=excluded.client_secret_id;
    if cfg.client_id is distinct from p_args->>'client_id' then
      update private.arisa_mail_credentials set refresh_secret_id=null,scopes='{}',sync_cursor='{}' where organization_id=p_org;
      update public.arisa_mail_settings set enabled=false,connected_email=null,connected_at=null where organization_id=p_org;
      if cfg.refresh_secret_id is not null then delete from vault.secrets where id=cfg.refresh_secret_id; end if;
    end if;
    perform private.arisa_archive_put(p_org,null,'mail_configuration',gen_random_uuid()::text,'platform','log','administrator','organization:'||p_org,'Évora','Configuração Google Workspace','Credenciais OAuth configuradas.',jsonb_build_object('actor',p_actor,'configured',true),now(),false);
    return jsonb_build_object('configured',true);
  elsif p_action='oauth_begin' then
    if cfg.client_id is null then raise exception 'GOOGLE_NOT_CONFIGURED'; end if;
    if p_args->>'state_hash' !~ '^[a-f0-9]{64}$' or length(coalesce(p_args->>'verifier','')) not between 43 and 128 then raise exception 'INVALID_STATE'; end if;
    with expired as (delete from private.arisa_mail_oauth_states where organization_id=p_org and expires_at<now() returning verifier_secret_id)
      delete from vault.secrets where id in (select verifier_secret_id from expired where verifier_secret_id is not null);
    secret_id:=vault.create_secret(p_args->>'verifier');
    insert into private.arisa_mail_oauth_states(state_hash,organization_id,actor_user_id,verifier_secret_id) values(p_args->>'state_hash',p_org,p_actor,secret_id);
    return jsonb_build_object('client_id',cfg.client_id);
  elsif p_action='oauth_consume' then
    select * into state from private.arisa_mail_oauth_states where state_hash=p_args->>'state_hash' and organization_id=p_org and actor_user_id=p_actor and used_at is null and expires_at>now() for update;
    if not found then raise exception 'GOOGLE_STATE_EXPIRED'; end if;
    select jsonb_build_object('client_id',cfg.client_id,'client_secret',s.decrypted_secret,'verifier',v.decrypted_secret) into result from vault.decrypted_secrets s,vault.decrypted_secrets v where s.id=cfg.client_secret_id and v.id=state.verifier_secret_id;
    update private.arisa_mail_oauth_states set used_at=now(),verifier_secret_id=null where state_hash=state.state_hash;
    delete from vault.secrets where id=state.verifier_secret_id;
    return result;
  elsif p_action='oauth_finish' then
    select * into state from private.arisa_mail_oauth_states where state_hash=p_args->>'state_hash' and organization_id=p_org and actor_user_id=p_actor and used_at is not null and completed_at is null and expires_at>now() for update;
    if not found or p_args->>'email'<>'arisa@evoraurbanismo.com.br' or length(coalesce(p_args->>'refresh_token',''))<20 then raise exception 'GOOGLE_ACCOUNT_MISMATCH'; end if;
    if cfg.refresh_secret_id is null then secret_id:=vault.create_secret(p_args->>'refresh_token','arisa-google-refresh-'||p_org);
    else secret_id:=cfg.refresh_secret_id; perform vault.update_secret(secret_id,p_args->>'refresh_token'); end if;
    update private.arisa_mail_credentials set refresh_secret_id=secret_id,scopes=array(select jsonb_array_elements_text(p_args->'scopes')),sync_cursor='{}' where organization_id=p_org;
    update public.arisa_mail_settings set enabled=true,connected_email=p_args->>'email',connected_at=now(),sync_error=null,updated_at=now() where organization_id=p_org;
    update private.arisa_mail_oauth_states set completed_at=now() where state_hash=state.state_hash;
    perform private.arisa_archive_put(p_org,null,'mail_connection',gen_random_uuid()::text,'platform','log','administrator','organization:'||p_org,'Évora','Conta Arisa conectada','Autorização Google concluída para arisa@evoraurbanismo.com.br.',jsonb_build_object('actor',p_actor),now(),false);
    return jsonb_build_object('connected',true);
  elsif p_action='disconnect' then
    update public.arisa_mail_settings set enabled=false,updated_at=now() where organization_id=p_org;
    update private.arisa_mail_credentials set refresh_secret_id=null,scopes='{}' where organization_id=p_org;
    if cfg.refresh_secret_id is not null then delete from vault.secrets where id=cfg.refresh_secret_id; end if;
    perform private.arisa_archive_put(p_org,null,'mail_disconnect',gen_random_uuid()::text,'platform','log','administrator','organization:'||p_org,'Évora','Conta desconectada','Envio e sincronização desativados; arquivo preservado.',jsonb_build_object('actor',p_actor),now(),false);
    return jsonb_build_object('connected',false);
  elsif p_action='log' then
    perform private.arisa_archive_put(p_org,null,'mail_request',gen_random_uuid()::text,'email','log','system','organization:'||p_org,'Évora','Operação de e-mail','',jsonb_build_object('actor',p_actor,'action',left(p_args->>'action',30),'error',left(p_args->>'error',80),'reference',p_args->>'reference'),now(),false);
    return jsonb_build_object('ok',true);
  elsif p_action='runtime' then
    if not coalesce(settings.enabled,false) or cfg.refresh_secret_id is null then raise exception 'GOOGLE_NOT_CONNECTED'; end if;
    select jsonb_build_object('client_id',cfg.client_id,'client_secret',s.decrypted_secret,'refresh_token',r.decrypted_secret,'sender',settings.sender_email,'cursor',cfg.sync_cursor) into result from vault.decrypted_secrets s,vault.decrypted_secrets r where s.id=cfg.client_secret_id and r.id=cfg.refresh_secret_id;
    return result;
  elsif p_action='sync_claim' then
    update private.arisa_mail_credentials set sync_lease=lease,sync_lease_until=now()+interval '3 minutes'
      where organization_id=p_org and (sync_lease_until is null or sync_lease_until<now()) and settings.enabled returning * into cfg;
    if not found then return null; end if;
    return jsonb_build_object('lease',lease,'cursor',cfg.sync_cursor);
  elsif p_action='sync_finish' then
    update private.arisa_mail_credentials set sync_cursor=case when p_args ? 'cursor' then p_args->'cursor' else sync_cursor end,sync_lease=null,sync_lease_until=null
      where organization_id=p_org and sync_lease=(p_args->>'lease')::uuid;
    if not found then raise exception 'MAIL_SYNC_LEASE_CHANGED'; end if;
    update public.arisa_mail_settings set last_sync_at=case when p_args->>'error' is null then now() else last_sync_at end,sync_error=left(p_args->>'error',80),updated_at=now() where organization_id=p_org;
    perform private.arisa_archive_put(p_org,null,'mail_sync',gen_random_uuid()::text,'email','log','system','organization:'||p_org,'Évora','Sincronização de e-mail','',jsonb_build_object('error',left(p_args->>'error',80),'cursor',p_args->'cursor'),now(),false);
    return jsonb_build_object('ok',true);
  elsif p_action='prepare' then
    if p_args->>'operation_key' !~ '^[a-f0-9]{64}$' or length(coalesce(p_args->>'subject','')) not between 1 and 250 or length(coalesce(p_args->>'body','')) not between 1 and 150000 or jsonb_array_length(coalesce(p_args->'to','[]')) not between 1 and 20 then raise exception 'MAIL_INVALID'; end if;
    if nullif(p_args->>'source_message_id','') is not null then
      select * into source from public.arisa_chat_messages where id=(p_args->>'source_message_id')::uuid and organization_id=p_org and owner_user_id=p_actor and role='user' and status='processing' and lease_token=(p_args->>'lease')::uuid and lease_expires_at>now();
      if not found then raise exception 'ARISA_LEASE_CHANGED'; end if;
    end if;
    if nullif(p_args->>'crm_record_id','') is not null and not exists(select 1 from public.crm_records where id=(p_args->>'crm_record_id')::uuid and organization_id=p_org) then raise exception 'MAIL_INVALID_LEAD'; end if;
    insert into public.arisa_mail_messages(organization_id,created_by,source_message_id,operation_key,direction,sender,recipients,cc,subject,body,attachments,crm_record_id,status)
      values(p_org,p_actor,nullif(p_args->>'source_message_id','')::uuid,p_args->>'operation_key','outbound','arisa@evoraurbanismo.com.br',array(select jsonb_array_elements_text(p_args->'to')),array(select jsonb_array_elements_text(coalesce(p_args->'cc','[]'))),p_args->>'subject',p_args->>'body',coalesce(p_args->'attachments','[]'),nullif(p_args->>'crm_record_id','')::uuid,'draft')
      on conflict(organization_id,operation_key) do nothing;
    select * into m from public.arisa_mail_messages where organization_id=p_org and operation_key=p_args->>'operation_key';
    if m.created_by<>p_actor then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
    return to_jsonb(m);
  elsif p_action='send_begin' then
    select * into m from public.arisa_mail_messages where id=(p_args->>'id')::uuid and organization_id=p_org and created_by=p_actor for update;
    if not found then raise exception 'MAIL_NOT_FOUND'; end if;
    if m.status not in ('draft','failed') then return jsonb_build_object('send',false,'message',to_jsonb(m)); end if;
    if not coalesce(settings.enabled,false) then raise exception 'GOOGLE_NOT_CONNECTED'; end if;
    if m.source_message_id is not null and not exists(select 1 from public.arisa_chat_messages where id=m.source_message_id and owner_user_id=p_actor and status='processing' and lease_token=(p_args->>'lease')::uuid and lease_expires_at>now()) then raise exception 'ARISA_LEASE_CHANGED'; end if;
    update public.arisa_mail_messages set status='sending',raw_path=p_args->>'raw_path',rfc_message_id=p_args->>'rfc_message_id',error_code=null,updated_at=now() where id=m.id returning * into m;
    return jsonb_build_object('send',true,'message',to_jsonb(m));
  end if;
  raise exception 'INVALID_ACTION';
end $$;

-- A dedicated worker secret never reaches the client or the archive.
do $$ begin
  if not exists(select 1 from vault.secrets where name='arisa-background-secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32),'hex'),'arisa-background-secret');
  end if;
end $$;
create function public.arisa_background_secret() returns text language sql stable security definer set search_path='' as $$
  select decrypted_secret from vault.decrypted_secrets where name='arisa-background-secret';
$$;

revoke all on function private.arisa_mail_capture(),private.arisa_actor_admin(uuid,uuid),public.arisa_mail_service(text,uuid,uuid,jsonb),public.arisa_background_secret() from public,anon,authenticated,service_role;
grant execute on function public.arisa_mail_service(text,uuid,uuid,jsonb),public.arisa_background_secret() to service_role;

-- This queue processes interaction memory and mailbox synchronization; it does
-- not generate scheduled insights or change the existing 06:00 insight job.
select cron.schedule('evora-arisa-memory-mail-5m','*/5 * * * *',$cron$
  select net.http_post(
    url:='https://qsdffayasuzsmngteika.supabase.co/functions/v1/arisa-background',
    headers:=jsonb_build_object('content-type','application/json','x-arisa-worker-secret',(select decrypted_secret from vault.decrypted_secrets where name='arisa-background-secret')),
    body:='{}'::jsonb,timeout_milliseconds:=170000
  );
$cron$);
select cron.alter_job(jobid,active:=false) from cron.job where jobname='evora-arisa-memory-mail-5m';
commit;
