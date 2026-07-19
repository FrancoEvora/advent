import { getSupabase } from "@/lib/supabase";
import type { ErpData, PurchaseRequest } from "../types";

export async function createPurchasePayable(data: ErpData, request: PurchaseRequest) {
  const client = getSupabase();
  if (!client) throw new Error("Supabase indisponível.");
  const today = new Date().toISOString().slice(0, 10);
  const result = await client.from("financial_entries").insert({
    organization_id: data.organization.id,
    user_id: data.session.user.id,
    created_by: data.session.user.id,
    type: "saida",
    description: request.title,
    category: "Compras e suprimentos",
    cost_center_id: request.cost_center_id,
    contact_id: request.supplier_contact_id,
    project_id: request.project_id,
    amount: request.estimated_total,
    due_date: request.payment_due_date || today,
    issue_date: today,
    competence_date: today,
    status: "pendente",
    approval_status: "aprovado",
  }).select("id").single();
  if (result.error) throw new Error(result.error.message);
  const linked = await client.from("purchase_requests").update({ financial_entry_id: result.data.id, status: "contratada" }).eq("id", request.id);
  if (linked.error) throw new Error(linked.error.message);
}
