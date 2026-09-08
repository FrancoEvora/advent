import assert from 'node:assert/strict';
import { test } from 'node:test';
import { handleWhatsAppWebhook } from '../supabase/functions/_shared/arisa-whatsapp-webhook.ts';
import { biaOutboundText, processBiaWhatsApp } from '../supabase/functions/_shared/bia-whatsapp-replies.ts';

const org='11111111-1111-4111-8111-111111111111';
const runtime={organization_id:org,enabled:true,waba_id:'200',phone_number_id:'300',app_secret:'test-signing-secret',verify_token:'verify-bia'};
const payload=(phone='300')=>({object:'whatsapp_business_account',entry:[{id:'200',changes:[{field:'messages',value:{metadata:{phone_number_id:phone},contacts:[{wa_id:'5534999999999',profile:{name:'Teste'}}],messages:[{id:'wamid.test',from:'5534999999999',timestamp:'1788897600',type:'text',text:{body:'Olá'}}]}}]}]});
async function signed(value:unknown,secret=runtime.app_secret){
  const raw=JSON.stringify(value),key=await crypto.subtle.importKey('raw',new TextEncoder().encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  const digest=new Uint8Array(await crypto.subtle.sign('HMAC',key,new TextEncoder().encode(raw)));
  return new Request(`https://example.test/webhook?organizationId=${org}`,{method:'POST',headers:{'x-hub-signature-256':'sha256='+Array.from(digest,b=>b.toString(16).padStart(2,'0')).join(''),'content-type':'application/json'},body:raw});
}
test('Bia validates the signature and routes only to the commercial receiver',async()=>{
  const calls:string[]=[];
  const response=await handleWhatsAppWebhook(await signed(payload()),async name=>{calls.push(name);return name==='bia_whatsapp_credentials'?runtime:{handled_message_ids:['wamid.test'],handled_status_ids:[]};},'bia');
  assert.equal(response.status,200);assert.deepEqual(calls,['bia_whatsapp_credentials','bia_whatsapp_webhook']);
  assert.equal((await response.json()).bia_inbound,1);
});
test('Bia rejects an Arisa number and a forged signature without ingestion',async()=>{
  for(const request of [await signed(payload('301')),await signed(payload(),'forged')]){
    const calls:string[]=[];const response=await handleWhatsAppWebhook(request,async name=>{calls.push(name);return runtime;},'bia');
    assert.ok([401,403].includes(response.status));assert.deepEqual(calls,['bia_whatsapp_credentials']);
  }
});
test('Bia webhook verification uses its own secret and its own status record',async()=>{
  const calls:string[]=[];
  const response=await handleWhatsAppWebhook(new Request(`https://example.test/?organizationId=${org}&hub.mode=subscribe&hub.verify_token=verify-bia&hub.challenge=hello`),async name=>{calls.push(name);return runtime;},'bia');
  assert.equal(await response.text(),'hello');assert.deepEqual(calls,['bia_whatsapp_credentials','bia_whatsapp_verify_webhook']);
});
test('sales attachments keep HTTPS links and never exceed the WhatsApp text limit',()=>{
  const result=biaOutboundText({reply:'Segue o material.',attachments:[{url:'javascript:alert(1)',title:'bad'},{url:'https://example.com/planta.pdf',title:'Planta'}]});
  assert.equal(result,'Segue o material.\n\nPlanta: https://example.com/planta.pdf');
  assert.throws(()=>biaOutboundText({reply:'a'.repeat(4097)}));
});
function workerScenario({allow=true,failSend=false,cached=false}={}){
  let claimed=false;const actions:string[]=[],requests:{url:string;body:Record<string,unknown>}[]=[];
  const job={id:'22222222-2222-4222-8222-222222222222',lease:'33333333-3333-4333-8333-333333333333',organizationId:org,slug:'solaris',tokenHash:'a'.repeat(64),fingerprintHash:'b'.repeat(64),phone:'5534999999999',message:'Olá',messageType:'text',generatedContent:cached?'Resposta já preparada':''};
  const rpc=async(name:string,args:Record<string,unknown>)=>{
    if(name==='bia_whatsapp_credentials')return {enabled:true,access_token:'test-only',phone_number_id:'300',graph_api_version:'v25.0'};
    assert.equal(name,'bia_whatsapp_reply_worker');actions.push(String(args.p_action));
    if(args.p_action==='claim'){if(claimed)return {};claimed=true;return job;}
    if(args.p_action==='send')return {proceed:allow};return {ok:true};
  };
  const http=(async(url:URL|string|Request,init?:RequestInit)=>{
    const target=String(url);requests.push({url:target,body:JSON.parse(String(init?.body))});
    if(target.includes('gateway'))return Response.json({ok:true,data:{reply:'Olá! Sou a Bia. Como posso ajudar?'}});
    if(failSend)throw new Error('network lost');
    return Response.json({messages:[{id:'wamid.accepted'}]});
  }) as typeof fetch;
  return {rpc,http,actions,requests};
}
test('worker generates a sales turn and sends only after the database rechecks the window',async()=>{
  const s=workerScenario();assert.equal((await processBiaWhatsApp({...s,gatewayUrl:'https://example.test/gateway',publishableKey:'test-only'})).sent,1);
  assert.deepEqual(s.actions,['claim','send','finish','claim']);assert.equal(s.requests[1].body.to,'5534999999999');assert.equal(s.requests[1].body.biz_opaque_callback_data,'22222222-2222-4222-8222-222222222222');
});
test('a pause or expired window prevents the send; cached turns do not execute the model twice',async()=>{
  const s=workerScenario({allow:false,cached:true});assert.equal((await processBiaWhatsApp({...s,gatewayUrl:'https://example.test/gateway',publishableKey:'test-only'})).sent,0);
  assert.equal(s.requests.length,0);assert.deepEqual(s.actions,['claim','send','claim']);
});
test('uncertain Meta responses are recorded for reconciliation without repeating the send',async()=>{
  const s=workerScenario({failSend:true});await processBiaWhatsApp({...s,gatewayUrl:'https://example.test/gateway',publishableKey:'test-only'});
  assert.deepEqual(s.actions,['claim','send','fail','claim']);assert.equal(s.requests.filter(r=>r.url.includes('graph.facebook.com')).length,1);
});
