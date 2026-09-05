import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import { isObject, ManagerError, UUID, type Obj } from "../_shared/arisa-manager.ts";
import { extractMemories, type ArchiveEvent } from "../_shared/arisa-memory.ts";
import { syncArisaMail } from "../_shared/arisa-mail-runtime.ts";

const HEADERS={"access-control-allow-origin":"*","access-control-allow-headers":"authorization,apikey,content-type,x-client-info,x-arisa-worker-secret","access-control-allow-methods":"POST,OPTIONS","cache-control":"no-store","content-type":"application/json"};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:HEADERS});
const envKey=(name:string)=>{try{const v=JSON.parse(Deno.env.get(name)||"{}");return typeof v.default==="string"?v.default:"";}catch{return "";}};
async function constantEqual(a:string,b:string){if(!a||!b)return false;const digest=async(v:string)=>new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v)));const [x,y]=await Promise.all([digest(a),digest(b)]);return x.reduce((n,v,i)=>n|(v^y[i]),0)===0;}

export async function handleBackground(request:Request){
  if(request.method==="OPTIONS")return new Response(null,{status:204,headers:HEADERS});
  if(request.method!=="POST")return json({ok:false},405);
  const reference=crypto.randomUUID(),deadline=Date.now()+145000;
  try{
    const url=Deno.env.get("SUPABASE_URL")||"",service=envKey("SUPABASE_SECRET_KEYS")||Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||"",publicKey=envKey("SUPABASE_PUBLISHABLE_KEYS")||Deno.env.get("SUPABASE_ANON_KEY")||"";
    const admin=createClient(url,service,{auth:{persistSession:false,autoRefreshToken:false}});
    let org:string|null=null,cron=false;
    const secret=request.headers.get("x-arisa-worker-secret")||"";
    if(secret){const expected=await admin.rpc("arisa_background_secret");cron=!expected.error&&typeof expected.data==="string"&&await constantEqual(secret,expected.data);if(!cron)return json({ok:false},401);}
    else{
      const authorization=request.headers.get("authorization")||"";if(!/^Bearer \S+$/.test(authorization))return json({ok:false},401);
      const raw=await request.text();if(raw.length>4096)return json({ok:false},400);
      let body:unknown;try{body=JSON.parse(raw);}catch{return json({ok:false},400);}
      if(!isObject(body)||typeof body.organizationId!=="string"||!UUID.test(body.organizationId))return json({ok:false},400);
      org=body.organizationId;
      const caller=createClient(url,publicKey,{global:{headers:{Authorization:authorization}},auth:{persistSession:false,autoRefreshToken:false}});
      const auth=await caller.auth.getUser();if(auth.error||!auth.data.user)return json({ok:false},401);
      const access=await caller.rpc("arisa_admin_catalog",{p_organization_id:org});if(access.error)return json({ok:false},403);
    }
    let mail:Obj={};
    if(cron){
      const settings=await admin.from("arisa_mail_settings").select("organization_id").eq("enabled",true).order("last_sync_at",{ascending:true,nullsFirst:true}).limit(1);
      if(settings.error)throw new ManagerError("BACKGROUND_QUEUE_UNAVAILABLE");
      if(settings.data?.[0])mail=await syncArisaMail(admin,settings.data[0].organization_id,Math.min(deadline-55000,Date.now()+80000)).catch(error=>({error:error instanceof ManagerError?error.code:"MAIL_SYNC_UNAVAILABLE"}));
    }
    let processed=0,failed=0;
    while(processed+failed<(cron?8:2)&&Date.now()<deadline-55000){
      const claimed=await admin.rpc("arisa_memory_worker",{p_action:"claim",p_args:org?{organization_id:org}:{}});
      if(claimed.error)throw new ManagerError("MEMORY_QUEUE_UNAVAILABLE");
      if(!isObject(claimed.data)||!isObject(claimed.data.event))break;
      const event=claimed.data.event as unknown as ArchiveEvent,lease=claimed.data.lease;
      try{
        const config=await admin.rpc("get_crm_ai_runtime_credentials",{p_organization_id:event.organization_id});
        if(config.error||!isObject(config.data)||config.data.enabled!==true||typeof config.data.api_key!=="string")throw new ManagerError("MEMORY_AI_NOT_CONFIGURED");
        const result=await extractMemories(event,config.data);
        const saved=await admin.rpc("arisa_memory_worker",{p_action:"finish",p_args:{event_id:event.id,lease,...result}});
        if(saved.error)throw new ManagerError("MEMORY_SAVE_FAILED");processed++;
      }catch(error){
        failed++;await admin.rpc("arisa_memory_worker",{p_action:"fail",p_args:{event_id:event.id,lease,error:error instanceof ManagerError?error.code:"MEMORY_PROCESSING_FAILED"}});
      }
    }
    return json({ok:true,processed,failed,mail});
  }catch(error){const code=error instanceof ManagerError?error.code:"BACKGROUND_UNAVAILABLE";console.error("arisa-background",{code,reference});return json({ok:false,error:code,supportReference:reference},503);}
}
Deno.serve(handleBackground);
