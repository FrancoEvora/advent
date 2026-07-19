import type { EntryStatus, FinancialEntry, Role } from "./types";

export const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
export const shortDate = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
export const roleLabels: Record<Role, string> = { admin: "Administrador", diretoria: "Diretoria", financeiro: "Financeiro", engenharia: "Engenharia", comercial: "Comercial", compras: "Compras", consulta: "Consulta" };
export const statusLabels: Record<EntryStatus, string> = { rascunho: "Rascunho", pendente: "Pendente", pago: "Pago", recebido: "Recebido", cancelado: "Cancelado", vencido: "Vencido" };
export const isSettled = (entry: FinancialEntry) => entry.status === "pago" || entry.status === "recebido";
export const dateAtNoon = (value: string) => new Date(`${value}T12:00:00`);
export const daysUntil = (value: string) => { const now = new Date(); now.setHours(12, 0, 0, 0); return Math.ceil((dateAtNoon(value).getTime() - now.getTime()) / 86400000); };
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).map((part) => part[0]).slice(0, 2).join("").toUpperCase();
export const canAdmin = (role: Role) => role === "admin" || role === "diretoria";
export const canWriteFinance = (role: Role) => ["admin", "diretoria", "financeiro", "compras"].includes(role);
export const sumEntries = (entries: FinancialEntry[], type: "entrada" | "saida", settled?: boolean) => entries.filter((entry) => entry.type === type && (settled === undefined || isSettled(entry) === settled)).reduce((total, entry) => total + Number(entry.amount), 0);
export const downloadCsv = (filename: string, headers: string[], rows: Array<Array<string | number | null | undefined>>) => {
  const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
  const csv = "\ufeff" + [headers, ...rows].map((row) => row.map(escape).join(";")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename; anchor.click(); URL.revokeObjectURL(url);
};
