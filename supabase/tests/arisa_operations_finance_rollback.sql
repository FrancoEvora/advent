-- Execute only after the Arisa migration. This entire fixture MUST roll back.
-- Uses the first active admin and existing master-data IDs internally; prints no IDs.
begin;
set local statement_timeout='60s';
do $$
declare
  v_org uuid; v_actor uuid; v_contact uuid; v_project uuid; v_center uuid; v_category uuid; v_bank uuid;
  v_item uuid; v_duplicate uuid; v_missing uuid; v_receipt uuid; v_auto uuid; v_statement uuid; v_conflict uuid;
  v_entry uuid; v_auto_entry uuid; v_context jsonb; v_extract jsonb; v_result jsonb; v_again jsonb; v_claim jsonb;
  v_document text:='ARISA-TEST-'||gen_random_uuid()::text; v_cnpj text:='11222333000181';
  v_day date:=(now() at time zone 'America/Sao_Paulo')::date; v_hash text:=md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text);
  v_before integer; v_failed boolean; v_external text:='ARISA-FITID-'||gen_random_uuid()::text;
begin
  select organization_id,user_id into v_org,v_actor from public.organization_members where active and role='admin' order by organization_id limit 1;
  if v_org is null then raise exception 'Fixture needs an active administrator.'; end if;
  perform set_config('request.jwt.claim.sub',v_actor::text,true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_actor,'role','authenticated')::text,true);
  select id into v_project from public.projects where organization_id=v_org and active limit 1;
  select id into v_center from public.cost_centers where organization_id=v_org and active limit 1;
  select id into v_category from public.financial_categories where organization_id=v_org and active and movement_type in ('saida','ambos') limit 1;
  select id into v_bank from public.bank_accounts where organization_id=v_org and active limit 1;
  if v_bank is null then
    insert into public.bank_accounts(organization_id,name,bank_name,initial_balance,active)
    values(v_org,'ARISA QA BANK - ROLLBACK','Synthetic',0,true) returning id into v_bank;
  end if;
  if v_project is null or v_center is null or v_category is null then raise exception 'Fixture needs active financial master data.'; end if;
  insert into public.contacts(organization_id,contact_type,name,document,active) values(v_org,'fornecedor','ARISA ROLLBACK FIXTURE',v_cnpj,true) returning id into v_contact;
  v_context:=jsonb_build_object('contact_id',v_contact,'project_id',v_project,'cost_center_id',v_center,'category_id',v_category,'bank_account_id',v_bank);
  v_extract:=jsonb_build_object('document_type','invoice','supplier_name','ARISA ROLLBACK FIXTURE','supplier_document',v_cnpj,'document_number',v_document,
    'amount',1873.42,'due_date',v_day,'issue_date',v_day,'description','ARISA fixture obligation','confidence',1,'warnings','[]'::jsonb,
    'source_evidence',jsonb_build_object('supplier_document',v_cnpj,'amount','1873,42','due_date',v_day::text));
  perform public.arisa_set_operation_policy(v_org,false,5000);
  insert into public.arisa_operation_items(organization_id,input_kind,storage_path,file_name,mime_type,size_bytes,file_hash,status,payload,extracted,created_by)
  values(v_org,'payable',v_org||'/'||v_actor||'/'||gen_random_uuid()||'/fixture.pdf','fixture.pdf','application/pdf',1,v_hash,'needs_decision',v_context,v_extract,v_actor) returning id into v_item;

  v_result:=public.arisa_resolve_payable(v_item,'{}',false);
  if v_result->>'status'<>'needs_decision' or v_result->>'entry_id' is not null then raise exception 'Ready review must not create obligation.'; end if;
  v_result:=public.arisa_resolve_payable(v_item,'{}',true); v_entry:=(v_result->>'entry_id')::uuid;
  if v_entry is null or v_result->>'status'<>'completed' then raise exception 'Explicit reviewed creation failed.'; end if;
  if not exists(select 1 from public.financial_entries where id=v_entry and status='pendente' and approval_status='pendente' and settlement_date is null) then raise exception 'Created title must await approval, without settlement.'; end if;
  if (select count(*) from public.approval_requests where entry_id=v_entry and status='pendente')<>1 then raise exception 'Approval request not atomic.'; end if;
  v_again:=public.arisa_resolve_payable(v_item,'{}',true);
  if v_again->>'entry_id'<>v_entry::text then raise exception 'Resolve retry not idempotent.'; end if;
  v_again:=public.arisa_intake_document(v_org,'unused','fixture.pdf','application/pdf',1,v_hash,'payable','{}');
  if v_again->>'id'<>v_item::text then raise exception 'Repeated file hash not idempotent.'; end if;

  insert into public.arisa_operation_items(organization_id,input_kind,storage_path,file_name,mime_type,size_bytes,file_hash,status,payload,extracted,created_by)
  values(v_org,'payable',v_org||'/'||v_actor||'/'||gen_random_uuid()||'/duplicate.pdf','duplicate.pdf','application/pdf',1,md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text),'needs_decision',v_context,v_extract,v_actor) returning id into v_duplicate;
  v_result:=public.arisa_resolve_payable(v_duplicate,'{}',true);
  if v_result->>'entry_id' is not null or not (v_result#>'{outcome,duplicate_entry_ids}' ? v_entry::text) then raise exception 'Duplicate created or candidate missing.'; end if;
  v_result:=public.arisa_link_existing_payable(v_duplicate,v_entry);
  if v_result->>'entry_id'<>v_entry::text then raise exception 'Strong existing-title link failed.'; end if;

  insert into public.arisa_operation_items(organization_id,input_kind,storage_path,file_name,mime_type,size_bytes,file_hash,status,payload,extracted,created_by)
  values(v_org,'payable',v_org||'/'||v_actor||'/'||gen_random_uuid()||'/missing.pdf','missing.pdf','application/pdf',1,md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text),'needs_information',v_context,v_extract||jsonb_build_object('amount',null,'document_number',v_document||'-missing'),v_actor) returning id into v_missing;
  v_result:=public.arisa_resolve_payable(v_missing,'{}',true);
  if v_result->>'status'<>'needs_information' or v_result->>'entry_id' is not null then raise exception 'Missing amount accepted.'; end if;
  v_failed:=false;
  begin perform public.arisa_resolve_payable(v_missing,'{"amount":12.345}',true); exception when others then v_failed:=true; end;
  if not v_failed then raise exception 'Fractional cent silently accepted.'; end if;
  v_failed:=false;
  begin perform public.arisa_resolve_payable(v_missing,jsonb_build_object('contact_id',gen_random_uuid()),false); exception when others then v_failed:=true; end;
  if not v_failed then raise exception 'Unknown/cross-organization identifier accepted.'; end if;

  insert into public.arisa_operation_items(organization_id,input_kind,storage_path,file_name,mime_type,size_bytes,file_hash,status,payload,extracted,created_by)
  values(v_org,'payable',v_org||'/'||v_actor||'/'||gen_random_uuid()||'/receipt.pdf','receipt.pdf','application/pdf',1,md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text),'needs_decision',v_context,v_extract||jsonb_build_object('document_type','receipt','document_number',v_document||'-receipt','amount',1888.42),v_actor) returning id into v_receipt;
  v_result:=public.arisa_resolve_payable(v_receipt,'{"document_type":"invoice"}',true);
  if v_result->>'entry_id' is not null then raise exception 'Receipt reclassified to create payable.'; end if;

  perform public.arisa_set_operation_policy(v_org,true,5000);
  insert into public.arisa_operation_items(organization_id,input_kind,storage_path,file_name,mime_type,size_bytes,file_hash,payload,created_by)
  values(v_org,'payable',v_org||'/'||v_actor||'/'||gen_random_uuid()||'/auto.pdf','auto.pdf','application/pdf',1,md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text),v_context,v_actor) returning id into v_auto;
  v_claim:=public.arisa_claim_operation(v_auto,v_actor);
  v_failed:=false;
  begin perform public.arisa_claim_operation(v_auto,v_actor); exception when lock_not_available then v_failed:=true; end;
  if not v_failed then raise exception 'Concurrent claim accepted.'; end if;
  v_extract:=v_extract||jsonb_build_object('document_number',v_document||'-auto','amount',1999.42,
    'source_evidence',jsonb_build_object('supplier_document',v_cnpj,'amount','1999,42','due_date',v_day::text));
  v_result:=public.arisa_finish_extraction(v_auto,(v_claim->>'lease_token')::uuid,v_extract); v_auto_entry:=(v_result->>'entry_id')::uuid;
  if (select count(*) from public.contacts where organization_id=v_org and active and contact_type in ('fornecedor','ambos','colaborador') and regexp_replace(coalesce(document,''),'\D','','g')=v_cnpj)=1 then
    if v_auto_entry is null then raise exception 'Complete policy-enabled document not registered.'; end if;
    if not exists(select 1 from public.financial_entries where id=v_auto_entry and approval_status='pendente' and status='pendente') then raise exception 'Automatic registration bypassed approval.'; end if;
  end if;
  v_again:=public.arisa_finish_extraction(v_auto,(v_claim->>'lease_token')::uuid,v_extract);
  if v_again->>'entry_id' is distinct from v_result->>'entry_id' then raise exception 'Finish retry changed result.'; end if;

  -- Fixture-only approval to exercise matching; production matcher never approves.
  update public.financial_entries set approval_status='aprovado' where id=v_entry;
  insert into public.arisa_operation_items(organization_id,input_kind,storage_path,file_name,mime_type,size_bytes,file_hash,status,payload,extracted,created_by)
  values(v_org,'bank_statement',v_org||'/'||v_actor||'/'||gen_random_uuid()||'/statement.csv','statement.csv','text/csv',1,md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text),'needs_decision',v_context,
    jsonb_build_object('document_type','bank_statement','warnings','[]'::jsonb,'transactions',jsonb_build_array(jsonb_build_object('external_id',v_external,'posted_on',v_day,'amount',-1873.42,'description','ARISA fixture bank movement','document_reference',v_document))),v_actor) returning id into v_statement;
  v_result:=public.arisa_reconcile_statement(v_statement);
  if (v_result#>>'{outcome,matched}')::integer<>1 then raise exception 'Exact statement match failed.'; end if;
  if not exists(select 1 from public.financial_entries where id=v_entry and status='pendente' and settlement_date is null) then raise exception 'Statement match settled a title.'; end if;
  v_again:=public.arisa_reconcile_statement(v_statement);
  if (select count(*) from public.arisa_bank_transactions where item_id=v_statement)<>1 then raise exception 'Statement retry duplicated transaction.'; end if;
  insert into public.arisa_operation_items(organization_id,input_kind,storage_path,file_name,mime_type,size_bytes,file_hash,status,payload,extracted,created_by)
  values(v_org,'bank_statement',v_org||'/'||v_actor||'/'||gen_random_uuid()||'/conflict.csv','conflict.csv','text/csv',1,md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text),'needs_decision',v_context,
    jsonb_build_object('document_type','bank_statement','warnings','[]'::jsonb,'transactions',jsonb_build_array(jsonb_build_object('external_id',v_external,'posted_on',v_day,'amount',-1888.42,'description','ARISA conflicting movement','document_reference',v_document))),v_actor) returning id into v_conflict;
  v_result:=public.arisa_reconcile_statement(v_conflict);
  if (v_result#>>'{outcome,identifier_conflicts}')::integer<>1 or v_result->>'status'<>'needs_decision' then raise exception 'Conflicting bank identifier hidden.'; end if;

  if has_function_privilege('authenticated','public.arisa_claim_operation(uuid,uuid)','execute') then raise exception 'Worker claim exposed to user.'; end if;
  if has_table_privilege('authenticated','public.arisa_operation_items','insert') then raise exception 'Direct browser writes allowed.'; end if;
  if has_table_privilege('service_role','public.arisa_operation_events','update') then raise exception 'Event history mutable by service role.'; end if;
  select count(*) into v_before from public.arisa_operation_events where item_id=v_item;
  if v_before<2 then raise exception 'Operation audit events missing.'; end if;
end $$;
rollback;
select 'Arisa financial integration assertions passed; all fixture writes rolled back.' as result;
