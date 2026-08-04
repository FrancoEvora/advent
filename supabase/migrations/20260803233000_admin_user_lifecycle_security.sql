-- Évora Gestão 6.24 — ciclo seguro de usuários.
-- Remove as políticas legadas baseadas apenas no uid e exige vínculo ativo
-- com a organização em cada acesso financeiro. Assim, suspender ou excluir
-- um membro interrompe o acesso mesmo enquanto um JWT antigo ainda não expirou.

begin;

create or replace function public.is_active_organization_member(
  p_organization_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
      from public.organization_members member
     where member.organization_id = p_organization_id
       and member.user_id = (select auth.uid())
       and member.active = true
  );
$function$;

create or replace function public.has_any_active_membership()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
      from public.organization_members member
     where member.user_id = (select auth.uid())
       and member.active = true
  );
$function$;

create or replace function public.shares_active_organization(
  p_profile_user_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
      from public.organization_members viewer
      join public.organization_members target
        on target.organization_id = viewer.organization_id
       and target.user_id = p_profile_user_id
     where viewer.user_id = (select auth.uid())
       and viewer.active = true
  );
$function$;

revoke all on function public.is_active_organization_member(uuid)
  from public, anon;
revoke all on function public.has_any_active_membership()
  from public, anon;
revoke all on function public.shares_active_organization(uuid)
  from public, anon;
grant execute on function public.is_active_organization_member(uuid)
  to authenticated;
grant execute on function public.has_any_active_membership()
  to authenticated;
grant execute on function public.shares_active_organization(uuid)
  to authenticated;

do $block$
begin
  if to_regclass('public.financial_entries') is not null then
    alter table public.financial_entries enable row level security;

    drop policy if exists entries_select_own
      on public.financial_entries;
    drop policy if exists entries_insert_own
      on public.financial_entries;
    drop policy if exists entries_update_own
      on public.financial_entries;
    drop policy if exists entries_delete_own
      on public.financial_entries;
    -- As políticas legadas de organização eram permissivas. Mantê-las faria
    -- o PostgreSQL combinar as regras com OR e contornar as novas alçadas.
    drop policy if exists entries_org_select
      on public.financial_entries;
    drop policy if exists entries_org_insert
      on public.financial_entries;
    drop policy if exists entries_org_update
      on public.financial_entries;
    drop policy if exists entries_org_delete
      on public.financial_entries;
    drop policy if exists financial_entries_active_member_select
      on public.financial_entries;
    drop policy if exists financial_entries_active_member_insert
      on public.financial_entries;
    drop policy if exists financial_entries_active_member_update
      on public.financial_entries;
    drop policy if exists financial_entries_active_member_delete
      on public.financial_entries;
    drop policy if exists financial_entries_require_active_member
      on public.financial_entries;

    create policy financial_entries_active_member_select
      on public.financial_entries
      for select
      to authenticated
      using (
        public.is_active_organization_member(organization_id)
        and public.has_app_permission(organization_id, 'financial.view')
      );

    create policy financial_entries_active_member_insert
      on public.financial_entries
      for insert
      to authenticated
      with check (
        public.is_active_organization_member(organization_id)
        and public.has_app_permission(organization_id, 'financial.manage')
      );

    create policy financial_entries_active_member_update
      on public.financial_entries
      for update
      to authenticated
      using (
        public.is_active_organization_member(organization_id)
        and public.has_app_permission(organization_id, 'financial.manage')
      )
      with check (
        public.is_active_organization_member(organization_id)
        and public.has_app_permission(organization_id, 'financial.manage')
      );

    create policy financial_entries_active_member_delete
      on public.financial_entries
      for delete
      to authenticated
      using (
        public.is_active_organization_member(organization_id)
        and public.has_app_permission(organization_id, 'financial.manage')
      );

    -- Política restritiva: continua valendo em conjunto com qualquer política
    -- permissiva adicionada por outro módulo.
    create policy financial_entries_require_active_member
      on public.financial_entries
      as restrictive
      for all
      to authenticated
      using (
        public.is_active_organization_member(organization_id)
      )
      with check (
        public.is_active_organization_member(organization_id)
      );
  end if;
