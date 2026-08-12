import { getSupabase } from "@/lib/supabase";
import type {
  CrmOpportunityAttribution,
  CrmOpportunityEvent,
} from "./types";

export interface CrmOpportunityContext {
  attributions: CrmOpportunityAttribution[];
  events: CrmOpportunityEvent[];
}

/**
 * Loads the attribution and immutable journey for one opportunity only.
 * Keeping this out of loadCrmCore avoids sending every lead's full history to
 * the browser when the CRM shell opens.
 */
export async function loadCrmOpportunityContext(
  organizationId: string,
  crmRecordId: string,
): Promise<CrmOpportunityContext> {
  const client = getSupabase();
  if (!client) throw new Error("Supabase indisponível.");

  const [attributions, events] = await Promise.all([
    client
      .from("crm_opportunity_attributions")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("crm_record_id", crmRecordId)
      .order("captured_at", { ascending: false }),
    client
      .from("crm_opportunity_events")
      .select("*")
      .eq("organization_id", organizationId)
      .eq("opportunity_key", crmRecordId)
      .order("occurred_at", { ascending: false }),
  ]);

  if (attributions.error) throw attributions.error;
  if (events.error) throw events.error;

  return {
    attributions: (attributions.data ?? []) as CrmOpportunityAttribution[],
    events: (events.data ?? []) as CrmOpportunityEvent[],
  };
}
