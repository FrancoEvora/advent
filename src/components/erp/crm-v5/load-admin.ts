import { getSupabase } from "@/lib/supabase";
import type { CrmMetaLeadIntegrationStatus, CrmMetaLeadRoute } from "./types";

export async function loadCrmAdmin(organizationId:string) {
  const client=getSupabase(); if(!client) throw new Error("Supabase indisponível.");
  const [automations,integrations,goals,metaLeadRoutes,metaLeadStatus]=await Promise.all([
    client.from("crm_automations").select("*").eq("organization_id",organizationId).order("priority"),
    // A configuração pode conter dados operacionais sensíveis em integrações
    // legadas. O navegador recebe somente o estado necessário para a tela.
    client.from("crm_integrations").select("id,organization_id,provider,display_name,status,last_sync_at,created_at,updated_at").eq("organization_id",organizationId).order("display_name"),
    client.from("crm_goals").select("*").eq("organization_id",organizationId).order("period_start",{ascending:false}),
    client.from("crm_meta_lead_routes").select("id,organization_id,name,page_id,form_id,provider_account_id,project_id,product_id,lead_source_id,pipeline_id,initial_stage_id,team_id,fallback_owner_user_id,assignment_strategy,assignment_role,first_contact_sla_minutes,default_country_calling_code,active,metadata,created_by,updated_by,created_at,updated_at").eq("organization_id",organizationId).order("name"),
    client.rpc("get_meta_lead_integration_status",{p_organization_id:organizationId})
  ]);
  const failed=[automations,integrations,goals].find(item=>item.error); if(failed?.error) throw failed.error;
  return {
    automations:automations.data??[],
    integrations:integrations.data??[],
    goals:goals.data??[],
    metaLeadRoutes:(metaLeadRoutes.error?[]:metaLeadRoutes.data??[]) as CrmMetaLeadRoute[],
    metaLeadStatus:(metaLeadStatus.error?null:metaLeadStatus.data) as CrmMetaLeadIntegrationStatus|null,
    metaLeadStatusError:metaLeadRoutes.error||metaLeadStatus.error?"Status da integração Meta indisponível para este acesso.":null
  };
}
