-- Auditoria semanal 2026-08-31
-- Segurança: o verificador do worker Meta é um RPC interno, usado apenas por
-- enterprise-meta-worker através de um cliente service_role. Impede exposição
-- do segredo/validador via PostgREST para anon/authenticated.
revoke execute on function public.verify_meta_worker_bearer(text, text)
  from public, anon, authenticated;
grant execute on function public.verify_meta_worker_bearer(text, text)
  to service_role;

-- Desempenho: índices de cobertura para FKs quentes do agente público/Bia.
-- Os índices compostos acompanham exatamente as FKs compostas e reduzem o
-- custo de validação/restrição em manutenção de organizações, produtos e usuários.
create index if not exists public_agent_experiences_org_owner_idx
  on crm_private.public_agent_experiences (organization_id, fallback_owner_user_id);
create index if not exists public_agent_experiences_org_product_idx
  on crm_private.public_agent_experiences (organization_id, project_id, product_id);
create index if not exists public_agent_experiences_org_source_idx
  on crm_private.public_agent_experiences (organization_id, lead_source_id);

create index if not exists public_agent_generated_assets_org_idx
  on crm_private.public_agent_generated_assets (organization_id);
create index if not exists public_agent_generated_assets_project_idx
  on crm_private.public_agent_generated_assets (project_id);

create index if not exists public_agent_knowledge_items_org_idx
  on crm_private.public_agent_knowledge_items (organization_id);
create index if not exists public_agent_knowledge_items_project_idx
  on crm_private.public_agent_knowledge_items (project_id);

create index if not exists public_agent_usage_events_experience_idx
  on crm_private.public_agent_usage_events (experience_id);
create index if not exists public_agent_usage_events_org_idx
  on crm_private.public_agent_usage_events (organization_id);

create index if not exists crm_ai_knowledge_documents_created_by_idx
  on public.crm_ai_knowledge_documents (created_by);
create index if not exists crm_ai_knowledge_documents_updated_by_idx
  on public.crm_ai_knowledge_documents (updated_by);

-- Desempenho RLS: auth.uid() em subconsulta initplan é calculado uma vez por
-- statement, não novamente para cada linha. A regra de acesso permanece idêntica.
alter policy profiles_admin_update
  on public.profiles
  using (
    exists (
      select 1
      from public.organization_members target
      join public.organization_members administrator
        on administrator.organization_id = target.organization_id
      where target.user_id = profiles.id
        and administrator.user_id = (select auth.uid())
        and administrator.active
        and administrator.role = any (array['admin'::text, 'diretoria'::text])
    )
  )
  with check (
    exists (
      select 1
      from public.organization_members target
      join public.organization_members administrator
        on administrator.organization_id = target.organization_id
      where target.user_id = profiles.id
        and administrator.user_id = (select auth.uid())
        and administrator.active
        and administrator.role = any (array['admin'::text, 'diretoria'::text])
    )
  );

alter policy post_sale_collection_actions_org_access
  on public.post_sale_collection_actions
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = post_sale_collection_actions.organization_id
        and m.user_id = (select auth.uid())
        and m.active
    )
  )
  with check (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = post_sale_collection_actions.organization_id
        and m.user_id = (select auth.uid())
        and m.active
    )
  );

alter policy post_sale_communications_org_access
  on public.post_sale_communications
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = post_sale_communications.organization_id
        and m.user_id = (select auth.uid())
        and m.active
    )
  )
  with check (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = post_sale_communications.organization_id
        and m.user_id = (select auth.uid())
        and m.active
    )
  );

alter policy post_sale_deeds_org_access
  on public.post_sale_deeds
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = post_sale_deeds.organization_id
        and m.user_id = (select auth.uid())
        and m.active
    )
  )
  with check (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = post_sale_deeds.organization_id
        and m.user_id = (select auth.uid())
        and m.active
    )
  );

alter policy post_sale_inspections_org_access
  on public.post_sale_inspections
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = post_sale_inspections.organization_id
        and m.user_id = (select auth.uid())
        and m.active
    )
  )
  with check (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = post_sale_inspections.organization_id
        and m.user_id = (select auth.uid())
        and m.active
    )
  );

alter policy post_sale_journeys_org_access
  on public.post_sale_journeys
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = post_sale_journeys.organization_id
        and m.user_id = (select auth.uid())
        and m.active
    )
  )
  with check (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = post_sale_journeys.organization_id
        and m.user_id = (select auth.uid())
        and m.active
    )
  );

alter policy post_sale_milestones_org_access
  on public.post_sale_milestones
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = post_sale_milestones.organization_id
        and m.user_id = (select auth.uid())
        and m.active
    )
  )
  with check (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = post_sale_milestones.organization_id
        and m.user_id = (select auth.uid())
        and m.active
    )
  );

alter policy post_sale_renegotiations_org_access
  on public.post_sale_renegotiations
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = post_sale_renegotiations.organization_id
        and m.user_id = (select auth.uid())
        and m.active
    )
  )
  with check (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = post_sale_renegotiations.organization_id
        and m.user_id = (select auth.uid())
        and m.active
    )
  );

alter policy post_sale_surveys_org_access
  on public.post_sale_surveys
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = post_sale_surveys.organization_id
        and m.user_id = (select auth.uid())
        and m.active
    )
  )
  with check (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = post_sale_surveys.organization_id
        and m.user_id = (select auth.uid())
        and m.active
    )
  );

alter policy post_sale_tickets_org_access
  on public.post_sale_tickets
  using (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = post_sale_tickets.organization_id
        and m.user_id = (select auth.uid())
        and m.active
    )
  )
  with check (
    exists (
      select 1 from public.organization_members m
      where m.organization_id = post_sale_tickets.organization_id
        and m.user_id = (select auth.uid())
        and m.active
    )
  );
