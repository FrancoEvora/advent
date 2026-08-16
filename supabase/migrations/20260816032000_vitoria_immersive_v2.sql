begin;

alter table crm_private.vitoria_knowledge_sources
  add column if not exists shareable boolean not null default false,
  add column if not exists category text,
  add column if not exists public_label text,
  add column if not exists description text;

alter table crm_private.vitoria_knowledge_sources
  drop constraint if exists vitoria_knowledge_category_check;
alter table crm_private.vitoria_knowledge_sources
  add constraint vitoria_knowledge_category_check
  check (category is null or category in ('institucional','empreendimento','comercial','urbanistico','ambiental','juridico','obra','marketing','outro'));

create table if not exists crm_private.public_agent_generated_assets (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  experience_id uuid not null references crm_private.public_agent_experiences(id) on delete cascade,
  session_id uuid not null references crm_private.public_agent_sessions(id) on delete cascade,
  asset_type text not null,
  status text not null default 'completed',
  prompt_summary text,
  storage_bucket text not null default 'vitoria-public-assets',
  storage_path text not null,
  mime_type text not null default 'image/webp',
  size_bytes bigint,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz,
  constraint public_agent_generated_assets_type_check check (asset_type in ('house_simulation','document_preview','other')),
  constraint public_agent_generated_assets_status_check check (status in ('processing','completed','failed')),
  constraint public_agent_generated_assets_size_check check (size_bytes is null or (size_bytes > 0 and size_bytes <= 20971520)),
  constraint public_agent_generated_assets_metadata_check check (jsonb_typeof(metadata)='object' and pg_column_size(metadata) <= 32768)
);

create index if not exists public_agent_generated_assets_session_idx
  on crm_private.public_agent_generated_assets(session_id,created_at desc);
create index if not exists public_agent_generated_assets_expires_idx
  on crm_private.public_agent_generated_assets(expires_at)
  where expires_at is not null;

alter table crm_private.public_agent_generated_assets enable row level security;
revoke all on crm_private.public_agent_generated_assets from public,anon,authenticated;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values(
  'vitoria-public-assets',
  'vitoria-public-assets',
  false,
  20971520,
  array['image/png','image/jpeg','image/webp']::text[]
)
on conflict(id) do update
set public=false,
    file_size_limit=excluded.file_size_limit,
    allowed_mime_types=excluded.allowed_mime_types;

