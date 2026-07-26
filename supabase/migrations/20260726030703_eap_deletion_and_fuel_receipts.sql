-- EAP deletion is exposed only through guarded RPCs. The predefined template
-- library is intentionally outside the deletion scope.

create or replace function private.preview_construction_deletion(
  p_organization_id uuid,
  p_project_id uuid default null,
  p_package_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_project_id uuid;
  v_scope text;
  v_result jsonb;
begin
  if v_user_id is null then
    raise exception 'Sessão expirada.';
  end if;

  if (p_project_id is null) = (p_package_id is null) then
    raise exception 'Informe uma EAP ou um elemento para analisar.';
  end if;

  if not public.has_app_permission(
    p_organization_id,
    'construction.manage'
  ) then
    raise exception 'Sem permissão para excluir elementos da EAP.';
  end if;

  if p_package_id is not null then
    select work_package.project_id
      into v_project_id
    from public.construction_work_packages work_package
    where work_package.id = p_package_id
      and work_package.organization_id = p_organization_id;

    if not found then
      raise exception 'Elemento da EAP não encontrado.';
    end if;
    v_scope := 'package';
  else
    select project.id
      into v_project_id
    from public.projects project
    where project.id = p_project_id
      and project.organization_id = p_organization_id;

    if not found then
      raise exception 'Empreendimento não encontrado.';
    end if;
    v_scope := 'eap';
  end if;

  with recursive targets(id) as (
    select work_package.id
    from public.construction_work_packages work_package
    where work_package.organization_id = p_organization_id
      and (
        (
          p_package_id is not null
          and work_package.id = p_package_id
        )
        or (
          p_package_id is null
          and work_package.project_id = v_project_id
        )
      )

    union

    select child.id
    from public.construction_work_packages child
    join targets parent on parent.id = child.parent_id
    where p_package_id is not null
      and child.organization_id = p_organization_id
      and child.project_id = v_project_id
  ),
  dependency_counts as (
    select
      (
        select count(*)::integer
        from public.construction_work_packages work_package
        where work_package.id in (select target.id from targets target)
          and (
            work_package.status not in ('planejado', 'cancelado')
            or coalesce(work_package.actual_progress, 0) <> 0
            or work_package.actual_start is not null
            or work_package.actual_end is not null
            or coalesce(work_package.committed_amount, 0) <> 0
            or coalesce(work_package.measured_amount, 0) <> 0
            or coalesce(work_package.paid_amount, 0) <> 0
          )
      ) as activity_count,
      (
        select count(*)::integer
        from public.purchase_requests item
        where item.organization_id = p_organization_id
          and item.work_package_id in (
            select target.id from targets target
          )
      ) as purchase_count,
      (
        select count(*)::integer
        from public.operational_contracts item
        where item.organization_id = p_organization_id
          and item.work_package_id in (
            select target.id from targets target
          )
      ) as contract_count,
      (
        select count(*)::integer
        from public.contract_measurements item
        where item.organization_id = p_organization_id
          and item.work_package_id in (
            select target.id from targets target
          )
      ) as measurement_count,
      (
        select count(*)::integer
        from public.construction_daily_logs item
        where item.organization_id = p_organization_id
          and item.work_package_id in (
            select target.id from targets target
          )
      ) as daily_log_count,
      (
        select count(*)::integer
        from public.construction_progress_snapshots item
        where item.organization_id = p_organization_id
          and item.work_package_id in (
            select target.id from targets target
          )
      ) as progress_count,
      (
        select count(*)::integer
        from public.construction_hseq_records item
        where item.organization_id = p_organization_id
          and item.work_package_id in (
            select target.id from targets target
          )
      ) as hseq_count,
      (
        select count(*)::integer
        from public.construction_risks item
        where item.organization_id = p_organization_id
          and item.work_package_id in (
            select target.id from targets target
          )
      ) as risk_count,
      (
        select count(*)::integer
        from public.construction_change_orders item
        where item.organization_id = p_organization_id
          and item.work_package_id in (
            select target.id from targets target
          )
      ) as change_order_count
  ),
  deletion_summary as (
    select
      (select count(*)::integer from targets) as element_count,
      (
        select pg_catalog.md5(
          coalesce(
            pg_catalog.string_agg(
              pg_catalog.jsonb_build_array(
                work_package.id::text,
                work_package.parent_id::text,
                work_package.project_id::text,
                coalesce(work_package.wbs_code, ''),
                coalesce(work_package.package_code, ''),
                work_package.code,
                work_package.name,
                work_package.status,
                work_package.is_summary,
                work_package.sort_order,
                extract(epoch from work_package.updated_at)::text
              )::text,
              '|' order by work_package.id
            ),
            ''
          )
        )
        from public.construction_work_packages work_package
        where work_package.id in (
          select target.id from targets target
        )
      ) as target_token,
      case
        when v_scope = 'package' then
          greatest((select count(*)::integer from targets) - 1, 0)
        else (
          select count(*)::integer
          from public.construction_work_packages work_package
          where work_package.id in (select target.id from targets target)
            and work_package.parent_id is not null
        )
      end as descendant_count,
      dependency.activity_count,
      dependency.purchase_count,
      dependency.contract_count,
      dependency.measurement_count,
      dependency.daily_log_count,
      dependency.progress_count,
      dependency.hseq_count,
      dependency.risk_count,
      dependency.change_order_count,
      (
        dependency.activity_count
        + dependency.purchase_count
        + dependency.contract_count
        + dependency.measurement_count
        + dependency.daily_log_count
        + dependency.progress_count
        + dependency.hseq_count
        + dependency.risk_count
        + dependency.change_order_count
      )::integer as dependency_total
    from dependency_counts dependency
  )
  select jsonb_build_object(
    'scope', v_scope,
    'element_count', summary.element_count,
    'target_token', summary.target_token,
    'descendant_count', summary.descendant_count,
    'dependency_total', summary.dependency_total,
    'can_delete',
      summary.element_count > 0 and summary.dependency_total = 0,
    'dependencies', jsonb_build_array(
      jsonb_build_object(
        'key', 'activity',
        'label', 'Evolução ou valores realizados',
        'count', summary.activity_count
      ),
      jsonb_build_object(
        'key', 'purchases',
        'label', 'Compras e solicitações',
        'count', summary.purchase_count
      ),
      jsonb_build_object(
        'key', 'contracts',
        'label', 'Contratos operacionais',
        'count', summary.contract_count
      ),
      jsonb_build_object(
        'key', 'measurements',
        'label', 'Medições contratuais',
        'count', summary.measurement_count
      ),
      jsonb_build_object(
        'key', 'daily_logs',
        'label', 'Diários de obra',
        'count', summary.daily_log_count
      ),
      jsonb_build_object(
        'key', 'progress',
        'label', 'Apontamentos de progresso',
        'count', summary.progress_count
      ),
      jsonb_build_object(
        'key', 'hseq',
        'label', 'Registros de segurança e qualidade',
        'count', summary.hseq_count
      ),
      jsonb_build_object(
        'key', 'risks',
        'label', 'Riscos da obra',
        'count', summary.risk_count
      ),
      jsonb_build_object(
        'key', 'change_orders',
        'label', 'Ordens de alteração',
        'count', summary.change_order_count
      )
    )
  )
    into v_result
  from deletion_summary summary;

  return v_result;
end;
$$;

revoke all on function private.preview_construction_deletion(
  uuid,
  uuid,
  uuid
) from public, anon, authenticated;

create or replace function public.preview_construction_work_package_deletion(
  p_organization_id uuid,
  p_package_id uuid
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.preview_construction_deletion(
    p_organization_id,
    null,
    p_package_id
  );
$$;

create or replace function public.preview_construction_eap_deletion(
  p_organization_id uuid,
  p_project_id uuid
)
returns jsonb
language sql
security definer
set search_path = ''
as $$
  select private.preview_construction_deletion(
    p_organization_id,
    p_project_id,
    null
  );
$$;

create or replace function public.delete_construction_work_package(
  p_organization_id uuid,
  p_package_id uuid,
  p_expected_count integer,
  p_expected_token text,
  p_include_descendants boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_project_id uuid;
  v_preview jsonb;
  v_element_count integer;
  v_descendant_count integer;
  v_target_token text;
  v_target_ids uuid[];
  v_target_snapshot jsonb;
  v_deleted_count integer;
begin
  if v_user_id is null then
    raise exception 'Sessão expirada.';
  end if;

  if not public.has_app_permission(
    p_organization_id,
    'construction.manage'
  ) then
    raise exception 'Sem permissão para excluir elementos da EAP.';
  end if;

  select work_package.project_id
    into v_project_id
  from public.construction_work_packages work_package
  where work_package.id = p_package_id
    and work_package.organization_id = p_organization_id;

  if not found then
    raise exception 'Elemento da EAP não encontrado.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'construction-eap:'
      || p_organization_id::text
      || ':'
      || v_project_id::text,
      0
    )
  );

  perform 1
  from public.projects project
  where project.id = v_project_id
    and project.organization_id = p_organization_id
  for update;

  if not found then
    raise exception
      'O empreendimento foi alterado. Revise a análise antes de excluir.';
  end if;

  perform 1
  from public.construction_work_packages work_package
  where work_package.organization_id = p_organization_id
    and work_package.project_id = v_project_id
  order by work_package.id
  for update;

  if not exists (
    select 1
    from public.construction_work_packages work_package
    where work_package.id = p_package_id
      and work_package.organization_id = p_organization_id
      and work_package.project_id = v_project_id
  ) then
    raise exception
      'A estrutura da EAP foi alterada. Revise a análise antes de excluir.';
  end if;

  v_preview := private.preview_construction_deletion(
    p_organization_id,
    null,
    p_package_id
  );
  v_element_count := (v_preview ->> 'element_count')::integer;
  v_descendant_count := (v_preview ->> 'descendant_count')::integer;
  v_target_token := v_preview ->> 'target_token';

  if p_expected_count is null or p_expected_count <> v_element_count then
    raise exception
      'A estrutura da EAP foi alterada. Revise a análise antes de excluir.';
  end if;
  if p_expected_token is null or p_expected_token <> v_target_token then
    raise exception
      'A estrutura da EAP foi alterada. Revise a análise antes de excluir.';
  end if;
  if not coalesce((v_preview ->> 'can_delete')::boolean, false) then
    raise exception
      'Exclusão bloqueada: existem registros operacionais vinculados.';
  end if;
  if v_descendant_count > 0 and not coalesce(
    p_include_descendants,
    false
  ) then
    raise exception
      'O elemento possui subetapas. Confirme a exclusão da subárvore.';
  end if;

  with recursive targets(id) as (
    select work_package.id
    from public.construction_work_packages work_package
    where work_package.id = p_package_id
      and work_package.organization_id = p_organization_id

    union

    select child.id
    from public.construction_work_packages child
    join targets parent on parent.id = child.parent_id
    where child.organization_id = p_organization_id
      and child.project_id = v_project_id
  )
  select
    coalesce(
      pg_catalog.array_agg(
        work_package.id order by work_package.id
      ),
      array[]::uuid[]
    ),
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', work_package.id,
          'parent_id', work_package.parent_id,
          'wbs_code', work_package.wbs_code,
          'name', work_package.name,
          'status', work_package.status,
          'updated_at', work_package.updated_at
        )
        order by work_package.id
      ),
      '[]'::jsonb
    )
    into v_target_ids, v_target_snapshot
  from targets target
  join public.construction_work_packages work_package
    on work_package.id = target.id
  where work_package.organization_id = p_organization_id
    and work_package.project_id = v_project_id;

  if pg_catalog.cardinality(v_target_ids) <> v_element_count then
    raise exception
      'A estrutura da EAP foi alterada. Revise a análise antes de excluir.';
  end if;

  delete from public.construction_work_packages work_package
  where work_package.organization_id = p_organization_id
    and work_package.project_id = v_project_id
    and work_package.id = any(v_target_ids);

  get diagnostics v_deleted_count = row_count;
  if v_deleted_count <> v_element_count then
    raise exception
      'A exclusão não foi concluída integralmente; nenhuma alteração foi salva.';
  end if;

  insert into public.audit_logs(
    organization_id,
    user_id,
    action,
    entity,
    entity_id,
    old_data,
    new_data
  )
  values (
    p_organization_id,
    v_user_id,
    'DELETE',
    'construction_work_packages',
    p_package_id::text,
    pg_catalog.jsonb_build_object(
      'scope', 'package',
      'project_id', v_project_id,
      'root_package_id', p_package_id,
      'element_count', v_deleted_count,
      'target_token', v_target_token,
      'elements', v_target_snapshot
    ),
    null
  );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'scope', 'package',
    'deleted_count', v_deleted_count,
    'project_id', v_project_id,
    'target_token', v_target_token
  );