end
$block$;

do $block$
begin
  if to_regclass('public.profiles') is not null then
    alter table public.profiles enable row level security;

    drop policy if exists profiles_select_own on public.profiles;
    drop policy if exists profiles_update_own on public.profiles;
    drop policy if exists profiles_active_org_select on public.profiles;
    drop policy if exists profiles_active_self_update on public.profiles;
    drop policy if exists profiles_require_active_member on public.profiles;

    create policy profiles_active_org_select
      on public.profiles
      for select
      to authenticated
      using (public.shares_active_organization(id));

    create policy profiles_active_self_update
      on public.profiles
      for update
      to authenticated
      using (
        id = (select auth.uid())
        and public.has_any_active_membership()
      )
      with check (
        id = (select auth.uid())
        and public.has_any_active_membership()
      );

    create policy profiles_require_active_member
      on public.profiles
      as restrictive
      for all
      to authenticated
      using (public.has_any_active_membership())
      with check (public.has_any_active_membership());
  end if;
end
$block$;

-- Operação persistida para que a exclusão continue idempotente mesmo quando
-- a chamada ao serviço de identidade e a transação do banco ocorram em etapas
-- diferentes. Os identificadores não têm FK para auth.users de propósito: a
-- trilha precisa sobreviver à exclusão lógica da credencial.
create table if not exists public.admin_user_lifecycle_operations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations(id) on delete cascade,
  target_user_id uuid not null,
  actor_user_id uuid not null,
  action text not null default 'delete_profile'
    check (action = 'delete_profile'),
  status text not null default 'prepared'
    check (status in ('prepared', 'completed')),
  target_role text not null,
  target_was_active boolean not null,
  active_assignments_cancelled integer not null default 0,
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index if not exists
  admin_user_lifecycle_operations_pending_uidx
  on public.admin_user_lifecycle_operations (
    organization_id, target_user_id, action
  )
  where status = 'prepared';

create index if not exists admin_user_lifecycle_operations_lookup_idx
  on public.admin_user_lifecycle_operations (
    organization_id, target_user_id, created_at desc
  );

alter table public.admin_user_lifecycle_operations enable row level security;
revoke all on table public.admin_user_lifecycle_operations
  from public, anon, authenticated;
grant all on table public.admin_user_lifecycle_operations to service_role;

-- Defesa adicional para qualquer alteração futura que não passe pela API.
-- As RPCs abaixo adquirem a mesma trava antes da leitura, eliminando a corrida
-- entre dois administradores removidos ou suspensos simultaneamente.
create or replace function public.enforce_last_active_organization_admin()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_other_admins integer;
  v_removes_admin boolean := false;
begin
  if tg_op = 'DELETE' then
    v_removes_admin := old.active = true and old.role = 'admin';
  else
    v_removes_admin :=
      old.active = true
      and old.role = 'admin'
      and (new.active = false or new.role <> 'admin');
  end if;

  if v_removes_admin then
    perform pg_advisory_xact_lock(
      hashtextextended(old.organization_id::text, 0)
    );

    -- Não bloqueia uma exclusão em cascata da própria organização.
    if exists (
      select 1
        from public.organizations organization
       where organization.id = old.organization_id
    ) then
      select count(*)::integer
        into v_other_admins
        from public.organization_members member
       where member.organization_id = old.organization_id
         and member.role = 'admin'
         and member.active = true
         and member.id <> old.id;

      if v_other_admins = 0 then
        raise exception using
          errcode = 'P0001',
          message = 'LAST_ACTIVE_ADMIN';
      end if;
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end
$function$;

revoke all on function public.enforce_last_active_organization_admin()
  from public, anon, authenticated;

drop trigger if exists organization_members_preserve_last_admin
  on public.organization_members;
create trigger organization_members_preserve_last_admin
before update of role, active or delete
on public.organization_members
for each row
execute function public.enforce_last_active_organization_admin();

