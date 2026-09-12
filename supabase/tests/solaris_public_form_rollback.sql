begin;
do $$
declare
 request_id uuid:=gen_random_uuid();
 fresh_id uuid:=gen_random_uuid();
 payload jsonb;
 result jsonb;
 lead_count integer;
begin
 if has_function_privilege('anon','public.submit_solaris_public_form(jsonb,text)','execute') or has_function_privilege('authenticated','public.submit_solaris_public_form(jsonb,text)','execute') then raise exception 'Public RPC permission'; end if;
 if has_table_privilege('anon','private.crm_public_form_submissions','select') or has_table_privilege('authenticated','private.crm_public_form_submissions','select') then raise exception 'Public data access'; end if;
 select count(*) into lead_count from public.crm_records;
 payload:=jsonb_build_object('requestId',request_id,'name','Franco','phone','+5511917664123','purpose','investir','budget','acima_500','consent',true,'attribution','{}'::jsonb);
 result:=public.submit_solaris_public_form(payload,repeat('a',64));
 if result->>'id'<>request_id::text then raise exception 'Wrong receipt'; end if;
 if (select count(*) from public.crm_records)<>lead_count then raise exception 'Duplicated existing person'; end if;
 if not exists(select 1 from private.crm_public_form_submissions where id=request_id and crm_record_id='8bc6921b-62ae-4f93-8810-bd165621150b') then raise exception 'Wrong CRM record'; end if;
 result:=public.submit_solaris_public_form(payload,repeat('a',64));
 if result->'duplicate'<>'true'::jsonb then raise exception 'Retry not idempotent'; end if;
 begin
   perform public.submit_solaris_public_form(payload||'{"purpose":"morar"}'::jsonb,repeat('a',64));
   raise exception 'Conflict accepted';
 exception when others then if sqlerrm<>'FORM_ID_CONFLICT' then raise; end if; end;
 begin
   perform public.submit_solaris_public_form(payload||'{"consent":false}'::jsonb,repeat('a',64));
   raise exception 'Missing consent accepted';
 exception when others then if sqlerrm<>'FORM_INVALID' then raise; end if; end;
 payload:=payload||jsonb_build_object('requestId',fresh_id,'name','Teste SQL rollback Solaris','phone','+5534999990001','budget','300_500');
 perform public.submit_solaris_public_form(payload,repeat('b',64));
 if (select count(*) from public.crm_records)<>lead_count+1 then raise exception 'New lead missing'; end if;
 if not exists(select 1 from private.crm_public_form_submissions s join public.crm_records r on r.id=s.crm_record_id where s.id=fresh_id and r.budget_min=300000 and r.budget_max=500000 and r.project_id='85799c1b-e14a-5120-bf3d-976928d5dec3' and r.contact_id is not null) then raise exception 'CRM mapping incomplete'; end if;
end;
$$;
rollback;
select 'passed: persistence, CRM mapping, consent, idempotency, conflict and permissions; rolled back' as verification;
