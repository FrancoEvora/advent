import { type NextRequest, NextResponse } from "next/server";
import { signOnboardingState } from "@/lib/integrations/meta/onboarding-contract";
import { configured, onboardingAuth, onboardingBody, onboardingConfig, onboardingCookie, OnboardingError, onboardingFailure, onboardingHeaders } from "@/lib/integrations/meta/onboarding-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: NextRequest) {
  try {
    const auth = await onboardingAuth(request, request.nextUrl.searchParams.get("organizationId"));
    const [wa, ig] = await Promise.all([
      auth.client.rpc("get_whatsapp_runtime_status", { p_organization_id: auth.organizationId }),
      auth.client.rpc("enterprise_instagram_status", { p_organization_id: auth.organizationId }),
    ]);
    const config = onboardingConfig();
    return NextResponse.json({
      whatsapp: { available: configured("whatsapp") && !ig.error && !wa.error, runtime: wa.error ? null : wa.data, error: wa.error ? "Não foi possível consultar o canal." : ig.error ? "A preparação da conexão guiada no Enterprise ainda está pendente." : null },
      instagram: { available: configured("instagram") && !ig.error, account: ig.error ? null : ig.data, error: ig.error ? "A preparação do Instagram no Enterprise ainda está pendente." : null },
      originMatches: request.nextUrl.origin === config.origin,
      appId: config.appId, graphVersion: config.graphVersion,
      callbackUrl: config.origin ? `${config.origin}/integrations/meta/callback` : null,
    }, { headers: onboardingHeaders });
  } catch (error) { return onboardingFailure(error); }
}
export async function POST(request: NextRequest) {
  try {
    const body = await onboardingBody(request);
    const auth = await onboardingAuth(request, body.organizationId);
    if (body.channel !== "whatsapp" && body.channel !== "instagram") throw new OnboardingError("Escolha WhatsApp ou Instagram.");
    const config = onboardingConfig();
    if (!configured(body.channel)) throw new OnboardingError("A equipe técnica precisa concluir a configuração do aplicativo Meta para habilitar este botão.", 503);
    if (request.nextUrl.origin !== config.origin) throw new OnboardingError("Conecte a conta pelo endereço oficial do Enterprise. Este ambiente é apenas para revisão.");
    const state = signOnboardingState({ organizationId: auth.organizationId, userId: auth.userId, channel: body.channel }, config.secret);
    let authorizeUrl: string | null = null;
    if (body.channel === "instagram") {
      const url = new URL("https://www.instagram.com/oauth/authorize");
      url.search = new URLSearchParams({ client_id: config.instagramAppId, redirect_uri: `${config.origin}/integrations/meta/callback`, response_type: "code", scope: "instagram_business_basic", state, enable_fb_login: "0", force_authentication: "1" }).toString();
      authorizeUrl = url.toString();
    }
    const response = NextResponse.json({ state, authorizeUrl, appId: config.appId, configId: config.configId, graphVersion: config.graphVersion }, { headers: onboardingHeaders });
    response.cookies.set(onboardingCookie, state, { httpOnly: true, secure: true, sameSite: "lax", path: "/api/integrations/meta", maxAge: 600 });
    return response;
  } catch (error) { return onboardingFailure(error); }
}
