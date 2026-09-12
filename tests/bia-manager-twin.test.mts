import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { managerInstructions, managerTools, MANAGER_TOOLS, runManager } from '../supabase/functions/_shared/arisa-manager.ts';
import { biaManagerOutreach, biaManagerRecipient, runBiaManagerWhatsApp } from '../supabase/functions/_shared/bia-manager-whatsapp.ts';
import { biaChatOperationId } from '../supabase/functions/enterprise-bia-agent-gateway/whatsapp-operator.ts';
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
const jaquelines = [
  {id:'jaq1',person_name:'Jaqueline',phone:'34999991159'},
  {id:'jaq2',person_name:'Jaqueline Hillebrand',phone:'34999990685'},
];
const originalOrder = 'Bia. Inicie contato com a Jaqueline cadastrada em nosso sistema e venda um lote para ela. Via WhatsApp.';
const clarificationId = '66666666-6666-4666-8666-666666666666';
const orderHistory = [{id:messageId,role:'user',content:originalOrder},
  {id:'reply1',role:'assistant',content:'Encontrei duas Jaquelines, finais 1159 e 0685. Qual delas?'}];

test('recipient clarification and renewed authorization keep the original order and operation ID',()=>{
  const resolved=biaManagerOutreach(clarificationId,'Final 1159',jaquelines,orderHistory);
  assert.equal(resolved.messageId,messageId);assert.equal(resolved.message,originalOrder);
  assert.equal(biaManagerRecipient(resolved.message,{},jaquelines,resolved.clarifications),'5534999991159');
  const resumed=biaManagerOutreach('new-message','Você tem a autorização',jaquelines,[...orderHistory,
    {id:clarificationId,role:'user',content:'Final 1159'},
    {id:'reply2',role:'assistant',content:'Autorização explícita necessária.'}]);
  assert.equal(resumed.messageId,messageId);
  assert.equal(biaManagerRecipient(resumed.message,{},jaquelines,resumed.clarifications),'5534999991159');
  for(const choice of ['Jaqueline Hillebrand','(34) 99999-0685']) {
    const named=biaManagerOutreach(clarificationId,choice,jaquelines,orderHistory);
    assert.equal(biaManagerRecipient(named.message,{},jaquelines,named.clarifications),'5534999990685');
  }
});

test('a clarification cannot change the authorized recipient, bypass ambiguity, or revive a canceled/unrelated order',()=>{
  const order=biaManagerOutreach(clarificationId,'Final 1159',jaquelines,orderHistory);
  for(const args of [{phone:'34999990685'},{contact_id:'jaq2'}]) {
    assert.throws(()=>biaManagerRecipient(order.message,args,jaquelines,order.clarifications),/AMBIGUOUS/);
  }
  assert.throws(()=>biaManagerRecipient(order.message,{},[...jaquelines,{...jaquelines[0],id:'another'}],order.clarifications),/AMBIGUOUS/);
  assert.throws(()=>biaManagerRecipient(order.message,{},jaquelines,['34999990000']),/AMBIGUOUS/);
  const records=[...jaquelines,{id:'r1',person_name:'Renato Almeida',phone:'34999990000'}];
  assert.throws(()=>biaManagerRecipient(originalOrder,{},records,['Renato Almeida']),/AMBIGUOUS/);
  assert.throws(()=>biaManagerRecipient('Envie para Renato Almeida',{},[...records,{id:'r2',person_name:'Renato Silva',phone:'34999990001'}],['34999990001']),/AMBIGUOUS/);
  for(const content of ['Não envie para Jaqueline','Cancele o envio','Quais leads temos?','Como enviar para Jaqueline?']) {
    assert.throws(()=>biaManagerOutreach(clarificationId,'Você tem a autorização',jaquelines,[...orderHistory,{id:'barrier',role:'user',content}]),/EXPLICIT/);
  }
  assert.throws(()=>biaManagerOutreach(clarificationId,'Final 1159',jaquelines,[]),/EXPLICIT/);
  assert.throws(()=>biaManagerOutreach(clarificationId,'Final 1159',jaquelines,[{id:'assistant',role:'assistant',content:originalOrder}]),/EXPLICIT/);
});

