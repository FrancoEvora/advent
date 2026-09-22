import { biaApprovedTemplate, biaInitialPhone, biaPersonalizedOpening, biaRecipientName } from "./bia-whatsapp-outbound.ts";

type Obj = Record<string, unknown>;
type Rpc = (name: string, args: Obj) => Promise<unknown>;
const object = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const string = (v: unknown) => typeof v === "string" ? v : "";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const code = (e: unknown) => e instanceof Error && /^BIA_[A-Z_]+$/.test(e.message) ? e.message : "BIA_CAMPAIGN_UNAVAILABLE";

// Only trusted, leased database jobs can choose a campaign template. No client payload is used.
export async function processBiaCampaignOutreach(rpc: Rpc, http: typeof fetch = fetch) {
  const call = async (action: string, args: Obj = {}) => {
    const result = await rpc("bia_campaign_outreach_worker", { p_action: action, p_args: args });
    if (!object(result)) throw new Error("BIA_CAMPAIGN_UNAVAILABLE");
    return result;
  };
  let processed = 0, deferred = 0;
  for (let i = 0; i < 3; i++) {
    const job = await call("claim");
    if (!job.id) break;
    if (![job.id, job.lease, job.organization_id].every(v => uuid.test(string(v)))) throw new Error("BIA_CAMPAIGN_JOB_INVALID");
    const key = { id: job.id, lease: job.lease };
    let started = false;
    try {
      const phone = biaInitialPhone(job.phone);
      const credentials = await rpc("bia_whatsapp_credentials", { p_organization_id: job.organization_id });
      if (!object(credentials)) throw new Error("BIA_CHANNEL_DISABLED");
      const template = await biaApprovedTemplate(credentials, string(job.template_name), http);
      let name: string;
      try { name = biaRecipientName(job.recipient_name); } catch { name = "tudo bem"; }
      const opening = biaPersonalizedOpening(template, name);
      const reservation = await call("start", { ...key, hash: template.hash, body: opening.plainText });
      if (reservation.proceed !== true) continue;
      started = true;
      let outcome: Obj = { status: "unknown", errorCode: "SEND_UNCONFIRMED" };
      try {
        const response = await http(
          "https://graph.facebook.com/" + credentials.graph_api_version + "/" + credentials.phone_number_id + "/messages",
          {
            method: "POST", redirect: "error", signal: AbortSignal.timeout(20000),
            headers: { Authorization: "Bearer " + credentials.access_token, "content-type": "application/json" },
            body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to: phone, type: "template",
              template: { name: template.name, language: { code: "pt_BR" }, ...(opening.components.length ? { components: opening.components } : {}) },
              biz_opaque_callback_data: job.id }),
          },
        );
        const payload: unknown = await response.json();
        const message = object(payload) && Array.isArray(payload.messages) ? payload.messages[0] : null;
        const contact = object(payload) && Array.isArray(payload.contacts) ? payload.contacts[0] : null;
        if (response.ok && object(message) && string(message.id)) {
          outcome = { status: "accepted", providerMessageId: message.id, recipientPhone: object(contact) && string(contact.wa_id) ? contact.wa_id : phone };
        } else if (response.status >= 400 && response.status < 500 && object(payload) && object(payload.error)) {
          outcome = { status: "failed", errorCode: "META_" + String(payload.error.code || response.status).replace(/[^0-9]/g, "").slice(0, 12) };
        }
      } catch { /* Unknown outcomes must never trigger another Graph send. */ }
      await call("finish", { ...key, ...outcome });
      processed++;
    } catch (error) {
      if (started) continue; // Webhooks or lease reconciliation settle uncertain outcomes.
      await call("defer", { ...key, error: code(error) }).catch(() => {});
      deferred++;
    }
  }
  return { processed, deferred };
}