create or replace function public.admin_manage_member_access(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_action text,
  p_role text default null,
  p_active boolean default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_target public.organization_members%rowtype;
  v_remaining_admins integer;
  v_new_role text;
  v_new_active boolean;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text, 0));

  if not exists (
    select 1
      from public.organization_members actor
     where actor.organization_id = p_organization_id
       and actor.user_id = p_actor_user_id
       and actor.role = 'admin'
       and actor.active = true
  ) then
    raise exception using errcode = 'P0001', message = 'ADMIN_REQUIRED';
  end if;

  select target.*
    into v_target
    from public.organization_members target
   where target.organization_id = p_organization_id
     and target.user_id = p_target_user_id
   for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'TARGET_NOT_FOUND';
  end if;

  v_new_role := v_target.role;
  v_new_active := v_target.active;

  if p_action = 'change_role' then
    if p_role is null or p_role not in (
      'admin', 'diretoria', 'financeiro', 'engenharia', 'comercial',
      'compras', 'consulta', 'gestor_crm', 'sdr', 'corretor', 'marketing'
    ) then
      raise exception using errcode = 'P0001', message = 'INVALID_ROLE';
    end if;
    if p_target_user_id = p_actor_user_id
       and v_target.role = 'admin'
       and p_role <> 'admin' then
      raise exception using errcode = 'P0001', message = 'SELF_ADMIN_DEMOTION';
    end if;
    v_new_role := p_role;
  elsif p_action = 'set_active' then
    if p_active is null then
      raise exception using errcode = 'P0001', message = 'INVALID_ACTIVE_STATE';
    end if;
    if p_target_user_id = p_actor_user_id and p_active = false then
      raise exception using errcode = 'P0001', message = 'SELF_SUSPENSION';
    end if;
    v_new_active := p_active;
  else
    raise exception using errcode = 'P0001', message = 'INVALID_ACTION';
  end if;

  if v_target.role = 'admin'
     and v_target.active = true
     and (v_new_role <> 'admin' or v_new_active = false) then
    select count(*)::integer
      into v_remaining_admins
      from public.organization_members member
     where member.organization_id = p_organization_id
       and member.role = 'admin'
       and member.active = true
       and member.id <> v_target.id;
    if v_remaining_admins = 0 then
      raise exception using errcode = 'P0001', message = 'LAST_ACTIVE_ADMIN';
    end if;
  end if;

  update public.organization_members
     set role = v_new_role,
         active = v_new_active,
         updated_at = now()
   where id = v_target.id;

  insert into public.audit_logs (
    organization_id, user_id, action, entity, entity_id,
    old_data, new_data
  ) values (
    p_organization_id,
    p_actor_user_id,
    case when p_action = 'change_role'
      then 'admin_member_role_changed'
      else 'admin_member_access_changed'
    end,
    'organization_members',
    v_target.id::text,
    jsonb_build_object(
      'role', v_target.role,
      'active', v_target.active
    ),
    jsonb_build_object(
      'role', v_new_role,
      'active', v_new_active,
      'target_user_id', p_target_user_id,
      'changed_at', now()
    )
  );

  return jsonb_build_object(
    'action', p_action,
    'role', v_new_role,
    'active', v_new_active
  );
end
$function$;

