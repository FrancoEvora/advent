/** Official Business App coexistence onboarding, reviewed 2026-10-03. */
export const CONNECT_POLICY = {
  mode: "coexistence", launchAllowed: true, graphVersion: "v26.0", embeddedSignupVersion: "v4",
  channel: "franco_personal", automationEnabled: false,
  documentation: "https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users",
} as const;
export const metaId = (value: unknown): value is string => typeof value === "string" && /^\d{5,32}$/.test(value);
export const record = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
export function coexistenceLoginOptions(configId: string) {
  if (!metaId(configId)) throw new Error("INVALID_META_CONFIG_ID");
  return { config_id: configId, response_type: "code", override_default_response_type: true,
    extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" } } as const;
}
export type MetaFinish = { event: "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING"; wabaId: string; phoneNumberId?: string };
export type MetaEvent = MetaFinish | { event: "CANCEL" | "ERROR" };
export function parseMetaEvent(origin: string, raw: unknown): MetaEvent | null {
  if (!["https://www.facebook.com", "https://web.facebook.com", "https://business.facebook.com", "https://m.facebook.com"].includes(origin)) return null;
  if (typeof raw !== "string" || raw.length > 16384) return null;
  let value: unknown; try { value = JSON.parse(raw); } catch { return null; }
  if (!record(value) || value.type !== "WA_EMBEDDED_SIGNUP") return null;
  if (value.event === "CANCEL" || value.event === "ERROR") return { event: value.event };
  if (value.event !== "FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING" || !record(value.data) || !metaId(value.data.waba_id)) return null;
  return { event: value.event, wabaId: value.data.waba_id, ...(metaId(value.data.phone_number_id) ? { phoneNumberId: value.data.phone_number_id } : {}) };
}
export function maskPhone(value: unknown) {
  const digits = typeof value === "string" ? value.replace(/\D/g, "") : "";
  return digits.length >= 8 ? `•••• ${digits.slice(-4)}` : "Número confirmado";
}
export type ConnectSnapshot = {
  connection: { id: string; label: string; onboarding_status: string; coexistence_status: string; updated_at: string;
    phone_number_masked: string | null; waba_id: string | null; phone_number_id: string | null;
    operations: Record<string, string>; sync_progress: number | null; history_shared: boolean | null; token_expires_at: string | null } | null;
  configuration: { appId: string | null; configId: string | null; ready: boolean };
  audit: { id: string; event: string; to_state: string; created_at: string }[];
  primary: { configured: boolean; enabled: boolean };
};
export type ConnectResponse = ConnectSnapshot & { ok: true; policy: typeof CONNECT_POLICY };
export type OnboardingSession = { sessionId: string; nonce: string; expiresAt: string; appId: string; configId: string };
