begin;

-- Additive rollout: existing gateways continue to work until the new runtime is deployed.
create or replace function public.get_bia_turn_context_v1(p_slug text, p_session_token_hash text, p_fingerprint_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare c jsonb; g jsonb; last_simulation jsonb;
begin
  perform crm_private.assert_public_agent_service_role();
  c := public.get_public_agent_v3_context(p_slug,p_session_token_hash,p_fingerprint_hash);
  g := public.get_public_agent_gateway_context_v1(p_slug,p_session_token_hash,p_fingerprint_hash);
  select r.response->'simulation' into last_simulation
  from crm_private.public_agent_gateway_requests r
  where r.session_id=(c->>'sessionId')::uuid and jsonb_typeof(r.response->'simulation')='object'
  order by r.created_at desc limit 1;
  return jsonb_build_object('context',c,'gateway',g,'now',clock_timestamp(),
    'timezone','America/Sao_Paulo','lastSimulation',last_simulation);
end $$;

create or replace function public.sync_bia_contact_lead_v1(p_slug text, p_session_token_hash text, p_fingerprint_hash text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s crm_private.public_agent_sessions%rowtype; result jsonb; old_stage text;
begin
  perform crm_private.assert_public_agent_service_role();
  select session.* into s from crm_private.public_agent_sessions session
  join crm_private.public_agent_experiences e on e.id=session.experience_id
  where e.slug=lower(trim(p_slug)) and e.active and session.session_token_hash=p_session_token_hash
    and session.fingerprint_hash=p_fingerprint_hash for update of session;
  if not found or s.status in ('closed','blocked') or s.expires_at<=now() then
    raise exception 'PUBLIC_AGENT_SESSION_INACTIVE';
  end if;
  if s.crm_record_id is null and char_length(trim(coalesce(s.contact_capture->>'name',''))) between 2 and 180
    and coalesce(s.contact_capture->>'phone','') ~ '^[+][1-9][0-9]{7,14}$'
    and s.contact_consent_at is not null then
    old_stage := s.stage;
    result := public.convert_public_agent_lead(p_slug,p_session_token_hash,p_fingerprint_hash,
      s.contact_capture->>'name',s.contact_capture->>'phone',s.contact_capture->>'email',
      s.contact_capture->>'city',coalesce(s.marketing_consent,false),
      s.captured_profile||jsonb_build_object('summary','Atendimento da Bia, especialista da Futura Casa, parceira da Évora Urbanismo.'));
    -- Identifying a visitor does not end the AI conversation or claim a completed sale.
    update crm_private.public_agent_sessions set stage=case when old_stage in ('welcome','contact','completed') then 'discovery' else old_stage end
    where id=s.id;
    update public.crm_records set tags=array_replace(tags,'vitoria','bia'), updated_at=now()
    where id=(result->>'crmRecordId')::uuid and organization_id=s.organization_id;
  end if;
  return public.get_public_agent_gateway_context_v1(p_slug,p_session_token_hash,p_fingerprint_hash);
end $$;

create or replace function public.finish_bia_turn_v1(
  p_slug text,p_session_token_hash text,p_fingerprint_hash text,p_client_request_id uuid,
  p_lease_token uuid,p_payload jsonb,p_response jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s crm_private.public_agent_sessions%rowtype; r crm_private.public_agent_requests%rowtype;
  m crm_private.public_agent_messages%rowtype; result jsonb; rich jsonb; meta jsonb; trace jsonb;
  digest_value text; event_key text;
begin
  perform crm_private.assert_public_agent_service_role();
  if p_payload is null or jsonb_typeof(p_payload)<>'object' or pg_column_size(p_payload)>65536
    or p_response is null or jsonb_typeof(p_response)<>'object' or pg_column_size(p_response)>16384 then
    raise exception 'PUBLIC_AGENT_GATEWAY_TURN_INVALID';
  end if;
  select session.* into s from crm_private.public_agent_sessions session
  join crm_private.public_agent_experiences e on e.id=session.experience_id
  where e.slug=lower(trim(p_slug)) and e.active and session.session_token_hash=p_session_token_hash
    and session.fingerprint_hash=p_fingerprint_hash for update of session;
  if not found or s.status in ('closed','blocked') or s.expires_at<=now() then
    raise exception 'PUBLIC_AGENT_SESSION_INACTIVE';
  end if;
  select * into r from crm_private.public_agent_requests
  where session_id=s.id and client_request_id=p_client_request_id for update;
  digest_value:=encode(extensions.digest(convert_to(p_payload::text,'UTF8'),'sha256'),'hex');
  if not found or r.request_kind<>'message' then raise exception 'PUBLIC_AGENT_REQUEST_NOT_FOUND'; end if;
  if r.payload_hash<>digest_value then raise exception 'PUBLIC_AGENT_IDEMPOTENCY_CONFLICT'; end if;
  if r.status='succeeded' then return r.response; end if;
  if r.status<>'processing' or r.lease_token is distinct from p_lease_token or r.lease_expires_at<=now() then
    raise exception 'PUBLIC_AGENT_STALE_LEASE';
  end if;

  result:=public.commit_public_agent_gateway_turn_v1(p_slug,p_session_token_hash,p_fingerprint_hash,
    p_client_request_id,p_payload->>'message',p_response,null,'{}'::jsonb,null,null,null);
  select * into s from crm_private.public_agent_sessions where id=s.id;
  result:=result||jsonb_build_object('contactCapture',s.contact_capture,'serviceConsented',s.contact_consent_at is not null,
    'marketingConsented',s.marketing_consent,'converted',s.crm_record_id is not null,'profile',s.captured_profile,
    'leadProtocol',case when s.crm_record_id is not null then upper(left(replace(s.crm_record_id::text,'-',''),10)) else null end);
  trace:=case when jsonb_typeof(result->'metadata')='object' then result->'metadata' else '{}'::jsonb end;
  trace:=jsonb_strip_nulls(jsonb_build_object('runtime_contract',trace->>'runtime_contract','trace_id',trace->>'trace_id',
    'openai_request_id',trace->>'openai_request_id','tool_calls',trace->'tool_calls','tool_rounds',trace->'tool_rounds',
    'tool_errors',trace->'tool_errors','elapsed_ms',trace->'elapsed_ms'));
  rich:=jsonb_strip_nulls(jsonb_build_object('action',result->'action','selectedUnitCode',result->'selectedUnitCode',
    'quickReplies',result->'quickReplies','simulation',nullif(result->'simulation','null'::jsonb),
    'visit',nullif(result->'visit','null'::jsonb),'handoff',nullif(result->'handoff','null'::jsonb),
    'attachments',result->'attachments','commercial',nullif(result->'commercial','null'::jsonb)));
  meta:=jsonb_build_object('public_response',rich,'ai_first',true,'gateway_deterministic',false,
    'client_request_id',p_client_request_id,'runtime',trace);
  -- Financial snapshots and operation receipts have priority over redundant inventory cards.
  if pg_column_size(meta)>8192 then rich:=rich-'commercial'; meta:=jsonb_set(meta,'{public_response}',rich); end if;
  if pg_column_size(meta)>8192 then raise exception 'PUBLIC_AGENT_GATEWAY_SNAPSHOT_TOO_LARGE'; end if;
  select * into m from crm_private.public_agent_messages where session_id=s.id and direction='assistant'
  order by created_at desc,id desc limit 1;
  if m.id is null then raise exception 'PUBLIC_AGENT_GATEWAY_MESSAGE_MISSING'; end if;
  update crm_private.public_agent_messages set metadata=meta where id=m.id and session_id=s.id;
  if s.crm_record_id is not null then
    update public.crm_messages set metadata=jsonb_build_object('public_agent_session_id',s.id)||meta
    where organization_id=s.organization_id and crm_record_id=s.crm_record_id and direction='outbound'
      and actor_type='ai' and occurred_at=m.created_at and metadata->>'public_agent_session_id'=s.id::text;
    if jsonb_typeof(result->'simulation')='object' then
      event_key:='bia:simulation:'||s.id::text||':'||p_client_request_id::text;
      insert into public.crm_opportunity_events(organization_id,crm_record_id,opportunity_key,contact_id,
        actor_type,event_type,event_source,channel,occurred_at,idempotency_key,correlation_id,data)
      values(s.organization_id,s.crm_record_id,s.crm_record_id,s.contact_id,'ai','commercial.simulation_created','api','site',
        now(),event_key,'bia:'||p_client_request_id::text,jsonb_build_object('simulation',result->'simulation',
        'public_agent_session_id',s.id,'not_a_binding_proposal',true))
      on conflict(organization_id,idempotency_key) where idempotency_key is not null do nothing;
    end if;
  end if;
  update crm_private.public_agent_gateway_requests set response=result
  where session_id=s.id and client_request_id=p_client_request_id;
  update crm_private.public_agent_requests set status='succeeded',response=result,completed_at=now(),
    lease_expires_at=now(),error_code=null,updated_at=now() where id=r.id;
  return result;
end $$;

create or replace function public.request_bia_handoff_v1(p_slug text,p_session_token_hash text,p_fingerprint_hash text,
  p_client_action_id uuid,p_reason text,p_kind text default 'human')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s crm_private.public_agent_sessions%rowtype; lead public.crm_records%rowtype; a public.crm_actions%rowtype; g jsonb;
begin
  perform crm_private.assert_public_agent_service_role();
  if p_client_action_id is null or p_kind not in ('human','proposal') then raise exception 'PUBLIC_AGENT_INPUT_INVALID'; end if;
  g:=public.sync_bia_contact_lead_v1(p_slug,p_session_token_hash,p_fingerprint_hash);
  select * into s from crm_private.public_agent_sessions where id=(g->>'sessionId')::uuid for update;
  if s.crm_record_id is null then return jsonb_build_object('requested',false,'needs','name_and_phone'); end if;
  select * into lead from public.crm_records where id=s.crm_record_id and organization_id=s.organization_id for update;
  if not found or lead.record_status='arquivada' then return jsonb_build_object('requested',false,'reason','LEAD_UNAVAILABLE'); end if;
  if exists(select 1 from public.contacts where id=s.contact_id and organization_id=s.organization_id and do_not_contact_at is not null) then
    return jsonb_build_object('requested',false,'reason','CONTACT_REVIEW_REQUIRED');
  end if;
  select * into a from public.crm_actions where organization_id=s.organization_id and crm_record_id=s.crm_record_id
    and metadata->>'bia_action_id'=p_client_action_id::text and metadata->>'bia_action_kind'=p_kind limit 1;
  if not found then
    insert into public.crm_actions(organization_id,crm_record_id,action_type,subject,scheduled_at,action_status,notes,channel,assigned_to,metadata)
    values(s.organization_id,s.crm_record_id,case when p_kind='proposal' then 'proposta' else 'tarefa' end,
      case when p_kind='proposal' then 'Preparar proposta solicitada à Bia' else 'Atendimento humano solicitado à Bia' end,
      now()+interval '30 minutes','pendente',left(coalesce(p_reason,'Solicitação feita no atendimento da Futura Casa.'),1000),
      'interno',coalesce(lead.broker_user_id,lead.sdr_user_id,lead.owner_user_id),
      jsonb_build_object('bia_action_id',p_client_action_id,'bia_action_kind',p_kind,'source','bia',
        'public_agent_session_id',s.id,'external_message_sent',false)) returning * into a;
  end if;
  return jsonb_build_object('requested',true,'actionId',a.id,'kind',p_kind,'status','pending_team',
    'leadProtocol',g->>'leadProtocol','externalMessageSent',false);
end $$;

create or replace function public.schedule_bia_visit_v2(p_slug text,p_session_token_hash text,p_fingerprint_hash text,
  p_client_action_id uuid,p_scheduled_at timestamptz,p_unit_code text default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  s crm_private.public_agent_sessions%rowtype; lead public.crm_records%rowtype; e crm_private.public_agent_experiences%rowtype;
  a public.crm_actions%rowtype; broker uuid; ending timestamptz; calendar_id uuid; result jsonb; g jsonb; conflict_found boolean;
begin
  perform crm_private.assert_public_agent_service_role();
  if p_client_action_id is null or p_scheduled_at is null or p_scheduled_at<=now()+interval '15 minutes'
    or p_scheduled_at>now()+interval '180 days' then raise exception 'PUBLIC_AGENT_VISIT_INPUT_INVALID'; end if;
  g:=public.sync_bia_contact_lead_v1(p_slug,p_session_token_hash,p_fingerprint_hash);
  select * into s from crm_private.public_agent_sessions where id=(g->>'sessionId')::uuid for update;
  if s.crm_record_id is null then return jsonb_build_object('scheduled',false,'needs','name_and_phone'); end if;
  select * into lead from public.crm_records where id=s.crm_record_id and organization_id=s.organization_id for update;
  if not found or lead.record_status='arquivada' then return jsonb_build_object('scheduled',false,'reason','LEAD_UNAVAILABLE'); end if;
  if exists(select 1 from public.contacts where id=s.contact_id and organization_id=s.organization_id and do_not_contact_at is not null) then
    return jsonb_build_object('scheduled',false,'reason','CONTACT_REVIEW_REQUIRED');
  end if;
  select * into e from crm_private.public_agent_experiences where id=s.experience_id;
  if p_unit_code is not null and not exists(select 1 from public.crm_inventory_units
    where organization_id=s.organization_id and project_id=e.project_id and active and unit_code=upper(trim(p_unit_code))) then
    return jsonb_build_object('scheduled',false,'reason','UNIT_NOT_FOUND');
  end if;
  select * into a from public.crm_actions where organization_id=s.organization_id and crm_record_id=s.crm_record_id
    and metadata->>'public_agent_visit_action_id'=p_client_action_id::text order by created_at desc limit 1;
  if found and a.metadata ? 'calendar_user_activity_id' then
    return jsonb_build_object('scheduled',true,'id',a.id,'scheduledAt',a.scheduled_at,
      'unitCode',a.metadata->>'unit_code','calendarActivityId',a.metadata->>'calendar_user_activity_id','idempotent',true);
  end if;
  broker:=coalesce(lead.broker_user_id,lead.sdr_user_id,lead.owner_user_id,e.fallback_owner_user_id);
  if broker is null or not exists(select 1 from public.organization_members member
    where member.organization_id=s.organization_id and member.user_id=broker and member.active and
    (lower(member.role)='corretor' or exists(select 1 from public.crm_team_members tm join public.crm_teams t
      on t.id=tm.team_id and t.organization_id=tm.organization_id where tm.organization_id=s.organization_id
      and tm.user_id=broker and tm.active and t.active
      and (lower(t.team_type) in ('corretor','corretores','vendas','comercial') or lower(tm.team_role) like '%corretor%')))) then
    return jsonb_build_object('scheduled',false,'reason','BROKER_REQUIRED','requestedAt',p_scheduled_at,
      'handoff',public.request_bia_handoff_v1(p_slug,p_session_token_hash,p_fingerprint_hash,p_client_action_id,
        'Definir corretor e confirmar visita solicitada para '||to_char(p_scheduled_at at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI'),'human'));
  end if;
  ending:=p_scheduled_at+interval '60 minutes';
  perform pg_advisory_xact_lock(hashtextextended(s.organization_id::text||':'||broker::text,0));
  select exists(select 1 from (
    select ua.starts_at,case when ua.due_at>ua.starts_at then ua.due_at
      else ua.starts_at+make_interval(mins=>greatest(coalesce(ua.estimated_minutes,60),15)) end ends_at
    from public.user_activities ua where ua.organization_id=s.organization_id and ua.owner_user_id=broker
      and ua.starts_at is not null and ua.board_status<>'concluida' and ua.status<>'cancelada'
      and (ua.activity_type in ('visita','reuniao','indisponibilidade','bloqueio_agenda') or ua.tags && array['agenda-bloqueio','indisponibilidade']::text[])
    union all
    select ca.scheduled_at,ca.scheduled_at+make_interval(mins=>greatest(coalesce(ca.duration_minutes,60),15))
    from public.crm_actions ca where ca.organization_id=s.organization_id and ca.assigned_to=broker
      and ca.action_status='pendente' and ca.scheduled_at is not null
      and (ca.action_type in ('visita','reuniao') or ca.outcome='visita_agendada')
      and not(ca.metadata ? 'calendar_user_activity_id') and (a.id is null or ca.id<>a.id)
  ) occupied where occupied.starts_at<ending and occupied.ends_at>p_scheduled_at) into conflict_found;
  if conflict_found then return jsonb_build_object('scheduled',false,'reason','SCHEDULE_CONFLICT','needs','another_date_and_time'); end if;
  result:=public.schedule_public_agent_visit_v1(p_slug,p_session_token_hash,p_fingerprint_hash,p_client_action_id,p_scheduled_at,p_unit_code);
  insert into public.user_activities(organization_id,owner_user_id,title,description,activity_type,status,board_status,priority,
    starts_at,due_at,related_type,related_id,project_id,tags,estimated_minutes,progress_percent,reminders)
  values(s.organization_id,broker,'Visita ao '||e.name||' · '||coalesce(lead.person_name,'Cliente'),
    'Agendada pela Bia, especialista da Futura Casa, parceira da Évora Urbanismo.','visita','pendente','backlog','alta',
    (result->>'scheduledAt')::timestamptz,(result->>'scheduledAt')::timestamptz+interval '60 minutes','crm_actions',(result->>'id')::uuid,
    e.project_id,array['crm','bia','agenda-bloqueio','visita']::text[],60,0,
    jsonb_build_array(jsonb_build_object('offset_minutes',60),jsonb_build_object('offset_minutes',15))) returning id into calendar_id;
  update public.crm_actions set assigned_to=broker,notes='Visita agendada pela Bia, especialista da Futura Casa, parceira da Évora Urbanismo.',
    metadata=metadata||jsonb_build_object('calendar_user_activity_id',calendar_id,'calendar_managed',true,'source','bia')
    where id=(result->>'id')::uuid and organization_id=s.organization_id;
  return result||jsonb_build_object('scheduled',true,'calendarActivityId',calendar_id,'timezone','America/Sao_Paulo');
end $$;

revoke all on function public.get_bia_turn_context_v1(text,text,text) from public,anon,authenticated;
revoke all on function public.sync_bia_contact_lead_v1(text,text,text) from public,anon,authenticated;
revoke all on function public.finish_bia_turn_v1(text,text,text,uuid,uuid,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.request_bia_handoff_v1(text,text,text,uuid,text,text) from public,anon,authenticated;
revoke all on function public.schedule_bia_visit_v2(text,text,text,uuid,timestamptz,text) from public,anon,authenticated;
grant execute on function public.get_bia_turn_context_v1(text,text,text) to service_role;
grant execute on function public.sync_bia_contact_lead_v1(text,text,text) to service_role;
grant execute on function public.finish_bia_turn_v1(text,text,text,uuid,uuid,jsonb,jsonb) to service_role;
grant execute on function public.request_bia_handoff_v1(text,text,text,uuid,text,text) to service_role;
grant execute on function public.schedule_bia_visit_v2(text,text,text,uuid,timestamptz,text) to service_role;

commit;
