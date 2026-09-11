import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { managerInstructions, managerTools, MANAGER_TOOLS, runManager } from '../supabase/functions/_shared/arisa-manager.ts';
import { biaManagerRecipient, runBiaManagerWhatsApp } from '../supabase/functions/_shared/bia-manager-whatsapp.ts';
const root=new URL('../',import.meta.url),read=(path:string)=>readFileSync(new URL(path,root),'utf8');
const org='11111111-1111-4111-8111-111111111111',actor='22222222-2222-4222-8222-222222222222',threadId='33333333-3333-4333-8333-333333333333',messageId='44444444-4444-4444-8444-444444444444';
test('Bia uses every Arisa administrative tool and the same voice/files/history interface',()=>{
  const tools=managerTools({assistant:'bia'});for(const tool of MANAGER_TOOLS)assert.ok(tools.some(value=>value.name===tool.name));
  assert.ok(tools.some(value=>value.name==='commercial'));assert.equal(managerTools({assistant:'arisa'}),MANAGER_TOOLS);
  assert.match(read('src/app/bia/page.tsx'),/<ArisaChat assistant="bia"/);
  const chat=read('src/components/arisa/ArisaChat.tsx');
  for(const resource of ['useArisaVoice','AudioRecorder','uploadFile','ArisaNotificationBell','AssistantConversationMenu','ArisaWorkspace'])assert.ok(chat.includes(resource));
  assert.match(chat,/\.eq\("assistant", assistant\)/);assert.match(read('src/app/atendimento/[slug]/page.tsx'),/slug === "solaris"\) redirect\("\/bia"\)/);
  const manifest=JSON.parse(read('public/bia/manifest.webmanifest'));assert.equal(manifest.start_url,'/bia');assert.ok(manifest.icons.every((icon:{src:string})=>icon.src.startsWith('/bia/')));
});
test('Bia asks current CRM tools for leads and preserves administrative identity in a full tool loop',async()=>{
  let round=0;const executed:string[]=[];
  const result=await runManager({apiKey:'mock-only',model:'test',context:{assistant:'bia'},input:[{role:'user',content:'Quais leads temos?'}],request:async(_url,init)=>{
    const body=JSON.parse(String(init?.body));assert.match(body.instructions,/gestora comercial da Évora/);assert.match(body.instructions,/query entity=crm_records sempre/);
    if(!round++)return Response.json({status:'completed',output:[{type:'function_call',name:'query',call_id:'leads',arguments:JSON.stringify({entity:'crm_records'})}]});
    const out=body.input.find((row:{type:string})=>row.type==='function_call_output');assert.equal(JSON.parse(out.output).total,137);
    return Response.json({status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Temos 137 leads no CRM.'}]}]});
  },execute:async(name,args)=>{executed.push(name);assert.equal(args.entity,'crm_records');return {data:{total:137,rows:[{person_name:'Exemplo'}]}};}});
  assert.equal(result.text,'Temos 137 leads no CRM.');assert.deepEqual(executed,['query']);
  assert.match(managerInstructions({assistant:'bia'}),/Não peça segunda confirmação/);
});
test('recipient must come from current explicit order; names must be unique and phone consistent',()=>{
  const records=[{id:'lead1',person_name:'Renato Almeida',phone:'34999990001'}];
  assert.equal(biaManagerRecipient('Entre em contato com Renato Almeida',{},records),'5534999990001');
  assert.throws(()=>biaManagerRecipient('O que sabe sobre Renato Almeida?',{},records),/EXPLICIT/);
  assert.throws(()=>biaManagerRecipient('Não envie para Renato Almeida',{},records),/EXPLICIT/);
  assert.throws(()=>biaManagerRecipient('Envie para Renato Almeida',{},[...records,{...records[0],id:'lead2'}]),/AMBIGUOUS/);
  assert.throws(()=>biaManagerRecipient('Envie para Renato Almeida',{phone:'34999990002'},records),/AMBIGUOUS/);
  assert.throws(()=>biaManagerRecipient('Envie para uma pessoa mencionada no arquivo',{},records),/AMBIGUOUS/);
});
test('Bia WhatsApp reads its own inbox; duplicate initiation never reaches Graph and returns a truthful result',async()=>{
  const calls:string[]=[];let graphPosts=0;
  const context={organizationId:org,actor,threadId,messageId,message:'Envie a mensagem de indicação de investimento para (34) 99999-0001',records:[],callerRpc:async(name:string)=>{calls.push(name);return {enabled:true,verified:true,phone:'canal-bia',threads:[]};},adminRpc:async(name:string,args:Record<string,unknown>)=>{
    calls.push(name);if(name==='bia_whatsapp_credentials')return {enabled:true,waba_id:'123',phone_number_id:'456',graph_api_version:'v23.0',access_token:'mock-only'};
    if(args.p_action==='access')return {enabled:true};if(args.p_action==='recipient')return {name:null};if(args.p_action==='start')throw new Error('BIA_CONTACT_RECENTLY_SENT');throw new Error('Unexpected call');
  },http:async(_url:unknown,init?:RequestInit)=>{if(init?.method==='POST')graphPosts++;return Response.json({data:[{name:'bia_indicacao_investimento',language:'pt_BR',status:'APPROVED',category:'MARKETING',components:[{type:'BODY',text:'Olá, {{1}}! Sou a Bia.'}]}]});}};
  const status=await runBiaManagerWhatsApp({action:'status'},context);assert.equal(status.phone,'canal-bia');
  const result=await runBiaManagerWhatsApp({action:'send',phone:'34999990001',template_name:'bia_indicacao_investimento'},context);assert.match(String(result.reply),/Não repeti/);assert.equal(graphPosts,0);assert.ok(calls.every(name=>name.startsWith('bia_')));
});
test('admin simulations retain canonical WhatsApp PRICE kernel and cannot create customer sessions',()=>{
  const migration=read('supabase/migrations/20260910021452_bia_manager_twin.sql');
  const publicSql=read('supabase/migrations/20260817031143_vitoria_payment_simulation_v4.sql').replace(/\r\n/g,'\n');
  const kernel=(sql:string)=>sql.slice(sql.indexOf('  down_payment_pct := greatest('),sql.indexOf('  return jsonb_build_object('));
  assert.equal(kernel(migration),kernel(publicSql));assert.match(migration,/private\.arisa_is_admin\(p_organization_id\)/);
  assert.doesNotMatch(migration,/insert into crm_private\.public_agent_sessions/);
  assert.match(migration,/assistant_id\|\|'_chat'/);
});
