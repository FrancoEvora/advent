"use client";

import { useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ErpData, HrEmployee, HrPayrollRun } from "../types";
import { money } from "../utils";
import { Kpi, PanelTitle } from "../views-dashboard";
import { EntityDocumentModal } from "../documents/entity-document-modal";
import { EmployeeModal } from "./employee-modal";
import { EmployeeList } from "./employee-list";
import { HrEventModal } from "./hr-event-modal";
import { HrEventsList } from "./hr-events-list";
import { PayrollModalV2 } from "./payroll-modal-v2";
import { PayrollList } from "./payroll-list";
import { estimatedSeparationCost } from "./cost-estimate";

export function HrView({ data, mutate }: { data: ErpData; mutate: (operation: () => Promise<void>, success: string) => Promise<void> }) {
  const [tab, setTab] = useState<"colaboradores" | "folhas" | "eventos">("colaboradores");
  const [employee, setEmployee] = useState<HrEmployee | "new" | null>(null);
  const [event, setEvent] = useState(false); const [payroll, setPayroll] = useState(false);
  const [documentTarget, setDocumentTarget] = useState<{ type: string; id: string } | null>(null);
  const monthly = data.hrEmployees.filter(item => item.active).reduce((sum, item) => sum + Number(item.base_salary) + Number(item.benefits_monthly) + Number(item.base_salary) * Number(item.employer_charge_rate), 0);
  const separation = data.hrEmployees.filter(item => item.active).reduce((sum, item) => sum + estimatedSeparationCost(item, Number(data.settings.termination_reserve_rate || 0.4)), 0);
  const pendingPayroll = data.hrPayrollRuns.filter(item => ["calculada", "aprovada"].includes(item.status)).reduce((sum, item) => sum + Number(item.net_total) + Number(item.charges_total), 0);
  async function toggle(item: HrEmployee) { await mutate(async () => { const client = getSupabase(); if (!client) throw new Error("Supabase indisponível."); const result = await client.from("hr_employees").update({ active: !item.active }).eq("id", item.id); if (result.error) throw new Error(result.error.message); }, item.active ? "Colaborador desativado." : "Colaborador reativado."); }

  return <div className="stack"><section className="module-toolbar"><div><small>GESTÃO DE PESSOAS</small><h2>RH, folha e previsibilidade trabalhista</h2></div><div className="toolbar-actions"><button onClick={() => setEvent(true)}>+ Evento de RH</button><button onClick={() => setPayroll(true)}>Gerar folha</button><button className="primary" onClick={() => setEmployee("new")}>+ Colaborador</button></div></section><section className="kpi-grid four"><Kpi label="Colaboradores ativos" value={String(data.hrEmployees.filter(item => item.active).length)} tone="positive" detail="Quadro cadastrado" /><Kpi label="Custo mensal estimado" value={money.format(monthly)} tone="negative" detail="Remuneração, benefícios e encargos" /><Kpi label="Folhas no caixa" value={money.format(pendingPayroll)} tone="warning" detail="Calculadas ou aprovadas" /><Kpi label="Exposição de desligamento" value={money.format(separation)} tone="gold" detail="Estimativa gerencial configurável" /></section><nav className="module-tabs"><button className={tab === "colaboradores" ? "active" : ""} onClick={() => setTab("colaboradores")}>Colaboradores</button><button className={tab === "folhas" ? "active" : ""} onClick={() => setTab("folhas")}>Folhas de pagamento</button><button className={tab === "eventos" ? "active" : ""} onClick={() => setTab("eventos")}>Férias, antecipações e eventos</button></nav><section className="panel"><PanelTitle eyebrow={tab === "colaboradores" ? "CADASTRO E CUSTOS" : tab === "folhas" ? "PROCESSAMENTO" : "MOVIMENTAÇÕES"} title={tab === "colaboradores" ? "Quadro de colaboradores" : tab === "folhas" ? "Folhas calculadas" : "Eventos com impacto financeiro"} />{tab === "colaboradores" && <EmployeeList data={data} edit={item => setEmployee(item)} documents={item => setDocumentTarget({ type: "hr_employee", id: item.id })} toggle={toggle} />}{tab === "folhas" && <PayrollList data={data} mutate={mutate} documents={(run: HrPayrollRun) => setDocumentTarget({ type: "payroll_run", id: run.id })} />}{tab === "eventos" && <HrEventsList data={data} mutate={mutate} />}</section><div className="info-box">Os valores de desligamento são estimativas gerenciais para planejamento de caixa. O cálculo oficial deve ser validado pela contabilidade e pela assessoria trabalhista.</div>{employee && <EmployeeModal data={data} employee={employee === "new" ? null : employee} mutate={mutate} close={() => setEmployee(null)} />}{event && <HrEventModal data={data} mutate={mutate} close={() => setEvent(false)} />}{payroll && <PayrollModalV2 data={data} mutate={mutate} close={() => setPayroll(false)} />}{documentTarget && <EntityDocumentModal data={data} mutate={mutate} entityType={documentTarget.type} entityId={documentTarget.id} close={() => setDocumentTarget(null)} />}</div>;
}