import fs from "node:fs";

function read(path){return fs.readFileSync(path,"utf8")}
function write(path,content){fs.writeFileSync(path,content)}
function replaceOnce(content,search,replacement,label){
  if(!content.includes(search)) throw new Error(`Trecho não encontrado: ${label}`);
  return content.replace(search,replacement);
}

// Types and operational loading
{
  const path="src/components/erp/types.ts";
  let s=read(path);
  s=replaceOnce(s,'export type ViewId = "dashboard" | "crm" | "posvenda" | "financeiro" | "caixa" | "obras" | "compras" | "contratos_operacionais"','export type ViewId = "dashboard" | "crm" | "posvenda" | "financeiro" | "caixa" | "obras" | "compras" | "combustiveis" | "contratos_operacionais"','ViewId combustíveis');
  if(!s.includes('export interface EquipmentMeterReading')){
    s=s.replace('export interface Settings {',`export interface EquipmentMeterReading {\n  id: string;\n  organization_id: string;\n  operational_contract_id: string | null;\n  contract_item_id: string | null;\n  project_id: string | null;\n  equipment_identifier: string;\n  reading_type: string;\n  reading_value: number;\n  reading_at: string;\n  productive_hours: number | null;\n  idle_hours: number | null;\n  maintenance_hours: number | null;\n  operator_name: string | null;\n  notes: string | null;\n  created_by: string | null;\n  created_at: string;\n}\nexport interface Settings {`);
  }
  s=replaceOnce(s,'contractMeasurements: ContractMeasurement[]; contractMeasurementItems: ContractMeasurementItem[]; }','contractMeasurements: ContractMeasurement[]; contractMeasurementItems: ContractMeasurementItem[]; equipmentMeterReadings: EquipmentMeterReading[]; }','ErpData horímetros');
  write(path,s);
}
{
  const path="src/components/erp/operational-data.ts";
  let s=read(path);
  s=replaceOnce(s,'    contractMeasurementItems,\n  ] = await Promise.all([','    contractMeasurementItems,\n    equipmentMeterReadings,\n  ] = await Promise.all([','desestruturação horímetros');
  s=replaceOnce(s,'    client.from("contract_measurement_items").select("*").eq("organization_id", organizationId).order("created_at", { ascending: false }),\n  ]);','    client.from("contract_measurement_items").select("*").eq("organization_id", organizationId).order("created_at", { ascending: false }),\n    client.from("equipment_meter_readings").select("*").eq("organization_id", organizationId).order("reading_at", { ascending: false }),\n  ]);','consulta horímetros');
  s=replaceOnce(s,'    contractMeasurementItems,\n  ].find(result => result.error);','    contractMeasurementItems,\n    equipmentMeterReadings,\n  ].find(result => result.error);','erro horímetros');
  s=replaceOnce(s,'    contractMeasurementItems: contractMeasurementItems.data ?? [],\n  };','    contractMeasurementItems: contractMeasurementItems.data ?? [],\n    equipmentMeterReadings: equipmentMeterReadings.data ?? [],\n  };','retorno horímetros');
  write(path,s);
}

// Sidebar and dedicated fuel view
{
  const path="src/components/erp/erp-app-v55.tsx";
  let s=read(path);
  s=replaceOnce(s,'import {ProcurementView} from "./operations/procurement-view";','import {ProcurementView} from "./operations/procurement-view";\nimport {FuelManagement} from "./operations/fuel-management";','import combustível');
  s=replaceOnce(s,'const nav:Array<{id:ViewId;label:string;icon:string;group:string;permission:string}>=[','const nav:Array<{id:ViewId;label:string;icon:string;group:string;permission:string;subitem?:boolean}>=[','tipo submenu');
  s=replaceOnce(s,'{id:"compras",label:"Compras e serviços",icon:"▣",group:"Operações",permission:"procurement.view"},{id:"contratos_operacionais"','{id:"compras",label:"Compras e serviços",icon:"▣",group:"Operações",permission:"procurement.view"},{id:"combustiveis",label:"Gestão de combustíveis",icon:"⛽",group:"Operações",permission:"fuel.view",subitem:true},{id:"contratos_operacionais"','item combustível');
  s=replaceOnce(s,'financeiro:"financial.manage",aprovacoes:"financial.approve",rh:','financeiro:"financial.manage",aprovacoes:"financial.approve",combustiveis:"fuel.request",rh:','permissão combustível');
  s=s.replaceAll('className={view===i.id?"active":""}','className={`${view===i.id?"active":""}${i.subitem?" nav-subitem":""}`}');
  s=replaceOnce(s,'{view==="compras"&&<ProcurementView data={data} mutate={mutate} can={access}/>} {view==="contratos_operacionais"','{view==="compras"&&<ProcurementView data={data} mutate={mutate} can={access}/>} {view==="combustiveis"&&<FuelManagement data={data} mutate={mutate} can={access}/>} {view==="contratos_operacionais"','render combustível');
  s=s.replaceAll('Versão 6.6 Enterprise','Versão 7.4 Enterprise').replaceAll('VERSÃO 6.6','VERSÃO 7.4');
  write(path,s);
}

