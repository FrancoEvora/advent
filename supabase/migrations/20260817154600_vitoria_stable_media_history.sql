begin;

do $migration_preflight$
begin
  if to_regprocedure(
    'public.finalize_public_agent_message_v4(text,text,text,uuid,uuid,bigint,text,text,jsonb,jsonb,jsonb,boolean,boolean,text)'
  ) is null
     or to_regprocedure(
       'public.commit_public_agent_action_message_v5(text,text,text,uuid,uuid,bigint,text,uuid,text,text,jsonb,boolean,boolean,text,text,jsonb,jsonb)'
     ) is null then
    raise exception 'VITORIA_STABLE_MEDIA_DEPENDENCY_MISSING';
  end if;
end
$migration_preflight$;

create or replace function crm_private.public_agent_server_media_refs(
  p_media_refs jsonb
)
returns jsonb
language plpgsql
immutable
set search_path = ''
as $function$
declare
  direction_value text;
  direction_input jsonb;
  media_item jsonb;
  result_value jsonb := jsonb_build_object(
    'inbound', '[]'::jsonb,
    'outbound', '[]'::jsonb
  );
  bucket_value text;
  storage_path_value text;
  kind_value text;
  mime_value text;
  title_value text;
  attachment_id_value text;
  duration_value numeric;
  sanitized_item jsonb;
begin
  if p_media_refs is null then
    return result_value;
  end if;

  if jsonb_typeof(p_media_refs) <> 'object'
     or pg_column_size(p_media_refs) > 6144
     or exists (
       select 1
       from jsonb_object_keys(p_media_refs) as media_key(value)
       where media_key.value not in ('inbound', 'outbound')
     ) then
    raise exception 'PUBLIC_AGENT_MEDIA_REFS_INVALID';
  end if;

  foreach direction_value in array array['inbound', 'outbound'] loop
    direction_input := coalesce(p_media_refs -> direction_value, '[]'::jsonb);
    if jsonb_typeof(direction_input) <> 'array'
       or jsonb_array_length(direction_input) > 8 then
      raise exception 'PUBLIC_AGENT_MEDIA_REFS_INVALID';
    end if;

    for media_item in
      select item.value
      from jsonb_array_elements(direction_input) as item(value)
    loop
      if jsonb_typeof(media_item) <> 'object'
         or exists (
           select 1
           from jsonb_object_keys(media_item) as item_key(value)
           where item_key.value not in (
             'kind', 'bucket', 'storagePath', 'mimeType',
             'attachmentId', 'title', 'durationSeconds'
           )
         ) then
        raise exception 'PUBLIC_AGENT_MEDIA_REFS_INVALID';
      end if;

      kind_value := lower(nullif(trim(media_item ->> 'kind'), ''));
      bucket_value := lower(nullif(trim(media_item ->> 'bucket'), ''));
      storage_path_value := nullif(trim(media_item ->> 'storagePath'), '');
      mime_value := lower(nullif(trim(media_item ->> 'mimeType'), ''));
      title_value := left(nullif(trim(media_item ->> 'title'), ''), 180);
      attachment_id_value := left(
        nullif(trim(media_item ->> 'attachmentId'), ''),
        180
      );
      duration_value := case
        when jsonb_typeof(media_item -> 'durationSeconds') = 'number'
          then (media_item ->> 'durationSeconds')::numeric
        else null
      end;

      if bucket_value not in (
           'erp-documents', 'vitoria-generated', 'vitoria-knowledge'
         )
         or storage_path_value is null
         or char_length(storage_path_value) > 512
         or storage_path_value !~ '^[A-Za-z0-9][A-Za-z0-9._/-]*$'
         or storage_path_value like '%//%'
         or storage_path_value ~ '(^|/)\.{1,2}(/|$)'
         or kind_value not in ('audio', 'document', 'image', 'video')
         or mime_value is null
         or char_length(mime_value) > 120 then
        raise exception 'PUBLIC_AGENT_MEDIA_REFS_INVALID';
      end if;

      if bucket_value = 'vitoria-generated' and kind_value <> 'image' then
        raise exception 'PUBLIC_AGENT_MEDIA_REFS_INVALID';
      end if;

      if bucket_value = 'vitoria-knowledge'
         and kind_value not in ('document', 'image') then
        raise exception 'PUBLIC_AGENT_MEDIA_REFS_INVALID';
      end if;

      if kind_value = 'audio' then
        if bucket_value <> 'erp-documents'
           or mime_value not in (
             'audio/webm', 'audio/mp4', 'audio/mpeg',
             'audio/wav', 'audio/x-wav'
           )
           or duration_value is null
           or duration_value <= 0
           or duration_value > 90 then
          raise exception 'PUBLIC_AGENT_MEDIA_REFS_INVALID';
        end if;
      elsif kind_value = 'document' then
        if mime_value <> 'application/pdf' then
          raise exception 'PUBLIC_AGENT_MEDIA_REFS_INVALID';
        end if;
      elsif kind_value = 'image' then
        if mime_value not in ('image/png', 'image/jpeg', 'image/webp') then
          raise exception 'PUBLIC_AGENT_MEDIA_REFS_INVALID';
        end if;
      elsif kind_value = 'video' then
        if bucket_value <> 'erp-documents'
           or mime_value not in ('video/mp4', 'video/webm', 'video/quicktime') then
          raise exception 'PUBLIC_AGENT_MEDIA_REFS_INVALID';
        end if;
      end if;

      sanitized_item := jsonb_strip_nulls(jsonb_build_object(
        'kind', kind_value,
        'bucket', bucket_value,
        'storagePath', storage_path_value,
        'mimeType', mime_value,
        'attachmentId', attachment_id_value,
        'title', title_value,
        'durationSeconds', case
          when kind_value = 'audio' then round(duration_value, 2)
          else null
        end
      ));
      result_value := jsonb_set(
        result_value,
        array[direction_value],
        (result_value -> direction_value) || jsonb_build_array(sanitized_item),
        true
      );
    end loop;
  end loop;

  if pg_column_size(result_value) > 6144 then
    raise exception 'PUBLIC_AGENT_MEDIA_REFS_INVALID';
  end if;
  return result_value;
