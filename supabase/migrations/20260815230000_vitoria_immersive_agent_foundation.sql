begin;

alter table crm_private.public_agent_sessions
  add column if not exists voice_request_count integer not null default 0,
  add column if not exists image_generation_count integer not null default 0,
  add column if not exists last_voice_at timestamptz,
  add column if not exists last_image_at timestamptz,
  add column if not exists marketing_consent_at timestamptz,
  add column if not exists consent_copy_version text;

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'crm_private.public_agent_sessions'::regclass
      and conname = 'public_agent_sessions_voice_count_check'
  ) then
    alter table crm_private.public_agent_sessions
      add constraint public_agent_sessions_voice_count_check
      check (voice_request_count between 0 and 200);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'crm_private.public_agent_sessions'::regclass
      and conname = 'public_agent_sessions_image_count_check'
  ) then
    alter table crm_private.public_agent_sessions
      add constraint public_agent_sessions_image_count_check
      check (image_generation_count between 0 and 10);
  end if;
end
$constraints$;

alter table crm_private.vitoria_knowledge_sources
  add column if not exists public_share boolean not null default false,
  add column if not exists public_description text,
  add column if not exists public_category text,
  add column if not exists last_error text;

create table if not exists crm_private.vitoria_generated_assets (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references crm_private.public_agent_sessions(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  asset_type text not null default 'home_simulation',
  title text not null,
  prompt text not null,
  storage_bucket text,
  storage_path text,
  mime_type text,
  status text not null default 'processing',
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint vitoria_generated_assets_type_check
    check (asset_type in ('home_simulation')),
  constraint vitoria_generated_assets_status_check
    check (status in ('processing','completed','failed')),
  constraint vitoria_generated_assets_title_check
    check (char_length(trim(title)) between 2 and 180),
  constraint vitoria_generated_assets_prompt_check
    check (char_length(trim(prompt)) between 10 and 8000),
  constraint vitoria_generated_assets_metadata_check
    check (jsonb_typeof(metadata)='object' and pg_column_size(metadata)<=32768)
);

create index if not exists vitoria_generated_assets_session_idx
  on crm_private.vitoria_generated_assets(session_id, created_at desc);
create index if not exists vitoria_generated_assets_org_project_idx
  on crm_private.vitoria_generated_assets(organization_id, project_id, created_at desc);

alter table crm_private.vitoria_generated_assets enable row level security;
revoke all on crm_private.vitoria_generated_assets from public, anon, authenticated;

do $bucket$
begin
  insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values(
    'vitoria-simulations',
    'vitoria-simulations',
    false,
    10485760,
    array['image/png','image/jpeg','image/webp']::text[]
  )
  on conflict(id) do update
  set public=false,
      file_size_limit=excluded.file_size_limit,
      allowed_mime_types=excluded.allowed_mime_types;
end
$bucket$;

create or replace function public.get_public_agent_enterprise_context(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  experience_row crm_private.public_agent_experiences%rowtype;
  organization_row public.organizations%rowtype;
  projects_json jsonb;
  products_json jsonb;
begin
  perform crm_private.assert_public_agent_service_role();

  select experience.* into experience_row
  from crm_private.public_agent_experiences experience
  where experience.slug=lower(trim(p_slug)) and experience.active
  order by experience.created_at desc
  limit 1;
  if not found then raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND'; end if;

  select organization.* into organization_row
  from public.organizations organization
  where organization.id=experience_row.organization_id and organization.active;
  if not found then raise exception 'PUBLIC_AGENT_ORGANIZATION_NOT_FOUND'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',project.id,
    'code',project.code,
    'name',project.name,
    'city',project.city,
    'state',project.state,
    'status',project.status,
    'isCurrent',project.id=experience_row.project_id
  ) order by (project.id=experience_row.project_id) desc,project.name),'[]'::jsonb)
  into projects_json
  from public.projects project
  where project.organization_id=experience_row.organization_id and project.active;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',product.id,
    'projectId',product.project_id,
    'code',product.code,
    'name',product.name,
    'type',product.product_type,
    'description',product.description,
    'metadata',product.metadata,
    'isCurrent',product.id=experience_row.product_id
  ) order by (product.id=experience_row.product_id) desc,product.name),'[]'::jsonb)
  into products_json
  from public.crm_products product
  where product.organization_id=experience_row.organization_id and product.active;

  return jsonb_build_object(
    'organization',jsonb_build_object(
      'name',organization_row.name,
      'tradeName',organization_row.trade_name,
      'currency',organization_row.currency
    ),
    'currentProjectId',experience_row.project_id,
    'currentProductId',experience_row.product_id,
    'projects',projects_json,
    'products',products_json,
    'updatedAt',clock_timestamp()
  );
