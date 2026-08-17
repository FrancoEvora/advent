begin;

create or replace function crm_private.public_agent_dynamic_rows(
  p_organization_id uuid,
  p_project_id uuid,
  p_name_pattern text,
  p_limit_per_table integer default 40
)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  table_row record;
  filter_sql text;
  query_sql text;
  table_data jsonb;
  result_data jsonb := '[]'::jsonb;
begin
  perform crm_private.assert_public_agent_service_role();
  p_limit_per_table := greatest(1,least(coalesce(p_limit_per_table,40),80));

  for table_row in
    select t.table_name,
      exists(select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=t.table_name and c.column_name='organization_id') as has_org,
      exists(select 1 from information_schema.columns c where c.table_schema='public' and c.table_name=t.table_name and c.column_name='project_id') as has_project
    from information_schema.tables t
    where t.table_schema='public'
      and t.table_type='BASE TABLE'
      and t.table_name ~* p_name_pattern
      and t.table_name not in ('crm_records','crm_messages','crm_conversations','crm_opportunity_events','crm_opportunity_attributions','crm_ai_jobs','crm_ai_runs','crm_audit_log')
      and exists(
        select 1 from information_schema.columns c
        where c.table_schema='public' and c.table_name=t.table_name
          and c.column_name in ('id','name','title','code','number','status','price','value','area','lot_area','total_area','available','availability','file_url','url','storage_path')
      )
    order by t.table_name
    limit 12
  loop
    filter_sql := 'true';
    if table_row.has_org then
      filter_sql := format('(to_jsonb(row_data)->>''organization_id'') = %L',p_organization_id::text);
    end if;
    if table_row.has_project and p_project_id is not null then
      filter_sql := filter_sql || format(' and (to_jsonb(row_data)->>''project_id'') = %L',p_project_id::text);
    end if;

    query_sql := format($sql$
      select coalesce(jsonb_agg(item),'[]'::jsonb)
      from (
        select jsonb_strip_nulls(jsonb_build_object(
          'sourceTable', %L,
          'id', to_jsonb(row_data)->'id',
          'name', coalesce(to_jsonb(row_data)->'name',to_jsonb(row_data)->'title'),
          'title', to_jsonb(row_data)->'title',
          'code', coalesce(to_jsonb(row_data)->'code',to_jsonb(row_data)->'number'),
          'status', to_jsonb(row_data)->'status',
          'available', coalesce(to_jsonb(row_data)->'available',to_jsonb(row_data)->'availability'),
          'area', coalesce(to_jsonb(row_data)->'area',to_jsonb(row_data)->'lot_area',to_jsonb(row_data)->'total_area'),
          'price', coalesce(to_jsonb(row_data)->'price',to_jsonb(row_data)->'value'),
          'description', to_jsonb(row_data)->'description',
          'category', coalesce(to_jsonb(row_data)->'category',to_jsonb(row_data)->'type'),
          'fileUrl', coalesce(to_jsonb(row_data)->'file_url',to_jsonb(row_data)->'url'),
          'storageBucket', to_jsonb(row_data)->'storage_bucket',
          'storagePath', to_jsonb(row_data)->'storage_path',
          'updatedAt', coalesce(to_jsonb(row_data)->'updated_at',to_jsonb(row_data)->'created_at')
        )) as item
        from public.%I row_data
        where %s
        limit %s
      ) limited
    $sql$,table_row.table_name,table_row.table_name,filter_sql,p_limit_per_table);

    begin
      execute query_sql into table_data;
      if jsonb_array_length(coalesce(table_data,'[]'::jsonb))>0 then
        result_data := result_data || jsonb_build_array(jsonb_build_object('table',table_row.table_name,'rows',table_data));
      end if;
    exception when others then
      null;
    end;
  end loop;

  return result_data;
end
$function$;

create or replace function public.get_public_agent_commercial_snapshot(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  experience_row crm_private.public_agent_experiences%rowtype;
  project_data jsonb;
  product_data jsonb;
  knowledge_data jsonb;
  inventory_data jsonb;
  enterprise_resources jsonb;
begin
  perform crm_private.assert_public_agent_service_role();
  select * into experience_row from crm_private.public_agent_experiences where slug=lower(trim(p_slug)) and active;
  if not found then raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND'; end if;

  select jsonb_strip_nulls(to_jsonb(project)-jsonb_build_array('organization_id','created_by','updated_by'))
  into project_data from public.projects project where project.id=experience_row.project_id and project.organization_id=experience_row.organization_id;

  select jsonb_strip_nulls(to_jsonb(product)-jsonb_build_array('organization_id','created_by','updated_by'))
  into product_data from public.crm_products product where product.id=experience_row.product_id and product.organization_id=experience_row.organization_id;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id',item.id,'title',item.title,'description',item.description,'knowledgeType',item.knowledge_type,
    'bodyText',case when item.knowledge_type='text' then left(item.body_text,12000) else null end,
    'sourceUrl',item.source_url,'storageBucket',item.storage_bucket,'storagePath',item.storage_path,
    'mimeType',item.mime_type,'publicToLead',item.public_to_lead,'indexingStatus',item.indexing_status,
    'metadata',item.metadata
  )) order by item.sort_order,item.updated_at desc),'[]'::jsonb)
  into knowledge_data
  from crm_private.public_agent_knowledge_items item
  where item.experience_id=experience_row.id and item.active and item.agent_searchable;

  inventory_data := crm_private.public_agent_dynamic_rows(experience_row.organization_id,experience_row.project_id,'(unit|lot|inventory|stock|map)',40);
  enterprise_resources := crm_private.public_agent_dynamic_rows(experience_row.organization_id,experience_row.project_id,'(document|material|file|media|attachment)',30);

  return jsonb_build_object(
    'organizationId',experience_row.organization_id,
    'experienceId',experience_row.id,
    'project',coalesce(project_data,'{}'::jsonb),
    'product',coalesce(product_data,'{}'::jsonb),
    'inventory',inventory_data,
    'enterpriseResources',enterprise_resources,
    'knowledge',knowledge_data,
    'openaiVectorStoreId',experience_row.openai_vector_store_id,
    'capabilities',experience_row.capabilities
  );
