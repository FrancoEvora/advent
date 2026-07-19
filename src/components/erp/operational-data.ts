import { getSupabase } from "@/lib/supabase";

export async function loadOperationalData(organizationId: string) {
  const client = getSupabase();
  if (!client) throw new Error("Supabase indisponível.");
  const [documents, purchaseRequests, purchaseItems, hrEmployees, hrEvents, hrPayrollRuns, hrPayrollItems, revenueCenters, crmRecords, crmActions] = await Promise.all([
    client.from("document_attachments").select("*").eq("organization_id", organizationId).order("created_at", { ascending: false }),
    client.from("purchase_requests").select("*").eq("organization_id", organizationId).order("created_at", { ascending: false }),
    client.from("purchase_request_items").select("*").order("description"),
    client.from("hr_employees").select("*").eq("organization_id", organizationId).order("full_name"),
    client.from("hr_events").select("*").eq("organization_id", organizationId).order("reference_date", { ascending: false }),
    client.from("hr_payroll_runs").select("*").eq("organization_id", organizationId).order("reference_month", { ascending: false }),
    client.from("hr_payroll_items").select("*"),
    client.from("revenue_centers").select("*").eq("organization_id", organizationId).order("code"),
    client.from("crm_records").select("*").eq("organization_id", organizationId).order("updated_at", { ascending: false }),
    client.from("crm_actions").select("*").eq("organization_id", organizationId).order("scheduled_at", { ascending: true }),
  ]);
  const failed = [documents, purchaseRequests, purchaseItems, hrEmployees, hrEvents, hrPayrollRuns, hrPayrollItems, revenueCenters, crmRecords, crmActions].find(result => result.error);
  if (failed?.error) throw failed.error;
  return {
    documents: documents.data ?? [], purchaseRequests: purchaseRequests.data ?? [], purchaseItems: purchaseItems.data ?? [],
    hrEmployees: hrEmployees.data ?? [], hrEvents: hrEvents.data ?? [], hrPayrollRuns: hrPayrollRuns.data ?? [], hrPayrollItems: hrPayrollItems.data ?? [],
    revenueCenters: revenueCenters.data ?? [], crmRecords: crmRecords.data ?? [], crmActions: crmActions.data ?? [],
  };
}