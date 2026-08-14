import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { type NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const META_ID=/^\d{1,64}$/;
const VERSION=/^v\d{1,3}\.\d{1,2}$/;
const HEADERS={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff","Referrer-Policy":"no-referrer"};
type Obj=Record<string,unknown>;
class ApiError extends Error { constructor(readonly code:string,readonly status:number){super(code);} }

function publicConfig(){const url=process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();const key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();if(!url||!key)throw new ApiError("WHATSAPP_SERVICE_UNAVAILABLE",503);return{url,key};}
function bearer(req:NextRequest){const m=/^Bearer\s+([^\s]+)$/i.exec(req.headers.get("authorization")||"");if(!m)throw new ApiError("SESSION_REQUIRED",401);return m[1];}
async function db(req:NextRequest):Promise<SupabaseClient>{const token=bearer(req),{url,key}=publicConfig();const client=createClient(url,key,{auth:{autoRefreshToken:false,detectSessionInUrl:false,persistSession:false},global:{headers:{Authorization:`Bearer ${token}`}}});const{data,error}=await client.auth.getUser(token);if(error||!data.user)throw new ApiError("SESSION_EXPIRED",401);return client;}
function org(value:unknown){if(typeof value!=="string"||!UUID.test(value))throw new ApiError("INVALID_ORGANIZATION",400);return value;}
function optionalText(body:Obj,key:string,max:number){const v=body[key];if(v===undefined||v===null||v==="")return null;if(typeof v!=="string"||v.trim()!==v||v.length>max)throw new ApiError("INVALID_WHATSAPP_VALUE",400);return v;}
function secret(body:Obj,key:string,min:number,max:number){const v=optionalText(body,key,max);if(v===null)return null;if(v.length<min||/\s/.test(v))throw new ApiError("INVALID_WHATSAPP_SECRET",400);return v;}
async function body(req:NextRequest){if(!req.headers.get("content-type")?.toLowerCase().startsWith("application/json"))throw new ApiError("UNSUPPORTED_CONTENT_TYPE",415);const parsed=await req.json().catch(()=>null);if(!parsed||typeof parsed!=="object"||Array.isArray(parsed))throw new ApiError("INVALID_REQUEST",400);return parsed as Obj;}
function sameOrigin(req:NextRequest){const s=req.headers.get("sec-fetch-site");if(s&&s!=="same-origin"&&s!=="none")throw new ApiError("CROSS_SITE_REQUEST_REJECTED",403);}
function fail(error:unknown){if(error instanceof ApiError)return NextResponse.json({ok:false,error:error.code},{status:error.status,headers:HEADERS});const code=error&&typeof error==="object"&&"code" in error?String((error as {code:unknown}).code):"";return NextResponse.json({ok:false,error:code==="42501"?"WHATSAPP_PERMISSION_DENIED":"WHATSAPP_CONFIG_FAILED"},{status:code==="42501"?403:409,headers:HEADERS});}

export async function GET(req:NextRequest){try{const organizationId=org(req.nextUrl.searchParams.get("organizationId"));const client=await db(req);const{data,error}=await client.rpc("get_whatsapp_runtime_status",{p_organization_id:organizationId});if(error)throw error;return NextResponse.json({ok:true,runtime:data},{headers:HEADERS});}catch(error){return fail(error);}}

export async function PUT(req:NextRequest){try{sameOrigin(req);const b=await body(req);const organizationId=org(b.organizationId);const wabaId=optionalText(b,"wabaId",64);const phoneNumberId=optionalText(b,"phoneNumberId",64);const graphApiVersion=optionalText(b,"graphApiVersion",16);if(wabaId&&!META_ID.test(wabaId))throw new ApiError("INVALID_WABA_ID",400);if(phoneNumberId&&!META_ID.test(phoneNumberId))throw new ApiError("INVALID_PHONE_NUMBER_ID",400);if(graphApiVersion&&!VERSION.test(graphApiVersion))throw new ApiError("INVALID_GRAPH_API_VERSION",400);const mode=b.mode===undefined?null:String(b.mode);if(mode&&!new Set(["supervised","autonomous_replies"]).has(mode))throw new ApiError("INVALID_WHATSAPP_MODE",400);const enabled=typeof b.enabled==="boolean"?b.enabled:null;const client=await db(req);const{data,error}=await client.rpc("configure_whatsapp_runtime",{p_organization_id:organizationId,p_waba_id:wabaId,p_phone_number_id:phoneNumberId,p_graph_api_version:graphApiVersion,p_display_phone_number:optionalText(b,"displayPhoneNumber",40),p_access_token:secret(b,"accessToken",32,8192),p_app_secret:secret(b,"appSecret",24,512),p_verify_token:secret(b,"verifyToken",24,512),p_enabled:enabled,p_mode:mode});if(error)throw error;return NextResponse.json({ok:true,runtime:data},{headers:HEADERS});}catch(error){return fail(error);}}
