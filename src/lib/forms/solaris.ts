export const SOLARIS_FORM_SLUG = "solaris-futura-casa";
export const SOLARIS_FORM_PATH = "/atendimento/solaris/cadastro";
export const SOLARIS_CONSENT = "solaris-whatsapp-v1";
export const SOLARIS_INSTAGRAM_CONSENT = "solaris-instagram-v1";
export const SOLARIS_INSTAGRAM_CONSENT_TEXT = "Autorizo a Futura Casa e a Bia a considerar informações públicas do perfil que informei, quando o acesso for permitido, para personalizar meu atendimento sobre o Solaris. Posso retirar esta autorização a qualquer momento.";
export type SolarisSubmission = { requestId: string; name: string; phone: string; purpose: "investir" | "morar"; budget: "300_500" | "acima_500" | null; consent: true; instagram: string | null; instagramConsent: boolean; attribution: Record<string, string> };

/** Normalizes an explicitly supplied handle or profile URL; does not fetch or verify a profile. */
export function normalizeInstagram(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 200) return null;
  let handle = value.trim();
  if (/^(?:https?:\/\/|(?:www\.)?instagram\.com\/)/i.test(handle)) {
    try {
      const url = new URL(/^https?:\/\//i.test(handle) ? handle : `https://${handle}`);
      if (!["instagram.com", "www.instagram.com"].includes(url.hostname.toLowerCase()) || url.username || url.password || url.port) return null;
      const match = url.pathname.match(/^\/([a-zA-Z0-9._]+)\/?$/);
      if (!match) return null;
      handle = match[1];
    } catch { return null; }
  } else handle = handle.replace(/^@/, "");
  handle = handle.toLowerCase();
  if (!/^[a-z0-9_](?:[a-z0-9._]{0,28}[a-z0-9_])?$/.test(handle) || handle.includes("..")) return null;
  if (["p", "reel", "reels", "stories", "explore", "accounts", "direct", "about", "developer", "legal", "privacy", "terms"].includes(handle)) return null;
  return handle;
}

export function normalizePhone(value: unknown): string | null {
  if (typeof value !== "string") return null;
  let digits = value.replace(/\D/g, "");
  if ((digits.length === 12 || digits.length === 13) && digits.startsWith("55")) digits = digits.slice(2);
  const ddds = [11,12,13,14,15,16,17,18,19,21,22,24,27,28,31,32,33,34,35,37,38,41,42,43,44,45,46,47,48,49,51,53,54,55,61,62,63,64,65,66,67,68,69,71,73,74,75,77,79,81,82,83,84,85,86,87,88,89,91,92,93,94,95,96,97,98,99];
  if (!/^\d{10,11}$/.test(digits) || !ddds.includes(Number(digits.slice(0,2))) || /^(\d)\1+$/.test(digits.slice(2))) return null;
  if (digits.length === 11 && digits[2] !== "9") return null;
  if (digits.length === 10 && !/[2-9]/.test(digits[2])) return null;
  return "+55" + digits;
}

export function validateSolarisSubmission(value: unknown): SolarisSubmission | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  const name = typeof data.name === "string" ? data.name.trim().replace(/\s+/g, " ") : "";
  const phone = normalizePhone(data.phone);
  if (!/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(String(data.requestId)) || name.length < 3 || name.length > 120 || !phone || data.consent !== true || data.website || !["investir", "morar"].includes(String(data.purpose)) || (data.budget != null && !["300_500", "acima_500"].includes(String(data.budget)))) return null;
  if (data.instagram != null && typeof data.instagram !== "string") return null;
  const rawInstagram = typeof data.instagram === "string" ? data.instagram.trim() : "";
  const instagram = normalizeInstagram(rawInstagram);
  if (rawInstagram && !instagram) return null;
  if (data.instagramConsent != null && typeof data.instagramConsent !== "boolean") return null;
  const instagramConsent = data.instagramConsent === true;
  if (instagramConsent && !instagram) return null;
  const attribution: Record<string, string> = {};
  const raw = data.attribution && typeof data.attribution === "object" && !Array.isArray(data.attribution) ? data.attribution as Record<string, unknown> : {};
  for (const key of ["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term", "fbclid", "campaign_id", "adset_id", "ad_id"]) {
    if (typeof raw[key] === "string") attribution[key] = raw[key].slice(0,200);
  }
  return { requestId: String(data.requestId).toLowerCase(), name, phone, consent: true, purpose: data.purpose as SolarisSubmission["purpose"], budget: (data.budget ?? null) as SolarisSubmission["budget"], instagram, instagramConsent, attribution };
}
