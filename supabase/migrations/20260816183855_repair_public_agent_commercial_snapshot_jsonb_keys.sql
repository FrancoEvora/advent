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

  select * into experience_row
  from crm_private.public_agent_experiences
  where slug=lower(trim(p_slug)) and active;

  if not found then
    raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND';
  end if;

  select jsonb_strip_nulls(
    to_jsonb(project) - array['organization_id','created_by','updated_by']::text[]
  )
  into project_data
  from public.projects project
  where project.id=experience_row.project_id
    and project.organization_id=experience_row.organization_id;

  select jsonb_strip_nulls(
    to_jsonb(product) - array['organization_id','created_by','updated_by']::text[]
  )
  into product_data
  from public.crm_products product
  where product.id=experience_row.product_id
    and product.organization_id=experience_row.organization_id;

  select coalesce(jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
    'id',item.id,
    'title',item.title,
    'description',item.description,
    'knowledgeType',item.knowledge_type,
    'bodyText',case when item.knowledge_type='text' then left(item.body_text,12000) else null end,
    'sourceUrl',item.source_url,
    'storageBucket',item.storage_bucket,
    'storagePath',item.storage_path,
    'mimeType',item.mime_type,
    'publicToLead',item.public_to_lead,
    'indexingStatus',item.indexing_status,
    'metadata',item.metadata
  )) order by item.sort_order,item.updated_at desc),'[]'::jsonb)
  into knowledge_data
  from crm_private.public_agent_knowledge_items item
  where item.experience_id=experience_row.id
    and item.active
    and item.agent_searchable;

  inventory_data := crm_private.public_agent_dynamic_rows(
    experience_row.organization_id,
    experience_row.project_id,
    '(unit|lot|inventory|stock|map)',
    40
  );

  enterprise_resources := crm_private.public_agent_dynamic_rows(
    experience_row.organization_id,
    experience_row.project_id,
    '(document|material|file|media|attachment)',
    30
  );

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

revoke all on function public.get_public_agent_commercial_snapshot(text) from public,anon,authenticated;
grant execute on function public.get_public_agent_commercial_snapshot(text) to service_role;
