-- Auditoria incremental 2026-09-14
-- Mantém a semântica de autorização e reduz custo de RLS/junções em caminhos ativos.

begin;

-- Evita reavaliar auth.uid() por linha nas políticas apontadas pelo Advisor.
DROP POLICY IF EXISTS intergeo_v2_analysis_insert ON public.intergeo_v2_analysis_runs;
CREATE POLICY intergeo_v2_analysis_insert
ON public.intergeo_v2_analysis_runs
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK (
  created_by = (SELECT auth.uid())
  AND malha_private.role_for(organization_id) <> ALL (ARRAY['Visualizador'::text, 'Consultor'::text])
);

DROP POLICY IF EXISTS max_insert ON public.intergeo_max_comparables;
CREATE POLICY max_insert
ON public.intergeo_max_comparables
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK (
  created_by = (SELECT auth.uid())
  AND malha_private.role_for(organization_id) <> ALL (ARRAY['Consultor'::text, 'Visualizador'::text])
  AND malha_private.role_for(organization_id) IS NOT NULL
);

DROP POLICY IF EXISTS max_insert ON public.intergeo_max_sources;
CREATE POLICY max_insert
ON public.intergeo_max_sources
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK (
  created_by = (SELECT auth.uid())
  AND malha_private.role_for(organization_id) <> ALL (ARRAY['Consultor'::text, 'Visualizador'::text])
  AND malha_private.role_for(organization_id) IS NOT NULL
);

DROP POLICY IF EXISTS max_insert ON public.intergeo_max_runs;
CREATE POLICY max_insert
ON public.intergeo_max_runs
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK (
  created_by = (SELECT auth.uid())
  AND malha_private.role_for(organization_id) <> ALL (ARRAY['Consultor'::text, 'Visualizador'::text])
  AND malha_private.role_for(organization_id) IS NOT NULL
);

DROP POLICY IF EXISTS max_insert ON public.intergeo_max_reviews;
CREATE POLICY max_insert
ON public.intergeo_max_reviews
AS PERMISSIVE
FOR INSERT
TO authenticated
WITH CHECK (
  created_by = (SELECT auth.uid())
  AND malha_private.role_for(organization_id) <> ALL (ARRAY['Consultor'::text, 'Visualizador'::text])
  AND malha_private.role_for(organization_id) IS NOT NULL
);

-- Índices de cobertura para formulários públicos, Bia e notificações da Arisa.
-- São caminhos ativos no cadastro do Solaris e no atendimento automatizado.
CREATE INDEX IF NOT EXISTS crm_public_form_submissions_form_slug_fk_idx
  ON private.crm_public_form_submissions (form_slug);

CREATE INDEX IF NOT EXISTS crm_public_form_submissions_organization_fk_idx
  ON private.crm_public_form_submissions (organization_id);

CREATE INDEX IF NOT EXISTS crm_public_forms_organization_fk_idx
  ON private.crm_public_forms (organization_id);

CREATE INDEX IF NOT EXISTS crm_public_forms_project_fk_idx
  ON private.crm_public_forms (project_id)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS crm_public_forms_pipeline_fk_idx
  ON private.crm_public_forms (pipeline_id)
  WHERE pipeline_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS crm_public_forms_stage_fk_idx
  ON private.crm_public_forms (stage_id)
  WHERE stage_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS crm_public_forms_lead_source_fk_idx
  ON private.crm_public_forms (lead_source_id)
  WHERE lead_source_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bia_customer_files_message_fk_idx
  ON crm_private.bia_customer_files (message_id)
  WHERE message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS bia_whatsapp_channels_experience_fk_idx
  ON crm_private.bia_whatsapp_channels (experience_id)
  WHERE experience_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS arisa_whatsapp_recipients_user_fk_idx
  ON crm_private.arisa_whatsapp_recipients (user_id);

commit;
