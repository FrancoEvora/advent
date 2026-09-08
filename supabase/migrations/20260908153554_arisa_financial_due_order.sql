create or replace function public.arisa_whatsapp_finance(p_job uuid,p_lease uuid,p_action text default 'probe',p_reference text default '')
returns jsonb language plpgsql security definer set search_path='' as $$
declare j crm_private.arisa_whatsapp_reply_jobs; t public.arisa_whatsapp_threads; m public.arisa_whatsapp_messages;
 s crm_private.arisa_whatsapp_finance_sessions;c public.contacts; cached crm_private.arisa_whatsapp_finance_events;
 ids uuid[];redacted jsonb;v_result jsonb;v_doc text;v_email text;v_name text;v_rows jsonb;v_total bigint;v_identity boolean:=false;v_ready boolean:=false;
 v_ask text:='Para consultar seus pagamentos, confirme em uma mensagem: nome completo ou razão social, CPF/CNPJ e e-mail cadastrado. A confirmação vale apenas para seus próprios assuntos financeiros.';
 v_help text:='Não consegui confirmar o cadastro com segurança por aqui. Vou pedir à equipe que confira seu atendimento antes de consultar valores.';
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' then raise exception 'SERVICE_REQUIRED' using errcode='42501';end if;
 if p_action not in('probe','start','consult') or length(coalesce(p_reference,''))>100 then raise exception 'FINANCE_REQUEST_INVALID';end if;
 select * into j from crm_private.arisa_whatsapp_reply_jobs where id=p_job for update;
 if j.id is null or j.lease is distinct from p_lease or j.status<>'processing' or j.lease_until<=now() then raise exception 'WHATSAPP_REPLY_LEASE_CHANGED';end if;
 select * into t from public.arisa_whatsapp_threads where id=j.thread_id and organization_id=j.organization_id for update;
 select * into m from public.arisa_whatsapp_messages where id=j.id and thread_id=t.id and direction='inbound';
 if m.id is null or t.opted_out_at is not null or not exists(select 1 from crm_private.arisa_whatsapp_channel where organization_id=j.organization_id and enabled and auto_reply_enabled) then raise exception 'FINANCE_CHANNEL_UNAVAILABLE';end if;
 select coalesce(jsonb_agg(message_id),'[]'::jsonb) into redacted from crm_private.arisa_whatsapp_finance_events where thread_id=t.id and organization_id=j.organization_id and contains_identity;
 select * into cached from crm_private.arisa_whatsapp_finance_events where message_id=j.id;
 select * into s from crm_private.arisa_whatsapp_finance_sessions where thread_id=t.id for update;
 if private.arisa_finance_valid(t.id,j.organization_id) then
  if p_action<>'consult' then
   return jsonb_build_object('verified',true,'handled',false,'redacted_message_ids',redacted)
    || case when cached.result->>'just_verified'='true' then jsonb_build_object('just_verified',true,'request',s.original_request) else '{}'::jsonb end;
  end if;
  select * into c from public.contacts where id=s.contact_id and organization_id=j.organization_id;
  -- Only finalized customer receivables or supplier payables belonging to this exact contact.
  -- Internal notes, bank balances, risk, other contacts, drafts and provisions are never selected.
  select count(*) into v_total from public.financial_entries e where e.organization_id=j.organization_id and e.contact_id=c.id
    and e.type=case when c.contact_type='cliente' then 'entrada' else 'saida' end
    and e.status in('pendente','vencido','pago','recebido','cancelado') and coalesce(e.is_provision,false)=false
    and (coalesce(p_reference,'')='' or private.arisa_name_key(e.document_number)=private.arisa_name_key(p_reference));
  select coalesce(jsonb_agg(to_jsonb(entry)),'[]'::jsonb) into v_rows from(
    select e.document_number,e.installment_number,e.installment_total,e.amount,e.open_amount,e.due_date,e.status,e.settlement_date,
      case when e.approval_status='aprovado' and e.status in('pendente','vencido') then e.scheduled_payment_date else null end as scheduled_payment_date
    from public.financial_entries e where e.organization_id=j.organization_id and e.contact_id=c.id
      and e.type=case when c.contact_type='cliente' then 'entrada' else 'saida' end
      and e.status in('pendente','vencido','pago','recebido','cancelado') and coalesce(e.is_provision,false)=false
      and (coalesce(p_reference,'')='' or private.arisa_name_key(e.document_number)=private.arisa_name_key(p_reference))
    order by case when e.status in('pendente','vencido') then 0 else 1 end,case when e.status in('pendente','vencido') then e.due_date end asc nulls last,e.due_date desc,e.id limit 20
  )entry;
  insert into crm_private.arisa_whatsapp_finance_events(message_id,organization_id,thread_id,contact_id,disclosed)
   values(j.id,j.organization_id,t.id,c.id,true) on conflict(message_id) do update set disclosed=true,contact_id=excluded.contact_id;
  return jsonb_build_object('verified',true,'scope','own_contact_only','contact_name',c.name,'contact_type',c.contact_type,
    'entries',v_rows,'total',v_total,'truncated',v_total>20,'as_of',now(),'changes_allowed',false,'negotiation_policy','proposal_requires_administrator_approval');
 end if;
 if p_action='consult' then raise exception 'FINANCE_IDENTITY_REQUIRED' using errcode='42501';end if;
 if cached.message_id is not null and coalesce(cached.result->>'just_verified','false')<>'true' then
  return cached.result||jsonb_build_object('redacted_message_ids',redacted);
 end if;
 if s.stage='verified' then
  update crm_private.arisa_whatsapp_finance_sessions set stage='closed',verified_until=null where thread_id=t.id;
  s.stage='closed';
 end if;
 if p_action='probe' and (s.thread_id is null or s.stage not in('awaiting','locked')) then
  return jsonb_build_object('verified',false,'handled',false,'redacted_message_ids',redacted);
 end if;
 if s.locked_until>now() then
  v_result=jsonb_build_object('verified',false,'handled',true,'reply','A confirmação está temporariamente bloqueada após tentativas divergentes. A equipe pode dar continuidade ao atendimento.','escalate',false);
 else
  select array_agg(contact.id) into ids from public.contacts contact where contact.organization_id=j.organization_id and contact.active
   and private.arisa_finance_contact_phone(contact.phone,contact.country)=any(crm_private.whatsapp_phone_variants(t.phone));
  if cardinality(ids)=1 then select * into c from public.contacts where id=ids[1] and contact_type in('cliente','fornecedor') and do_not_contact_at is null;end if;
  v_ready=c.id is not null and length(trim(coalesce(c.name,'')))>=3 and length(regexp_replace(coalesce(c.document,''),'[^0-9]','','g')) in(11,14)
   and coalesce(c.email,'') ~* '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$';
  if not coalesce(v_ready,false) then
   v_result=jsonb_build_object('verified',false,'handled',true,'reply',v_help,'escalate',true);
   update crm_private.arisa_whatsapp_finance_sessions set stage='closed',verified_until=null where thread_id=t.id;
  else
   if s.thread_id is null then
    insert into crm_private.arisa_whatsapp_finance_sessions(thread_id,organization_id,contact_id,original_request,challenge_until)
     values(t.id,j.organization_id,c.id,left(m.content,3000),now()+interval '15 minutes') returning * into s;
   elsif p_action='start' and (s.stage<>'awaiting' or s.challenge_until<=now()) then
    update crm_private.arisa_whatsapp_finance_sessions set contact_id=c.id,stage='awaiting',original_request=left(m.content,3000),
      challenge_until=now()+interval '15 minutes',verified_until=null,
      failed_attempts=case when attempt_window<=now()-interval '24 hours' then 0 else failed_attempts end,
      attempt_window=case when attempt_window<=now()-interval '24 hours' then now() else attempt_window end,updated_at=now()
     where thread_id=t.id returning * into s;
   end if;
   if s.stage='awaiting' and s.challenge_until<=now() then
    update crm_private.arisa_whatsapp_finance_sessions set stage='closed' where thread_id=t.id;
    v_result=jsonb_build_object('verified',false,'handled',true,'reply','A confirmação expirou. Diga qual assunto financeiro deseja tratar para começarmos novamente.');
   elsif private.arisa_name_key(m.content) in('cancelar','cancelar verificacao','outro assunto','depois') then
    update crm_private.arisa_whatsapp_finance_sessions set stage='closed' where thread_id=t.id;
    v_result=jsonb_build_object('verified',false,'handled',true,'reply','Tudo bem. Qual assunto você quer tratar agora?');
   else
    select lower(matches[1]) into v_email from regexp_matches(m.content,'([A-Za-z0-9.!#$%&''*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+[.][A-Za-z]{2,})','g') matches limit 1;
    select regexp_replace(matches[1],'[^0-9]','','g') into v_doc from regexp_matches(m.content,'([0-9]{3}[.][0-9]{3}[.][0-9]{3}-[0-9]{2}|[0-9]{2}[.][0-9]{3}[.][0-9]{3}/[0-9]{4}-[0-9]{2}|[0-9]{14}|[0-9]{11})','g') matches limit 1;
    v_name=private.arisa_name_key(m.content);v_identity=v_doc is not null or v_email is not null;
    if v_doc is not null and v_email is not null then
     if v_doc=regexp_replace(c.document,'[^0-9]','','g') and v_email=lower(trim(c.email))
       and position(' '||private.arisa_name_key(c.name)||' ' in ' '||v_name||' ')>0 then
      update crm_private.arisa_whatsapp_finance_sessions set stage='verified',contact_id=c.id,fingerprint=private.arisa_finance_fingerprint(c),
       verified_until=now()+interval '30 minutes',updated_at=now() where thread_id=t.id;
      v_result=jsonb_build_object('verified',true,'handled',false,'just_verified',true,'request',s.original_request);
     else
      update crm_private.arisa_whatsapp_finance_sessions set failed_attempts=failed_attempts+1,
       stage=case when failed_attempts+1>=3 then 'locked' else 'awaiting' end,
       locked_until=case when failed_attempts+1>=3 then now()+interval '24 hours' else null end,updated_at=now()
       where thread_id=t.id returning * into s;
      v_result=jsonb_build_object('verified',false,'handled',true,'escalate',s.stage='locked','reply',
       case when s.stage='locked' then v_help else 'Os dados não conferiram em conjunto. Confira nome completo ou razão social, CPF/CNPJ e e-mail cadastrados e envie os três novamente. Você também pode cancelar a confirmação.' end);
     end if;
    else
     v_result=jsonb_build_object('verified',false,'handled',true,'reply',v_ask);
    end if;
   end if;
  end if;
 end if;
 insert into crm_private.arisa_whatsapp_finance_events(message_id,organization_id,thread_id,contact_id,contains_identity,result)
  values(j.id,j.organization_id,t.id,case when v_result->>'verified'='true' then c.id else null end,v_identity,v_result)
  on conflict(message_id) do update set result=excluded.result,contact_id=excluded.contact_id,contains_identity=excluded.contains_identity;
 if v_identity then redacted=redacted||jsonb_build_array(j.id);end if;
 return v_result||jsonb_build_object('redacted_message_ids',redacted);
end $$;
revoke all on function public.arisa_whatsapp_finance(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.arisa_whatsapp_finance(uuid,uuid,text,text) to service_role;
