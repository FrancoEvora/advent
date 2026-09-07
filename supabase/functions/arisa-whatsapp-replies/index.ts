import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import { processWhatsAppReplies } from "../_shared/arisa-whatsapp-replies.ts";

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {status, headers:{"content-type":"application/json","cache-control":"no-store"}});
function serviceKey() { try { const keys=JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")||"{}"); if(typeof keys.default==="string")return keys.default; } catch { /* Legacy projects use the single key. */ } return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")||""; }
async function equal(a: string, b: string) { const digest=async(v:string)=>new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(v))); const [x,y]=await Promise.all([digest(a),digest(b)]); return x.reduce((n,v,i)=>n|(v^y[i]),0)===0; }
Deno.serve(async request => {
  if(request.method!=="POST")return json({ok:false},405);
  const supplied=request.headers.get("x-arisa-worker-secret")||"";
  if(!supplied || supplied.length>512)return json({ok:false},401);
  const admin=createClient(Deno.env.get("SUPABASE_URL")||"",serviceKey(),{auth:{persistSession:false,autoRefreshToken:false}});
  const expected=await admin.rpc("arisa_background_secret");
  if(expected.error || typeof expected.data!=="string" || !expected.data || !await equal(supplied,expected.data))return json({ok:false},401);
  try { return json({ok:true,...await processWhatsAppReplies(admin)}); }
  catch { return json({ok:false,error:"WHATSAPP_REPLY_WORKER_UNAVAILABLE"},503); }
});
