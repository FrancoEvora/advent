/** Coexistence is onboarding, not a read-only eligibility API. Reviewed 2026-10-03. */
export const CONNECT_POLICY = {
  mode: "preflight_only",
  launchAllowed: false,
  eligibility: "unknown",
  reason: "META_READ_ONLY_ELIGIBILITY_UNAVAILABLE",
  graphVersion: "v26.0",
  embeddedSignupVersion: "v4",
  channel: "franco_personal",
  documentation: "https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users",
} as const;

// Kept as a reviewed contract for the later, separately authorized onboarding.
// No runtime code in this release calls FB.login or exchanges an OAuth code.
export function coexistenceLoginOptions(configId: string) {
  if (!/^\d{5,32}$/.test(configId)) throw new Error("INVALID_META_CONFIG_ID");
  return {
    config_id: configId,
    response_type: "code",
    override_default_response_type: true,
    extras: { setup: {}, featureType: "whatsapp_business_app_onboarding", sessionInfoVersion: "3" },
  } as const;
}

export type ConnectSnapshot = {
  connection: { id: string; label: string; onboarding_status: string; coexistence_status: string; updated_at: string } | null;
  audit: { id: string; event: string; to_state: string; created_at: string }[];
  primary: { configured: boolean; enabled: boolean };
};

export type ConnectResponse = ConnectSnapshot & {
  ok: true;
  policy: typeof CONNECT_POLICY;
  configuration: { appIdPresent: boolean; configIdPresent: boolean };
};
