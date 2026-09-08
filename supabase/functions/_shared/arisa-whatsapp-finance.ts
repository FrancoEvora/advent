import type { SupabaseClient } from "npm:@supabase/supabase-js@2.110.7";
import { isObject, ManagerError, type Obj } from "./arisa-manager.ts";
import { analyzeWhatsAppAttention } from "./arisa-whatsapp-attention.ts";

export function redactIdentity(text: string): string {
  return text
    .replace(/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b|\b(?:\d{14}|\d{11})\b/g, "[documento omitido]")
    .replace(/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[e-mail omitido]");
}
export function financeHistory(history: Obj[], state: Obj): Obj[] {
  const hidden = new Set(Array.isArray(state.redacted_message_ids) ? state.redacted_message_ids : []);
  const result: Obj[] = history.filter(row => !hidden.has(row.id)).map(row => ({ ...row, content: redactIdentity(String(row.content || "")) }));
  if (state.just_verified === true && typeof state.request === "string") result.push({ direction: "inbound", content: redactIdentity(state.request) });
  return result;
}
export async function prepareWhatsAppConversation(admin: SupabaseClient, job: Obj, history: Obj[], config: Obj, request?: typeof fetch) {
  const financeCall = async (action: string, reference = "") => {
    const r = await admin.rpc("arisa_whatsapp_finance", { p_job: job.id, p_lease: job.lease, p_action: action, p_reference: reference });
    if (r.error || !isObject(r.data)) throw new ManagerError("WHATSAPP_FINANCE_UNAVAILABLE");
    return r.data;
  };
  const record = async (analysis: Obj) => {
    const r = await admin.rpc("arisa_whatsapp_attention", { p_job: job.id, p_lease: job.lease, p_analysis: analysis });
    if (r.error || !isObject(r.data)) throw new ManagerError("WHATSAPP_ATTENTION_UNAVAILABLE");
    return r.data;
  };
  const held = async (state: Obj) => {
    const attention = state.escalate === true ? await record({
      kind: "subject", needs_notification: true, requires_authorization: false, target_names: [],
      summary: "Atendimento financeiro: não foi possível confirmar o cadastro do interlocutor. Conferir a identidade e os dados cadastrais antes de fornecer informações. Nenhum valor foi divulgado.",
    }) : { status: "not_needed" };
    const content = state.escalate === true && attention.status === "notified"
      ? "Não consegui confirmar o cadastro com segurança por aqui. Encaminhei o atendimento à equipe para conferência, antes de consultar valores."
      : String(state.reply || "Para consultar seus pagamentos, preciso confirmar nome completo ou razão social, CPF/CNPJ e e-mail cadastrados.");
    return { history: [] as Obj[], attention, finance: {} as Obj, content, usage: { identity_check: "server_only" } as Obj };
  };
  let state = await financeCall("probe");
  if (state.handled === true) return held(state);
  let safeHistory = financeHistory(history, state);
  const triage = await analyzeWhatsAppAttention(safeHistory, config, request);
  let analysis = triage.analysis;
  let financial: Obj = {};
  if (["financial", "negotiation"].includes(String(analysis.kind)) && analysis.requires_authorization === false) {
    if (state.verified !== true) {
      state = await financeCall("start");
      if (state.handled === true || state.verified !== true) return held(state);
      safeHistory = financeHistory(history, state);
    }
    financial = await financeCall("consult", typeof analysis.financial_reference === "string" ? analysis.financial_reference : "");
    if (financial.verified !== true) throw new ManagerError("WHATSAPP_FINANCE_UNAVAILABLE");
    analysis = { ...analysis, kind: analysis.kind === "negotiation" ? "negotiation" : analysis.needs_notification ? "subject" : "none",
      needs_notification: analysis.kind === "negotiation" || analysis.needs_notification === true,
      requires_authorization: false };
  }
  if (analysis.requires_authorization === true && ["financial", "negotiation"].includes(String(analysis.kind))) analysis = { ...analysis, kind: "authorization" };
  const attention = await record(analysis);
  return { history: safeHistory, attention, finance: financial, content: undefined,
    usage: { attention: triage.usage, attention_response_id: triage.response_id } as Obj };
}
