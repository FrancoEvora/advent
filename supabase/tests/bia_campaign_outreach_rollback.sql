begin;
set local request.jwt.claims='{"role":"service_role"}';
do $$
declare form private.crm_public_forms; cfg uuid; owner_id uuid; campaign uuid; req uuid:=gen_random_uuid(); req2 uuid:=gen_random_uuid(); lead_id uuid; old_id uuid; contact_id uuid; j jsonb; r jsonb; op crm_private.bia_whatsapp_outbound; th crm_private.bia_whatsapp_threads; before_count integer; got jsonb; meta_lead uuid; meta_attribution uuid:=gen_random_uuid(); meta_event uuid:=gen_random_uuid(); meta_phone text:='5534999990103';
begin
 select * into form from private.crm_public_forms where slug='solaris-futura-casa';
 select user_id into owner_id from public.organization_members where organization_id=form.organization_id and role='admin' and active order by created_at limit 1;
 select id into campaign from public.crm_campaigns where organization_id=form.organization_id and name='SOLARIS | PLANO SAFRA 2026 | FORMULARIO | EVORA | MONTE CARMELO';
 if form.slug is null or owner_id is null or campaign is null then raise exception 'TEST_FIXTURE_MISSING';end if;
 insert into crm_private.bia_campaign_outreach_settings(organization_id,campaign_id,project_id,actor_user_id,notify_user_id,public_form_slug,meta_campaign_id,meta_form_id,template_name,campaign_context,enabled,activated_at)
 values(form.organization_id,campaign,form.project_id,owner_id,owner_id,form.slug,'120246671040840037','951976484620201','bia_plano_safra_2026','{"name":"Plano Safra 2026"}',true,now()-interval '1 second')
 returning id into cfg;
 if has_function_privilege('anon','public.bia_campaign_outreach_worker(text,jsonb)','execute') or has_function_privilege('authenticated','public.bia_campaign_outreach_worker(text,jsonb)','execute') then raise exception 'TEST_WORKER_PUBLIC';end if;
 perform public.submit_solaris_public_form(jsonb_build_object('requestId',req,'name','Teste Campanha Maria','phone','+5534999990101','purpose','investir','consent',true),repeat('a',64));
 select crm_record_id into lead_id from private.crm_public_form_submissions where id=req;
 if (select count(*) from crm_private.bia_campaign_outreach_jobs where source_id=req)<>1 then raise exception 'TEST_QUEUE_MISSING';end if;
 perform public.submit_solaris_public_form(jsonb_build_object('requestId',req,'name','Teste Campanha Maria','phone','+5534999990101','purpose','investir','consent',true),repeat('a',64));
 perform crm_private.bia_enqueue_campaign_source('public_form',req);
 if (select count(*) from crm_private.bia_campaign_outreach_jobs where crm_record_id=lead_id)<>1 then raise exception 'TEST_DUPLICATE_JOB';end if;
 j:=public.bia_campaign_outreach_worker('claim');
 if j->>'phone'<>'5534999990101' or j->>'template_name'<>'bia_plano_safra_2026' then raise exception 'TEST_WRONG_CAMPAIGN_JOB';end if;
 begin
  perform public.bia_whatsapp_outbound_admin(form.organization_id,owner_id,'start',jsonb_build_object('id',gen_random_uuid(),'phone','5534999990102','template','bia_plano_safra_2026','body','unauthorized campaign','hash',repeat('b',64),'consent',true));
  raise exception 'TEST_CAMPAIGN_BYPASS';
 exception when others then if sqlerrm<>'BIA_REQUEST_INVALID' then raise;end if;end;
 r:=public.bia_campaign_outreach_worker('start',j||jsonb_build_object('hash',repeat('b',64),'body','Olá, Maria! Plano Safra.'));
 if r->>'proceed'<>'true' then raise exception 'TEST_START_MISSING';end if;
 select * into op from crm_private.bia_whatsapp_outbound where id=(j->>'id')::uuid;
 if op.template_name<>'bia_plano_safra_2026' then raise exception 'TEST_WRONG_TEMPLATE';end if;
 perform public.bia_campaign_outreach_worker('finish',j||jsonb_build_object('status','accepted','providerMessageId','wamid.bia.campaign.rollback.test','recipientPhone',j->>'phone'));
 perform crm_private.bia_outbound_status(op.channel_id,jsonb_build_object('operation_id',op.id,'provider_message_id','wamid.bia.campaign.rollback.test','recipient_phone',j->>'phone','status','delivered'));
 if (select count(*) from public.activity_notifications where metadata->>'outbound_id'=op.id::text and notification_type='bia_conversation_started')<>1 then raise exception 'TEST_NOTICE_DUPLICATED';end if;
 if not exists(select 1 from crm_private.arisa_whatsapp_notice_jobs w join public.activity_notifications n on n.id=w.id where n.metadata->>'outbound_id'=op.id::text and w.recipient_user_id=owner_id) then raise exception 'TEST_CURRENT_WHATSAPP_NOTIFICATION_MISSING';end if;
 select * into th from crm_private.bia_whatsapp_threads where id=op.thread_id;
 got:=public.get_public_agent_gateway_context_v1('solaris',th.token_hash,th.fingerprint_hash);
 if got->'campaignContext'->>'name'<>'Plano Safra 2026' or got->'campaignContext'->'knownAnswers'->>'purpose'<>'investir' or got->>'crmRecordId'<>lead_id::text then raise exception 'TEST_CONTEXT_MISSING';end if;
 if exists(select 1 from crm_private.public_agent_messages where session_id=th.session_id and direction='user') then raise exception 'TEST_FABRICATED_CUSTOMER_TURN';end if;
 -- Client consent may be revoked between claim and send.
 perform public.submit_solaris_public_form(jsonb_build_object('requestId',req2,'name','Teste Campanha Ana','phone','+5534999990102','purpose','morar','consent',true),repeat('b',64));
 j:=public.bia_campaign_outreach_worker('claim');
 select r.contact_id into contact_id from public.crm_records r join private.crm_public_form_submissions s on s.crm_record_id=r.id where s.id=req2;
 update public.contacts set do_not_contact_at=now() where id=contact_id;
 r:=public.bia_campaign_outreach_worker('start',j||jsonb_build_object('hash',repeat('c',64),'body','Olá, Ana! Plano Safra.'));
 if r->>'proceed'<>'false' or exists(select 1 from crm_private.bia_whatsapp_outbound where id=(j->>'id')::uuid) then raise exception 'TEST_REVOKED_CONTACT_SENT';end if;
 -- Existing records are never enrolled, even if reconciliation is repeated.
 select count(*) into before_count from crm_private.bia_campaign_outreach_jobs;
 for old_id in select s.id from private.crm_public_form_submissions s join public.crm_records r on r.id=s.crm_record_id where r.created_at<now()-interval '1 second' limit 30 loop
  perform crm_private.bia_enqueue_campaign_source('public_form',old_id);
 end loop;
 if (select count(*) from crm_private.bia_campaign_outreach_jobs)<>before_count then raise exception 'TEST_RETROACTIVE_CONTACT';end if;

 -- A committed Meta form carries campaign-specific consent and its existing objective answer.
 update crm_private.bia_campaign_outreach_settings set meta_consent_notice='Pedido de contato por WhatsApp sobre o Solaris',meta_consent_verified_at=now()-interval '1 second' where id=cfg;
 insert into public.crm_records(organization_id,person_name,phone,project_id,pipeline_id,stage_id,stage,record_status,source,source_channel)
 values(form.organization_id,'Teste Meta Marcos','+'||meta_phone,form.project_id,form.pipeline_id,form.stage_id,'novo','aberta','Meta Lead Ads','meta_lead_ads') returning id into meta_lead;
 update public.crm_records r set product_id=route.product_id,lead_source_id=route.lead_source_id,campaign_id=campaign from public.crm_meta_lead_routes route where r.id=meta_lead and route.form_id='951976484620201' and route.organization_id=form.organization_id;
 insert into public.crm_opportunity_attributions
 select (jsonb_populate_record(null::public.crm_opportunity_attributions,to_jsonb(a)||jsonb_build_object('id',meta_attribution,'crm_record_id',meta_lead,'opportunity_key',meta_lead,'created_at',now(),'captured_at',now(),'meta_lead_id',replace(meta_event::text,'-',''),'external_lead_id',replace(meta_event::text,'-',''),'metadata',jsonb_build_object('inbox_event_id',meta_event)))).*
 from public.crm_opportunity_attributions a where a.form_id='951976484620201' order by a.created_at limit 1;
 insert into crm_integration_private.integration_inbox_events
 select (jsonb_populate_record(null::crm_integration_private.integration_inbox_events,to_jsonb(e)||jsonb_build_object(
 'id',meta_event,'event_key','bia-campaign-test:'||meta_event,'external_lead_id',replace(meta_event::text,'-',''),'meta_lead_id',replace(meta_event::text,'-',''),
 'crm_record_id',meta_lead,'contact_id',null,'attribution_id',meta_attribution,'event_occurred_at',now(),'created_at',now(),
 'lead_payload',jsonb_build_object('lead',jsonb_build_object('field_data',jsonb_build_array(jsonb_build_object('name','objetivo','values',jsonb_build_array('morar')))))))).*
 from crm_integration_private.integration_inbox_events e where e.form_id='951976484620201' order by e.created_at limit 1;
 set constraints bia_campaign_meta_lead_created immediate;
 select to_jsonb(q) into got from crm_private.bia_campaign_outreach_jobs q where q.source_id=meta_attribution;
 if got is null or got->'profile'->>'purpose'<>'morar' or got->'consent'->>'version'<>'meta_form_solaris_whatsapp_v1' then raise exception 'TEST_META_COMMITTED_CONTEXT';end if;
 if crm_private.bia_campaign_block_reason((got->>'id')::uuid) is not null then raise exception 'TEST_META_FORM_CONSENT';end if;
 update crm_private.bia_campaign_outreach_settings set meta_consent_notice=null where id=cfg;
 if crm_private.bia_campaign_block_reason((got->>'id')::uuid) is distinct from 'BIA_CAMPAIGN_CONSENT_REQUIRED' then raise exception 'TEST_UNREVIEWED_META_FORM';end if;
 -- A quick reply declining interest must opt out before the reply queue runs.
 perform public.bia_whatsapp_webhook(form.organization_id,(select phone_number_id from crm_private.bia_whatsapp_channels where id=op.channel_id),
 jsonb_build_object('messages',jsonb_build_array(jsonb_build_object('from_phone','5534999990101','provider_message_id','wamid.test.decline','content','Não tenho interesse','message_type','button','occurred_at',now())),'statuses','[]'::jsonb));
 if not exists(select 1 from crm_private.bia_whatsapp_threads where id=op.thread_id and opted_out_at is not null) then raise exception 'TEST_DECLINE_NOT_RESPECTED';end if;

end $$;
rollback;
