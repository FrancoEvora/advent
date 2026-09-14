import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type MetaChannel = "whatsapp" | "instagram";
export type OnboardingState = { organizationId: string; userId: string; channel: MetaChannel; expiresAt: number; nonce: string };
export function signOnboardingState(input: Omit<OnboardingState, "expiresAt" | "nonce">, secret: string, now = Date.now()) {
  if (secret.length < 32) throw new Error("ONBOARDING_NOT_CONFIGURED");
  const payload = Buffer.from(JSON.stringify({ ...input, expiresAt: now + 600_000, nonce: randomBytes(24).toString("hex") })).toString("base64url");
  return `${payload}.${createHmac("sha256", secret).update(payload).digest("base64url")}`;
}
export function verifyOnboardingState(value: string, cookie: string, secret: string, expected: { organizationId: string; userId: string }, now = Date.now()): OnboardingState {
  if (!value || value.length > 2048 || value !== cookie || secret.length < 32) throw new Error("INVALID_ONBOARDING_STATE");
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) throw new Error("INVALID_ONBOARDING_STATE");
  const actual = Buffer.from(signature, "base64url");
  const wanted = createHmac("sha256", secret).update(payload).digest();
  if (actual.length !== wanted.length || !timingSafeEqual(actual, wanted)) throw new Error("INVALID_ONBOARDING_STATE");
  const state = JSON.parse(Buffer.from(payload, "base64url").toString()) as OnboardingState;
  if (state.organizationId !== expected.organizationId || state.userId !== expected.userId || !["whatsapp", "instagram"].includes(state.channel) || !Number.isFinite(state.expiresAt) || state.expiresAt <= now || state.expiresAt > now + 600_000 || typeof state.nonce !== "string") throw new Error("INVALID_ONBOARDING_STATE");
  return state;
}
export function sameWhatsAppIdentity(current: { phone_number_id?: string | null; waba_id?: string | null }, phone: string, waba: string) {
  return (!current.phone_number_id || current.phone_number_id === phone) && (!current.waba_id || current.waba_id === waba);
}
export function metaErrorMessage(code: number | undefined) {
  if (code === 190) return "A autorização expirou ou foi revogada. Conecte a conta novamente.";
  if (code === 10 || code === 200) return "Faltam permissões na Meta. Revise o acesso à conta e a aprovação do aplicativo.";
  if (code === 4 || code === 17 || code === 613) return "A Meta limitou temporariamente as consultas. Aguarde antes de tentar novamente.";
  return "A Meta não concluiu a operação. Verifique as permissões e tente novamente.";
}