test('actual sales wording, phone suffix variants and retry sequence preserve authorization',()=>{
  const sales='Venda um lote para a Jaqueline. Via WhatsApp. O final do telefone é o 1159.';
  const direct=biaManagerOutreach(messageId,sales,jaquelines);
  assert.equal(biaManagerRecipient(direct.message,{},jaquelines),'5534999991159');
  for(const suffix of ['O final do telefone é o 1159','Telefone final 1159','Final do número 1159','Termina em 1159']) {
    const order=biaManagerOutreach(clarificationId,suffix,jaquelines,orderHistory);
    assert.equal(biaManagerRecipient(order.message,{},jaquelines,order.clarifications),'5534999991159');
  }
  const history=[...orderHistory];
  const turns=['Final 1159','Você tem a autorização','Tente novamente','+55 34 99999-1159 Tente este número','Tente novamente','Tente agora',
    'Bia, tente de novo, por favor','Continue o envio','Repita agora','Tente novamente'];
  for(const [index,content] of turns.entries()) {
    const order=biaManagerOutreach('retry-'+index,content,jaquelines,history);
    assert.equal(order.messageId,messageId);assert.equal(biaManagerRecipient(order.message,{},jaquelines,order.clarifications),'5534999991159');
    history.push({id:'retry-'+index,role:'user',content});
  }
  for(const message of ['Não venda para Jaqueline via WhatsApp','Como vender para Jaqueline via WhatsApp?','Simule uma venda para Jaqueline pelo WhatsApp',
    'Tente novamente','Tente agora','+55 34 99999-1159 Tente este número']) {
    assert.throws(()=>biaManagerOutreach(messageId,message,jaquelines),/EXPLICIT/);
  }
  assert.throws(()=>biaManagerRecipient('Venda para Jaqueline via WhatsApp, final 1159 ou final 0685',{},jaquelines),/AMBIGUOUS/);
  assert.throws(()=>biaManagerOutreach(messageId,'Tente novamente',jaquelines,[...orderHistory,{id:'stop',role:'user',content:'Cancele o envio'}]),/EXPLICIT/);
});

test('addressed commercial orders use the customer channel without requiring a magic channel word',()=>{
  const records=[{id:'lead1',person_name:'Renato',phone:'11999990001'}];
  for(const message of ['Bia. Apresente o Solaris para 11999990001 Renato.','Apresente o Solaris para Renato.',
    'Venda um lote para Renato','Ofereça um lote ao Renato','Quero que você apresente o Solaris para Renato']) {
    const order=biaManagerOutreach(messageId,message,records);
    assert.equal(biaManagerRecipient(order.message,{},records),'5511999990001');
  }
  for(const message of ['Apresente o Solaris','Apresente o Solaris para um interessado',
    'Como apresentar o Solaris para 11999990001 Renato?','Não apresente o Solaris para Renato',
    'Simule uma apresentação para Renato','Apresente um rascunho para Renato',
    'Apresente o Solaris para Renato por e-mail','Envie um e-mail para Renato',
    'Apresente o Solaris para Renato por SMS']) {
    assert.throws(()=>biaManagerOutreach(messageId,message,records),/EXPLICIT/);
  }
  assert.throws(()=>biaManagerRecipient('Apresente o Solaris para Renato',{phone:'11999990002'},records),/AMBIGUOUS/);
});

test('a corrected invalid phone keeps the original authorization and id without authorizing another recipient',()=>{
  const records=[{id:'lead1',person_name:'Renato',phone:'11999990001'}];
  const original='Bia. Apresente o Solaris para 11999990001 Renato.';
  const history=[{id:messageId,role:'user',content:original}];
  for(const [index,content] of ['119999990001','119999990001','11999990001','Tente novamente'].entries()) {
    const order=biaManagerOutreach('step-'+index,content,records,history);
    assert.equal(order.messageId,messageId);
    if(index<2)assert.throws(()=>biaManagerRecipient(order.message,{},records,order.clarifications),/PHONE_INVALID/);
    else assert.equal(biaManagerRecipient(order.message,{},records,order.clarifications),'5511999990001');
    history.push({id:'step-'+index,role:'user',content});
  }
  const invalidHistory=history.slice(0,3);
  const retry=biaManagerOutreach('retry','Tente novamente',records,invalidHistory);
  assert.throws(()=>biaManagerRecipient(retry.message,{},records,retry.clarifications),/PHONE_INVALID/);
  const changed=biaManagerOutreach('changed','11999990002',records,invalidHistory);
  assert.throws(()=>biaManagerRecipient(changed.message,{},records,changed.clarifications),/AMBIGUOUS/);
  for(const content of ['Cancele o envio','Quais leads temos?']) {
    assert.throws(()=>biaManagerOutreach('retry','11999990001',records,[...invalidHistory,{id:'barrier',role:'user',content}]),/EXPLICIT/);
  }
  assert.throws(()=>biaManagerOutreach('retry','11999990001',records,[]),/EXPLICIT/);
});

test('explicit phone remains authoritative with duplicate CRM cards and a stale model contact ID',()=>{
  const records=[{id:'r1',person_name:'Renato',phone:'11999990001'},
    {id:'r2',person_name:'Renato Almeida',phone:'+5511999990001'}];
  const message='Bia. Apresente o Solaris para 11999990001 Renato.';
  const args={contact_id:'nonexistent-model-id',phone:'+5511999990001'};
  assert.equal(biaManagerRecipient(message,args,records),'5511999990001');
  assert.equal(biaManagerRecipient(message,args,[],['119999990001','11999990001']),'5511999990001');
  assert.throws(()=>biaManagerRecipient(message,{...args,phone:'11999990002'},records),/AMBIGUOUS/);
  assert.throws(()=>biaManagerRecipient('Apresente o Solaris para Renato',args,records),/AMBIGUOUS/);
});

