"use client";

import type { ErpData, HrEmployee } from "../types";
import { money } from "../utils";
import { Empty } from "../views-dashboard";
import { estimatedSeparationCost } from "./cost-estimate";

export function EmployeeList({ data, edit, documents, toggle }: { data: ErpData; edit: (employee: HrEmployee) => void; documents: (employee: HrEmployee) => void; toggle: (employee: HrEmployee) => void }) {
  return <div className="employee-list">{data.hrEmployees.map(employee => { const monthly = Number(employee.base_salary) + Number(employee.benefits_monthly) + Number(employee.base_salary) * Number(employee.employer_charge_rate); const separation = estimatedSeparationCost(employee, Number(data.settings.termination_reserve_rate || 0.4)); return <article key={employee.id}><div className="avatar-square">{employee.full_name.slice(0, 2).toUpperCase()}</div><div><strong>{employee.full_name}</strong><small>{employee.job_title || "Cargo não informado"} · {employee.department || "Sem departamento"}</small></div><span><small>Custo mensal</small><strong>{money.format(monthly)}</strong></span><span><small>Desligamento estimado</small><strong>{money.format(separation)}</strong></span><div><button onClick={() => documents(employee)}>Documentos</button><button onClick={() => edit(employee)}>Editar</button><button onClick={() => toggle(employee)}>{employee.active ? "Desativar" : "Reativar"}</button></div></article>; })}{!data.hrEmployees.length && <Empty text="Nenhum colaborador cadastrado." />}</div>;
}
