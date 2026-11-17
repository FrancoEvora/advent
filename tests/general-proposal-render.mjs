// Synthetic React renders and persistence checks; no live customers or network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire, Module} from 'node:module';
const require=createRequire(import.meta.url), ts=require('typescript'), React=require('react');
const {renderToStaticMarkup}=require('react-dom/server');
const resolve=Module._resolveFilename;
Module._resolveFilename=function(name,...args){return resolve.call(this,name.startsWith('@/')?path.resolve('src',name.slice(2)):name,...args)};
const compile=(module,filename)=>module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText,filename);
require.extensions['.ts']=compile;require.extensions['.tsx']=compile;require.extensions['.css']=module=>{module.exports=new Proxy({},{get:(_,key)=>String(key)})};
const writes=[];
const client={from(table){return {insert(payload){writes.push({table,payload});return {error:null,select(){return {single:async()=>({data:{id:'proposal',approval_status:'pendente'},error:null})}}}},update(){throw Error('Pending proposal must not be auto-approved')}}}};
const load=Module._load;
Module._load=function(name,...args){return name==='@/lib/supabase'?{getSupabase:()=>client}:load.call(this,name,...args)};
const {ProposalModalV52}=require('../src/components/erp/crm-v5/sales/proposal-modal-v52.tsx');
const {saveGeneralProposal}=require('../src/components/erp/crm-v5/sales/save-general-proposal.ts');
const {buildBrokerPlan}=require('../src/lib/broker-payment-plan.ts');
const policy={id:'policy',project_id:'project',name:'Política',active:true,min_down_payment_pct:.1,max_installments:180,monthly_interest_rate:.006,indexer:'IPCA',grace_months:0,balloon_frequency_months:12,balloon_limit_pct:.4,allow_down_payment_installments:true,max_down_payment_installments:6,down_payment_frequency_days:30,down_payment_interest_rate:.0033,proposal_validity_days:5,max_discount_pct:.1,admin_approval_discount_pct:.05,parameters:{annual_balloon_max_count:4}};
const unit={id:'unit',project_id:'project',unit_code:'A01',area:300,list_price:360000,status:'disponivel'};
const data={organization:{id:'org'},session:{user:{id:'user'}},projects:[{id:'project',name:'Projeto'}],crmRecords:[{id:'lead',person_name:'Comprador teste'}]};
const sales={units:[unit],policies:[policy]};
const props={data,sales,initialUnitId:'unit',close(){},async reload(){}};
let html=renderToStaticMarkup(React.createElement(ProposalModalV52,props));
for(const label of ['Entrada (%)','Tabela Price','SACOC','Balões anuais','Juros automáticos','Saldo das mensais','Total do fluxo com juros','Ver cronograma completo','Gerar PDF de conferência','PDF por WhatsApp','PDF por e-mail','Proposta avulsa','Submeter proposta'])assert.ok(html.includes(label),label);
assert.ok(!html.includes('Encaminhar proposta e reservar lote'));
assert.ok(html.includes('36.000,00'));
// Preserve state across renders, drive real input handlers through captured setters.
const originalState=React.useState;const state=[],setters=[];let index=0;
React.useState=initial=>{const i=index++;if(!(i in state))state[i]=typeof initial==='function'?initial():initial;setters[i]=value=>state[i]=typeof value==='function'?value(state[i]):value;return[state[i],setters[i]]};
function render(){index=0;return renderToStaticMarkup(React.createElement(ProposalModalV52,props))}
try{
 render();setters[3](400000);html=render();assert.ok(html.includes('40.000,00'),'Entry percentage follows price');
 setters[5](6);setters[7](true);setters[12]('sacoc');html=render();
 for(const label of ['160.000,00','Última:','4º balão','Restaurar']){if(label!=='Restaurar')assert.ok(html.includes(label),label)}
 setters[6](6);html=render();assert.ok(html.includes('Confira os percentuais'),'Invalid balloons on short term cannot submit');
}finally{React.useState=originalState}
const plan=buildBrokerPlan({salePrice:360000,downPayment:36000,downCount:6,downDue:'2027-01-31',downRate:.0033,downFrequencyDays:30,months:180,monthlyRate:.006,method:'sacoc',firstDue:'2027-07-30',graceMonths:0,balloonTotal:144000,balloonCount:4,balloonFrequency:12});
const form=new FormData();form.set('customer_name','Cliente avulso');form.set('conditions_text','Conferido');
await saveGeneralProposal(data,sales,{unitId:'unit',leadId:'',price:360000,down:36000,downCount:6,downFirstDue:'2027-01-31',months:180,balloons:144000,balloonCount:4,firstDue:'2027-07-30',method:'sacoc',plan},form);
assert.equal(writes[0].payload.amortization_method,'sacoc');assert.equal(writes[0].payload.customer_name,'Cliente avulso');assert.equal(writes[0].payload.negotiation_policy_id,'policy');assert.deepEqual(writes[0].payload.payment_plan,plan);assert.equal(writes[1].payload.length,190);assert.ok(writes.some(row=>row.table==='crm_proposal_approvals'));
html=renderToStaticMarkup(React.createElement(ProposalModalV52,{...props,embedded:true}));assert.ok(!html.includes('role="dialog"'));assert.ok(!html.includes('modal-backdrop'));
console.log('General simulator: shared controls, percentage recalculation, SACOC, balloons, corporate persistence and embedded render passed');