end
$function$;

create or replace function public.get_public_agent_v3_context(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  experience_row crm_private.public_agent_experiences%rowtype;
  session_row crm_private.public_agent_sessions%rowtype;
  runtime_row crm_private.ai_runtime_settings%rowtype;
  transcript jsonb;
  minute_count integer;
  hour_count integer;
begin
  perform crm_private.assert_public_agent_service_role();

  select session.* into session_row
  from crm_private.public_agent_sessions session
  join crm_private.public_agent_experiences experience on experience.id=session.experience_id
  where experience.slug=lower(trim(p_slug))
    and experience.active
    and session.session_token_hash=p_session_token_hash
    and session.fingerprint_hash=p_fingerprint_hash
  for update of session;
  if not found then raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND'; end if;
  if session_row.status in ('closed','blocked') or session_row.expires_at<=now() then
    raise exception 'PUBLIC_AGENT_SESSION_INACTIVE';
  end if;

  select experience.* into experience_row
  from crm_private.public_agent_experiences experience
  where experience.id=session_row.experience_id and experience.active;
  if not found then raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND'; end if;

  select runtime.* into runtime_row
  from crm_private.ai_runtime_settings runtime
  where runtime.organization_id=session_row.organization_id;

  select count(*) filter(where message.created_at>=now()-interval '1 minute'),
         count(*) filter(where message.created_at>=now()-interval '1 hour')
  into minute_count,hour_count
  from crm_private.public_agent_messages message
  where message.session_id=session_row.id and message.direction='user';
  if minute_count>=6 or hour_count>=40 or session_row.message_count>=140 then
    raise exception 'PUBLIC_AGENT_MESSAGE_RATE_LIMIT';
  end if;

  select coalesce(jsonb_agg(message_row order by message_row.created_at,message_row.id),'[]'::jsonb)
  into transcript
  from (
    select message.id,message.direction,message.content,message.metadata,message.created_at
    from crm_private.public_agent_messages message
    where message.session_id=session_row.id
    order by message.created_at desc,message.id desc
    limit 32
  ) message_row;

  update crm_private.public_agent_sessions
  set last_activity_at=now(),updated_at=now()
  where id=session_row.id;

  return jsonb_build_object(
    'organizationId',session_row.organization_id,
    'projectId',experience_row.project_id,
    'productId',experience_row.product_id,
    'sessionId',session_row.id,
    'stage',session_row.stage,
    'profile',session_row.captured_profile,
    'contactCapture',session_row.contact_capture,
    'contactConsented',session_row.contact_consent_at is not null,
    'marketingConsented',session_row.marketing_consent,
    'converted',session_row.crm_record_id is not null,
    'leadProtocol',case when session_row.crm_record_id is null then null else upper(left(replace(session_row.crm_record_id::text,'-',''),10)) end,
    'knowledge',experience_row.knowledge,
    'vectorStoreId',runtime_row.knowledge_vector_store_id,
    'experience',jsonb_build_object(
      'slug',experience_row.slug,
      'name',experience_row.name,
      'agentName',experience_row.agent_name,
      'title',experience_row.title,
      'subtitle',experience_row.subtitle,
      'eyebrow',experience_row.eyebrow,
      'heroImageUrl',experience_row.hero_image_url,
      'theme',experience_row.theme
    ),
    'messages',transcript
  );
end
$function$;

create or replace function public.update_public_agent_contact_capture_v3(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_patch jsonb,
  p_service_consent boolean default null,
  p_marketing_consent boolean default null,
  p_consent_copy_version text default null
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  session_row crm_private.public_agent_sessions%rowtype;
  clean_patch jsonb := '{}'::jsonb;
  phone_digits text;
  phone_e164 text;
  email_value text;
  name_value text;
  city_value text;
begin
  perform crm_private.assert_public_agent_service_role();
  if p_patch is null or jsonb_typeof(p_patch)<>'object' or pg_column_size(p_patch)>8192 then
    raise exception 'PUBLIC_AGENT_CONTACT_INVALID';
  end if;

  select session.* into session_row
  from crm_private.public_agent_sessions session
  join crm_private.public_agent_experiences experience on experience.id=session.experience_id
  where experience.slug=lower(trim(p_slug))
    and experience.active
    and session.session_token_hash=p_session_token_hash
    and session.fingerprint_hash=p_fingerprint_hash
  for update of session;
  if not found then raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND'; end if;

  name_value:=left(nullif(trim(p_patch->>'name'),''),180);
  if name_value is not null and char_length(name_value)>=2 then
    clean_patch:=clean_patch||jsonb_build_object('name',name_value);
  end if;

  phone_digits:=regexp_replace(coalesce(p_patch->>'phone',''),'[^0-9]','','g');
  if left(phone_digits,2)='55' then phone_digits:=substr(phone_digits,3); end if;
  if phone_digits~'^[0-9]{10,11}$' then
    phone_e164:='+55'||phone_digits;
    clean_patch:=clean_patch||jsonb_build_object('phone',phone_e164);
  end if;

  email_value:=lower(left(nullif(trim(p_patch->>'email'),''),320));
  if email_value is not null and email_value~'^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' then
    clean_patch:=clean_patch||jsonb_build_object('email',email_value);
  end if;

  city_value:=left(nullif(trim(coalesce(p_patch->>'city',p_patch->>'preferred_city')),''),180);
  if city_value is not null then clean_patch:=clean_patch||jsonb_build_object('city',city_value); end if;

  if coalesce(p_patch->>'preferred_contact_method','') in ('telefone','whatsapp','email') then
    clean_patch:=clean_patch||jsonb_build_object('preferred_contact_method',p_patch->>'preferred_contact_method');
  end if;

  update crm_private.public_agent_sessions
  set contact_capture=contact_capture||clean_patch,
      contact_consent_at=case when p_service_consent=true then now() when p_service_consent=false then null else contact_consent_at end,
      marketing_consent=case when p_marketing_consent is null then marketing_consent else p_marketing_consent end,
      marketing_consent_at=case when p_marketing_consent=true then now() when p_marketing_consent=false then null else marketing_consent_at end,
      consent_copy_version=coalesce(left(nullif(trim(p_consent_copy_version),''),80),consent_copy_version),
      stage=case when p_service_consent=true then 'handoff' when clean_patch<>'{}'::jsonb then 'contact' else stage end,
      updated_at=now(),
      last_activity_at=now()
  where id=session_row.id
  returning * into session_row;

  return jsonb_build_object(
    'contactCapture',session_row.contact_capture,
    'serviceConsented',session_row.contact_consent_at is not null,
    'marketingConsented',session_row.marketing_consent,
    'converted',session_row.crm_record_id is not null
  );
end
$function$;

create or replace function public.consume_public_agent_voice_quota(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare session_row crm_private.public_agent_sessions%rowtype;
begin
  perform crm_private.assert_public_agent_service_role();
  select session.* into session_row
  from crm_private.public_agent_sessions session
  join crm_private.public_agent_experiences experience on experience.id=session.experience_id
  where experience.slug=lower(trim(p_slug)) and experience.active
    and session.session_token_hash=p_session_token_hash
    and session.fingerprint_hash=p_fingerprint_hash
  for update of session;
  if not found then raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND'; end if;
  if session_row.status in ('closed','blocked') or session_row.expires_at<=now() then raise exception 'PUBLIC_AGENT_SESSION_INACTIVE'; end if;
  if session_row.voice_request_count>=60 then raise exception 'PUBLIC_AGENT_VOICE_LIMIT'; end if;
  if session_row.last_voice_at is not null and session_row.last_voice_at>now()-interval '3 seconds' then raise exception 'PUBLIC_AGENT_VOICE_RATE_LIMIT'; end if;
  update crm_private.public_agent_sessions
  set voice_request_count=voice_request_count+1,last_voice_at=now(),last_activity_at=now(),updated_at=now()
  where id=session_row.id
  returning * into session_row;
  return jsonb_build_object('allowed',true,'used',session_row.voice_request_count,'remaining',greatest(0,60-session_row.voice_request_count));
end
$function$;

create or replace function public.consume_public_agent_image_quota(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare session_row crm_private.public_agent_sessions%rowtype;
begin
  perform crm_private.assert_public_agent_service_role();
  select session.* into session_row
  from crm_private.public_agent_sessions session
  join crm_private.public_agent_experiences experience on experience.id=session.experience_id
  where experience.slug=lower(trim(p_slug)) and experience.active
    and session.session_token_hash=p_session_token_hash
    and session.fingerprint_hash=p_fingerprint_hash
  for update of session;
  if not found then raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND'; end if;
  if session_row.status in ('closed','blocked') or session_row.expires_at<=now() then raise exception 'PUBLIC_AGENT_SESSION_INACTIVE'; end if;
  if session_row.image_generation_count>=2 then raise exception 'PUBLIC_AGENT_IMAGE_LIMIT'; end if;
  if session_row.last_image_at is not null and session_row.last_image_at>now()-interval '30 seconds' then raise exception 'PUBLIC_AGENT_IMAGE_RATE_LIMIT'; end if;
  update crm_private.public_agent_sessions
  set image_generation_count=image_generation_count+1,last_image_at=now(),last_activity_at=now(),updated_at=now()
  where id=session_row.id
  returning * into session_row;
  return jsonb_build_object('allowed',true,'used',session_row.image_generation_count,'remaining',greatest(0,2-session_row.image_generation_count));
end
$function$;

create or replace function public.register_public_agent_generated_asset(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_asset_id uuid,
  p_title text,
  p_prompt text,
  p_storage_bucket text,
  p_storage_path text,
  p_mime_type text,
  p_status text,
  p_error_message text,
  p_metadata jsonb
)
returns uuid
language plpgsql
security definer
set search_path=''
as $function$
declare
  experience_row crm_private.public_agent_experiences%rowtype;
  session_row crm_private.public_agent_sessions%rowtype;
  asset_id uuid:=coalesce(p_asset_id,gen_random_uuid());
begin
  perform crm_private.assert_public_agent_service_role();
  if p_status not in ('processing','completed','failed') then raise exception 'PUBLIC_AGENT_ASSET_STATUS_INVALID'; end if;
  if p_metadata is null or jsonb_typeof(p_metadata)<>'object' or pg_column_size(p_metadata)>32768 then raise exception 'PUBLIC_AGENT_ASSET_METADATA_INVALID'; end if;
  select session.* into session_row
  from crm_private.public_agent_sessions session
  join crm_private.public_agent_experiences experience on experience.id=session.experience_id
  where experience.slug=lower(trim(p_slug)) and experience.active
    and session.session_token_hash=p_session_token_hash
    and session.fingerprint_hash=p_fingerprint_hash;
  if not found then raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND'; end if;
  select experience.* into experience_row from crm_private.public_agent_experiences experience where experience.id=session_row.experience_id;

  insert into crm_private.vitoria_generated_assets(
    id,session_id,organization_id,project_id,asset_type,title,prompt,
    storage_bucket,storage_path,mime_type,status,error_message,metadata
  ) values(
    asset_id,session_row.id,session_row.organization_id,experience_row.project_id,'home_simulation',
    left(trim(p_title),180),left(trim(p_prompt),8000),p_storage_bucket,p_storage_path,p_mime_type,p_status,left(p_error_message,1000),p_metadata
  )
  on conflict(id) do update set
    storage_bucket=excluded.storage_bucket,
    storage_path=excluded.storage_path,
    mime_type=excluded.mime_type,
    status=excluded.status,
    error_message=excluded.error_message,
    metadata=excluded.metadata,
    updated_at=now();
  return asset_id;
end
$function$;

create or replace function public.list_public_agent_shared_resources(p_slug text,p_limit integer default 8)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare experience_row crm_private.public_agent_experiences%rowtype;
begin
  perform crm_private.assert_public_agent_service_role();
  select experience.* into experience_row from crm_private.public_agent_experiences experience
  where experience.slug=lower(trim(p_slug)) and experience.active limit 1;
  if not found then raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND'; end if;
  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',source.id,
      'title',source.title,
      'description',source.public_description,
      'category',source.public_category,
      'originalFilename',source.original_filename,
      'mimeType',source.mime_type,
      'bytes',source.bytes,
      'storagePath',source.storage_path,
      'updatedAt',source.updated_at
    ) order by source.updated_at desc),'[]'::jsonb)
    from (
      select source.*
      from crm_private.vitoria_knowledge_sources source
      where source.organization_id=experience_row.organization_id
        and source.active
        and source.public_share
        and source.source_type='file'
        and source.storage_path is not null
        and source.vector_file_status='completed'
        and (source.scope='organization' or source.project_id=experience_row.project_id)
      order by source.updated_at desc
      limit greatest(1,least(20,coalesce(p_limit,8)))
    ) source
  );