create or replace function public.get_public_agent_enterprise_catalog(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  experience_row crm_private.public_agent_experiences%rowtype;
  projects_json jsonb;
  organization_json jsonb;
begin
  perform crm_private.assert_public_agent_service_role();

  select e.* into experience_row
  from crm_private.public_agent_experiences e
  where e.slug=lower(trim(p_slug)) and e.active
  order by e.created_at desc
  limit 1;
  if not found then raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND'; end if;

  select jsonb_build_object(
    'name',o.name,
    'tradeName',o.trade_name,
    'city',o.city,
    'state',o.state,
    'website',o.website
  ) into organization_json
  from public.organizations o
  where o.id=experience_row.organization_id;

  select coalesce(jsonb_agg(project_row order by project_row.name),'[]'::jsonb)
  into projects_json
  from (
    select
      p.id,
      p.code,
      p.name,
      p.city,
      p.state,
      p.status,
      coalesce((
        select jsonb_agg(jsonb_build_object(
          'id',product.id,
          'code',product.code,
          'name',product.name,
          'type',product.product_type,
          'description',product.description
        ) order by product.name)
        from public.crm_products product
        where product.organization_id=p.organization_id
          and product.project_id=p.id
          and product.active
      ),'[]'::jsonb) as products,
      coalesce((
        select jsonb_build_object(
          'availableCount',count(*) filter(where unit.status='disponivel'),
          'minimumArea',round(min(unit.area) filter(where unit.status='disponivel'),2),
          'maximumArea',round(max(unit.area) filter(where unit.status='disponivel'),2),
          'minimumPrice',round(min(unit.list_price) filter(where unit.status='disponivel'),2),
          'maximumPrice',round(max(unit.list_price) filter(where unit.status='disponivel'),2),
          'asOf',max(unit.updated_at)
        )
        from public.crm_inventory_units unit
        where unit.organization_id=p.organization_id
          and unit.project_id=p.id
          and unit.active
      ),'{}'::jsonb) as inventory
    from public.projects p
    where p.organization_id=experience_row.organization_id
      and p.active
  ) project_row;

  return jsonb_build_object(
    'organization',coalesce(organization_json,'{}'::jsonb),
    'projects',projects_json,
    'currentProjectId',experience_row.project_id,
    'currentProductId',experience_row.product_id,
    'asOf',clock_timestamp()
  );
end
$function$;

create or replace function public.list_public_agent_documents(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  experience_row crm_private.public_agent_experiences%rowtype;
begin
  perform crm_private.assert_public_agent_service_role();

  select e.* into experience_row
  from crm_private.public_agent_experiences e
  where e.slug=lower(trim(p_slug)) and e.active
  order by e.created_at desc
  limit 1;
  if not found then raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND'; end if;

  return (
    select coalesce(jsonb_agg(jsonb_build_object(
      'id',source.id,
      'title',coalesce(nullif(source.public_label,''),source.title),
      'description',coalesce(source.description,source.content_preview),
      'category',coalesce(source.category,'outro'),
      'sourceType',source.source_type,
      'mimeType',source.mime_type,
      'bytes',source.bytes,
      'storagePath',source.storage_path,
      'projectId',source.project_id,
      'updatedAt',source.updated_at
    ) order by source.category,source.title),'[]'::jsonb)
    from crm_private.vitoria_knowledge_sources source
    where source.organization_id=experience_row.organization_id
      and source.active
      and source.shareable
      and source.vector_file_status='completed'
      and (source.scope='organization' or source.project_id=experience_row.project_id)
  );
end
$function$;

create or replace function public.count_public_agent_generated_assets(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text
)
returns integer
language plpgsql
security definer
set search_path=''
as $function$
declare
  session_key uuid;
begin
  perform crm_private.assert_public_agent_service_role();
  select session.id into session_key
  from crm_private.public_agent_sessions session
  join crm_private.public_agent_experiences experience on experience.id=session.experience_id
  where experience.slug=lower(trim(p_slug))
    and experience.active
    and session.session_token_hash=p_session_token_hash
    and session.fingerprint_hash=p_fingerprint_hash;
  if session_key is null then raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND'; end if;
  return (
    select count(*)::integer
    from crm_private.public_agent_generated_assets asset
    where asset.session_id=session_key
      and asset.asset_type='house_simulation'
      and asset.created_at>=now()-interval '24 hours'
      and asset.status='completed'
  );
end
$function$;

create or replace function public.record_public_agent_generated_asset(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_asset_type text,
  p_prompt_summary text,
  p_storage_bucket text,
  p_storage_path text,
  p_mime_type text,
  p_size_bytes bigint,
  p_metadata jsonb default '{}'::jsonb
)
returns uuid
language plpgsql
security definer
set search_path=''
as $function$
declare
  experience_row crm_private.public_agent_experiences%rowtype;
  session_row crm_private.public_agent_sessions%rowtype;
  asset_key uuid;
begin
  perform crm_private.assert_public_agent_service_role();
  if p_asset_type not in ('house_simulation','document_preview','other')
     or p_storage_bucket<>'vitoria-public-assets'
     or p_storage_path is null
     or char_length(p_storage_path)>1000
     or p_mime_type not in ('image/png','image/jpeg','image/webp')
     or p_size_bytes is null
     or p_size_bytes<1
     or p_size_bytes>20971520
     or p_metadata is null
     or jsonb_typeof(p_metadata)<>'object'
     or pg_column_size(p_metadata)>32768 then
    raise exception 'PUBLIC_AGENT_ASSET_INVALID';
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

  select * into experience_row
  from crm_private.public_agent_experiences
  where id=session_row.experience_id;

  insert into crm_private.public_agent_generated_assets(
    organization_id,experience_id,session_id,asset_type,status,prompt_summary,
    storage_bucket,storage_path,mime_type,size_bytes,metadata,expires_at
  ) values(
    session_row.organization_id,experience_row.id,session_row.id,p_asset_type,'completed',
    left(nullif(trim(p_prompt_summary),''),1200),p_storage_bucket,p_storage_path,p_mime_type,p_size_bytes,
    p_metadata,now()+interval '30 days'
  ) returning id into asset_key;

  return asset_key;
end
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
  p_created_by uuid,
  p_shareable boolean default false,
  p_category text default 'outro',
  p_public_label text default null,
  p_description text default null
)
returns uuid
language plpgsql
security definer
set search_path=''
as $function$
declare
  source_id uuid:=coalesce(p_id,gen_random_uuid());
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then
    raise exception 'VITORIA_KNOWLEDGE_FORBIDDEN';
  end if;
  if p_scope not in ('organization','project')
     or p_source_type not in ('text','file')
     or p_vector_file_status not in ('pending','processing','completed','failed')
     or coalesce(p_category,'outro') not in ('institucional','empreendimento','comercial','urbanistico','ambiental','juridico','obra','marketing','outro')
     or char_length(trim(p_title)) not between 2 and 180 then
    raise exception 'VITORIA_KNOWLEDGE_INVALID';
  end if;
  if p_scope='project' and not exists(
    select 1 from public.projects project
    where project.id=p_project_id and project.organization_id=p_organization_id
  ) then raise exception 'VITORIA_KNOWLEDGE_PROJECT_INVALID'; end if;

  insert into crm_private.vitoria_knowledge_sources(
    id,organization_id,project_id,scope,source_type,title,content_preview,storage_path,
    original_filename,mime_type,bytes,openai_file_id,vector_store_id,vector_file_status,
    active,created_by,shareable,category,public_label,description
  ) values(
    source_id,p_organization_id,case when p_scope='project' then p_project_id else null end,
    p_scope,p_source_type,left(trim(p_title),180),left(p_content_preview,1200),p_storage_path,
    p_original_filename,p_mime_type,p_bytes,p_openai_file_id,p_vector_store_id,p_vector_file_status,
    true,p_created_by,coalesce(p_shareable,false),coalesce(p_category,'outro'),
    left(nullif(trim(p_public_label),''),180),left(nullif(trim(p_description),''),1200)
  )
  on conflict(id) do update
  set project_id=excluded.project_id,
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
      active=true,
      shareable=excluded.shareable,
      category=excluded.category,
      public_label=excluded.public_label,
      description=excluded.description,
      updated_at=now();
  return source_id;
end
$function$;

create or replace function public.get_vitoria_admin_snapshot(p_organization_id uuid)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then
    raise exception 'VITORIA_ADMIN_FORBIDDEN';
  end if;
  return jsonb_build_object(
    'experiences',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',e.id,'slug',e.slug,'name',e.name,'agentName',e.agent_name,'title',e.title,
        'subtitle',e.subtitle,'eyebrow',e.eyebrow,'heroImageUrl',e.hero_image_url,
        'knowledge',e.knowledge,'theme',e.theme,'active',e.active,'projectId',e.project_id
      ) order by e.name)
      from crm_private.public_agent_experiences e
      where e.organization_id=p_organization_id
    ),'[]'::jsonb),
    'sources',coalesce((
      select jsonb_agg(jsonb_build_object(
        'id',s.id,'projectId',s.project_id,'scope',s.scope,'sourceType',s.source_type,
        'title',s.title,'contentPreview',s.content_preview,'originalFilename',s.original_filename,
        'mimeType',s.mime_type,'bytes',s.bytes,'vectorFileStatus',s.vector_file_status,
        'active',s.active,'shareable',s.shareable,'category',s.category,
        'publicLabel',s.public_label,'description',s.description,'updatedAt',s.updated_at
      ) order by s.updated_at desc)
      from crm_private.vitoria_knowledge_sources s
      where s.organization_id=p_organization_id
    ),'[]'::jsonb),
    'projects',coalesce((
      select jsonb_agg(jsonb_build_object('id',p.id,'name',p.name,'code',p.code,'active',p.active) order by p.name)
      from public.projects p
      where p.organization_id=p_organization_id and p.active
    ),'[]'::jsonb),
    'vectorStoreId',(select r.knowledge_vector_store_id from crm_private.ai_runtime_settings r where r.organization_id=p_organization_id)
  );
