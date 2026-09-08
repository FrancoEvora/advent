-- All fixture rows, notices and pg_net requests are rolled back.
begin;
set local statement_timeout='120s';
set local lock_timeout='5s';
do $test$
declare v_org uuid;v_actor uuid;v_other_user uuid;v_contact uuid;v_other uuid;v_supplier uuid;v_thread uuid;v_message uuid;v_lease uuid:=gen_random_uuid();
 v_entry uuid;v_notice uuid;v_other_notice uuid;v_phone text:='551198'||lpad(floor(random()*10000000)::bigint::text,7,'0');
 v_result jsonb;v_again jsonb;v_denied boolean;v_count integer;v_i integer;
begin
 select c.organization_id,c.updated_by into v_org,v_actor from crm_private.arisa_whatsapp_channel c where c.enabled and c.auto_reply_enabled and private.arisa_actor_admin(c.organization_id,c.updated_by) limit 1;
 if v_org is null then raise exception 'Enabled channel fixture required';end if;
 perform set_config('request.jwt.claims',jsonb_build_object('role','service_role','sub',v_actor)::text,true);
 if has_function_privilege('authenticated','public.arisa_whatsapp_finance(uuid,uuid,text,text)','EXECUTE')
  or has_function_privilege('anon','public.arisa_my_notifications(uuid,integer,integer,boolean)','EXECUTE')
  or has_table_privilege('authenticated','crm_private.arisa_whatsapp_finance_sessions','SELECT') then raise exception 'Private finance access exposed';end if;
 insert into public.contacts(organization_id,contact_type,name,document,email,phone,country,active)
  values(v_org,'cliente','Pessoa Cliente Teste','12345678909','cliente@example.test',v_phone,'BR',true) returning id into v_contact;
 insert into public.contacts(organization_id,contact_type,name,document,email,phone,country,active)
  values(v_org,'cliente','Outra Pessoa Teste','98765432100','outro@example.test','5511977776666','BR',true) returning id into v_other;
 insert into public.contacts(organization_id,contact_type,name,document,email,phone,country,active)
  values(v_org,'fornecedor','Fornecedor Teste LTDA','11222333000181','fornecedor@example.test','5511966665555','BR',true) returning id into v_supplier;
 insert into public.financial_entries(organization_id,user_id,type,description,amount,open_amount,due_date,status,approval_status,contact_id,document_number,notes)
  values(v_org,v_actor,'entrada','Internal description not for external disclosure',123.45,123.45,current_date+7,'pendente','aprovado',v_contact,'OWN-1','INTERNAL_SECRET_FIXTURE') returning id into v_entry;
 insert into public.financial_entries(organization_id,user_id,type,description,amount,open_amount,due_date,status,approval_status,contact_id,document_number)
  values(v_org,v_actor,'entrada','Other contact',99999,99999,current_date+7,'pendente','aprovado',v_other,'OTHER-SECRET'),
  (v_org,v_actor,'entrada','Second own installment',200,200,current_date+14,'pendente','aprovado',v_contact,'OWN-2'),
  (v_org,v_actor,'entrada','Draft',555,555,current_date+7,'rascunho','pendente',v_contact,'DRAFT-SECRET'),
  (v_org,v_actor,'saida','Other direction',888,888,current_date+7,'pendente','aprovado',v_contact,'WRONG-DIRECTION'),
  (v_org,v_actor,'saida','Supplier invoice',456,0,current_date-1,'pago','aprovado',v_supplier,'SUPPLIER-1');
 insert into public.arisa_whatsapp_threads(organization_id,phone_number_id,phone,last_inbound_at)
  select v_org,phone_number_id,v_phone,now() from crm_private.whatsapp_runtime_settings where organization_id=v_org returning id into v_thread;
 update crm_private.arisa_whatsapp_reply_jobs set status='skipped' where thread_id=v_thread and status in('pending','processing');
insert into public.arisa_whatsapp_messages(organization_id,thread_id,direction,content,provider_message_id,delivery_status)
values(v_org,v_thread,'inbound','Quero consultar minha nota OWN-1.','wamid.finance.fixture.'||gen_random_uuid()::text,'delivered') returning id into v_message;
update crm_private.arisa_whatsapp_reply_jobs set status='processing',lease=v_lease,lease_until=now()+interval '3 minutes' where id=v_message;
 v_denied=false;begin perform public.arisa_whatsapp_finance(v_message,v_lease,'consult');exception when insufficient_privilege then v_denied=true;end;if not v_denied then raise exception 'Unverified financial read accepted';end if;
 v_result=public.arisa_whatsapp_finance(v_message,v_lease,'start');
 if v_result->>'verified'<>'false' or v_result->>'handled'<>'true' then raise exception 'Verification not required';end if;
 update crm_private.arisa_whatsapp_reply_jobs set status='skipped' where thread_id=v_thread and status in('pending','processing');
