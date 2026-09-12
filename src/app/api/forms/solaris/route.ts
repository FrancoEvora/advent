import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { getSupabaseIntegrationConfig } from "@/lib/integrations/meta/server-config";
import { validateSolarisSubmission } from "@/lib/forms/solaris";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const reply = (body: unknown, status = 200) => Response.json(body, {status, headers: {"Cache-Control":"no-store", "X-Content-Type-Options":"nosniff"}});

export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) return reply({error:"Origem inválida."},403);
  if (!request.headers.get("content-type")?.includes("application/json")) return reply({error:"Formato inválido."},415);
  if (Number(request.headers.get("content-length") || 0) > 8192) return reply({error:"Dados muito longos."},413);
  let data;
  try {
    const raw = await request.text();
    if (raw.length > 8192) return reply({error:"Dados muito longos."},413);
    data = validateSolarisSubmission(JSON.parse(raw));
  } catch { return reply({error:"Dados inválidos."},400); }
  if (!data) return reply({error:"Confira seu nome, WhatsApp, opções e autorização de contato."},400);
  try {
    const config = getSupabaseIntegrationConfig();
    const db = createClient(config.url,config.serviceRoleKey,{auth:{persistSession:false,autoRefreshToken:false},global:{fetch:(input,init)=>fetch(input,{...init,signal:AbortSignal.timeout(15000)})}});
    const address = (request.headers.get("x-vercel-forwarded-for") || request.headers.get("x-real-ip") || request.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim().slice(0,128);
    const fingerprint = createHash("sha256").update(`solaris-form:${Math.floor(Date.now()/3600000)}:${address}`).digest("hex");
    const {data: result,error} = await db.rpc("submit_solaris_public_form",{p_submission:data,p_fingerprint:fingerprint});
    if (error) {
      if (error.message.includes("FORM_RATE_LIMIT")) return reply({error:"Muitas tentativas. Aguarde um pouco e tente novamente."},429);
      if (error.message.includes("FORM_ID_CONFLICT")) return reply({error:"Este envio já foi registrado com outros dados. Reabra o formulário para um novo cadastro."},409);
      console.error("Solaris form persistence failed",{code:error.code});
      return reply({error:"Não foi possível registrar agora. Seus dados continuam preenchidos. Tente novamente."},503);
    }
    if (!result || result.id !== data.requestId) throw new Error("Invalid receipt");
    return reply({id:result.id},result.duplicate ? 200 : 201);
  } catch {
    console.error("Solaris form service unavailable");
    return reply({error:"Não foi possível registrar agora. Seus dados continuam preenchidos. Tente novamente."},503);
  }
}
