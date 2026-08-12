import type { MetaLeadBundle } from "./graph-api";

type JsonObject = Record<string, unknown>;

const NAME_FIELDS = ["full_name", "nome_completo", "nome", "name"];
const FIRST_NAME_FIELDS = ["first_name", "primeiro_nome"];
const LAST_NAME_FIELDS = ["last_name", "sobrenome"];
const PHONE_FIELDS = [
  "phone_number",
  "phone",
  "telefone",
  "numero_de_telefone",
  "whatsapp",
];
const EMAIL_FIELDS = ["email", "email_address", "endereco_de_email"];

export class MetaLeadNormalizationError extends Error {
  readonly code: string;
  readonly retryable = false;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MetaLeadNormalizationError";
    this.code = code;
  }
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function fieldKey(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function fieldMap(lead: JsonObject): Map<string, string[]> {
  const result = new Map<string, string[]>();
  if (!Array.isArray(lead.field_data)) return result;
  for (const candidate of lead.field_data) {
    if (!isObject(candidate) || typeof candidate.name !== "string") continue;
    const values = Array.isArray(candidate.values)
      ? candidate.values.filter((item): item is string => typeof item === "string")
      : [];
    result.set(fieldKey(candidate.name), values);
  }
  return result;
}

function firstValue(fields: Map<string, string[]>, aliases: string[]): string | null {
  for (const alias of aliases) {
    const value = fields.get(alias)?.find((item) => item.trim());
    if (value) return value.trim();
  }
  return null;
}

function normalizeName(fields: Map<string, string[]>): string | null {
  const fullName = firstValue(fields, NAME_FIELDS);
  const name = fullName || [
    firstValue(fields, FIRST_NAME_FIELDS),
    firstValue(fields, LAST_NAME_FIELDS),
  ].filter(Boolean).join(" ");
  const normalized = name.replace(/\s+/g, " ").trim();
  return normalized.length >= 2 && normalized.length <= 180 ? normalized : null;
}

export function normalizePhoneE164(
  value: string | null,
  defaultCountryCode = "55",
): string | null {
  if (!value || !/^[1-9]\d{0,2}$/.test(defaultCountryCode)) return null;
  const trimmed = value.trim();
  const hadInternationalPrefix = trimmed.startsWith("+") || trimmed.startsWith("00");
  let digits = trimmed.replace(/\D/g, "");
  if (trimmed.startsWith("00")) digits = digits.slice(2);

  if (!hadInternationalPrefix) {
    if (digits.startsWith("0") && (digits.length === 11 || digits.length === 12)) {
      digits = digits.slice(1);
    }
    const alreadyInternational =
      digits.startsWith(defaultCountryCode) &&
      digits.length >= defaultCountryCode.length + 10 &&
      digits.length <= defaultCountryCode.length + 11;
    if (!alreadyInternational && digits.length >= 10 && digits.length <= 11) {
      digits = `${defaultCountryCode}${digits}`;
    } else if (!alreadyInternational) {
      return null;
    }
  }

  return /^\d{8,15}$/.test(digits) ? `+${digits}` : null;
}

function normalizeEmail(value: string | null): string | null {
  if (!value) return null;
  const email = value.trim().toLowerCase();
  if (
    email.length > 254 ||
    !/^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/.test(email)
  ) {
    return null;
  }
  return email;
}

function disclaimerConsent(
  lead: JsonObject,
  configuredKeys: string[],
): {
  status: "unknown" | "granted" | "denied";
  source: string | null;
} {
  if (!configuredKeys.length || !Array.isArray(lead.custom_disclaimer_responses)) {
    return { status: "unknown", source: null };
  }
  const acceptedKeys = new Set(configuredKeys.map(fieldKey));
  const matches = lead.custom_disclaimer_responses.flatMap((candidate) => {
    if (!isObject(candidate) || typeof candidate.checkbox_key !== "string") return [];
    const normalizedKey = fieldKey(candidate.checkbox_key);
    if (!acceptedKeys.has(normalizedKey)) return [];
    const raw = candidate.is_checked;
    const checked = raw === true || raw === 1 || raw === "1" || raw === "true";
    const unchecked =
      raw === false || raw === 0 || raw === "0" || raw === "" || raw === "false";
    return checked || unchecked ? [{ key: normalizedKey, checked }] : [];
  });
  if (!matches.length) return { status: "unknown", source: null };
  const matchedKeys = [...new Set(matches.map((item) => item.key))];
  return {
    status: matches.some((item) => item.checked) ? "granted" : "denied",
    source: `meta_custom_disclaimer:${matchedKeys.join(",")}`,
  };
}

function capturedAt(bundle: MetaLeadBundle): string {
  const leadTime = typeof bundle.lead.created_time === "string"
    ? Date.parse(bundle.lead.created_time)
    : Number.NaN;
  if (Number.isFinite(leadTime)) return new Date(leadTime).toISOString();
  if (bundle.webhook.created_time !== null) {
    return new Date(bundle.webhook.created_time * 1_000).toISOString();
  }
  return bundle.fetched_at;
}

export function buildMetaIngestPayload(
  bundle: MetaLeadBundle,
  defaultCountryCode = "55",
  marketingConsentCheckboxKeys: string[] = [],
): JsonObject {
  const fields = fieldMap(bundle.lead);
  const name =
    normalizeName(fields) ||
    `Lead Meta ${bundle.webhook.leadgen_id.slice(-8)}`;
  const rawPhone = firstValue(fields, PHONE_FIELDS);
  const rawEmail = firstValue(fields, EMAIL_FIELDS);
  const phone = normalizePhoneE164(rawPhone, defaultCountryCode);
  const email = normalizeEmail(rawEmail);
  if (!phone && !email) {
    throw new MetaLeadNormalizationError(
      "META_LEAD_CONTACT_MISSING",
      "O formulário Meta não forneceu telefone ou e-mail válido.",
    );
  }
  const marketingConsent = disclaimerConsent(
    bundle.lead,
    marketingConsentCheckboxKeys,
  );
  const leadCapturedAt = capturedAt(bundle);

  return {
    raw_payload: {
      lead: bundle.lead,
      graph: bundle.graph,
      webhook: bundle.webhook,
      fetched_at: bundle.fetched_at,
    },
    person: {
      name,
      phone_e164: phone,
      email,
      marketing_consent_status: marketingConsent.status,
      marketing_consent_at:
        marketingConsent.status === "granted" ? leadCapturedAt : null,
      ...(marketingConsent.source
        ? { marketing_consent_source: marketingConsent.source }
        : {}),
    },
    attribution: {
      provider_account_id: bundle.attribution.provider_account_id,
      campaign_id: bundle.attribution.campaign_id,
      campaign_name: bundle.attribution.campaign_name,
      adset_id: bundle.attribution.adset_id,
      adset_name: bundle.attribution.adset_name,
      ad_id: bundle.attribution.ad_id,
      ad_name: bundle.attribution.ad_name,
      creative_id: bundle.attribution.creative_id,
      creative_name: bundle.attribution.creative_name,
      form_name: bundle.attribution.form_name,
      page_name: bundle.attribution.page_name,
      placement: bundle.attribution.placement,
      publisher_platform: bundle.attribution.publisher_platform,
      platform_position: null,
      device_platform: null,
      captured_at: leadCapturedAt,
      attribution_incomplete: bundle.attribution.attribution_incomplete,
      enrichment_warnings: bundle.attribution.enrichment_warnings,
    },
  };
}
