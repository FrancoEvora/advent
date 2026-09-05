begin;

create or replace function private.arisa_is_admin(p_org uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select auth.uid() is not null and exists(
    select 1 from public.organization_members m join public.organizations o on o.id=m.organization_id
    where m.organization_id=p_org and m.user_id=auth.uid() and m.active and m.role='admin' and o.active
  );
$$;
revoke all on function private.arisa_is_admin(uuid) from public,anon;
grant execute on function private.arisa_is_admin(uuid) to authenticated,service_role;

create table public.arisa_chat_threads(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id),
  owner_user_id uuid not null references auth.users(id),
  title text not null default 'Conversa com a Arisa' check(char_length(title) between 1 and 150),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(id,organization_id,owner_user_id)
);
create table public.arisa_chat_files(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null, owner_user_id uuid not null, thread_id uuid not null,
  storage_path text not null unique, file_name text not null, mime_type text not null,
  size_bytes bigint not null check(size_bytes between 1 and 8388608),
  file_hash text not null check(file_hash ~ '^[a-f0-9]{64}$'),
  operation_item_id uuid references public.arisa_operation_items(id),
  created_at timestamptz not null default now(),
  foreign key(thread_id,organization_id,owner_user_id) references public.arisa_chat_threads(id,organization_id,owner_user_id),
  unique(id,organization_id,owner_user_id)
);
create table public.arisa_chat_messages(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null, owner_user_id uuid not null, thread_id uuid not null,
  role text not null check(role in ('user','assistant')),
  content text not null check(char_length(content)<=30000),
  file_ids uuid[] not null default '{}',
  parent_id uuid unique references public.arisa_chat_messages(id),
  status text not null default 'queued' check(status in ('queued','processing','completed','failed')),
  lease_token uuid, lease_expires_at timestamptz,
  metadata jsonb not null default '{}',
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  foreign key(thread_id,organization_id,owner_user_id) references public.arisa_chat_threads(id,organization_id,owner_user_id),
  unique(id,organization_id,owner_user_id)
);
create table public.arisa_chat_actions(
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null, actor_user_id uuid not null, message_id uuid not null,
  operation_key text not null check(char_length(operation_key) between 1 and 160),
  action text not null, entity text not null, record_id text, summary text not null,
  result jsonb not null, before_data jsonb, after_data jsonb,
  created_at timestamptz not null default now(),
  foreign key(message_id,organization_id,actor_user_id) references public.arisa_chat_messages(id,organization_id,owner_user_id),
  unique(message_id,operation_key)
);
create index arisa_chat_threads_owner on public.arisa_chat_threads(owner_user_id,organization_id,updated_at desc);
create index arisa_chat_threads_org on public.arisa_chat_threads(organization_id);
create index arisa_chat_files_thread on public.arisa_chat_files(thread_id,organization_id,owner_user_id);
create index arisa_chat_files_operation on public.arisa_chat_files(operation_item_id);
create index arisa_chat_messages_thread on public.arisa_chat_messages(thread_id,organization_id,owner_user_id,created_at,id);
create index arisa_chat_actions_message on public.arisa_chat_actions(message_id,organization_id,actor_user_id);
alter table public.arisa_chat_threads enable row level security;
alter table public.arisa_chat_files enable row level security;
alter table public.arisa_chat_messages enable row level security;
alter table public.arisa_chat_actions enable row level security;
revoke all on public.arisa_chat_threads,public.arisa_chat_files,public.arisa_chat_messages,public.arisa_chat_actions from anon,authenticated,service_role;
grant select on public.arisa_chat_threads,public.arisa_chat_files,public.arisa_chat_messages,public.arisa_chat_actions to authenticated;
grant select,insert,update on public.arisa_chat_threads,public.arisa_chat_files,public.arisa_chat_messages to service_role;
grant select,insert on public.arisa_chat_actions to service_role;
create policy arisa_threads_read on public.arisa_chat_threads for select to authenticated using(owner_user_id=(select auth.uid()) and private.arisa_is_admin(organization_id));
create policy arisa_files_read on public.arisa_chat_files for select to authenticated using(owner_user_id=(select auth.uid()) and private.arisa_is_admin(organization_id));
create policy arisa_messages_read on public.arisa_chat_messages for select to authenticated using(owner_user_id=(select auth.uid()) and private.arisa_is_admin(organization_id));
create policy arisa_actions_read on public.arisa_chat_actions for select to authenticated using(actor_user_id=(select auth.uid()) and private.arisa_is_admin(organization_id));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values(
  'arisa-chat','arisa-chat',false,8388608,
  array['application/pdf','image/png','image/jpeg','image/webp','application/xml','text/xml','text/plain','text/csv','application/x-ofx','audio/webm','audio/mp4','audio/mpeg','audio/wav','audio/x-wav']
);
create policy arisa_chat_storage_read on storage.objects for select to authenticated using(
  bucket_id='arisa-chat' and (storage.foldername(name))[2]=(select auth.uid())::text
  and exists(select 1 from public.arisa_chat_threads t where t.organization_id::text=(storage.foldername(name))[1] and t.id::text=(storage.foldername(name))[3] and t.owner_user_id=(select auth.uid()) and private.arisa_is_admin(t.organization_id))
);
create policy arisa_chat_storage_insert on storage.objects for insert to authenticated with check(
  bucket_id='arisa-chat' and (storage.foldername(name))[2]=(select auth.uid())::text
  and exists(select 1 from public.arisa_chat_threads t where t.organization_id::text=(storage.foldername(name))[1] and t.id::text=(storage.foldername(name))[3] and t.owner_user_id=(select auth.uid()) and private.arisa_is_admin(t.organization_id))
);
create policy arisa_chat_storage_remove_orphan on storage.objects for delete to authenticated using(
  bucket_id='arisa-chat' and owner_id=(select auth.uid())::text
  and exists(select 1 from public.arisa_chat_threads t where t.organization_id::text=(storage.foldername(name))[1] and t.id::text=(storage.foldername(name))[3] and t.owner_user_id=(select auth.uid()) and private.arisa_is_admin(t.organization_id))
  and not exists(select 1 from public.arisa_chat_files f where f.storage_path=name)
);