// Work package table bars + EAP templates
{
  const path="src/components/erp/operations/work-management-view.tsx";
  let s=read(path);
  s=replaceOnce(s,'import { FormEvent, useMemo, useState } from "react";','import { FormEvent, useEffect, useMemo, useState } from "react";','React hooks');
  if(!s.includes('type EapTemplate =')){
    s=s.replace('type Mutate = (operation: () => Promise<void>, success: string) => Promise<void>;','type Mutate = (operation: () => Promise<void>, success: string) => Promise<void>;\n\ntype EapTemplate = { template_code:string; name:string; description:string; category:string; icon:string; estimated_duration_days:number; active:boolean; sort_order:number };\ntype EapTemplateItem = { template_code:string; item_key:string; wbs_code:string; name:string; sequence:number; is_summary:boolean };');
  }
  s=replaceOnce(s,'  const [editing, setEditing] = useState<ConstructionWorkPackage | null>(null);','  const [editing, setEditing] = useState<ConstructionWorkPackage | null>(null);\n  const [showTemplates,setShowTemplates]=useState(false);\n  const [templates,setTemplates]=useState<EapTemplate[]>([]);\n  const [templateItems,setTemplateItems]=useState<EapTemplateItem[]>([]);\n  const [selectedTemplate,setSelectedTemplate]=useState<string | null>(null);\n\n  useEffect(()=>{\n    const client=getSupabase(); if(!client)return;\n    Promise.all([\n      client.from("construction_eap_templates").select("*").eq("active",true).order("sort_order"),\n      client.from("construction_eap_template_items").select("template_code,item_key,wbs_code,name,sequence,is_summary").order("template_code").order("sequence"),\n    ]).then(([templateResult,itemResult])=>{\n      if(!templateResult.error)setTemplates((templateResult.data||[]) as EapTemplate[]);\n      if(!itemResult.error)setTemplateItems((itemResult.data||[]) as EapTemplateItem[]);\n    });\n  },[]);\n\n  async function applyTemplate(template:EapTemplate){\n    if(!effectiveProjectId)return;\n    const project=data.projects.find(item=>item.id===effectiveProjectId);\n    const start=window.prompt("Data inicial da linha de base (AAAA-MM-DD)",project?.start_date||new Date().toISOString().slice(0,10));\n    if(!start)return;\n    const budget=Number(window.prompt("Orçamento total da obra em R$",String(project?.total_budget||0))||0);\n    if(!window.confirm(`Aplicar o modelo ${template.name}? Pacotes já existentes não serão duplicados.`))return;\n    await mutate(async()=>{\n      const client=getSupabase(); if(!client)throw new Error("Supabase indisponível.");\n      const {error}=await client.rpc("apply_construction_eap_template",{p_organization_id:data.organization.id,p_project_id:effectiveProjectId,p_template_code:template.template_code,p_start_date:start,p_total_budget:Number.isFinite(budget)?budget:0});\n      if(error)throw error;\n    },`Modelo ${template.name} aplicado à obra.`);\n    setShowTemplates(false);\n  }','states templates');
  s=replaceOnce(s,'        </label>\n      </section>','        </label>\n        <button type="button" onClick={()=>setShowTemplates(value=>!value)}>▦ Modelos de EAP</button>\n      </section>','botão templates');
  s=replaceOnce(s,'      {!projectsWithWork.length ? (','      {showTemplates&&<section className="work-template-library"><header><div><small>BIBLIOTECA DE EAP</small><h3>Modelos editáveis para loteamentos</h3><p>Use uma estrutura de referência e ajuste datas, pesos, responsáveis e orçamento depois da aplicação.</p></div><span>{templates.length} modelos</span></header><div>{templates.map(template=>{const items=templateItems.filter(item=>item.template_code===template.template_code),executive=items.filter(item=>!item.is_summary).length;return <article key={template.template_code} className={selectedTemplate===template.template_code?"selected":""} onClick={()=>setSelectedTemplate(template.template_code)}><i>{template.icon||"▦"}</i><small>{template.category}</small><h4>{template.name}</h4><p>{template.description}</p><footer><span>{executive} pacotes executivos</span><span>{template.estimated_duration_days} dias</span></footer>{selectedTemplate===template.template_code&&<div className="work-template-preview">{items.slice(0,6).map(item=><span key={item.item_key}><b>{item.wbs_code}</b>{item.name}</span>)}<button className="primary" onClick={event=>{event.stopPropagation();applyTemplate(template)}}>Usar como base</button></div>}</article>})}</div></section>}\n\n      {!projectsWithWork.length ? (','biblioteca templates');
  s=replaceOnce(s,'                    <span>{percent.format(planned)}%</span>\n                    <span className="work-stage-measured">{percent.format(actual)}%</span>','                    <span className="work-table-progress"><i><b style={{width:`${Math.min(100,Math.max(0,planned))}%`}} /></i><em>{percent.format(planned)}%</em></span>\n                    <span className="work-table-progress work-table-progress-actual"><i><b style={{width:`${Math.min(100,Math.max(0,actual))}%`}} /></i><em>{percent.format(actual)}%</em></span>','barras tabela');
  write(path,s);
}

