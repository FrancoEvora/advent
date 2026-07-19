import { getSupabase } from "@/lib/supabase";

export async function loadCrmMarketing(organizationId:string) {
  const client=getSupabase(); if(!client) throw new Error("Supabase indisponível.");
  const [campaigns,folders,assets,templates]=await Promise.all([
    client.from("crm_campaigns").select("*").eq("organization_id",organizationId).order("created_at",{ascending:false}),
    client.from("crm_asset_folders").select("*").eq("organization_id",organizationId).order("name"),
    client.from("crm_marketing_assets").select("*").eq("organization_id",organizationId).order("created_at",{ascending:false}),
    client.from("crm_templates").select("*").eq("organization_id",organizationId).order("name")
  ]);
  const failed=[campaigns,folders,assets,templates].find(item=>item.error); if(failed?.error) throw failed.error;
  return {campaigns:campaigns.data??[],folders:folders.data??[],assets:assets.data??[],templates:templates.data??[]};
}
