-- Preserve reviewed, campaign-specific consent and the existing notification delivery.
alter table crm_private.bia_campaign_outreach_settings add column meta_consent_notice text, add column meta_consent_verified_at timestamptz;
create index bia_campaign_settings_actor on crm_private.bia_campaign_outreach_settings(actor_user_id);
create index bia_campaign_settings_campaign on crm_private.bia_campaign_outreach_settings(campaign_id);
create index bia_campaign_settings_recipient on crm_private.bia_campaign_outreach_settings(notify_user_id);
create index bia_campaign_settings_project on crm_private.bia_campaign_outreach_settings(project_id);
CREATE OR REPLACE FUNCTION crm_private.bia_enqueue_campaign_source(p_source text, p_source_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare cfg crm_private.bia_campaign_outreach_settings; lead public.crm_records; submission private.crm_public_form_submissions;
 attribution public.crm_opportunity_attributions; v_id uuid; v_phone text; profile jsonb:='{}'; consent jsonb:='{}'; captured timestamptz;
begin
 if p_source='public_form' then
  select * into submission from private.crm_public_form_submissions where id=p_source_id and original_created_at is null;
  if submission.id is null then return null;end if;
  select * into cfg from crm_private.bia_campaign_outreach_settings where public_form_slug=submission.form_slug and organization_id=submission.organization_id and enabled;
  select * into lead from public.crm_records where id=submission.crm_record_id;
  captured:=submission.created_at;
  profile:=jsonb_build_object('purpose',submission.purpose,'budget',submission.budget);
  consent:=jsonb_build_object('source','public_form','version',submission.consent_version,'at',submission.created_at);
 elsif p_source='meta' then
  select * into attribution from public.crm_opportunity_attributions where id=p_source_id and provider='meta' and channel='meta_lead_ads';
  if attribution.id is null then return null;end if;
  select * into cfg from crm_private.bia_campaign_outreach_settings where organization_id=attribution.organization_id and meta_campaign_id=attribution.campaign_id and meta_form_id=attribution.form_id and enabled;
  select * into lead from public.crm_records where id=attribution.crm_record_id;
  captured:=attribution.captured_at;
  consent:=jsonb_build_object('source','meta','attributionId',attribution.id,'at',captured,'version','meta_form_solaris_whatsapp_v1','formId',cfg.meta_form_id,'notice',cfg.meta_consent_notice,'noticeVerifiedAt',cfg.meta_consent_verified_at);
  select jsonb_strip_nulls(jsonb_build_object('purpose',
    case lower(trim(field->'values'->>0)) when 'investir' then 'investir' when 'morar' then 'morar' when 'avaliando' then 'avaliando' when 'ainda estou avaliando' then 'avaliando' end)) into profile
    from crm_integration_private.integration_inbox_events e cross join lateral jsonb_array_elements(coalesce(e.lead_payload->'lead'->'field_data','[]')) field
    where e.attribution_id=attribution.id and e.organization_id=cfg.organization_id and e.form_id=cfg.meta_form_id and field->>'name'='objetivo' limit 1;
  profile:=coalesce(profile,'{}'::jsonb);
 else return null;end if;
 if cfg.id is null or lead.id is null or lead.organization_id<>cfg.organization_id or lead.project_id<>cfg.project_id
  or lead.created_at<cfg.activated_at or captured is null or captured<cfg.activated_at or captured<now()-interval '24 hours' or lead.record_status<>'aberta' then return null;end if;
 v_phone:=regexp_replace(lead.phone,'[^0-9]','','g');
 if length(v_phone) in(10,11) then v_phone:='55'||v_phone;end if;
 if coalesce(v_phone,'')!~'^55[1-9][0-9]([2-9][0-9]{7}|9[0-9]{8})$' then return null;end if;
 insert into crm_private.bia_campaign_outreach_jobs(settings_id,crm_record_id,source_type,source_id,phone,recipient_name,profile,consent)
 values(cfg.id,lead.id,p_source,p_source_id,v_phone,coalesce(nullif(trim(lead.person_name),''),'tudo bem'),profile,consent)
 on conflict do nothing returning id into v_id;
 if v_id is not null and lead.campaign_id is null then update public.crm_records set campaign_id=cfg.campaign_id where id=lead.id and campaign_id is null;end if;
 return v_id;
end $function$
;
CREATE OR REPLACE FUNCTION crm_private.bia_campaign_block_reason(p_job uuid)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare j crm_private.bia_campaign_outreach_jobs; cfg crm_private.bia_campaign_outreach_settings; lead public.crm_records; contact public.contacts; v_phone text;
begin
 select * into j from crm_private.bia_campaign_outreach_jobs where id=p_job;
 select * into cfg from crm_private.bia_campaign_outreach_settings where id=j.settings_id;
 if j.id is null or not coalesce(cfg.enabled,false) then return 'BIA_CAMPAIGN_DISABLED';end if;
 if not private.arisa_actor_admin(cfg.organization_id,cfg.actor_user_id) then return 'BIA_CAMPAIGN_ACTOR_INACTIVE';end if;
 select * into lead from public.crm_records where id=j.crm_record_id;
 select * into contact from public.contacts where id=lead.contact_id;
 if lead.id is null or lead.organization_id<>cfg.organization_id or lead.project_id<>cfg.project_id or lead.record_status<>'aberta'
   or lead.created_at<cfg.activated_at then return 'BIA_CAMPAIGN_LEAD_INACTIVE';end if;
 if j.created_at<now()-interval '24 hours' then return 'BIA_CAMPAIGN_EXPIRED';end if;
 v_phone:=regexp_replace(lead.phone,'[^0-9]','','g');if length(v_phone) in(10,11) then v_phone:='55'||v_phone;end if;
 if v_phone is distinct from j.phone then return 'BIA_CAMPAIGN_PHONE_CHANGED';end if;
 if contact.id is not null and (not contact.active or contact.do_not_contact_at is not null or contact.marketing_consent_status in('denied','revoked')) then return 'BIA_CONTACT_PAUSED';end if;
 if j.source_type='public_form' then
  if not exists(select 1 from private.crm_public_form_submissions s where s.id=j.source_id and s.form_slug=cfg.public_form_slug and s.organization_id=cfg.organization_id and s.crm_record_id=lead.id and s.original_created_at is null and s.created_at>=cfg.activated_at and s.consent_version='solaris-whatsapp-v1' and regexp_replace(s.phone,'[^0-9]','','g')=j.phone) then return 'BIA_CAMPAIGN_CONSENT_REQUIRED';end if;
 elsif j.source_type='meta' then
  if not exists(select 1 from public.crm_opportunity_attributions a where a.id=j.source_id and a.crm_record_id=lead.id and a.organization_id=cfg.organization_id and a.provider='meta' and a.campaign_id=cfg.meta_campaign_id and a.form_id=cfg.meta_form_id and a.captured_at>=cfg.activated_at) then return 'BIA_CAMPAIGN_SOURCE_CHANGED';end if;
  -- The reviewed published form explicitly requests WhatsApp service on submission. This is scoped
  -- contact consent, not broad marketing permission; it must not change the contact's global preference.
  if nullif(trim(cfg.meta_consent_notice),'') is null or cfg.meta_consent_verified_at is null
    or (j.consent->>'at')::timestamptz<cfg.meta_consent_verified_at
    or j.consent->>'notice' is distinct from cfg.meta_consent_notice then return 'BIA_CAMPAIGN_CONSENT_REQUIRED';end if;
 end if;
 if exists(select 1 from crm_private.bia_whatsapp_threads t join crm_private.bia_whatsapp_channels ch on ch.id=t.channel_id where ch.organization_id=cfg.organization_id and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(j.phone) and (t.opted_out_at is not null or t.human_requested)) then return 'BIA_CONTACT_PAUSED';end if;
 -- Never open a second automated conversation for an already contacted phone, even under another lead ID.
 if exists(select 1 from crm_private.bia_whatsapp_threads t join crm_private.bia_whatsapp_channels ch on ch.id=t.channel_id where ch.organization_id=cfg.organization_id and crm_private.bia_phone_key(t.peer_phone)=crm_private.bia_phone_key(j.phone) and (t.last_inbound_at is not null or exists(select 1 from crm_private.bia_whatsapp_outbound o where o.thread_id=t.id and o.id<>j.id and o.status<>'failed'))) then return 'BIA_CAMPAIGN_ALREADY_CONTACTED';end if;
 return null;
end $function$
;
CREATE OR REPLACE FUNCTION public.bia_campaign_outreach_worker(p_action text, p_args jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare j crm_private.bia_campaign_outreach_jobs; cfg crm_private.bia_campaign_outreach_settings; reason text; r jsonb; src record; lead public.crm_records; o crm_private.bia_whatsapp_outbound;
begin
 perform crm_private.assert_public_agent_service_role();
 if p_action='claim' then
  -- Reconcile ingestion and interrupted leases without re-sending uncertain operations.
  for src in select s.id from private.crm_public_form_submissions s join crm_private.bia_campaign_outreach_settings c on c.public_form_slug=s.form_slug and c.organization_id=s.organization_id and c.enabled where s.created_at>=c.activated_at and s.created_at>now()-interval '24 hours' and s.original_created_at is null and not exists(select 1 from crm_private.bia_campaign_outreach_jobs q where q.source_type='public_form' and q.source_id=s.id) order by s.created_at limit 100 loop
   perform crm_private.bia_enqueue_campaign_source('public_form',src.id);
  end loop;
  for src in select a.id from public.crm_opportunity_attributions a join crm_private.bia_campaign_outreach_settings c on c.organization_id=a.organization_id and c.meta_campaign_id=a.campaign_id and c.meta_form_id=a.form_id and c.enabled where a.captured_at>=c.activated_at and a.created_at>now()-interval '24 hours' and not exists(select 1 from crm_private.bia_campaign_outreach_jobs q where q.source_type='meta' and q.source_id=a.id) order by a.created_at limit 100 loop
   perform crm_private.bia_enqueue_campaign_source('meta',src.id);
  end loop;
  for j in select * from crm_private.bia_campaign_outreach_jobs where status in('sending','processing') and lease_until<now() for update skip locked loop
   select * into o from crm_private.bia_whatsapp_outbound where id=j.id;
   if o.id is not null then
    update crm_private.bia_campaign_outreach_jobs set status=case when o.status in('accepted','sent','delivered','read') then 'sent' when o.status='failed' then 'failed' else 'unknown' end,error_code=coalesce(o.error_code,'BIA_CAMPAIGN_SEND_INTERRUPTED'),updated_at=now() where id=j.id;
    if o.status in('accepted','sent','delivered','read') then perform crm_private.bia_campaign_notice(j.id,'started');else perform crm_private.bia_campaign_notice(j.id,'attention');end if;
   else update crm_private.bia_campaign_outreach_jobs set status='pending',available_at=now(),updated_at=now() where id=j.id;end if;
  end loop;
  for j in select q.* from crm_private.bia_campaign_outreach_jobs q join crm_private.bia_campaign_outreach_settings c on c.id=q.settings_id and c.enabled where q.status in('pending','awaiting_template','awaiting_consent') and q.available_at<=now() order by q.created_at limit 25 for update of q skip locked loop
   reason:=crm_private.bia_campaign_block_reason(j.id);
   if reason is not null then
    update crm_private.bia_campaign_outreach_jobs set status=case when reason='BIA_CAMPAIGN_CONSENT_REQUIRED' then 'awaiting_consent' else 'skipped' end,error_code=reason,available_at=now()+interval '5 minutes',updated_at=now() where id=j.id;
    perform crm_private.bia_campaign_notice(j.id,'attention');continue;
   end if;
   update crm_private.bia_campaign_outreach_jobs set status='processing',lease=gen_random_uuid(),lease_until=now()+interval '3 minutes',attempts=attempts+1,updated_at=now() where id=j.id returning * into j;
   select * into cfg from crm_private.bia_campaign_outreach_settings where id=j.settings_id;
   return jsonb_build_object('id',j.id,'lease',j.lease,'organization_id',cfg.organization_id,'template_name',cfg.template_name,'phone',j.phone,'recipient_name',j.recipient_name);
  end loop;
  return '{}';
 end if;
 select * into j from crm_private.bia_campaign_outreach_jobs where id=(p_args->>'id')::uuid for update;
 if j.id is null or j.lease is distinct from (p_args->>'lease')::uuid or j.lease_until<=now() then raise exception 'BIA_CAMPAIGN_LEASE_CHANGED';end if;
 select * into cfg from crm_private.bia_campaign_outreach_settings where id=j.settings_id;
 if p_action='start' and j.status='processing' then
  select * into lead from public.crm_records where id=j.crm_record_id for update;
  perform 1 from public.contacts where id=lead.contact_id for update;
  reason:=crm_private.bia_campaign_block_reason(j.id);
  if reason is not null then
   update crm_private.bia_campaign_outreach_jobs set status='skipped',error_code=reason,updated_at=now() where id=j.id;perform crm_private.bia_campaign_notice(j.id,'attention');return jsonb_build_object('proceed',false);
  end if;
  r:=public.bia_whatsapp_outbound_admin(cfg.organization_id,cfg.actor_user_id,'start',
   jsonb_build_object('id',j.id,'campaignLease',j.lease,'phone',j.phone,'consent',true,'template',cfg.template_name,'hash',p_args->>'hash','body',p_args->>'body'));
  if r->>'proceed'='true' then
   update crm_private.bia_campaign_outreach_jobs set status='sending',updated_at=now() where id=j.id;
   select * into o from crm_private.bia_whatsapp_outbound where id=j.id;
   update crm_private.bia_whatsapp_outbound set consent_copy_version=coalesce(j.consent->>'version','campaign_whatsapp_v1') where id=j.id;
   update crm_private.public_agent_sessions s set crm_record_id=lead.id,contact_id=lead.contact_id,
    contact_capture=s.contact_capture||jsonb_build_object('name',j.recipient_name,'phone','+'||j.phone),
    captured_profile=s.captured_profile||jsonb_strip_nulls(j.profile),contact_consent_at=(j.consent->>'at')::timestamptz,consent_copy_version=coalesce(j.consent->>'version','meta_custom_disclaimer')
   from crm_private.bia_whatsapp_threads t where t.id=o.thread_id and s.id=t.session_id;
  end if;return r;
 elsif p_action='finish' then
  return public.bia_whatsapp_outbound_admin(cfg.organization_id,cfg.actor_user_id,'finish',p_args);
 elsif p_action='defer' and j.status='processing' then
  reason:=left(p_args->>'error',128);
  update crm_private.bia_campaign_outreach_jobs set status=case when reason in('BIA_TEMPLATE_NOT_APPROVED','BIA_TEMPLATE_UNAVAILABLE') then 'awaiting_template' when reason in('BIA_CHANNEL_DISABLED','BIA_SEND_RATE_LIMIT') or attempts<3 then 'pending' else 'failed' end,error_code=reason,available_at=now()+interval '1 minute',updated_at=now() where id=j.id;
  if reason not in('BIA_SEND_RATE_LIMIT') then perform crm_private.bia_campaign_notice(j.id,'attention');end if;
  return jsonb_build_object('ok',true);
 end if;
 raise exception 'BIA_CAMPAIGN_ACTION_INVALID';
end $function$
;
CREATE OR REPLACE FUNCTION crm_private.bia_campaign_notice(p_job uuid, p_kind text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare j crm_private.bia_campaign_outreach_jobs; cfg crm_private.bia_campaign_outreach_settings; o crm_private.bia_whatsapp_outbound; n uuid; link text; message text;
begin
 select * into j from crm_private.bia_campaign_outreach_jobs where id=p_job;
 select * into cfg from crm_private.bia_campaign_outreach_settings where id=j.settings_id;
 if cfg.id is null then return;end if;
 select * into o from crm_private.bia_whatsapp_outbound where id=j.id;
 link:=case when o.thread_id is not null then '/bia?painel=whatsapp&atendimento='||o.thread_id else '/bia?painel=whatsapp' end;
 message:=case when p_kind='started' then 'A Bia iniciou o contato com '||j.recipient_name||' pelo WhatsApp. Mensagem aceita pela Meta; acompanhe a entrega e as respostas no histórico.'
 else 'O primeiro contato da Bia com '||j.recipient_name||' aguarda atenção. '||case coalesce(j.error_code,o.error_code,j.status)
 when 'BIA_CAMPAIGN_CONSENT_REQUIRED' then 'O cadastro ainda não registra a autorização de contato pelo WhatsApp.'
 when 'BIA_TEMPLATE_NOT_APPROVED' then 'O modelo da campanha aguarda aprovação da Meta.'
 when 'BIA_TEMPLATE_UNAVAILABLE' then 'Não foi possível verificar o modelo da campanha na Meta.'
 when 'BIA_CHANNEL_DISABLED' then 'O WhatsApp da Bia está temporariamente indisponível.'
 when 'BIA_CONTACT_PAUSED' then 'O contato está pausado ou pediu para não receber mensagens.'
 when 'BIA_CAMPAIGN_ALREADY_CONTACTED' then 'Já existe atendimento para esse telefone; a abertura não foi repetida.'
 when 'BIA_CAMPAIGN_PHONE_CHANGED' then 'O telefone do cadastro mudou antes do envio.'
 when 'BIA_CAMPAIGN_EXPIRED' then 'O primeiro contato ficou pendente por mais de 24 horas.'
 when 'META_131042' then 'A Meta recusou o envio por uma pendência na forma de pagamento.'
 else 'O envio não foi confirmado. Consulte o histórico antes de tentar novamente.' end end;
 message:=message||E'\nCampanha: '||coalesce(cfg.campaign_context->>'name','Campanha Solaris')||E'\nTelefone final: '||right(j.phone,4);
 insert into public.activity_notifications(organization_id,recipient_user_id,actor_user_id,notification_type,title,message,metadata,dedupe_key)
 values(cfg.organization_id,cfg.notify_user_id,cfg.actor_user_id,'bia_conversation_'||p_kind,
 case when p_kind='started' then 'Bia iniciou uma conversa' else 'Contato da Bia requer atenção' end,message,
 jsonb_build_object('source','bia_whatsapp','campaign_id',cfg.campaign_id,'crm_record_id',j.crm_record_id,'outbound_id',j.id,'thread_id',o.thread_id,'href',link,'whatsapp_status','pending'),
 'bia-campaign:'||j.id||':'||p_kind)
 on conflict do nothing returning id into n;
 if n is not null then
  insert into crm_private.arisa_whatsapp_notice_jobs(id,organization_id,recipient_user_id,actor_user_id)
  values(n,cfg.organization_id,cfg.notify_user_id,cfg.actor_user_id) on conflict do nothing;
 end if;
end $function$
;
CREATE OR REPLACE FUNCTION public.bia_whatsapp_webhook(p_organization_id uuid, p_phone_number_id text, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare ch crm_private.bia_whatsapp_channels; th crm_private.bia_whatsapp_threads; item jsonb; mid uuid; sid uuid; token text; fingerprint text; slug text; handled jsonb:='[]'; statuses jsonb:='[]'; stamp timestamptz;
begin
  perform crm_private.assert_public_agent_service_role();
  if jsonb_typeof(p_payload)<>'object' or pg_column_size(p_payload)>1048576 then raise exception 'BIA_PAYLOAD_INVALID'; end if;
  select * into ch from crm_private.bia_whatsapp_channels where organization_id=p_organization_id and phone_number_id=p_phone_number_id;
  if ch.id is null then raise exception 'BIA_CHANNEL_NOT_FOUND'; end if;
  select e.slug into slug from crm_private.public_agent_experiences e where e.id=ch.experience_id and e.organization_id=ch.organization_id and e.active;
  if slug is null then raise exception 'BIA_EXPERIENCE_INACTIVE'; end if;
  for item in select value from jsonb_array_elements(coalesce(p_payload->'messages','[]')) loop
    if coalesce(item->>'from_phone','') !~ '^[0-9]{8,20}$' or coalesce(item->>'provider_message_id','')='' then raise exception 'BIA_MESSAGE_INVALID'; end if;
    stamp:=least((item->>'occurred_at')::timestamptz,now());
    perform pg_advisory_xact_lock(hashtextextended('bia:'||ch.id::text||':'||crm_private.bia_phone_key(item->>'from_phone'),0));
    select * into th from crm_private.bia_whatsapp_threads where channel_id=ch.id and crm_private.bia_phone_key(peer_phone)=crm_private.bia_phone_key(item->>'from_phone') order by (peer_phone=item->>'from_phone') desc,created_at limit 1;
    if th.id is null then
      token:=encode(extensions.gen_random_bytes(32),'hex'); fingerprint:=encode(extensions.gen_random_bytes(32),'hex');
      sid:=(public.open_public_agent_session(slug,token,fingerprint,jsonb_build_object('source','whatsapp'),'whatsapp',null,'Bia WhatsApp Cloud API')->>'sessionId')::uuid;
      insert into crm_private.bia_whatsapp_threads(channel_id,peer_phone,session_id,token_hash,fingerprint_hash,last_inbound_at) values(ch.id,item->>'from_phone',sid,token,fingerprint,stamp) returning * into th;
      -- The transport proves possession of the sender's number; a WhatsApp profile name is not a verified customer name.
      update crm_private.public_agent_sessions set contact_capture=contact_capture||jsonb_build_object('phone','+'||(item->>'from_phone')),contact_consent_at=now(),consent_copy_version='whatsapp_customer_initiated_v1' where id=sid;
    end if;
    insert into crm_private.bia_whatsapp_messages(thread_id,provider_message_id,direction,content,message_type,metadata,occurred_at)
      values(th.id,item->>'provider_message_id','inbound',left(coalesce(item->>'content',''),6000),item->>'message_type',coalesce(item->'metadata','{}'),stamp)
      on conflict(provider_message_id) do nothing returning id into mid;
    handled:=handled||jsonb_build_array(item->>'provider_message_id');
    if mid is null then continue; end if;
    update crm_private.bia_whatsapp_threads set peer_phone=item->>'from_phone',last_inbound_at=greatest(last_inbound_at,stamp),opted_out_at=case when trim(lower(item->>'content'))~'^(sair|parar|pare|stop|n[aã]o tenho interesse|sem interesse|cancelar mensagens|n[aã]o me (chame|contate|mande mensagens))[.! ]*$' then now() else opted_out_at end where id=th.id;
    update crm_private.public_agent_sessions set expires_at=greatest(expires_at,now()+interval '14 days'),last_activity_at=now() where id=th.session_id and status not in('closed','blocked');
    insert into crm_private.bia_whatsapp_reply_jobs(id,thread_id) values(mid,th.id);
  end loop;
  for item in select value from jsonb_array_elements(coalesce(p_payload->'statuses','[]')) loop
    if crm_private.bia_outbound_status(ch.id,item) then
      statuses:=statuses||jsonb_build_array(item->>'provider_message_id');continue;
    end if;
    -- Correlate a Meta delivery callback even when the HTTP send response was lost.
    if coalesce(item->>'operation_id','') ~ '^[0-9a-f-]{36}$' then
      select q.id into mid from crm_private.bia_whatsapp_reply_jobs q join crm_private.bia_whatsapp_threads t on t.id=q.thread_id
        where q.id::text=item->>'operation_id' and t.channel_id=ch.id and t.peer_phone=coalesce(item->>'recipient_phone',t.peer_phone) and q.status in('sending','unknown','sent');
      if mid is not null then
        insert into crm_private.bia_whatsapp_messages(thread_id,provider_message_id,direction,content,delivery_status,occurred_at,metadata)
          select q.thread_id,item->>'provider_message_id','outbound',q.generated_content,item->>'status',(item->>'occurred_at')::timestamptz,jsonb_build_object('reply_to',q.id)
          from crm_private.bia_whatsapp_reply_jobs q where q.id=mid on conflict(provider_message_id) do nothing;
        update crm_private.bia_whatsapp_reply_jobs set status=case when item->>'status'='failed' and status<>'sent' then 'failed' else 'sent' end,updated_at=now() where id=mid;
        update crm_private.bia_whatsapp_threads set human_requested=true where id=(select thread_id from crm_private.bia_whatsapp_reply_jobs where id=mid and human_requested);
      end if;
    end if;
    update crm_private.bia_whatsapp_messages m set delivery_status=item->>'status'
    from crm_private.bia_whatsapp_threads t where m.thread_id=t.id and t.channel_id=ch.id and m.provider_message_id=item->>'provider_message_id' and m.direction='outbound' and m.message_type<>'template'
      and (case item->>'status' when 'read' then 4 when 'delivered' then 3 when 'sent' then 2 when 'failed' then 1 else 0 end) >= (case m.delivery_status when 'read' then 4 when 'delivered' then 3 when 'sent' then 2 when 'failed' then 1 else 0 end);
    statuses:=statuses||jsonb_build_array(item->>'provider_message_id');
  end loop;
  perform private.bia_dispatch_whatsapp_replies();
  return jsonb_build_object('handled_message_ids',handled,'handled_status_ids',statuses);
end $function$
;

