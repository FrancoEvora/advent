import { getSupabase } from "@/lib/supabase";

export async function loadCrmCore(organizationId:string) {
  const client=getSupabase(); if(!client) throw new Error("Supabase indisponível.");
  const [records,actions,pipelines,stages,teams,members,products,leadSources,lossReasons,alerts,assignments]=await Promise.all([
    client.from("crm_records").select("*").eq("organization_id",organizationId).order("updated_at",{ascending:false}),
    client.from("crm_actions").select("*").eq("organization_id",organizationId).order("scheduled_at",{ascending:true}),
    client.from("crm_pipelines").select("*").eq("organization_id",organizationId).order("name"),
    client.from("crm_stages").select("*").eq("organization_id",organizationId).order("position"),
    client.from("crm_teams").select("*").eq("organization_id",organizationId).order("name"),
    client.from("crm_team_members").select("*").eq("organization_id",organizationId),
    client.from("crm_products").select("*").eq("organization_id",organizationId).order("name"),
    client.from("crm_lead_sources").select("*").eq("organization_id",organizationId).order("name"),
    client.from("crm_loss_reasons").select("*").eq("organization_id",organizationId).order("sort_order"),
    client.from("crm_alerts").select("*").eq("organization_id",organizationId).order("created_at",{ascending:false}),
    client.from("crm_lead_assignments").select("*").eq("organization_id",organizationId).order("assigned_at",{ascending:false})
  ]);
  const failed=[records,actions,pipelines,stages,teams,members,products,leadSources,lossReasons,alerts,assignments].find(item=>item.error); if(failed?.error) throw failed.error;
  return {records:records.data??[],actions:actions.data??[],pipelines:pipelines.data??[],stages:stages.data??[],teams:teams.data??[],teamMembers:members.data??[],products:products.data??[],leadSources:leadSources.data??[],lossReasons:lossReasons.data??[],alerts:alerts.data??[],assignments:assignments.data??[]};
}
