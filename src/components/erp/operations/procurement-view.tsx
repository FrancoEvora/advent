"use client";

import { useState } from "react";
import type { ErpData, PurchaseRequest } from "../types";
import { money } from "../utils";
import { Empty, Kpi, PanelTitle } from "../views-dashboard";
import { EntityDocumentModal } from "../documents/entity-document-modal";
import { PurchaseModal } from "./purchase-modal";
import { PurchaseRow } from "./purchase-row";
import { decidePurchase } from "./purchase-decision";
import { createPurchasePayable } from "./purchase-payable";

export function ProcurementView({ data, mutate }: { data: ErpData; mutate: (operation: () => Promise<void>, success: string) => Promise<void> }) {
  const [create, setCreate] = useState(false);
  const [documents, setDocuments] = useState<PurchaseRequest | null>(null);
  const pending = data.purchaseRequests.filter(request => request.status === "submetida");
  const approved = data.purchaseRequests.filter(request => ["aprovada", "contratada", "recebida"].includes(request.status));
  const exposure = approved.filter(request => !request.financial_entry_id).reduce((sum, request) => sum + Number(request.estimated_total), 0);
  const decide = (request: PurchaseRequest, status: "aprovada" | "rejeitada") => mutate(() => decidePurchase(data, request, status), status === "aprovada" ? "Compra aprovada." : "Solicitação rejeitada.");
  const payable = (request: PurchaseRequest) => mutate(() => createPurchasePayable(data, request), "Conta a pagar gerada a partir da compra aprovada.");

  return <div className="stack"><section className="module-toolbar"><div><small>SUPRIMENTOS E CONTRATAÇÕES</small><h2>Compras, materiais e serviços</h2></div><button className="primary" onClick={() => setCreate(true)}>+ Nova solicitação</button></section><section className="kpi-grid four"><Kpi label="Aguardando aprovação" value={String(pending.length)} tone="warning" detail="Decisão administrativa" /><Kpi label="Aprovadas / contratadas" value={String(approved.length)} tone="positive" detail="Solicitações ativas" /><Kpi label="Compromisso projetado" value={money.format(exposure)} tone="negative" detail="Ainda sem conta a pagar" /><Kpi label="Risco de caixa" value={String(data.purchaseRequests.filter(request => request.cash_risk && !["rejeitada", "cancelada"].includes(request.status)).length)} tone="danger" detail="Datas a reprogramar" /></section><section className="panel"><PanelTitle eyebrow="SOLICITAÇÕES" title="Fila de compras e contratações" /><div className="purchase-list">{data.purchaseRequests.map(request => <PurchaseRow key={request.id} data={data} request={request} documents={() => setDocuments(request)} approve={() => decide(request, "aprovada")} reject={() => decide(request, "rejeitada")} payable={() => payable(request)} />)}{!data.purchaseRequests.length && <Empty text="Nenhuma solicitação de compra registrada." />}</div></section>{create && <PurchaseModal data={data} mutate={mutate} close={() => setCreate(false)} />}{documents && <EntityDocumentModal data={data} mutate={mutate} entityType="purchase_request" entityId={documents.id} close={() => setDocuments(null)} />}</div>;
}
