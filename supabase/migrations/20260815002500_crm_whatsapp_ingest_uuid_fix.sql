begin;

create or replace function public.ingest_whatsapp_inbound_message(
  p_organization_id uuid,p_provider_message_id text,p_from_phone text,p_profile_name text,
  p_content text,p_occurred_at timestamptz,p_phone_number_id text,p_message_type text default 'text')
returns jsonb language plpgsql security definer set search_path=''
as $function$
declare
  normalized_phone text;
  contact_key uuid;
  record_key uuid;
  conversation_key uuid;
  message_key uuid;
  job_key uuid;
  job_inserted boolean:=false;
  open_count integer:=0;
begin
  if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'RPC restrita ao webhook WhatsApp.' using errcode='42501'; end if;
  if p_provider_message_id is null or char_length(trim(p_provider_message_id)) not between 8 and 512 then raise exception 'Message ID invalido.'; end if;
  if p_content is null or char_length(trim(p_content)) not between 1 and 12000 then raise exception 'Conteudo inbound invalido.'; end if;
  normalized_phone:=regexp_replace(coalesce(p_from_phone,''),'[^0-9]','','g');
  if char_length(normalized_phone) not between 8 and 20 then raise exception 'Telefone inbound invalido.'; end if;
  if not exists(select 1 from crm_private.whatsapp_runtime_settings s where s.organization_id=p_organization_id and s.enabled and s.phone_number_id=trim(p_phone_number_id)) then raise exception 'Runtime WhatsApp nao corresponde ao numero receptor.' using errcode='42501'; end if;

  select m.id into message_key from public.crm_messages m where m.organization_id=p_organization_id and m.channel='whatsapp' and m.provider_message_id=trim(p_provider_message_id) limit 1;
  if message_key is not null then return jsonb_build_object('message_id',message_key,'inserted',false,'duplicate',true); end if;

  select c.id into contact_key from public.contacts c
  where c.organization_id=p_organization_id and regexp_replace(coalesce(c.phone,''),'[^0-9]','','g')=normalized_phone
  order by c.updated_at desc nulls last,c.created_at desc,c.id limit 1;

  if contact_key is null then
    insert into public.contacts(organization_id,contact_type,name,phone,preferred_channel,marketing_consent_status)
    values(p_organization_id,'cliente',left(coalesce(nullif(trim(p_profile_name),''),'Contato WhatsApp'),180),'+'||normalized_phone,'whatsapp','unknown')
    returning id into contact_key;
  end if;

  select count(*)::integer into open_count
  from public.crm_records r
  where r.organization_id=p_organization_id and r.contact_id=contact_key and r.record_status='aberta';

  if open_count=1 then
    select r.id into record_key
    from public.crm_records r
    where r.organization_id=p_organization_id and r.contact_id=contact_key and r.record_status='aberta'
    order by r.created_at desc,r.id desc limit 1;
  elsif open_count>1 then
    select c.crm_record_id into record_key from public.crm_conversations c
    where c.organization_id=p_organization_id and c.contact_id=contact_key and c.channel='whatsapp' and c.status<>'closed'
    order by c.last_message_at desc nulls last,c.updated_at desc limit 1;
    if record_key is null then raise exception 'MULTIPLE_OPEN_OPPORTUNITIES_FOR_WHATSAPP'; end if;
  else
    insert into public.crm_records(organization_id,contact_id,person_name,phone,source,source_channel,record_status,notes)
    select p_organization_id,contact_key,c.name,c.phone,'WhatsApp Cloud API','whatsapp_inbound','aberta','Criado automaticamente a partir de mensagem inbound do WhatsApp.'
    from public.contacts c where c.id=contact_key
    returning id into record_key;
  end if;

  insert into public.crm_conversations(organization_id,crm_record_id,contact_id,channel,status,ai_enabled,last_message_at)
  values(p_organization_id,record_key,contact_key,'whatsapp','ai_active',true,coalesce(p_occurred_at,now()))
  on conflict(organization_id,crm_record_id,channel) do update
  set contact_id=excluded.contact_id,
      last_message_at=greatest(coalesce(public.crm_conversations.last_message_at,'epoch'::timestamptz),excluded.last_message_at),
      status=case when public.crm_conversations.status='human_active' then 'human_active' else 'ai_active' end,
      ai_enabled=case when public.crm_conversations.status='human_active' then false else public.crm_conversations.ai_enabled end,
      updated_at=now()
  returning id into conversation_key;

  insert into public.crm_messages(organization_id,conversation_id,crm_record_id,direction,actor_type,channel,content,delivery_status,provider_message_id,metadata,occurred_at)
  values(p_organization_id,conversation_key,record_key,'inbound','lead','whatsapp',trim(p_content),'delivered',trim(p_provider_message_id),
    jsonb_build_object('provider','meta_whatsapp_cloud','phone_number_id',trim(p_phone_number_id),'message_type',coalesce(p_message_type,'text'),'from_phone_normalized',normalized_phone),coalesce(p_occurred_at,now()))
  returning id into message_key;

  if exists(select 1 from public.crm_conversations c where c.id=conversation_key and c.ai_enabled=true and c.status<>'human_active') then
    select q.job_id,q.inserted into job_key,job_inserted
    from public.enqueue_crm_ai_job(p_organization_id,record_key,contact_key,'message_received','whatsapp-inbound:'||trim(p_provider_message_id),'shadow') q;
    if job_inserted then
      begin perform crm_private.dispatch_crm_ai_worker();
      exception when others then raise warning 'WhatsApp AI dispatch fail-open; job=%, sqlstate=%',job_key,sqlstate;
      end;
    end if;
  end if;

  return jsonb_build_object('message_id',message_key,'conversation_id',conversation_key,'crm_record_id',record_key,'contact_id',contact_key,'job_id',job_key,'job_inserted',job_inserted,'inserted',true,'duplicate',false);
end
$function$;

revoke all on function public.ingest_whatsapp_inbound_message(uuid,text,text,text,text,timestamptz,text,text) from public,anon,authenticated;
grant execute on function public.ingest_whatsapp_inbound_message(uuid,text,text,text,text,timestamptz,text,text) to service_role;

commit;
