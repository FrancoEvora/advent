import type { HrEmployee } from "../types";

export function estimatedSeparationCost(employee: HrEmployee, reserveRate: number) {
  const salary = Number(employee.base_salary || 0);
  const admitted = new Date(`${employee.admission_date}T12:00:00`);
  const current = new Date();
  const months = Math.max(1, (current.getFullYear() - admitted.getFullYear()) * 12 + current.getMonth() - admitted.getMonth());
  const proportional = Math.max(1, current.getMonth() + 1) / 12;
  const notice = employee.employment_type === "clt" ? salary : 0;
  const annualAccrual = salary * proportional;
  const restAccrual = salary * Math.min(12, months % 12 || 12) / 12 * 4 / 3;
  const reserve = employee.employment_type === "clt" ? salary * months * Number(employee.fgts_rate || 0) * Number(reserveRate || 0) : 0;
  return notice + annualAccrual + restAccrual + reserve;
}
