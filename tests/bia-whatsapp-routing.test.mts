import assert from 'node:assert/strict';
import { test } from 'node:test';
import { biaApprovedOpening, biaApprovedTemplate, biaPersonalizedOpening, biaRecipientName, BIA_INBOUND_TEMPLATE } from '../supabase/functions/_shared/bia-whatsapp-outbound.ts';
import { processBiaWhatsApp } from '../supabase/functions/_shared/bia-whatsapp-replies.ts';

const credentials={enabled:true,waba_id:'200',phone_number_id:'300',graph_api_version:'v25.0',access_token:'test-only'};
const referral={name:'bia_indicacao_investimento',language:'pt_BR',status:'APPROVED',category:'MARKETING',components:[{type:'BODY',text:'Olá, {{1}}! Seu contato foi indicado por um cliente do Solaris.'}]};
const welcome={name:'bia_boas_vindas',language:'pt_BR',status:'APPROVED',category:'MARKETING',components:[{type:'BODY',text:'Olá! Eu sou a Bia. Como posso ajudar você hoje?'}]};

test('outreach fetches referral and sends one name parameter, preserving exactly the approved body',async()=>{
 const template=await biaApprovedOpening(credentials,(async(url:URL|string|Request)=>{
  assert.equal(new URL(String(url)).searchParams.get('name'),'bia_indicacao_investimento');return Response.json({data:[welcome,referral]});
 }) as typeof fetch);
 const result=biaPersonalizedOpening(template,'  João D’Ávila  ');
 assert.equal(result.body,'Olá, João D’Ávila! Seu contato foi indicado por um cliente do Solaris.');
 assert.deepEqual(result.components,[{type:'body',parameters:[{type:'text',text:'João D’Ávila'}]}]);
 assert.equal(biaPersonalizedOpening(template,null).body,'Olá, tudo bem! Seu contato foi indicado por um cliente do Solaris.');
 for(const name of ['{{1}}','Maria\n<script>','a'.repeat(81)]) assert.throws(()=>biaRecipientName(name));
});

test('welcome accepts no parameters and an extra or missing referral parameter prevents dispatch',async()=>{
 const fetchTemplate=(data:unknown)=>(async()=>Response.json({data:[data]})) as typeof fetch;
 assert.equal((await biaApprovedTemplate(credentials,BIA_INBOUND_TEMPLATE,fetchTemplate(welcome))).body,welcome.components[0].text);
 for(const text of ['Olá!','Olá, {{2}}','Olá, {{1}} {{1}}','Olá, {{1}} {{2}}']) {
  await assert.rejects(biaApprovedOpening(credentials,fetchTemplate({...referral,components:[{type:'BODY',text}]})),/BIA_TEMPLATE_CHANGED/);
 }
 await assert.rejects(biaApprovedTemplate(credentials,BIA_INBOUND_TEMPLATE,fetchTemplate({...welcome,components:referral.components})),/BIA_TEMPLATE_CHANGED/);
});

function scenario({first=true,allow=true,pending=false,cached=false}={}) {
 let claimed=false;const calls:string[]=[],posts:Record<string,unknown>[]=[],urls:string[]=[];
 const rpc=async(name:string,args:Record<string,unknown>)=>{
  if(name==='bia_whatsapp_credentials')return credentials;
  calls.push(String(args.p_action));
  if(args.p_action==='claim'){if(claimed)return {};claimed=true;return {id:'job',lease:'lease',organizationId:'org',phone:'5534999999999',openingTemplate:first?'bia_boas_vindas':null,message:'Olá',messageType:'text',generatedContent:cached?welcome.components[0].text:''};}
  if(args.p_action==='send')return {proceed:allow};return {ok:true};
 };
 const http=(async(url:URL|string|Request,init?:RequestInit)=>{
  urls.push(String(url));
  if(String(url).includes('/message_templates'))return Response.json({data:[{...welcome,status:pending?'PENDING':'APPROVED'},referral]});
  if(String(url).includes('/gateway'))return Response.json({ok:true,data:{reply:'Seguimos com a sua simulação.'}});
  posts.push(JSON.parse(String(init?.body)));return Response.json({messages:[{id:'wamid.mock'}]});
 }) as typeof fetch;
 return {rpc,http,calls,posts,urls,gatewayUrl:'https://example.test/gateway',publishableKey:'test-only'};
}

test('customer-initiated first message gets welcome; subsequent messages continue through the sales gateway',async()=>{
 const first=scenario();assert.equal((await processBiaWhatsApp(first)).sent,1);
 assert.equal((first.posts[0].text as Record<string,unknown>).body,welcome.components[0].text);
 assert.equal(first.urls.some(u=>u.includes('/gateway')),false);
 assert.match(first.urls[0],/name=bia_boas_vindas/);
 const next=scenario({first:false});await processBiaWhatsApp(next);
 assert.equal(next.urls.some(u=>u.includes('message_templates')),false);
 assert.equal((next.posts[0].text as Record<string,unknown>).body,'Seguimos com a sua simulação.');
});

test('pending approval, changed context and cached retry never cause an extra welcome send',async()=>{
 const pending=scenario({pending:true});await processBiaWhatsApp(pending);assert.equal(pending.posts.length,0);assert.ok(pending.calls.includes('fail'));
 const paused=scenario({allow:false});await processBiaWhatsApp(paused);assert.equal(paused.posts.length,0);
 const cached=scenario({cached:true});await processBiaWhatsApp(cached);assert.equal(cached.posts.length,1);assert.equal(cached.urls.length,1);
});
