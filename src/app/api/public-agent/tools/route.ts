import { NextRequest, NextResponse } from "next/server";
import { enforcePublicAgentOrigin, publicAgentCookieName, publicAgentFingerprint, PublicAgentServerError, requestBiaCustomerTool } from "@/lib/public-agent/server";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 90;
const HEADERS = { "Cache-Control": "no-store, private", "X-Content-Type-Options": "nosniff" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function POST(request: NextRequest) {
  try {
    enforcePublicAgentOrigin(request);
    if (!request.headers.get("content-type")?.startsWith("application/json")) throw new PublicAgentServerError("PUBLIC_AGENT_JSON_REQUIRED",415);
    if (Number(request.headers.get("content-length")||0)>20000) throw new PublicAgentServerError("PUBLIC_AGENT_INPUT_INVALID",413);
    const raw=await request.text();
    if (raw.length>20000) throw new PublicAgentServerError("PUBLIC_AGENT_INPUT_INVALID",413);
    const b=JSON.parse(raw);
    if (!b || typeof b!=="object" || typeof b.slug!=="string" || typeof b.conversationId!=="string" || !UUID.test(b.conversationId)
      || !["notices","notices_read","files_list","files_prepare","files_confirm","files_open","speech"].includes(b.operation)
      || !b.args || typeof b.args!=="object" || Array.isArray(b.args)) throw new PublicAgentServerError("PUBLIC_AGENT_INPUT_INVALID",400);
    const token=request.cookies.get(publicAgentCookieName(b.slug))?.value;
    if (!token) throw new PublicAgentServerError("PUBLIC_AGENT_SESSION_NOT_FOUND",401);
    const response=await requestBiaCustomerTool({slug:b.slug,token,fingerprint:publicAgentFingerprint(request),conversationId:b.conversationId,operation:b.operation,args:b.args,signal:request.signal});
    return new Response(response.body,{status:response.status,headers:{...HEADERS,"Content-Type":response.headers.get("content-type")||"application/json"}});
  } catch(error) {
    return NextResponse.json({ok:false,error:error instanceof PublicAgentServerError?error.code:error instanceof SyntaxError?"PUBLIC_AGENT_INPUT_INVALID":"PUBLIC_AGENT_TOOL_UNAVAILABLE"},
      {status:error instanceof PublicAgentServerError?error.status:error instanceof SyntaxError?400:503,headers:HEADERS});
  }
}
