import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";
import type { ErpData, Membership } from "../types";
import type { CrmEnterpriseData, CrmPipeline, CrmStage } from "../crm-v5/types";

export async function loadBrokerData(session: Session, membership: Membership) {
  const client = getSupabase();
  if (!client) throw new Error("Serviço indisponível.");
  const org = membership.organization_id;
  const [organization, profile, context, records, actions, assignments, assets, folders, activities, commercial] = await Promise.all([
    client.from("organizations").select("*").eq("id", org).single(),
    client.from("profiles").select("*").eq("id", session.user.id).single(),
    client.rpc("get_broker_attendance_context", { p_organization_id: org }),
    client.from("crm_records").select("*").eq("organization_id", org).neq("record_status", "arquivada").order("updated_at", { ascending: false }),
    client.from("crm_actions").select("*").eq("organization_id", org).order("scheduled_at"),
    client.from("crm_lead_assignments").select("*").eq("organization_id", org).order("assigned_at", { ascending: false }),
    client.from("crm_marketing_assets").select("*").eq("organization_id", org).eq("active", true).order("name"),
    client.from("crm_asset_folders").select("*").eq("organization_id", org).order("name"),
    client.from("user_activities").select("id,title,description,status,due_at,starts_at,related_type,related_id,owner_user_id,activity_type").eq("organization_id", org).eq("owner_user_id", session.user.id).order("due_at"),
    client.rpc("get_broker_commercial_context", { p_organization_id: org }),
  ]);
  const failed = [organization, profile, context, records, actions, assignments, assets, folders, activities, commercial].find(result => result.error);
  if (failed?.error) throw new Error(failed.error.message);
  const commerce = commercial.data as BrokerCommercialContext;
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
    pipelines: commerce.pipelines, stages: commerce.stages, teams: [], teamMembers: [], products: [], leadSources: [], lossReasons: [], campaigns: [], automations: [], alerts: [], templates: [], integrations: [],
    metaLeadRoutes: [], metaLeadStatus: null, metaLeadStatusError: null, goals: [],
  };
  return { data, crm, commerce, units: context.data.units as BrokerUnit[], agencies: context.data.agencies as Array<{ id: string; name: string }>, activities: (activities.data ?? []) as BrokerAppointment[] };
}

export type BrokerUnit = { id: string; project_id: string; unit_code: string; block_code: string; lot_number: string; area: number; list_price: number; price_per_sqm: number | null; frontage: number | null; depth: number | null; corner: boolean; topography: string | null; orientation: string | null };
export type BrokerData = Awaited<ReturnType<typeof loadBrokerData>>;

export type BrokerPolicy = { id: string; project_id: string; name: string; is_default: boolean; min_down_payment_pct: number; max_installments: number; monthly_interest_rate: number; indexer: string; grace_months: number; balloon_frequency_months: number; reservation_validity_hours: number; proposal_validity_days: number; max_down_payment_installments: number; down_payment_frequency_days: number; down_payment_interest_rate: number };
export type BrokerProposal = { id: string; crm_record_id: string; project_id: string; unit_code: string; proposal_number: string; status: string; approval_status: string; sale_price: number; down_payment: number; installments_count: number; monthly_interest_rate: number; indexer: string; balloon_total: number; conditions_text: string | null; created_at: string; rejection_reason: string | null; reservation_status: string | null; reserved_until: string | null };
export type BrokerCommercialContext = { pipelines: CrmPipeline[]; stages: CrmStage[]; responsibles: Array<{ id: string; full_name: string }>; policies: BrokerPolicy[]; lead_policies: Array<{ record_id: string; policy_id: string }>; proposals: BrokerProposal[] };
export type BrokerAppointment = { id: string; title: string; description: string | null; status: string; due_at: string | null; starts_at: string | null; related_type: string | null; related_id: string | null; owner_user_id: string; activity_type: string };
