-- Additive service-only contracts. No inventory, price, financing formula or historical lead rewrite.
CREATE OR REPLACE FUNCTION public.ensure_bia_lead_v1(p_slug text,p_session_token_hash text,p_fingerprint_hash text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s crm_private.public_agent_sessions%rowtype; linked jsonb; old_stage text;
BEGIN
 PERFORM crm_private.assert_public_agent_service_role();
 SELECT x.* INTO s FROM crm_private.public_agent_sessions x JOIN crm_private.public_agent_experiences e ON e.id=x.experience_id
 WHERE e.slug=lower(trim(p_slug)) AND e.active AND x.session_token_hash=p_session_token_hash AND x.fingerprint_hash=p_fingerprint_hash FOR UPDATE OF x;
 IF NOT FOUND OR s.status IN ('closed','blocked') OR s.expires_at<=now() THEN RAISE EXCEPTION 'PUBLIC_AGENT_SESSION_INACTIVE'; END IF;
 IF s.crm_record_id IS NOT NULL THEN RETURN jsonb_build_object('linked',true,'idempotent',true); END IF;
 IF length(trim(coalesce(s.contact_capture->>'name','')))<2 OR coalesce(s.contact_capture->>'phone','')!~'^[+][1-9][0-9]{7,14}$'
    OR s.contact_consent_at IS NULL OR s.consent_copy_version='service_contact_declined_v1' THEN
   RETURN jsonb_build_object('linked',false,'needs','nome_e_telefone');
 END IF;
 old_stage:=s.stage;
 linked:=public.convert_public_agent_lead(p_slug,p_session_token_hash,p_fingerprint_hash,s.contact_capture->>'name',s.contact_capture->>'phone',
   s.contact_capture->>'email',s.contact_capture->>'city',s.marketing_consent,
   s.captured_profile||jsonb_build_object('summary','Atendimento da Bia, especialista da Futura Casa, parceira da Évora Urbanismo.'));
 -- Linking is not completion of the conversation or acceptance of any commercial proposal.
 UPDATE crm_private.public_agent_sessions SET stage=CASE WHEN old_stage IN ('welcome','contact','completed') THEN 'discovery' ELSE old_stage END WHERE id=s.id;
 RETURN jsonb_build_object('linked',true,'idempotent',coalesce((linked->>'idempotent')::boolean,false));
END $$;
REVOKE ALL ON FUNCTION public.ensure_bia_lead_v1(text,text,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_bia_lead_v1(text,text,text) TO service_role;

CREATE OR REPLACE FUNCTION public.finish_bia_turn_v1(p_slug text,p_session_token_hash text,p_fingerprint_hash text,p_client_request_id uuid,p_lease_token uuid,p_payload jsonb,p_response jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s crm_private.public_agent_sessions%rowtype; r crm_private.public_agent_requests%rowtype; meta jsonb; result jsonb; profile jsonb; stage text; turn jsonb; rich jsonb; e crm_private.public_agent_experiences%rowtype;
BEGIN
 PERFORM crm_private.assert_public_agent_service_role();
 IF p_response IS NULL OR jsonb_typeof(p_response)<>'object' OR pg_column_size(p_response)>32768
    OR p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' OR coalesce(char_length(trim(p_payload->>'message')),0) NOT BETWEEN 1 AND 800
    OR coalesce(char_length(trim(p_response->>'reply')),0) NOT BETWEEN 1 AND 1200 THEN RAISE EXCEPTION 'PUBLIC_AGENT_GATEWAY_TURN_INVALID'; END IF;
 SELECT x.* INTO s FROM crm_private.public_agent_sessions x JOIN crm_private.public_agent_experiences ex ON ex.id=x.experience_id
 WHERE ex.slug=lower(trim(p_slug)) AND ex.active AND x.session_token_hash=p_session_token_hash AND x.fingerprint_hash=p_fingerprint_hash FOR UPDATE OF x;
 IF NOT FOUND OR s.status IN ('closed','blocked') OR s.expires_at<=now() THEN RAISE EXCEPTION 'PUBLIC_AGENT_SESSION_INACTIVE'; END IF;
 SELECT * INTO r FROM crm_private.public_agent_requests WHERE session_id=s.id AND client_request_id=p_client_request_id FOR UPDATE;
 IF NOT FOUND OR r.request_kind<>'message' THEN RAISE EXCEPTION 'PUBLIC_AGENT_REQUEST_NOT_FOUND'; END IF;
 IF r.payload_hash<>encode(extensions.digest(convert_to(p_payload::text,'UTF8'),'sha256'),'hex') THEN RAISE EXCEPTION 'PUBLIC_AGENT_IDEMPOTENCY_CONFLICT'; END IF;
 IF r.status='succeeded' THEN RETURN r.response; END IF;
 IF r.status<>'processing' OR r.lease_token IS DISTINCT FROM p_lease_token OR r.lease_expires_at<=now() THEN RAISE EXCEPTION 'PUBLIC_AGENT_STALE_LEASE'; END IF;
 SELECT * INTO e FROM crm_private.public_agent_experiences WHERE id=s.experience_id;
 profile:=s.captured_profile||CASE WHEN jsonb_typeof(p_response->'profile')='object' THEN p_response->'profile' ELSE '{}'::jsonb END;
 stage:=coalesce(p_response->>'stage','discovery');
 rich:=jsonb_strip_nulls(jsonb_build_object('action',p_response->>'action','selectedUnitCode',p_response->>'selectedUnitCode','quickReplies',p_response->'quickReplies',
   'simulation',CASE WHEN jsonb_typeof(p_response->'simulation')='object' THEN p_response->'simulation' END,
   'commercial',CASE WHEN jsonb_typeof(p_response->'commercial')='object' THEN p_response->'commercial' END,
   'attachments',CASE WHEN jsonb_typeof(p_response->'attachments')='array' THEN p_response->'attachments' END,
   'visit',p_response->'visit','followup',p_response->'followup'));
 meta:=jsonb_build_object('public_response',rich,'gateway_deterministic',false,'bia_request_id',p_client_request_id,'runtime_contract','bia-professional-v5');
 -- Preserve the calculation before optional inventory cards when reaching the existing message budget.
 IF pg_column_size(meta)>8000 THEN meta:=jsonb_set(meta,'{public_response}',rich-'commercial'); END IF;
 IF pg_column_size(meta)>8192 THEN RAISE EXCEPTION 'PUBLIC_AGENT_GATEWAY_RESPONSE_INVALID'; END IF;
 turn:=public.append_public_agent_turn(p_slug,p_session_token_hash,p_fingerprint_hash,p_payload->>'message',p_response->>'reply',stage,profile,meta);
 SELECT * INTO s FROM crm_private.public_agent_sessions WHERE id=s.id;
 result:=p_response||jsonb_build_object('status','completed','profile',s.captured_profile,'contactCapture',s.contact_capture,'serviceConsented',s.contact_consent_at IS NOT NULL,
   'marketingConsented',s.marketing_consent,'converted',s.crm_record_id IS NOT NULL,'leadProtocol',CASE WHEN s.crm_record_id IS NOT NULL THEN upper(left(replace(s.crm_record_id::text,'-',''),10)) END);
 IF s.crm_record_id IS NOT NULL AND jsonb_typeof(p_response->'simulation')='object' THEN
  INSERT INTO public.crm_opportunity_events(organization_id,crm_record_id,opportunity_key,contact_id,project_id,product_id,actor_type,event_type,event_source,channel,idempotency_key,correlation_id,data)
  VALUES(s.organization_id,s.crm_record_id,s.crm_record_id,s.contact_id,e.project_id,e.product_id,'ai','simulation.presented','integration','site',
    'bia:simulation:'||p_client_request_id::text,'bia:'||s.id::text,jsonb_build_object('simulation',p_response->'simulation','status','indicativa','public_agent_session_id',s.id))
  ON CONFLICT(organization_id,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;
 END IF;
 UPDATE crm_private.public_agent_requests SET status='succeeded',response=result,completed_at=now(),lease_expires_at=now(),error_code=NULL,updated_at=now() WHERE id=r.id;
 INSERT INTO crm_private.public_agent_gateway_requests(session_id,client_request_id,response) VALUES(s.id,p_client_request_id,result)
 ON CONFLICT(session_id,client_request_id) DO NOTHING;
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION public.finish_bia_turn_v1(text,text,text,uuid,uuid,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finish_bia_turn_v1(text,text,text,uuid,uuid,jsonb,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.record_bia_followup_v1(p_slug text,p_session_token_hash text,p_fingerprint_hash text,p_client_request_id uuid,p_kind text,p_unit_code text DEFAULT NULL,p_simulation jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s crm_private.public_agent_sessions%rowtype; lead public.crm_records%rowtype; a public.crm_actions%rowtype;
BEGIN
 PERFORM crm_private.assert_public_agent_service_role();
 IF p_kind IS NULL OR p_kind NOT IN ('proposal_review','human_request') OR p_client_request_id IS NULL OR (p_simulation IS NOT NULL AND (jsonb_typeof(p_simulation)<>'object' OR pg_column_size(p_simulation)>8192)) THEN RAISE EXCEPTION 'PUBLIC_AGENT_INPUT_INVALID'; END IF;
 SELECT x.* INTO s FROM crm_private.public_agent_sessions x JOIN crm_private.public_agent_experiences e ON e.id=x.experience_id WHERE e.slug=lower(trim(p_slug)) AND e.active
 AND x.session_token_hash=p_session_token_hash AND x.fingerprint_hash=p_fingerprint_hash FOR UPDATE OF x;
 IF NOT FOUND OR s.status IN ('closed','blocked') OR s.expires_at<=now() THEN RAISE EXCEPTION 'PUBLIC_AGENT_SESSION_INACTIVE'; END IF;
 IF s.crm_record_id IS NULL THEN RETURN jsonb_build_object('recorded',false,'needs','nome_e_telefone'); END IF;
 SELECT * INTO lead FROM public.crm_records WHERE id=s.crm_record_id AND organization_id=s.organization_id FOR UPDATE;
 IF NOT FOUND OR lead.record_status='arquivada' THEN RAISE EXCEPTION 'PUBLIC_AGENT_CRM_UNAVAILABLE'; END IF;
 SELECT * INTO a FROM public.crm_actions WHERE organization_id=s.organization_id AND crm_record_id=s.crm_record_id
   AND metadata->>'bia_request_id'=p_client_request_id::text AND metadata->>'request_kind'=p_kind LIMIT 1;
 IF FOUND THEN RETURN jsonb_build_object('recorded',true,'id',a.id,'status','pendente','approved',false,'idempotent',true); END IF;
 INSERT INTO public.crm_actions(organization_id,crm_record_id,action_type,subject,action_status,scheduled_at,channel,assigned_to,notes,metadata)
 VALUES(s.organization_id,s.crm_record_id,CASE WHEN p_kind='proposal_review' THEN 'proposta' ELSE 'tarefa' END,
   CASE WHEN p_kind='proposal_review' THEN 'Bia · Solicitação de proposta para revisão' ELSE 'Bia · Atendimento humano solicitado' END,
   'pendente',now()+interval '1 hour','interno',coalesce(lead.broker_user_id,lead.owner_user_id,lead.sdr_user_id),
   'Solicitação registrada pela Bia, da Futura Casa. Não representa aprovação, aceite, reserva ou envio externo.',
   jsonb_strip_nulls(jsonb_build_object('source','bia','bia_request_id',p_client_request_id,'request_kind',p_kind,'unit_code',p_unit_code,'simulation',p_simulation,'no_external_delivery',true))) RETURNING * INTO a;
 UPDATE public.crm_records SET next_action_at=least(coalesce(next_action_at,a.scheduled_at),a.scheduled_at),updated_at=now() WHERE id=lead.id;
 RETURN jsonb_build_object('recorded',true,'id',a.id,'status','pendente','approved',false,'idempotent',false);
END $$;
REVOKE ALL ON FUNCTION public.record_bia_followup_v1(text,text,text,uuid,text,text,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.record_bia_followup_v1(text,text,text,uuid,text,text,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.schedule_bia_visit_v2(p_slug text,p_session_token_hash text,p_fingerprint_hash text,p_client_action_id uuid,p_scheduled_at timestamptz,p_unit_code text DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s crm_private.public_agent_sessions%rowtype; lead public.crm_records%rowtype; a public.crm_actions%rowtype; broker uuid; calendar_id uuid; visit_end timestamptz; busy boolean; pending boolean:=false; note text;
BEGIN
 PERFORM crm_private.assert_public_agent_service_role();
 IF p_client_action_id IS NULL OR p_scheduled_at IS NULL OR p_scheduled_at<=now()+interval '15 minutes' OR p_scheduled_at>now()+interval '180 days' THEN RAISE EXCEPTION 'PUBLIC_AGENT_VISIT_INPUT_INVALID'; END IF;
 SELECT x.* INTO s FROM crm_private.public_agent_sessions x JOIN crm_private.public_agent_experiences e ON e.id=x.experience_id WHERE e.slug=lower(trim(p_slug)) AND e.active
 AND x.session_token_hash=p_session_token_hash AND x.fingerprint_hash=p_fingerprint_hash FOR UPDATE OF x;
 IF NOT FOUND OR s.status IN ('closed','blocked') OR s.expires_at<=now() THEN RAISE EXCEPTION 'PUBLIC_AGENT_SESSION_INACTIVE'; END IF;
 IF s.crm_record_id IS NULL THEN RETURN jsonb_build_object('scheduled',false,'needs','nome_e_telefone'); END IF;
 SELECT * INTO lead FROM public.crm_records WHERE id=s.crm_record_id AND organization_id=s.organization_id FOR UPDATE;
 IF NOT FOUND OR lead.record_status='arquivada' THEN RAISE EXCEPTION 'PUBLIC_AGENT_CRM_UNAVAILABLE'; END IF;
 SELECT * INTO a FROM public.crm_actions WHERE organization_id=s.organization_id AND crm_record_id=s.crm_record_id AND metadata->>'public_agent_visit_action_id'=p_client_action_id::text LIMIT 1;
 IF FOUND THEN RETURN jsonb_build_object('scheduled',a.metadata ? 'calendar_user_activity_id','requested',true,'id',a.id,'scheduledAt',a.scheduled_at,'idempotent',true,'status',CASE WHEN a.metadata ? 'calendar_user_activity_id' THEN 'agendada' ELSE 'aguardando_equipe' END); END IF;
 IF p_unit_code IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.crm_inventory_units u WHERE u.organization_id=s.organization_id AND u.project_id=lead.project_id AND u.unit_code=upper(trim(p_unit_code)) AND u.active) THEN RAISE EXCEPTION 'PUBLIC_AGENT_UNIT_CODE_INVALID'; END IF;
 broker:=lead.broker_user_id;
 IF broker IS NULL OR NOT EXISTS(SELECT 1 FROM public.organization_members m WHERE m.organization_id=s.organization_id AND m.user_id=broker AND m.active AND (lower(m.role)='corretor' OR EXISTS(SELECT 1 FROM public.crm_team_members tm JOIN public.crm_teams t ON t.id=tm.team_id AND t.organization_id=tm.organization_id WHERE tm.organization_id=s.organization_id AND tm.user_id=broker AND tm.active AND t.active AND (lower(t.team_type) IN ('corretor','corretores','vendas','comercial') OR lower(tm.team_role) LIKE '%corretor%')))) THEN pending:=true; END IF;
 -- Respect existing published workday, do not silently invent availability outside it.
 IF (p_scheduled_at AT TIME ZONE 'America/Sao_Paulo')::time < time '08:00' OR (p_scheduled_at AT TIME ZONE 'America/Sao_Paulo')::time > time '17:00' THEN pending:=true; END IF;
 visit_end:=p_scheduled_at+interval '60 minutes';
 IF NOT pending THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(s.organization_id::text||':'||broker::text,0));
  SELECT EXISTS(SELECT 1 FROM (
   SELECT x.starts_at,CASE WHEN x.due_at>x.starts_at THEN x.due_at ELSE x.starts_at+make_interval(mins=>greatest(coalesce(x.estimated_minutes,60),15)) END AS ends_at
   FROM public.user_activities x WHERE x.organization_id=s.organization_id AND x.owner_user_id=broker AND x.starts_at IS NOT NULL AND x.board_status<>'concluida' AND x.status<>'cancelada'
     AND (x.activity_type IN ('visita','reuniao','indisponibilidade','bloqueio_agenda') OR x.tags && ARRAY['agenda-bloqueio','indisponibilidade']::text[])
   UNION ALL SELECT x.scheduled_at,x.scheduled_at+make_interval(mins=>greatest(coalesce(x.duration_minutes,60),15)) FROM public.crm_actions x
   WHERE x.organization_id=s.organization_id AND x.assigned_to=broker AND x.action_status='pendente' AND (x.action_type IN ('visita','reuniao') OR x.outcome='visita_agendada') AND NOT(x.metadata ? 'calendar_user_activity_id')
  ) z WHERE z.starts_at<visit_end AND z.ends_at>p_scheduled_at) INTO busy;
  IF busy THEN RETURN jsonb_build_object('scheduled',false,'requested',false,'reason','horario_indisponivel','needs','outro_horario'); END IF;
 END IF;
 note:=CASE WHEN pending THEN 'Solicitação de visita: aguarda definição/validação de corretor e horário. Não confirmada ao cliente.' ELSE 'Visita registrada pela Bia, especialista da Futura Casa, parceira da Évora Urbanismo.' END;
 INSERT INTO public.crm_actions(organization_id,crm_record_id,action_type,subject,scheduled_at,action_status,notes,channel,duration_minutes,assigned_to,metadata)
 VALUES(s.organization_id,s.crm_record_id,CASE WHEN pending THEN 'tarefa' ELSE 'visita' END,CASE WHEN pending THEN 'Bia · Solicitação de visita — validar agenda' ELSE 'Bia · Visita agendada' END,
   p_scheduled_at,'pendente',note,'site',60,coalesce(broker,lead.owner_user_id,lead.sdr_user_id),jsonb_strip_nulls(jsonb_build_object('source','bia','request_kind','visit','public_agent_session_id',s.id,'public_agent_visit_action_id',p_client_action_id,'unit_code',p_unit_code,'requested_at',p_scheduled_at,'no_external_delivery',true))) RETURNING * INTO a;
 IF NOT pending THEN
  INSERT INTO public.user_activities(organization_id,owner_user_id,title,description,activity_type,status,board_status,priority,starts_at,due_at,related_type,related_id,project_id,tags,estimated_minutes)
  VALUES(s.organization_id,broker,'Visita com '||coalesce(lead.person_name,'cliente'),note,'visita','pendente','backlog','alta',p_scheduled_at,visit_end,'crm_actions',a.id,lead.project_id,ARRAY['crm','agenda-bloqueio','corretor','visita']::text[],60) RETURNING id INTO calendar_id;
  UPDATE public.crm_actions SET metadata=metadata||jsonb_build_object('calendar_user_activity_id',calendar_id) WHERE id=a.id;
 END IF;
 UPDATE public.crm_records SET next_action_at=least(coalesce(next_action_at,p_scheduled_at),p_scheduled_at),updated_at=now() WHERE id=lead.id;
 DELETE FROM crm_private.public_agent_visit_state WHERE session_id=s.id;
 RETURN jsonb_build_object('scheduled',NOT pending,'requested',true,'id',a.id,'calendarActivityId',calendar_id,'scheduledAt',p_scheduled_at,'timezone','America/Sao_Paulo','status',CASE WHEN pending THEN 'aguardando_equipe' ELSE 'agendada' END);
END $$;
REVOKE ALL ON FUNCTION public.schedule_bia_visit_v2(text,text,text,uuid,timestamptz,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.schedule_bia_visit_v2(text,text,text,uuid,timestamptz,text) TO service_role;

-- Voluntary operational contact never overrides an explicit refusal or opts into marketing.
CREATE OR REPLACE FUNCTION crm_private.apply_public_agent_implicit_service_contact()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE new_phone text; old_phone text; new_name text;
BEGIN
 new_phone:=nullif(trim(coalesce(new.contact_capture->>'phone','')),'');
 new_name:=nullif(trim(coalesce(new.contact_capture->>'name','')),'');
 IF tg_op='UPDATE' THEN old_phone:=nullif(trim(coalesce(old.contact_capture->>'phone','')),''); END IF;
 new.captured_profile:=coalesce(new.captured_profile,'{}'::jsonb)||jsonb_build_object('contact_name_captured',new_name IS NOT NULL,'contact_phone_captured',new_phone IS NOT NULL);
 IF new.consent_copy_version='service_contact_declined_v1' THEN new.contact_consent_at:=NULL;
 ELSIF new_phone IS NOT NULL AND (tg_op='INSERT' OR old_phone IS NULL) AND new.contact_consent_at IS NULL THEN
  new.contact_consent_at:=now();
  IF nullif(trim(coalesce(new.consent_copy_version,'')),'') IS NULL THEN new.consent_copy_version:='implicit_service_contact_v1'; END IF;
 END IF;
 RETURN new;
END $$;
REVOKE ALL ON FUNCTION crm_private.apply_public_agent_implicit_service_contact() FROM PUBLIC,anon,authenticated;