end
$function$;

create or replace function public.list_vitoria_knowledge_sources(p_organization_id uuid)
returns jsonb
language sql
security definer
set search_path=''
as $function$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',source.id,
    'organization_id',source.organization_id,
    'project_id',source.project_id,
    'scope',source.scope,
    'source_type',source.source_type,
    'title',source.title,
    'content_preview',source.content_preview,
    'original_filename',source.original_filename,
    'mime_type',source.mime_type,
    'bytes',source.bytes,
    'vector_file_status',source.vector_file_status,
    'public_share',source.public_share,
    'public_description',source.public_description,
    'public_category',source.public_category,
    'last_error',source.last_error,
    'active',source.active,
    'created_at',source.created_at,
    'updated_at',source.updated_at
  ) order by source.updated_at desc),'[]'::jsonb)
  from crm_private.vitoria_knowledge_sources source
  where source.organization_id=p_organization_id;
$function$;

create or replace function public.upsert_vitoria_knowledge_source_v2(
  p_id uuid,
  p_organization_id uuid,
  p_project_id uuid,
  p_scope text,
  p_source_type text,
  p_title text,
  p_content_preview text,
  p_storage_path text,
  p_original_filename text,
  p_mime_type text,
  p_bytes bigint,
  p_openai_file_id text,
  p_vector_store_id text,
  p_vector_file_status text,
  p_public_share boolean,
  p_public_description text,
  p_public_category text,
  p_last_error text,
  p_created_by uuid
)
returns uuid
language plpgsql
security definer
set search_path=''
as $function$
declare source_id uuid:=coalesce(p_id,gen_random_uuid());
begin
  if p_scope not in ('organization','project')
     or p_source_type not in ('text','file')
     or p_vector_file_status not in ('pending','processing','completed','failed') then
    raise exception 'VITORIA_KNOWLEDGE_INVALID';
  end if;
  if p_scope='project' and not exists(
    select 1 from public.projects project
    where project.id=p_project_id and project.organization_id=p_organization_id and project.active
  ) then raise exception 'VITORIA_KNOWLEDGE_PROJECT_INVALID'; end if;

  insert into crm_private.vitoria_knowledge_sources(
    id,organization_id,project_id,scope,source_type,title,content_preview,
    storage_path,original_filename,mime_type,bytes,openai_file_id,vector_store_id,
    vector_file_status,public_share,public_description,public_category,last_error,active,created_by
  ) values(
    source_id,p_organization_id,case when p_scope='project' then p_project_id else null end,
    p_scope,p_source_type,left(trim(p_title),180),left(p_content_preview,1200),p_storage_path,
    p_original_filename,p_mime_type,p_bytes,p_openai_file_id,p_vector_store_id,p_vector_file_status,
    coalesce(p_public_share,false) and p_source_type='file',left(p_public_description,800),left(p_public_category,80),left(p_last_error,1000),true,p_created_by
  )
  on conflict(id) do update set
    project_id=excluded.project_id,
    scope=excluded.scope,
    source_type=excluded.source_type,
    title=excluded.title,
    content_preview=excluded.content_preview,
    storage_path=excluded.storage_path,
    original_filename=excluded.original_filename,
    mime_type=excluded.mime_type,
    bytes=excluded.bytes,
    openai_file_id=excluded.openai_file_id,
    vector_store_id=excluded.vector_store_id,
    vector_file_status=excluded.vector_file_status,
    public_share=excluded.public_share,
    public_description=excluded.public_description,
    public_category=excluded.public_category,
    last_error=excluded.last_error,
    active=true,
    updated_at=now();
  return source_id;