insert into public.arisa_whatsapp_messages(organization_id,thread_id,direction,content,provider_message_id,delivery_status)
values(v_org,v_thread,'inbound','Pessoa Cliente Teste, CPF 00000000000, cliente@example.test','wamid.finance.fixture.'||gen_random_uuid()::text,'delivered') returning id into v_message;
update crm_private.arisa_whatsapp_reply_jobs set status='processing',lease=v_lease,lease_until=now()+interval '3 minutes' where id=v_message;
 v_result=public.arisa_whatsapp_finance(v_message,v_lease);
 v_again=public.arisa_whatsapp_finance(v_message,v_lease);
 if v_result->>'verified'<>'false' or (select failed_attempts from crm_private.arisa_whatsapp_finance_sessions where thread_id=v_thread)<>1 then raise exception 'Mismatch or retry rate limit failed';end if;
 update crm_private.arisa_whatsapp_reply_jobs set status='skipped' where thread_id=v_thread and status in('pending','processing');
insert into public.arisa_whatsapp_messages(organization_id,thread_id,direction,content,provider_message_id,delivery_status)
values(v_org,v_thread,'inbound','Pessoa Cliente Teste, CPF 123.456.789-09, cliente@example.test','wamid.finance.fixture.'||gen_random_uuid()::text,'delivered') returning id into v_message;
update crm_private.arisa_whatsapp_reply_jobs set status='processing',lease=v_lease,lease_until=now()+interval '3 minutes' where id=v_message;
 v_result=public.arisa_whatsapp_finance(v_message,v_lease);
 if v_result->>'verified'<>'true' or v_result->>'just_verified'<>'true' then raise exception 'Three matching facts rejected: %',v_result;end if;
 if not v_result->'redacted_message_ids' @> jsonb_build_array(v_message) then raise exception 'Identity message not redacted';end if;
 v_result=public.arisa_whatsapp_finance(v_message,v_lease,'consult');
 if v_result->>'total'<>'2' or v_result->'entries'->0->>'document_number'<>'OWN-1' or v_result::text ~ 'OTHER-SECRET|DRAFT-SECRET|WRONG-DIRECTION|INTERNAL_SECRET_FIXTURE|description|bank_account_id' then raise exception 'Financial scope leaked: %',v_result;end if;
 v_result=public.arisa_whatsapp_finance(v_message,v_lease,'consult','OTHER-SECRET');
 if v_result->>'total'<>'0' then raise exception 'Reference bypassed contact boundary';end if;
 update crm_private.arisa_whatsapp_reply_jobs set status='skipped' where thread_id=v_thread and status in('pending','processing');
