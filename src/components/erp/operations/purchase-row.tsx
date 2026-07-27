"use client";
import {useEffect,useRef} from "react";
import type {ActivityDeepLinkTarget} from "../activities/activity-links";
import type {ErpData,PurchaseRequest} from "../types";
import {canAdmin,dateAtNoon,money,shortDate} from "../utils";
type ExtendedPurchase=PurchaseRequest&{negotiated_payment_date?:string|null;decision_notes?:string|null};
export function PurchaseRow({data,request,canManage,documents,approve,reject,payable,focus}:{data:ErpData;request:ExtendedPurchase;canManage:boolean;documents:()=>void;approve:()=>void;reject:()=>void;payable:()=>void;focus?:ActivityDeepLinkTarget|null}){
 const supplier=data.contacts.find(contact=>contact.id===request.supplier_contact_id),effectiveDate=request.negotiated_payment_date||request.payment_due_date;
 const linked=focus?.sourceType==="purchase_requests"&&focus.recordId===request.id;
 const rowRef=useRef<HTMLElement|null>(null);
 useEffect(()=>{
  if(!linked||!rowRef.current)return;
  rowRef.current.focus({preventScroll:true});
  rowRef.current.scrollIntoView({behavior:"smooth",block:"center"});
 },[linked]);
 return <article ref={linked?rowRef:undefined} data-record-id={request.id} tabIndex={linked?-1:undefined} className={`${request.cash_risk?"risk ":""}${linked?"agenda-linked-target":""}`.trim()}><div><span className={`purchase-status ${request.status}`}>{request.status}</span><strong>{request.title}</strong><small>{supplier?.trade_name||supplier?.name||"Fornecedor a definir"} · {request.request_type} · {effectiveDate?shortDate.format(dateAtNoon(effectiveDate)):"sem data"}</small>{request.negotiated_payment_date&&<em>Data negociada e registrada pela administração.</em>}</div><b>{money.format(Number(request.estimated_total))}</b><div className="purchase-actions"><button onClick={documents}>Documentos</button>{canManage&&canAdmin(data.membership.role)&&request.status==="submetida"&&<><button onClick={reject}>Rejeitar</button><button className="primary" onClick={approve}>Analisar e aprovar</button></>}{canManage&&request.status==="aprovada"&&!request.financial_entry_id&&<button className="primary" onClick={payable}>Gerar conta a pagar</button>}</div>{request.cash_risk&&<p>Risco {request.cash_risk_level}. {request.recommended_payment_date?`Recomendação: pagamento em ${shortDate.format(dateAtNoon(request.recommended_payment_date))}.`:"Sem cobertura no horizonte configurado."}</p>}{request.decision_notes&&request.status!=="submetida"&&<p>{request.decision_notes}</p>}</article>;
}
