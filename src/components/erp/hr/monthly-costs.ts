import type { ErpData } from "../types";

export function monthlyCostLines(data: ErpData, month: string) {
  return data.hrEmployees.filter(employee => employee.active).map(employee => {
    const events = data.hrEvents.filter(event => event.employee_id === employee.id && event.reference_date.startsWith(month.slice(0, 7)) && event.status !== "cancelado");
    const additions = events.filter(event => ["ferias", "decimo_terceiro", "bonus", "outro"].includes(event.event_type)).reduce((sum, event) => sum + Number(event.amount), 0);
    const advances = events.filter(event => event.event_type === "adiantamento").reduce((sum, event) => sum + Number(event.amount), 0);
    const deductions = events.filter(event => event.event_type === "desconto").reduce((sum, event) => sum + Number(event.amount), 0);
    const base = Number(employee.base_salary || 0);
    const benefits = Number(employee.benefits_monthly || 0);
    const charges = base * Number(employee.employer_charge_rate || 0);
    return { employee_id: employee.id, base_salary: base, variable_earnings: additions, benefits, employer_charges: charges, advances, deductions, net_amount: Math.max(0, base + additions + benefits - advances - deductions) };
  });
}