test('clarified Bia outreach rechecks the live CRM and sends template 1 once across subsequent authorizations',async()=>{
  let graphPosts=0,lookups=0;const reserved=new Set<string>();const ids:string[]=[];
  const context={organizationId:org,actor,threadId,messageId:clarificationId,message:'Final 1159',records:jaquelines,history:orderHistory,
    callerRpc:async(name:string,args:Record<string,unknown>)=>{
      assert.equal(name,'arisa_admin_query');assert.equal(args.p_organization_id,org);
      assert.deepEqual(args.p_filters,[{column:'person_name',operator:'contains',value:'Jaqueline'}]);lookups++;
      return {total:2,rows:jaquelines};
    },
    adminRpc:async(name:string,args:Record<string,unknown>)=>{
      if(name==='bia_whatsapp_credentials')return {enabled:true,waba_id:'123',phone_number_id:'456',graph_api_version:'v23.0',access_token:'mock-only'};
      const data=args.p_args as Record<string,unknown>;
      if(args.p_action==='access')return {enabled:true};
      if(args.p_action==='recipient'){assert.equal(data.phone,'5534999991159');return {name:'Jaqueline'};}
      if(args.p_action==='start'){
        const id=String(data.id);ids.push(id);assert.equal(data.template,'bia_indicacao_investimento');assert.equal(data.consent,true);
        if(reserved.has(id))return {proceed:false,status:'accepted'};reserved.add(id);return {proceed:true};
      }
      if(args.p_action==='finish')return {status:data.status,provider_message_id:data.providerMessageId};
      throw new Error('Unexpected RPC');
    },
    http:async(_url:unknown,init?:RequestInit)=>{
      if(init?.method==='POST'){
        graphPosts++;const body=JSON.parse(String(init.body));assert.equal(body.to,'5534999991159');
        assert.equal(body.template.name,'bia_indicacao_investimento');assert.equal(body.template.components[0].parameters[0].text,'Jaqueline');
        return Response.json({messages:[{id:'mock-wa-message'}]});
      }
      return Response.json({data:[{name:'bia_indicacao_investimento',language:'pt_BR',status:'APPROVED',category:'MARKETING',components:[{type:'BODY',text:'Olá, {{1}}! Sou a Bia.'}]}]});
    }};
  const args={action:'send',contact_id:'jaq1',template_name:'bia_indicacao_investimento'};
  const first=await runBiaManagerWhatsApp(args,context);assert.equal(first.status,'accepted');
  const retry=await runBiaManagerWhatsApp(args,{...context,messageId:'77777777-7777-4777-8777-777777777777',message:'Você tem a autorização',
    history:[...orderHistory,{id:clarificationId,role:'user',content:'Final 1159'}]});
  assert.equal(retry.status,'accepted');assert.equal(graphPosts,1);assert.equal(lookups,2);
  const expected=await biaChatOperationId(threadId,messageId);assert.deepEqual(ids,[expected,expected]);
  await assert.rejects(()=>runBiaManagerWhatsApp(args,{...context,callerRpc:async()=>({total:1,rows:[{...jaquelines[0],phone:'34999991160'}]})}),/AMBIGUOUS/);
  // Even if a model returned only one match, the server detects a second live homonym.
  await assert.rejects(()=>runBiaManagerWhatsApp({action:'send'}, {...context,messageId,message:originalOrder,records:[jaquelines[0]],history:[]}),/AMBIGUOUS/);
  await assert.rejects(()=>runBiaManagerWhatsApp(args,{...context,callerRpc:async()=>({total:201,rows:jaquelines})}),/AMBIGUOUS/);
  assert.equal(graphPosts,1);
});

test('admin simulations retain canonical WhatsApp PRICE kernel and cannot create customer sessions',()=>{
  const migration=read('supabase/migrations/20260910021452_bia_manager_twin.sql');
  const publicSql=read('supabase/migrations/20260817031143_vitoria_payment_simulation_v4.sql').replace(/\r\n/g,'\n');
  const kernel=(sql:string)=>sql.slice(sql.indexOf('  down_payment_pct := greatest('),sql.indexOf('  return jsonb_build_object('));
  assert.equal(kernel(migration),kernel(publicSql));assert.match(migration,/private\.arisa_is_admin\(p_organization_id\)/);
  assert.doesNotMatch(migration,/insert into crm_private\.public_agent_sessions/);
  assert.match(migration,/assistant_id\|\|'_chat'/);
});