end
$function$;

revoke all on function public.get_public_agent_enterprise_context(text) from public,anon,authenticated;
revoke all on function public.get_public_agent_v3_context(text,text,text) from public,anon,authenticated;
revoke all on function public.update_public_agent_contact_capture_v3(text,text,text,jsonb,boolean,boolean,text) from public,anon,authenticated;
revoke all on function public.consume_public_agent_voice_quota(text,text,text) from public,anon,authenticated;
revoke all on function public.consume_public_agent_image_quota(text,text,text) from public,anon,authenticated;
revoke all on function public.register_public_agent_generated_asset(text,text,text,uuid,text,text,text,text,text,text,text,jsonb) from public,anon,authenticated;
revoke all on function public.list_public_agent_shared_resources(text,integer) from public,anon,authenticated;
revoke all on function public.list_vitoria_knowledge_sources(uuid) from public,anon,authenticated;
revoke all on function public.upsert_vitoria_knowledge_source_v2(uuid,uuid,uuid,text,text,text,text,text,text,text,bigint,text,text,text,boolean,text,text,text,uuid) from public,anon,authenticated;

grant execute on function public.get_public_agent_enterprise_context(text) to service_role;
grant execute on function public.get_public_agent_v3_context(text,text,text) to service_role;
grant execute on function public.update_public_agent_contact_capture_v3(text,text,text,jsonb,boolean,boolean,text) to service_role;
grant execute on function public.consume_public_agent_voice_quota(text,text,text) to service_role;
grant execute on function public.consume_public_agent_image_quota(text,text,text) to service_role;
grant execute on function public.register_public_agent_generated_asset(text,text,text,uuid,text,text,text,text,text,text,text,jsonb) to service_role;
grant execute on function public.list_public_agent_shared_resources(text,integer) to service_role;
grant execute on function public.list_vitoria_knowledge_sources(uuid) to service_role;
grant execute on function public.upsert_vitoria_knowledge_source_v2(uuid,uuid,uuid,text,text,text,text,text,text,text,bigint,text,text,text,boolean,text,text,text,uuid) to service_role;

commit;
