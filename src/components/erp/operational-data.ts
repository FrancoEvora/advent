import { getSupabase } from "@/lib/supabase";

export async function loadOperationalData(organizationId: string) {
  const client = getSupabase();
  if (!client) throw new Error("Supabase indisponível.");
  const [documents, purchaseRequests, purchaseItems, hrEmployees, hrEvents, hrPayrollRuns, hrPayrollItems, revenueCenters] = await Promise.all([
    client.from("document_attachments").select("*").eq("organization_id", organizationId).order("created_at", { ascending: false }),
    client.from("purchase_requests").select("*").eq("organization_id", organizationId).order("created_at", { ascending: false }),
    client.from("purchase_request_items").select("*").order("description"),
    client.from("hr_employees").select("*").eq("organization_id", organizationId).order("full_name"),
    client.from("hr_events").select("*").eq("organization_id", organizationId).order("reference_date", { ascending: false }),
    client.from("hr_payroll_runs").select("*").eq("organization_id", organizationId).order("reference_month", { ascending: false }),
    client.from("hr_payroll_items").select("*"),
    client.from("revenue_centers").select("*").eq("organization_id", organizationId).order("code"),
  ]);
  const failed = [documents, purchaseRequests, purchaseItems, hrEmployees, hrEvents, hrPayrollRuns, hrPayrollItems, revenueCenters].find(result => result.error);
  if (failed?.error) throw failed.error;
  return { documents: documents.data ?? [], purchaseRequests: purchaseRequests.data ?? [], purchaseItems: purchaseItems.data ?? [], hrEmployees: hrEmployees.data ?? [], hrEvents: hrEvents.data ?? [], hrPayrollRuns: hrPayrollRuns.data ?? [], hrPayrollItems: hrPayrollItems.data ?? [], revenueCenters: revenueCenters.data ?? [] };
}