create or replace function public.admin_prepare_profile_deletion(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_target_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_target public.organization_members%rowtype;
  v_operation public.admin_user_lifecycle_operations%rowtype;
  v_remaining_admins integer;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text, 0));

  if not exists (
    select 1
      from public.organization_members actor
     where actor.organization_id = p_organization_id
       and actor.user_id = p_actor_user_id
       and actor.role = 'admin'
       and actor.active = true
  ) then
    raise exception using errcode = 'P0001', message = 'ADMIN_REQUIRED';
  end if;
  if p_actor_user_id = p_target_user_id then
    raise exception using errcode = 'P0001', message = 'SELF_DELETION';
  end if;

  select operation.*
    into v_operation
    from public.admin_user_lifecycle_operations operation
   where operation.organization_id = p_organization_id
     and operation.target_user_id = p_target_user_id
     and operation.action = 'delete_profile'
     and operation.status = 'prepared'
   order by operation.created_at desc
   limit 1
   for update;
  if found then
    return jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'active_assignments_cancelled',
        v_operation.active_assignments_cancelled
    );
  end if;

  select target.*
    into v_target
    from public.organization_members target
   where target.organization_id = p_organization_id
     and target.user_id = p_target_user_id
   for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'TARGET_NOT_FOUND';
  end if;

  if exists (
    select 1
      from public.organization_members other_member
     where other_member.user_id = p_target_user_id
       and other_member.organization_id <> p_organization_id
  ) then
    raise exception using errcode = 'P0001', message = 'OTHER_ORGANIZATIONS';
  end if;

  if v_target.role = 'admin' and v_target.active = true then
    select count(*)::integer
      into v_remaining_admins
      from public.organization_members member
     where member.organization_id = p_organization_id
       and member.role = 'admin'
       and member.active = true
       and member.id <> v_target.id;
    if v_remaining_admins = 0 then
      raise exception using errcode = 'P0001', message = 'LAST_ACTIVE_ADMIN';
    end if;
  end if;

  insert into public.admin_user_lifecycle_operations (
    organization_id, target_user_id, actor_user_id,
    target_role, target_was_active
  ) values (
    p_organization_id, p_target_user_id, p_actor_user_id,
    v_target.role, v_target.active
  )
  returning * into v_operation;

  update public.organization_members
     set active = false,
         updated_at = now()
   where id = v_target.id;

  insert into public.audit_logs (
    organization_id, user_id, action, entity, entity_id,
    old_data, new_data
  ) values (
    p_organization_id,
    p_actor_user_id,
    'admin_profile_deletion_prepared',
    'auth_user',
    p_target_user_id::text,
    jsonb_build_object(
      'role', v_target.role,
      'active', v_target.active
    ),
    jsonb_build_object(
      'operation_id', v_operation.id,
      'access_suspended', true,
      'prepared_at', now()
    )
  );

  return jsonb_build_object(
    'operation_id', v_operation.id,
    'status', v_operation.status,
    'active_assignments_cancelled', 0
  );
end
$function$;

