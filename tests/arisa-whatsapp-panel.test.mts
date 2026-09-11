import test from 'node:test';
import assert from 'node:assert/strict';
import { arisaOutbound } from '../supabase/functions/_shared/arisa-whatsapp-outbound.ts';
const org='11111111-1111-4111-8111-111111111111', actor='22222222-2222-4222-8222-222222222222', id='33333333-3333-4333-8333-333333333333', opId='44444444-4444-4444-8444-444444444444', thread='55555555-5555-4555-8555-555555555555';
const phone='5534999998888', greeting='Olá. Aqui é a Arisa, da Évora Urbanismo. Pode conversar comigo neste momento?';
function fixture(ambiguous=false) {
  let op: Record<string,unknown> | null=null; const calls:string[]=[], posts:unknown[]=[];
  const admin={rpc:async(name:string,params:Record<string,unknown>)=>{
    if(name==='arisa_whatsapp_credentials')return {data:{enabled:true,waba_id:'12345678',phone_number_id:'87654321',graph_api_version:'v26.0',access_token:'test-only'}};
    assert.equal(name,'arisa_whatsapp_service');const action=String(params.p_action),args=params.p_args as Record<string,unknown>;calls.push(action);
    if(action==='request_status')return {data:op||{}};
    if(action==='status')return {data:{ready:true,legacy_crm_enabled:false,display_phone_number:'+55 34 9986-2027'}};
    if(action==='resolve')return {data:{phone,contact_id:null}};
    if(action==='prepare'){op={...args,id:opId,thread_id:thread,phone,phone_number_id:'87654321',send_mode:'template',status:'prepared',proceed:true};return {data:op};}
    if(action==='claim'){op={...op,status:'queued',proceed:true};return {data:op};}
    if(action==='finish'){op={...op,status:'completed',delivery_status:'accepted'};return {data:{ok:true,accepted_by_meta:true,operation_id:opId}};}
    if(action==='fail'){op={...op,status:args.status,delivery_status:args.status,error_code:args.error};return {data:{ok:true}};}
    throw Error('Unexpected action '+action);
  }};
  const request:typeof fetch=async(url,init)=>{
    if(String(url).includes('message_templates'))return Response.json({data:[{name:'arisa',language:'pt_BR',status:'APPROVED',components:[{type:'BODY',text:greeting}]}]});
    assert.equal(init?.method,'POST');posts.push(JSON.parse(String(init?.body)));if(ambiguous)throw Error('Connection lost');return Response.json({messages:[{id:'wamid.panel.accepted'}]});
  };
  return {admin:admin as never,request,posts,calls,op:()=>op};
}
test('preview reads the approved Portuguese Arisa opening without sending',async()=>{
  const f=fixture();const p=await arisaOutbound(f.admin,org,actor,'preview',{},f.request);
  assert.equal(p.body,greeting);assert.equal(p.language,'pt_BR');assert.equal(p.name,'arisa');assert.equal(f.posts.length,0);
});
test('start requires consent and a matching preview before preparing a send',async()=>{
  const f=fixture();await assert.rejects(arisaOutbound(f.admin,org,actor,'send',{id,phone},f.request),/WHATSAPP_CONSENT_REQUIRED/);
  await assert.rejects(arisaOutbound(f.admin,org,actor,'send',{id,phone,consent:true,hash:'changed'},f.request),/WHATSAPP_TEMPLATE_CHANGED/);
  assert.equal(f.posts.length,0);assert.ok(!f.calls.includes('prepare'));
});
test('start persists request identity, sends on Arisa and returns the actual conversation for opening its history',async()=>{
  const f=fixture();const preview=await arisaOutbound(f.admin,org,actor,'preview',{},f.request);
  const input={id,phone:'34999998888',recipientName:'Contato',consent:true,hash:preview.hash};
  const result=await arisaOutbound(f.admin,org,actor,'send',input,f.request);
  assert.equal(result.id,id);assert.equal(result.threadId,thread);assert.equal(result.status,'accepted');assert.equal(f.op()?.request_id,id);
  assert.equal(f.posts.length,1);assert.equal((f.posts[0] as Record<string,unknown>).to,phone);
  await arisaOutbound(f.admin,org,actor,'send',input,f.request);await arisaOutbound(f.admin,org,actor,'status',{id},f.request);
  assert.equal(f.posts.length,1);
});
test('uncertain sends are reconciled after reopening and never retried automatically',async()=>{
  const f=fixture(true);const p=await arisaOutbound(f.admin,org,actor,'preview',{},f.request);const input={id,phone,consent:true,hash:p.hash};
  const result=await arisaOutbound(f.admin,org,actor,'send',input,f.request);assert.equal(result.status,'unknown');
  assert.equal((await arisaOutbound(f.admin,org,actor,'status',{id},f.request)).status,'unknown');
  await arisaOutbound(f.admin,org,actor,'send',input,f.request);assert.equal(f.posts.length,1);
});
test('own number and changed recipient cannot trigger a new send under the same request',async()=>{
  const f=fixture();await assert.rejects(arisaOutbound(f.admin,org,actor,'send',{id,phone:'34999862027',consent:true},f.request),/WHATSAPP_SELF_RECIPIENT/);
  const p=await arisaOutbound(f.admin,org,actor,'preview',{},f.request);await arisaOutbound(f.admin,org,actor,'send',{id,phone,consent:true,hash:p.hash},f.request);
  await assert.rejects(arisaOutbound(f.admin,org,actor,'send',{id,phone:'5534999997777',consent:true,hash:p.hash},f.request),/WHATSAPP_REQUEST_CHANGED/);assert.equal(f.posts.length,1);
});
