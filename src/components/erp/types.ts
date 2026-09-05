import type { Session } from "@supabase/supabase-js";

export type Role = "admin" | "diretoria" | "financeiro" | "engenharia" | "comercial" | "compras" | "consulta" | "gestor_crm" | "sdr" | "corretor" | "marketing";
export type EntryType = "entrada" | "saida";
export type EntryStatus = "rascunho" | "pendente" | "pago" | "recebido" | "cancelado" | "vencido";
export type ApprovalStatus = "rascunho" | "pendente" | "aprovado" | "rejeitado";
export type CashRiskLevel = "baixo" | "medio" | "alto" | "critico";
export type TreatmentStatus = "nao_aplicavel" | "recomendado" | "em_negociacao" | "acordo_firmado" | "concluido";
export type ViewId = "dashboard" | "arisa" | "insights" | "crm" | "posvenda" | "financeiro" | "caixa" | "parceiros" | "obras" | "compras" | "contratos_operacionais" | "rh" | "documentos" | "aprovacoes" | "centros" | "cadastros" | "projetos" | "usuarios" | "relatorios" | "auditoria" | "configuracoes";

export interface Organization { id: string; name: string; trade_name: string | null; document: string | null; currency: string; }
export interface Membership { id: string; organization_id: string; user_id: string; role: Role; active: boolean; permissions: Record<string, boolean>; }
export interface Profile { id: string; full_name: string | null; email?: string | null; role: Role; avatar_path?: string | null; }
export interface CostCenter { id: string; organization_id: string; code: string; name: string; center_type: string; budget: number | null; active: boolean; }
export interface RevenueCenter { id: string; organization_id: string; code: string | null; name: string; center_type: string; revenue_goal: number | null; active: boolean; }
export interface Category { id: string; organization_id: string; code: string; name: string; movement_type: EntryType | "ambos"; active: boolean; }
export interface BankAccount { id: string; organization_id: string; name: string; bank_name: string | null; account_type: string; agency: string | null; account_number: string | null; initial_balance: number; active: boolean; }
export interface Contact { id: string; organization_id: string; contact_type: string; name: string; trade_name: string | null; document: string | null; email: string | null; phone: string | null; preferred_channel?: string | null; marketing_consent_status?: "unknown" | "granted" | "denied" | "revoked"; marketing_consent_at?: string | null; marketing_consent_source?: string | null; data_processing_basis?: "consent" | "pre_contract" | "contract" | "legitimate_interest" | "legal_obligation" | "not_defined" | null; do_not_contact_at?: string | null; postal_code?: string | null; street?: string | null; address_number?: string | null; complement?: string | null; neighborhood?: string | null; city: string | null; state: string | null; country?: string | null; person_type?: string | null; rg_ie?: string | null; birth_date?: string | null; nationality?: string | null; marital_status?: string | null; property_regime?: string | null; occupation?: string | null; monthly_income?: number | null; spouse_name?: string | null; spouse_document?: string | null; notes: string | null; active: boolean; }
export interface Project { id: string; organization_id: string; code: string; name: string; city: string | null; state: string | null; status: string; total_budget: number | null; start_date: string | null; end_date: string | null; active: boolean; }
export interface FinancialEntry { id: string; organization_id: string; user_id: string; created_by: string | null; type: EntryType; description: string; category: string; category_id: string | null; cost_center_id: string | null; revenue_center_id?: string | null; bank_account_id: string | null; contact_id: string | null; project_id: string | null; amount: number; due_date: string; issue_date: string | null; competence_date: string | null; scheduled_payment_date: string | null; settlement_date: string | null; status: EntryStatus; approval_status: ApprovalStatus; payment_method: string | null; document_number: string | null; installment_number: number; installment_total: number; recurring: boolean; recurrence_rule: string | null; notes: string | null; created_at: string; updated_at: string; cash_risk?: boolean; cash_risk_level?: CashRiskLevel; projected_balance?: number | null; recommended_due_date?: string | null; risk_reason?: string | null; treatment_status?: TreatmentStatus; treatment_notes?: string | null; open_amount?: number; original_amount?: number; is_provision?: boolean; payment_blocked?: boolean; payment_block_reason?: string | null; payment_release_status?: "nao_aplicavel" | "bloqueado_documentos" | "liberado" | "reconciliado" | "cancelado"; }
export interface ApprovalRequest { id: string; organization_id: string; entry_id: string; requested_by: string; assigned_to: string | null; status: "pendente" | "aprovado" | "rejeitado" | "cancelado"; comment: string | null; reason?: string | null; risk_snapshot?: Record<string, unknown> | null; recommended_due_date?: string | null; decided_at: string | null; created_at: string; }
export interface Invitation { id: string; organization_id: string; email: string; full_name: string | null; role: Role; accepted_at: string | null; expires_at: string; created_at: string; }
export interface AuditLog { id: number; organization_id: string; user_id: string | null; action: string; entity: string; entity_id: string | null; old_data: unknown; new_data: unknown; created_at: string; }
export interface DocumentAttachment { id: string; organization_id: string; entity_type: string; entity_id: string | null; document_type: string; file_name: string; storage_path: string; mime_type: string | null; size_bytes: number | null; notes: string | null; uploaded_by: string | null; created_at: string; }
export interface PurchaseRequest { id: string; organization_id: string; request_type: "material" | "servico" | "misto"; title: string; description: string | null; supplier_contact_id: string | null; project_id: string | null; cost_center_id: string | null; requested_by: string; needed_by: string | null; payment_due_date: string | null; recommended_payment_date: string | null; estimated_total: number; cash_risk: boolean; cash_risk_level: CashRiskLevel; projected_balance: number | null; status: "rascunho" | "submetida" | "aprovada" | "rejeitada" | "contratada" | "recebida" | "cancelada"; approval_required: boolean; approved_by: string | null; approved_at: string | null; rejection_reason: string | null; financial_entry_id: string | null; created_at: string; updated_at: string; }
export interface PurchaseRequestItem { id: string; purchase_request_id: string; description: string; quantity: number; unit: string | null; unit_price: number; total: number; notes: string | null; }
export interface HrEmployee { id: string; organization_id: string; full_name: string; document: string | null; registration_number: string | null; email: string | null; phone: string | null; job_title: string | null; department: string | null; cost_center_id: string | null; admission_date: string; termination_date: string | null; employment_type: "clt" | "pj" | "estagio" | "temporario" | "diretor"; base_salary: number; employer_charge_rate: number; fgts_rate: number; vacation_accrual_rate: number; thirteenth_accrual_rate: number; benefits_monthly: number; active: boolean; notes: string | null; created_at: string; updated_at: string; }
export interface HrEvent { id: string; organization_id: string; employee_id: string; event_type: "adiantamento" | "ferias" | "decimo_terceiro" | "bonus" | "desconto" | "afastamento" | "desligamento" | "outro"; reference_date: string; due_date: string | null; amount: number; status: "previsto" | "aprovado" | "pago" | "cancelado"; cash_flow_impact: boolean; notes: string | null; created_by: string | null; approved_by: string | null; approved_at: string | null; financial_entry_id: string | null; created_at: string; }
export interface HrPayrollRun { id: string; organization_id: string; reference_month: string; payment_date: string; status: "rascunho" | "calculada" | "aprovada" | "paga" | "cancelada"; gross_total: number; charges_total: number; benefits_total: number; advances_total: number; net_total: number; projected_cash_balance: number | null; recommended_payment_date: string | null; cash_risk: boolean; approved_by: string | null; approved_at: string | null; created_by: string | null; financial_entry_id: string | null; created_at: string; updated_at: string; }
export interface HrPayrollItem { id: string; payroll_run_id: string; employee_id: string; base_salary: number; variable_earnings: number; benefits: number; employer_charges: number; advances: number; deductions: number; net_amount: number; notes: string | null; }
export interface CrmRecord { id: string; organization_id: string; contact_id: string | null; person_name: string; company_name: string | null; email: string | null; phone: string | null; project_id: string | null; product_id?: string | null; lead_source_id?: string | null; originated_at?: string | null; stage: string; record_status: "aberta" | "ganha" | "perdida" | "arquivada"; source: string | null; estimated_value: number; probability: number; expected_close_date: string | null; next_action_at: string | null; owner_user_id: string | null; notes: string | null; created_by: string | null; created_at: string; updated_at: string; pipeline_id?: string | null; stage_id?: string | null; team_id?: string | null; sdr_user_id?: string | null; broker_user_id?: string | null; campaign_id?: string | null; lead_score?: number; temperature?: "frio" | "morno" | "quente"; priority?: "baixa" | "normal" | "alta" | "urgente"; source_channel?: string | null; utm_source?: string | null; utm_medium?: string | null; utm_campaign?: string | null; utm_content?: string | null; landing_page?: string | null; last_contact_at?: string | null; first_response_at?: string | null; sla_due_at?: string | null; stagnation_at?: string | null; attempts?: number; tags?: string[]; budget_min?: number | null; budget_max?: number | null; preferred_area_min?: number | null; preferred_area_max?: number | null; preferred_city?: string | null; financing_interest?: boolean; payment_capacity?: number | null; lost_reason?: string | null; loss_reason_id?: string | null; converted_at?: string | null; person_type?: string; cpf_cnpj?: string | null; rg_ie?: string | null; issuing_authority?: string | null; birth_date?: string | null; nationality?: string | null; marital_status?: string | null; property_regime?: string | null; occupation?: string | null; monthly_income?: number | null; spouse_name?: string | null; spouse_document?: string | null; spouse_email?: string | null; spouse_phone?: string | null; postal_code?: string | null; street?: string | null; address_number?: string | null; complement?: string | null; neighborhood?: string | null; city?: string | null; state?: string | null; country?: string | null; buyer_profile_completed_at?: string | null; }
export interface CrmAction { id: string; organization_id: string; crm_record_id: string; action_type: string; subject: string; scheduled_at: string | null; completed_at: string | null; action_status: "pendente" | "concluida" | "cancelada"; notes: string | null; created_by: string | null; created_at: string; channel?: string | null; outcome?: string | null; duration_minutes?: number | null; assigned_to?: string | null; automation_id?: string | null; template_id?: string | null; metadata?: Record<string, unknown>; }
export interface ConstructionWorkPackage {
  id: string;
  organization_id: string;
  project_id: string;
  parent_id: string | null;
  code: string;
  package_code: string | null;
  name: string;
  description: string | null;
  discipline: string;
  phase: string;
  status: string;
  responsible_user_id: string | null;
  cost_center_id: string | null;
  priority: string;
  planned_start: string | null;
  planned_end: string | null;
  actual_start: string | null;
  actual_end: string | null;
  weight_pct: number;
  planned_progress: number;
  actual_progress: number;
  budget_amount: number;
  forecast_amount: number;
  committed_amount: number;
  measured_amount: number;
  paid_amount: number;
  notes: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  wbs_code: string | null;
  template_code: string | null;
  template_item_key: string | null;
  sort_order: number;
  is_summary: boolean;
}
export interface ConstructionEapTemplate {
  template_code: string;
  name: string;
  description: string;
  category: string;
  icon: string;
  estimated_duration_days: number;
  version: number;
  sort_order: number;
  active: boolean;
  created_at: string;
}
export interface ConstructionEapTemplateItem {
  template_code: string;
  item_key: string;
  parent_item_key: string | null;
  wbs_code: string;
  name: string;
  description: string | null;
  discipline: string;
  phase: string;
  sequence: number;
  start_offset_days: number;
  duration_days: number;
  weight_pct: number;
  budget_pct: number;
  priority: string;
  is_summary: boolean;
}
export interface FuelRequest {
  id: string;
  organization_id: string;
  link_id: string | null;
  client_request_id: string | null;
  request_code: string;
  project_id: string | null;
  contract_id: string | null;
  contract_item_id: string | null;
  requester_name: string;
  requester_document: string | null;
  requester_phone: string | null;
  driver_name: string | null;
  vehicle_identifier: string | null;
  plate_identifier: string | null;
  equipment_identifier: string | null;
  fuel_type: string;
  requested_liters: number;
  approved_liters: number | null;
  supplied_liters: number;
  odometer: number | null;
  hour_meter: number | null;
  purpose: string;
  needed_at: string | null;
  notes: string | null;
  location_text: string | null;
  latitude: number | null;
  longitude: number | null;
  location_accuracy: number | null;
  status: string;
  public_submission: boolean;
  evidence: Record<string, unknown>;
  created_by: string | null;
  submitted_at: string;
  approved_by: string | null;
  approved_at: string | null;
  decision_notes: string | null;
  created_at: string;
  updated_at: string;
  station_contact_id: string | null;
  estimated_unit_price: number | null;
  planned_due_date: string | null;
  category_id: string | null;
  cost_center_id: string | null;
  provision_financial_entry_id: string | null;
  document_workflow_status: string;
}
export interface FuelDispense {
  id: string;
  organization_id: string;
  request_id: string;
  dispense_code: string;
  liters: number;
  unit_price: number;
  total_amount: number | null;
  odometer: number | null;
  hour_meter: number | null;
  station_contact_id: string | null;
  receipt_attachment_id: string | null;
  dispensed_by: string | null;
  dispensed_at: string;
  notes: string | null;
  created_at: string;
}
export interface FuelRequestDocument {
  id: string;
  organization_id: string;
  request_id: string;
  attachment_id: string;
  document_code: string;
  document_type: string;
  revision: number;
  status: string;
  is_current: boolean;
  fiscal_number: string | null;
  fiscal_date: string | null;
  fiscal_amount: number | null;
  metadata: Record<string, unknown>;
  submitted_by: string;
  submitted_at: string;
  reviewed_by: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  supersedes_document_id: string | null;
  created_at: string;
  updated_at: string;
}
export interface OperationalContract {
  id: string;
  organization_id: string;
  supplier_contact_id: string;
  project_id: string | null;
  cost_center_id: string | null;
  category_id: string | null;
  purchase_request_id: string | null;
  contract_number: string;
  title: string;
  contract_type: string;
  scope: string | null;
  status: string;
  start_date: string;
  end_date: string | null;
  original_amount: number;
  current_amount: number;
  amendment_amount: number;
  retention_rate: number;
  advance_amortization_rate: number;
  indexer: string | null;
  adjustment_base_date: string | null;
  payment_terms: string | null;
  notes: string | null;
  responsible_user_id: string | null;
  created_by: string;
  approved_by: string | null;
  approved_at: string | null;
  decision_notes: string | null;
  created_at: string;
  updated_at: string;
  version: number;
  public_accepted_at: string | null;
  public_accepted_by_name: string | null;
  acceptance_document_hash: string | null;
  acceptance_evidence_hash: string | null;
  work_package_id: string | null;
}
export interface OperationalContractItem {
  id: string;
  organization_id: string;
  contract_id: string;
  purchase_request_item_id: string | null;
  line_number: number;
  code: string;
  description: string;
  item_type: string;
  measurement_method: string;
  unit: string;
  equipment_identifier: string | null;
  billing_basis: string | null;
  operator_included: boolean;
  fuel_included: boolean;
  maintenance_included: boolean;
  contracted_quantity: number;
  minimum_billable_quantity: number;
  unit_price: number;
  mobilization_amount: number;
  demobilization_amount: number;
  contracted_total: number | null;
  category_id: string | null;
  cost_center_id: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
  planned_due_date: string;
}
export interface ContractMeasurementPeriod {
  id: string;
  organization_id: string;
  contract_id: string;
  period_code: string;
  period_start: string;
  period_end: string;
  submission_deadline: string | null;
  expected_payment_date: string | null;
  status: string;
  notes: string | null;
  created_by: string;
  closed_by: string | null;
  closed_at: string | null;
  closing_notes: string | null;
  reopened_by: string | null;
  reopened_at: string | null;
  reopen_reason: string | null;
  created_at: string;
  updated_at: string;
  version: number;
}
export interface ContractMeasurement {
  id: string;
  organization_id: string;
  contract_id: string;
  measurement_number: number;
  measurement_code: string;
  measurement_period_id: string | null;
  work_package_id: string | null;
  period_start: string;
  period_end: string;
  requested_due_date: string | null;
  due_date: string | null;
  negotiated_due_date: string | null;
  recommended_due_date: string | null;
  payment_due_date: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  notes: string | null;
  status: string;
  document_workflow_status: string;
  gross_amount: number;
  additions_amount: number;
  discount_amount: number;
  glosa_amount: number;
  penalty_amount: number;
  retention_amount: number;
  tax_withholding_amount: number;
  advance_amortization_amount: number;
  dre_amount: number;
  net_amount: number;
  risk_snapshot: Record<string, unknown>;
  financial_entry_id: string | null;
  created_by: string;
  submitted_at: string;
  approved_by: string | null;
  approved_at: string | null;
  decided_by: string | null;
  decided_at: string | null;
  decision_notes: string | null;
  final_approved_by: string | null;
  final_approved_at: string | null;
  created_at: string;
  updated_at: string;
}
export interface ContractMeasurementItem {
  id: string;
  organization_id: string;
  measurement_id: string;
  contract_item_id: string;
  previous_quantity: number;
  reported_quantity: number;
  current_quantity: number;
  cumulative_quantity: number;
  unit_price_snapshot: number;
  unit_price: number | null;
  mobilization_amount: number;
  demobilization_amount: number;
  gross_amount: number | null;
  meter_start: number | null;
  meter_end: number | null;
  downtime_quantity: number;
  notes: string | null;
  created_at: string;
}
export interface Settings { organization_id: string; approval_threshold: number; require_approval: boolean; default_due_alert_days: number; require_cash_risk_approval?: boolean; minimum_cash_buffer?: number; forecast_horizon_days?: number; overdue_treatment_days?: number; procurement_approval_required?: boolean; salary_payment_day?: number; default_employer_charge_rate?: number; termination_reserve_rate?: number; document_max_size_mb?: number; otp_simulation_enabled?: boolean; otp_simulation_expires_at?: string | null; otp_simulation_updated_at?: string | null; otp_simulation_updated_by?: string | null; }
export interface ErpData { session: Session; organization: Organization; membership: Membership; profile: Profile | null; entries: FinancialEntry[]; costCenters: CostCenter[]; revenueCenters?: RevenueCenter[]; categories: Category[]; bankAccounts: BankAccount[]; contacts: Contact[]; projects: Project[]; members: Membership[]; profiles: Profile[]; invitations: Invitation[]; approvals: ApprovalRequest[]; auditLogs: AuditLog[]; settings: Settings; documents: DocumentAttachment[]; purchaseRequests: PurchaseRequest[]; purchaseItems: PurchaseRequestItem[]; hrEmployees: HrEmployee[]; hrEvents: HrEvent[]; hrPayrollRuns: HrPayrollRun[]; hrPayrollItems: HrPayrollItem[]; crmRecords: CrmRecord[]; crmActions: CrmAction[]; constructionWorkPackages: ConstructionWorkPackage[]; constructionEapTemplates: ConstructionEapTemplate[]; constructionEapTemplateItems: ConstructionEapTemplateItem[]; fuelRequests: FuelRequest[]; fuelDispenses: FuelDispense[]; fuelRequestDocuments: FuelRequestDocument[]; operationalContracts: OperationalContract[]; operationalContractItems: OperationalContractItem[]; contractMeasurementPeriods: ContractMeasurementPeriod[]; contractMeasurements: ContractMeasurement[]; contractMeasurementItems: ContractMeasurementItem[]; }
