import { getSupabase } from "@/lib/supabase";
import type { ErpData, PurchaseRequest } from "../types";

export async function decidePurchase(data: ErpData, request: PurchaseRequest, status: "aprovada" | "rejeitada") {
  const client = getSupabase();
  if (!client) throw new Error("Supabase indisponível.");
  const result = await client.from("purchase_requests").update({
    status,
    approved_by: status === "aprovada" ? data.session.user.id : null,
    approved_at: status === "aprovada" ? new Date().toISOString() : null,
  }).eq("id", request.id);
  if (result.error) throw new Error(result.error.message);
}
