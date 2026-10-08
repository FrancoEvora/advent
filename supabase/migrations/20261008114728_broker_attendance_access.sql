-- Corretores: carteira designada, disponibilidade e atendimento. Sem acesso ao ERP.
-- Políticas RESTRICTIVE complementam as permissivas existentes e preservam outros perfis.
alter table public.crm_teams add column if not exists is_brokerage boolean not null default false;
comment on column public.crm_teams.is_brokerage is 'Imobiliária explicitamente configurada pela gestão; equipes genéricas não compartilham carteira.';
create index if not exists crm_records_broker_scope_idx on public.crm_records(organization_id,broker_user_id);
create index if not exists crm_records_broker_team_scope_idx on public.crm_records(organization_id,team_id);
create index if not exists crm_team_members_broker_scope_idx on public.crm_team_members(organization_id,user_id,team_id) where active;

create or replace function private.is_broker_session()
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.organization_members m where m.user_id=(select auth.uid()) and m.active and m.role='corretor')
$$;
revoke all on function private.is_broker_session() from public,anon;
grant execute on function private.is_broker_session() to authenticated;

create or replace function private.broker_has_team(p_org uuid,p_team uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(
   select 1 from public.crm_teams t
   join public.crm_team_members tm on tm.team_id=t.id and tm.organization_id=t.organization_id
   join public.organization_members m on m.organization_id=t.organization_id and m.user_id=tm.user_id
   where t.id=p_team and t.organization_id=p_org and t.active and t.is_brokerage
     and tm.active and tm.user_id=(select auth.uid()) and m.active and m.role='corretor'
 )
$$;
revoke all on function private.broker_has_team(uuid,uuid) from public,anon;
grant execute on function private.broker_has_team(uuid,uuid) to authenticated;

create or replace function private.broker_can_read_record(p_org uuid,p_record uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(
  select 1 from public.crm_records r
  join public.organization_members m on m.organization_id=r.organization_id and m.user_id=(select auth.uid()) and m.active and m.role='corretor'
  where r.id=p_record and r.organization_id=p_org and r.record_status<>'arquivada'
  and (
   r.broker_user_id=m.user_id
   or (r.broker_user_id is null and r.owner_user_id=m.user_id and not exists(
      select 1 from public.crm_lead_assignments a where a.organization_id=r.organization_id and a.crm_record_id=r.id and a.assignment_role='corretor'
   ))
   or private.broker_has_team(r.organization_id,r.team_id)
   or (r.broker_user_id is null and exists(
      select 1 from public.crm_lead_assignments a where a.organization_id=r.organization_id and a.crm_record_id=r.id
       and a.assignment_role='corretor' and a.assigned_user_id=m.user_id and a.status in ('atribuida','aceita','em_atendimento')
   ))
  )
 )
$$;
revoke all on function private.broker_can_read_record(uuid,uuid) from public,anon;
grant execute on function private.broker_can_read_record(uuid,uuid) to authenticated;

create or replace function private.broker_can_read_entity(p_org uuid,p_type text,p_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
 select case
 when p_type in ('crm_record','crm_records') then private.broker_can_read_record(p_org,p_id)
 when p_type in ('crm_action','crm_actions') then exists(select 1 from public.crm_actions a where a.id=p_id and a.organization_id=p_org and private.broker_can_read_record(p_org,a.crm_record_id))
 else false end
$$;
revoke all on function private.broker_can_read_entity(uuid,text,uuid) from public,anon;
grant execute on function private.broker_can_read_entity(uuid,text,uuid) to authenticated;

-- A permissão genérica não pode ampliar o perfil restrito, nem por override individual.
create or replace function public.has_app_permission(p_organization_id uuid,p_permission_key text)
returns boolean language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.organization_members m
 where m.organization_id=p_organization_id and m.user_id=(select auth.uid()) and m.active and (
  m.role='admin' or (
   (m.role<>'corretor' or p_permission_key in ('crm.view','crm.attend'))
   and case when p_permission_key='crm.attend' and m.role='corretor' then true
    when m.permissions ? p_permission_key then coalesce((m.permissions->>p_permission_key)::boolean,false)
    else exists(select 1 from public.role_permissions rp where rp.organization_id=p_organization_id and rp.role=m.role and rp.permission_key=p_permission_key and rp.allowed)
   end
  )
 ))
$$;
update public.role_permissions set allowed=false where role='corretor' and permission_key not in ('crm.view','crm.attend');

create or replace function private.broker_asset_allowed(p_org uuid,p_path text)
returns boolean language sql stable security definer set search_path='' as $$
 select public.is_org_member(p_org) and (
  exists(select 1 from public.crm_marketing_assets a where a.organization_id=p_org and a.storage_path=p_path and a.active
   and (a.folder_id is null or exists(select 1 from public.crm_asset_folders f where f.id=a.folder_id and f.organization_id=p_org and f.visibility in ('equipe','publico','publica','corretores','comercial')))
   and coalesce(lower(a.audience),'') not in ('interno','internos','diretoria','administracao','administrativo','gestao'))
  or exists(select 1 from public.marketing_assets a where a.organization_id=p_org and a.storage_path=p_path and a.status in ('aprovado','publicado') and (a.expires_at is null or a.expires_at>=current_date))
 )
$$;
revoke all on function private.broker_asset_allowed(uuid,text) from public,anon;
grant execute on function private.broker_asset_allowed(uuid,text) to authenticated;

create or replace function private.broker_storage_allowed(p_bucket text,p_name text,p_write boolean default false)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare parts text[]:=string_to_array(p_name,'/'); org uuid; entity uuid;
begin
 if not private.is_broker_session() then return true; end if;
 if coalesce(parts[1],'') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then return false; end if;
 org:=parts[1]::uuid;
 if not public.is_org_member(org) then return false; end if;
 if p_bucket='marketing-assets' then return not p_write and private.broker_asset_allowed(org,p_name); end if;
 if p_bucket='profile-photos' then return parts[2]=(select auth.uid())::text; end if;
 if p_bucket<>'erp-documents' then return false; end if;
 if coalesce(parts[3],'') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
  entity:=parts[3]::uuid;
  if private.broker_can_read_entity(org,parts[2],entity) then return true; end if;
 end if;
 return not p_write and exists(select 1 from public.document_attachments d where d.organization_id=org and d.storage_path=p_name and private.broker_can_read_entity(org,d.entity_type,d.entity_id));
end $$;
revoke all on function private.broker_storage_allowed(text,text,boolean) from public,anon;
grant execute on function private.broker_storage_allowed(text,text,boolean) to authenticated;

create or replace function private.broker_row_allowed(p_table text,p_row jsonb,p_write boolean)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare org uuid:=nullif(p_row->>'organization_id','')::uuid; actor uuid:=(select auth.uid()); rid uuid;
begin
 if actor is null then return false; end if;
 if p_table in ('profiles','organizations','crm_records','contacts','crm_teams') then rid:=nullif(p_row->>'id','')::uuid; end if;
 if p_table='profiles' then return not p_write and rid=actor; end if;
 if p_table='organizations' then return not p_write and public.is_org_member(rid); end if;
 if org is null or not exists(select 1 from public.organization_members m where m.organization_id=org and m.user_id=actor and m.active and m.role='corretor') then return false; end if;
 case p_table
 when 'organization_members' then return not p_write and (p_row->>'user_id')::uuid=actor;
 when 'role_permissions' then return not p_write and p_row->>'role'='corretor';
 when 'crm_records' then return not p_write and private.broker_can_read_record(org,rid);
 when 'crm_actions' then return private.broker_can_read_record(org,(p_row->>'crm_record_id')::uuid)
   and (not p_write or coalesce((p_row->>'assigned_to')::uuid,(p_row->>'created_by')::uuid)=actor);
 when 'crm_lead_assignments' then return not p_write and private.broker_can_read_record(org,(p_row->>'crm_record_id')::uuid);
 when 'crm_lead_assignment_events' then return not p_write and exists(select 1 from public.crm_lead_assignments a where a.id=(p_row->>'assignment_id')::uuid and a.organization_id=org and private.broker_can_read_record(org,a.crm_record_id));
 when 'contacts' then return not p_write and exists(select 1 from public.crm_records r where r.contact_id=rid and r.organization_id=org and private.broker_can_read_record(org,r.id));
 when 'crm_teams' then return not p_write and private.broker_has_team(org,rid);
 when 'crm_team_members' then return not p_write and (p_row->>'user_id')::uuid=actor and private.broker_has_team(org,(p_row->>'team_id')::uuid);
 when 'crm_asset_folders' then return not p_write and p_row->>'visibility' in ('equipe','publico','publica','corretores','comercial');
 when 'crm_marketing_assets' then return not p_write and (p_row->>'active')::boolean
   and coalesce(lower(p_row->>'audience'),'') not in ('interno','internos','diretoria','administracao','administrativo','gestao')
   and (p_row->>'folder_id' is null or exists(select 1 from public.crm_asset_folders f where f.id=(p_row->>'folder_id')::uuid and f.organization_id=org and f.visibility in ('equipe','publico','publica','corretores','comercial')));
 when 'marketing_assets' then return not p_write and p_row->>'status' in ('aprovado','publicado') and (p_row->>'expires_at' is null or (p_row->>'expires_at')::date>=current_date);
 when 'document_attachments' then return private.broker_can_read_entity(org,p_row->>'entity_type',(p_row->>'entity_id')::uuid)
   and (not p_write or ((p_row->>'uploaded_by')::uuid=actor and (
    (p_row->>'document_type'='comunicacao' and split_part(p_row->>'storage_path','/',1)=org::text and split_part(p_row->>'storage_path','/',2)=p_row->>'entity_type' and split_part(p_row->>'storage_path','/',3)=p_row->>'entity_id')
    or (p_row->>'document_type'='material_marketing' and private.broker_asset_allowed(org,p_row->>'storage_path'))
   )));
 when 'communication_links' then return private.broker_can_read_entity(org,p_row->>'entity_type',(p_row->>'entity_id')::uuid) and (not p_write or (p_row->>'created_by')::uuid=actor);
 when 'user_activities' then return not p_write and (p_row->>'owner_user_id')::uuid=actor and (
   p_row->>'related_id' is null or private.broker_can_read_entity(org,p_row->>'related_type',(p_row->>'related_id')::uuid));
 when 'activity_notifications' then return not p_write and (p_row->>'recipient_user_id')::uuid=actor;
 else return false;
 end case;
end $$;
revoke all on function private.broker_row_allowed(text,jsonb,boolean) from public,anon;
grant execute on function private.broker_row_allowed(text,jsonb,boolean) to authenticated;

-- Todas as tabelas existentes têm RLS. A barreira é por sessão, inclusive tabelas sem organization_id.
do $guard$
declare item record;
begin
 for item in select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relrowsecurity
 loop
  execute format('create policy broker_scope_boundary on public.%I as restrictive for all to authenticated using (not (select private.is_broker_session()) or private.broker_row_allowed(%L,to_jsonb(%I),false)) with check (not (select private.is_broker_session()) or private.broker_row_allowed(%L,to_jsonb(%I),true))',item.relname,item.relname,item.relname,item.relname,item.relname);
  execute format('create policy broker_no_delete on public.%I as restrictive for delete to authenticated using (not (select private.is_broker_session()))',item.relname);
 end loop;
end $guard$;

-- Funções administrativas continuam sendo a única forma de mudar designações.
create or replace function private.guard_broker_action_identity()
returns trigger language plpgsql set search_path='' as $$
begin
 if current_user='authenticated' and private.is_broker_session() then
  if tg_op='INSERT' then raise exception 'Registre o atendimento pela operação autorizada.' using errcode='42501'; end if;
  if (new.organization_id,new.crm_record_id,new.assigned_to,new.created_by,new.automation_id,new.template_id)
    is distinct from (old.organization_id,old.crm_record_id,old.assigned_to,old.created_by,old.automation_id,old.template_id) then
    raise exception 'A responsabilidade e o vínculo da atividade só podem ser alterados pela gestão.' using errcode='42501';
  end if;
 end if;
 return new;
end $$;
create trigger broker_action_identity before insert or update on public.crm_actions for each row execute function private.guard_broker_action_identity();

create policy broker_storage_scope on storage.objects as restrictive for all to authenticated
 using (not (select private.is_broker_session()) or private.broker_storage_allowed(bucket_id,name,false))
 with check (not (select private.is_broker_session()) or private.broker_storage_allowed(bucket_id,name,true));
create policy broker_storage_delete on storage.objects as restrictive for delete to authenticated
 using (not (select private.is_broker_session()) or (owner_id=(select auth.uid())::text and private.broker_storage_allowed(bucket_id,name,true)));

-- Contexto com projeção explícita: nenhum orçamento, preço mínimo, comprador ou unidade vendida.
create or replace function public.get_broker_attendance_context(p_organization_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if not exists(select 1 from public.organization_members m where m.organization_id=p_organization_id and m.user_id=(select auth.uid()) and m.active and m.role='corretor') then
  raise exception 'Área exclusiva de atendimento do corretor.' using errcode='42501';
 end if;
 select jsonb_build_object(
 'projects',(select coalesce(jsonb_agg(jsonb_build_object('id',p.id,'organization_id',p.organization_id,'name',p.name,'code',p.code,'city',p.city,'state',p.state,'active',p.active) order by p.name),'[]') from public.projects p where p.organization_id=p_organization_id and p.active),
 'units',(select coalesce(jsonb_agg(jsonb_build_object('id',u.id,'project_id',u.project_id,'unit_code',u.unit_code,'block_code',u.block_code,'lot_number',u.lot_number,'area',u.area,'list_price',u.list_price,'price_per_sqm',u.price_per_sqm,'frontage',u.frontage,'depth',u.depth,'corner',u.corner,'topography',u.topography,'orientation',u.orientation) order by u.unit_code),'[]') from public.crm_inventory_units u where u.organization_id=p_organization_id and u.active and u.status='disponivel'
  and not exists(select 1 from public.crm_contracts c where c.organization_id=u.organization_id and c.unit_id=u.id and c.status<>'cancelado')
  and not exists(select 1 from public.crm_unit_reservations r where r.organization_id=u.organization_id and r.unit_id=u.id and r.status='ativa')),
 'agencies',(select coalesce(jsonb_agg(jsonb_build_object('id',t.id,'name',t.name)),'[]') from public.crm_teams t where t.organization_id=p_organization_id and private.broker_has_team(t.organization_id,t.id))
 ) into result;
 return result;
end $$;
revoke all on function public.get_broker_attendance_context(uuid) from public,anon;
grant execute on function public.get_broker_attendance_context(uuid) to authenticated;

-- RPCs SECURITY DEFINER não passam por RLS. Bloqueie o corretor antes de executar rotinas corporativas.
-- Lista explícita congela o escopo da migração; helpers de autorização e portais públicos ficam intactos.
do $rpc_guard$
declare item record; definition text; guarded text;
begin
 for item in select p.oid,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in (
    'generate_my_overdue_activity_notifications',
    'arisa_my_whatsapp_notifications',
    'archive_crm_lead_v1',
    'archive_landowner_portal_snapshot',
    'archive_public_agent_knowledge',
    'arisa_admin_catalog',
    'arisa_admin_execute',
    'arisa_admin_operations',
    'arisa_admin_query',
    'arisa_chat_create_thread',
    'arisa_chat_register_file',
    'arisa_chat_send',
    'arisa_create_content',
    'arisa_dismiss_operation',
    'arisa_intake_document',
    'arisa_knowledge_status',
    'arisa_link_existing_payable',
    'arisa_memory_review',
    'arisa_reconcile_statement',
    'arisa_resolve_payable',
    'arisa_set_operation_policy',
    'arisa_set_statement_account',
    'arisa_whatsapp_inbox',
    'arisa_whatsapp_monitor',
    'assign_crm_record',
    'assistant_chat_create_thread',
    'bia_bulk_campaign_admin',
    'bia_manager_simulate',
    'bia_strategy_enqueue_lead',
    'bia_strategy_queue_admin',
    'bia_strategy_queue_delivery',
    'bia_strategy_queue_find_thread',
    'bia_strategy_queue_preview',
    'bia_strategy_queue_record_optin',
    'bia_whatsapp_inbox',
    'bia_whatsapp_monitor',
    'close_measurement_period',
    'configure_fuel_request_financial',
    'configure_insights',
    'create_fuel_request_link',
    'create_measurement_period',
    'create_operational_contract',
    'create_operational_contract_acceptance_link',
    'create_partner_portal_link',
    'crm_cancel_unsigned_contract',
    'crm_company_send_contract',
    'crm_company_send_contract_v2',
    'crm_decide_unaccepted_proposal',
    'crm_finalize_contract',
    'decide_contract_advance',
    'decide_contract_measurement',
    'decide_fuel_request',
    'decide_operational_contract',
    'decide_partner_negotiation',
    'decide_public_agent_unit_hold',
    'delete_construction_eap',
    'delete_construction_work_package',
    'generate_management_insights',
    'get_arisa_crm_operations',
    'get_public_agent_admin_config',
    'list_pending_public_agent_unit_holds',
    'preview_archive_crm_lead_v1',
    'preview_landowner_portal_publication',
    'publish_landowner_portal_snapshot',
    'publish_partner_payment',
    'reconcile_arisa_crm_operations',
    'record_equipment_meter_reading',
    'record_fuel_dispense',
    'register_measurement_document',
    'release_contract_retention',
    'release_fuel_request_payment',
    'reopen_measurement_period',
    'reply_partner_negotiation',
    'reset_partner_portal_data',
    'review_fuel_request_document',
    'review_measurement_document',
    'revoke_fuel_request_link',
    'revoke_operational_contract_acceptance_link',
    'revoke_partner_portal_link',
    'run_my_automations',
    'run_my_construction_automations',
    'save_public_agent_profile_config',
    'set_insight_status',
    'set_landowner_contract_terms',
    'set_landowner_repass_entry',
    'submit_contract_advance',
    'submit_contract_measurement',
    'submit_fuel_request',
    'submit_fuel_request_document',
    'upsert_public_agent_knowledge'
 ) loop
  definition:=pg_get_functiondef(item.oid);
  guarded:=regexp_replace(definition,'([[:space:]]begin[[:space:]])',E'\\1\n  if private.is_broker_session() then raise exception ''Operação indisponível para o perfil corretor.'' using errcode=''42501''; end if;\n','i');
  if guarded=definition then raise exception 'Não foi possível proteger a função %',item.proname; end if;
  execute guarded;
 end loop;
end $rpc_guard$;

CREATE OR REPLACE FUNCTION public.create_crm_activity_with_broker(p_crm_record_id uuid, p_action_type text, p_channel text, p_subject text, p_scheduled_at timestamp with time zone, p_completed boolean, p_outcome text, p_duration_minutes integer, p_assigned_to uuid, p_broker_user_id uuid, p_notes text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid(); lead public.crm_records%rowtype;
  normalized_action_type text := lower(btrim(coalesce(p_action_type,'')));
  normalized_channel text := lower(btrim(coalesce(p_channel,'')));
  normalized_subject text := btrim(coalesce(p_subject,''));
  normalized_outcome text := nullif(lower(btrim(coalesce(p_outcome,''))),'');
  normalized_notes text := nullif(btrim(coalesce(p_notes,'')),'');
  effective_completed boolean := coalesce(p_completed,false); effective_scheduled_at timestamptz;
  effective_duration integer; effective_assigned_to uuid; effective_broker uuid; appointment boolean;
  appointment_ends_at timestamptz; conflict_exists boolean := false; assignment_id uuid; action_id uuid;
  calendar_activity_id uuid; assignment_due_at timestamptz;
begin
  if actor is null then raise exception 'Autenticação obrigatória.' using errcode='42501'; end if;
  select record.* into lead from public.crm_records record where record.id=p_crm_record_id for update;
  if not found then raise exception 'Lead não localizado.'; end if;
  if not public.is_org_member(lead.organization_id) then raise exception 'Organização não autorizada.' using errcode='42501'; end if;
  if private.is_broker_session() and (
    not private.broker_can_read_record(lead.organization_id,lead.id)
    or coalesce(p_assigned_to,actor)<>actor
    or coalesce(p_broker_user_id,actor)<>actor
  ) then raise exception 'Atendimento fora da carteira autorizada.' using errcode='42501'; end if;
  if lead.record_status='arquivada' then raise exception 'O lead está arquivado e não pode receber novas atividades.'; end if;
  if normalized_action_type not in ('contato','ligacao','whatsapp','email','reuniao','visita','proposta','tarefa') then raise exception 'Tipo de atividade inválido.'; end if;
  if normalized_channel not in ('whatsapp','telefone','email','presencial','video','instagram','interno') then raise exception 'Canal de atividade inválido.'; end if;
  if char_length(normalized_subject) not between 1 and 300 then raise exception 'Informe um assunto com até 300 caracteres.'; end if;
  if normalized_notes is not null and char_length(normalized_notes)>8000 then raise exception 'As observações excedem o limite permitido.'; end if;
  if p_duration_minutes is not null and (p_duration_minutes<0 or p_duration_minutes>480) then raise exception 'A duração deve estar entre 0 e 480 minutos.'; end if;

  effective_assigned_to:=coalesce(p_assigned_to,actor);
  if not exists(select 1 from public.organization_members member where member.organization_id=lead.organization_id and member.user_id=effective_assigned_to and member.active) then raise exception 'O responsável precisa estar ativo na organização.'; end if;

  effective_broker:=case when private.is_broker_session() then actor else coalesce(p_broker_user_id,lead.broker_user_id) end;
  if effective_broker is not null and not exists(
    select 1 from public.organization_members member
    where member.organization_id=lead.organization_id and member.user_id=effective_broker and member.active
      and (lower(member.role)='corretor' or exists(
        select 1 from public.crm_team_members team_member join public.crm_teams team on team.id=team_member.team_id and team.organization_id=team_member.organization_id
        where team_member.organization_id=lead.organization_id and team_member.user_id=member.user_id and team_member.active and team.active
          and (lower(team.team_type) in ('corretor','corretores','vendas','comercial') or lower(team_member.team_role) like '%corretor%')
      ))
  ) then raise exception 'O corretor selecionado não está elegível para atendimento.'; end if;

  appointment:=normalized_action_type in ('visita','reuniao') or normalized_outcome='visita_agendada';
  effective_scheduled_at:=case when effective_completed then now() else p_scheduled_at end;
  if appointment and not effective_completed and effective_scheduled_at is null then raise exception 'Defina a data e o horário da visita ou reunião.'; end if;
  if appointment and effective_broker is null then raise exception 'Atribua um corretor antes de agendar a visita ou reunião.'; end if;
  effective_duration:=nullif(coalesce(p_duration_minutes,0),0);
  if appointment then effective_duration:=greatest(coalesce(effective_duration,60),15); end if;

  if appointment and not effective_completed then
    if effective_scheduled_at <= now()+interval '15 minutes' then raise exception 'O agendamento precisa respeitar antecedência mínima de 15 minutos.'; end if;
    appointment_ends_at:=effective_scheduled_at+make_interval(mins=>effective_duration);
    perform pg_advisory_xact_lock(hashtextextended(lead.organization_id::text||':'||effective_broker::text,0));
    select exists(
      select 1 from (
        select activity.starts_at,
          case when activity.due_at is not null and activity.due_at>activity.starts_at then activity.due_at
               else activity.starts_at+make_interval(mins=>greatest(coalesce(activity.estimated_minutes,60),15)) end ends_at
        from public.user_activities activity
        where activity.organization_id=lead.organization_id and activity.owner_user_id=effective_broker and activity.starts_at is not null
          and activity.board_status<>'concluida' and activity.status<>'cancelada'
          and (activity.activity_type in ('visita','reuniao','indisponibilidade','bloqueio_agenda') or activity.tags && array['agenda-bloqueio','indisponibilidade']::text[])
        union all
        select action.scheduled_at, action.scheduled_at+make_interval(mins=>greatest(coalesce(action.duration_minutes,60),15))
        from public.crm_actions action
        where action.organization_id=lead.organization_id and action.assigned_to=effective_broker and action.scheduled_at is not null
          and action.action_status='pendente' and (action.action_type in ('visita','reuniao') or action.outcome='visita_agendada')
          and not (action.metadata ? 'calendar_user_activity_id')
      ) occupied where occupied.starts_at<appointment_ends_at and occupied.ends_at>effective_scheduled_at
    ) into conflict_exists;
    if conflict_exists then raise exception 'O corretor já possui compromisso neste horário. Selecione outro intervalo.'; end if;
  end if;

  if not private.is_broker_session() and p_broker_user_id is not null and p_broker_user_id is distinct from lead.broker_user_id then
    if not public.has_app_permission(lead.organization_id,'crm.assign') then raise exception 'Seu perfil não possui permissão para atribuir ou substituir o corretor.' using errcode='42501'; end if;
    assignment_due_at:=greatest(now()+interval '5 minutes',least(coalesce(effective_scheduled_at,now()+interval '24 hours'),now()+interval '24 hours'));
    assignment_id:=private.create_crm_assignment(
      lead.id,'corretor',p_broker_user_id,case when appointment then 'alta' else 'normal' end,assignment_due_at,
      case when appointment and effective_scheduled_at is not null then 'Atendimento atribuído durante o agendamento de visita para '||to_char(effective_scheduled_at at time zone 'America/Sao_Paulo','DD/MM/YYYY HH24:MI')||'.' else 'Atendimento atribuído pela atividade comercial.' end,
      actor,'manual',true
    );
  end if;

  insert into public.crm_actions(organization_id,crm_record_id,action_type,subject,scheduled_at,completed_at,action_status,notes,created_by,channel,outcome,duration_minutes,assigned_to,metadata)
  values(lead.organization_id,lead.id,normalized_action_type,normalized_subject,effective_scheduled_at,case when effective_completed then now() else null end,
    case when effective_completed then 'concluida' else 'pendente' end,normalized_notes,actor,normalized_channel,normalized_outcome,effective_duration,effective_assigned_to,
    jsonb_build_object('materials_supported',true,'external_delivery_handoff',false,'broker_user_id',effective_broker,'broker_assignment_id',assignment_id,'calendar_managed',appointment and not effective_completed))
  returning id into action_id;

  if appointment and not effective_completed then
    insert into public.user_activities(organization_id,owner_user_id,assigned_by,updated_by,title,description,activity_type,status,board_status,priority,starts_at,due_at,related_type,related_id,project_id,reminders,checklist,tags,estimated_minutes,watchers,progress_percent)
    values(lead.organization_id,effective_broker,actor,actor,case when normalized_action_type='reuniao' then 'Reunião com ' else 'Visita com ' end||coalesce(nullif(lead.person_name,''),'lead'),normalized_notes,
      case when normalized_action_type='reuniao' then 'reuniao' else 'visita' end,'pendente','backlog','alta',effective_scheduled_at,appointment_ends_at,'crm_actions',action_id,lead.project_id,
      jsonb_build_array(jsonb_build_object('offset_minutes',60),jsonb_build_object('offset_minutes',15)),
      jsonb_build_array(jsonb_build_object('label','Confirmar presença e orientações com o cliente','done',false),jsonb_build_object('label','Registrar o resultado no CRM','done',false)),
      array['crm','agenda-bloqueio','corretor',case when normalized_action_type='reuniao' then 'reuniao' else 'visita' end]::text[],effective_duration,array_remove(array[actor,effective_assigned_to]::uuid[],null),0)
    returning id into calendar_activity_id;
    update public.crm_actions set metadata=metadata||jsonb_build_object('calendar_user_activity_id',calendar_activity_id) where id=action_id;
  end if;

  update public.crm_records set
    broker_user_id=case when private.is_broker_session() then broker_user_id else coalesce(effective_broker,broker_user_id) end,
    next_action_at=case when not effective_completed and effective_scheduled_at is not null then least(coalesce(next_action_at,effective_scheduled_at),effective_scheduled_at) else next_action_at end,
    first_response_at=case when effective_completed then coalesce(first_response_at,now()) else first_response_at end,
    attempts=case when effective_completed then coalesce(attempts,0)+1 else attempts end,
    stagnation_at=case when effective_completed then now() else stagnation_at end,
    updated_at=now()
  where id=lead.id;

  return jsonb_build_object('action_id',action_id,'broker_user_id',effective_broker,'broker_assignment_id',assignment_id,'calendar_user_activity_id',calendar_activity_id,'completed',effective_completed);
end $function$
;
CREATE OR REPLACE FUNCTION public.get_crm_broker_availability(p_organization_id uuid, p_broker_user_id uuid, p_from timestamp with time zone, p_to timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare actor uuid := auth.uid(); busy_value jsonb;
begin
  if actor is null then raise exception 'Autenticação obrigatória.' using errcode = '42501'; end if;
  if not public.is_org_member(p_organization_id) then raise exception 'Organização não autorizada.' using errcode = '42501'; end if;
  if private.is_broker_session() and p_broker_user_id<>actor then raise exception 'Somente sua própria agenda está disponível.' using errcode='42501'; end if;
  if p_from is null or p_to is null or p_to <= p_from or p_to - p_from > interval '31 days' then raise exception 'Período de disponibilidade inválido.'; end if;
  if not exists (
    select 1 from public.organization_members member
    where member.organization_id = p_organization_id and member.user_id = p_broker_user_id and member.active
      and (lower(member.role) = 'corretor' or exists (
        select 1 from public.crm_team_members team_member
        join public.crm_teams team on team.id = team_member.team_id and team.organization_id = team_member.organization_id
        where team_member.organization_id = p_organization_id and team_member.user_id = member.user_id
          and team_member.active and team.active
          and (lower(team.team_type) in ('corretor','corretores','vendas','comercial') or lower(team_member.team_role) like '%corretor%')
      ))
  ) then raise exception 'Corretor não elegível para esta organização.'; end if;

  with activity_intervals as (
    select activity.id::text source_id, 'user_activity'::text source_type, activity.starts_at,
      case when activity.due_at is not null and activity.due_at > activity.starts_at then activity.due_at
           else activity.starts_at + make_interval(mins => greatest(coalesce(activity.estimated_minutes,60),15)) end ends_at,
      case when activity.activity_type='visita' then 'Visita agendada' when activity.activity_type='reuniao' then 'Reunião' else 'Indisponível' end label,
      activity.activity_type kind
    from public.user_activities activity
    where activity.organization_id=p_organization_id and activity.owner_user_id=p_broker_user_id and activity.starts_at is not null
      and activity.board_status <> 'concluida' and activity.status <> 'cancelada'
      and (activity.activity_type in ('visita','reuniao','indisponibilidade','bloqueio_agenda') or activity.tags && array['agenda-bloqueio','indisponibilidade']::text[])
  ), action_intervals as (
    select action.id::text source_id, 'crm_action'::text source_type, action.scheduled_at starts_at,
      action.scheduled_at + make_interval(mins => greatest(coalesce(action.duration_minutes,60),15)) ends_at,
      case when action.action_type='visita' or action.outcome='visita_agendada' then 'Visita agendada' else 'Reunião' end label,
      coalesce(action.action_type,'compromisso') kind
    from public.crm_actions action
    where action.organization_id=p_organization_id and action.assigned_to=p_broker_user_id and action.scheduled_at is not null
      and action.action_status='pendente' and (action.action_type in ('visita','reuniao') or action.outcome='visita_agendada')
      and not (action.metadata ? 'calendar_user_activity_id')
  ), combined as (select * from activity_intervals union all select * from action_intervals)
  select coalesce(jsonb_agg(jsonb_build_object('sourceId',source_id,'sourceType',source_type,'startsAt',starts_at,'endsAt',ends_at,'label',label,'kind',kind) order by starts_at,ends_at),'[]'::jsonb)
  into busy_value from combined where starts_at < p_to and ends_at > p_from;
  return jsonb_build_object('brokerUserId',p_broker_user_id,'timezone','America/Sao_Paulo','workdayStart','08:00','workdayEnd','18:00','slotMinutes',30,'busy',busy_value,'generatedAt',now());
end $function$
;
CREATE OR REPLACE FUNCTION public.set_crm_assignment_status(p_assignment_id uuid, p_status text)
 RETURNS crm_lead_assignments
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  actor uuid := auth.uid();
  assignment public.crm_lead_assignments%rowtype;
  requested_status text := lower(trim(p_status));
  can_manage boolean;
  event_type text;
  result public.crm_lead_assignments%rowtype;
begin
  if actor is null then
    raise exception 'Autenticacao obrigatoria.';
  end if;

  select item.* into assignment
  from public.crm_lead_assignments item
  where item.id = p_assignment_id
  for update;

  if not found then
    raise exception 'Designacao nao localizada.';
  end if;
  if not public.is_org_member(assignment.organization_id) then
    raise exception 'Acesso negado.';
  end if;

  if private.is_broker_session() and not private.broker_can_read_record(assignment.organization_id,assignment.crm_record_id) then
    raise exception 'Atendimento fora da carteira autorizada.' using errcode='42501';
  end if;
  can_manage := public.has_app_permission(
      assignment.organization_id, 'crm.assign'
    ) or public.has_app_permission(
      assignment.organization_id, 'crm.monitor_team'
    );

  if actor <> assignment.assigned_user_id and not can_manage then
    raise exception 'Somente o designado ou um gestor autorizado pode alterar a designacao.';
  end if;
  if requested_status not in (
    'aceita', 'em_atendimento', 'concluida', 'recusada', 'cancelada'
  ) then
    raise exception 'Status de designacao invalido.';
  end if;
  if not can_manage and not (
    (assignment.status = 'atribuida' and requested_status in ('aceita', 'recusada'))
    or (assignment.status = 'aceita' and requested_status in ('em_atendimento', 'concluida'))
    or (assignment.status = 'em_atendimento' and requested_status = 'concluida')
  ) then
    raise exception 'Transicao de status nao permitida.';
  end if;
  if assignment.status in ('concluida', 'recusada', 'cancelada', 'substituida') then
    raise exception 'A designacao ja foi encerrada.';
  end if;
  if requested_status = assignment.status then
    return assignment;
  end if;

  event_type := case requested_status
    when 'aceita' then 'acknowledged'
    when 'em_atendimento' then 'started'
    when 'concluida' then 'completed'
    when 'recusada' then 'rejected'
    when 'cancelada' then 'cancelled'
  end;

  update public.crm_lead_assignments
  set status = requested_status,
      acknowledged_at = case when requested_status in (
        'aceita', 'em_atendimento', 'concluida'
      ) then coalesce(acknowledged_at, now()) else acknowledged_at end,
      started_at = case when requested_status in (
        'em_atendimento', 'concluida'
      ) then coalesce(started_at, now()) else started_at end,
      completed_at = case when requested_status = 'concluida'
        then now() else completed_at end,
      cancelled_at = case when requested_status in ('recusada', 'cancelada')
        then now() else cancelled_at end,
      status_updated_by = actor,
      updated_at = now()
  where id = assignment.id
  returning * into result;

  if assignment.user_activity_id is not null then
    update public.user_activities
    set status = case
          when requested_status = 'aceita' then 'pendente'
          when requested_status = 'em_atendimento' then 'em_andamento'
          when requested_status = 'concluida' then 'concluida'
          else 'cancelada' end,
        board_status = case
          when requested_status = 'aceita' then 'backlog'
          when requested_status = 'em_atendimento' then 'em_andamento'
          else 'concluida' end,
        acknowledged_at = case when requested_status in (
          'aceita', 'em_atendimento', 'concluida'
        ) then coalesce(acknowledged_at, now()) else acknowledged_at end,
        acknowledged_by = case when requested_status in (
          'aceita', 'em_atendimento', 'concluida'
        ) then coalesce(acknowledged_by, actor) else acknowledged_by end,
        progress_percent = case
          when requested_status = 'aceita' then greatest(progress_percent, 10)
          when requested_status = 'em_atendimento' then greatest(progress_percent, 40)
          when requested_status = 'concluida' then 100
          else progress_percent end,
        progress_note = case
          when requested_status = 'recusada' then 'Designacao recusada pelo responsavel.'
          when requested_status = 'cancelada' then 'Designacao cancelada pelo gestor.'
          else progress_note end,
        completed_at = case when requested_status in (
          'concluida', 'recusada', 'cancelada'
        ) then now() else completed_at end,
        last_progress_at = now(), updated_by = actor, updated_at = now()
    where id = assignment.user_activity_id;
  end if;

  if assignment.crm_action_id is not null then
    update public.crm_actions
    set action_status = case
          when requested_status in ('concluida', 'recusada', 'cancelada')
            then 'concluida'
          else 'pendente' end,
        completed_at = case when requested_status in (
          'concluida', 'recusada', 'cancelada'
        ) then now() else completed_at end,
        outcome = case
          when requested_status = 'concluida' then 'atendimento_concluido'
          when requested_status = 'recusada' then 'designacao_recusada'
          when requested_status = 'cancelada' then 'designacao_cancelada'
          else outcome end
    where id = assignment.crm_action_id;
  end if;

  if requested_status in ('recusada', 'cancelada') then
    update public.crm_records
    set sdr_user_id = case
          when assignment.assignment_role = 'sdr'
               and sdr_user_id = assignment.assigned_user_id then null
          else sdr_user_id end,
        broker_user_id = case
          when assignment.assignment_role = 'corretor'
               and broker_user_id = assignment.assigned_user_id then null
          else broker_user_id end,
        updated_at = now()
    where id = assignment.crm_record_id;
  end if;

  if requested_status in ('concluida', 'recusada', 'cancelada') then
    update public.crm_alerts
    set status = 'resolvido', resolved_at = now()
    where crm_record_id = assignment.crm_record_id
      and alert_type like 'crm_assignment:' || assignment.id::text || ':%'
      and status = 'aberto';
  end if;

  insert into public.crm_lead_assignment_events (
    organization_id, assignment_id, event_type, previous_status,
    new_status, actor_user_id
  ) values (
    assignment.organization_id, assignment.id, event_type,
    assignment.status, requested_status, actor
  );

  return result;
end
$function$
;
CREATE OR REPLACE FUNCTION public.crm_document_storage_write_allowed(p_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  path_parts text[] := storage.foldername(p_name);
  organization_key uuid;
  record_key uuid;
  record_status_value text;
begin
  if private.is_broker_session() then return private.broker_storage_allowed('erp-documents',p_name,true); end if;
  if coalesce(array_length(path_parts, 1), 0) < 1
     or path_parts[1] !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;

  organization_key := path_parts[1]::uuid;
  if not public.is_org_member(organization_key) then
    return false;
  end if;

  if public.crm_canonical_restore_active(organization_key) then
    return true;
  end if;

  if coalesce(path_parts[2], '') <> 'crm_record' then
    return true;
  end if;

  if coalesce(path_parts[3], '') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    return false;
  end if;
  record_key := path_parts[3]::uuid;

  select record.record_status
    into record_status_value
  from public.crm_records record
  where record.organization_id = organization_key
    and record.id = record_key
  for key share;

  return found and record_status_value <> 'arquivada';
end
$function$
;


-- Compartilhamento explícito de carteira com uma imobiliária, administrado pela gestão.
create or replace function public.assign_crm_brokerage(p_crm_record_id uuid,p_team_id uuid default null)
returns void language plpgsql security definer set search_path='' as $$
declare lead public.crm_records%rowtype;
begin
 select * into lead from public.crm_records where id=p_crm_record_id for update;
 if not found or not public.has_app_permission(lead.organization_id,'crm.assign') then
  raise exception 'Você não pode alterar a designação deste lead.' using errcode='42501';
 end if;
 if p_team_id is not null and not exists(select 1 from public.crm_teams t where t.id=p_team_id and t.organization_id=lead.organization_id and t.active and t.is_brokerage) then
  raise exception 'Selecione uma imobiliária ativa da organização.' using errcode='22023';
 end if;
 update public.crm_records set team_id=p_team_id,updated_at=now() where id=lead.id;
 insert into public.audit_logs(organization_id,user_id,action,entity,entity_id,old_data,new_data)
 values(lead.organization_id,auth.uid(),'assign_brokerage','crm_records',lead.id::text,jsonb_build_object('team_id',lead.team_id),jsonb_build_object('team_id',p_team_id));
end $$;
revoke all on function public.assign_crm_brokerage(uuid,uuid) from public,anon;
grant execute on function public.assign_crm_brokerage(uuid,uuid) to authenticated;