create or replace function public.admin_finalize_profile_deletion(
  p_organization_id uuid,
  p_actor_user_id uuid,
  p_target_user_id uuid,
  p_operation_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_operation public.admin_user_lifecycle_operations%rowtype;
  v_assignment public.crm_lead_assignments%rowtype;
  v_cancelled integer := 0;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text, 0));

  if not exists (
    select 1
      from public.organization_members actor
     where actor.organization_id = p_organization_id
       and actor.user_id = p_actor_user_id
       and actor.role = 'admin'
       and actor.active = true
  ) then
    raise exception using errcode = 'P0001', message = 'ADMIN_REQUIRED';
  end if;

  select operation.*
    into v_operation
    from public.admin_user_lifecycle_operations operation
   where operation.id = p_operation_id
     and operation.organization_id = p_organization_id
     and operation.target_user_id = p_target_user_id
     and operation.action = 'delete_profile'
   for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'OPERATION_NOT_FOUND';
  end if;

  if v_operation.status = 'completed' then
    return jsonb_build_object(
      'operation_id', v_operation.id,
      'status', v_operation.status,
      'active_assignments_cancelled',
        v_operation.active_assignments_cancelled
    );
  end if;

  for v_assignment in
    select assignment.*
      from public.crm_lead_assignments assignment
     where assignment.organization_id = p_organization_id
       and assignment.assigned_user_id = p_target_user_id
       and assignment.status in ('atribuida', 'aceita', 'em_atendimento')
     for update
  loop
    update public.crm_lead_assignments
       set status = 'cancelada',
           cancelled_at = now(),
           status_updated_by = p_actor_user_id,
           updated_at = now()
     where id = v_assignment.id;

    insert into public.crm_lead_assignment_events (
      organization_id, assignment_id, event_type,
      previous_status, new_status, actor_user_id, note, metadata
    ) values (
      p_organization_id, v_assignment.id, 'cancelled',
      v_assignment.status, 'cancelada', p_actor_user_id,
      'Designação encerrada pela exclusão administrativa do perfil.',
      jsonb_build_object('source', 'admin_user_management')
    );

    if v_assignment.user_activity_id is not null then
      update public.user_activities
         set status = 'cancelada',
             board_status = 'concluida',
             completed_at = now(),
             progress_note =
               'Cancelada pela exclusão administrativa do perfil.',
             updated_by = p_actor_user_id,
             updated_at = now()
       where id = v_assignment.user_activity_id;
    end if;
    v_cancelled := v_cancelled + 1;
  end loop;

  update public.crm_records
     set sdr_user_id = null, updated_at = now()
   where organization_id = p_organization_id
     and sdr_user_id = p_target_user_id;
  update public.crm_records
     set broker_user_id = null, updated_at = now()
   where organization_id = p_organization_id
     and broker_user_id = p_target_user_id;
  update public.crm_records
     set owner_user_id = null, updated_at = now()
   where organization_id = p_organization_id
     and owner_user_id = p_target_user_id;

  update public.crm_actions
     set assigned_to = p_actor_user_id
   where organization_id = p_organization_id
     and assigned_to = p_target_user_id
     and action_status = 'pendente';

  update public.user_activities
     set owner_user_id = p_actor_user_id,
         updated_by = p_actor_user_id,
         updated_at = now(),
         progress_note =
           'Reatribuída ao administrador pela exclusão do responsável anterior.'
   where organization_id = p_organization_id
     and owner_user_id = p_target_user_id
     and status not in ('concluida', 'cancelada');

  update public.approval_requests
     set assigned_to = p_actor_user_id
   where organization_id = p_organization_id
     and assigned_to = p_target_user_id
     and status = 'pendente';

  update public.insights
     set responsible_user_id = p_actor_user_id
   where organization_id = p_organization_id
     and responsible_user_id = p_target_user_id
     and status not in ('resolvido', 'descartado');

  update public.construction_work_packages
     set responsible_user_id = null,
         updated_at = now()
   where organization_id = p_organization_id
     and responsible_user_id = p_target_user_id;

  delete from public.organization_members
   where organization_id = p_organization_id
     and user_id = p_target_user_id;
  delete from public.profiles
   where id = p_target_user_id;

  insert into public.audit_logs (
    organization_id, user_id, action, entity, entity_id,
    old_data, new_data
  ) values (
    p_organization_id,
    p_actor_user_id,
    'admin_profile_soft_deleted',
    'auth_user',
    p_target_user_id::text,
    jsonb_build_object(
      'role', v_operation.target_role,
      'active', v_operation.target_was_active
    ),
    jsonb_build_object(
      'operation_id', v_operation.id,
      'profile_removed', true,
      'auth_soft_deleted', true,
      'active_assignments_cancelled', v_cancelled,
      'removed_at', now()
    )
  );

  update public.admin_user_lifecycle_operations
     set status = 'completed',
         active_assignments_cancelled = v_cancelled,
         last_error_code = null,
         updated_at = now(),
         completed_at = now()
   where id = v_operation.id;

  return jsonb_build_object(
    'operation_id', v_operation.id,
    'status', 'completed',
    'active_assignments_cancelled', v_cancelled
  );
end
$function$;

revoke all on function public.admin_manage_member_access(
  uuid, uuid, uuid, text, text, boolean
) from public, anon, authenticated;
revoke all on function public.admin_prepare_profile_deletion(
  uuid, uuid, uuid
) from public, anon, authenticated;
revoke all on function public.admin_finalize_profile_deletion(
  uuid, uuid, uuid, uuid
) from public, anon, authenticated;
grant execute on function public.admin_manage_member_access(
  uuid, uuid, uuid, text, text, boolean
) to service_role;
grant execute on function public.admin_prepare_profile_deletion(
  uuid, uuid, uuid
) to service_role;
grant execute on function public.admin_finalize_profile_deletion(
  uuid, uuid, uuid, uuid
) to service_role;

commit;
