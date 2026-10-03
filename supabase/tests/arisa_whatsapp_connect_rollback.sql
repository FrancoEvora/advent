-- Real schema validation. All test connection/audit writes are rolled back.
begin;
select set_config('test.connect_actor',m.user_id::text,true),set_config('test.connect_org',m.organization_id::text,true)
  from public.organization_members m join public.organizations o on o.id=m.organization_id
  where m.active and m.role='admin' and o.active order by m.created_at limit 1;
select set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.connect_actor'),'role','authenticated')::text,true);
set local role authenticated;
do $test$
declare
  org uuid := current_setting('test.connect_org')::uuid;
  result jsonb;
  v_request_id uuid := gen_random_uuid();
  row_id uuid;
  denied boolean;
  before_count int;
  remaining int;
begin
  select count(*) into before_count from public.arisa_whatsapp_connections where organization_id=org;
  result := public.arisa_whatsapp_connect(org,'status',null);
  assert result->'primary' ? 'configured','Missing safe primary-channel status';
  assert (select count(*) from public.arisa_whatsapp_connections where organization_id=org)=before_count,'Status must not write';
  result := public.arisa_whatsapp_connect(org,'preflight',v_request_id);
  row_id := (result->'connection'->>'id')::uuid;
  assert result->'connection'->>'onboarding_status'='blocked','Must block before Meta onboarding';
  assert result->'connection'->>'coexistence_status'='unknown','Must not claim eligibility';
  assert result::text not like '%access_token%','No token fields in API';
  result := public.arisa_whatsapp_connect(org,'preflight',v_request_id);
  assert (select count(*) from public.arisa_whatsapp_connection_audit a where a.request_id=v_request_id and a.connection_id=row_id)=2,'Retry must not duplicate events';
  assert (select count(*) from public.arisa_whatsapp_connections where id=row_id)=1,'Owner can read own connection';
  denied := false;
  begin update public.arisa_whatsapp_connections set automation_enabled=true where id=row_id;
  exception when insufficient_privilege then denied := true; end;
  assert denied,'Authenticated cannot activate or modify a connection';
  denied := false;
  begin insert into public.arisa_whatsapp_connection_audit(connection_id,organization_id,owner_user_id,request_id,event,from_state,to_state,reason)
    values(row_id,org,auth.uid(),gen_random_uuid(),'onboarding_blocked','checking','blocked','META_READ_ONLY_ELIGIBILITY_UNAVAILABLE');
  exception when insufficient_privilege then denied := true; end;
  assert denied,'Authenticated cannot forge audit';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',gen_random_uuid(),'role','authenticated')::text,true);
  assert (select count(*) from public.arisa_whatsapp_connections where id=row_id)=0,'RLS hides other owner connection';
  assert (select count(*) from public.arisa_whatsapp_connection_audit where connection_id=row_id)=0,'RLS hides audit';
  denied := false;
  begin perform public.arisa_whatsapp_connect(org,'status',null);
  exception when insufficient_privilege then denied := true; end;
  assert denied,'Non-member denied by RPC';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.connect_actor'),'role','authenticated')::text,true);
  denied := false;
  begin perform public.arisa_whatsapp_connect(gen_random_uuid(),'preflight',gen_random_uuid());
  exception when insufficient_privilege then denied := true; end;
  assert denied,'Cross-organization request denied';
  select 5-count(*) into remaining from public.arisa_whatsapp_connection_audit
    where organization_id=org and owner_user_id=auth.uid() and event='preflight_started' and created_at>now()-interval '1 hour';
  for i in 1..remaining loop perform public.arisa_whatsapp_connect(org,'preflight',gen_random_uuid()); end loop;
  denied := false;
  begin perform public.arisa_whatsapp_connect(org,'preflight',gen_random_uuid());
  exception when sqlstate 'P0429' then denied := true; end;
  assert denied,'Sixth request must be rate-limited';
  perform public.arisa_whatsapp_connect(org,'preflight',v_request_id); -- retry remains idempotent at limit
end;
$test$;
reset role;
do $test$
declare denied boolean := false;
begin
  assert not has_table_privilege('anon','public.arisa_whatsapp_connections','SELECT');
  assert not has_function_privilege('anon','public.arisa_whatsapp_connect(uuid,text,uuid)','EXECUTE');
  assert not has_table_privilege('authenticated','public.arisa_whatsapp_connections','INSERT');
  assert (select relrowsecurity from pg_class where oid='public.arisa_whatsapp_connections'::regclass);
  assert (select relrowsecurity from pg_class where oid='public.arisa_whatsapp_connection_audit'::regclass);
  begin update public.arisa_whatsapp_connections set onboarding_status='connected';
  exception when check_violation then denied := true; end;
  assert denied,'Constraint prevents connection activation even by privileged writer';
end;
$test$;
select 'PASS: auth, owner/organization RLS, readonly status, typed audit, idempotency, rate limit, activation guard' as verification;
rollback;