end
$function$;

create or replace function public.update_vitoria_experience_config(
  p_organization_id uuid,
  p_experience_id uuid,
  p_agent_name text,
  p_title text,
  p_subtitle text,
  p_eyebrow text,
  p_hero_image_url text,
  p_theme jsonb,
  p_knowledge jsonb
)
returns void
language plpgsql
security definer
set search_path=''
as $function$
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then
    raise exception 'VITORIA_ADMIN_FORBIDDEN';
  end if;
  if char_length(trim(p_agent_name)) not between 2 and 80
     or char_length(trim(p_title)) not between 3 and 240
     or char_length(trim(p_subtitle)) not between 3 and 600
     or char_length(trim(p_eyebrow)) not between 2 and 180
     or p_theme is null or jsonb_typeof(p_theme)<>'object' or pg_column_size(p_theme)>65536
     or p_knowledge is null or jsonb_typeof(p_knowledge)<>'object' or pg_column_size(p_knowledge)>131072 then
    raise exception 'VITORIA_CONFIG_INVALID';
  end if;
  update crm_private.public_agent_experiences
  set agent_name=left(trim(p_agent_name),80),
      title=left(trim(p_title),240),
      subtitle=left(trim(p_subtitle),600),
      eyebrow=left(trim(p_eyebrow),180),
      hero_image_url=left(nullif(trim(p_hero_image_url),''),1000),
      theme=p_theme,
      knowledge=p_knowledge,
      updated_at=now()
  where id=p_experience_id and organization_id=p_organization_id;
  if not found then raise exception 'VITORIA_EXPERIENCE_NOT_FOUND'; end if;
