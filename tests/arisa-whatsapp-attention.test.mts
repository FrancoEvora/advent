import test from "node:test";
import assert from "node:assert/strict";
import {analyzeWhatsAppAttention,processWhatsAppNotices,NOTICE_TEXT} from "../supabase/functions/_shared/arisa-whatsapp-attention.ts";
import {generateWhatsAppReply} from "../supabase/functions/_shared/arisa-whatsapp-replies.ts";
const config={enabled:true,api_key:"test-only",agent_model:"gpt-test"};
const completed=(value:unknown)=>({status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify(value)}]}]});
test("triage extracts names without access to the staff directory or privileged tools",async()=>{
 const history=[{direction:"inbound",content:"Quero uma reunião com Franco amanhã às 10h."}];
 const value={needs_notification:true,target_names:["Franco"],kind:"meeting",summary:"Pedido de reunião com Franco amanhã às 10h.",requires_authorization:false};
 const result=await analyzeWhatsAppAttention(history,config,(async(_url,init)=>{const body=JSON.parse(String(init?.body));assert.equal(body.tools,undefined);assert.equal(body.store,false);assert.equal(body.text.format.strict,true);assert.ok(!JSON.stringify(body).includes("recipient_user_id"));return Response.json(completed(value));}) as typeof fetch);
 assert.deepEqual(result.analysis,value);
});
test("invalid routing output and excessive targets fail before database notification",async()=>{
 for(const targets of [["Franco",null],["a","b","c","d"]])await assert.rejects(analyzeWhatsAppAttention([],config,(async()=>Response.json(completed({needs_notification:true,target_names:targets,kind:"meeting",summary:"Meeting",requires_authorization:false}))) as typeof fetch));
});
test("reply receives confirmed routing outcome and cannot claim an appointment was booked",async()=>{
 const facts={status:"notified",notified_names:["Franco"],authorization_pending:false,meeting_confirmed:false};
 await generateWhatsAppReply([{direction:"inbound",content:"Avise o Franco"}],config,(async(_url,init)=>{const body=JSON.parse(String(init?.body));assert.ok(body.instructions.includes(JSON.stringify(facts)));assert.match(body.instructions,/Nunca afirme que uma reunião está marcada/);return Response.json({status:"completed",output:[{type:"message",content:[{type:"output_text",text:"Avisei o Franco. Qual seria a pauta?"}]}]});}) as typeof fetch,facts);
});
test("WhatsApp notice waits for the exact approved template outside 24h and exposes no request details",async()=>{
 let claimed=false,deferred=false,posts=0;
 const admin={rpc:async(name,args)=>{
  if(name==="arisa_whatsapp_notice_worker"){
   if(args.p_action==="claim"){if(claimed)return {data:{}};claimed=true;return {data:{id:"11111111-1111-4111-8111-111111111111",organization_id:"org",actor_user_id:"actor",window_open:false,lease:"lease"}};}
   if(args.p_action==="defer"){deferred=true;return {data:{ok:true}};}throw Error("Should not send");
  }
  if(name==="arisa_whatsapp_credentials")return {data:{enabled:true,waba_id:"12345678",phone_number_id:"87654321",graph_api_version:"v26.0",access_token:"fixture"}};
  throw Error("Unexpected RPC");
 }};
 await processWhatsAppNotices(admin as never,(async(_url,init)=>{if(init?.method==="POST")posts++;return Response.json({data:[{name:"hello_world",language:"en_US",status:"APPROVED"}]});}) as typeof fetch);
 assert.equal(deferred,true);assert.equal(posts,0);assert.ok(!NOTICE_TEXT.includes("summary"));assert.match(NOTICE_TEXT,/Acesse sua conta/);
});