insert into public.arisa_whatsapp_messages(organization_id,thread_id,direction,content,provider_message_id,delivery_status)
values(v_org,v_thread,'inbound','Quero negociar a nota OWN-1: pagar em duas parcelas no próximo mês.','wamid.finance.fixture.'||gen_random_uuid()::text,'delivered') returning id into v_message;
update crm_private.arisa_whatsapp_reply_jobs set status='processing',lease=v_lease,lease_until=now()+interval '3 minutes' where id=v_message;
 perform public.arisa_whatsapp_finance(v_message,v_lease,'consult','OWN-1');
 v_result=public.arisa_whatsapp_attention(v_message,v_lease,jsonb_build_object('kind','negotiation','needs_notification',true,'requires_authorization',false,'target_names','[]'::jsonb,'summary','Cliente propõe pagar OWN-1 em duas parcelas no próximo mês; aguarda aprovação.'));
 select id into v_notice from public.activity_notifications where metadata->>'source_message_id'=v_message::text and recipient_user_id=v_actor;
 if v_notice is null or not exists(select 1 from crm_private.arisa_whatsapp_notice_jobs where id=v_notice)
   or not exists(select 1 from public.activity_notifications where id=v_notice and metadata->>'proposal_status'='pending' and metadata->>'verified_contact_id'=v_contact::text)
   or (select amount from public.financial_entries where id=v_entry)<>123.45 then raise exception 'Proposal missing or financial entry mutated';end if;
 -- Revocation is enforced again before sending a generated financial response.
 update public.contacts set email='changed@example.test' where id=v_contact;
 v_denied=false;begin perform public.arisa_whatsapp_finance(v_message,v_lease,'consult');exception when insufficient_privilege then v_denied=true;end;if not v_denied then raise exception 'Unverified financial read accepted';end if;
 v_result=public.arisa_whatsapp_reply_worker('send',jsonb_build_object('id',v_message,'lease',v_lease,'content','A reply that must not leave'));
 if v_result->>'proceed'<>'false' then raise exception 'Changed identity sent stale financial reply';end if;
 update public.contacts set email='cliente@example.test' where id=v_contact;
 -- Inactivity/expiry, duplicate phones and another sender cannot inherit verification.
 update crm_private.arisa_whatsapp_reply_jobs set status='processing' where id=v_message;
 update crm_private.arisa_whatsapp_finance_sessions set verified_until=now()-interval '1 second' where thread_id=v_thread;
 v_denied=false;begin perform public.arisa_whatsapp_finance(v_message,v_lease,'consult');exception when insufficient_privilege then v_denied=true;end;if not v_denied then raise exception 'Unverified financial read accepted';end if;
 update crm_private.arisa_whatsapp_finance_sessions set verified_until=now()+interval '30 minutes' where thread_id=v_thread;
 update public.contacts set phone=v_phone where id=v_other;
 v_denied=false;begin perform public.arisa_whatsapp_finance(v_message,v_lease,'consult');exception when insufficient_privilege then v_denied=true;end;if not v_denied then raise exception 'Unverified financial read accepted';end if;
 update public.contacts set phone='5511977776666' where id=v_other;
 update public.arisa_whatsapp_threads set phone='5511955554444' where id=v_thread;
 v_denied=false;begin perform public.arisa_whatsapp_finance(v_message,v_lease,'consult');exception when insufficient_privilege then v_denied=true;end;if not v_denied then raise exception 'Unverified financial read accepted';end if;
 update public.arisa_whatsapp_threads set phone=v_phone where id=v_thread;
 -- Three divergent attempts lock the conversation; all three fields are required.
 update crm_private.arisa_whatsapp_finance_sessions set stage='awaiting',failed_attempts=0,challenge_until=now()+interval '15 minutes' where thread_id=v_thread;
 for v_i in 1..3 loop
 update crm_private.arisa_whatsapp_reply_jobs set status='skipped' where thread_id=v_thread and status in('pending','processing');
insert into public.arisa_whatsapp_messages(organization_id,thread_id,direction,content,provider_message_id,delivery_status)
values(v_org,v_thread,'inbound',case v_i when 1 then 'Wrong Name, 12345678909, cliente@example.test' when 2 then 'Pessoa Cliente Teste, 99999999999, cliente@example.test' else 'Pessoa Cliente Teste, 12345678909, wrong@example.test' end,'wamid.finance.fixture.'||gen_random_uuid()::text,'delivered') returning id into v_message;
update crm_private.arisa_whatsapp_reply_jobs set status='processing',lease=v_lease,lease_until=now()+interval '3 minutes' where id=v_message;
 v_result=public.arisa_whatsapp_finance(v_message,v_lease);
 if v_result->>'verified'<>'false' then raise exception 'One mismatched field accepted';end if;
 end loop;
 update crm_private.arisa_whatsapp_reply_jobs set status='skipped' where thread_id=v_thread and status in('pending','processing');
insert into public.arisa_whatsapp_messages(organization_id,thread_id,direction,content,provider_message_id,delivery_status)
values(v_org,v_thread,'inbound','Pessoa Cliente Teste, 12345678909, cliente@example.test','wamid.finance.fixture.'||gen_random_uuid()::text,'delivered') returning id into v_message;
update crm_private.arisa_whatsapp_reply_jobs set status='processing',lease=v_lease,lease_until=now()+interval '3 minutes' where id=v_message;
 v_result=public.arisa_whatsapp_finance(v_message,v_lease);
 if v_result->>'verified'<>'false' or (select stage from crm_private.arisa_whatsapp_finance_sessions where thread_id=v_thread)<>'locked' then raise exception 'Rate limit bypassed';end if;
 -- Supplier consultations use only payable rows for the verified supplier.
 update public.contacts set phone=null where id=v_contact;
 update public.contacts set phone=v_phone where id=v_supplier;
 update crm_private.arisa_whatsapp_finance_sessions set stage='closed',locked_until=null,failed_attempts=0 where thread_id=v_thread;
 update crm_private.arisa_whatsapp_reply_jobs set status='skipped' where thread_id=v_thread and status in('pending','processing');
