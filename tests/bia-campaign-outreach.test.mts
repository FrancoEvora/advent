import assert from "node:assert/strict";
import { test } from "node:test";
import { processBiaCampaignOutreach } from "../supabase/functions/_shared/bia-campaign-outreach.ts";

type Obj = Record<string, unknown>;
const job = { id:"11111111-1111-4111-8111-111111111111", lease:"22222222-2222-4222-8222-222222222222", organization_id:"33333333-3333-4333-8333-333333333333", phone:"5534999990101", recipient_name:"Maria", template_name:"bia_plano_safra_2026" };
function scenario(mode = "success", proceed = true, approval = "APPROVED") {
  const calls: { action:string; args:Obj }[] = [], posts: Obj[] = [];
  let claimed = false;
  const rpc = async (name:string,args:Obj) => {
    if(name==="bia_whatsapp_credentials")return {enabled:true,waba_id:"200",phone_number_id:"300",graph_api_version:"v25.0",access_token:"secret"};
    const action=String(args.p_action), data=args.p_args as Obj; calls.push({action,args:data});
    if(action==="claim"){if(claimed)return {};claimed=true;return job;}
    assert.equal(data.lease,job.lease);assert.equal(data.id,job.id);
    if(action==="start")return {proceed};
    if(action==="finish" && mode==="finish-fails")throw Error("connection interrupted");
    return {ok:true};
  };
  const http=(async (_url: unknown,init?:RequestInit)=>{
    if(!init?.body)return Response.json({data:[{name:job.template_name,language:"pt_BR",status:approval,category:"MARKETING",components:[{type:"BODY",text:"Olá, {{1}}! Vamos conversar sobre o Plano Safra?"}]}]});
    posts.push(JSON.parse(String(init.body)));
    if(mode==="timeout")throw Error("timeout");
    if(mode==="payment")return Response.json({error:{code:131042}},{status:400});
    if(mode==="server")return Response.json({error:{code:500}},{status:500});
    return Response.json({messages:[{id:"wamid.test"}],contacts:[{wa_id:job.phone}]});
  }) as typeof fetch;
  return {rpc,http,calls,posts};
}
test("campaign uses its approved opening, CRM name, stable operation and database lease",async()=>{
 const s=scenario();assert.deepEqual(await processBiaCampaignOutreach(s.rpc,s.http),{processed:1,deferred:0});
 assert.equal(s.posts.length,1);
 assert.equal((s.posts[0].template as Obj).name,job.template_name);
 assert.equal(s.posts[0].biz_opaque_callback_data,job.id);
 assert.equal(s.posts[0].to,job.phone);
 assert.match(String(s.calls.find(c=>c.action==="start")?.args.body),/Olá, Maria!/);
 assert.equal(s.calls.find(c=>c.action==="finish")?.args.status,"accepted");
});
test("no Graph send before Meta approval",async()=>{
 const s=scenario("success",true,"PENDING");await processBiaCampaignOutreach(s.rpc,s.http);
 assert.equal(s.posts.length,0);assert.ok(!s.calls.some(c=>c.action==="start"));
 assert.equal(s.calls.find(c=>c.action==="defer")?.args.error,"BIA_TEMPLATE_NOT_APPROVED");
});
test("duplicate or revoked reservation cannot send",async()=>{
 const s=scenario("success",false);await processBiaCampaignOutreach(s.rpc,s.http);
 assert.equal(s.posts.length,0);assert.ok(!s.calls.some(c=>c.action==="finish"));
});
for(const mode of ["timeout","server","payment","finish-fails"])test("uncertain and rejected sends are never retried: "+mode,async()=>{
 const s=scenario(mode);await processBiaCampaignOutreach(s.rpc,s.http);
 assert.equal(s.posts.length,1);assert.ok(!s.calls.some(c=>c.action==="defer"));
 assert.equal(s.calls.find(c=>c.action==="finish")?.args.status,mode==="payment"?"failed":mode==="finish-fails"?"accepted":"unknown");
});

