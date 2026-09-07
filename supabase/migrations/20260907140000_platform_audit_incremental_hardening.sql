-- Auditoria incremental 2026-09-07
-- Mantém semântica de autorização; evita reavaliar auth.uid() por linha.

begin;

-- communication_links
DROP POLICY IF EXISTS communication_links_access ON public.communication_links;
CREATE POLICY communication_links_access
ON public.communication_links
AS PERMISSIVE
FOR ALL
TO public
USING (
  organization_id IN (
    SELECT organization_members.organization_id
    FROM public.organization_members
    WHERE organization_members.user_id = (SELECT auth.uid())
      AND organization_members.active
  )
)
WITH CHECK (
  organization_id IN (
    SELECT organization_members.organization_id
    FROM public.organization_members
    WHERE organization_members.user_id = (SELECT auth.uid())
      AND organization_members.active
  )
);

-- signature_events
DROP POLICY IF EXISTS signature_events_select_org ON public.signature_events;
CREATE POLICY signature_events_select_org
ON public.signature_events
AS PERMISSIVE
FOR SELECT
TO authenticated
USING (
  EXISTS (
    SELECT 1
    FROM public.organization_members m
    WHERE m.organization_id = signature_events.organization_id
      AND m.user_id = (SELECT auth.uid())
      AND m.active
  )
);

-- marketing_channels
DROP POLICY IF EXISTS org_access ON public.marketing_channels;
CREATE POLICY org_access
ON public.marketing_channels
AS PERMISSIVE
FOR ALL
TO public
USING (
  EXISTS (
    SELECT 1
    FROM public.organization_members m
    WHERE m.organization_id = marketing_channels.organization_id
      AND m.user_id = (SELECT auth.uid())
      AND m.active = true
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.organization_members m
    WHERE m.organization_id = marketing_channels.organization_id
      AND m.user_id = (SELECT auth.uid())
      AND m.active = true
  )
);

-- marketing_requests
DROP POLICY IF EXISTS org_access ON public.marketing_requests;
CREATE POLICY org_access
ON public.marketing_requests
AS PERMISSIVE
FOR ALL
TO public
USING (
  EXISTS (
    SELECT 1
    FROM public.organization_members m
    WHERE m.organization_id = marketing_requests.organization_id
      AND m.user_id = (SELECT auth.uid())
      AND m.active = true
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.organization_members m
    WHERE m.organization_id = marketing_requests.organization_id
      AND m.user_id = (SELECT auth.uid())
      AND m.active = true
  )
);

-- portal_messages
DROP POLICY IF EXISTS org_access ON public.portal_messages;
CREATE POLICY org_access
ON public.portal_messages
AS PERMISSIVE
FOR ALL
TO public
USING (
  EXISTS (
    SELECT 1
    FROM public.organization_members m
    WHERE m.organization_id = portal_messages.organization_id
      AND m.user_id = (SELECT auth.uid())
      AND m.active = true
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.organization_members m
    WHERE m.organization_id = portal_messages.organization_id
      AND m.user_id = (SELECT auth.uid())
      AND m.active = true
  )
);

-- restore_jobs
DROP POLICY IF EXISTS org_access ON public.restore_jobs;
CREATE POLICY org_access
ON public.restore_jobs
AS PERMISSIVE
FOR ALL
TO public
USING (
  EXISTS (
    SELECT 1
    FROM public.organization_members m
    WHERE m.organization_id = restore_jobs.organization_id
      AND m.user_id = (SELECT auth.uid())
      AND m.active = true
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.organization_members m
    WHERE m.organization_id = restore_jobs.organization_id
      AND m.user_id = (SELECT auth.uid())
      AND m.active = true
  )
);

-- equipment_meter_readings
DROP POLICY IF EXISTS equipment_meter_readings_insert ON public.equipment_meter_readings;
CREATE POLICY equipment_meter_readings_insert
ON public.equipment_meter_readings
AS PERMISSIVE
FOR INSERT
TO public
WITH CHECK (
  (
    public.has_app_permission(organization_id, 'contracts.manage')
    OR public.has_app_permission(organization_id, 'fuel.dispense')
    OR public.has_app_permission(organization_id, 'construction.manage')
  )
  AND created_by = (SELECT auth.uid())
);

-- FK/join paths used by Agenda, Arisa and web agents.
CREATE INDEX IF NOT EXISTS user_activities_acknowledged_by_fk_idx
  ON public.user_activities (acknowledged_by)
  WHERE acknowledged_by IS NOT NULL;

CREATE INDEX IF NOT EXISTS user_activities_parent_activity_id_fk_idx
  ON public.user_activities (parent_activity_id)
  WHERE parent_activity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS user_activities_project_id_fk_idx
  ON public.user_activities (project_id)
  WHERE project_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS arisa_whatsapp_operations_contact_id_fk_idx
  ON public.arisa_whatsapp_operations (contact_id)
  WHERE contact_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS vitoria_web_events_session_id_fk_idx
  ON public.vitoria_web_events (session_id);

CREATE INDEX IF NOT EXISTS vitoria_web_sessions_lead_record_id_fk_idx
  ON public.vitoria_web_sessions (lead_record_id)
  WHERE lead_record_id IS NOT NULL;

commit;