end
$function$;

revoke all on function public.get_public_agent_enterprise_catalog(text) from public,anon,authenticated;
revoke all on function public.list_public_agent_documents(text) from public,anon,authenticated;
revoke all on function public.count_public_agent_generated_assets(text,text,text) from public,anon,authenticated;
revoke all on function public.record_public_agent_generated_asset(text,text,text,text,text,text,text,text,bigint,jsonb) from public,anon,authenticated;
revoke all on function public.upsert_vitoria_knowledge_source_v2(uuid,uuid,uuid,text,text,text,text,text,text,text,bigint,text,text,text,uuid,boolean,text,text,text) from public,anon,authenticated;
revoke all on function public.get_vitoria_admin_snapshot(uuid) from public,anon,authenticated;
revoke all on function public.update_vitoria_experience_config(uuid,uuid,text,text,text,text,text,jsonb,jsonb) from public,anon,authenticated;

grant execute on function public.get_public_agent_enterprise_catalog(text) to service_role;
grant execute on function public.list_public_agent_documents(text) to service_role;
grant execute on function public.count_public_agent_generated_assets(text,text,text) to service_role;
grant execute on function public.record_public_agent_generated_asset(text,text,text,text,text,text,text,text,bigint,jsonb) to service_role;
grant execute on function public.upsert_vitoria_knowledge_source_v2(uuid,uuid,uuid,text,text,text,text,text,text,text,bigint,text,text,text,uuid,boolean,text,text,text) to service_role;
grant execute on function public.get_vitoria_admin_snapshot(uuid) to service_role;
grant execute on function public.update_vitoria_experience_config(uuid,uuid,text,text,text,text,text,jsonb,jsonb) to service_role;

update crm_private.public_agent_experiences
set hero_image_url='/vitoria/vitoria-portrait.webp',
    theme=theme || jsonb_build_object(
      'visualMode','immersive',
      'voice','coral',
      'voiceEnabled',true,
      'autoSpeak',false,
      'avatarMotion',true,
      'capabilities',jsonb_build_array('empreendimentos','estoque','condicoes','documentos','simulacao_visual','visitas')
    ),
    knowledge=knowledge || jsonb_build_object(
      'organizationExpert',true,
      'commercialDataSource','enterprise_realtime',
      'documentKnowledgeSource','openai_file_search'
    ),
    updated_at=now()
where slug='solaris';

commit;
