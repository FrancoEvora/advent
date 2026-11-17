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

const {BrokerActivityReport}=require('../src/components/erp/crm-v5/broker-activity-report.tsx');
const data={organization:{id:'org'},session:{user:{id:'admin'}},members:[{role:'corretor',user_id:'broker'}],profiles:[{id:'broker',full_name:'Corretor teste'}]};
const crm={teamMembers:[],assignments:[]};
const html=renderToStaticMarkup(React.createElement(BrokerActivityReport,{data,crm}));
for(const text of ['Atividades por corretor','Corretor teste','Gerar relatório','Últimos 7 dias','Últimos 30 dias','Últimos 90 dias'])assert.ok(html.includes(text),text);
assert.equal((html.match(/type="date"/g)||[]).length,2);
assert.ok(!html.includes('Exportar CSV'),'Export only after a successful query');
console.log('Broker report real React initial render passed');