end;
$$;

create or replace function public.delete_construction_eap(
  p_organization_id uuid,
  p_project_id uuid,
  p_expected_count integer,
  p_expected_token text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_preview jsonb;
  v_element_count integer;
  v_target_token text;
  v_target_ids uuid[];
  v_target_snapshot jsonb;
  v_deleted_count integer;
begin
  if v_user_id is null then
    raise exception 'Sessão expirada.';
  end if;

  if not public.has_app_permission(
    p_organization_id,
    'construction.manage'
  ) then
    raise exception 'Sem permissão para excluir a EAP.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'construction-eap:'
      || p_organization_id::text
      || ':'
      || p_project_id::text,
      0
    )
  );

  perform 1
  from public.projects project
  where project.id = p_project_id
    and project.organization_id = p_organization_id
  for update;

  if not found then
    raise exception 'Empreendimento não encontrado.';
  end if;

  perform 1
  from public.construction_work_packages work_package
  where work_package.organization_id = p_organization_id
    and work_package.project_id = p_project_id
  order by work_package.id
  for update;

  v_preview := private.preview_construction_deletion(
    p_organization_id,
    p_project_id,
    null
  );
  v_element_count := (v_preview ->> 'element_count')::integer;
  v_target_token := v_preview ->> 'target_token';

  if p_expected_count is null or p_expected_count <> v_element_count then
    raise exception
      'A estrutura da EAP foi alterada. Revise a análise antes de excluir.';
  end if;
  if p_expected_token is null or p_expected_token <> v_target_token then
    raise exception
      'A estrutura da EAP foi alterada. Revise a análise antes de excluir.';
  end if;
  if not coalesce((v_preview ->> 'can_delete')::boolean, false) then
    raise exception
      'Exclusão bloqueada: existem registros operacionais vinculados.';
  end if;

  select
    coalesce(
      pg_catalog.array_agg(
        work_package.id order by work_package.id
      ),
      array[]::uuid[]
    ),
    coalesce(
      pg_catalog.jsonb_agg(
        pg_catalog.jsonb_build_object(
          'id', work_package.id,
          'parent_id', work_package.parent_id,
          'wbs_code', work_package.wbs_code,
          'name', work_package.name,
          'status', work_package.status,
          'updated_at', work_package.updated_at
        )
        order by work_package.id
      ),
      '[]'::jsonb
    )
    into v_target_ids, v_target_snapshot
  from public.construction_work_packages work_package
  where work_package.organization_id = p_organization_id
    and work_package.project_id = p_project_id;

  if pg_catalog.cardinality(v_target_ids) <> v_element_count then
    raise exception
      'A estrutura da EAP foi alterada. Revise a análise antes de excluir.';
  end if;

  delete from public.construction_work_packages work_package
  where work_package.organization_id = p_organization_id
    and work_package.project_id = p_project_id
    and work_package.id = any(v_target_ids);

  get diagnostics v_deleted_count = row_count;
  if v_deleted_count <> v_element_count then
    raise exception
      'A exclusão não foi concluída integralmente; nenhuma alteração foi salva.';
  end if;

  insert into public.audit_logs(
    organization_id,
    user_id,
    action,
    entity,
    entity_id,
    old_data,
    new_data
  )
  values (
    p_organization_id,
    v_user_id,
    'DELETE',
    'construction_work_packages',
    p_project_id::text,
    pg_catalog.jsonb_build_object(
      'scope', 'eap',
      'project_id', p_project_id,
      'element_count', v_deleted_count,
      'target_token', v_target_token,
      'elements', v_target_snapshot
    ),
    null
  );

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'scope', 'eap',
    'deleted_count', v_deleted_count,
    'project_id', p_project_id,
    'target_token', v_target_token
  );
