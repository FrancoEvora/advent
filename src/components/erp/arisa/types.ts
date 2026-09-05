export type OperationStatus = "received" | "processing" | "needs_information" | "needs_decision" | "completed" | "failed" | "dismissed";
export type InputKind = "payable" | "bank_statement";
export type OperationFilter = "all" | "completed" | "needs_decision" | "needs_information" | "failed" | "processing";
export type JsonRecord = Record<string, unknown>;

export interface OperationItem {
  id: string;
  organization_id: string;
  input_kind: InputKind;
  storage_path: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  file_hash: string;
  status: OperationStatus;
  payload: JsonRecord;
  extracted: JsonRecord;
  outcome: JsonRecord;
  issues: string[];
  entry_id: string | null;
  created_at: string;
  updated_at: string;
  attempts: number;
  error_code: string | null;
  error_message: string | null;
}

export interface OperationPolicy {
  organization_id: string;
  auto_register_complete_documents: boolean;
  max_auto_amount: number;
}

export interface BankTransaction {
  id: string;
  organization_id: string;
  item_id: string;
  bank_account_id: string;
  line_number: number;
  external_id: string | null;
  transaction_date: string;
  amount: number;
  description: string;
  document_number: string | null;
  status: "unmatched" | "matched" | "ambiguous";
  matched_entry_id: string | null;
  candidate_count: number;
  match_reason: string | null;
}

export const OPERATION_LABELS: Record<OperationStatus, string> = {
  received: "Pronto para processar",
  processing: "Em processamento",
  needs_information: "Informação faltante",
  needs_decision: "Aguarda decisão",
  completed: "Concluído",
  failed: "Falha no processamento",
  dismissed: "Descartado",
};

export const PAYABLE_FIELDS = ["contact_id", "project_id", "cost_center_id", "category_id", "bank_account_id", "amount", "due_date", "issue_date", "document_number", "description", "supplier_name", "supplier_document"] as const;
export type PayableField = typeof PAYABLE_FIELDS[number];
export type PayableValues = Record<PayableField, string>;

export const FIELD_LABELS: Record<PayableField, string> = {
  contact_id: "Fornecedor", project_id: "Empreendimento", cost_center_id: "Centro de custo",
  category_id: "Categoria", bank_account_id: "Conta bancária", amount: "Valor (R$)",
  due_date: "Vencimento", issue_date: "Data de emissão", document_number: "Número do documento", description: "Descrição", supplier_name: "Emitente no documento", supplier_document: "CPF/CNPJ do emitente",
};

export function asRecord(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
}

export function stringValue(value: unknown): string {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

const ISSUE_LABELS: Record<string, string> = {
  MULTIPLE_INSTALLMENTS_REQUIRES_REVIEW: "O documento contém várias parcelas. Confira o valor e o vencimento da obrigação.",
  DUE_DATE_NOT_IN_DOCUMENT: "O vencimento não foi localizado no documento.",
  SUPPLIER_DOCUMENT_MISSING_OR_INVALID: "O CPF/CNPJ do emitente não foi confirmado. Confira o documento e o cadastro do fornecedor.",
  AMOUNT_NOT_CONFIRMED: "O valor da obrigação não foi confirmado.",
  AMOUNT_NOT_EVIDENCED: "Não foi encontrada evidência suficiente para confirmar o valor.",
  AMOUNT_EVIDENCE_MISMATCH: "O valor identificado diverge do trecho de origem. Confira o documento.",
  IMMEDIATE_PAYMENT_INDICATED_REQUIRES_REVIEW: "O documento indica pagamento à vista. Confira se a obrigação já foi paga.",
  NFE_ADJUSTMENT_OR_RETURN_REQUIRES_REVIEW: "A nota indica ajuste ou devolução. Confira a natureza da obrigação.",
  NFE_AUTHORIZATION_NOT_CONFIRMED: "A autorização da nota fiscal não foi confirmada no arquivo.",
  RECEIPT_DOES_NOT_CREATE_PAYABLE: "Comprovante de pagamento: não cria uma nova conta a pagar.",
  DOCUMENT_REQUIRES_REVIEW: "Confira o tipo de documento. Para cadastrar uma obrigação, envie a nota fiscal ou o boleto.",
};
export function operationIssue(value: string): string { return ISSUE_LABELS[value] || value; }

export const formatMoney = (value: number) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
export function formatDate(value: string | null | undefined, includeTime = false): string {
  if (!value) return "Não informado";
  const date = new Date(value.length === 10 ? `${value}T12:00:00Z` : value);
  if (Number.isNaN(date.getTime())) return "Data inválida";
  return new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", year: "numeric", ...(includeTime ? { hour: "2-digit", minute: "2-digit" } as const : {}) }).format(date);
}
