-- Arisa Operações: ingestão com evidência, cadastro pendente e vínculo de extrato.
-- Nenhuma rotina desta migração autoriza, executa ou dá baixa em pagamentos.
begin;
set local lock_timeout = '10s';
set local statement_timeout = '120s';

create table public.arisa_operation_policies (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  auto_register_complete_documents boolean not null default false,
  max_auto_amount numeric(15,2) not null default 5000 check (max_auto_amount > 0 and max_auto_amount <= 1000000),
  updated_by uuid references auth.users(id), updated_at timestamptz not null default now()
);
create table public.arisa_operation_items (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null references public.organizations(id),
  input_kind text not null check (input_kind in ('payable','bank_statement')),
  storage_path text not null unique, file_name text not null, mime_type text not null,
  size_bytes bigint not null check (size_bytes > 0 and size_bytes <= 8388608),
  file_hash text not null check (file_hash ~ '^[a-f0-9]{64}$'),
  status text not null default 'received' check (status in ('received','processing','needs_information','needs_decision','completed','failed','dismissed')),
  payload jsonb not null default '{}' check (jsonb_typeof(payload)='object'),
  extracted jsonb not null default '{}' check (jsonb_typeof(extracted)='object'),
  outcome jsonb not null default '{}' check (jsonb_typeof(outcome)='object'),
  issues jsonb not null default '[]' check (jsonb_typeof(issues)='array'),
  entry_id uuid references public.financial_entries(id), created_by uuid not null references auth.users(id),
  lease_token uuid, lease_expires_at timestamptz, lease_actor_user_id uuid references auth.users(id),
  attempts integer not null default 0 check (attempts >= 0),
  error_code text, error_message text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique (organization_id,file_hash,input_kind), unique(id,organization_id)
);
create table public.arisa_operation_events (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null,
  item_id uuid not null, event_type text not null, actor_user_id uuid references auth.users(id),
  details jsonb not null default '{}' check (jsonb_typeof(details)='object'), created_at timestamptz not null default now(),
  foreign key(item_id,organization_id) references public.arisa_operation_items(id,organization_id)
);
create table public.arisa_bank_transactions (
  id uuid primary key default gen_random_uuid(), organization_id uuid not null,
  item_id uuid not null, bank_account_id uuid not null references public.bank_accounts(id),
  line_number integer not null check (line_number > 0), external_id text,
  transaction_date date not null, amount numeric(15,2) not null check (amount <> 0),
  description text not null, document_number text,
  status text not null default 'unmatched' check (status in ('unmatched','matched','ambiguous')),
  matched_entry_id uuid references public.financial_entries(id), candidate_count integer not null default 0,
  match_reason text, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(item_id,organization_id) references public.arisa_operation_items(id,organization_id),
  unique(item_id,line_number), check ((status='matched') = (matched_entry_id is not null))
);
create unique index arisa_bank_external_unique on public.arisa_bank_transactions(organization_id,bank_account_id,external_id) where external_id is not null;
create unique index arisa_bank_matched_entry_unique on public.arisa_bank_transactions(matched_entry_id) where matched_entry_id is not null;
create index arisa_items_queue on public.arisa_operation_items(organization_id,status,created_at desc);
create index arisa_items_entry on public.arisa_operation_items(entry_id) where entry_id is not null;
create index arisa_items_creator on public.arisa_operation_items(created_by);
create index arisa_items_lease_actor on public.arisa_operation_items(lease_actor_user_id) where lease_actor_user_id is not null;
create index arisa_policy_actor on public.arisa_operation_policies(updated_by) where updated_by is not null;
create index arisa_events_item on public.arisa_operation_events(item_id,created_at);
create index arisa_events_org on public.arisa_operation_events(organization_id,created_at desc);
create index arisa_events_actor on public.arisa_operation_events(actor_user_id) where actor_user_id is not null;
create index arisa_bank_org_status on public.arisa_bank_transactions(organization_id,status,transaction_date);
create index arisa_bank_account on public.arisa_bank_transactions(bank_account_id);
create index arisa_financial_document_candidates on public.financial_entries(organization_id,contact_id,document_number) where status <> 'cancelado';

alter table public.arisa_operation_policies enable row level security;
alter table public.arisa_operation_items enable row level security;
alter table public.arisa_operation_events enable row level security;
alter table public.arisa_bank_transactions enable row level security;
revoke all on public.arisa_operation_policies,public.arisa_operation_items,public.arisa_operation_events,public.arisa_bank_transactions from public,anon,authenticated;
grant select on public.arisa_operation_policies,public.arisa_operation_items,public.arisa_operation_events,public.arisa_bank_transactions to authenticated;
grant all on public.arisa_operation_policies,public.arisa_operation_items,public.arisa_bank_transactions to service_role;
revoke all on public.arisa_operation_events from service_role;
grant select,insert on public.arisa_operation_events to service_role;
create policy arisa_policies_read on public.arisa_operation_policies for select to authenticated using (public.has_app_permission(organization_id,'financial.view'));
create policy arisa_items_read on public.arisa_operation_items for select to authenticated using (public.has_app_permission(organization_id,'financial.view'));
create policy arisa_events_read on public.arisa_operation_events for select to authenticated using (public.has_app_permission(organization_id,'financial.view'));
create policy arisa_transactions_read on public.arisa_bank_transactions for select to authenticated using (public.has_app_permission(organization_id,'financial.view'));

create function private.arisa_storage_access(p_name text,p_write boolean) returns boolean
language plpgsql stable security definer set search_path='' as $$
declare v_org uuid;
begin
  if split_part(p_name,'/',1) !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then return false; end if;
  v_org := split_part(p_name,'/',1)::uuid;
  if not public.has_app_permission(v_org,'financial.view') then return false; end if;
  return not p_write or (split_part(p_name,'/',2)=(select auth.uid())::text
    and public.has_app_permission(v_org,'financial.manage') and public.has_app_permission(v_org,'documents.manage'));