end;
$$;

revoke all on function public.preview_construction_work_package_deletion(
  uuid,
  uuid
) from public, anon;
revoke all on function public.preview_construction_eap_deletion(
  uuid,
  uuid
) from public, anon;
revoke all on function public.delete_construction_work_package(
  uuid,
  uuid,
  integer,
  text,
  boolean
) from public, anon;
revoke all on function public.delete_construction_eap(
  uuid,
  uuid,
  integer,
  text
) from public, anon;

grant execute on function public.preview_construction_work_package_deletion(
  uuid,
  uuid
) to authenticated;
grant execute on function public.preview_construction_eap_deletion(
  uuid,
  uuid
) to authenticated;
grant execute on function public.delete_construction_work_package(
  uuid,
  uuid,
  integer,
  text,
  boolean
) to authenticated;
grant execute on function public.delete_construction_eap(
  uuid,
  uuid,
  integer,
  text
) to authenticated;

-- Fuel receipts reuse the private ERP document bucket and are linked directly
-- to the immutable dispense record.

do $$
declare
  v_duplicate_receipt_id uuid;
  v_existing_index_oid oid;
  v_index_is_exact boolean;
begin
  select dispense.receipt_attachment_id
    into v_duplicate_receipt_id
  from public.fuel_dispenses dispense
  where dispense.receipt_attachment_id is not null
  group by dispense.receipt_attachment_id
  having count(*) > 1
  order by dispense.receipt_attachment_id
  limit 1;

  if found then
    raise exception
      'Não é possível criar o índice de comprovantes: o anexo % está vinculado a mais de um abastecimento.',
      v_duplicate_receipt_id;
  end if;

  select index_relation.oid
    into v_existing_index_oid
  from pg_catalog.pg_class index_relation
  join pg_catalog.pg_namespace index_namespace
    on index_namespace.oid = index_relation.relnamespace
  where index_namespace.nspname = 'public'
    and index_relation.relname =
      'fuel_dispenses_receipt_attachment_unique';

  if found then
    select
      index_relation.relkind = 'i'
      and access_method.amname = 'btree'
      and index_definition.indrelid =
        'public.fuel_dispenses'::pg_catalog.regclass
      and index_definition.indisunique
      and index_definition.indisvalid
      and index_definition.indisready
      and index_definition.indislive
      and index_definition.indnkeyatts = 1
      and index_definition.indnatts = 1
      and index_definition.indexprs is null
      and index_definition.indkey::text =
        indexed_column.attnum::text
      and pg_catalog.regexp_replace(
        pg_catalog.lower(
          pg_catalog.pg_get_expr(
            index_definition.indpred,
            index_definition.indrelid,
            true
          )
        ),
        '[[:space:]()]',
        '',
        'g'
      ) = 'receipt_attachment_idisnotnull'
      into v_index_is_exact
    from pg_catalog.pg_class index_relation
    join pg_catalog.pg_index index_definition
      on index_definition.indexrelid = index_relation.oid
    join pg_catalog.pg_am access_method
      on access_method.oid = index_relation.relam
    join pg_catalog.pg_attribute indexed_column
      on indexed_column.attrelid = index_definition.indrelid
     and indexed_column.attname = 'receipt_attachment_id'
     and not indexed_column.attisdropped
    where index_relation.oid = v_existing_index_oid;

    if not coalesce(v_index_is_exact, false) then
      raise exception
        'O índice public.fuel_dispenses_receipt_attachment_unique existe com definição diferente da esperada.';
    end if;
  end if;
