import {createHash,createHmac} from "node:crypto";
import {createClient} from "@supabase/supabase-js";
import {type NextRequest,NextResponse} from "next/server";
import {getMetaGraphConfig} from "@/lib/integrations/meta/server-config";
import {enqueueMetaLeadDelivery} from "@/lib/integrations/meta/supabase-gateway";
import {processMetaLeadQueue} from "@/lib/integrations/meta/processor";
import type {MetaLeadNotification} from "@/lib/integrations/meta/webhook-core";

export const runtime="nodejs";
export const dynamic="force-dynamic";
export const maxDuration=60;
const META_ID=/^\d{1,64}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEADERS={"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"};

type Obj=Record<string,unknown>;
function isObj(v:unknown):v is Obj{return !!v&&typeof v==="object"&&!Array.isArray(v)}
function id(v:unknown){const s=typeof v==="string"||typeof v==="number"?String(v):"";return META_ID.test(s)?s:null}
function token(req:NextRequest){const m=/^Bearer ([^\s]{20,4096})$/i.exec(req.headers.get("authorization")||"");return m?.[1]||null}
async function authorize(req:NextRequest,organizationId:string){const access=token(req);if(!access)throw new Error("SESSION_REQUIRED");const url=process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();const key=process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();if(!url||!key)throw new Error("SERVICE_UNAVAILABLE");const s=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},global:{headers:{Authorization:`Bearer ${access}`}}});const user=await s.auth.getUser(access);if(user.error||!user.data.user)throw new Error("SESSION_EXPIRED");const permission=await s.rpc("has_app_permission",{p_organization_id:organizationId,p_permission_key:"crm.integrations.manage"});if(permission.error||permission.data!==true)throw new Error("META_PERMISSION_DENIED")}
async function graphPage(url:URL,accessToken:string,proof:string,timeout:number){url.searchParams.delete("access_token");if(proof)url.searchParams.set("appsecret_proof",proof);else url.searchParams.delete("appsecret_proof");const response=await fetch(url,{headers:{Accept:"application/json",Authorization:`Bearer ${accessToken}`},cache:"no-store",signal:AbortSignal.timeout(timeout)});const body=await response.json() as unknown;if(!response.ok||isObj(body)&&isObj(body.error))throw new Error("META_GRAPH_SYNC_FAILED");return body}
async function allData(first:URL,accessToken:string,proof:string,timeout:number,maxPages=50){const out:Obj[]=[];let next:URL|null=first;for(let page=0;next&&page<maxPages;page++){const body=await graphPage(next,accessToken,proof,timeout);if(!isObj(body)||!Array.isArray(body.data))throw new Error("META_GRAPH_SYNC_INVALID");for(const item of body.data)if(isObj(item))out.push(item);const paging=isObj(body.paging)?body.paging:null;const n=paging&&typeof paging.next==="string"?paging.next:null;next=n?new URL(n):null}return out}

export async function POST(req:NextRequest){
 try{
  const body=await req.json() as Obj;const organizationId=typeof body.organizationId==="string"?body.organizationId:"";const pageId=id(body.pageId);if(!UUID.test(organizationId)||!pageId)return NextResponse.json({ok:false,error:"INVALID_REQUEST"},{status:400,headers:HEADERS});
  await authorize(req,organizationId);
  const config=await getMetaGraphConfig(organizationId,pageId);const proof=config.appSecret?createHmac("sha256",config.appSecret).update(config.accessToken).digest("hex"):"";
  const formsUrl=new URL(`https://graph.facebook.com/${config.apiVersion}/${pageId}/leadgen_forms`);formsUrl.searchParams.set("fields","id,name,status");formsUrl.searchParams.set("limit","100");
  const forms=await allData(formsUrl,config.accessToken,proof,config.requestTimeoutMs,20);let fetched=0,queued=0,duplicates=0,unmapped=0;
  for(const form of forms){const formId=id(form.id);if(!formId)continue;const leadsUrl=new URL(`https://graph.facebook.com/${config.apiVersion}/${formId}/leads`);leadsUrl.searchParams.set("fields","id,created_time,ad_id,form_id");leadsUrl.searchParams.set("limit","100");const leads=await allData(leadsUrl,config.accessToken,proof,config.requestTimeoutMs,50);fetched+=leads.length;
   const notifications:MetaLeadNotification[]=leads.flatMap((lead,index)=>{const leadId=id(lead.id);if(!leadId)return[];const created=typeof lead.created_time==="string"&&Number.isFinite(Date.parse(lead.created_time))?Math.floor(Date.parse(lead.created_time)/1000):null;return[{eventKey:`meta:leadgen:${leadId}`,leadgenId:leadId,pageId,formId:id(lead.form_id)||formId,adId:id(lead.ad_id),createdTime:created,entryIndex:0,changeIndex:index,value:{leadgen_id:leadId,page_id:pageId,form_id:id(lead.form_id)||formId,ad_id:id(lead.ad_id),created_time:created}}]});
   for(let i=0;i<notifications.length;i+=500){const batch=notifications.slice(i,i+500);if(!batch.length)continue;const receivedAt=new Date().toISOString();const raw={source:"enterprise_historical_sync",page_id:pageId,form_id:formId,lead_ids:batch.map(x=>x.leadgenId)};const rawText=JSON.stringify(raw);const result=await enqueueMetaLeadDelivery({notifications:batch,rawBodySha256:createHash("sha256").update(rawText).digest("hex"),rawBody:raw,correlationId:`SYNC-${crypto.randomUUID()}`,receivedAt,requestHeaders:{"content-type":"application/json","user-agent":"evora-enterprise-historical-sync","x-hub-signature-256":"internal-graph-verified"}});queued+=result.insertedEvents;duplicates+=result.duplicateEvents;unmapped+=result.unmappedEvents}
  }
  const processing=await processMetaLeadQueue();
  return NextResponse.json({ok:true,formsFound:forms.length,fetched,queued,duplicates,unmapped,processing},{status:200,headers:HEADERS});
 }catch(error){const code=error instanceof Error?error.message:"META_SYNC_FAILED";const status=code.startsWith("SESSION")?401:code.includes("PERMISSION")?403:code==="INVALID_REQUEST"?400:503;console.error("Meta historical sync failed",{code});return NextResponse.json({ok:false,error:code},{status,headers:HEADERS})}
}
