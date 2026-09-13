begin;
do $test$
declare
 request_id uuid:=gen_random_uuid();
 legacy_id uuid:=gen_random_uuid();
 payload jsonb;
 result jsonb;
begin
 if has_function_privilege('anon','public.submit_solaris_public_form(jsonb,text)','execute') or has_function_privilege('authenticated','public.submit_solaris_public_form(jsonb,text)','execute') then raise exception 'Public RPC permission'; end if;
 if has_table_privilege('anon','private.crm_public_form_submissions','select') or has_table_privilege('authenticated','private.crm_public_form_submissions','select') then raise exception 'Public data access'; end if;
 payload:=jsonb_build_object('requestId',request_id,'name','Teste transacional Solaris '||request_id::text,'phone','+5534999990001','purpose','investir','consent',true,'attribution',jsonb_build_object('utm_source','teste_rollback'));
 result:=public.submit_solaris_public_form(payload,repeat('d',64));
 if result->>'id'<>request_id::text then raise exception 'Missing receipt'; end if;
 if not exists(select 1 from private.crm_public_form_submissions s join public.crm_records r on r.id=s.crm_record_id where s.id=request_id and s.budget is null and r.budget_min is null and r.budget_max is null and r.notes not like '%Faixa:%' and r.contact_id is not null) then raise exception 'Missing null budget CRM mapping'; end if;
 result:=public.submit_solaris_public_form(payload||'{"budget":null}'::jsonb,repeat('d',64));
 if result->'duplicate' is distinct from 'true'::jsonb then raise exception 'Null retry not idempotent'; end if;
 begin
  perform public.submit_solaris_public_form(payload||'{"budget":"acima_500"}'::jsonb,repeat('d',64));
  raise exception 'Changed budget accepted';
 exception when others then if sqlerrm<>'FORM_ID_CONFLICT' then raise; end if; end;
 begin
  perform public.submit_solaris_public_form(payload||'{"consent":false}'::jsonb,repeat('d',64));
  raise exception 'Missing consent accepted';
 exception when others then if sqlerrm<>'FORM_INVALID' then raise; end if; end;
 begin
  perform public.submit_solaris_public_form(payload||'{"budget":"invalid"}'::jsonb,repeat('d',64));
  raise exception 'Invalid range accepted';
 exception when others then if sqlerrm<>'FORM_INVALID' then raise; end if; end;
 payload:=payload||jsonb_build_object('requestId',legacy_id,'name','Teste transacional legado '||legacy_id::text,'budget','300_500');
 perform public.submit_solaris_public_form(payload,repeat('e',64));
 if not exists(select 1 from private.crm_public_form_submissions s join public.crm_records r on r.id=s.crm_record_id where s.id=legacy_id and s.budget='300_500' and r.budget_min=300000 and r.budget_max=500000) then raise exception 'Legacy range mapping changed'; end if;
end;
$test$;
rollback;
select 'passed: missing investment, CRM null mapping, consent, legacy values, retries, conflicts and access; all test changes rolled back' as verification, (select count(*) from private.crm_public_form_submissions where form_slug='solaris-futura-casa') as persisted_submissions;