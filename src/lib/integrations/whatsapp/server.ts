import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseIntegrationConfig } from "@/lib/integrations/meta/server-config";

type Obj = Record<string, unknown>;

let serviceClient: SupabaseClient | null = null;

export class WhatsAppServerError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 503) {
    super(code);
    this.name = "WhatsAppServerError";
    this.code = code;
    this.status = status;
  }
}

export function serviceDatabase() {
  if (serviceClient) return serviceClient;
  const config = getSupabaseIntegrationConfig();
  serviceClient = createClient(config.url, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    global: { headers: { "X-Client-Info": "evora-whatsapp-cloud/1.0" } },
  });
  return serviceClient;
}

function object(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export type WhatsAppRuntimeCredentials = {
  organizationId: string;
  enabled: boolean;
  mode: "supervised" | "autonomous_replies";
  wabaId: string;
  phoneNumberId: string;
  graphApiVersion: string;
  accessToken: string;
  appSecret: string;
  verifyToken: string;
};

function credentials(value: unknown): WhatsAppRuntimeCredentials | null {
  if (!object(value)) return null;
  const required = ["organization_id","waba_id","phone_number_id","graph_api_version","access_token","app_secret","verify_token"] as const;
  if (!required.every((key) => typeof value[key] === "string" && String(value[key]).length > 0)) return null;
  if (value.enabled !== true) return null;
  const mode = value.mode === "autonomous_replies" ? "autonomous_replies" : "supervised";
  return {
    organizationId: String(value.organization_id), enabled: true, mode,
    wabaId: String(value.waba_id), phoneNumberId: String(value.phone_number_id),
    graphApiVersion: String(value.graph_api_version), accessToken: String(value.access_token),
    appSecret: String(value.app_secret), verifyToken: String(value.verify_token),
  };
}

export async function getWhatsAppCredentialsByOrganization(organizationId: string) {
  const { data, error } = await serviceDatabase().rpc("get_whatsapp_runtime_credentials", { p_organization_id: organizationId });
  if (error) throw new WhatsAppServerError("WHATSAPP_RUNTIME_LOOKUP_FAILED");
  return credentials(data);
}

export async function getWhatsAppCredentialsByPhoneNumberId(phoneNumberId: string) {
  const { data, error } = await serviceDatabase().rpc("get_whatsapp_runtime_by_phone_number_id", { p_phone_number_id: phoneNumberId });
  if (error) throw new WhatsAppServerError("WHATSAPP_RUNTIME_LOOKUP_FAILED");
  return credentials(data);
}

export async function sendWhatsAppText(input: { runtime: WhatsAppRuntimeCredentials; to: string; text: string }) {
  const to = input.to.replace(/[^0-9]/g, "");
  if (to.length < 8 || to.length > 20) throw new WhatsAppServerError("WHATSAPP_DESTINATION_INVALID", 400);
  const text = input.text.trim();
  if (!text || text.length > 4096) throw new WhatsAppServerError("WHATSAPP_TEXT_INVALID", 400);
  const endpoint = `https://graph.facebook.com/${encodeURIComponent(input.runtime.graphApiVersion)}/${encodeURIComponent(input.runtime.phoneNumberId)}/messages`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${input.runtime.accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ messaging_product: "whatsapp", recipient_type: "individual", to, type: "text", text: { preview_url: false, body: text } }),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok || !object(payload)) throw new WhatsAppServerError(`WHATSAPP_GRAPH_HTTP_${response.status}`, response.status >= 500 ? 503 : 409);
    const messages = Array.isArray(payload.messages) ? payload.messages : [];
    const first = object(messages[0]) ? messages[0] : null;
    const id = first && typeof first.id === "string" ? first.id : null;
    if (!id) throw new WhatsAppServerError("WHATSAPP_GRAPH_MESSAGE_ID_MISSING", 503);
    return { providerMessageId: id };
  } catch (error) {
    if (error instanceof WhatsAppServerError) throw error;
    if (error instanceof Error && error.name === "AbortError") throw new WhatsAppServerError("WHATSAPP_GRAPH_TIMEOUT", 503);
    throw new WhatsAppServerError("WHATSAPP_GRAPH_NETWORK_FAILURE", 503);
  } finally {
    clearTimeout(timeout);
  }
}
