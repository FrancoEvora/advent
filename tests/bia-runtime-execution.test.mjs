import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const ts = require('typescript');
const dir=new URL('../supabase/functions/enterprise-bia-agent-gateway/',import.meta.url);
const source=(name)=>ts.transpileModule(fs.readFileSync(new URL(name,dir),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const coreCode=source('core.ts'),indexCode=source('index.ts');
const key='publishable_test_'+'x'.repeat(40);
const base={action:'message',slug:'solaris',tokenHash:'a'.repeat(64),fingerprintHash:'b'.repeat(64),clientMessageId:'123e4567-e89b-42d3-a456-426614174001',source:'text',message:'Qual a menor parcela?'};
const output=(text)=>({status:'completed',output:[{type:'message',content:[{type:'output_text',text}]}]});
const call=(id,name,args={})=>({type:'function_call',call_id:id,name,arguments:JSON.stringify(args)});
const simulation={unitCode:'SOL-C-04',area:360,price:450000,downPayment:45000,downPaymentInstallments:1,monthlyInterestRate:.0033,indexer:'IPCA',balloonCount:0,scenarios:[{months:150,monthlyPayment:3427.52}]};
function harness({responses=[],claim=null,overrides={}}={}){
 const calls=[],modelRequests=[];const gateway={contactCapture:{},converted:false,serviceConsented:false,profile:{}};
 const rpc=async(name,args)=>{
  calls.push({name,args});
  if(overrides[name])return overrides[name](args,gateway);
  if(name==='claim_public_agent_request_v4')return {data:claim||{state:'claimed',leaseToken:'lease'}};
  if(name==='get_public_agent_v3_context')return {data:{organizationId:'org',stage:'welcome',profile:{},knowledge:{},messages:[]}};
  if(name==='get_public_agent_gateway_context_v1')return {data:structuredClone(gateway)};
  if(name==='get_crm_ai_runtime_credentials')return {data:{enabled:true,mode:'autonomous',api_key:'secret-test-not-public'+'x'.repeat(40),agent_model:'erp-model',agent_reasoning:'low'}};
  if(name==='get_public_agent_commercial_context')return {data:{realTime:true,units:[{unit_code:'SOL-C-04',area:360,list_price:450000}],policy:{parameters:{}}}};
  if(name==='calculate_public_agent_payment_simulation_v4')return {data:simulation};
  if(name==='update_public_agent_contact_capture_v3'){Object.assign(gateway.contactCapture,args.p_patch);gateway.serviceConsented=true;return {data:structuredClone(gateway)};}
  if(name==='ensure_bia_lead_v1'){gateway.converted=!!gateway.contactCapture.phone;return {data:{linked:gateway.converted}};}
  if(name==='schedule_bia_visit_v2')return {data:{scheduled:true,id:'appointment',scheduledAt:args.p_scheduled_at}};
  if(name==='finish_bia_turn_v1')return {data:args.p_response};
  return {data:{}};
 };
 const core={exports:{}};new Function('exports','module',coreCode)(core.exports,core);
 const runtimeModule={exports:{}};
 const fakeFetch=async(url,opts)=>{assert.equal(url,'https://api.openai.com/v1/responses');modelRequests.push(JSON.parse(opts.body));const next=responses.shift();if(next instanceof Error)throw next;if(!next)throw Error('Unexpected model call');return new Response(JSON.stringify(next.payload||next),{status:next.statusCode||200,headers:{'content-type':'application/json','x-request-id':'req_test'}});};
 const deno={env:{get:n=>({SUPABASE_URL:'https://test.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'server-secret',SUPABASE_PUBLISHABLE_KEYS:JSON.stringify({default:key})})[n]},serve:()=>{}};
 new Function('require','exports','module','Deno','fetch',indexCode)(name=>name==='./core.ts'?core.exports:{createClient:()=>({rpc})},runtimeModule.exports,runtimeModule,deno,fakeFetch);
 return {calls,modelRequests,run:async(body={})=>{const r=await runtimeModule.exports.handleRequest(new Request('https://test/function',{method:'POST',headers:{apikey:key,'content-type':'application/json'},body:JSON.stringify({...base,...body})}));return {status:r.status,...await r.json()};}};
}
test('cached duplicate completes without model or tool cost',async()=>{const h=harness({claim:{state:'succeeded',response:{reply:'cached',status:'completed'}}});const r=await h.run();assert.equal(r.data.reply,'cached');assert.equal(h.modelRequests.length,0);});
test('active identical request only polls without executing',async()=>{const h=harness({claim:{state:'inProgress'}});const r=await h.run();assert.equal(r.status,202);assert.equal(r.data.status,'processing');assert.equal(h.modelRequests.length,0);});
test('all parallel tool calls are returned before continuing the model',async()=>{const h=harness({responses:[{status:'completed',output:[call('a','consultar_estoque'),call('b','consultar_condicoes_comerciais')]},output('Valor consultado no ERP.')]});const r=await h.run();assert.equal(r.status,200);assert.deepEqual(h.modelRequests[1].input.filter(x=>x.type==='function_call_output').map(x=>x.call_id),['a','b']);assert.equal(r.data.metadata.tool_calls,2);assert.equal(r.data.degraded,false);});
test('contact state is refreshed before a visit in the same turn',async()=>{const when=new Date(Date.now()+86400000).toISOString();const h=harness({responses:[{status:'completed',output:[call('a','registrar_contato',{name:'Ana',phone:'34999998888'}),call('b','agendar_visita',{requested_when:when})]},output('Visita registrada.')]});const r=await h.run({message:`Ana, WhatsApp (34) 99999-8888. Agende a visita para ${when}.`});assert.equal(r.data.contactCapture.name,'Ana');assert.equal(r.data.serviceConsented,true);assert.equal(r.data.converted,true);assert.ok(h.calls.some(c=>c.name==='schedule_bia_visit_v2'));});
test('fabricated contact never writes to CRM',async()=>{const h=harness({responses:[{status:'completed',output:[call('a','registrar_contato',{name:'Ana',phone:'34999998888'})]},output('Qual seu nome?')]});await h.run({message:'Bom dia'});assert.equal(h.calls.some(c=>c.name==='update_public_agent_contact_capture_v3'),false);});
test('provider quota is truthful degraded delivery, not local successful greeting',async()=>{const h=harness({responses:[{statusCode:429,payload:{error:{code:'credit_balance_exhausted',type:'quota'}}}]});const r=await h.run({message:'Bom dia'});assert.equal(r.status,200);assert.equal(r.data.degraded,true);assert.equal(r.data.metadata.failure_code,'BIA_PROVIDER_QUOTA');assert.match(r.data.reply,/Não consegui concluir/);assert.doesNotMatch(JSON.stringify(r),/secret-test|server-secret/);});
test('verified ERP simulation survives final model failure',async()=>{const h=harness({responses:[{status:'completed',output:[call('a','simular_pagamento',{objective:'lowest_monthly_payment'})]},new Error('network')]});const r=await h.run();assert.equal(r.status,200);assert.equal(r.data.degraded,true);assert.equal(r.data.simulation.price,450000);assert.match(r.data.reply,/3\.427,52/);assert.match(r.data.reply,/entre os prazos calculados/);assert.equal(h.calls.find(x=>x.name==='calculate_public_agent_payment_simulation_v4').args.p_requested_months,null);});
test('invalid message size rejected before claiming or calling provider',async()=>{const h=harness();const r=await h.run({message:'x'.repeat(801)});assert.equal(r.status,400);assert.equal(h.calls.length,0);assert.equal(h.modelRequests.length,0);});
