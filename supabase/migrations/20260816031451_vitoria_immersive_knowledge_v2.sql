begin;

alter table crm_private.public_agent_experiences
  add column if not exists greeting_text text,
  add column if not exists avatar jsonb not null default '{}'::jsonb,
  add column if not exists capabilities jsonb not null default '{}'::jsonb,
  add column if not exists openai_vector_store_id text;

update crm_private.public_agent_experiences
set greeting_text = coalesce(nullif(greeting_text, ''),
  'Olá, sou a Vitória, assistente virtual da Évora Urbanismo. Posso apresentar nossos empreendimentos, esclarecer dúvidas, simular possibilidades e acompanhar você até o atendimento de um especialista.'),
    avatar = case when avatar = '{}'::jsonb then jsonb_build_object(
      'mode','animated_svg',
      'displayName','Vitória',
      'subtitle','Especialista digital da Évora Urbanismo',
      'voice','coral',
      'imageUrl',null,
      'videoUrl',null
    ) else avatar end,
    capabilities = case when capabilities = '{}'::jsonb then jsonb_build_object(
      'voiceInput',true,
      'voiceOutput',true,
      'documentPresentation',true,
      'houseSimulation',true,
      'enterpriseCommercialData',true,
      'inChatContactCapture',true,
      'humanHandoff',true
    ) else capabilities end
where slug='solaris';

