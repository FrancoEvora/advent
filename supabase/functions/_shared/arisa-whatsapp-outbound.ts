import type { SupabaseClient } from "npm:@supabase/supabase-js@2.110.7";
import { isObject, ManagerError, operationKey, UUID, type Obj } from "./arisa-manager.ts";
import { runWhatsAppTool } from "./arisa-whatsapp-runtime.ts";
import { normalizeWhatsAppRecipientInput, renderedTemplate } from "./arisa-whatsapp.ts";

export async function arisaOutbound(admin: SupabaseClient, org: string, actor: string, action: string, args: Obj, request?: typeof fetch): Promise<Obj> {
  const call = (action: string, input: Obj = {}) => runWhatsAppTool(admin, org, actor, action, input, undefined, { request });
  const preview = async () => {
    const result = await call("templates");
    const template = Array.isArray(result.templates) ? result.templates.filter(isObject).find(t => t.name === "arisa" && t.language === "pt_BR") : undefined;
    if (!template) throw new ManagerError("WHATSAPP_TEMPLATE_NOT_FOUND", 422);
    const body = renderedTemplate(template, []);
    return { name: template.name, language: template.language, body, hash: await operationKey("arisa_opening_preview", { name: template.name, language: template.language, body }) };
  };
  const status = async (id: string): Promise<Obj> => {
    const op = await call("request_status", { request_id: id });
    if (!op.id) return { id, status: "not_found" };
    return { id, status: op.delivery_status || op.status || "unknown", phone: op.phone, threadId: op.thread_id, errorCode: op.error_code };
  };
  if (action === "preview") return preview();
  if (typeof args.id !== "string" || !UUID.test(args.id)) throw new ManagerError("WHATSAPP_INVALID", 422);
  if (action === "status") return status(args.id);
  if (action !== "send") throw new ManagerError("WHATSAPP_INVALID", 422);
  if (args.consent !== true) throw new ManagerError("WHATSAPP_CONSENT_REQUIRED", 422);
  const phone = normalizeWhatsAppRecipientInput(args.phone);
  if (args.recipientName != null && (typeof args.recipientName !== "string" || args.recipientName.length > 80)) throw new ManagerError("WHATSAPP_INVALID", 422);
  const existing = await status(args.id);
  if (existing.status !== "not_found") {
    if (existing.phone && existing.phone !== phone) throw new ManagerError("WHATSAPP_REQUEST_CHANGED", 409);
    return existing;
  }
  const channel = await call("status");
  if (channel.ready !== true || channel.legacy_crm_enabled === true) throw new ManagerError("WHATSAPP_NOT_CONFIGURED", 409);
  const ownPhone = String(channel.display_phone_number || "").replace(/\D/g, "");
  const variants = (p: string) => p.startsWith("55") && p.length === 13 && p[4] === "9" ? p.slice(0,4)+p.slice(5) : p;
  if (ownPhone && variants(phone) === variants(ownPhone)) throw new ManagerError("WHATSAPP_SELF_RECIPIENT", 422);
  const template = await preview();
  if (args.hash !== template.hash) throw new ManagerError("WHATSAPP_TEMPLATE_CHANGED", 409);
  await runWhatsAppTool(admin, org, actor, "send", { phone, contact_name: typeof args.recipientName === "string" ? args.recipientName.trim() : "", template_name: template.name, template_language: template.language }, { requestId: args.id }, { request });
  return status(args.id);
}