end;
$$;

do $$
declare
  v_updated_bucket_count integer;
begin
  update storage.buckets as bucket
  set public = false,
      file_size_limit = case
        when bucket.file_size_limit is null then 20971520::bigint
        else least(
          bucket.file_size_limit,
          20971520::bigint
        )
      end,
      allowed_mime_types = case
        when bucket.allowed_mime_types is null then null
        else array(
          select distinct allowed_type.mime_type
          from pg_catalog.unnest(
            bucket.allowed_mime_types
            || array[
              'application/pdf',
              'image/jpeg',
              'image/png',
              'image/webp',
              'image/heic',
              'image/heif',
              'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'text/csv'
            ]::text[]
          ) as allowed_type(mime_type)
          where allowed_type.mime_type is not null
          order by allowed_type.mime_type
        )
      end
  where bucket.id = 'erp-documents';

  get diagnostics v_updated_bucket_count = row_count;
  if v_updated_bucket_count <> 1 then
    raise exception
      'O bucket privado erp-documents não existe; a migration foi interrompida.';
  end if;
end;
$$;

create unique index if not exists
  fuel_dispenses_receipt_attachment_unique
on public.fuel_dispenses(receipt_attachment_id)
where receipt_attachment_id is not null;

revoke all on function public.v69_record_fuel_dispense(
  uuid,
  jsonb
) from public, anon, authenticated;

