"use client";

import { FormEvent, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ErpData } from "../types";
import { analyzeComprehensivePaymentRisk } from "../operational-cash";
import { dateAtNoon, money, shortDate } from "../utils";
import { PanelTitle } from "../views-dashboard";
import { newPurchaseLine, PurchaseLines, type PurchaseLine } from "./purchase-lines";

export function PurchaseModal({ data, close, mutate }: { data: ErpData; close: () => void; mutate: (operation: () => Promise<void>, success: string) => Promise<void> }) {
  const [lines, setLines] = useState<PurchaseLine[]>([newPurchaseLine()]);
  const [dueDate, setDueDate] = useState(new Date().toISOString().slice(0, 10));
  const [error, setError] = useState("");
  const total = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  const risk = useMemo(() => analyzeComprehensivePaymentRisk(data, { amount: total, dueDate }), [data, total, dueDate]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setError("");
    const form = new FormData(event.currentTarget);
    const validLines = lines.filter(line => line.description.trim() && line.quantity > 0);
    if (!validLines.length) { setError("Inclua ao menos um item ou serviço."); return; }
    await mutate(async () => {
      const supabase = getSupabase(); if (!supabase) throw new Error("Supabase indisponível.");
      const { data: request, error: requestError } = await supabase.from("purchase_requests").insert({ organization_id: data.organization.id, request_type: String(form.get("request_type")), title: String(form.get("title")).trim(), description: String(form.get("description") || "") || null, supplier_contact_id: String(form.get("supplier_contact_id") || "") || null, project_id: String(form.get("project_id") || "") || null, cost_center_id: String(form.get("cost_center_id") || "") || null, requested_by: data.session.user.id, needed_by: String(form.get("needed_by") || "") || null, payment_due_date: dueDate, recommended_payment_date: risk.recommendedDate, estimated_total: total, cash_risk: risk.risky, cash_risk_level: risk.level, projected_balance: risk.projectedBalance, status: "submetida", approval_required: true }).select().single();
      if (requestError) throw new Error(requestError.message);
      const { error: itemError } = await supabase.from("purchase_request_items").insert(validLines.map(line => ({ purchase_request_id: request.id, description: line.description.trim(), quantity: line.quantity, unit: line.unit || null, unit_price: line.unitPrice })));
      if (itemError) throw new Error(itemError.message);
    }, risk.risky ? "Solicitação enviada com alerta de caixa." : "Solicitação enviada para aprovação administrativa.");
    close();
  }

  return <div className="modal-backdrop" onMouseDown={close}><form className="modal large purchase-modal" onSubmit={submit} onMouseDown={event => event.stopPropagation()}><PanelTitle eyebrow="NOVA SOLICITAÇÃO" title="Comprar materiais ou contratar serviços" /><button className="modal-close" type="button" onClick={close}>×</button><div className="form-section"><h4>Dados da solicitação</h4><div className="form-grid three"><label>Tipo<select name="request_type"><option value="material">Compra de material</option><option value="servico">Contratação de serviço</option><option value="misto">Material e serviço</option></select></label><label className="span-2">Título<input name="title" required /></label><label>Fornecedor<select name="supplier_contact_id"><option value="">A definir</option>{data.contacts.filter(contact => contact.active && ["fornecedor", "ambos"].includes(contact.contact_type)).map(contact => <option key={contact.id} value={contact.id}>{contact.trade_name || contact.name}</option>)}</select></label><label>Centro de custo<select name="cost_center_id" required><option value="">Selecione</option>{data.costCenters.filter(center => center.active).map(center => <option key={center.id} value={center.id}>{center.code} · {center.name}</option>)}</select></label><label>Empreendimento<select name="project_id"><option value="">Corporativo</option>{data.projects.filter(project => project.active).map(project => <option key={project.id} value={project.id}>{project.code} · {project.name}</option>)}</select></label><label>Necessidade<input name="needed_by" type="date" /></label><label>Pagamento previsto<input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} required /></label><label className="span-3">Justificativa / escopo<textarea name="description" rows={3} /></label></div></div><PurchaseLines lines={lines} setLines={setLines} />{risk.risky && <div className={`cash-risk-alert ${risk.level}`}><div><b>!</b><span><strong>Data incompatível com o fluxo de caixa</strong><small>Saldo projetado: {money.format(risk.projectedBalance)}</small></span></div><p>{risk.reason}</p>{risk.recommendedDate && <button type="button" onClick={() => setDueDate(risk.recommendedDate!)}>Aplicar melhor data: {shortDate.format(dateAtNoon(risk.recommendedDate))}</button>}<em>A compra continuará dependendo de aprovação administrativa.</em></div>}{error && <div className="feedback error">{error}</div>}<footer><button type="button" onClick={close}>Cancelar</button><button className="primary">Enviar para aprovação</button></footer></form></div>;
}
