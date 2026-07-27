export type PartnerKind =
  | "fornecedor"
  | "credor_financeiro"
  | "terrenista"
  | "parceiro";

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
  generated_at: string;
}
