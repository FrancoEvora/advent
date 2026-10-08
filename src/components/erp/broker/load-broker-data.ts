import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";
import type { ErpData, Membership } from "../types";
import type { CrmEnterpriseData } from "../crm-v5/types";

export async function loadBrokerData(session: Session, membership: Membership) {
  const client = getSupabase();
  if (!client) throw new Error("Serviço indisponível.");
  const org = membership.organization_id;
  const [organization, profile, context, records, actions, assignments, assets, folders, activities] = await Promise.all([
    client.from("organizations").select("*").eq("id", org).single(),
    client.from("profiles").select("*").eq("id", session.user.id).single(),
    client.rpc("get_broker_attendance_context", { p_organization_id: org }),
    client.from("crm_records").select("*").eq("organization_id", org).neq("record_status", "arquivada").order("updated_at", { ascending: false }),
    client.from("crm_actions").select("*").eq("organization_id", org).order("scheduled_at"),
    client.from("crm_lead_assignments").select("*").eq("organization_id", org).order("assigned_at", { ascending: false }),
    client.from("crm_marketing_assets").select("*").eq("organization_id", org).eq("active", true).order("name"),
    client.from("crm_asset_folders").select("*").eq("organization_id", org).order("name"),
    client.from("user_activities").select("id,title,description,status,due_at,starts_at,related_type,related_id,owner_user_id").eq("organization_id", org).eq("owner_user_id", session.user.id).order("due_at"),
  ]);
  const failed = [organization, profile, context, records, actions, assignments, assets, folders, activities].find(result => result.error);
  if (failed?.error) throw new Error(failed.error.message);
  const data: ErpData = {
    session, membership, organization: organization.data, profile: profile.data,
    projects: context.data.projects, members: [membership], profiles: [profile.data], contacts: [],
    crmRecords: records.data ?? [], crmActions: actions.data ?? [],
    entries: [], costCenters: [], revenueCenters: [], categories: [], bankAccounts: [], invitations: [], approvals: [], auditLogs: [],
    settings: { organization_id: org, approval_threshold: 0, require_approval: true, default_due_alert_days: 7 },
    documents: [], purchaseRequests: [], purchaseItems: [], hrEmployees: [], hrEvents: [], hrPayrollRuns: [], hrPayrollItems: [],
    constructionWorkPackages: [], constructionEapTemplates: [], constructionEapTemplateItems: [], fuelRequests: [], fuelDispenses: [], fuelRequestDocuments: [],
    operationalContracts: [], operationalContractItems: [], contractMeasurementPeriods: [], contractMeasurements: [], contractMeasurementItems: [],
  };
  const crm: CrmEnterpriseData = {
    records: data.crmRecords, actions: data.crmActions, assignments: assignments.data ?? [], assets: assets.data ?? [], folders: folders.data ?? [],
    pipelines: [], stages: [], teams: [], teamMembers: [], products: [], leadSources: [], lossReasons: [], campaigns: [], automations: [], alerts: [], templates: [], integrations: [],
    metaLeadRoutes: [], metaLeadStatus: null, metaLeadStatusError: null, goals: [],
  };
  return { data, crm, units: context.data.units as BrokerUnit[], agencies: context.data.agencies as Array<{ id: string; name: string }>, activities: activities.data ?? [] };
}

export type BrokerUnit = { id: string; project_id: string; unit_code: string; block_code: string; lot_number: string; area: number; list_price: number; price_per_sqm: number | null; frontage: number | null; depth: number | null; corner: boolean; topography: string | null; orientation: string | null };
export type BrokerData = Awaited<ReturnType<typeof loadBrokerData>>;