end
$function$;

create or replace function crm_private.attach_public_agent_message_media_v5(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_client_request_id uuid,
  p_media_refs jsonb
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  session_row crm_private.public_agent_sessions%rowtype;
  experience_row crm_private.public_agent_experiences%rowtype;
  assistant_private_row crm_private.public_agent_messages%rowtype;
  user_private_row crm_private.public_agent_messages%rowtype;
  assistant_crm_row public.crm_messages%rowtype;
  user_crm_row public.crm_messages%rowtype;
  sanitized_refs jsonb;
  inbound_refs jsonb;
  outbound_refs jsonb;
  public_audio_value jsonb;
  inbound_patch jsonb;
begin
  perform crm_private.assert_public_agent_service_role();

  sanitized_refs := crm_private.public_agent_server_media_refs(p_media_refs);
  inbound_refs := sanitized_refs -> 'inbound';
  outbound_refs := sanitized_refs -> 'outbound';
  if jsonb_array_length(inbound_refs) = 0
     and jsonb_array_length(outbound_refs) = 0 then
    return;
  end if;

  select session.* into session_row
  from crm_private.public_agent_sessions session
  join crm_private.public_agent_experiences experience
    on experience.id = session.experience_id
  where experience.slug = lower(trim(p_slug))
    and experience.active
    and session.session_token_hash = p_session_token_hash
    and session.fingerprint_hash = p_fingerprint_hash
  for update of session;

  if not found then
    raise exception 'PUBLIC_AGENT_SESSION_NOT_FOUND';
  end if;

  select experience.* into experience_row
  from crm_private.public_agent_experiences experience
  where experience.id = session_row.experience_id
    and experience.active;

  if not found then
    raise exception 'PUBLIC_AGENT_EXPERIENCE_NOT_FOUND';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(inbound_refs || outbound_refs) as media(value)
    where case media.value ->> 'bucket'
      when 'vitoria-generated' then
        media.value ->> 'storagePath' not like
          session_row.organization_id::text || '/' || session_row.id::text || '/%'
      when 'erp-documents' then
        media.value ->> 'storagePath' not like
          'vitoria/audio/' || session_row.organization_id::text || '/' || session_row.id::text || '/%'
        and media.value ->> 'storagePath' not like
          'vitoria-simulations/' || session_row.organization_id::text || '/' || session_row.id::text || '/%'
        and (
          coalesce(media.value ->> 'attachmentId', '') !~
            '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          or not exists (
            select 1
            from public.crm_marketing_assets asset
            where asset.id = (media.value ->> 'attachmentId')::uuid
              and asset.organization_id = session_row.organization_id
              and asset.storage_path = media.value ->> 'storagePath'
              and asset.active
              and (
                asset.project_id is null
                or asset.project_id = experience_row.project_id
              )
              and (
                'vitoria-public' = any(asset.tags)
                or asset.audience in ('publico', 'lead')
              )
          )
        )
      when 'vitoria-knowledge' then
        coalesce(media.value ->> 'attachmentId', '') !~
          '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        or not exists (
          select 1
          from crm_private.vitoria_knowledge_sources source
          where source.id = (media.value ->> 'attachmentId')::uuid
            and source.organization_id = session_row.organization_id
            and source.storage_path = media.value ->> 'storagePath'
            and source.active
            and source.public_document
            and source.vector_file_status = 'completed'
            and (
              source.scope = 'organization'
              or source.project_id = experience_row.project_id
            )
        )
      else true
    end
  ) then
    raise exception 'PUBLIC_AGENT_MEDIA_SCOPE_INVALID';
  end if;

  select message.* into assistant_private_row
  from crm_private.public_agent_messages message
  where message.session_id = session_row.id
    and message.direction = 'assistant'
    and message.metadata ->> 'client_request_id' = p_client_request_id::text
  order by message.created_at desc, message.id desc
  limit 1;

  if not found then
    raise exception 'PUBLIC_AGENT_MEDIA_MESSAGE_NOT_FOUND';
  end if;

  select message.* into user_private_row
  from crm_private.public_agent_messages message
  where message.session_id = session_row.id
    and message.direction = 'user'
    and message.created_at = assistant_private_row.created_at - interval '1 millisecond'
  order by message.id desc
  limit 1;

  if not found then
    raise exception 'PUBLIC_AGENT_MEDIA_MESSAGE_NOT_FOUND';
  end if;

  public_audio_value := case
    when jsonb_typeof(user_private_row.metadata -> 'public_audio') = 'object'
      then user_private_row.metadata -> 'public_audio'
    else '{}'::jsonb
  end;
  inbound_patch := jsonb_build_object(
    'server_media_contract', 'v1',
    'server_media_refs', inbound_refs
  );
  if public_audio_value <> '{}'::jsonb then
    inbound_patch := inbound_patch || jsonb_build_object(
      'public_audio', public_audio_value
    );
  end if;

  if jsonb_array_length(inbound_refs) > 0
     and jsonb_typeof(user_private_row.metadata -> 'server_media_refs') = 'array'
     and user_private_row.metadata -> 'server_media_refs' <> inbound_refs then
    raise exception 'PUBLIC_AGENT_MEDIA_IDEMPOTENCY_CONFLICT';
  end if;
  if jsonb_array_length(outbound_refs) > 0
     and jsonb_typeof(assistant_private_row.metadata -> 'server_media_refs') = 'array'
     and assistant_private_row.metadata -> 'server_media_refs' <> outbound_refs then
    raise exception 'PUBLIC_AGENT_MEDIA_IDEMPOTENCY_CONFLICT';
  end if;

  if jsonb_array_length(inbound_refs) > 0 then
    update crm_private.public_agent_messages
    set metadata = metadata || inbound_patch
    where id = user_private_row.id;
  end if;

  if jsonb_array_length(outbound_refs) > 0 then
    update crm_private.public_agent_messages
    set metadata = metadata || jsonb_build_object(
      'server_media_contract', 'v1',
      'server_media_refs', outbound_refs
    )
    where id = assistant_private_row.id;
  end if;

  if session_row.crm_record_id is null then
    return;
  end if;

  select message.* into assistant_crm_row
  from public.crm_messages message
  where message.organization_id = session_row.organization_id
    and message.crm_record_id = session_row.crm_record_id
    and message.direction = 'outbound'
    and message.actor_type = 'ai'
    and message.metadata ->> 'public_agent_session_id' = session_row.id::text
    and message.metadata ->> 'client_request_id' = p_client_request_id::text
  order by message.occurred_at desc, message.id desc
  limit 1;

  if not found then
    raise exception 'PUBLIC_AGENT_MEDIA_CRM_MESSAGE_NOT_FOUND';
  end if;

  select message.* into user_crm_row
  from public.crm_messages message
  where message.organization_id = session_row.organization_id
    and message.conversation_id = assistant_crm_row.conversation_id
    and message.crm_record_id = session_row.crm_record_id
    and message.direction = 'inbound'
    and message.actor_type = 'lead'
    and message.metadata ->> 'public_agent_session_id' = session_row.id::text
    and message.occurred_at = assistant_crm_row.occurred_at - interval '1 millisecond'
  order by message.id desc
  limit 1;

  if not found then
    raise exception 'PUBLIC_AGENT_MEDIA_CRM_MESSAGE_NOT_FOUND';
  end if;

  if jsonb_array_length(inbound_refs) > 0
     and jsonb_typeof(user_crm_row.metadata -> 'server_media_refs') = 'array'
     and user_crm_row.metadata -> 'server_media_refs' <> inbound_refs then
    raise exception 'PUBLIC_AGENT_MEDIA_IDEMPOTENCY_CONFLICT';
  end if;
  if jsonb_array_length(outbound_refs) > 0
     and jsonb_typeof(assistant_crm_row.metadata -> 'server_media_refs') = 'array'
     and assistant_crm_row.metadata -> 'server_media_refs' <> outbound_refs then
    raise exception 'PUBLIC_AGENT_MEDIA_IDEMPOTENCY_CONFLICT';
  end if;

  if jsonb_array_length(inbound_refs) > 0 then
    update public.crm_messages
    set metadata = metadata || inbound_patch
    where organization_id = session_row.organization_id
      and id = user_crm_row.id;
  end if;

  if jsonb_array_length(outbound_refs) > 0 then
    update public.crm_messages
    set metadata = metadata || jsonb_build_object(
      'server_media_contract', 'v1',
      'server_media_refs', outbound_refs
    )
    where organization_id = session_row.organization_id
      and id = assistant_crm_row.id;
  end if;
