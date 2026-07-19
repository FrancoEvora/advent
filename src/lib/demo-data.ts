import type { FinancialEntry } from "./types";

const today = new Date();
const iso = (offset: number) => {
  const date = new Date(today);
  date.setDate(date.getDate() + offset);
  return date.toISOString().slice(0, 10);
};

export const demoEntries: FinancialEntry[] = [
  {
    id: "demo-1",
    user_id: "demo-user",
    type: "entrada",
    description: "Recebimento de parcelas — Solaris",
    category: "Vendas",
    amount: 185000,
    due_date: iso(-2),
    status: "recebido",
    notes: "Recebimentos consolidados do período.",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "demo-2",
    user_id: "demo-user",
    type: "saida",
    description: "Medição de infraestrutura urbana",
    category: "Obras",
    amount: 84200,
    due_date: iso(1),
    status: "pendente",
    notes: "Pagamento condicionado à aprovação da medição.",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "demo-3",
    user_id: "demo-user",
    type: "saida",
    description: "Campanha comercial de lançamento",
    category: "Marketing",
    amount: 28750,
    due_date: iso(3),
    status: "pendente",
    notes: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "demo-4",
    user_id: "demo-user",
    type: "entrada",
    description: "Repasse de parceiro investidor",
    category: "Investimentos",
    amount: 320000,
    due_date: iso(6),
    status: "pendente",
    notes: "Previsão contratual.",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "demo-5",
    user_id: "demo-user",
    type: "saida",
    description: "Folha e encargos administrativos",
    category: "Administrativo",
    amount: 58300,
    due_date: iso(9),
    status: "pendente",
    notes: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "demo-6",
    user_id: "demo-user",
    type: "entrada",
    description: "Venda de área comercial",
    category: "Vendas",
    amount: 450000,
    due_date: iso(18),
    status: "pendente",
    notes: "Entrada prevista no compromisso de compra e venda.",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];
