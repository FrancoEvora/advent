update storage.buckets
set file_size_limit = 31457280,
    updated_at = now()
where id in ('arisa-chat','arisa-operations');

update public.system_settings
set document_max_size_mb = 30,
    updated_at = now()
where document_max_size_mb is distinct from 30;

create or replace function public.arisa_intake_document(
  p_organization_id uuid,
  p_storage_path text,
  p_file_name text,
  p_mime_type text,
  p_size_bytes bigint,
  p_file_hash text,
  p_input_kind text,
  p_context jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_item public.arisa_operation_items;
  v_actor uuid:=(select auth.uid());
  v_metadata jsonb;
  v_context jsonb;
  v_limit bigint;
begin
  perform private.arisa_assert_actor(p_organization_id,v_actor,'financial.manage');
  perform private.arisa_assert_actor(p_organization_id,v_actor,'documents.manage');

  if p_input_kind not in ('payable','bank_statement')
     or p_input_kind is null
     or coalesce(p_file_hash,'')!~'^[a-f0-9]{64}$'
     or nullif(btrim(p_file_name),'') is null
     or length(p_file_name)>255 then
    raise exception 'Arquivo ou finalidade inválidos.';
  end if;

  select * into v_item
  from public.arisa_operation_items
  where organization_id=p_organization_id
    and file_hash=p_file_hash
    and input_kind=p_input_kind;
  if found then return to_jsonb(v_item); end if;

  if split_part(p_storage_path,'/',1)<>p_organization_id::text
     or split_part(p_storage_path,'/',2)<>v_actor::text
     or p_storage_path like '%..%' then
    raise exception 'Caminho de arquivo inválido.';
  end if;

  select metadata into v_metadata
  from storage.objects
  where bucket_id='arisa-operations'
    and name=p_storage_path
    and coalesce(owner_id,owner::text)=v_actor::text;
  if not found then
    raise exception 'O arquivo enviado não foi localizado para este usuário.';
  end if;

  select least(coalesce(document_max_size_mb,30),30)::bigint*1048576
  into v_limit
  from public.system_settings
  where organization_id=p_organization_id;

  if p_size_bytes is null
     or p_size_bytes<1
     or p_size_bytes>coalesce(v_limit,31457280)
     or coalesce((v_metadata->>'size')::bigint,0)<>p_size_bytes then
    raise exception 'Tamanho de arquivo inválido.';
  end if;

  if p_mime_type is null
     or p_mime_type<>coalesce(v_metadata->>'mimetype','') then
    raise exception 'Tipo do arquivo não corresponde ao upload.';
  end if;

  v_context:=private.arisa_context(p_organization_id,coalesce(p_context,'{}'));

  insert into public.arisa_operation_items(
    organization_id,input_kind,storage_path,file_name,mime_type,size_bytes,
    file_hash,payload,created_by
  )
  values(
    p_organization_id,p_input_kind,p_storage_path,p_file_name,p_mime_type,
    p_size_bytes,p_file_hash,v_context,v_actor
  )
  on conflict(organization_id,file_hash,input_kind) do nothing
  returning * into v_item;

  if not found then
    select * into v_item
    from public.arisa_operation_items
    where organization_id=p_organization_id
      and file_hash=p_file_hash
      and input_kind=p_input_kind;
  else
    perform private.arisa_event(
      v_item,'received',v_actor,jsonb_build_object('input_kind',p_input_kind)
    );
  end if;

  return to_jsonb(v_item);
end
$function$;
