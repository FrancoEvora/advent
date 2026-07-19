export type EntryType = "entrada" | "saida";
export type EntryStatus = "pendente" | "pago" | "recebido";

export type FinancialEntry = {
  id: string;
  user_id: string;
  type: EntryType;
  description: string;
  category: string;
  amount: number;
  due_date: string;
  status: EntryStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
};

export type Profile = {
  id: string;
  full_name: string | null;
  role: string;
  created_at: string;
  updated_at: string;
};

export type AppView = "inicio" | "lancamentos" | "caixa" | "alertas" | "mais";