end
$function$;

create or replace function public.get_public_agent_experience(p_slug text)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare experience_row crm_private.public_agent_experiences%rowtype;
begin
  perform crm_private.assert_public_agent_service_role();
  select * into experience_row from crm_private.public_agent_experiences where slug=lower(trim(p_slug)) and active;
  if not found then raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND'; end if;
  return jsonb_build_object(
    'slug',experience_row.slug,'name',experience_row.name,'agentName',experience_row.agent_name,
    'title',experience_row.title,'subtitle',experience_row.subtitle,'eyebrow',experience_row.eyebrow,
    'heroImageUrl',experience_row.hero_image_url,'greetingText',experience_row.greeting_text,
    'avatar',experience_row.avatar,'capabilities',experience_row.capabilities,'theme',experience_row.theme
  );
end
$function$;

create or replace function public.get_public_agent_context(p_slug text,p_session_token_hash text,p_fingerprint_hash text)
returns jsonb
language plpgsql
security definer
set search_path=''
as $function$
declare
  experience_row crm_private.public_agent_experiences%rowtype;
  session_row crm_private.public_agent_sessions%rowtype;
  minute_count integer;
  hour_count integer;
  transcript jsonb;
  commercial jsonb;
  generated jsonb;
begin
  perform crm_private.assert_public_agent_service_role();
  select session.* into session_row
  from crm_private.public_agent_sessions session
  join crm_private.public_agent_experiences experience on experience.id=session.experience_id
  where experience.slug=lower(trim(p_slug)) and experience.active
    and session.session_token_hash=p_session_token_hash and session.fingerprint_hash=p_fingerprint_hash
  for update of session;
  if not found then raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND'; end if;
  select * into experience_row from crm_private.public_agent_experiences where id=session_row.experience_id and active;
  if not found then raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND'; end if;
  if session_row.status in ('closed','blocked') or session_row.expires_at<=now() then raise exception 'PUBLIC_AGENT_SESSION_INACTIVE'; end if;

  select count(*) filter(where message.created_at>=now()-interval '1 minute'),count(*) filter(where message.created_at>=now()-interval '1 hour')
  into minute_count,hour_count from crm_private.public_agent_messages message where message.session_id=session_row.id and message.direction='user';
  if minute_count>=6 or hour_count>=40 or session_row.message_count>=140 then raise exception 'PUBLIC_AGENT_MESSAGE_RATE_LIMIT'; end if;

  update crm_private.public_agent_sessions set last_activity_at=now(),updated_at=now() where id=session_row.id;

  select coalesce(jsonb_agg(row_data order by row_data.created_at,row_data.id),'[]'::jsonb) into transcript
  from (
    select message.id,message.direction,message.content,message.metadata,message.created_at
    from crm_private.public_agent_messages message where message.session_id=session_row.id
    order by message.created_at desc,message.id desc limit 30
  ) row_data;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id',asset.id,'type',asset.asset_type,'title',asset.title,'url',asset.public_url,
    'mimeType',asset.mime_type,'metadata',asset.metadata,'createdAt',asset.created_at
  ) order by asset.created_at desc),'[]'::jsonb)
  into generated from crm_private.public_agent_generated_assets asset where asset.session_id=session_row.id and asset.status='ready';

  commercial := public.get_public_agent_commercial_snapshot(experience_row.slug);

  return jsonb_build_object(
    'organizationId',experience_row.organization_id,'sessionId',session_row.id,'stage',session_row.stage,
    'profile',session_row.captured_profile,'converted',session_row.crm_record_id is not null,
    'crmRecordId',session_row.crm_record_id,'commercial',commercial,'generatedAssets',generated,
    'experience',jsonb_build_object(
      'slug',experience_row.slug,'name',experience_row.name,'agentName',experience_row.agent_name,
      'title',experience_row.title,'subtitle',experience_row.subtitle,'eyebrow',experience_row.eyebrow,
      'greetingText',experience_row.greeting_text,'avatar',experience_row.avatar,
      'capabilities',experience_row.capabilities,'theme',experience_row.theme
    ),
    'messages',transcript
  );
end
$function$;

revoke all on function crm_private.public_agent_dynamic_rows(uuid,uuid,text,integer) from public,anon,authenticated;
revoke all on function public.get_public_agent_commercial_snapshot(text) from public,anon,authenticated;
grant execute on function crm_private.public_agent_dynamic_rows(uuid,uuid,text,integer) to service_role;
grant execute on function public.get_public_agent_commercial_snapshot(text) to service_role;

commit;