create table if not exists crm_private.public_agent_knowledge_items (
  id uuid primary key default gen_random_uuid(),
  experience_id uuid not null references crm_private.public_agent_experiences(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  project_id uuid references public.projects(id) on delete set null,
  title text not null,
  description text,
  knowledge_type text not null default 'text',
  body_text text,
  source_url text,
  storage_bucket text,
  storage_path text,
  mime_type text,
  file_size bigint,
  openai_file_id text,
  openai_vector_store_file_id text,
  indexing_status text not null default 'not_required',
  public_to_lead boolean not null default false,
  agent_searchable boolean not null default true,
  active boolean not null default true,
  sort_order integer not null default 100,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint public_agent_knowledge_type_check check (knowledge_type in ('text','url','file','enterprise_document','image','video')),
  constraint public_agent_knowledge_indexing_check check (indexing_status in ('not_required','pending','processing','ready','failed','archived')),
  constraint public_agent_knowledge_title_check check (char_length(trim(title)) between 2 and 240),
  constraint public_agent_knowledge_body_check check (body_text is null or char_length(body_text) <= 200000),
  constraint public_agent_knowledge_metadata_check check (jsonb_typeof(metadata)='object' and pg_column_size(metadata)<=65536)
);

create index if not exists public_agent_knowledge_experience_idx
  on crm_private.public_agent_knowledge_items(experience_id, active, agent_searchable, sort_order, updated_at desc);
create index if not exists public_agent_knowledge_openai_file_idx
  on crm_private.public_agent_knowledge_items(openai_file_id)
  where openai_file_id is not null;

create table if not exists crm_private.public_agent_generated_assets (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references crm_private.public_agent_sessions(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  crm_record_id uuid references public.crm_records(id) on delete set null,
  asset_type text not null,
  title text not null,
  prompt text,
  storage_bucket text not null,
  storage_path text not null,
  public_url text,
  mime_type text not null default 'image/png',
  model text,
  status text not null default 'ready',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint public_agent_generated_type_check check (asset_type in ('house_simulation','illustration','voice')),
  constraint public_agent_generated_status_check check (status in ('pending','ready','failed','archived')),
  constraint public_agent_generated_metadata_check check (jsonb_typeof(metadata)='object' and pg_column_size(metadata)<=65536)
);

create index if not exists public_agent_generated_session_idx
  on crm_private.public_agent_generated_assets(session_id, created_at desc);

create table if not exists crm_private.public_agent_usage_events (
  id bigint generated always as identity primary key,
  experience_id uuid references crm_private.public_agent_experiences(id) on delete set null,
  session_id uuid references crm_private.public_agent_sessions(id) on delete set null,
  organization_id uuid references public.organizations(id) on delete cascade,
  event_name text not null,
  model text,
  input_tokens integer,
  output_tokens integer,
  image_count integer,
  duration_ms integer,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint public_agent_usage_event_check check (char_length(event_name) between 2 and 100),
  constraint public_agent_usage_metadata_check check (jsonb_typeof(metadata)='object' and pg_column_size(metadata)<=32768)
);

create index if not exists public_agent_usage_session_idx
  on crm_private.public_agent_usage_events(session_id, created_at desc);

alter table crm_private.public_agent_knowledge_items enable row level security;
alter table crm_private.public_agent_generated_assets enable row level security;
alter table crm_private.public_agent_usage_events enable row level security;

revoke all on crm_private.public_agent_knowledge_items from public, anon, authenticated;
revoke all on crm_private.public_agent_generated_assets from public, anon, authenticated;
revoke all on crm_private.public_agent_usage_events from public, anon, authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values
  ('vitoria-knowledge','vitoria-knowledge',false,52428800,array['application/pdf','text/plain','text/markdown','application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/msword','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','text/csv','image/png','image/jpeg','image/webp']),
  ('vitoria-avatar','vitoria-avatar',true,15728640,array['image/png','image/jpeg','image/webp','image/svg+xml','video/mp4','video/webm']),
  ('vitoria-generated','vitoria-generated',true,20971520,array['image/png','image/jpeg','image/webp','audio/mpeg','audio/wav','audio/ogg'])
on conflict(id) do update set
  public=excluded.public,
  file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

create or replace function crm_private.public_agent_is_admin(p_organization_id uuid, p_user_id uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path=''
as $function$
  select exists(
    select 1
    from public.organization_members member
    where member.organization_id=p_organization_id
      and member.user_id=p_user_id
      and member.active
      and member.role in ('admin','owner','diretor','gestor')
  );
$function$;

revoke all on function crm_private.public_agent_is_admin(uuid,uuid) from public,anon,authenticated;

grant execute on function crm_private.public_agent_is_admin(uuid,uuid) to authenticated,service_role;

create or replace function public.get_public_agent_admin_config(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  experience_row crm_private.public_agent_experiences%rowtype;
  knowledge_rows jsonb;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  select * into experience_row from crm_private.public_agent_experiences where slug=lower(trim(p_slug));
  if not found then raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND'; end if;
  if not crm_private.public_agent_is_admin(experience_row.organization_id,auth.uid()) then
    raise exception 'PUBLIC_AGENT_ADMIN_FORBIDDEN' using errcode='42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',item.id,'title',item.title,'description',item.description,'knowledgeType',item.knowledge_type,
    'bodyText',item.body_text,'sourceUrl',item.source_url,'storageBucket',item.storage_bucket,
    'storagePath',item.storage_path,'mimeType',item.mime_type,'fileSize',item.file_size,
    'indexingStatus',item.indexing_status,'publicToLead',item.public_to_lead,
    'agentSearchable',item.agent_searchable,'active',item.active,'updatedAt',item.updated_at,
    'metadata',item.metadata
  ) order by item.sort_order,item.updated_at desc),'[]'::jsonb)
  into knowledge_rows
  from crm_private.public_agent_knowledge_items item
  where item.experience_id=experience_row.id;

  return jsonb_build_object(
    'organizationId',experience_row.organization_id,
    'projectId',experience_row.project_id,
    'experienceId',experience_row.id,
    'slug',experience_row.slug,
    'name',experience_row.name,
    'agentName',experience_row.agent_name,
    'title',experience_row.title,
    'subtitle',experience_row.subtitle,
    'eyebrow',experience_row.eyebrow,
    'greetingText',experience_row.greeting_text,
    'avatar',experience_row.avatar,
    'capabilities',experience_row.capabilities,
    'theme',experience_row.theme,
    'openaiVectorStoreId',experience_row.openai_vector_store_id,
    'knowledge',knowledge_rows
  );
end
$function$;

create or replace function public.save_public_agent_profile_config(
  p_slug text,
  p_agent_name text,
  p_title text,
  p_subtitle text,
  p_eyebrow text,
  p_greeting_text text,
  p_avatar jsonb,
  p_capabilities jsonb,
  p_theme jsonb
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare experience_row crm_private.public_agent_experiences%rowtype;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  select * into experience_row from crm_private.public_agent_experiences where slug=lower(trim(p_slug)) for update;
  if not found then raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND'; end if;
  if not crm_private.public_agent_is_admin(experience_row.organization_id,auth.uid()) then raise exception 'PUBLIC_AGENT_ADMIN_FORBIDDEN' using errcode='42501'; end if;
  if char_length(trim(p_agent_name)) not between 2 and 80 or char_length(trim(p_title)) not between 4 and 300 or char_length(trim(p_subtitle)) not between 4 and 600 or char_length(trim(p_greeting_text)) not between 10 and 1200 then raise exception 'PUBLIC_AGENT_PROFILE_INVALID'; end if;
  if jsonb_typeof(p_avatar)<>'object' or jsonb_typeof(p_capabilities)<>'object' or jsonb_typeof(p_theme)<>'object' then raise exception 'PUBLIC_AGENT_PROFILE_INVALID'; end if;
  update crm_private.public_agent_experiences
  set agent_name=left(trim(p_agent_name),80),title=left(trim(p_title),300),subtitle=left(trim(p_subtitle),600),
      eyebrow=left(coalesce(nullif(trim(p_eyebrow),''),'Atendimento inteligente'),180),
      greeting_text=left(trim(p_greeting_text),1200),avatar=p_avatar,capabilities=p_capabilities,theme=p_theme,updated_at=now()
  where id=experience_row.id;
  return jsonb_build_object('ok',true,'experienceId',experience_row.id);
end
$function$;

create or replace function public.upsert_public_agent_knowledge(
  p_slug text,
  p_id uuid,
  p_title text,
  p_description text,
  p_knowledge_type text,
  p_body_text text,
  p_source_url text,
  p_public_to_lead boolean,
  p_agent_searchable boolean,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path=''
as $function$
declare experience_row crm_private.public_agent_experiences%rowtype; result_id uuid;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  select * into experience_row from crm_private.public_agent_experiences where slug=lower(trim(p_slug));
  if not found then raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND'; end if;
  if not crm_private.public_agent_is_admin(experience_row.organization_id,auth.uid()) then raise exception 'PUBLIC_AGENT_ADMIN_FORBIDDEN' using errcode='42501'; end if;
  if p_knowledge_type not in ('text','url') or char_length(trim(p_title)) not between 2 and 240 then raise exception 'PUBLIC_AGENT_KNOWLEDGE_INVALID'; end if;
  if p_knowledge_type='text' and char_length(coalesce(p_body_text,''))<5 then raise exception 'PUBLIC_AGENT_KNOWLEDGE_INVALID'; end if;
  if p_knowledge_type='url' and coalesce(p_source_url,'') !~ '^https://[^[:space:]]+$' then raise exception 'PUBLIC_AGENT_KNOWLEDGE_INVALID'; end if;

  if p_id is null then
    insert into crm_private.public_agent_knowledge_items(experience_id,organization_id,project_id,title,description,knowledge_type,body_text,source_url,indexing_status,public_to_lead,agent_searchable,metadata,created_by,updated_by)
    values(experience_row.id,experience_row.organization_id,experience_row.project_id,left(trim(p_title),240),left(nullif(trim(p_description),''),1000),p_knowledge_type,left(nullif(p_body_text,''),200000),left(nullif(trim(p_source_url),''),2000),case when p_agent_searchable then 'pending' else 'not_required' end,p_public_to_lead,p_agent_searchable,coalesce(p_metadata,'{}'::jsonb),auth.uid(),auth.uid()) returning id into result_id;
  else
    update crm_private.public_agent_knowledge_items
    set title=left(trim(p_title),240),description=left(nullif(trim(p_description),''),1000),knowledge_type=p_knowledge_type,
        body_text=left(nullif(p_body_text,''),200000),source_url=left(nullif(trim(p_source_url),''),2000),
        indexing_status=case when p_agent_searchable then 'pending' else 'not_required' end,
        public_to_lead=p_public_to_lead,agent_searchable=p_agent_searchable,metadata=coalesce(p_metadata,'{}'::jsonb),updated_by=auth.uid(),updated_at=now()
    where id=p_id and experience_id=experience_row.id returning id into result_id;
    if result_id is null then raise exception 'PUBLIC_AGENT_KNOWLEDGE_NOT_FOUND'; end if;
  end if;
  return result_id;
end
$function$;

create or replace function public.archive_public_agent_knowledge(p_slug text,p_id uuid)
returns boolean
language plpgsql
security definer
set search_path=''
as $function$
declare experience_row crm_private.public_agent_experiences%rowtype;
begin
  if auth.uid() is null then raise exception 'AUTH_REQUIRED' using errcode='42501'; end if;
  select * into experience_row from crm_private.public_agent_experiences where slug=lower(trim(p_slug));
  if not found then raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND'; end if;
  if not crm_private.public_agent_is_admin(experience_row.organization_id,auth.uid()) then raise exception 'PUBLIC_AGENT_ADMIN_FORBIDDEN' using errcode='42501'; end if;
  update crm_private.public_agent_knowledge_items set active=false,indexing_status='archived',updated_by=auth.uid(),updated_at=now() where id=p_id and experience_id=experience_row.id;
  return found;
end
$function$;

revoke all on function public.get_public_agent_admin_config(text) from public,anon;
revoke all on function public.save_public_agent_profile_config(text,text,text,text,text,text,jsonb,jsonb,jsonb) from public,anon;
revoke all on function public.upsert_public_agent_knowledge(text,uuid,text,text,text,text,text,boolean,boolean,jsonb) from public,anon;
revoke all on function public.archive_public_agent_knowledge(text,uuid) from public,anon;
grant execute on function public.get_public_agent_admin_config(text) to authenticated,service_role;
grant execute on function public.save_public_agent_profile_config(text,text,text,text,text,text,jsonb,jsonb,jsonb) to authenticated,service_role;
grant execute on function public.upsert_public_agent_knowledge(text,uuid,text,text,text,text,text,boolean,boolean,jsonb) to authenticated,service_role;
grant execute on function public.archive_public_agent_knowledge(text,uuid) to authenticated,service_role;

commit;