create or replace function public.arisa_chat_create_thread(p_organization_id uuid,p_title text default 'Conversa com a Arisa')
returns jsonb language plpgsql security definer set search_path='' as $$
declare result public.arisa_chat_threads;
begin
  if not private.arisa_is_admin(p_organization_id) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  insert into public.arisa_chat_threads(organization_id,owner_user_id,title)
  values(p_organization_id,auth.uid(),left(coalesce(nullif(btrim(p_title),''),'Conversa com a Arisa'),150)) returning * into result;
  return to_jsonb(result);
end $$;

create or replace function public.arisa_chat_register_file(p_thread_id uuid,p_path text,p_name text,p_mime text,p_size bigint,p_hash text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare thread public.arisa_chat_threads; result public.arisa_chat_files; stored_size bigint;
begin
  select * into thread from public.arisa_chat_threads where id=p_thread_id and owner_user_id=auth.uid();
  if not found or not private.arisa_is_admin(thread.organization_id) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  if p_path not like thread.organization_id::text||'/'||auth.uid()::text||'/'||thread.id::text||'/%'
    or p_path like '%..%' or char_length(p_name) not between 1 and 250 then raise exception 'Arquivo inválido.'; end if;
  select (metadata->>'size')::bigint into stored_size from storage.objects where bucket_id='arisa-chat' and name=p_path and owner_id=auth.uid()::text;
  if stored_size is null or stored_size<>p_size or p_mime not in ('application/pdf','image/png','image/jpeg','image/webp','application/xml','text/xml','text/plain','text/csv','application/x-ofx','audio/webm','audio/mp4','audio/mpeg','audio/wav','audio/x-wav') then raise exception 'Arquivo não confirmado no armazenamento.'; end if;
  insert into public.arisa_chat_files(organization_id,owner_user_id,thread_id,storage_path,file_name,mime_type,size_bytes,file_hash)
  values(thread.organization_id,auth.uid(),thread.id,p_path,p_name,p_mime,p_size,p_hash) returning * into result;
  return to_jsonb(result);
end $$;

create or replace function public.arisa_chat_send(p_thread_id uuid,p_message_id uuid,p_content text,p_file_ids uuid[] default '{}')
returns jsonb language plpgsql security definer set search_path='' as $$
declare thread public.arisa_chat_threads; result public.arisa_chat_messages;
begin
  p_file_ids:=coalesce(p_file_ids,'{}');
  select * into thread from public.arisa_chat_threads where id=p_thread_id and owner_user_id=auth.uid() for update;
  if not found or not private.arisa_is_admin(thread.organization_id) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  if char_length(coalesce(p_content,''))>6000 or (nullif(btrim(p_content),'') is null and cardinality(p_file_ids)=0) or cardinality(p_file_ids)>5 then raise exception 'Envie uma mensagem de até 6.000 caracteres e até 5 anexos.'; end if;
  if exists(select 1 from unnest(p_file_ids) f(id) where not exists(select 1 from public.arisa_chat_files a where a.id=f.id and a.thread_id=thread.id and a.owner_user_id=auth.uid())) then raise exception 'Anexo não pertence à conversa.' using errcode='42501'; end if;
  select * into result from public.arisa_chat_messages where id=p_message_id;
  if found then
    if result.thread_id<>thread.id or result.owner_user_id<>auth.uid() or result.role<>'user' or result.content<>coalesce(p_content,'') or result.file_ids<>p_file_ids then raise exception 'MESSAGE_ID_CONFLICT'; end if;
    return to_jsonb(result);
  end if;
  insert into public.arisa_chat_messages(id,organization_id,owner_user_id,thread_id,role,content,file_ids)
  values(p_message_id,thread.organization_id,auth.uid(),thread.id,'user',coalesce(p_content,''),p_file_ids) returning * into result;
  update public.arisa_chat_threads set updated_at=now(),title=case when title='Conversa com a Arisa' then left(coalesce(nullif(btrim(p_content),''),'Documentos enviados'),100) else title end where id=thread.id;
  return to_jsonb(result);
end $$;

create or replace function public.arisa_chat_claim(p_message_id uuid,p_actor_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare msg public.arisa_chat_messages; lease uuid:=gen_random_uuid();
begin
  select * into msg from public.arisa_chat_messages where id=p_message_id and owner_user_id=p_actor_user_id and role='user';
  if not found or not exists(select 1 from public.organization_members where organization_id=msg.organization_id and user_id=p_actor_user_id and active and role='admin') then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  perform 1 from public.arisa_chat_threads where id=msg.thread_id for update;
  select * into msg from public.arisa_chat_messages where id=p_message_id for update;
  if msg.status='completed' then return jsonb_build_object('message',to_jsonb(msg),'lease',null); end if;
  if exists(select 1 from public.arisa_chat_messages where thread_id=msg.thread_id and status='processing' and lease_expires_at>now()) then raise exception 'ARISA_BUSY' using errcode='55P03'; end if;
  update public.arisa_chat_messages set status='processing',lease_token=lease,lease_expires_at=now()+interval '210 seconds',updated_at=now() where id=msg.id returning * into msg;
  return jsonb_build_object('message',to_jsonb(msg),'lease',lease);
end $$;

create or replace function public.arisa_chat_finish(p_message_id uuid,p_lease uuid,p_content text,p_metadata jsonb,p_error boolean default false)
returns jsonb language plpgsql security definer set search_path='' as $$
declare msg public.arisa_chat_messages; reply public.arisa_chat_messages;
begin
  select * into msg from public.arisa_chat_messages where id=p_message_id and lease_token=p_lease and status='processing' for update;
  if not found then raise exception 'ARISA_LEASE_CHANGED'; end if;
  if not exists(select 1 from public.organization_members where organization_id=msg.organization_id and user_id=msg.owner_user_id and active and role='admin') then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  update public.arisa_chat_messages set status=case when p_error then 'failed' else 'completed' end,metadata=coalesce(p_metadata,'{}'),lease_token=null,lease_expires_at=null,updated_at=now() where id=msg.id;
  if p_error then return jsonb_build_object('status','failed','message',p_content); end if;
  insert into public.arisa_chat_messages(organization_id,owner_user_id,thread_id,role,content,parent_id,status,metadata)
  values(msg.organization_id,msg.owner_user_id,msg.thread_id,'assistant',left(p_content,30000),msg.id,'completed',coalesce(p_metadata,'{}')) returning * into reply;
  update public.arisa_chat_threads set updated_at=now() where id=msg.thread_id;
  return to_jsonb(reply);
end $$;

revoke all on function public.arisa_chat_create_thread(uuid,text),public.arisa_chat_register_file(uuid,text,text,text,bigint,text),public.arisa_chat_send(uuid,uuid,text,uuid[]) from public,anon,authenticated,service_role;
grant execute on function public.arisa_chat_create_thread(uuid,text),public.arisa_chat_register_file(uuid,text,text,text,bigint,text),public.arisa_chat_send(uuid,uuid,text,uuid[]) to authenticated;
revoke all on function public.arisa_chat_claim(uuid,uuid),public.arisa_chat_finish(uuid,uuid,text,jsonb,boolean) from public,anon,authenticated,service_role;
grant execute on function public.arisa_chat_claim(uuid,uuid),public.arisa_chat_finish(uuid,uuid,text,jsonb,boolean) to service_role;

create table private.arisa_admin_entities(
  entity text primary key, area text not null, readable text[] not null, writable text[] not null,
  can_create boolean not null default false, can_update boolean not null default false,
  can_delete boolean not null default false
);
revoke all on private.arisa_admin_entities from public,anon,authenticated;
do $catalog$
declare entity text; fields text[]; writable text[]; can_write boolean;
begin
  foreach entity in array array[
    'projects','contacts','cost_centers','financial_categories','bank_accounts','revenue_centers',
    'financial_entries','approval_requests','dre_budgets','dre_groups','financial_category_dre_map',
    'crm_records','crm_actions','crm_inventory_units','crm_proposals','crm_proposal_installments','crm_contracts',
    'crm_conversations','crm_messages','crm_alerts','crm_goals','crm_campaigns','crm_lead_sources',
    'crm_loss_reasons','crm_products','crm_pipelines','crm_stages','crm_teams','crm_team_members',
    'crm_lead_assignments','crm_lead_assignment_events','crm_opportunity_events','crm_templates',
    'crm_marketing_assets','crm_ai_jobs','crm_unit_reservations','crm_negotiation_parameters',
    'construction_work_packages','construction_daily_logs','construction_risks','construction_hseq_records',
    'construction_change_orders','purchase_requests','operational_contracts','operational_contract_items',
    'contract_measurements','contract_measurement_items','contract_measurement_periods','contract_advances',
    'contract_retentions','contract_adjustments','fuel_requests','fuel_dispenses','equipment_meter_readings',
    'hr_employees','hr_events','hr_payroll_runs','user_activities','activity_notifications',
    'post_sale_tickets','post_sale_journeys','post_sale_milestones','post_sale_inspections',
    'post_sale_deeds','post_sale_renegotiations','post_sale_collection_actions',
    'marketing_campaigns','marketing_calendar_items','marketing_requests','marketing_assets',
    'marketing_channels','marketing_personas','marketing_performance_snapshots',
    'insights','insight_metrics','insight_runs','insight_settings',
    'organization_members','role_permissions','role_access_profiles','system_settings',
    'arisa_operation_items','arisa_bank_transactions','arisa_operation_events','arisa_operation_policies'
  ] loop
    if to_regclass('public.'||entity) is null or not exists(select 1 from pg_attribute where attrelid=to_regclass('public.'||entity) and attname='organization_id' and not attisdropped) then continue; end if;
    select array_agg(a.attname order by a.attnum) into fields from pg_attribute a
      where a.attrelid=to_regclass('public.'||entity) and a.attnum>0 and not a.attisdropped
      and a.attname !~ '(token|password|secret|api_key|otp|session_hash|public_url|signed_url)';
    can_write:=entity=any(array[
      'projects','contacts','cost_centers','financial_categories','bank_accounts','revenue_centers','financial_entries',
      'dre_budgets','dre_groups','financial_category_dre_map','crm_records','crm_inventory_units','crm_goals',
      'crm_campaigns','crm_lead_sources','crm_loss_reasons','crm_products','crm_pipelines','crm_stages',
      'crm_teams','crm_team_members','crm_templates','crm_marketing_assets','crm_negotiation_parameters',
      'construction_work_packages','construction_daily_logs','construction_risks','construction_hseq_records',
      'purchase_requests','operational_contracts','operational_contract_items','hr_employees','hr_events',
      'user_activities','post_sale_tickets','post_sale_journeys','post_sale_milestones','post_sale_inspections',
      'post_sale_deeds','post_sale_collection_actions','marketing_campaigns','marketing_calendar_items',
      'marketing_requests','marketing_assets','marketing_channels','marketing_personas',
      'organization_members','role_permissions','role_access_profiles','system_settings'
    ]);
    select coalesce(array_agg(f),'{}') into writable from unnest(fields) f
    where f not in ('id','organization_id','created_at','created_by','updated_at','updated_by','approved_by','approved_at','source_id','source_type','source_component')
      and f !~ '(signature|signed_|snapshot)'
      and (entity<>'financial_entries' or f not in ('approval_status','status','settlement_date','open_amount','reconciled_amount','payment_release_status','payment_blocked','payment_block_reason','original_amount','is_provision','dre_amount','scheduled_payment_date'))
      and (entity not in ('operational_contracts','operational_contract_items','crm_inventory_units','hr_events') or f not in ('status','approval_status','approved_by','approved_at','signed_at','buyer_id','crm_contract_id'))
      and (entity<>'crm_records' or f not in ('sdr_user_id','broker_user_id','record_status','last_contact_at','next_action_at','first_response_at','attempts'))
      and (entity<>'organization_members' or f='permissions')
      and (entity<>'system_settings' or f !~ '(backup|reset|simulation)');
    insert into private.arisa_admin_entities values(entity,
      case when entity like 'crm_%' then 'Comercial' when entity like 'construction_%' then 'Obras'
        when entity like 'post_sale_%' then 'Pós-venda' when entity like 'marketing_%' then 'Marketing'
        when entity like 'hr_%' then 'RH' when entity like '%contract%' then 'Contratos'
        when entity in ('organization_members','role_permissions','role_access_profiles','system_settings') then 'Administração'
        else 'Gestão e financeiro' end,
      fields,case when can_write then writable else '{}' end,
      can_write and entity not in ('organization_members','system_settings'),
      can_write,
      can_write and entity not in ('organization_members','system_settings','financial_entries','crm_records','construction_work_packages','operational_contracts','operational_contract_items','hr_events')
    );
  end loop;
end $catalog$;

create or replace function public.arisa_admin_catalog(p_organization_id uuid,p_entity text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  if not private.arisa_is_admin(p_organization_id) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  select jsonb_agg(jsonb_build_object('entity',e.entity,'area',e.area,'create',e.can_create,'update',e.can_update,'delete',e.can_delete,
    'fields',case when p_entity is not null then (
      select jsonb_agg(jsonb_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'required',a.attnotnull and d.adbin is null,
        'writable',a.attname=any(e.writable),'default',pg_get_expr(d.adbin,d.adrelid),
        'references',(select cn.nspname||'.'||ct.relname from pg_constraint c join pg_class ct on ct.oid=c.confrelid join pg_namespace cn on cn.oid=ct.relnamespace where c.contype='f' and c.conrelid=a.attrelid and a.attnum=any(c.conkey) limit 1))
        order by a.attnum)
      from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
      where a.attrelid=to_regclass('public.'||e.entity) and a.attname=any(e.readable) and a.attnum>0
    ) else null end,
    'checks',case when p_entity is not null then (select jsonb_agg(pg_get_constraintdef(c.oid)) from pg_constraint c where c.conrelid=to_regclass('public.'||e.entity) and c.contype='c') else null end
  ) order by e.area,e.entity) into result from private.arisa_admin_entities e where p_entity is null or e.entity=p_entity;
  return jsonb_build_object('entities',coalesce(result,'[]'),'extra_entity','team_directory (user_id, full_name, email, role, active)');
end $$;

create or replace function private.arisa_filter_sql(p_entity text,p_filters jsonb,p_search text)
returns text language plpgsql stable set search_path='' as $$
declare e private.arisa_admin_entities; f jsonb; col text; typ text; op text; result text:=''; searches text;
begin
  select * into e from private.arisa_admin_entities where entity=p_entity;
  if not found or jsonb_typeof(coalesce(p_filters,'[]'))<>'array' or jsonb_array_length(coalesce(p_filters,'[]'))>16 then raise exception 'Consulta inválida.'; end if;
  for f in select * from jsonb_array_elements(coalesce(p_filters,'[]')) loop
    col:=f->>'column'; op:=f->>'operator';
    if col is null or not col=any(e.readable) then raise exception 'Campo de filtro inválido: %',col; end if;
    select format_type(atttypid,atttypmod) into typ from pg_attribute where attrelid=to_regclass('public.'||p_entity) and attname=col;
    if op in ('is_null','not_null') then result:=result||format(' and t.%I is %s null',col,case when op='not_null' then 'not' else '' end);
    elsif op='in' then
      if jsonb_typeof(f->'value')<>'array' or jsonb_array_length(f->'value')>100 then raise exception 'Filtro IN inválido.'; end if;
      result:=result||format(' and t.%I in (select value::%s from jsonb_array_elements_text(%L::jsonb))',col,typ,(f->'value')::text);
    elsif op='contains' then result:=result||format(' and t.%I::text ilike %L',col,'%'||(f->>'value')||'%');
    elsif op in ('eq','neq','gt','gte','lt','lte') then
      result:=result||format(' and t.%I %s %L::%s',col,case op when 'eq' then '=' when 'neq' then '<>' when 'gt' then '>' when 'gte' then '>=' when 'lt' then '<' else '<=' end,f->>'value',typ);
    else raise exception 'Operador de filtro inválido.'; end if;
  end loop;
  if nullif(btrim(p_search),'') is not null then
    if length(p_search)>200 then raise exception 'Busca muito longa.'; end if;
    select string_agg(format('t.%I::text ilike %L',a.attname,'%'||p_search||'%'),' or ') into searches
    from pg_attribute a where a.attrelid=to_regclass('public.'||p_entity) and a.attname=any(e.readable)
      and a.attname in ('name','title','description','person_name','document_number','document','email','phone','code','subject','full_name','unit_code','notes');
    if searches is null then raise exception 'Use filtros por campo para esta entidade.'; end if;
    result:=result||' and ('||searches||')';
  end if;
  return result;
end $$;
revoke all on function private.arisa_filter_sql(text,jsonb,text) from public,anon,authenticated;

create or replace function public.arisa_admin_query(p_organization_id uuid,p_entity text,p_filters jsonb default '[]',p_search text default null,p_limit integer default 50,p_offset integer default 0,p_sum_column text default null,p_group_column text default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare e private.arisa_admin_entities; cols text; predicate text; rows jsonb; total bigint; sums jsonb; groups jsonb; field_type oid; group_count bigint;
begin
  if not private.arisa_is_admin(p_organization_id) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  if p_entity='team_directory' then
    select jsonb_agg(jsonb_build_object('user_id',m.user_id,'full_name',p.full_name,'email',p.email,'role',m.role,'active',m.active)) into rows
      from public.organization_members m join public.profiles p on p.id=m.user_id where m.organization_id=p_organization_id;
    return jsonb_build_object('entity',p_entity,'rows',coalesce(rows,'[]'),'retrieved_at',now());
  end if;
  select * into e from private.arisa_admin_entities where entity=p_entity;
  if not found then raise exception 'Entidade não cadastrada. Consulte o catálogo.'; end if;
  if p_limit is null or p_offset is null or p_limit not between 1 and 200 or p_offset not between 0 and 100000 then raise exception 'Paginação inválida.'; end if;
  select string_agg(format('t.%I',f),',') into cols from unnest(e.readable) f;
  predicate:=format('t.organization_id=%L::uuid',p_organization_id)||private.arisa_filter_sql(p_entity,p_filters,p_search);
  execute format('select count(*) from public.%I t where %s',p_entity,predicate) into total;
  execute format('select coalesce(jsonb_agg(to_jsonb(s)),''[]'') from (select %s, md5(to_jsonb(t)::text) as _revision from public.%I t where %s order by %s limit %s offset %s) s',
    cols,p_entity,predicate,case when 'id'=any(e.readable) then 't.id' else 't.organization_id' end,p_limit,p_offset) into rows;
  if p_sum_column is not null then
    select atttypid into field_type from pg_attribute where attrelid=to_regclass('public.'||p_entity) and attname=p_sum_column and attname=any(e.readable);
    if field_type is null or not field_type=any(array['numeric'::regtype::oid,'int2'::regtype::oid,'int4'::regtype::oid,'int8'::regtype::oid,'float4'::regtype::oid,'float8'::regtype::oid]) then raise exception 'A soma precisa de campo numérico.'; end if;
    execute format('select jsonb_build_object(''column'',%L,''sum'',coalesce(sum(t.%I),0),''count'',count(*)) from public.%I t where %s',p_sum_column,p_sum_column,p_entity,predicate) into sums;
    if p_group_column is not null then
      if not p_group_column=any(e.readable) then raise exception 'Campo de agrupamento inválido.'; end if;
      execute format('select count(*) from (select t.%I from public.%I t where %s group by 1) s',p_group_column,p_entity,predicate) into group_count;
      execute format('select coalesce(jsonb_agg(to_jsonb(s)),''[]'') from (select t.%I as group_value,count(*) as count,coalesce(sum(t.%I),0) as sum from public.%I t where %s group by 1 order by sum desc limit 200) s',p_group_column,p_sum_column,p_entity,predicate) into groups;
    end if;
  end if;
  return jsonb_build_object('entity',p_entity,'total',total,'offset',p_offset,'limit',p_limit,'has_more',p_offset+p_limit<total,'rows',rows,'aggregate',sums,'groups',groups,'groups_truncated',coalesce(group_count>200,false),'retrieved_at',now());
end $$;
revoke all on function public.arisa_admin_catalog(uuid,text),public.arisa_admin_query(uuid,text,jsonb,text,integer,integer,text,text) from public,anon,authenticated,service_role;
grant execute on function public.arisa_admin_catalog(uuid,text),public.arisa_admin_query(uuid,text,jsonb,text,integer,integer,text,text) to authenticated;

create or replace function private.arisa_validate_references(p_entity text,p_values jsonb,p_org uuid)
returns void language plpgsql set search_path='' as $$
declare f record; val text; valid boolean; ref_type text; watcher_id uuid;
begin
  for f in
    select a.attname as field,n.nspname as ref_schema,t.relname as ref_table,b.attname as ref_column
    from pg_constraint c join pg_attribute a on a.attrelid=c.conrelid and a.attnum=c.conkey[1]
    join pg_class t on t.oid=c.confrelid join pg_namespace n on n.oid=t.relnamespace
    join pg_attribute b on b.attrelid=c.confrelid and b.attnum=c.confkey[1]
    where c.conrelid=to_regclass('public.'||p_entity) and c.contype='f' and cardinality(c.conkey)=1
  loop
    val:=p_values->>f.field;
    if val is null then continue; end if;
    if f.ref_schema='auth' and f.ref_table='users' or f.ref_schema='public' and f.ref_table='profiles' then
      select exists(select 1 from public.organization_members where organization_id=p_org and user_id=val::uuid and active) into valid;
    elsif f.ref_schema='public' and exists(select 1 from pg_attribute where attrelid=to_regclass('public.'||f.ref_table) and attname='organization_id' and not attisdropped) then
      execute format('select exists(select 1 from public.%I where %I::text=$1 and organization_id=$2)',f.ref_table,f.ref_column) into valid using val,p_org;
    else continue;
    end if;
    if not valid then raise exception 'Referência fora da organização ou indisponível: %',f.field using errcode='42501'; end if;
  end loop;
  if p_entity='user_activities' then
    if p_values ? 'watchers' then
      for watcher_id in select value::uuid from jsonb_array_elements_text(p_values->'watchers') loop
        if not exists(select 1 from public.organization_members m where m.organization_id=p_org and m.user_id=watcher_id and m.active) then raise exception 'Observador não pertence à organização.' using errcode='42501'; end if;
      end loop;
    end if;
    if p_values->>'related_id' is not null then
      ref_type:=p_values->>'related_type';
      if not exists(select 1 from private.arisa_admin_entities where entity=ref_type) then raise exception 'Tipo de vínculo inválido.'; end if;
      execute format('select exists(select 1 from public.%I where id::text=$1 and organization_id=$2)',ref_type) into valid using p_values->>'related_id',p_org;
      if not valid then raise exception 'Vínculo não pertence à organização.' using errcode='42501'; end if;
    end if;
  end if;
end $$;
revoke all on function private.arisa_validate_references(text,jsonb,uuid) from public,anon,authenticated;

create table private.arisa_admin_rpcs(name text primary key,scope jsonb not null default '{}');
insert into private.arisa_admin_rpcs values
  ('assign_crm_record','{"p_crm_record_id":"crm_records","p_assigned_user_id":"@member"}'),
  ('create_crm_activity_with_broker','{"p_crm_record_id":"crm_records","p_assigned_to":"@member","p_broker_user_id":"@member"}'),
  ('archive_crm_lead_v1','{"p_crm_record_id":"crm_records"}'),
  ('set_crm_assignment_status','{"p_assignment_id":"crm_lead_assignments"}'),
  ('arisa_resolve_payable','{"p_item_id":"arisa_operation_items"}'),
  ('arisa_link_existing_payable','{"p_item_id":"arisa_operation_items","p_entry_id":"financial_entries"}'),
  ('arisa_set_statement_account','{"p_item_id":"arisa_operation_items","p_bank_account_id":"bank_accounts"}'),
  ('arisa_reconcile_statement','{"p_item_id":"arisa_operation_items"}'),
  ('arisa_dismiss_operation','{"p_item_id":"arisa_operation_items"}'),
  ('arisa_set_operation_policy','{}'),
  ('reconcile_arisa_crm_operations','{}'),
  ('decide_operational_contract','{"p_contract_id":"operational_contracts"}'),
  ('decide_contract_measurement','{"p_measurement_id":"contract_measurements"}'),
  ('decide_contract_advance','{"p_advance_id":"contract_advances"}'),
  ('decide_fuel_request','{"p_request_id":"fuel_requests"}'),
  ('record_fuel_dispense','{"p_request_id":"fuel_requests"}'),
  ('create_measurement_period','{"p_contract_id":"operational_contracts"}'),
  ('preview_construction_eap_deletion','{"p_project_id":"projects"}'),
  ('preview_construction_work_package_deletion','{"p_package_id":"construction_work_packages"}'),
  ('delete_construction_eap','{"p_project_id":"projects"}'),
  ('delete_construction_work_package','{"p_package_id":"construction_work_packages"}');
revoke all on private.arisa_admin_rpcs from public,anon,authenticated;

create or replace function public.arisa_admin_operations(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
  if not private.arisa_is_admin(p_organization_id) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  select jsonb_agg(jsonb_build_object('name',p.proname,'arguments',pg_get_function_arguments(p.oid))) into result
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace join private.arisa_admin_rpcs r on r.name=p.proname
    where n.nspname='public';
  return coalesce(result,'[]');
end $$;

create or replace function public.arisa_admin_execute(
  p_organization_id uuid,p_message_id uuid,p_operation_key text,p_action text,p_entity text,
  p_record_id uuid default null,p_values jsonb default '{}',p_revision text default null,p_summary text default 'Operação administrativa',p_lease uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare msg public.arisa_chat_messages; e private.arisa_admin_entities; prior jsonb; before_row jsonb; after_row jsonb;
  vals jsonb:=coalesce(p_values,'{}'); cols text; setters text; result jsonb; k text; ref record; valid boolean; procedure record;
  args text:=''; i integer; arg_name text; arg_type text; scope jsonb; doc public.financial_entries; decision text;
begin
  if not private.arisa_is_admin(p_organization_id) then raise exception 'ADMIN_REQUIRED' using errcode='42501'; end if;
  select * into msg from public.arisa_chat_messages where id=p_message_id and organization_id=p_organization_id and owner_user_id=auth.uid() and role='user' for update;
  if not found then raise exception 'Conversa indisponível.' using errcode='42501'; end if;
  select a.result into prior from public.arisa_chat_actions a where a.message_id=msg.id and a.operation_key=p_operation_key;
  if found then return prior||jsonb_build_object('replayed',true); end if;
  if msg.status<>'processing' or msg.lease_expires_at<=clock_timestamp() or p_lease is null or msg.lease_token<>p_lease then raise exception 'ARISA_LEASE_CHANGED'; end if;
  if jsonb_typeof(vals)<>'object' or length(vals::text)>60000 or length(p_summary) not between 1 and 500 then raise exception 'Operação inválida.'; end if;

  if p_action='rpc' then
    select r.scope into scope from private.arisa_admin_rpcs r where r.name=p_entity;
    if not found then raise exception 'Rotina não disponível no catálogo.'; end if;
    select p.* into procedure from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=p_entity;
    if not found then raise exception 'Rotina não instalada.'; end if;
    if 'p_organization_id'=any(procedure.proargnames) then vals:=vals||jsonb_build_object('p_organization_id',p_organization_id); end if;
    for ref in select * from jsonb_each_text(scope) loop
      if vals->>ref.key is null then continue; end if;
      if ref.value='@member' then
        select exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(vals->>ref.key)::uuid and active) into valid;
      else execute format('select exists(select 1 from public.%I where id::text=$1 and organization_id=$2)',ref.value) into valid using vals->>ref.key,p_organization_id;
      end if;
      if not valid then raise exception 'Referência fora da organização: %',ref.key using errcode='42501'; end if;
    end loop;
    for k in select jsonb_object_keys(vals) loop
      if not k=any(procedure.proargnames) then raise exception 'Argumento desconhecido: %',k; end if;
    end loop;
    for i in 1..procedure.pronargs loop
      arg_name:=procedure.proargnames[i]; arg_type:=format_type(procedure.proargtypes[i-1],null);
      if not vals ? arg_name then continue; end if;
      if args<>'' then args:=args||','; end if;
      args:=args||format('%I => %s',arg_name,case when vals->arg_name='null'::jsonb then 'null::'||arg_type
        when arg_type in ('json','jsonb') then format('%L::%s',(vals->arg_name)::text,arg_type)
        else format('%L::%s',vals->>arg_name,arg_type) end);
    end loop;
    execute format('select to_jsonb(public.%I(%s))',p_entity,args) into after_row;
    result:=jsonb_build_object('ok',true,'action',p_action,'entity',p_entity,'result',after_row);
  elsif p_action='manage_member' then
    if p_entity<>'organization_members' or p_record_id is null then raise exception 'Usuário inválido.'; end if;
    select to_jsonb(m) into before_row from public.organization_members m where organization_id=p_organization_id and user_id=p_record_id for update;
    if before_row is null then raise exception 'Usuário não pertence à organização.'; end if;
    after_row:=public.admin_manage_member_access(p_organization_id,auth.uid(),p_record_id,vals->>'action',vals->>'role',(vals->>'active')::boolean);
    result:=jsonb_build_object('ok',true,'action',p_action,'entity',p_entity,'record_id',p_record_id,'result',after_row);
  elsif p_action in ('approve_financial','settle_financial') then
    if p_entity<>'financial_entries' then raise exception 'Entidade financeira inválida.'; end if;
    select * into doc from public.financial_entries where id=p_record_id and organization_id=p_organization_id for update;
    if not found then raise exception 'Título não localizado.'; end if;
    before_row:=to_jsonb(doc);
    if p_revision is null or md5(before_row::text)<>p_revision then raise exception 'RECORD_CHANGED: consulte o título novamente.'; end if;
    if p_action='approve_financial' then
      decision:=vals->>'decision';
      if decision not in ('aprovado','rejeitado') or decision is null then raise exception 'Decisão inválida.'; end if;
      if doc.status in ('pago','recebido','cancelado') then raise exception 'Título já encerrado.'; end if;
      if vals->>'scheduled_payment_date' is not null and ((vals->>'scheduled_payment_date')::date<doc.issue_date or doc.type<>'saida' or doc.payment_blocked or doc.is_provision and doc.payment_release_status not in ('liberado','reconciliado')) then raise exception 'A programação exige título válido e liberação documental.'; end if;
      update public.financial_entries set approval_status=decision,
        approved_by=case when decision='aprovado' then auth.uid() else null end,
        approved_at=case when decision='aprovado' then now() else null end,
        scheduled_payment_date=case when decision='aprovado' then coalesce((vals->>'scheduled_payment_date')::date,scheduled_payment_date) else null end
        where id=doc.id returning to_jsonb(financial_entries.*) into after_row;
      update public.approval_requests set status=decision,assigned_to=auth.uid(),decided_at=now(),comment=coalesce(vals->>'note',p_summary) where entry_id=doc.id and organization_id=p_organization_id and status='pendente';
    else
      if doc.approval_status<>'aprovado' or doc.payment_blocked or doc.is_provision and doc.payment_release_status not in ('liberado','reconciliado') then raise exception 'O título exige aprovação ou liberação documental.'; end if;
      if doc.status in ('cancelado','pago','recebido') then raise exception 'Título já encerrado.'; end if;
      if vals->>'date' is null or (vals->>'date')::date>(now() at time zone 'America/Sao_Paulo')::date or (vals->>'date')::date<doc.issue_date then raise exception 'Informe a data do pagamento ou recebimento já realizado, não anterior à emissão.'; end if;
      perform private.arisa_validate_references('financial_entries',vals,p_organization_id);
      update public.financial_entries set status=case when type='saida' then 'pago' else 'recebido' end,
        settlement_date=(vals->>'date')::date,bank_account_id=coalesce((vals->>'bank_account_id')::uuid,bank_account_id)
        where id=doc.id returning to_jsonb(financial_entries.*) into after_row;
    end if;
    result:=jsonb_build_object('ok',true,'action',p_action,'entity',p_entity,'record_id',doc.id,'record',after_row,'bank_transfer_executed',false);
  elsif p_action in ('create','update','delete') then
    select * into e from private.arisa_admin_entities where entity=p_entity;
    if not found or p_action='create' and not e.can_create or p_action='update' and not e.can_update or p_action='delete' and not e.can_delete then raise exception 'Use a rotina transacional desta entidade no catálogo.'; end if;
    for k in select jsonb_object_keys(vals) loop
      if not k=any(e.writable) then raise exception 'Campo não editável nesta operação: %',k; end if;
    end loop;
    if p_action<>'create' then
      execute format('select to_jsonb(t) from public.%I t where organization_id=$1 and %s for update',p_entity,
        case when p_entity='system_settings' then 'organization_id=$1' else 'id=$2' end) into before_row using p_organization_id,p_record_id;
      if before_row is null then raise exception 'Registro não localizado na organização.'; end if;
      if p_revision is null or md5(before_row::text)<>p_revision then raise exception 'RECORD_CHANGED: consulte o registro novamente.'; end if;
      if p_entity='financial_entries' and before_row->>'status' in ('pago','recebido','cancelado') then raise exception 'Título encerrado: é necessário tratar o estorno no fluxo financeiro antes de alterar seus dados.'; end if;
    end if;
    perform private.arisa_validate_references(p_entity,coalesce(before_row,'{}')||vals,p_organization_id);
    if p_entity='financial_entries' and vals ? 'amount' and ((vals->>'amount')::numeric<0 or round((vals->>'amount')::numeric,2)<>(vals->>'amount')::numeric) then raise exception 'Valor financeiro inválido.'; end if;
    if p_action='create' then
      vals:=vals||jsonb_build_object('organization_id',p_organization_id);
      if 'created_by'=any(e.readable) then vals:=vals||jsonb_build_object('created_by',auth.uid()); end if;
      if p_entity='user_activities' then vals:=vals||jsonb_build_object('assigned_by',auth.uid()); end if;
      if p_entity='financial_entries' then vals:=vals||jsonb_build_object('approval_status','pendente','status','pendente','source_type','arisa_chat','source_id',msg.id,'source_component',p_operation_key); end if;
      select string_agg(format('%I',key),',') into cols from jsonb_object_keys(vals) key;
      execute format('insert into public.%I(%s) select %s from jsonb_populate_record(null::public.%I,$1) returning to_jsonb(%I.*)',p_entity,cols,cols,p_entity,p_entity) into after_row using vals;
      if p_entity='financial_entries' then
        insert into public.approval_requests(organization_id,entry_id,status,reason,requested_by)
        values(p_organization_id,(after_row->>'id')::uuid,'pendente','Lançamento preparado pela Arisa a pedido do administrador.',auth.uid());
      end if;
    elsif p_action='update' then
      if vals='{}' then raise exception 'Informe o que deve ser atualizado.'; end if;
      if 'updated_by'=any(e.readable) then vals:=vals||jsonb_build_object('updated_by',auth.uid()); end if;
      if 'updated_at'=any(e.readable) then vals:=vals||jsonb_build_object('updated_at',now()); end if;
      select string_agg(format('%1$I=v.%1$I',key),',') into setters from jsonb_object_keys(vals) key;
      execute format('update public.%I t set %s from jsonb_populate_record(null::public.%I,$1) v where t.organization_id=$2 and %s returning to_jsonb(t.*)',p_entity,setters,p_entity,
        case when p_entity='system_settings' then 't.organization_id=$2' else 't.id=$3' end) into after_row using vals,p_organization_id,p_record_id;
    else execute format('delete from public.%I where id=$1 and organization_id=$2',p_entity) using p_record_id,p_organization_id;
    end if;
    result:=jsonb_build_object('ok',true,'action',p_action,'entity',p_entity,'record_id',coalesce(after_row->>'id',p_record_id::text),'record',after_row);
  else raise exception 'Operação desconhecida.'; end if;
  insert into public.arisa_chat_actions(organization_id,actor_user_id,message_id,operation_key,action,entity,record_id,summary,result,before_data,after_data)
  values(p_organization_id,auth.uid(),msg.id,p_operation_key,p_action,p_entity,coalesce(result->>'record_id',p_record_id::text),p_summary,result,before_row,after_row);
  insert into public.audit_logs(organization_id,user_id,action,entity,entity_id,old_data,new_data)
  values(p_organization_id,auth.uid(),'arisa.'||p_action,p_entity,coalesce(result->>'record_id',msg.id::text),before_row,
    jsonb_build_object('message_id',msg.id,'summary',p_summary,'result',result));
  return result;
end $$;
revoke all on function public.arisa_admin_operations(uuid),public.arisa_admin_execute(uuid,uuid,text,text,text,uuid,jsonb,text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.arisa_admin_operations(uuid),public.arisa_admin_execute(uuid,uuid,text,text,text,uuid,jsonb,text,text,uuid) to authenticated;

commit;
