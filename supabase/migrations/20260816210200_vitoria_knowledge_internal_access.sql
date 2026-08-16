begin;

grant execute on function public.get_vitoria_knowledge_source(uuid,uuid) to service_role;

create or replace function public.update_vitoria_knowledge_source_metadata(
  p_organization_id uuid,
  p_source_id uuid,
  p_title text,
  p_public_document boolean,
  p_display_description text,
  p_tags text[],
  p_sort_order integer,
  p_active boolean
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  source_row crm_private.vitoria_knowledge_sources%rowtype;
begin
  perform crm_private.assert_public_agent_service_role();
  update crm_private.vitoria_knowledge_sources source
  set title=left(trim(p_title),180),
      public_document=coalesce(p_public_document,false),
      display_description=left(nullif(trim(p_display_description),''),500),
      tags=coalesce(p_tags,'{}'::text[]),
      sort_order=greatest(0,least(10000,coalesce(p_sort_order,100))),
      active=coalesce(p_active,true),
      updated_at=now()
  where source.organization_id=p_organization_id and source.id=p_source_id
  returning * into source_row;
  if not found then raise exception 'VITORIA_KNOWLEDGE_NOT_FOUND'; end if;
  return jsonb_build_object(
    'id',source_row.id,'title',source_row.title,'publicDocument',source_row.public_document,
    'displayDescription',source_row.display_description,'tags',source_row.tags,
    'sortOrder',source_row.sort_order,'active',source_row.active,'updatedAt',source_row.updated_at
  );
end
$function$;

revoke all on function public.update_vitoria_knowledge_source_metadata(uuid,uuid,text,boolean,text,text[],integer,boolean)
  from public,anon,authenticated;
grant execute on function public.update_vitoria_knowledge_source_metadata(uuid,uuid,text,boolean,text,text[],integer,boolean)
  to service_role;

commit;