insert into public.arisa_whatsapp_messages(organization_id,thread_id,direction,content,provider_message_id,delivery_status)
values(v_org,v_thread,'inbound','Fornecedor Teste LTDA, 11.222.333/0001-81, fornecedor@example.test','wamid.finance.fixture.'||gen_random_uuid()::text,'delivered') returning id into v_message;
update crm_private.arisa_whatsapp_reply_jobs set status='processing',lease=v_lease,lease_until=now()+interval '3 minutes' where id=v_message;
 v_result=public.arisa_whatsapp_finance(v_message,v_lease,'start');
 if v_result->>'verified'<>'true' then raise exception 'Supplier identity rejected';end if;
 v_result=public.arisa_whatsapp_finance(v_message,v_lease,'consult');
 if v_result->>'total'<>'1' or v_result->'entries'->0->>'document_number'<>'SUPPLIER-1' then raise exception 'Supplier scope failed';end if;
 update public.contacts set email=null where id=v_supplier;
 v_denied=false;begin perform public.arisa_whatsapp_finance(v_message,v_lease,'consult');exception when insufficient_privilege then v_denied=true;end;if not v_denied then raise exception 'Unverified financial read accepted';end if;
 update crm_private.arisa_whatsapp_reply_jobs set status='skipped' where thread_id=v_thread and status in('pending','processing');
insert into public.arisa_whatsapp_messages(organization_id,thread_id,direction,content,provider_message_id,delivery_status)
values(v_org,v_thread,'inbound','Quero consultar minha nota.','wamid.finance.fixture.'||gen_random_uuid()::text,'delivered') returning id into v_message;
update crm_private.arisa_whatsapp_reply_jobs set status='processing',lease=v_lease,lease_until=now()+interval '3 minutes' where id=v_message;
 v_result=public.arisa_whatsapp_finance(v_message,v_lease,'start');
 if v_result->>'verified'<>'false' or v_result->>'escalate'<>'true' then raise exception 'Incomplete registration did not escalate';end if;
 -- Self inbox uses auth.uid even when a caller supplies another notification ID.
 select user_id into v_other_user from public.organization_members where organization_id=v_org and active and user_id<>v_actor limit 1;
 if v_other_user is not null then
  insert into public.activity_notifications(organization_id,recipient_user_id,notification_type,title,message,metadata)
   values(v_org,v_other_user,'arisa_whatsapp','Private other inbox','OTHER_INBOX_SECRET',jsonb_build_object('source','arisa_whatsapp')) returning id into v_other_notice;
 end if;
 perform set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',v_actor)::text,true);
 update public.arisa_whatsapp_messages set occurred_at='2026-09-07 22:30:00-03' where id=(select (metadata->>'source_message_id')::uuid from public.activity_notifications where id=v_notice);
 v_result=public.arisa_my_notifications(v_org,100);
 if not exists(select 1 from jsonb_array_elements(v_result->'items') n where n->>'id'=v_notice::text and n->'reference_dates'->>'tomorrow'='2026-09-08') then raise exception 'Relative date moved to the day of reading';end if;
 if not v_result->'items' @> jsonb_build_array(jsonb_build_object('id',v_notice)) or v_result::text like '%OTHER_INBOX_SECRET%' then raise exception 'Inbox recipient boundary failed';end if;
 if v_other_notice is not null and public.arisa_mark_notifications_read(v_org,array[v_other_notice])<>0 then raise exception 'Marked another recipient notice';end if;
 if public.arisa_mark_notifications_read(v_org,array[v_notice])<>1 then raise exception 'Own notice not marked';end if;
 v_denied=false;begin perform public.arisa_my_notifications(gen_random_uuid());exception when insufficient_privilege then v_denied=true;end;
 if not v_denied then raise exception 'Foreign organization inbox accepted';end if;
 perform set_config('request.jwt.claims','{"role":"anon"}',true);
 v_denied=false;begin perform public.arisa_my_notifications(v_org);exception when insufficient_privilege then v_denied=true;end;
 if not v_denied then raise exception 'Anonymous inbox accepted';end if;
 raise notice 'PASS: three facts + sender binding, retry idempotency, own client/supplier scope, no internal fields, proposal approval queue, expiry/revocation/send guard, rate limit and private notifications';
end $test$;
rollback;