end
$function$;

create or replace function public.finalize_public_agent_message_v5(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_client_request_id uuid,
  p_lease_token uuid,
  p_expected_revision bigint,
  p_source text,
  p_user_message text,
  p_response jsonb,
  p_pending_action jsonb,
  p_contact_patch jsonb,
  p_service_consent boolean,
  p_marketing_consent boolean,
  p_consent_copy_version text,
  p_media_refs jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  result_value jsonb;
  sanitized_refs jsonb;
begin
  perform crm_private.assert_public_agent_service_role();
  sanitized_refs := crm_private.public_agent_server_media_refs(p_media_refs);
  if coalesce(p_response, '{}'::jsonb)::text ~* '"(storagePath|storage_path|storageBucket|storage_bucket|serverMediaRefs|server_media_refs)"[[:space:]]*:' then
    raise exception 'PUBLIC_AGENT_MEDIA_RESPONSE_INVALID';
  end if;

  result_value := public.finalize_public_agent_message_v4(
    p_slug,
    p_session_token_hash,
    p_fingerprint_hash,
    p_client_request_id,
    p_lease_token,
    p_expected_revision,
    p_source,
    p_user_message,
    p_response,
    p_pending_action,
    p_contact_patch,
    p_service_consent,
    p_marketing_consent,
    p_consent_copy_version
  );

  if result_value ->> 'status' = 'completed' then
    perform crm_private.attach_public_agent_message_media_v5(
      p_slug,
      p_session_token_hash,
      p_fingerprint_hash,
      p_client_request_id,
      sanitized_refs
    );
  end if;
  return result_value;
end
$function$;

create or replace function public.commit_public_agent_action_message_v6(
  p_slug text,
  p_session_token_hash text,
  p_fingerprint_hash text,
  p_client_request_id uuid,
  p_lease_token uuid,
  p_expected_revision bigint,
  p_source text,
  p_client_action_id uuid,
  p_action_kind text,
  p_unit_code text,
  p_contact_patch jsonb,
  p_service_consent boolean,
  p_marketing_consent boolean,
  p_consent_copy_version text,
  p_user_message text,
  p_profile jsonb,
  p_response jsonb,
  p_media_refs jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  result_value jsonb;
  sanitized_refs jsonb;
begin
  perform crm_private.assert_public_agent_service_role();
  sanitized_refs := crm_private.public_agent_server_media_refs(p_media_refs);
  if coalesce(p_response, '{}'::jsonb)::text ~* '"(storagePath|storage_path|storageBucket|storage_bucket|serverMediaRefs|server_media_refs)"[[:space:]]*:' then
    raise exception 'PUBLIC_AGENT_MEDIA_RESPONSE_INVALID';
  end if;

  result_value := public.commit_public_agent_action_message_v5(
    p_slug,
    p_session_token_hash,
    p_fingerprint_hash,
    p_client_request_id,
    p_lease_token,
    p_expected_revision,
    p_source,
    p_client_action_id,
    p_action_kind,
    p_unit_code,
    p_contact_patch,
    p_service_consent,
    p_marketing_consent,
    p_consent_copy_version,
    p_user_message,
    p_profile,
    p_response
  );

  if result_value ->> 'status' = 'completed' then
    perform crm_private.attach_public_agent_message_media_v5(
      p_slug,
      p_session_token_hash,
      p_fingerprint_hash,
      p_client_request_id,
      sanitized_refs
    );
  end if;
  return result_value;
end
$function$;

comment on function public.finalize_public_agent_message_v5(
  text, text, text, uuid, uuid, bigint, text, text, jsonb, jsonb,
  jsonb, boolean, boolean, text, jsonb
) is
  'Finaliza uma mensagem e associa referencias privadas estaveis de midia ao par correto sem expo-las na resposta publica.';

comment on function public.commit_public_agent_action_message_v6(
  text, text, text, uuid, uuid, bigint, text, uuid, text, text,
  jsonb, boolean, boolean, text, text, jsonb, jsonb, jsonb
) is
  'Finaliza cadastro ou bloqueio e associa referencias privadas estaveis de midia na mesma transacao idempotente.';

revoke all on function crm_private.public_agent_server_media_refs(jsonb)
  from public, anon, authenticated, service_role;
revoke all on function crm_private.attach_public_agent_message_media_v5(
  text, text, text, uuid, jsonb
) from public, anon, authenticated, service_role;

revoke all on function public.finalize_public_agent_message_v5(
  text, text, text, uuid, uuid, bigint, text, text, jsonb, jsonb,
  jsonb, boolean, boolean, text, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.finalize_public_agent_message_v5(
  text, text, text, uuid, uuid, bigint, text, text, jsonb, jsonb,
  jsonb, boolean, boolean, text, jsonb
) to service_role;

revoke all on function public.commit_public_agent_action_message_v6(
  text, text, text, uuid, uuid, bigint, text, uuid, text, text,
  jsonb, boolean, boolean, text, text, jsonb, jsonb, jsonb
) from public, anon, authenticated, service_role;
grant execute on function public.commit_public_agent_action_message_v6(
  text, text, text, uuid, uuid, bigint, text, uuid, text, text,
  jsonb, boolean, boolean, text, text, jsonb, jsonb, jsonb
) to service_role;

commit;
