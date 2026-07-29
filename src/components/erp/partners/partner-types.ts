export type PartnerKind =
  | "fornecedor"
  | "credor_financeiro"
  | "terrenista"
  | "parceiro"
  | "colaborador"
  | "beneficiario";

export type PartnerPaymentStatus =
  | "em_analise"
  | "previsto"
  | "programado"
  | "em_processamento"
  | "pago"
  | "suspenso";

export type PartnerNegotiationType =
  | "prorrogacao"
  | "parcelamento"
  | "antecipacao_desconto"
  | "compensacao"
  | "contestacao"
  | "outro";

export type PartnerNegotiationStatus =
  | "aberta"
  | "em_analise"
  | "contraproposta"
  | "aguardando_parceiro"
  | "aceita_pelo_parceiro"
  | "aprovada"
  | "rejeitada"
  | "cancelada"
  | "encerrada";

export interface PartnerPayment {
  id: string;
  publication_id: string;
  description: string;
  project_name: string | null;
  document_number: string | null;
  installment_number: number | null;
  installment_total: number | null;
  amount: number;
  issue_date: string | null;
  contractual_due_date: string;
  public_status: PartnerPaymentStatus;
  forecast_start: string | null;
  forecast_end: string | null;
  /**
   * Fonte financeira canônica. `scheduled_date` permanece como snapshot
   * compatível da publicação feita ao parceiro.
   */
  scheduled_payment_date: string | null;
  scheduled_date: string | null;
  processing_started_at: string | null;
  paid_on: string | null;
  paid_at: string | null;
  public_note: string | null;
  updated_at: string;
}

export interface PartnerNegotiationTerms {
  proposed_due_date?: string;
  proposed_installments?: number;
  proposed_discount_pct?: number;
  proposed_amount?: number;
  [key: string]: unknown;
}

export interface PartnerNegotiationMessage {
  id: string;
  sender_kind: "parceiro" | "equipe" | "sistema";
  sender_name: string | null;
  message_type:
    | "mensagem"
    | "proposta"
    | "contraproposta"
    | "decisao"
    | "sistema";
  body: string;
  terms_snapshot: PartnerNegotiationTerms;
  terms_version: number | null;
  created_at: string;
}

export interface PartnerNegotiation {
  id: string;
  financial_entry_id: string | null;
  type: PartnerNegotiationType;
  status: PartnerNegotiationStatus;
  subject: string;
  current_terms: PartnerNegotiationTerms;
  terms_version: number;
  opened_at: string;
  updated_at: string;
  messages: PartnerNegotiationMessage[];
}

export interface PartnerPaymentPortalPayload {
  organization: {
    name: string;
    trade_name: string | null;
  };
  partner: {
    name: string;
    trade_name: string | null;
    kind: PartnerKind;
  };
  access: {
    label: string | null;
    expires_at: string;
    token_hint: string;
  };
  payments: PartnerPayment[];
  negotiations: PartnerNegotiation[];
  policy: {
    forecast: string;
    scheduled: string;
    processing: string;
    paid: string;
  };
  landowner: LandownerPortalPayload | null;
  generated_at: string;
}

export interface LandownerSaleDetail {
  contract_number: string | null;
  unit_code: string;
  block_code: string;
  lot_number: string;
  area: number;
  sale_date: string;
  list_price: number;
  sale_price: number;
  discount_pct: number;
  down_payment: number;
  financed_amount: number;
  installments_count: number;
  monthly_interest_rate: number;
  indexer: string | null;
}

export interface LandownerRepassDetail {
  id: string;
  description: string;
  due_date: string;
  scheduled_payment_date: string | null;
  settlement_date: string | null;
  amount: number;
  status: string;
}

export interface LandownerWorkStage {
  id: string;
  code: string;
  name: string;
  status: string;
  weight_pct: number;
  planned_progress_pct: number;
  actual_progress_pct: number;
}

export interface LandownerPortalPublication {
  id: string;
  version: number;
  project: {
    id: string;
    code: string;
    name: string;
  };
  period: {
    start: string;
    end: string;
    calculated_at: string;
    position_note?: string;
  };
  public_note: string | null;
  published_at: string;
  summary?: {
    total_lots?: number;
    sold_lots?: number;
    available_lots?: number;
    not_sold_lots?: number;
    total_vgv?: number;
    sold_vgv?: number;
    sold_vgv_pct?: number;
    sales_in_period?: number;
    vso_pct?: number;
    vso_basis?: string;
  };
  sales_conditions?: {
    average_sale_price?: number;
    average_discount_pct?: number;
    average_installments?: number;
    average_down_payment_pct?: number;
    sales?: LandownerSaleDetail[];
  };
  delinquency?: {
    receivable_total: number;
    open_total: number;
    overdue_amount: number;
    overdue_installments: number;
    overdue_rate_pct: number;
    basis: string;
  };
  repasses?: {
    configured: boolean;
    contractual_percentage?: number;
    receipts_basis_amount?: number;
    contractual_entitlement?: number;
    contractual_balance?: number;
    overpaid_amount?: number;
    unprogrammed_amount?: number;
    paid_amount?: number;
    due_not_repassed?: number;
    total_not_repassed?: number;
    due_not_repassed_count?: number;
    basis?: string;
    entries?: LandownerRepassDetail[];
  };
  construction?: {
    actual_progress_pct: number;
    planned_progress_pct: number;
    deviation_pct: number;
    stage_count: number;
    source: string;
    stages: LandownerWorkStage[];
  };
}

export interface LandownerPortalPayload {
  publications: LandownerPortalPublication[];
  governance_note: string;
}
