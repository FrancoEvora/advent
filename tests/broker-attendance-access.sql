-- Run as the migration owner. All fixtures and actions roll back, including on failure.
begin;
do $test$
declare
 org uuid; actor uuid; manager uuid; team uuid; leads uuid[]; archived uuid; sold uuid;
 result jsonb; action uuid; visible integer; denied boolean:=false;
begin
 select organization_id,user_id into org,actor from public.organization_members where active and role='corretor' limit 1;
 if actor is null then raise exception 'Test requires an active broker'; end if;
 select user_id into manager from public.organization_members where organization_id=org and active and role='admin' limit 1;
 select array_agg(id) into leads from (select id from public.crm_records where organization_id=org and record_status<>'arquivada' order by id limit 3) r;
 select id into team from public.crm_teams where organization_id=org and active and team_type='corretores' limit 1;
 if cardinality(leads)<3 or team is null then raise exception 'Missing lead/team fixtures'; end if;
 update public.crm_teams set is_brokerage=true where id=team;
 insert into public.crm_team_members(organization_id,team_id,user_id,active) select org,team,actor,true where not exists(select 1 from public.crm_team_members where team_id=team and user_id=actor);
 update public.crm_team_members set active=true where team_id=team and user_id=actor;
 update public.crm_records set broker_user_id=case when id=leads[1] then actor else manager end,owner_user_id=manager,team_id=case when id=leads[2] then team else null end where id=any(leads);
 select id into archived from public.crm_records where organization_id=org and record_status='arquivada' limit 1;
 select u.id into sold from public.crm_inventory_units u join public.crm_contracts c on c.unit_id=u.id and c.organization_id=u.organization_id where u.organization_id=org and c.status<>'cancelado' limit 1;
 if sold is not null then update public.crm_inventory_units set status='disponivel' where id=sold; end if;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 set local role authenticated;
 select count(*) into visible from public.crm_records where id=any(leads);
 assert visible=2,'Only own + brokerage lead should be visible';
 assert not exists(select 1 from public.crm_records where id=archived),'Archived lead exposed';
 assert not exists(select 1 from public.crm_proposals),'Proposals exposed';
 assert not exists(select 1 from public.crm_contracts),'Contracts exposed';
 assert not exists(select 1 from public.crm_inventory_units),'Raw inventory exposed';
 assert not exists(select 1 from public.financial_entries),'Finance exposed';
 assert not exists(select 1 from public.audit_logs),'Corporate audit exposed';
 assert not exists(select 1 from public.crm_automations),'Automations exposed';
 assert not public.has_app_permission(org,'crm.assign'),'Assignment permission exposed';
 assert not public.has_app_permission(org,'crm.manage'),'Management permission exposed';
 result:=public.get_broker_attendance_context(org);
 assert not exists(select 1 from jsonb_array_elements(result->'units') u where u->>'id'=sold::text),'Sold/contracted lot exposed despite stale status';
 assert not exists(select 1 from jsonb_array_elements(result->'units') u where u ?| array['minimum_price','buyer_name','status','contract_id','metadata']),'Private inventory columns exposed';
 begin
  perform public.assign_crm_brokerage(leads[1],team);
  raise exception 'Broker reassigned a lead';
 exception when insufficient_privilege then null; end;
 begin
  perform public.create_crm_activity_with_broker(leads[3],'contato','telefone','Unauthorized test',null,true,null,5,actor,actor,null);
  raise exception 'Broker attended another portfolio';
 exception when insufficient_privilege then null; end;
 begin
  perform public.create_crm_activity_with_broker(leads[1],'contato','telefone','Unauthorized assignee',null,true,null,5,manager,actor,null);
  raise exception 'Broker assigned another user';
 exception when insufficient_privilege then null; end;
 result:=public.create_crm_activity_with_broker(leads[2],'contato','telefone','Rollback access regression',null,true,null,5,actor,actor,'Transactional test');
 action:=(result->>'action_id')::uuid;
 assert exists(select 1 from public.crm_actions where id=action),'Own activity unavailable';
 assert private.broker_storage_allowed('erp-documents',org::text||'/crm_record/'||leads[1]::text||'/test.pdf',true),'Scoped attachment rejected';
 assert not private.broker_storage_allowed('erp-documents',org::text||'/crm_record/'||leads[3]::text||'/test.pdf',false),'Other portfolio attachment exposed';
 assert not private.broker_storage_allowed('erp-documents',org::text||'/financial_entry/'||leads[1]::text||'/test.pdf',false),'Corporate attachment exposed';
 begin
  update public.crm_records set broker_user_id=actor where id=leads[2];
 exception when insufficient_privilege or raise_exception then denied:=true; end;
 assert denied,'Broker changed assignment';
 reset role;
 assert (select broker_user_id=manager from public.crm_records where id=leads[2]),'Agency attendance stole lead assignment';
 update public.crm_team_members set active=false where team_id=team and user_id=actor;
 set local role authenticated;
 assert not exists(select 1 from public.crm_records where id=leads[2]),'Removed brokerage membership retained lead';
 assert not exists(select 1 from public.crm_actions where id=action),'Removed brokerage membership retained activity';
 reset role;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
 update public.crm_records set broker_user_id=manager,owner_user_id=manager where id=leads[1];
 perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,true);
 set local role authenticated;
 assert not exists(select 1 from public.crm_records where id=leads[1]),'Reassigned lead remained visible';
 reset role;
 perform set_config('request.jwt.claims',jsonb_build_object('sub',manager,'role','authenticated')::text,true);
 set local role authenticated;
 assert (select count(*) from public.crm_records where id=any(leads))=3,'Admin access regressed';
 assert exists(select 1 from public.crm_inventory_units),'Admin inventory unavailable';
 reset role;
end $test$;
rollback;
select 'broker access regression passed; fixtures rolled back' as result;
