import type { ViewId } from "../types";

type RelatedItemDefinition = {
  label: string;
  permission: string;
  parentPermission?: string;
  view: ViewId | "marketing";
  section?: string;
  tab?: string;
};

export type ActivityDeepLinkTarget = RelatedItemDefinition & {
  sourceType: string;
  recordId: string;
  href: string;
};

const relatedItemDefinitions: Record<string, RelatedItemDefinition> = {
  financial_entries: {
    label: "Abrir lançamento",
    permission: "financial.view",
    view: "financeiro",
  },
  approval_requests: {
    label: "Abrir aprovação",
    permission: "financial.approve",
    view: "aprovacoes",
  },
  purchase_requests: {
    label: "Abrir compra",
    permission: "procurement.view",
    view: "compras",
    tab: "solicitacoes",
  },
  construction_work_packages: {
    label: "Abrir etapa da obra",
    permission: "construction.view",
    view: "obras",
  },
  crm_records: {
    label: "Abrir lead",
    permission: "crm.view",
    view: "crm",
    section: "leads",
  },
  fuel_requests: {
    label: "Abrir abastecimento",
    permission: "fuel.view",
    parentPermission: "procurement.view",
    view: "compras",
    tab: "combustiveis",
  },
  contract_measurements: {
    label: "Abrir medição",
    permission: "contracts.view",
    view: "contratos_operacionais",
  },
  hr_events: {
    label: "Abrir evento de RH",
    permission: "hr.view",
    view: "rh",
    tab: "eventos",
  },
  post_sale_tickets: {
    label: "Abrir atendimento",
    permission: "post_sale.view",
    view: "posvenda",
    section: "tickets",
  },
  marketing_requests: {
    label: "Abrir solicitação",
    permission: "marketing.view",
    view: "marketing",
    section: "production",
  },
};

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function first(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function getActivityRelatedLink(
  sourceType: string | null | undefined,
  recordId: string | null | undefined,
): ActivityDeepLinkTarget | null {
  if (!sourceType || !recordId || !uuidPattern.test(recordId)) return null;
  const definition = relatedItemDefinitions[sourceType];
  if (!definition) return null;
  const parameters = new URLSearchParams({
    source: sourceType,
    record: recordId,
  });
  if (definition.view !== "marketing") {
    parameters.set("view", definition.view);
  }
  if (definition.section) parameters.set("section", definition.section);
  if (definition.tab) parameters.set("tab", definition.tab);
  const pathname = definition.view === "marketing" ? "/marketing" : "/";
  return {
    ...definition,
    sourceType,
    recordId,
    href: `${pathname}?${parameters.toString()}`,
  };
}

export function parseActivityDeepLink(
  searchParams: Record<string, string | string[] | undefined>,
) {
  return getActivityRelatedLink(
    first(searchParams.source),
    first(searchParams.record),
  );
}
