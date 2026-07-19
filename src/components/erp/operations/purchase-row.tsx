"use client";

import type { ErpData, PurchaseRequest } from "../types";
import { canAdmin, dateAtNoon, money, shortDate } from "../utils";

export function PurchaseRow({ data, request, documents, approve, reject, payable }: { data: ErpData; request: PurchaseRequest; documents: () => void; approve: () => void; reject: () => void; payable: () => void }) {
  const supplier = data.contacts.find(contact => contact.id === request.supplier_contact_id);
  return <article className={request.cash_risk ? "risk" : ""}><div><span className={`purchase-status ${request.status}`}>{request.status}</span><strong>{request.title}</strong><small>{supplier?.trade_name || supplier?.name || "Fornecedor a definir"} · {request.request_type} · {request.payment_due_date ? shortDate.format(dateAtNoon(request.payment_due_date)) : "sem data"}</small></div><b>{money.format(Number(request.estimated_total))}</b><div className="purchase-actions"><button onClick={documents}>Documentos</button>{canAdmin(data.membership.role) && request.status === "submetida" && <><button onClick={reject}>Rejeitar</button><button className="primary" onClick={approve}>Aprovar</button></>}{request.status === "aprovada" && !request.financial_entry_id && <button className="primary" onClick={payable}>Gerar conta a pagar</button>}</div>{request.cash_risk && <p>Risco {request.cash_risk_level}. {request.recommended_payment_date ? `Recomendação: pagamento em ${shortDate.format(dateAtNoon(request.recommended_payment_date))}.` : "Sem cobertura no horizonte configurado."}</p>}</article>;
}