// Version metadata and CSS
{
  const path="src/app/layout.tsx"; let s=read(path);
  if(!s.includes('v7-4-works.css')) s=s.replace('import "./styles/v6-6-operations.css";','import "./styles/v6-6-operations.css";\nimport "./styles/v7-4-works.css";');
  s=s.replaceAll('Versão 6.6 Enterprise','Versão 7.4 Enterprise');
  write(path,s);
}
{
  const path="public/manifest.webmanifest";let s=read(path);s=s.replaceAll('Versão 6.6 Enterprise','Versão 7.4 Enterprise');write(path,s);
}
{
  const path="public/sw.js";let s=read(path);s=s.replace(/evora-gestao-v[^"']+/, 'evora-gestao-v7-4');write(path,s);
}
{
  const path="src/app/styles/v7-4-works.css";
  write(path,`.nav-group button.nav-subitem{margin-left:24px;width:calc(100% - 24px);padding-top:9px;padding-bottom:9px;background:#f7faf9;font-size:12px}.nav-group button.nav-subitem b{font-size:14px}.work-table-progress{display:grid;grid-template-columns:minmax(70px,1fr) auto;align-items:center;gap:8px}.work-table-progress i{height:7px;border-radius:999px;background:#e7edef;overflow:hidden}.work-table-progress i b{display:block;height:100%;border-radius:999px;background:#1d5271}.work-table-progress-actual i b{background:#79a92f}.work-table-progress em{font-style:normal;color:#526a74;font-size:11px;font-weight:800}.work-template-library{display:grid;gap:18px;padding:24px;border:1px solid #dce5e7;border-radius:22px;background:#fff}.work-template-library>header{display:flex;justify-content:space-between;gap:20px}.work-template-library>header small{color:#79a92f;font-weight:900;letter-spacing:.13em}.work-template-library>header h3{margin:5px 0;color:#143f52}.work-template-library>header p{margin:0;color:#71858d}.work-template-library>header>span{align-self:start;padding:7px 10px;border-radius:999px;background:#eef5e8;color:#5f8d2e;font-size:11px;font-weight:850}.work-template-library>div{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.work-template-library article{display:grid;grid-template-columns:48px 1fr;gap:5px 14px;padding:20px;border:1px solid #dce5e7;border-radius:17px;cursor:pointer}.work-template-library article.selected{border-color:#79a92f;box-shadow:0 8px 24px rgba(75,120,45,.12)}.work-template-library article>i{grid-row:1/5;display:grid;place-content:center;width:48px;height:48px;border-radius:14px;background:#eef5e8;color:#67992f;font-style:normal;font-size:22px}.work-template-library article>small{color:#6b933e;font-weight:850;text-transform:uppercase}.work-template-library h4{margin:0;color:#153f53;font-size:20px}.work-template-library article>p{margin:5px 0;color:#71858d}.work-template-library footer{display:flex;justify-content:space-between;gap:10px;color:#71858d;font-size:10px;font-weight:800;text-transform:uppercase}.work-template-preview{grid-column:1/-1;display:grid;gap:7px;margin-top:12px;padding-top:14px;border-top:1px solid #e8eeee}.work-template-preview>span{display:grid;grid-template-columns:48px 1fr;gap:8px;font-size:12px}.work-template-preview>span b{color:#5e8b2f}.work-template-preview .primary{margin-top:8px}@media(max-width:760px){.nav-group button.nav-subitem{margin-left:12px;width:calc(100% - 12px)}.work-template-library>header{display:grid}.work-template-library>div{grid-template-columns:1fr}.work-stage-table-head,.work-stage-table>article{grid-template-columns:minmax(200px,2fr) repeat(3,minmax(125px,1fr)) minmax(95px,.8fr) minmax(120px,1fr) 82px}}`);
}

console.log("Évora Gestão 7.4 aplicada.");