end $$;
revoke all on function private.arisa_storage_access(text,boolean) from public,anon;
grant execute on function private.arisa_storage_access(text,boolean) to authenticated,service_role;
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values ('arisa-operations','arisa-operations',false,8388608,
 array['application/pdf','image/jpeg','image/png','image/webp','text/csv','application/csv','text/plain','application/xml','text/xml','application/x-ofx','application/vnd.intu.qfx','application/octet-stream'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy arisa_storage_read on storage.objects for select to authenticated using (bucket_id='arisa-operations' and private.arisa_storage_access(name,false));
create policy arisa_storage_insert on storage.objects for insert to authenticated with check (bucket_id='arisa-operations' and private.arisa_storage_access(name,true));
-- Uploaded evidence is immutable after intake. Only unregistered uploads can be removed.
create policy arisa_storage_cleanup on storage.objects for delete to authenticated using (bucket_id='arisa-operations' and private.arisa_storage_access(name,true)
 and not exists(select 1 from public.arisa_operation_items i where i.storage_path=name));

create function private.arisa_assert_actor(p_org uuid,p_actor uuid,p_permission text) returns void
language plpgsql security definer set search_path='' as $$
begin
  if p_actor is null or not private.member_has_app_permission(p_org,p_actor,'financial.view')
    or not private.member_has_app_permission(p_org,p_actor,p_permission) then
    raise exception 'Sem permissão para esta operação financeira.' using errcode='42501';
  end if;
end $$;
create function private.arisa_context(p_org uuid,p_context jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_result jsonb:='{}'; v_row record; v_value text; v_ok boolean;
begin
  if p_context is null or jsonb_typeof(p_context)<>'object' then raise exception 'Contexto inválido.'; end if;
  for v_row in select * from (values ('project_id','projects'),('cost_center_id','cost_centers'),('category_id','financial_categories'),('contact_id','contacts'),('bank_account_id','bank_accounts')) m(k,t) loop
    v_value:=nullif(p_context->>v_row.k,'');
    if v_value is not null then
      if v_value !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' then raise exception 'Identificador inválido: %.',v_row.k; end if;
      execute format('select exists(select 1 from public.%I where id=$1 and organization_id=$2 and active)',v_row.t) into v_ok using v_value::uuid,p_org;
      if not v_ok then raise exception 'Cadastro indisponível nesta organização: %.',v_row.k; end if;
      v_result:=v_result||jsonb_build_object(v_row.k,v_value);
    end if;
  end loop;
  return v_result;
end $$;
create function private.arisa_date(p_value text) returns date
language plpgsql immutable set search_path='' as $$
begin
  if p_value is null or p_value !~ '^\d{4}-\d{2}-\d{2}$' then return null; end if;
  return p_value::date;
exception when others then return null;
end $$;
create function private.arisa_event(p_item public.arisa_operation_items,p_type text,p_actor uuid,p_details jsonb default '{}') returns void
language sql security definer set search_path='' as $$
  insert into public.arisa_operation_events(organization_id,item_id,event_type,actor_user_id,details)
  values(p_item.organization_id,p_item.id,p_type,p_actor,p_details)
$$;
create function private.arisa_clean_extracted(p_value jsonb,p_kind text) returns jsonb
language plpgsql set search_path='' as $$
declare v_result jsonb:='{}'; v_key text; v_warnings jsonb;
begin
  if p_value is null or jsonb_typeof(p_value)<>'object' or octet_length(p_value::text)>2000000 then raise exception 'Extração inválida ou muito extensa.'; end if;
  v_warnings:=coalesce(p_value->'warnings','[]'::jsonb);
  if jsonb_typeof(v_warnings)<>'array' or jsonb_array_length(v_warnings)>30
    or exists(select 1 from jsonb_array_elements(v_warnings) w where jsonb_typeof(w)<>'string' or length(w#>>'{}')>2000) then raise exception 'Avisos de extração inválidos.'; end if;
  if p_kind='bank_statement' then
    if coalesce(p_value->>'document_type','')<>'bank_statement' or jsonb_typeof(p_value->'transactions') is distinct from 'array'
      or jsonb_array_length(p_value->'transactions')>500 then raise exception 'Extrato inválido ou acima de 500 movimentos.'; end if;
    return jsonb_build_object('document_type','bank_statement','transactions',p_value->'transactions','warnings',v_warnings);
  end if;
  if coalesce(p_value->>'document_type','') not in ('invoice','boleto','receipt','contract','other') then raise exception 'Tipo de documento inválido.'; end if;
  foreach v_key in array array['document_type','supplier_name','supplier_document','document_number','due_date','issue_date','description'] loop
    if p_value->v_key is not null and jsonb_typeof(p_value->v_key) not in ('string','null') then raise exception 'Campo textual inválido: %.',v_key; end if;
    v_result:=v_result||jsonb_build_object(v_key,left(nullif(btrim(p_value->>v_key),''),2000));
  end loop;
  foreach v_key in array array['amount','confidence'] loop
    if p_value->v_key is not null and jsonb_typeof(p_value->v_key) not in ('number','null') then raise exception 'Campo numérico inválido: %.',v_key; end if;
    v_result:=v_result||jsonb_build_object(v_key,p_value->v_key);
  end loop;
  if (v_result->>'amount')::numeric is not null and ((v_result->>'amount')::numeric<=0 or (v_result->>'amount')::numeric>999999999999.99
    or (v_result->>'amount')::numeric<>round((v_result->>'amount')::numeric,2)) then raise exception 'Valor de documento inválido.'; end if;
  if coalesce((v_result->>'confidence')::numeric,0) not between 0 and 1 then raise exception 'Confiança inválida.'; end if;
  if jsonb_typeof(coalesce(p_value->'source_evidence','{}'))<>'object' then raise exception 'Evidências inválidas.'; end if;
  foreach v_key in array array['amount','due_date','supplier_document'] loop
    if p_value->'source_evidence'->v_key is not null and jsonb_typeof(p_value->'source_evidence'->v_key) not in ('string','null') then raise exception 'Evidência textual inválida: %.',v_key; end if;
  end loop;
  return v_result||jsonb_build_object('warnings',v_warnings,'source_evidence',coalesce(p_value->'source_evidence','{}'));
end $$;

create function public.arisa_intake_document(p_organization_id uuid,p_storage_path text,p_file_name text,p_mime_type text,p_size_bytes bigint,p_file_hash text,p_input_kind text,p_context jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_item public.arisa_operation_items; v_actor uuid:=(select auth.uid()); v_metadata jsonb; v_context jsonb; v_limit bigint;
begin
  perform private.arisa_assert_actor(p_organization_id,v_actor,'financial.manage');
  perform private.arisa_assert_actor(p_organization_id,v_actor,'documents.manage');
  if p_input_kind not in ('payable','bank_statement') or p_input_kind is null or coalesce(p_file_hash,'')!~'^[a-f0-9]{64}$'
    or nullif(btrim(p_file_name),'') is null or length(p_file_name)>255 then raise exception 'Arquivo ou finalidade inválidos.'; end if;
  select * into v_item from public.arisa_operation_items where organization_id=p_organization_id and file_hash=p_file_hash and input_kind=p_input_kind;
  if found then return to_jsonb(v_item); end if;
  if split_part(p_storage_path,'/',1)<>p_organization_id::text or split_part(p_storage_path,'/',2)<>v_actor::text
    or p_storage_path like '%..%' then raise exception 'Caminho de arquivo inválido.'; end if;
  select metadata into v_metadata from storage.objects where bucket_id='arisa-operations' and name=p_storage_path
    and coalesce(owner_id,owner::text)=v_actor::text;
  if not found then raise exception 'O arquivo enviado não foi localizado para este usuário.'; end if;
  select least(coalesce(document_max_size_mb,8),8)::bigint*1048576 into v_limit from public.system_settings where organization_id=p_organization_id;
  if p_size_bytes is null or p_size_bytes<1 or p_size_bytes>coalesce(v_limit,8388608)
    or coalesce((v_metadata->>'size')::bigint,0)<>p_size_bytes then raise exception 'Tamanho de arquivo inválido.'; end if;
  if p_mime_type is null or p_mime_type<>coalesce(v_metadata->>'mimetype','') then raise exception 'Tipo do arquivo não corresponde ao upload.'; end if;
  v_context:=private.arisa_context(p_organization_id,coalesce(p_context,'{}'));
  insert into public.arisa_operation_items(organization_id,input_kind,storage_path,file_name,mime_type,size_bytes,file_hash,payload,created_by)
  values(p_organization_id,p_input_kind,p_storage_path,p_file_name,p_mime_type,p_size_bytes,p_file_hash,v_context,v_actor)
  on conflict(organization_id,file_hash,input_kind) do nothing returning * into v_item;
  if not found then select * into v_item from public.arisa_operation_items where organization_id=p_organization_id and file_hash=p_file_hash and input_kind=p_input_kind;
  else perform private.arisa_event(v_item,'received',v_actor,jsonb_build_object('input_kind',p_input_kind)); end if;
  return to_jsonb(v_item);
end $$;

create function public.arisa_set_operation_policy(p_organization_id uuid,p_enabled boolean,p_max_amount numeric) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_policy public.arisa_operation_policies; v_actor uuid:=(select auth.uid());
begin
  perform private.arisa_assert_actor(p_organization_id,v_actor,'financial.view');
  if not (public.has_app_permission(p_organization_id,'financial.approve') or public.has_app_permission(p_organization_id,'settings.manage')) then raise exception 'Sem alçada para definir a autonomia.' using errcode='42501'; end if;
  if p_enabled is null or p_max_amount is null or p_max_amount<=0 or p_max_amount>1000000 then raise exception 'Limite inválido.'; end if;
  insert into public.arisa_operation_policies(organization_id,auto_register_complete_documents,max_auto_amount,updated_by)
  values(p_organization_id,p_enabled,p_max_amount,v_actor)
  on conflict(organization_id) do update set auto_register_complete_documents=excluded.auto_register_complete_documents,max_auto_amount=excluded.max_auto_amount,updated_by=v_actor,updated_at=now()
  returning * into v_policy;
  insert into public.audit_logs(organization_id,user_id,action,entity,entity_id,new_data)
  values(p_organization_id,v_actor,'arisa_policy_changed','arisa_operation_policies',p_organization_id::text,to_jsonb(v_policy));
  return to_jsonb(v_policy);
end $$;

create function public.arisa_claim_operation(p_item_id uuid,p_actor_user_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_item public.arisa_operation_items;
begin
  select * into v_item from public.arisa_operation_items where id=p_item_id for update;
  if not found then raise exception 'Documento não localizado.'; end if;
  perform private.arisa_assert_actor(v_item.organization_id,p_actor_user_id,'financial.manage');
  perform private.arisa_assert_actor(v_item.organization_id,p_actor_user_id,'documents.manage');
  if v_item.status not in ('received','failed','processing') then return jsonb_build_object('item',to_jsonb(v_item),'lease_token',null); end if;
  if v_item.status='processing' and v_item.lease_expires_at>now() then raise exception 'Documento já está em processamento.' using errcode='55P03'; end if;
  if v_item.attempts>=5 and v_item.updated_at>now()-interval '5 minutes' then raise exception 'Limite de tentativas atingido. Aguarde 5 minutos antes de tentar novamente.'; end if;
  update public.arisa_operation_items set status='processing',lease_token=gen_random_uuid(),lease_expires_at=now()+interval '120 seconds',
    lease_actor_user_id=p_actor_user_id,attempts=attempts+1,error_code=null,error_message=null,updated_at=now() where id=p_item_id returning * into v_item;
  perform private.arisa_event(v_item,'processing',p_actor_user_id,jsonb_build_object('attempt',v_item.attempts));
  return jsonb_build_object('item',to_jsonb(v_item),'lease_token',v_item.lease_token);
end $$;

-- Serialized per organization so repeated documents and concurrent approvals cannot race.
create function private.arisa_evaluate_payable(p_item_id uuid,p_actor uuid,p_create boolean,p_auto boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_item public.arisa_operation_items; v_context jsonb; v_data jsonb; v_issues jsonb:='[]'; v_decisions jsonb:='[]';
 v_doc text; v_contact uuid; v_contacts uuid[]; v_duplicates uuid[]; v_amount numeric; v_due date; v_issue date;
 v_policy public.arisa_operation_policies; v_entry uuid; v_category text; v_auto boolean:=false; v_supplier_doc text;
begin
  select * into v_item from public.arisa_operation_items where id=p_item_id for update;
  if v_item.entry_id is not null then return to_jsonb(v_item); end if;
  perform private.arisa_assert_actor(v_item.organization_id,p_actor,'financial.manage');
  perform pg_advisory_xact_lock(hashtextextended('arisa_finance:'||v_item.organization_id::text,0));
  v_context:=private.arisa_context(v_item.organization_id,v_item.payload)||jsonb_build_object('resolved_values',coalesce(v_item.payload->'resolved_values','{}'));
  v_data:=private.arisa_clean_extracted(v_item.extracted||coalesce(v_item.payload->'resolved_values','{}'),'payable');
  v_amount:=(v_data->>'amount')::numeric; v_due:=private.arisa_date(v_data->>'due_date'); v_issue:=private.arisa_date(v_data->>'issue_date');
  v_doc:=nullif(btrim(v_data->>'document_number'),''); v_supplier_doc:=regexp_replace(coalesce(v_data->>'supplier_document',''),'\D','','g');
  if length(v_supplier_doc) in (11,14) then
    select array_agg(id) into v_contacts from public.contacts where organization_id=v_item.organization_id and active
      and contact_type in ('fornecedor','ambos','colaborador') and regexp_replace(coalesce(document,''),'\D','','g')=v_supplier_doc;
    if cardinality(v_contacts)=1 and not (v_context ? 'contact_id') then v_context:=v_context||jsonb_build_object('contact_id',v_contacts[1]); end if;
  end if;
  v_contact:=(v_context->>'contact_id')::uuid;
  if coalesce(v_data->>'document_type','') not in ('invoice','boleto') then v_decisions:=v_decisions||jsonb_build_array('Este documento não cria obrigação: envie nota fiscal ou boleto.'); end if;
  if v_amount is null or v_amount<=0 then v_issues:=v_issues||jsonb_build_array('Informe o valor da obrigação.'); end if;
  if v_due is null then v_issues:=v_issues||jsonb_build_array('Informe a data de vencimento.'); end if;
  if v_issue is null then v_issues:=v_issues||jsonb_build_array('Informe a data de emissão.'); end if;
  if v_due<v_issue then v_issues:=v_issues||jsonb_build_array('Vencimento anterior à emissão: confira as datas.'); end if;
  if v_doc is null then v_issues:=v_issues||jsonb_build_array('Informe o número do documento.'); end if;
  if nullif(btrim(v_data->>'description'),'') is null then v_issues:=v_issues||jsonb_build_array('Informe a descrição da obrigação.'); end if;
  if v_contact is null then v_issues:=v_issues||jsonb_build_array('Selecione o fornecedor cadastrado.'); end if;
  if not (v_context ? 'category_id') then v_issues:=v_issues||jsonb_build_array('Selecione a categoria financeira.');
  elsif not exists(select 1 from public.financial_categories where id=(v_context->>'category_id')::uuid and movement_type in ('saida','ambos')) then v_issues:=v_issues||jsonb_build_array('A categoria deve permitir despesas.'); end if;
  if not (v_context ? 'project_id') then v_issues:=v_issues||jsonb_build_array('Selecione o empreendimento.'); end if;
  if not (v_context ? 'cost_center_id') then v_issues:=v_issues||jsonb_build_array('Selecione o centro de custo.'); end if;
  if v_contact is not null and not exists(select 1 from public.contacts where id=v_contact and contact_type in ('fornecedor','ambos','colaborador')) then v_issues:=v_issues||jsonb_build_array('O contato selecionado não está cadastrado como fornecedor.'); end if;
  if v_contact is not null and length(v_supplier_doc) in (11,14) and not exists(select 1 from public.contacts where id=v_contact and regexp_replace(coalesce(document,''),'\D','','g')=v_supplier_doc) then v_issues:=v_issues||jsonb_build_array('O CPF/CNPJ extraído diverge do fornecedor selecionado.'); end if;
  if exists(select 1 from public.organizations where id=v_item.organization_id and regexp_replace(coalesce(document,''),'\D','','g')=v_supplier_doc and v_supplier_doc<>'') then v_issues:=v_issues||jsonb_build_array('O emitente é a própria organização. Confira o documento.'); end if;
  select array_agg(f.id) into v_duplicates from public.financial_entries f
    where f.organization_id=v_item.organization_id and f.status<>'cancelado' and f.type='saida' and v_contact is not null
      and (f.contact_id=v_contact or exists(select 1 from public.contacts other join public.contacts chosen on chosen.id=v_contact
        where other.id=f.contact_id and other.organization_id=v_item.organization_id and length(regexp_replace(coalesce(chosen.document,''),'\D','','g')) in (11,14)
          and regexp_replace(coalesce(other.document,''),'\D','','g')=regexp_replace(coalesce(chosen.document,''),'\D','','g')))
      and ((v_doc is not null and lower(btrim(f.document_number))=lower(v_doc)) or (f.amount=v_amount and f.due_date=v_due));
  if cardinality(v_duplicates)>0 then v_decisions:=v_decisions||jsonb_build_array('Possível obrigação já cadastrada. Vincule o documento ao título existente; nova criação está bloqueada.'); end if;
  select * into v_policy from public.arisa_operation_policies where organization_id=v_item.organization_id;
  v_auto:=coalesce(p_auto,false) and coalesce(v_policy.auto_register_complete_documents,false)
    and v_amount<=v_policy.max_auto_amount and jsonb_array_length(v_issues)=0 and jsonb_array_length(v_decisions)=0
    and jsonb_array_length(coalesce(v_data->'warnings','[]'))=0 and coalesce((v_data->>'confidence')::numeric,0)>=0.95
    and cardinality(v_contacts)=1 and v_contacts[1]=v_contact
    and length(coalesce(v_data#>>'{source_evidence,amount}',''))>0
    and length(coalesce(v_data#>>'{source_evidence,due_date}',''))>0
    and regexp_replace(coalesce(v_data#>>'{source_evidence,supplier_document}',''),'\D','','g')=v_supplier_doc;
  update public.arisa_operation_items set payload=v_context,issues=v_issues||v_decisions||coalesce(v_data->'warnings','[]'),
    outcome=jsonb_build_object('duplicate_entry_ids',coalesce(to_jsonb(v_duplicates),'[]'),'auto_registration_eligible',coalesce(v_auto,false)),
    status=case when jsonb_array_length(v_issues)>0 then 'needs_information' else 'needs_decision' end,updated_at=now() where id=p_item_id returning * into v_item;
  if (coalesce(p_create,false) or coalesce(v_auto,false)) and jsonb_array_length(v_issues)=0 and jsonb_array_length(v_decisions)=0 then
    select name into v_category from public.financial_categories where id=(v_context->>'category_id')::uuid;
    insert into public.financial_entries(organization_id,user_id,created_by,type,description,category,category_id,cost_center_id,contact_id,project_id,bank_account_id,
      amount,due_date,issue_date,competence_date,status,approval_status,document_number,source_type,source_id,source_component,notes)
    values(v_item.organization_id,p_actor,p_actor,'saida',v_data->>'description',v_category,(v_context->>'category_id')::uuid,
      (v_context->>'cost_center_id')::uuid,v_contact,(v_context->>'project_id')::uuid,(v_context->>'bank_account_id')::uuid,
      v_amount,v_due,v_issue,v_issue,'pendente','pendente',v_doc,'arisa_document',p_item_id,'payable','Documento e evidências na central Arisa Operações.') returning id into v_entry;
    insert into public.approval_requests(organization_id,entry_id,requested_by,status,reason)
    values(v_item.organization_id,v_entry,p_actor,'pendente','Obrigação preparada pela Arisa. Validar documento, alçada e disponibilidade antes de programar.');
    update public.arisa_operation_items set entry_id=v_entry,status='completed',issues='[]',updated_at=now(),
      outcome=outcome||jsonb_build_object('action','payable_registered','entry_id',v_entry,'approval_status','pendente','automatic',coalesce(v_auto,false)) where id=p_item_id returning * into v_item;
    perform private.arisa_event(v_item,'payable_registered',p_actor,jsonb_build_object('entry_id',v_entry,'automatic',coalesce(v_auto,false),'approval_status','pendente'));
  end if;
  return to_jsonb(v_item);
end $$;

create function public.arisa_resolve_payable(p_item_id uuid,p_values jsonb,p_create boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_item public.arisa_operation_items; v_actor uuid:=(select auth.uid()); v_values jsonb; v_key text; v_data jsonb; v_resolved jsonb;
begin
  select * into v_item from public.arisa_operation_items where id=p_item_id for update;
  if not found then raise exception 'Documento não localizado.'; end if;
  perform private.arisa_assert_actor(v_item.organization_id,v_actor,'financial.manage');
  if v_item.input_kind<>'payable' then raise exception 'Esta operação não é uma obrigação.'; end if;
  if v_item.entry_id is not null then return to_jsonb(v_item); end if;
  if v_item.status not in ('needs_information','needs_decision') then raise exception 'Aguarde a leitura antes de revisar o documento.'; end if;
  if p_values is null or jsonb_typeof(p_values)<>'object' then raise exception 'Revisão inválida.'; end if;
  v_values:=private.arisa_context(v_item.organization_id,v_item.payload||p_values); v_resolved:=coalesce(v_item.payload->'resolved_values','{}');
  foreach v_key in array array['supplier_name','supplier_document','document_number','due_date','issue_date','description','amount'] loop
    if p_values ? v_key then v_resolved:=v_resolved||jsonb_build_object(v_key,p_values->v_key); end if;
  end loop;
  v_data:=private.arisa_clean_extracted(v_item.extracted||v_resolved,'payable');
  v_values:=v_values||jsonb_build_object('resolved_values',v_resolved);
  update public.arisa_operation_items set payload=v_values,updated_at=now() where id=p_item_id returning * into v_item;
  perform private.arisa_event(v_item,'human_review',v_actor,jsonb_build_object('create_requested',coalesce(p_create,false),'changed_fields',(select jsonb_agg(key) from jsonb_object_keys(p_values) key)));
  return private.arisa_evaluate_payable(p_item_id,v_actor,coalesce(p_create,false),false);
end $$;

create function public.arisa_link_existing_payable(p_item_id uuid,p_entry_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_item public.arisa_operation_items; v_entry public.financial_entries; v_actor uuid:=(select auth.uid()); v_data jsonb;
begin
  select * into v_item from public.arisa_operation_items where id=p_item_id for update;
  if not found then raise exception 'Documento não localizado.'; end if;
  perform private.arisa_assert_actor(v_item.organization_id,v_actor,'financial.manage');
  if v_item.entry_id=p_entry_id then return to_jsonb(v_item); end if;
  if v_item.input_kind<>'payable' or v_item.status not in ('needs_information','needs_decision') or v_item.entry_id is not null then raise exception 'Documento indisponível para vínculo.'; end if;
  perform private.arisa_evaluate_payable(p_item_id,v_actor,false,false);
  select * into v_item from public.arisa_operation_items where id=p_item_id;
  v_data:=v_item.extracted||coalesce(v_item.payload->'resolved_values','{}');
  select * into v_entry from public.financial_entries where id=p_entry_id and organization_id=v_item.organization_id and type='saida' and status<>'cancelado' for key share;
  if not found or not (coalesce(v_item.outcome->'duplicate_entry_ids','[]') ? p_entry_id::text) then raise exception 'O título não corresponde às evidências do documento.'; end if;
  if v_entry.contact_id is distinct from (v_item.payload->>'contact_id')::uuid
    or v_entry.amount is distinct from (v_data->>'amount')::numeric
    or nullif(lower(btrim(v_data->>'document_number')),'') is null
    or lower(btrim(v_entry.document_number)) is distinct from lower(btrim(v_data->>'document_number')) then
    raise exception 'Vínculo exige fornecedor, número do documento e valor iguais ao título. Confira a possível duplicidade.';
  end if;
  update public.arisa_operation_items set entry_id=p_entry_id,status='completed',issues='[]',updated_at=now(),
    outcome=outcome||jsonb_build_object('action','linked_existing','entry_id',p_entry_id) where id=p_item_id returning * into v_item;
  perform private.arisa_event(v_item,'linked_existing',v_actor,jsonb_build_object('entry_id',p_entry_id));
  return to_jsonb(v_item);
end $$;

create function private.arisa_match_statement(p_item_id uuid,p_actor uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_item public.arisa_operation_items; v_context jsonb; v_tx public.arisa_bank_transactions; v_existing public.arisa_bank_transactions; v_row record; v_candidates uuid[];
 v_account uuid; v_amount numeric; v_date date; v_reference text; v_unmatched integer; v_matched integer; v_ambiguous integer; v_duplicates integer:=0; v_conflicts integer:=0; v_issues jsonb:='[]';
begin
  select * into v_item from public.arisa_operation_items where id=p_item_id for update;
  perform private.arisa_assert_actor(v_item.organization_id,p_actor,'financial.manage');
  perform pg_advisory_xact_lock(hashtextextended('arisa_finance:'||v_item.organization_id::text,0));
  v_context:=private.arisa_context(v_item.organization_id,v_item.payload); v_account:=(v_context->>'bank_account_id')::uuid;
  if v_account is null then
    update public.arisa_operation_items set status='needs_information',issues='["Selecione a conta bancária do extrato."]',updated_at=now() where id=p_item_id returning * into v_item;
    return to_jsonb(v_item);
  end if;
  for v_row in select value,ordinality from jsonb_array_elements(coalesce(v_item.extracted->'transactions','[]')) with ordinality loop
    if jsonb_typeof(v_row.value)<>'object' or jsonb_typeof(v_row.value->'amount') is distinct from 'number' then raise exception 'Movimento de extrato inválido na linha %.',v_row.ordinality; end if;
    v_amount:=(v_row.value->>'amount')::numeric; v_date:=private.arisa_date(v_row.value->>'posted_on');
    if v_amount=0 or abs(v_amount)>999999999999.99 or v_amount<>round(v_amount,2) or v_date is null then raise exception 'Valor ou data inválida na linha %.',v_row.ordinality; end if;
    if v_row.value->'external_id' is not null and jsonb_typeof(v_row.value->'external_id') not in ('null','string') then raise exception 'Identificador bancário inválido.'; end if;
    if length(coalesce(v_row.value->>'external_id',''))>256 or length(coalesce(v_row.value->>'document_reference',''))>200 then raise exception 'Identificador ou referência bancária muito extensa.'; end if;
    if nullif(btrim(v_row.value->>'description'),'') is null then raise exception 'Descrição bancária ausente.'; end if;
    insert into public.arisa_bank_transactions(organization_id,item_id,bank_account_id,line_number,external_id,transaction_date,amount,description,document_number)
    values(v_item.organization_id,p_item_id,v_account,v_row.ordinality,nullif(left(btrim(v_row.value->>'external_id'),256),''),v_date,v_amount,left(v_row.value->>'description',2000),nullif(left(btrim(v_row.value->>'document_reference'),200),''))
    on conflict do nothing returning * into v_tx;
    if not found then
      if not exists(select 1 from public.arisa_bank_transactions where item_id=p_item_id and line_number=v_row.ordinality) then
        select * into v_existing from public.arisa_bank_transactions where organization_id=v_item.organization_id and bank_account_id=v_account
          and external_id=nullif(btrim(v_row.value->>'external_id'),'');
        if found and (v_existing.amount is distinct from v_amount or v_existing.transaction_date is distinct from v_date
          or v_existing.document_number is distinct from nullif(btrim(v_row.value->>'document_reference'),'')) then
          v_conflicts:=v_conflicts+1;
          v_issues:=v_issues||jsonb_build_array(format('Linha %s: identificador bancário já importado com valor, data ou referência divergente. Conferência necessária.',v_row.ordinality));
        else v_duplicates:=v_duplicates+1; end if;
      end if;
      continue;
    end if;
    perform private.arisa_event(v_item,'bank_transaction_imported',p_actor,jsonb_build_object('transaction_id',v_tx.id,'line_number',v_row.ordinality));
  end loop;
  for v_tx in select * from public.arisa_bank_transactions where item_id=p_item_id and status<>'matched' order by line_number for update loop
    v_reference:=nullif(regexp_replace(lower(coalesce(v_tx.document_number,'')),'[^a-z0-9]','','g'),'');
    v_candidates:=null;
    -- A value/date coincidence alone never constitutes a document match.
    if length(v_reference)>=3 then
      select array_agg(f.id) into v_candidates from public.financial_entries f
      where f.organization_id=v_item.organization_id and f.bank_account_id=v_account and f.amount=abs(v_tx.amount)
        and f.type=case when v_tx.amount<0 then 'saida' else 'entrada' end
        and f.status in ('pendente','vencido') and f.approval_status='aprovado' and not f.payment_blocked and not f.is_provision
        and f.source_type is distinct from 'fuel_request' and coalesce(f.source_type,'') not like 'contract_%'
        and f.due_date between v_tx.transaction_date-3 and v_tx.transaction_date+3
        and regexp_replace(lower(coalesce(f.document_number,'')),'[^a-z0-9]','','g')=v_reference
        and not exists(select 1 from public.arisa_bank_transactions other where other.matched_entry_id=f.id);
    end if;
    if cardinality(v_candidates)=1 then
      update public.arisa_bank_transactions set status='matched',matched_entry_id=v_candidates[1],candidate_count=1,match_reason='Conta, valor, direção, data e referência documental correspondem. Baixa financeira não executada.',updated_at=now() where id=v_tx.id;
      perform private.arisa_event(v_item,'bank_evidence_matched',p_actor,jsonb_build_object('transaction_id',v_tx.id,'entry_id',v_candidates[1],'settled',false));
    else
      update public.arisa_bank_transactions set status=case when cardinality(v_candidates)>1 then 'ambiguous' else 'unmatched' end,candidate_count=coalesce(cardinality(v_candidates),0),
        match_reason=case when cardinality(v_candidates)>1 then 'Mais de um título compatível. Conferência humana necessária.' else 'Sem correspondência documental inequívoca. Conferência humana necessária.' end,updated_at=now() where id=v_tx.id;
    end if;
  end loop;
  select count(*) filter(where status='matched'),count(*) filter(where status='unmatched'),count(*) filter(where status='ambiguous') into v_matched,v_unmatched,v_ambiguous from public.arisa_bank_transactions where item_id=p_item_id;
  if v_unmatched+v_ambiguous>0 then v_issues:=v_issues||jsonb_build_array('Há movimentos sem correspondência inequívoca. Confira o extrato e os títulos.'); end if;
  if v_duplicates>0 then v_issues:=v_issues||jsonb_build_array('Movimentos com identificador bancário já importado foram preservados no extrato anterior.'); end if;
  if jsonb_array_length(coalesce(v_item.extracted->'transactions','[]'))=0 then v_issues:=v_issues||jsonb_build_array('Nenhum movimento foi extraído. Confira o arquivo.'); end if;
  v_issues:=v_issues||coalesce(v_item.extracted->'warnings','[]');
  update public.arisa_operation_items set status=case when jsonb_array_length(v_issues)>0 then 'needs_decision' else 'completed' end,
    issues=v_issues,outcome=jsonb_build_object('action','bank_evidence_reviewed','matched',v_matched,'unmatched',v_unmatched,'ambiguous',v_ambiguous,'previously_imported',v_duplicates,'identifier_conflicts',v_conflicts,'settled',false),updated_at=now()
    where id=p_item_id returning * into v_item;
  return to_jsonb(v_item);
end $$;

create function public.arisa_reconcile_statement(p_item_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_item public.arisa_operation_items; v_actor uuid:=(select auth.uid());
begin
  select * into v_item from public.arisa_operation_items where id=p_item_id for update;
  if not found then raise exception 'Extrato não localizado.'; end if;
  perform private.arisa_assert_actor(v_item.organization_id,v_actor,'financial.manage');
  if v_item.input_kind<>'bank_statement' or v_item.status not in ('needs_information','needs_decision','completed') then raise exception 'Extrato indisponível para conferência.'; end if;
  return private.arisa_match_statement(p_item_id,v_actor);
end $$;
create function public.arisa_set_statement_account(p_item_id uuid,p_bank_account_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_item public.arisa_operation_items; v_context jsonb; v_actor uuid:=(select auth.uid());
begin
  select * into v_item from public.arisa_operation_items where id=p_item_id for update;
  if not found then raise exception 'Extrato não localizado.'; end if;
  perform private.arisa_assert_actor(v_item.organization_id,v_actor,'financial.manage');
  if v_item.input_kind<>'bank_statement' or v_item.status not in ('needs_information','needs_decision') then raise exception 'Extrato indisponível.'; end if;
  if exists(select 1 from public.arisa_bank_transactions where item_id=p_item_id) then raise exception 'A conta de movimentos já importados não pode ser trocada.'; end if;
  v_context:=private.arisa_context(v_item.organization_id,v_item.payload||jsonb_build_object('bank_account_id',p_bank_account_id));
  update public.arisa_operation_items set payload=v_context,updated_at=now() where id=p_item_id returning * into v_item;
  perform private.arisa_event(v_item,'statement_account_selected',v_actor,jsonb_build_object('bank_account_id',p_bank_account_id));
  return private.arisa_match_statement(p_item_id,v_actor);
end $$;

create function public.arisa_finish_extraction(p_item_id uuid,p_lease_token uuid,p_extracted jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_item public.arisa_operation_items; v_extracted jsonb; v_actor uuid; v_result jsonb;
begin
  select * into v_item from public.arisa_operation_items where id=p_item_id for update;
  if not found then raise exception 'Documento não localizado.'; end if;
  if p_lease_token is null or v_item.lease_token is distinct from p_lease_token then raise exception 'Reserva de processamento inválida.'; end if;
  if v_item.status<>'processing' then return to_jsonb(v_item); end if;
  if v_item.lease_expires_at<now() then raise exception 'Reserva de processamento expirada.'; end if;
  v_actor:=v_item.lease_actor_user_id;
  perform private.arisa_assert_actor(v_item.organization_id,v_actor,'financial.manage');
  perform private.arisa_assert_actor(v_item.organization_id,v_actor,'documents.manage');
  v_extracted:=private.arisa_clean_extracted(p_extracted,v_item.input_kind);
  update public.arisa_operation_items set extracted=v_extracted,status='needs_information',lease_expires_at=null,error_code=null,error_message=null,updated_at=now() where id=p_item_id returning * into v_item;
  perform private.arisa_event(v_item,'extracted',v_actor,jsonb_build_object('document_type',v_extracted->>'document_type'));
  if v_item.input_kind='payable' then v_result:=private.arisa_evaluate_payable(p_item_id,v_actor,false,true);
  else v_result:=private.arisa_match_statement(p_item_id,v_actor); end if;
  return v_result;
end $$;
create function public.arisa_fail_operation(p_item_id uuid,p_lease_token uuid,p_error_code text,p_error_message text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_item public.arisa_operation_items;
begin
  select * into v_item from public.arisa_operation_items where id=p_item_id for update;
  if not found or p_lease_token is null or v_item.lease_token is distinct from p_lease_token then raise exception 'Reserva de processamento inválida.'; end if;
  if v_item.status<>'processing' then return to_jsonb(v_item); end if;
  update public.arisa_operation_items set status='failed',lease_expires_at=null,error_code=left(coalesce(p_error_code,'extraction_failed'),80),
    error_message=left(coalesce(p_error_message,'Não foi possível ler o documento.'),1000),updated_at=now() where id=p_item_id returning * into v_item;
  perform private.arisa_event(v_item,'failed',v_item.lease_actor_user_id,jsonb_build_object('error_code',v_item.error_code));
  return to_jsonb(v_item);
end $$;
create function public.arisa_dismiss_operation(p_item_id uuid,p_reason text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare v_item public.arisa_operation_items; v_actor uuid:=(select auth.uid());
begin
  select * into v_item from public.arisa_operation_items where id=p_item_id for update;
  if not found then raise exception 'Documento não localizado.'; end if;
  perform private.arisa_assert_actor(v_item.organization_id,v_actor,'financial.manage');
  if v_item.status='dismissed' then return to_jsonb(v_item); end if;
  if v_item.status in ('processing','completed') or v_item.entry_id is not null then raise exception 'Esta operação não pode ser descartada.'; end if;
  if length(btrim(coalesce(p_reason,'')))<5 then raise exception 'Informe o motivo do descarte.'; end if;
  update public.arisa_operation_items set status='dismissed',updated_at=now(),outcome=outcome||jsonb_build_object('dismiss_reason',left(p_reason,1000)) where id=p_item_id returning * into v_item;
  perform private.arisa_event(v_item,'dismissed',v_actor,jsonb_build_object('reason',left(p_reason,1000)));
  return to_jsonb(v_item);
end $$;

-- These SECURITY DEFINER endpoints are the only write interface. Private helpers
-- have no grants to browser roles; extraction endpoints belong only to the worker.
revoke all on function private.arisa_assert_actor(uuid,uuid,text),private.arisa_context(uuid,jsonb),private.arisa_date(text),private.arisa_event(public.arisa_operation_items,text,uuid,jsonb),private.arisa_clean_extracted(jsonb,text),private.arisa_evaluate_payable(uuid,uuid,boolean,boolean),private.arisa_match_statement(uuid,uuid) from public,anon,authenticated;
revoke all on function public.arisa_intake_document(uuid,text,text,text,bigint,text,text,jsonb),public.arisa_set_operation_policy(uuid,boolean,numeric),public.arisa_resolve_payable(uuid,jsonb,boolean),public.arisa_link_existing_payable(uuid,uuid),public.arisa_reconcile_statement(uuid),public.arisa_set_statement_account(uuid,uuid),public.arisa_dismiss_operation(uuid,text) from public,anon;
grant execute on function public.arisa_intake_document(uuid,text,text,text,bigint,text,text,jsonb),public.arisa_set_operation_policy(uuid,boolean,numeric),public.arisa_resolve_payable(uuid,jsonb,boolean),public.arisa_link_existing_payable(uuid,uuid),public.arisa_reconcile_statement(uuid),public.arisa_set_statement_account(uuid,uuid),public.arisa_dismiss_operation(uuid,text) to authenticated;
revoke all on function public.arisa_claim_operation(uuid,uuid),public.arisa_finish_extraction(uuid,uuid,jsonb),public.arisa_fail_operation(uuid,uuid,text,text) from public,anon,authenticated;
grant execute on function public.arisa_claim_operation(uuid,uuid),public.arisa_finish_extraction(uuid,uuid,jsonb),public.arisa_fail_operation(uuid,uuid,text,text) to service_role;

comment on table public.arisa_bank_transactions is 'Evidência bancária importada. Vínculo documental não altera saldo, aprovação ou baixa do título.';
comment on table public.arisa_operation_items is 'Fila financeira da Arisa. Documento original privado, leitura estruturada e decisões auditadas.';
notify pgrst,'reload schema';
commit;
