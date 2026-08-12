import type { CrmAction, CrmRecord } from "../types";

export type CrmSection = "overview" | "leads" | "sdr" | "pipelines" | "opportunities" | "salesmap" | "inventory" | "negotiation" | "proposals" | "contracts" | "agenda" | "campaigns" | "materials" | "automations" | "alerts" | "reports" | "teams" | "settings";
export interface CrmPipeline { id:string; organization_id:string; name:string; description:string|null; pipeline_type:string; is_default:boolean; active:boolean; }
export interface CrmStage { id:string; organization_id:string; pipeline_id:string; name:string; code:string; position:number; probability:number; color:string; sla_hours:number; is_won:boolean; is_lost:boolean; active:boolean; }
export interface CrmTeam { id:string; organization_id:string; name:string; team_type:string; manager_user_id:string|null; assignment_strategy:string; active:boolean; }
export interface CrmTeamMember { id:string; organization_id:string; team_id:string; user_id:string; team_role:string; weight:number; capacity:number; active:boolean; last_assigned_at:string|null; }
export interface CrmCampaign { id:string; organization_id:string; name:string; campaign_type:string; channel:string|null; status:string; project_id:string|null; marketing_campaign_id?:string|null; owner_user_id:string|null; budget:number; spent:number; start_date:string|null; end_date:string|null; objective:string|null; audience:string|null; utm_source:string|null; utm_medium:string|null; utm_campaign:string|null; landing_page:string|null; notes:string|null; created_at:string; updated_at:string; }
export interface CrmCampaignMapping { id:string; organization_id:string; crm_campaign_id:string; provider:string; provider_account_id:string; external_campaign_id:string; external_campaign_name:string|null; provider_metadata:Record<string,unknown>; last_synced_at:string|null; created_at:string; updated_at:string; }
export interface CrmProduct { id:string; organization_id:string; project_id:string; code:string; name:string; product_type:string; description:string|null; active:boolean; metadata:Record<string,unknown>; created_at:string; updated_at:string; }
export interface CrmLeadSource { id:string; organization_id:string; code:string; name:string; provider:string; channel:string; manual_selectable:boolean; active:boolean; metadata:Record<string,unknown>; created_at:string; updated_at:string; }
export interface CrmLossReason { id:string; organization_id:string; code:string; name:string; active:boolean; sort_order:number; system_reason:boolean; metadata:Record<string,unknown>; created_at:string; updated_at:string; }
export interface CrmContactIdentity { id:string; organization_id:string; contact_id:string; identity_type:"whatsapp"|"phone"|"email"|"meta_user"|"external"; normalized_value:string; verified_at:string|null; last_seen_at:string|null; active:boolean; source:string; metadata:Record<string,unknown>; created_at:string; updated_at:string; }
export interface CrmOpportunityAttribution { id:string; organization_id:string; crm_record_id:string|null; opportunity_key:string; lead_source_id:string|null; project_id:string|null; product_id:string|null; crm_campaign_id:string|null; campaign_control_campaign_id:string|null; provider:string; channel:string; provider_account_id:string|null; external_lead_id:string; meta_lead_id:string|null; campaign_id:string|null; campaign_name:string|null; adset_id:string|null; adset_name:string|null; ad_id:string|null; ad_name:string|null; creative_id:string|null; creative_name:string|null; form_id:string|null; form_name:string|null; page_id:string|null; page_name:string|null; placement:string|null; publisher_platform:string|null; platform_position:string|null; device_platform:string|null; attribution_model:string; captured_at:string; received_at:string; is_primary:boolean; metadata:Record<string,unknown>; created_at:string; }
export interface CrmOpportunityEvent { id:string; organization_id:string; crm_record_id:string|null; opportunity_key:string; contact_id:string|null; project_id:string|null; product_id:string|null; lead_source_id:string|null; actor_type:"human"|"system"|"integration"|"ai"; actor_user_id:string|null; event_type:string; event_source:string; channel:string|null; occurred_at:string; idempotency_key:string|null; correlation_id:string|null; data:Record<string,unknown>; created_at:string; }
export type CrmOpportunity = CrmRecord;
export interface CrmFolder { id:string; organization_id:string; parent_id:string|null; name:string; description:string|null; project_id:string|null; visibility:string; }
export interface CrmAsset { id:string; organization_id:string; folder_id:string|null; project_id:string|null; name:string; asset_type:string; description:string|null; storage_path:string|null; external_url:string|null; mime_type:string|null; size_bytes:number|null; tags:string[]; audience:string|null; active:boolean; created_at:string; }
export interface CrmAutomation { id:string; organization_id:string; name:string; trigger_event:string; conditions:Record<string,unknown>; actions:Array<Record<string,unknown>>; active:boolean; priority:number; last_run_at:string|null; execution_count:number; }
export interface CrmAlert { id:string; organization_id:string; crm_record_id:string|null; alert_type:string; severity:string; title:string; message:string|null; assigned_to:string|null; due_at:string|null; status:string; created_at:string; }
export type CrmAssignmentRole = "sdr" | "corretor";
export type CrmAssignmentStatus = "atribuida" | "aceita" | "em_atendimento" | "concluida" | "recusada" | "cancelada" | "substituida";
export interface CrmAssignmentGuidance {
  headline?: string;
  objective?: string;
  recommended_channel?: string;
  approach?: string;
  opening_suggestion?: string;
  questions?: string[];
  next_steps?: string[];
  cautions?: string[];
  [key:string]: unknown;
}
export interface CrmLeadAssignment {
  id:string;
  organization_id:string;
  crm_record_id:string;
  assignment_role:CrmAssignmentRole;
  assigned_user_id:string;
  assigned_by:string|null;
  status:CrmAssignmentStatus;
  priority:"normal"|"alta"|"urgente";
  instructions:string|null;
  assignment_source:"manual"|"automation"|"migration";
  assigned_at:string;
  acknowledge_by:string;
  due_at:string;
  acknowledged_at:string|null;
  started_at:string|null;
  completed_at:string|null;
  cancelled_at:string|null;
  status_updated_by:string|null;
  user_activity_id:string|null;
  crm_action_id:string|null;
  guidance:CrmAssignmentGuidance;
  guidance_version:string;
  guidance_generated_at:string;
  metadata:Record<string,unknown>;
  created_at:string;
  updated_at:string;
}
export interface CrmTemplate { id:string; organization_id:string; name:string; channel:string; subject:string|null; body:string; variables:string[]; category:string|null; active:boolean; }
export interface CrmIntegration { id:string; organization_id:string; provider:string; display_name:string; status:string; last_sync_at:string|null; }
export type CrmMetaAssignmentStrategy = "round_robin" | "least_queue" | "fallback_only";
export type CrmMetaAssignmentRole = "sdr" | "broker";
export interface CrmMetaLeadRoute {
  id:string;
  organization_id:string;
  name:string;
  page_id:string;
  form_id:string;
  provider_account_id:string|null;
  project_id:string;
  product_id:string;
  lead_source_id:string;
  pipeline_id:string;
  initial_stage_id:string;
  team_id:string|null;
  fallback_owner_user_id:string|null;
  assignment_strategy:CrmMetaAssignmentStrategy;
  assignment_role:CrmMetaAssignmentRole;
  first_contact_sla_minutes:number;
  default_country_calling_code:string;
  active:boolean;
  metadata:Record<string,unknown>;
  created_by:string|null;
  updated_by:string|null;
  created_at:string;
  updated_at:string;
}
export interface CrmMetaLeadIntegrationStatus {
  routes:Record<string,number|string|null>;
  events:Record<string,number|string|null>;
  timestamps:Record<string,string|null>;
  errors:Record<string,number|string|null>;
}
export interface CrmGoal { id:string; organization_id:string; goal_type:string; user_id:string|null; team_id:string|null; project_id:string|null; period_start:string; period_end:string; target_value:number; target_quantity:number; }
export interface CrmEnterpriseData { records:CrmRecord[]; actions:CrmAction[]; pipelines:CrmPipeline[]; stages:CrmStage[]; teams:CrmTeam[]; teamMembers:CrmTeamMember[]; products:CrmProduct[]; leadSources:CrmLeadSource[]; lossReasons:CrmLossReason[]; campaigns:CrmCampaign[]; folders:CrmFolder[]; assets:CrmAsset[]; automations:CrmAutomation[]; alerts:CrmAlert[]; assignments:CrmLeadAssignment[]; templates:CrmTemplate[]; integrations:CrmIntegration[]; metaLeadRoutes:CrmMetaLeadRoute[]; metaLeadStatus:CrmMetaLeadIntegrationStatus|null; metaLeadStatusError:string|null; goals:CrmGoal[]; }