create or replace function public.record_fuel_dispense(
  p_request_id uuid,
  p_dispense jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_result jsonb;
  v_workflow text;
  v_request public.fuel_requests%rowtype;
  v_attachment public.document_attachments%rowtype;
  v_existing_dispense public.fuel_dispenses%rowtype;
  v_storage_metadata jsonb;
  v_storage_size_bytes bigint;
  v_storage_mime_type text;
  v_payload jsonb := coalesce(p_dispense, '{}'::jsonb);
  v_dispense_id uuid := nullif(v_payload ->> 'id', '')::uuid;
  v_receipt_id uuid :=
    nullif(v_payload ->> 'receipt_attachment_id', '')::uuid;
  v_station_id uuid :=
    nullif(v_payload ->> 'station_contact_id', '')::uuid;
  v_unit_price numeric(15,4) :=
    nullif(v_payload ->> 'unit_price', '')::numeric;
  v_liters numeric(12,3) :=
    nullif(v_payload ->> 'liters', '')::numeric;
  v_expected_prefix text;
begin
  if v_user_id is null then
    raise exception 'Sessão expirada.';
  end if;
  if v_dispense_id is null then
    raise exception 'Identificador do abastecimento ausente.';
  end if;
  if v_receipt_id is null then
    raise exception 'Anexe o PDF ou a foto da nota fiscal.';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'fuel-dispense:' || v_dispense_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_request_id::text, 0)
  );

  select *
    into v_request
  from public.fuel_requests
  where id = p_request_id
  for update;

  if not found then
    raise exception 'Requisição de combustível não encontrada.';
  end if;
  if not public.has_app_permission(
    v_request.organization_id,
    'fuel.dispense'
  ) then
    raise exception 'Sem permissão para registrar abastecimentos.';
  end if;

  select *
    into v_existing_dispense
  from public.fuel_dispenses dispense
  where dispense.id = v_dispense_id
  for update;

  if found
     and (
       v_existing_dispense.request_id is distinct from p_request_id
       or v_existing_dispense.receipt_attachment_id
          is distinct from v_receipt_id
     ) then
    raise exception
      'O identificador deste abastecimento já foi usado com outra requisição ou outro comprovante.';
  end if;

  if v_request.station_contact_id is null
     or v_request.estimated_unit_price is null
     or v_request.planned_due_date is null
     or v_request.provision_financial_entry_id is null
     or not exists (
       select 1
       from public.financial_entries entry
       where entry.id = v_request.provision_financial_entry_id
         and entry.organization_id = v_request.organization_id
         and entry.source_type = 'fuel_request'
         and entry.source_id = v_request.id
         and entry.fuel_request_id = v_request.id
         and entry.is_provision
         and entry.payment_blocked
         and entry.payment_release_status = 'bloqueado_documentos'
         and entry.status not in ('pago', 'recebido')
     ) then
    raise exception
      'Complete a configuração financeira antes de registrar o abastecimento.';
  end if;
  if v_liters is null or v_liters <= 0 then
    raise exception 'Informe uma quantidade abastecida maior que zero.';
  end if;
  if v_unit_price is null or v_unit_price <= 0 then
    raise exception 'Informe um preço unitário maior que zero.';
  end if;
  if v_station_id is not null
     and v_station_id <> v_request.station_contact_id then
    raise exception
      'O posto informado difere do fornecedor aprovado; submeta a alteração para reaprovação.';
  end if;

  v_expected_prefix :=
    v_request.organization_id::text
    || '/fuel_request/'
    || v_request.id::text
    || '/abastecimentos/'
    || v_dispense_id::text
    || '/';

  select *
    into v_attachment
  from public.document_attachments attachment
  where attachment.id = v_receipt_id;

  if not found
     or v_attachment.organization_id <> v_request.organization_id
     or v_attachment.entity_type <> 'fuel_request'
     or v_attachment.entity_id is distinct from v_request.id
     or v_attachment.document_type <> 'nota_fiscal'
     or v_attachment.uploaded_by is distinct from v_user_id
     or coalesce(v_attachment.size_bytes, 0) not between 1 and 10485760
     or lower(coalesce(v_attachment.mime_type, '')) not in (
       'application/pdf',
       'image/jpeg',
       'image/png',
       'image/webp',
       'image/heic',
       'image/heif'
     )
     or left(v_attachment.storage_path, length(v_expected_prefix))
        <> v_expected_prefix then
    raise exception
      'O comprovante fiscal é inválido, excede 10 MB ou não pertence a este abastecimento.';
  end if;

  select storage_object.metadata
    into v_storage_metadata
  from storage.objects storage_object
  where storage_object.bucket_id = 'erp-documents'
    and storage_object.name = v_attachment.storage_path;

  if not found
     or not coalesce(
       (v_storage_metadata ->> 'size') ~ '^[0-9]+$',
       false
     ) then
    raise exception
      'O arquivo do comprovante fiscal não foi localizado ou possui metadados inválidos.';
  end if;

  v_storage_size_bytes :=
    (v_storage_metadata ->> 'size')::bigint;
  v_storage_mime_type :=
    lower(coalesce(v_storage_metadata ->> 'mimetype', ''));

  if v_storage_size_bytes not between 1 and 10485760
     or v_storage_mime_type not in (
       'application/pdf',
       'image/jpeg',
       'image/png',
       'image/webp',
       'image/heic',
       'image/heif'
     )
     or v_storage_size_bytes is distinct from
        v_attachment.size_bytes::bigint
     or v_storage_mime_type is distinct from
        lower(v_attachment.mime_type) then
    raise exception
      'O arquivo real do comprovante fiscal difere dos metadados informados ou excede 10 MB.';
  end if;

  if exists (
    select 1
    from public.fuel_dispenses dispense
    where dispense.receipt_attachment_id = v_receipt_id
      and dispense.id <> v_dispense_id
  ) then
    raise exception 'Este comprovante já está vinculado a outro abastecimento.';
  end if;

  v_payload := v_payload || jsonb_build_object(
    'station_contact_id', v_request.station_contact_id,
    'id', v_dispense_id,
    'receipt_attachment_id', v_receipt_id
  );

  v_result := public.v69_record_fuel_dispense(
    p_request_id,
    v_payload
  );
  perform private.v70_reconcile_fuel_provision(p_request_id);
  v_workflow := private.v70_refresh_fuel_document_workflow(p_request_id);

  return v_result || jsonb_build_object(
    'workflow_status',
    v_workflow
  );
end;
$$;

revoke all on function public.record_fuel_dispense(
  uuid,
  jsonb
) from public, anon;
grant execute on function public.record_fuel_dispense(
  uuid,
  jsonb
) to authenticated;
