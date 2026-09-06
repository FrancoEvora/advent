import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import { isObject, ManagerError, UUID, type Obj } from "../_shared/arisa-manager.ts";
import { WHATSAPP_ERRORS } from "../_shared/arisa-whatsapp.ts";
import { runWhatsAppTool } from "../_shared/arisa-whatsapp-runtime.ts";

const HEADERS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization, apikey, content-type, x-client-info","access-control-allow-methods":"POST, OPTIONS","cache-control":"no-store","content-type":"application/json; charset=utf-8","x-content-type-options":"nosniff"};
const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:HEADERS});
const key=(name:string)=>{try{const value=JSON.parse(Deno.env.get(name)||"{}");return isObject(value)&&typeof value.default==="string"?value.default:"";}catch{return "";}};
export async function handleWhatsApp(request:Request):Promise<Response>{
  if(request.method==="OPTIONS")return new Response(null,{status:204,headers:HEADERS});if(request.method!=="POST")return json({ok:false,error:"METHOD_NOT_ALLOWED"},405);
  const reference=crypto.randomUUID();
  try{
    const authorization=request.headers.get("authorization")||"";if(!/^Bearer \S+$/i.test(authorization)||authorization.length>9000)throw new ManagerError("SESSION_REQUIRED",401);
    const raw=await request.text();if(raw.length>50000)throw new ManagerError("WHATSAPP_INVALID",413);let body:unknown;try{body=JSON.parse(raw);}catch{throw new ManagerError("WHATSAPP_INVALID",400);}
    if(!isObject(body)||typeof body.organizationId!=="string"||!UUID.test(body.organizationId)||typeof body.action!=="string"||!["status","templates","send","get","reconcile","list","configure"].includes(body.action))throw new ManagerError("WHATSAPP_INVALID",400);
    const url=Deno.env.get("SUPABASE_URL")||"",publicKey=key("SUPABASE_PUBLISHABLE_KEYS")||Deno.env.get("SUPABASE_ANON_KEY")||"",serviceKey=key("SUPABASE_SECRET_KEYS")||Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"";if(!url||!publicKey||!serviceKey)throw new ManagerError("WHATSAPP_UNAVAILABLE",503);
    const caller=createClient(url,publicKey,{global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false}});const auth=await caller.auth.getUser();if(auth.error||!auth.data.user)throw new ManagerError("SESSION_EXPIRED",401);const actor=auth.data.user.id;
    const allowed=await caller.rpc("arisa_admin_catalog",{p_organization_id:body.organizationId});if(allowed.error)throw new ManagerError("ADMIN_REQUIRED",403);
    const admin=createClient(url,serviceKey,{auth:{persistSession:false,autoRefreshToken:false}});const args=isObject(body.args)?body.args:{};
    let context:undefined|{requestId:string};if(body.action==="send"){if(typeof body.requestId!=="string"||!UUID.test(body.requestId))throw new ManagerError("WHATSAPP_INVALID",422);context={requestId:body.requestId};}
    const result=await runWhatsAppTool(admin,body.organizationId,actor,body.action,args,context);return json(body.action==="reconcile"?{...result,outcome_confirmed:result.ok===true,ok:true}:{ok:true,...result});
  }catch(error){const code=error instanceof ManagerError?error.code:"WHATSAPP_UNAVAILABLE",status=error instanceof ManagerError?error.status:503;console.error("Arisa WhatsApp",{reference,code,status});return json({ok:false,error:code,message:WHATSAPP_ERRORS[code]||"Não foi possível concluir a operação do WhatsApp.",supportReference:reference},status);}
}
Deno.serve(handleWhatsApp);

