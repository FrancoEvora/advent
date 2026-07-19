import { getSupabase } from "@/lib/supabase";

export async function loadCrmCore(organizationId:string) {
  const client=getSupabase(); if(!client) throw new Error("Supabase indisponível.");
  const [records,actions,pipelines,stages,teams,members,alerts]=await Promise.all([
    client.from("crm_records").select("*").eq("organization_id",organizationId).order("updated_at",{ascending:false}),
    client.from("crm_actions").select("*").eq("organization_id",organizationId).order("scheduled_at",{ascending:true}),
    client.from("crm_pipelines").select("*").eq("organization_id",organizationId).order("name"),
    client.from("crm_stages").select("*").eq("organization_id",organizationId).order("position"),
    client.from("crm_teams").select("*").eq("organization_id",organizationId).order("name"),
    client.from("crm_team_members").select("*").eq("organization_id",organizationId),
    client.from("crm_alerts").select("*").eq("organization_id",organizationId).order("created_at",{ascending:false})
  ]);
  const failed=[records,actions,pipelines,stages,teams,members,alerts].find(item=>item.error); if(failed?.error) throw failed.error;
  return {records:records.data??[],actions:actions.data??[],pipelines:pipelines.data??[],stages:stages.data??[],teams:teams.data??[],teamMembers:members.data??[],alerts:alerts.data??[]};
}
