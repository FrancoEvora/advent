-- Meta may identify Brazilian mobile subscribers without the inserted ninth digit.
-- Return only the two mobile forms; never alter landlines or other countries.
create or replace function crm_private.whatsapp_phone_variants(p_phone text)
returns text[]
language sql immutable strict
set search_path = ''
as $variants$
  with number as (select regexp_replace(p_phone, '[^0-9]', '', 'g') as phone)
  select case
    when phone ~ '^55[1-9][0-9][6-9][0-9]{7}$'
      then array[phone, left(phone,4) || '9' || substr(phone,5)]
    when phone ~ '^55[1-9][0-9]9[6-9][0-9]{7}$'
      then array[phone, left(phone,4) || substr(phone,6)]
    else array[phone]
  end from number;
$variants$;
revoke all on function crm_private.whatsapp_phone_variants(text) from public,anon,authenticated;

CREATE OR REPLACE FUNCTION public.arisa_whatsapp_webhook(p_organization_id uuid, p_phone_number_id text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare item jsonb;th public.arisa_whatsapp_threads;ct public.contacts;msg public.arisa_whatsapp_messages;op public.arisa_whatsapp_operations;v_phone text;v_phones text[];v_thread_ids uuid[];v_id text;v_status text;v_time timestamptz;v_count integer;v_rank integer;v_old_rank integer;v_messages jsonb:='[]';v_statuses jsonb:='[]';v_result jsonb;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'SERVICE_REQUIRED' using errcode='42501';end if;
  if not exists(select 1 from crm_private.whatsapp_runtime_settings s where s.organization_id=p_organization_id and s.phone_number_id=p_phone_number_id) then return jsonb_build_object('handled_message_ids',v_messages,'handled_status_ids',v_statuses);end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or pg_column_size(p_payload)>1048576 then raise exception 'WHATSAPP_INVALID';end if;
  for item in select value from jsonb_array_elements(coalesce(p_payload->'messages','[]')) loop
    th=null;ct=null;v_id=item->>'provider_message_id';v_phone=regexp_replace(coalesce(item->>'from_phone',''),'[^0-9]','','g');
    if length(coalesce(v_id,'')) not between 8 and 512 or v_phone!~'^[1-9][0-9]{7,14}$' or length(coalesce(item->>'content','')) not between 1 and 12000 then continue;end if;
    v_phones=crm_private.whatsapp_phone_variants(v_phone);
    select array_agg(t.id) into v_thread_ids from public.arisa_whatsapp_threads t
      where t.organization_id=p_organization_id and t.phone_number_id=p_phone_number_id and t.phone=any(v_phones);
    if cardinality(v_thread_ids)>1 then
      -- Do not guess between two administrative threads or fall through to CRM.
      v_messages=v_messages||jsonb_build_array(v_id);
      continue;
    end if;
    if cardinality(v_thread_ids)=1 then
      select * into th from public.arisa_whatsapp_threads where id=v_thread_ids[1] for update;
    end if;
    if th.id is null then
      select count(*) into v_count from public.contacts where organization_id=p_organization_id and active and regexp_replace(coalesce(phone,''),'[^0-9]','','g')=any(v_phones);
      if v_count<>1 then continue;end if;
      select * into ct from public.contacts where organization_id=p_organization_id and active and regexp_replace(coalesce(phone,''),'[^0-9]','','g')=any(v_phones);
      if ct.contact_type not in('fornecedor','colaborador','terrenista') then continue;end if;
      insert into public.arisa_whatsapp_threads(organization_id,phone_number_id,phone,contact_id,contact_name) values(p_organization_id,p_phone_number_id,regexp_replace(ct.phone,'[^0-9]','','g'),ct.id,ct.name) on conflict(organization_id,phone_number_id,phone) do update set contact_name=coalesce(public.arisa_whatsapp_threads.contact_name,excluded.contact_name) returning * into th;
    end if;
    v_messages=v_messages||jsonb_build_array(v_id);
    v_time=coalesce(nullif(item->>'occurred_at','')::timestamptz,now());
    if v_time>now()+interval '5 minutes' then continue;end if;v_time=least(v_time,now());
    insert into public.arisa_whatsapp_messages(organization_id,thread_id,direction,content,message_type,provider_message_id,delivery_status,metadata,occurred_at) values(p_organization_id,th.id,'inbound',item->>'content',left(coalesce(item->>'message_type','text'),40),v_id,'delivered',coalesce(item->'metadata','{}')||jsonb_build_object('provider_from_phone',v_phone),v_time) on conflict(organization_id,provider_message_id) do nothing returning * into msg;
    if not found then continue;end if;
    update public.arisa_whatsapp_threads set last_inbound_at=greatest(last_inbound_at,v_time),last_message_at=greatest(last_message_at,v_time),opted_out_at=case when lower(trim(item->>'content')) in('pare','parar','sair','stop','não quero receber mensagens','nao quero receber mensagens') then now() else opted_out_at end where id=th.id;
  end loop;
  for item in select value from jsonb_array_elements(coalesce(p_payload->'statuses','[]')) loop
    op=null;msg=null;v_id=item->>'provider_message_id';v_status=item->>'status';
    if length(coalesce(v_id,'')) not between 8 and 512 or v_status not in('sent','delivered','read','failed') then continue;end if;
    select m.* into msg from public.arisa_whatsapp_messages m join public.arisa_whatsapp_threads t on t.id=m.thread_id where m.organization_id=p_organization_id and t.phone_number_id=p_phone_number_id and m.provider_message_id=v_id and m.direction='outbound';
    if msg.id is null and coalesce(item->>'operation_id','')~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      select * into op from public.arisa_whatsapp_operations where id=(item->>'operation_id')::uuid and organization_id=p_organization_id and phone_number_id=p_phone_number_id and status in('queued','unknown','completed') for update;
      if op.id is not null then select * into msg from public.arisa_whatsapp_messages where id=op.channel_message_id and organization_id=p_organization_id for update;end if;
    end if;
    if msg.id is null or (msg.provider_message_id is not null and msg.provider_message_id<>v_id) then continue;end if;
    -- Match finish's operation-then-message locking order.
    if op.id is null then select * into op from public.arisa_whatsapp_operations where id=msg.operation_id for update;end if;
    if nullif(item->>'recipient_phone','') is not null and not coalesce(op.phone=any(crm_private.whatsapp_phone_variants(item->>'recipient_phone')),false) then continue;end if;
    select * into msg from public.arisa_whatsapp_messages where id=msg.id for update;
    v_statuses=v_statuses||jsonb_build_array(v_id);v_time=coalesce(nullif(item->>'occurred_at','')::timestamptz,now());
    if v_time>now()+interval '5 minutes' then continue;end if;v_time=least(v_time,now());
    v_rank=case v_status when 'read' then 4 when 'delivered' then 3 when 'sent' then 2 else 1 end;v_old_rank=case msg.delivery_status when 'read' then 4 when 'delivered' then 3 when 'sent' then 2 else 0 end;
    update public.arisa_whatsapp_messages set provider_message_id=v_id,delivery_status=case when v_status='failed' and v_old_rank<3 then 'failed' when v_rank>v_old_rank and (msg.delivery_status<>'failed' or v_status in('delivered','read')) then v_status else delivery_status end,status_at=greatest(status_at,v_time),metadata=metadata||jsonb_strip_nulls(jsonb_build_object('provider_status',v_status,'provider_status_at',v_time,'provider_error_code',left(item->>'error_code',128))) where id=msg.id returning * into msg;
    if op.id is null then select * into op from public.arisa_whatsapp_operations where id=msg.operation_id for update;end if;
    if op.id is not null then
      v_result=jsonb_build_object('ok',msg.delivery_status<>'failed','operation_id',op.id,'message_id',msg.id,'provider_message_id',v_id,'delivery_status',msg.delivery_status,'phone',op.phone,'content',msg.content,'accepted_by_meta',true,'delivered',msg.delivery_status in('delivered','read'),'read',msg.delivery_status='read');
      update public.arisa_whatsapp_operations set status='completed',result=v_result,updated_at=now() where id=op.id;
    end if;
  end loop;
  return jsonb_build_object('handled_message_ids',v_messages,'handled_status_ids',v_statuses);
end $function$
;
