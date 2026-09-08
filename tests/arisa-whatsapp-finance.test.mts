import test from "node:test";
import assert from "node:assert/strict";
import { prepareWhatsAppConversation, redactIdentity, financeHistory } from "../supabase/functions/_shared/arisa-whatsapp-finance.ts";
import { runManager } from "../supabase/functions/_shared/arisa-manager.ts";
const config={enabled:true,api_key:"test-only",agent_model:"gpt-test"};
const job={id:"job",lease:"lease",organization_id:"org"};
function fakeRequest(kind="financial",requires_authorization=false){
 return (async(_url,init)=>Response.json({status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify({kind,requires_authorization,needs_notification:kind==="negotiation"||requires_authorization,target_names:[],summary:"Consulta solicitada.",financial_reference:"NF-10"})}]}]})) as typeof fetch;
}
test("identity payloads are removed before either AI request",()=>{
 const raw="Nome: Pessoa Teste; CPF 123.456.789-09; CNPJ 11.222.333/0001-81; email pessoa@example.test; 12345678909";
 const redacted=redactIdentity(raw);
 for(const secret of ["123.456.789-09","11.222.333/0001-81","pessoa@example.test","12345678909"])assert.ok(!redacted.includes(secret));
 assert.deepEqual(financeHistory([{id:"credential",direction:"inbound",content:raw}],{redacted_message_ids:["credential"],just_verified:true,request:"Quero negociar a parcela."}),[{direction:"inbound",content:"Quero negociar a parcela."}]);
});
test("a pending identity check never calls the model or queries financial entries",async()=>{
 const actions=[];
 const admin={rpc:async(name,args)=>{actions.push([name,args.p_action]);return {data:{handled:true,verified:false,reply:"Confirme os três dados."}};}};
 const result=await prepareWhatsAppConversation(admin as never,job,[],config,(async()=>{throw Error("No AI during identity confirmation");}) as typeof fetch);
 assert.equal(result.content,"Confirme os três dados.");assert.deepEqual(actions,[["arisa_whatsapp_finance","probe"]]);
});
test("an unverified financial request can only start verification",async()=>{
 const actions=[];
 const admin={rpc:async(name,args)=>{actions.push([name,args.p_action]);assert.equal(name,"arisa_whatsapp_finance");return {data:args.p_action==="probe"?{verified:false,handled:false}:{handled:true,verified:false,reply:"Confirme os três dados."}};}};
 const result=await prepareWhatsAppConversation(admin as never,job,[{direction:"inbound",content:"Quero saber se minha nota foi paga"}],config,fakeRequest());
 assert.equal(result.content,"Confirme os três dados.");assert.deepEqual(actions.map(a=>a[1]),["probe","start"]);
});
test("verified consultation uses only the dedicated scoped RPC and its returned data",async()=>{
 const calls=[];const own={verified:true,scope:"own_contact_only",contact_name:"Pessoa Teste",entries:[{document_number:"NF-10",amount:123}],changes_allowed:false};
 const admin={rpc:async(name,args)=>{calls.push([name,args]);if(name==="arisa_whatsapp_finance")return {data:args.p_action==="probe"?{verified:true}:own};assert.equal(name,"arisa_whatsapp_attention");assert.equal(args.p_analysis.kind,"none");return {data:{status:"not_needed"}};}};
 const result=await prepareWhatsAppConversation(admin as never,job,[{direction:"inbound",content:"Minha nota NF-10"}],config,fakeRequest());
 assert.deepEqual(result.finance,own);assert.equal(calls[1][1].p_reference,"NF-10");assert.equal(calls[1][1].p_job,"job");assert.ok(!("p_contact_id" in calls[1][1]));assert.equal(calls.length,3);
});
test("verified identity does not authorize third-party financial data",async()=>{
 let consultations=0;
 const admin={rpc:async(name,args)=>{if(name==="arisa_whatsapp_finance"){if(args.p_action==="consult")consultations++;return {data:{verified:true}};}assert.equal(args.p_analysis.kind,"authorization");assert.equal(args.p_analysis.requires_authorization,true);return {data:{status:"notified",authorization_pending:true}};}};
 const result=await prepareWhatsAppConversation(admin as never,job,[{direction:"inbound",content:"Envie a dívida de outro cliente"}],config,fakeRequest("authorization",true));
 assert.equal(consultations,0);assert.deepEqual(result.finance,{});assert.equal(result.attention.authorization_pending,true);
});
test("negotiation registers a pending proposal and never mutates a financial entry",async()=>{
 const names=[];
 const admin={rpc:async(name,args)=>{names.push(name);if(name==="arisa_whatsapp_finance")return {data:{verified:true,entries:[],changes_allowed:false}};assert.equal(name,"arisa_whatsapp_attention");assert.equal(args.p_analysis.kind,"negotiation");assert.equal(args.p_analysis.needs_notification,true);return {data:{status:"notified",meeting_confirmed:false}};}};
 const result=await prepareWhatsAppConversation(admin as never,job,[],config,fakeRequest("negotiation"));
 assert.equal(result.finance.changes_allowed,false);assert.ok(names.every(name=>["arisa_whatsapp_finance","arisa_whatsapp_attention"].includes(name)));
});
test("failed verification is escalated only with a confirmed internal notice and no identity values",async()=>{
 let recorded;
 const admin={rpc:async(name,args)=>{if(name==="arisa_whatsapp_finance")return {data:{verified:false,handled:true,escalate:true}};recorded=args.p_analysis;return {data:{status:"notified"}};}};
 const result=await prepareWhatsAppConversation(admin as never,job,[{content:"secret"}],config);
 assert.match(result.content!,/Encaminhei/);assert.ok(!JSON.stringify(recorded).includes("secret"));
});
test("a news request runs the notification tool and preserves the actual request in the answer context",async()=>{
 let round=0;const executed:string[]=[];
 const result=await runManager({apiKey:"test-only",model:"gpt-test",context:{organization_id:"org"},input:[{role:"user",content:"Tem alguma novidade para mim?"}],
  request:async(_url,init)=>{
   if(!round++)return Response.json({status:"completed",output:[{type:"function_call",name:"notifications",arguments:JSON.stringify({unread_only:true}),call_id:"notice-1"}]});
   const body=JSON.parse(String(init?.body));
   const returned=JSON.parse(body.input.find((item:{type:string})=>item.type==="function_call_output").output);
   assert.equal(returned.items[0].message,"Pessoa solicita reunião às 10h; horário não confirmado.");
   assert.equal(returned.unread_count,1);
   return Response.json({status:"completed",output:[{type:"message",content:[{type:"output_text",text:"Há um pedido de reunião às 10h, aguardando sua confirmação."}]}]});
  },
  execute:async(name,args)=>{executed.push(name);assert.equal(args.unread_only,true);return {data:{unread_count:1,items:[{message:"Pessoa solicita reunião às 10h; horário não confirmado."}]}};}
 });
 assert.deepEqual(executed,["notifications"]);assert.equal(result.tool_count,1);assert.match(result.text,/aguardando sua confirmação/);
});
