"use client";

import {useMemo,useState} from "react";
import {getSupabase} from "@/lib/supabase";
import type {ErpData} from "../../types";
import type {CrmSection} from "../types";
import type {InventoryStatus,InventoryUnit,SalesData} from "./types";
import {brl,statusLabel} from "./utils";
import {ReservationModal,UnitEditor} from "./unit-editor";
import {SalesSitePlan} from "./sales-site-plan";

const statusOptions:InventoryStatus[]=["disponivel","reservado","vendido","bloqueio_estrategico","bloqueio_comercial","indisponivel"];

export function SalesMapView({data,sales,reload,setSection}:{data:ErpData;sales:SalesData;reload:()=>Promise<void>;setSection:(section:CrmSection)=>void}){
 const[project,setProject]=useState(data.projects[0]?.id||"");
 const[selectedId,setSelectedId]=useState<string|null>(null);
 const[edit,setEdit]=useState<InventoryUnit|null|"new">(null);
 const[reserve,setReserve]=useState<{unit:InventoryUnit;strategic?:boolean}|null>(null);
 const[status,setStatus]=useState<InventoryStatus|"todos">("todos");
 const[query,setQuery]=useState("");

 const units=useMemo(()=>sales.units.filter(unit=>unit.project_id===project&&unit.active),[sales.units,project]);
 const totals=useMemo(()=>Object.fromEntries(statusOptions.map(item=>[item,units.filter(unit=>unit.status===item).length])) as Record<InventoryStatus,number>,[units]);
 const visibleIds=useMemo(()=>{
  const normalized=query.trim().toLocaleLowerCase("pt-BR");
  return new Set(units.filter(unit=>(status==="todos"||unit.status===status)&&(!normalized||`${unit.unit_code} ${unit.block_code} ${unit.lot_number} ${statusLabel[unit.status]}`.toLocaleLowerCase("pt-BR").includes(normalized))).map(unit=>unit.id));
 },[units,status,query]);
 const selected=units.find(unit=>unit.id===selectedId)||null;
 const activeReservation=selected?sales.reservations.find(item=>item.unit_id===selected.id&&item.status==="ativa")||null:null;

 async function release(unit:InventoryUnit){
  const client=getSupabase();if(!client)return;
  await client.from("crm_unit_reservations").update({status:"cancelada"}).eq("unit_id",unit.id).eq("status","ativa");
  await client.from("crm_inventory_units").update({status:"disponivel",strategic_reason:null,reserved_until:null}).eq("id",unit.id);
  await reload();setSelectedId(null);
 }
 function createProposal(unit:InventoryUnit){localStorage.setItem("evora-proposal-unit",unit.id);setSection("proposals");}
 function changeProject(value:string){setProject(value);setSelectedId(null);setStatus("todos");setQuery("");}
 function changeStatus(value:InventoryStatus|"todos"){setStatus(value);setSelectedId(null);}

 return <div className="crm5-stack sales-map-v67-shell">
  <section className="crm5-section-header sales-map-v67-header">
   <div><small>COMERCIALIZAÇÃO IMOBILIÁRIA</small><h2>Mapa de vendas</h2><p>Visualize a implantação, consulte o estoque e opere propostas, reservas e bloqueios diretamente sobre os lotes.</p></div>
   <div className="sales-map-v67-head-actions"><select value={project} onChange={event=>changeProject(event.target.value)} aria-label="Empreendimento">{data.projects.map(item=><option key={item.id} value={item.id}>{item.name}</option>)}</select><button type="button" onClick={()=>setEdit("new")}>+ Nova unidade</button></div>
  </section>

  <section className="sales-map-v67-filters" aria-label="Pesquisa e filtros do mapa">
   <label><span>Buscar unidade</span><input value={query} onChange={event=>{setQuery(event.target.value);setSelectedId(null);}} placeholder="Quadra, lote ou código"/></label>
   <div className="sales-map-v67-statuses">
    <button type="button" className={status==="todos"?"active":""} onClick={()=>changeStatus("todos")}><strong>{units.length}</strong><span>Todos</span></button>
    {statusOptions.map(item=><button type="button" key={item} data-status={item} className={status===item?"active":""} onClick={()=>changeStatus(item)}><i/><strong>{totals[item]}</strong><span>{statusLabel[item]}</span></button>)}
   </div>
  </section>

  {!units.length?<section className="crm5-empty"><strong>Nenhuma unidade cadastrada</strong><p>Cadastre manualmente ou importe o estoque pela tela Unidades.</p><button className="primary" onClick={()=>setSection("inventory")}>Abrir estoque</button></section>:<section className="sales-map-v67-workspace">
   <SalesSitePlan units={units} selectedId={selectedId} visibleIds={visibleIds} onSelect={unit=>setSelectedId(unit.id)}/>
   <aside className="sales-map-v67-panel" aria-live="polite">
    {selected?<>
     <header><div><span className="sales-map-v67-status" data-status={selected.status}><i/>{statusLabel[selected.status]}</span><h3>{selected.unit_code}</h3><p>Quadra {selected.block_code} · Lote {selected.lot_number}</p></div><button type="button" onClick={()=>setSelectedId(null)} aria-label="Fechar detalhes">×</button></header>
     <section className="sales-map-v67-price"><small>VALOR DE TABELA</small><strong>{brl.format(Number(selected.list_price))}</strong><span>{brl.format(Number(selected.price_per_sqm||selected.list_price/Math.max(selected.area,1)))}/m²</span></section>
     <dl>
      <div><dt>Área</dt><dd>{selected.area} m²</dd></div>
      <div><dt>Dimensões</dt><dd>{selected.frontage?`${selected.frontage} m de frente`:"—"}{selected.depth?` × ${selected.depth} m`:""}</dd></div>
      <div><dt>Preço mínimo</dt><dd>{selected.minimum_price?brl.format(Number(selected.minimum_price)):"Não definido"}</dd></div>
      <div><dt>Características</dt><dd>{[selected.corner?"Esquina":null,selected.topography,selected.orientation].filter(Boolean).join(" · ")||"—"}</dd></div>
     </dl>
     {activeReservation&&<section className="sales-map-v67-reservation"><small>RESERVA ATIVA</small><strong>{activeReservation.customer_name}</strong><span>{activeReservation.expires_at?`Válida até ${new Date(activeReservation.expires_at).toLocaleString("pt-BR")}`:"Sem expiração definida"}</span></section>}
     {selected.strategic_reason&&<p className="sales-map-v67-note">{selected.strategic_reason}</p>}
     <div className="sales-map-v67-actions">
      {selected.status==="disponivel"&&<><button className="primary" type="button" onClick={()=>createProposal(selected)}>+ Nova proposta</button><button type="button" onClick={()=>setReserve({unit:selected})}>Reservar unidade</button><button type="button" onClick={()=>setReserve({unit:selected,strategic:true})}>Bloquear unidade</button></>}
      {(["reservado","bloqueio_estrategico","bloqueio_comercial"] as InventoryStatus[]).includes(selected.status)&&<button type="button" onClick={()=>release(selected)}>Liberar unidade</button>}
      <button className="subtle" type="button" onClick={()=>setEdit(selected)}>Editar cadastro</button>
     </div>
    </>:<div className="sales-map-v67-panel-empty"><b>▦</b><h3>Selecione uma unidade</h3><p>Toque ou clique em um lote para consultar preço, situação comercial e ações disponíveis.</p><span>{visibleIds.size} de {units.length} unidades visíveis</span></div>}
   </aside>
  </section>}

  {edit&&<UnitEditor data={data} unit={edit==="new"?null:edit} close={()=>setEdit(null)} reload={reload}/>}
  {reserve&&<ReservationModal data={data} sales={sales} unit={reserve.unit} strategic={reserve.strategic} close={()=>setReserve(null)} reload={reload}/>}
 </div>;
}
