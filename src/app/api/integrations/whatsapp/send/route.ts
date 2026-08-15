import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";

import { parseMetaCredentialBearer } from "@/lib/integrations/meta/credential-contract";
import { getWhatsAppCredentialsByOrganization, sendWhatsAppText, serviceDatabase, WhatsAppServerError } from "@/lib/integrations/whatsapp/server";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=30;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEADERS={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
type Obj=Record<string,unknown>;
class ApiError extends Error{constructor(readonly code:string,readonly status:number){super(code);}}
const object=(v:unknown):v is Obj=>v!==null&&typeof v==="object"&&!Array.isArray(v);
function config(){const url=process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();const key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();if(!url||!key)throw new ApiError("SUPABASE_PUBLIC_UNAVAILABLE",503);return{url,key};}
function sameOrigin(req:NextRequest){const site=req.headers.get("sec-fetch-site");if(site&&site!=="same-origin"&&site!=="none")throw new ApiError("CROSS_ORIGIN_REJECTED",403);}
async function actor(req:NextRequest,organizationId:string){const token=parseMetaCredentialBearer(req.headers.get("authorization"));if(!token)throw new ApiError("SESSION_REQUIRED",401);const{url,key}=config();const user=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{headers:{Authorization:`Bearer ${token}`}}});const session=await user.auth.getUser(token);if(session.error||!session.data.user)throw new ApiError("SESSION_EXPIRED",401);const permission=await user.rpc("has_app_permission",{p_organization_id:organizationId,p_permission_key:"crm.copilot.approve_send"});if(permission.error||permission.data!==true)throw new ApiError("COPILOT_APPROVAL_PERMISSION_REQUIRED",403);return session.data.user.id;}

export async function POST(req:NextRequest){let organizationId="",messageId="";try{sameOrigin(req);if(!req.headers.get("content-type")?.toLowerCase().startsWith("application/json"))throw new ApiError("JSON_REQUIRED",415);const body=await req.json().catch(()=>null);if(!object(body))throw new ApiError("INVALID_REQUEST",400);organizationId=typeof body.organizationId==="string"&&UUID.test(body.organizationId)?body.organizationId:"";messageId=typeof body.messageId==="string"&&UUID.test(body.messageId)?body.messageId:"";if(!organizationId||!messageId)throw new ApiError("INVALID_IDENTIFIERS",400);const userId=await actor(req,organizationId);
    const runtime=await getWhatsAppCredentialsByOrganization(organizationId);if(!runtime)throw new ApiError("WHATSAPP_RUNTIME_NOT_READY",409);
    const claim=await serviceDatabase().rpc("claim_whatsapp_prepared_message",{p_organization_id:organizationId,p_message_id:messageId,p_actor_user_id:userId});if(claim.error)throw new ApiError(claim.error.code==="42501"?"WHATSAPP_SEND_FORBIDDEN":"WHATSAPP_SEND_NOT_PREPARED",claim.error.code==="42501"?403:409);const claimed=claim.data;if(!object(claimed))throw new ApiError("WHATSAPP_SEND_CLAIM_INVALID",503);if(claimed.already_sent===true&&typeof claimed.provider_message_id==="string")return NextResponse.json({ok:true,idempotent:true,providerMessageId:claimed.provider_message_id},{headers:HEADERS});if(claimed.claimed!==true||typeof claimed.to_phone!=="string"||typeof claimed.content!=="string")throw new ApiError("WHATSAPP_SEND_CLAIM_INVALID",503);
    try{
      const sent=await sendWhatsAppText({runtime,to:claimed.to_phone,text:claimed.content});
      const marked=await serviceDatabase().rpc("mark_whatsapp_message_sent",{p_organization_id:organizationId,p_message_id:messageId,p_provider_message_id:sent.providerMessageId,p_actor_user_id:userId});if(marked.error)throw new ApiError("WHATSAPP_SEND_AUDIT_FAILED",503);
      return NextResponse.json({ok:true,idempotent:false,providerMessageId:sent.providerMessageId},{headers:HEADERS});
    }catch(error){const code=error instanceof WhatsAppServerError?error.code:error instanceof ApiError?error.code:"WHATSAPP_SEND_FAILED";await serviceDatabase().rpc("release_whatsapp_send_claim",{p_organization_id:organizationId,p_message_id:messageId,p_error_code:code}).catch(()=>null);throw error;}
  }catch(error){if(!(error instanceof ApiError)&&!(error instanceof WhatsAppServerError))console.error("Supervised WhatsApp send failed",{errorName:error instanceof Error?error.name:"UnknownError"});const status=error instanceof ApiError?error.status:error instanceof WhatsAppServerError?error.status:503;const code=error instanceof ApiError||error instanceof WhatsAppServerError?error.code:"WHATSAPP_SEND_UNAVAILABLE";return NextResponse.json({ok:false,error:code},{status,headers:HEADERS});}}
