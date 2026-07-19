import type { Session } from "@supabase/supabase-js";

export type Role = "admin" | "diretoria" | "financeiro" | "engenharia" | "comercial" | "compras" | "consulta";
export type EntryType = "entrada" | "saida";
export type EntryStatus = "rascunho" | "pendente" | "pago" | "recebido" | "cancelado" | "vencido";
export type ApprovalStatus = "rascunho" | "pendente" | "aprovado" | "rejeitado";
export type CashRiskLevel = "baixo" | "medio" | "alto" | "critico";
export type TreatmentStatus = "nao_aplicavel" | "recomendado" | "em_negociacao" | "acordo_firmado" | "concluido";
export type ViewId = "dashboard" | "financeiro" | "caixa" | "inadimplencia" | "aprovacoes" | "centros" | "cadastros" | "projetos" | "usuarios" | "relatorios" | "auditoria" | "configuracoes";

export interface Organization { id: string; name: string; trade_name: string | null; document: string | null; currency: string; }
export interface Membership { id: string; organization_id: string; user_id: string; role: Role; active: boolean; permissions: Record<string, boolean>; }
export interface Profile { id: string; full_name: string | null; email: string | null; role: Role; }
export interface CostCenter { id: string; organization_id: string; code: string; name: string; center_type: string; budget: number | null; active: boolean; }
export interface RevenueCenter { id: string; organization_id: string; code: string | null; name: string; center_type: string; revenue_goal: number | null; active: boolean; }
export interface Category { id: string; organization_id: string; code: string; name: string; movement_type: EntryType | "ambos"; active: boolean; }
export interface BankAccount { id: string; organization_id: string; name: string; bank_name: string | null; account_type: string; agency: string | null; account_number: string | null; initial_balance: number; active: boolean; }
export interface Contact { id: string; organization_id: string; contact_type: string; name: string; trade_name: string | null; document: string | null; email: string | null; phone: string | null; city: string | null; state: string | null; notes: string | null; active: boolean; }
export interface Project { id: string; organization_id: string; code: string; name: string; city: string | null; state: string | null; status: string; total_budget: number | null; start_date: string | null; end_date: string | null; active: boolean; }
export interface FinancialEntry {
  id: string; organization_id: string; user_id: string; created_by: string | null; type: EntryType; description: string;
  category: string; category_id: string | null; cost_center_id: string | null; revenue_center_id: string | null; bank_account_id: string | null;
  contact_id: string | null; project_id: string | null; amount: number; due_date: string; issue_date: string | null;
  competence_date: string | null; settlement_date: string | null; status: EntryStatus; approval_status: ApprovalStatus;
  payment_method: string | null; document_number: string | null; installment_number: number; installment_total: number;
  recurring: boolean; recurrence_rule: string | null; notes: string | null; created_at: string; updated_at: string;
  cash_risk: boolean; cash_risk_level: CashRiskLevel; projected_balance: number | null; recommended_due_date: string | null;
  risk_reason: string | null; treatment_status: TreatmentStatus; treatment_notes: string | null;
}
export interface ApprovalRequest { id: string; organization_id: string; entry_id: string; requested_by: string; assigned_to: string | null; status: "pendente" | "aprovado" | "rejeitado" | "cancelado"; comment: string | null; reason: string | null; risk_snapshot: Record<string, unknown> | null; recommended_due_date: string | null; decided_at: string | null; created_at: string; }
export interface Invitation { id: string; organization_id: string; email: string; full_name: string | null; role: Role; accepted_at: string | null; expires_at: string; created_at: string; }
export interface AuditLog { id: number; organization_id: string; user_id: string | null; action: string; entity: string; entity_id: string | null; old_data: unknown; new_data: unknown; created_at: string; }
export interface Settings { organization_id: string; approval_threshold: number; require_approval: boolean; default_due_alert_days: number; require_cash_risk_approval: boolean; minimum_cash_buffer: number; forecast_horizon_days: number; overdue_treatment_days: number; }

export interface ErpData {
  session: Session; organization: Organization; membership: Membership; profile: Profile | null;
  entries: FinancialEntry[]; costCenters: CostCenter[]; revenueCenters: RevenueCenter[]; categories: Category[]; bankAccounts: BankAccount[];
  contacts: Contact[]; projects: Project[]; members: Membership[]; profiles: Profile[]; invitations: Invitation[];
  approvals: ApprovalRequest[]; auditLogs: AuditLog[]; settings: Settings;
}
