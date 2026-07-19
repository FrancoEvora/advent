import { getSupabase } from "@/lib/supabase";

export async function loadCrmAdmin(organizationId:string) {
  const client=getSupabase(); if(!client) throw new Error("Supabase indisponível.");
  const [automations,integrations,goals]=await Promise.all([
    client.from("crm_automations").select("*").eq("organization_id",organizationId).order("priority"),
    client.from("crm_integrations").select("*").eq("organization_id",organizationId).order("display_name"),
    client.from("crm_goals").select("*").eq("organization_id",organizationId).order("period_start",{ascending:false})
  ]);
  const failed=[automations,integrations,goals].find(item=>item.error); if(failed?.error) throw failed.error;
  return {automations:automations.data??[],integrations:integrations.data??[],goals:goals.data??[]};
}
