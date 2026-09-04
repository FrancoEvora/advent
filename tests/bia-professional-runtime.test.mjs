import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import test from 'node:test';

const source = (await readFile('supabase/functions/enterprise-bia-agent-gateway/index.ts', 'utf8'))
  .replace(/import \{ createClient \} from "npm:@supabase\/supabase-js@2";/, 'const createClient = () => { throw new Error("Real database disabled in tests"); };')
  .replace('Deno.serve(createHandler());', '');
const runtime = await import('data:text/javascript;base64,' + Buffer.from(stripTypeScriptTypes(source, { mode: 'transform' })).toString('base64'));
const KEY='test-publishable-'+'x'.repeat(40);
const UUID='b94ed5c3-92c8-4a46-bbb9-931fa4b731d9';
const TOKEN='a'.repeat(64), FINGERPRINT='b'.repeat(64);
const NOW=Date.parse('2026-09-04T12:00:00Z');
const simulation={unitCode:'SOL-C-04',area:360,price:450000,downPayment:45000,downPaymentPct:0.1,downPaymentInstallments:1,downPaymentInstallmentAmount:45000,monthlyInterestRate:0.0033,indexer:'IPCA',balloonCount:0,balloonAmount:0,scenarios:[{months:100,monthlyPayment:4761.56},{months:150,monthlyPayment:3427.52}]};
const commercial={realTime:true,project:{name:'Solaris'},summary:{availableCount:2},policy:{minimumDownPaymentPct:0.1,maximumInstallments:150},units:[{unit_code:'SOL-C-04',area:360,list_price:450000,price_per_sqm:1250}]};
const call=(name,args,id='call_'+name)=>({type:'function_call',id:'fc_unstored',name,arguments:JSON.stringify(args),call_id:id});
const answer=text=>({status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text}]}]});
function fixture({replies=[answer('Olá!')],rpcOverrides={},vectorStoreId=null}={}) {
  const calls=[],requests=[];let replyIndex=0;
  const gateway={sessionId:'s',organizationId:'org-test',stage:'discovery',profile:{},contactCapture:{},serviceConsented:false,marketingConsented:false,converted:false};
  const defaults={
    claim_public_agent_request_v4:()=>({state:'claimed',leaseToken:UUID}),
    get_bia_turn_context_v1:()=>({context:{organizationId:'org-test',stage:'welcome',profile:{},experience:{name:'Solaris Residencial Resort'},messages:[],knowledge:{approvedFacts:['Lotes a partir de 360 m².'],guardrails:[]}},gateway:{...gateway},now:new Date(NOW).toISOString()}),
    get_crm_ai_runtime_credentials:()=>({enabled:true,mode:'autonomous',api_key:'test-openai-secret-never-leak-'+'x'.repeat(32),agent_model:'configured-model',agent_reasoning:'low',knowledge_vector_store_id:vectorStoreId}),
    get_public_agent_commercial_context:()=>commercial,
    calculate_public_agent_payment_simulation_v4:()=>simulation,
    get_public_agent_gateway_context_v1:()=>({...gateway}),
    update_public_agent_contact_capture_v3:a=>{Object.assign(gateway,{contactCapture:a.p_patch,serviceConsented:true});return {...gateway};},
    sync_bia_contact_lead_v1:()=>{gateway.converted=!!gateway.contactCapture.phone&&!!gateway.contactCapture.name;gateway.leadProtocol=gateway.converted?'TEST-LEAD':null;return {...gateway};},
    schedule_bia_visit_v2:a=>({scheduled:true,id:'test-visit',scheduledAt:a.p_scheduled_at,calendarActivityId:'test-calendar'}),
    finish_bia_turn_v1:a=>a.p_response,
    fail_public_agent_request_v4:()=>({status:'failed'}),
    record_bia_openai_diagnostic:()=>({ok:true}),
  };
  const admin={rpc:async(name,args)=>{calls.push({name,args});let result=(rpcOverrides[name]||defaults[name]);assert.ok(result,'Unexpected RPC: '+name);let data=await result(args,gateway);return data?.__error?{data:null,error:data.__error}:{data,error:null};}};
  const fetcher=async(url,init)=>{requests.push({url:String(url),body:JSON.parse(init.body),headers:init.headers});const value=replies[replyIndex++];assert.notEqual(value,undefined,'Unexpected provider call');if(value instanceof Error)throw value;if(typeof value==='function')return await value(requests.at(-1));return new Response(JSON.stringify(value),{status:200,headers:{'content-type':'application/json','x-request-id':'req_test'}});};
  const handler=runtime.createHandler({env:name=>({SUPABASE_URL:'https://example.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'not-real',SUPABASE_PUBLISHABLE_KEYS:JSON.stringify({default:KEY})})[name],fetcher,makeClient:()=>admin,now:()=>NOW});
  const send=async(message='Bom dia',extra={},headers={})=>{
    const response=await handler(new Request('https://example.supabase.co/functions/v1/test',{method:'POST',headers:{'content-type':'application/json',apikey:KEY,...headers},body:JSON.stringify({action:'message',slug:'solaris',tokenHash:TOKEN,fingerprintHash:FINGERPRINT,clientMessageId:UUID,source:'text',message,...extra})}));
    return {status:response.status,body:await response.json()};
  };
  return {send,calls,requests,gateway};
}

test('normalização preserva DDD 55 e rejeita números incompletos',()=>{
  assert.equal(runtime.normalizePhone('(55) 99999-0000'),'+5555999990000');
  assert.equal(runtime.normalizePhone('+55 (34) 99999-0000'),'+5534999990000');
  assert.equal(runtime.normalizePhone('123'),null);
});
test('contato precisa estar efetivamente nas mensagens do cliente',()=>{
  assert.deepEqual(runtime.safeContactPatch({name:'João',phone:'(34) 99999-0000',city:'Campinas'},['Meu nome é João, meu WhatsApp é 34 99999-0000.']),{name:'João',phone:'+5534999990000'});
  assert.deepEqual(runtime.safeContactPatch({name:'Inventado',phone:'34999990000'},['Bom dia']),{});
});
test('texto limpo não exibe markdown nem ultrapassa contrato de persistência',()=>{
  assert.equal(runtime.cleanReply('## Valores\n- **R$ 450.000**\n\n`IPCA`'),'Valores\n• R$ 450.000\n\nIPCA');
  assert.ok(runtime.cleanReply('Uma frase completa. '.repeat(200)).length<=1200);
});
test('todos os blocos de texto da resposta são reunidos',()=>{
  assert.equal(runtime.outputText({output:[{type:'message',content:[{type:'output_text',text:'Primeira parte.'},{type:'output_text',text:'Segunda parte.'}]}]}),'Primeira parte.\n\nSegunda parte.');
});
test('cada chamada recebe output, inclusive ferramenta malformada ou com falha',async()=>{
  const calls=runtime.toolCalls({output:[call('one',{},'one'),{type:'function_call',name:'bad',arguments:'{',call_id:'bad'},call('fails',{},'fails')]});
  let executed=0;const out=await runtime.executeAllCalls(calls,async c=>{executed++;if(c.name==='fails')throw new Error('unavailable');return {ok:true};});
  assert.equal(executed,2);assert.deepEqual(out.map(o=>o.call_id),['one','bad','fails']);
  assert.equal(JSON.parse(out[1].output).error,'INVALID_TOOL_ARGUMENTS');
  assert.equal(JSON.parse(out[2].output).error,'TOOL_EXECUTION_FAILED');
});
test('continuidade stateless preserva raciocínio cifrado e não reenvia IDs de file_search',()=>{
  const out=runtime.replayOutput({output:[{type:'file_search_call',id:'fs_unstored'}, {type:'reasoning',id:'rs_unstored',encrypted_content:'encrypted',summary:[]},call('consultar_estoque',{},'call-a')]});
  assert.equal(out.length,2);assert.equal(out[0].encrypted_content,'encrypted');assert.equal(out[1].call_id,'call-a');assert.ok(!JSON.stringify(out).includes('unstored'));
});
test('requisição sem autenticação falha antes de acessar ERP ou modelo',async()=>{
  const f=fixture();const res=await f.send('Oi',{}, {apikey:''});assert.equal(res.status,401);assert.equal(f.calls.length,0);assert.equal(f.requests.length,0);
});
test('contrato de 800 caracteres é validado antes do consumo da API',async()=>{
  const f=fixture();assert.equal((await f.send('x'.repeat(801))).status,400);assert.equal(f.calls.length,0);
});
test('reenvio concluído usa resultado salvo sem consumir modelo nem repetir ferramenta',async()=>{
  const f=fixture({rpcOverrides:{claim_public_agent_request_v4:()=>({state:'succeeded',response:{status:'completed',reply:'Já respondido.'}})}});
  const res=await f.send();assert.equal(res.status,200);assert.equal(res.body.data.reply,'Já respondido.');assert.equal(f.calls.length,1);assert.equal(f.requests.length,0);
});
test('requisição em andamento retorna 202 sem nova geração',async()=>{
  const f=fixture({rpcOverrides:{claim_public_agent_request_v4:()=>({state:'inProgress'})}});assert.equal((await f.send()).status,202);assert.equal(f.requests.length,0);
});
test('saudação mantém IA-first, identidade aprovada, relógio e captura posterior',async()=>{
  const f=fixture();assert.equal((await f.send()).status,200);
  const input=JSON.stringify(f.requests[0].body.input);assert.match(input,/Para o seu melhor atendimento/);assert.match(input,/America\/Sao_Paulo/);assert.match(input,/Futura Casa/);
  assert.equal(f.requests[0].body.model,'configured-model');assert.equal(f.requests[0].body.reasoning.effort,'low');assert.equal(f.requests[0].body.store,false);
  assert.equal(f.calls.some(c=>c.name==='get_public_agent_commercial_context'),false);
});
test('estoque e simulação podem ser consultados no mesmo turno',async()=>{
  const f=fixture({replies:[{status:'completed',output:[call('consultar_estoque',{unit_code:null,area_min:null,area_max:null,budget_max:null},'a'),call('simular_pagamento',{unit_code:null,objective:'lowest_monthly_payment'},'b')]},answer('Com entrada de 10%, a parcela calculada em 150 meses é R$ 3.427,52, mais IPCA.')]});
  const res=await f.send('Veja a menor parcela.');assert.equal(res.status,200);assert.equal(res.body.data.simulation.unitCode,'SOL-C-04');assert.equal(res.body.data.metadata.tool_calls,2);
  assert.deepEqual(f.requests[1].body.input.filter(x=>x.type==='function_call_output').map(x=>x.call_id),['a','b']);
  assert.equal(f.calls.filter(c=>c.name==='calculate_public_agent_payment_simulation_v4').length,1);
});
test('falha de uma ferramenta não deixa calls sem resposta',async()=>{
  const f=fixture({replies:[{output:[call('consultar_estoque',{},'a'),call('buscar_materiais',{query:'natureza'},'b')]},answer('Não consegui confirmar o estoque agora; posso explicar o conceito.')],rpcOverrides:{get_public_agent_commercial_context:()=>({__error:{code:'XX000',message:'db error containing private values'}})}});
  const res=await f.send('Estoque e conceito?');assert.equal(res.status,200);assert.equal(f.requests[1].body.input.filter(x=>x.type==='function_call_output').length,2);assert.ok(!JSON.stringify(res).includes('private values'));
});
test('contato e visita no mesmo turno usam o cadastro recém-salvo',async()=>{
  const message='Sou João, WhatsApp 34999990000. Quero agendar visita amanhã às 10h.';
  const f=fixture({replies:[{output:[call('registrar_contato',{name:'João',phone:'34999990000',email:null,city:null}),call('agendar_visita',{requested_when:'2026-09-05T10:00:00-03:00',unit_code:null,customer_confirmation:'Quero agendar visita amanhã às 10h.'})]},answer('Sua visita foi agendada para amanhã, às 10h.')]});
  const res=await f.send(message);assert.equal(res.status,200);assert.equal(res.body.data.converted,true);assert.equal(res.body.data.serviceConsented,true);assert.equal(res.body.data.marketingConsented,false);assert.equal(res.body.data.visit.calendarActivityId,'test-calendar');
  assert.equal(res.body.data.contactCapture.name,'João');assert.ok(f.calls.findIndex(c=>c.name==='sync_bia_contact_lead_v1')<f.calls.findIndex(c=>c.name==='schedule_bia_visit_v2'));
});
test('data ambígua ou ausência de confirmação não cria agendamento',async()=>{
  const f=fixture({replies:[{output:[call('agendar_visita',{requested_when:'amanhã',unit_code:null,customer_confirmation:'Quero visitar'})]},answer('Qual dia e horário você prefere?')]});
  const res=await f.send('Quero visitar');assert.equal(res.status,200);assert.equal(f.calls.some(c=>c.name==='schedule_bia_visit_v2'),false);
});
test('quota do provedor não é atribuída ao excesso de mensagens do cliente',async()=>{
  const f=fixture({replies:[()=>new Response(JSON.stringify({error:{code:'insufficient_quota',type:'insufficient_quota',message:'sensitive details'}}),{status:429})]});
  const res=await f.send();assert.equal(res.status,503);assert.equal(res.body.error,'BIA_PROVIDER_QUOTA');assert.equal(f.calls.some(c=>c.name==='fail_public_agent_request_v4'),true);assert.ok(!JSON.stringify(res).includes('sensitive details'));
});
test('limite local real continua classificado separadamente como 429',async()=>{
  const f=fixture({rpcOverrides:{claim_public_agent_request_v4:()=>({__error:{code:'P0001',message:'PUBLIC_AGENT_RATE_LIMIT'}})}});const res=await f.send();assert.equal(res.status,429);assert.equal(res.body.error,'PUBLIC_AGENT_RATE_LIMIT');assert.equal(f.requests.length,0);
});
test('resultado financeiro já calculado não é perdido se geração final falhar',async()=>{
  const f=fixture({replies:[{output:[call('simular_pagamento',{objective:'lowest_monthly_payment'})]},new Error('network')]});
  const res=await f.send('Simule a menor parcela.');assert.equal(res.status,200);assert.equal(res.body.data.degraded,true);assert.match(res.body.data.reply,/cenários calculados/);assert.match(res.body.data.reply,/IPCA/);assert.match(res.body.data.reply,/sem balões/);assert.equal(res.body.data.simulation.price,450000);
});
test('base de conhecimento usa o vector store configurado sem IDs hospedados efêmeros',async()=>{
  const f=fixture({vectorStoreId:'vs_testconfigured',replies:[{output:[call('buscar_materiais',{query:'Infraestrutura Solaris'})]}, {data:[{filename:'Aprovado.pdf',score:0.8,content:[{type:'text',text:'O projeto prevê redes subterrâneas.'}]}]},answer('O projeto prevê redes subterrâneas, conforme o material aprovado.')]});
  assert.equal((await f.send('Explique a infraestrutura.')).status,200);
  assert.match(f.requests[1].url,/vector_stores\/vs_testconfigured\/search$/);assert.equal(f.requests[1].body.max_num_results,5);
  assert.equal(f.requests[0].body.tools.some(t=>t.type==='file_search'),false);
});
test('resposta incompleta é regenerada antes de executar efeitos comerciais',async()=>{
  const f=fixture({replies:[{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[call('registrar_contato',{name:'Inventado'})]},answer('Para o seu melhor atendimento, qual é o seu nome e WhatsApp?')]});
  assert.equal((await f.send()).status,200);assert.equal(f.requests.length,2);assert.equal(f.calls.some(c=>c.name==='update_public_agent_contact_capture_v3'),false);
});
test('menção ao lote ou negativa não é confirmação de bloqueio',()=>{
  assert.equal(runtime.confirmedHold('SOL-C-04','Quanto custa SOL-C-04?','SOL-C-04'),false);
  assert.equal(runtime.confirmedHold('Não quero bloquear SOL-C-04','Não quero bloquear SOL-C-04','SOL-C-04'),false);
  assert.equal(runtime.confirmedHold('Confirmo o bloqueio do SOL-C-04','Confirmo o bloqueio do SOL-C-04','SOL-C-04'),true);
});
test('preferências declaradas são preservadas no perfil com evidência do turno',async()=>{
  const message='Quero investir até 500 mil reais.';
  const f=fixture({replies:[{output:[call('registrar_preferencias',{intent:'investir',budget_max:500000,preferred_area_min:null,purchase_horizon:null,evidence:message})]},answer('Vou considerar essa faixa de valor.')]});
  const res=await f.send(message);assert.equal(res.status,200);assert.equal(res.body.data.profile.intent,'investir');assert.equal(res.body.data.profile.budget_max,500000);
});
