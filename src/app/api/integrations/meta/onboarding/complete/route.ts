import { randomBytes } from "node:crypto";
import { serviceDatabase } from "@/lib/integrations/whatsapp/server";
import { type NextRequest, NextResponse } from "next/server";
import { sameWhatsAppIdentity, verifyOnboardingState } from "@/lib/integrations/meta/onboarding-contract";
import { asObject, configured, metaId, metaRequest, onboardingAuth, onboardingBody, onboardingConfig, onboardingCookie, OnboardingError, onboardingFailure, onboardingHeaders } from "@/lib/integrations/meta/onboarding-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function POST(request: NextRequest) {
  try {
    const body = await onboardingBody(request);
    const auth = await onboardingAuth(request, body.organizationId);
    const config = onboardingConfig();
    if (request.nextUrl.origin !== config.origin) throw new OnboardingError("Conclua a conexão no endereço oficial do Enterprise.");
    const state = verifyOnboardingState(String(body.state || ""), request.cookies.get(onboardingCookie)?.value || "", config.secret, auth);
    if (!configured(state.channel)) throw new OnboardingError("Configuração do aplicativo Meta pendente.", 503);
    if (typeof body.code !== "string" || body.code.length < 8 || body.code.length > 4096) throw new OnboardingError("A Meta não devolveu uma autorização válida.");
    const claim = await auth.client.rpc("enterprise_meta_claim_onboarding", { p_organization_id: auth.organizationId, p_nonce: state.nonce });
    if (claim.error || claim.data !== true) throw new OnboardingError("Esta tentativa já foi utilizada ou a integração está pendente. Inicie novamente.", 409);
    let result: Record<string, unknown>;
    if (state.channel === "whatsapp") {
      const wabaId = metaId(body.wabaId), phoneNumberId = metaId(body.phoneNumberId);
      const current = await auth.client.rpc("get_whatsapp_runtime_status", { p_organization_id: auth.organizationId });
      if (current.error) throw new OnboardingError("Não foi possível verificar o canal existente.", 503);
      if (!sameWhatsAppIdentity(asObject(current.data), phoneNumberId, wabaId)) throw new OnboardingError("O número escolhido é diferente do canal atual. A troca exige migração assistida para preservar os históricos da Arisa e da Bia.", 409);
      const exchange = new URL(`https://graph.facebook.com/${config.graphVersion}/oauth/access_token`);
      exchange.search = new URLSearchParams({ client_id: config.appId, client_secret: config.appSecret, code: body.code }).toString();
      const tokenResult = await metaRequest(exchange);
      const token = typeof tokenResult.access_token === "string" ? tokenResult.access_token : "";
      if (!token) throw new OnboardingError("A Meta não forneceu a credencial do canal.", 502);
      const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
      const phonesUrl = new URL(`https://graph.facebook.com/${config.graphVersion}/${wabaId}/phone_numbers`);
      phonesUrl.search = new URLSearchParams({ fields: "id,display_phone_number,verified_name,status", limit: "100" }).toString();
      const phones = await metaRequest(phonesUrl, { headers });
      const phone = (Array.isArray(phones.data) ? phones.data.map(asObject) : []).find(item => item.id === phoneNumberId);
      if (!phone) throw new OnboardingError("O número escolhido não pertence à conta WhatsApp autorizada.", 403);
      let verifyToken = randomBytes(32).toString("hex");
      if (asObject(current.data).app_secret_configured) {
        const existing = await serviceDatabase().rpc("get_whatsapp_runtime_credentials", { p_organization_id: auth.organizationId });
        const credentials = asObject(existing.data);
        if (existing.error || credentials.app_secret !== config.appSecret) throw new OnboardingError("O canal existente pertence a outro aplicativo Meta ou não pôde ser verificado. A renovação exige conferir o aplicativo para preservar o recebimento.", 409);
        if (typeof credentials.verify_token === "string") verifyToken = credentials.verify_token;
      }
      const saved = await auth.client.rpc("enterprise_connect_whatsapp", {
        p_organization_id: auth.organizationId, p_waba_id: wabaId, p_phone_number_id: phoneNumberId,
        p_graph_api_version: config.graphVersion, p_display_phone_number: String(phone.display_phone_number || phoneNumberId),
        p_access_token: token, p_app_secret: config.appSecret, p_verify_token: verifyToken,
      });
      if (saved.error) throw new OnboardingError("A autorização foi recebida, mas não foi possível salvar o canal. As ativações existentes foram preservadas.", 409);
      let webhookSubscribed = false;
      try {
        const subscription = await metaRequest(new URL(`https://graph.facebook.com/${config.graphVersion}/${wabaId}/subscribed_apps`), { method: "POST", headers, body: JSON.stringify({ override_callback_uri: `${config.origin}/api/integrations/whatsapp/webhook?organizationId=${encodeURIComponent(auth.organizationId)}`, verify_token: verifyToken }) });
        webhookSubscribed = subscription.success === true;
      } catch { /* Report saved credentials separately from provider subscription. */ }
      result = { channel: "whatsapp", authorized: true, webhookSubscribed, phoneStatus: phone.status || "UNKNOWN", runtime: saved.data,
        message: webhookSubscribed ? "Número autorizado e recebimento configurado. As ativações da Arisa e da Bia foram preservadas. Confira o estado do número antes de habilitar o atendimento." : "Credenciais salvas. A Meta ainda não confirmou o recebimento: conclua a configuração de webhook no aplicativo antes de ativar o atendimento." };
    } else {
      const short = await metaRequest(new URL("https://api.instagram.com/oauth/access_token"), { method: "POST", body: new URLSearchParams({ client_id: config.instagramAppId, client_secret: config.instagramSecret, grant_type: "authorization_code", redirect_uri: `${config.origin}/integrations/meta/callback`, code: body.code }) });
      const shortToken = typeof short.access_token === "string" ? short.access_token : "";
      if (!shortToken) throw new OnboardingError("O Instagram não forneceu uma autorização válida.", 502);
      const exchange = new URL("https://graph.instagram.com/access_token");
      exchange.search = new URLSearchParams({ grant_type: "ig_exchange_token", client_secret: config.instagramSecret, access_token: shortToken }).toString();
      const long = await metaRequest(exchange);
      const token = typeof long.access_token === "string" ? long.access_token : "";
      if (!token || typeof long.expires_in !== "number" || long.expires_in <= 0) throw new OnboardingError("Não foi possível concluir a autorização duradoura do Instagram.", 502);
      const profileUrl = new URL(`https://graph.instagram.com/${config.graphVersion}/me`);
      profileUrl.searchParams.set("fields", "user_id,username");
      const profile = await metaRequest(profileUrl, { headers: { Authorization: `Bearer ${token}` } });
      const saved = await auth.client.rpc("enterprise_connect_instagram", { p_organization_id: auth.organizationId, p_instagram_user_id: metaId(String(profile.user_id || profile.id || "")), p_username: String(profile.username || ""), p_access_token: token, p_expires_at: new Date(Date.now() + long.expires_in * 1000).toISOString() });
      if (saved.error) throw new OnboardingError("A conta foi autorizada, mas não pôde ser salva. Verifique se já pertence a outra organização.", 409);
      result = { channel: "instagram", authorized: true, account: saved.data, messagingReady: false, message: "Perfil profissional autorizado. O atendimento por Direct ainda exige a implantação do recebimento e das regras de encaminhamento. Arisa e Bia mantêm suas funções atuais." };
    }
    const response = NextResponse.json(result, { headers: onboardingHeaders });
    response.cookies.set(onboardingCookie, "", { httpOnly: true, secure: true, sameSite: "lax", path: "/api/integrations/meta", maxAge: 0 });
    return response;
  } catch (error) { return onboardingFailure(error); }
}
