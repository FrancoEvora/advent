/** Read-only, session-scoped CRM export. No admin keys, persistence or database writes. */
export type ExportRow = Record<string, unknown>;
export type ExportColumn = { key: string; label: string; format?: string; width?: number };
export type ExportCell = string | number | null | { t: "n"; v: number; z: string };
export type ExportSheet = { name: string; columns: ExportColumn[]; rows: ExportCell[][] };
export type LeadPage = { rows: ExportRow[]; total: number | null };
export const EXPORT_PAGE_SIZE = 500;
const money = '"R$" #,##0.00';
const date = "dd/mm/yyyy";
const datetime = "dd/mm/yyyy hh:mm:ss";

const labels: Record<string, string> = {
  id: "ID do lead", organization_id: "ID da organização", person_name: "Nome", company_name: "Empresa / razão social",
  phone: "Telefone / WhatsApp", email: "E-mail", instagram_username: "Instagram", person_type: "Tipo de pessoa",
  cpf_cnpj: "CPF / CNPJ", rg_ie: "RG / inscrição estadual", issuing_authority: "Órgão emissor", birth_date: "Nascimento",
  nationality: "Nacionalidade", marital_status: "Estado civil", property_regime: "Regime de bens", occupation: "Profissão",
  monthly_income: "Renda mensal", spouse_name: "Nome do cônjuge", spouse_document: "Documento do cônjuge",
  spouse_email: "E-mail do cônjuge", spouse_phone: "Telefone do cônjuge", postal_code: "CEP", street: "Logradouro",
  address_number: "Número", complement: "Complemento", neighborhood: "Bairro", city: "Cidade", state: "UF", country: "País",
  record_status: "Status do cadastro", stage: "Etapa (código)", source: "Origem (cadastro)", source_channel: "Canal de origem",
  estimated_value: "Valor estimado", probability: "Probabilidade (%)", expected_close_date: "Previsão de fechamento",
  lead_score: "Pontuação do lead", temperature: "Temperatura", priority: "Prioridade", tags: "Etiquetas",
  budget_min: "Orçamento mínimo", budget_max: "Orçamento máximo", preferred_area_min: "Área mínima desejada (m²)",
  preferred_area_max: "Área máxima desejada (m²)", preferred_city: "Cidade de interesse", financing_interest: "Interesse em financiamento",
  payment_capacity: "Capacidade de pagamento", notes: "Observações", lost_reason: "Motivo da perda (texto)",
  utm_source: "UTM origem", utm_medium: "UTM meio", utm_campaign: "UTM campanha", utm_content: "UTM conteúdo", landing_page: "Página de cadastro",
  attempts: "Tentativas de contato", created_at: "Cadastro no Enterprise", originated_at: "Data de origem", updated_at: "Última atualização",
  next_action_at: "Próxima ação", last_contact_at: "Último contato", first_response_at: "Primeira resposta", sla_due_at: "Prazo do SLA",
  stagnation_at: "Data de estagnação", converted_at: "Data de conversão", buyer_profile_completed_at: "Ficha cadastral concluída em",
  instagram_consent: "Consentimento Instagram", instagram_consent_at: "Data do consentimento Instagram",
  instagram_consent_version: "Versão do consentimento Instagram", instagram_source: "Origem do Instagram",
  contact_id: "ID do contato vinculado", project_id: "ID do empreendimento", product_id: "ID do produto", pipeline_id: "ID do funil",
  stage_id: "ID da etapa", team_id: "ID da equipe", owner_user_id: "ID do responsável", sdr_user_id: "ID do SDR", broker_user_id: "ID do corretor",
  campaign_id: "ID da campanha", lead_source_id: "ID da origem", loss_reason_id: "ID do motivo de perda", created_by: "ID de quem cadastrou",
};
const moneyKeys = new Set(["monthly_income", "budget_min", "budget_max", "estimated_value", "payment_capacity"]);
const numberKeys = new Set(["probability", "lead_score", "attempts", "preferred_area_min", "preferred_area_max"]);
export const leadColumns: ExportColumn[] = Object.entries(labels).map(([key, label]) => ({
  key, label, width: ["notes", "landing_page"].includes(key) ? 48 : key === "person_name" ? 34 : 24,
  format: moneyKeys.has(key) ? money : key.endsWith("_at") ? datetime : ["birth_date", "expected_close_date"].includes(key) ? date : numberKeys.has(key) ? "0.##" : undefined,
}));
const contactLabels: Record<string, string> = {
  id: "ID do contato", organization_id: "ID da organização", name: "Nome do contato", trade_name: "Nome fantasia",
  contact_type: "Tipo de contato", person_type: "Tipo de pessoa", document: "CPF / CNPJ", rg_ie: "RG / inscrição estadual",
  email: "E-mail", phone: "Telefone", birth_date: "Nascimento", nationality: "Nacionalidade", marital_status: "Estado civil",
  property_regime: "Regime de bens", occupation: "Profissão", monthly_income: "Renda mensal", spouse_name: "Nome do cônjuge",
  spouse_document: "Documento do cônjuge", postal_code: "CEP", street: "Logradouro", address_number: "Número",
  complement: "Complemento", neighborhood: "Bairro", city: "Cidade", state: "UF", country: "País", notes: "Observações",
  active: "Contato ativo", preferred_channel: "Canal preferencial", marketing_consent_status: "Consentimento de marketing",
  marketing_consent_at: "Data do consentimento de marketing", marketing_consent_source: "Origem do consentimento de marketing",
  data_processing_basis: "Base de tratamento cadastrada", do_not_contact_at: "Não contatar desde", created_at: "Data do cadastro", updated_at: "Última atualização",
};
export const contactColumns: ExportColumn[] = Object.entries(contactLabels).map(([key, label]) => ({
  key, label, width: key === "notes" ? 48 : key === "name" ? 34 : 24,
  format: key === "monthly_income" ? money : key.endsWith("_at") ? datetime : key === "birth_date" ? date : undefined,
}));
export const relatedSources = [
  { table: "projects", field: "project_id", label: "Empreendimento", nameField: "name" },
  { table: "crm_products", field: "product_id", label: "Produto de interesse", nameField: "name" },
  { table: "crm_pipelines", field: "pipeline_id", label: "Funil", nameField: "name" },
  { table: "crm_stages", field: "stage_id", label: "Etapa do funil", nameField: "name" },
  { table: "crm_teams", field: "team_id", label: "Equipe", nameField: "name" },
  { table: "crm_campaigns", field: "campaign_id", label: "Campanha", nameField: "name" },
  { table: "crm_lead_sources", field: "lead_source_id", label: "Origem identificada", nameField: "name" },
  { table: "profiles", field: "owner_user_id", label: "Responsável", nameField: "full_name" },
  { table: "profiles", field: "sdr_user_id", label: "SDR", nameField: "full_name" },
  { table: "profiles", field: "broker_user_id", label: "Corretor", nameField: "full_name" },
] as const;
export type RelatedSource = (typeof relatedSources)[number];

/** Never stop at a short server page: the configured API cap may be below our page size. */
export async function readAllLeadPages(
  readPage: (afterId: string | null, first: boolean) => Promise<LeadPage>,
  progress: (loaded: number, total: number) => void = () => {},
  signal?: AbortSignal,
): Promise<ExportRow[]> {
  const rows: ExportRow[] = [];
  const seen = new Set<string>();
  let after: string | null = null;
  let total: number | null = null;
  for (;;) {
    signal?.throwIfAborted();
    const page = await readPage(after, total === null);
    signal?.throwIfAborted();
    if (total === null) {
      total = page.total;
      if (total === null || !Number.isSafeInteger(total) || total < 0) throw new Error("Não foi possível conferir o total de leads. Tente novamente.");
      if (total > 1048575) throw new Error("A base excede o limite de linhas de uma aba do Excel.");
    }
    for (const row of page.rows) {
      const id = typeof row.id === "string" ? row.id : "";
      if (!id || seen.has(id) || (after !== null && id <= after)) throw new Error("A paginação retornou registros inconsistentes. Nenhum arquivo foi gerado.");
      seen.add(id); rows.push(row); after = id;
    }
    progress(rows.length, total);
    if (rows.length > total) throw new Error("A base mudou durante a consulta. Gere o relatório novamente.");
    if (rows.length === total) return rows;
    if (page.rows.length === 0) throw new Error("A consulta ficou incompleta. Nenhum relatório parcial foi gerado; tente novamente.");
  }
}

function excelDate(value: unknown, format: string): ExportCell {
  if (typeof value !== "string" || !value) return value == null ? null : String(value);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  let timestamp: number;
  if (format === date) timestamp = Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate());
  else {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    }).formatToParts(parsed).map(part => [part.type, part.value]));
    timestamp = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second));
  }
  const serial = (timestamp - Date.UTC(1899, 11, 30)) / 86400000;
  return serial < 0 ? value : { t: "n", v: serial, z: format };
}

/** Strings remain strings, including leading '=', '+', '-' and '@'. Never create formula cells from data. */
export function formatExportValue(value: unknown, column: ExportColumn): ExportCell {
  if (value === null || value === undefined) return null;
  if (column.format === date || column.format === datetime) return excelDate(value, column.format);
  if (column.format && value !== "" && (typeof value === "number" || typeof value === "string")) {
    const number = Number(value);
    if (Number.isFinite(number)) return { t: "n", v: number, z: column.format };
  }
  if (typeof value === "boolean") return value ? "Sim" : "Não";
  if (Array.isArray(value)) return value.map(String).join(" | ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function buildLeadReport(
  records: ExportRow[], contacts: ExportRow[], resolved: Record<string, Record<string, string>>,
  context: { organization: string; generatedAt: string; sourceUrl: string; warnings: string[] },
): ExportSheet[] {
  const extended: ExportCell[][] = [];
  const makeRows = (rows: ExportRow[], columns: ExportColumn[]) => rows.map(row => columns.map(column => {
    const value = formatExportValue(row[column.key], column);
    if (typeof value !== "string" || value.length <= 30000) return value;
    for (let start = 0; start < value.length; start += 30000) extended.push([String(row.id), column.label, start / 30000 + 1, value.slice(start, start + 30000)]);
    return `${value.slice(0, 160)} […] Conteúdo integral na aba Textos extensos, pelo ID e campo.`;
  }));
  const firstKeys = ["person_name", "phone", "email", "instagram_username", "city", "state"];
  const columns = [...firstKeys.map(key => leadColumns.find(column => column.key === key)!), ...relatedSources.map(item => ({ key: `resolved_${item.field}`, label: item.label, width: 28 })), ...leadColumns.filter(column => !firstKeys.includes(column.key))];
  const enriched = records.map(row => ({ ...row, ...Object.fromEntries(relatedSources.map(item => [`resolved_${item.field}`, resolved[item.field]?.[String(row[item.field])] || (row[item.field] ? `ID: ${row[item.field]}` : null)])) }));
  const leadRows = makeRows(enriched, columns);
  const contactRows = makeRows(contacts, contactColumns);
  const summary: ExportCell[][] = [
    ["Organização", context.organization], ["Gerado em (horário de Brasília)", excelDate(context.generatedAt, datetime)],
    ["Fonte", context.sourceUrl], ["Leads exportados", records.length], ["Inclui arquivados", "Sim"],
    ["Leads arquivados", records.filter(row => row.record_status === "arquivada").length], ["Contatos vinculados exportados", contacts.length],
    ["Escopo", "Todos os registros do CRM permitidos à sessão, de todos os empreendimentos e status; sem filtros da tela."],
    ["Dados cadastrais", "A aba Leads preserva os valores do cadastro CRM. Dados do contato vinculado ficam em aba separada, unidos pelo ID do contato."],
    ["Campos vazios", "Não informados no cadastro; não foram inferidos ou substituídos por zero."],
    ["Datas", "Datas e horas convertidas para America/Sao_Paulo. A data de nascimento não sofre conversão de fuso."],
    ["Privacidade", "Uso interno. Contém dados pessoais. Gerado na sessão autenticada, sem publicação do arquivo no servidor."],
    ["Integridade", "Uma linha por ID de lead. Registros com o mesmo nome ou telefone são preservados. Total conferido na paginação."],
    ["Atualização", "Consulta realizada no momento da geração, com conferência do total antes do download; não é um backup transacional."],
    ...context.warnings.map(warning => ["Aviso", warning] as ExportCell[]),
  ];
  const dictionary = columns.map(column => [column.label, column.key, column.key.startsWith("resolved_") ? "Nome do cadastro relacionado; ID preservado quando o nome não está acessível." : "public.crm_records; valor original, sem inferência."]);
  const sheets: ExportSheet[] = [
    { name: "Resumo", columns: [{ key: "item", label: "Informação", width: 36 }, { key: "value", label: "Valor / descrição", width: 85 }], rows: summary },
    { name: "Leads", columns, rows: leadRows },
    { name: "Contatos vinculados", columns: contactColumns, rows: contactRows },
    { name: "Dicionário", columns: [{ key: "column", label: "Coluna", width: 38 }, { key: "field", label: "Campo de origem", width: 38 }, { key: "note", label: "Descrição", width: 85 }], rows: dictionary },
  ];
  if (extended.length) sheets.push({ name: "Textos extensos", columns: [{ key: "id", label: "ID", width: 38 }, { key: "field", label: "Campo", width: 32 }, { key: "part", label: "Parte", width: 12 }, { key: "text", label: "Conteúdo integral em partes", width: 85 }], rows: extended });
  return sheets;
}

export async function downloadLeadWorkbook(sheets: ExportSheet[], generatedAt: string, signal?: AbortSignal): Promise<string> {
  const XLSX = await import("xlsx");
  signal?.throwIfAborted();
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title: "Relatório de leads cadastrados", Author: "Évora Enterprise", Subject: "Cadastro completo dos leads — uso interno", CreatedDate: new Date(generatedAt) };
  for (const spec of sheets) {
    const sheet = XLSX.utils.aoa_to_sheet([spec.columns.map(column => column.label), ...spec.rows]);
    sheet["!cols"] = spec.columns.map(column => ({ wch: column.width || 24 }));
    sheet["!rows"] = [{ hpt: 30 }];
    if (spec.name !== "Resumo" && sheet["!ref"]) sheet["!autofilter"] = { ref: sheet["!ref"] };
    XLSX.utils.book_append_sheet(workbook, sheet, spec.name);
  }
  const stamp = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(generatedAt)).replace(/[^0-9]/g, "");
  const filename = `Evora_Enterprise_Leads_${stamp}.xlsx`;
  signal?.throwIfAborted();
  XLSX.writeFile(workbook, filename, { bookType: "xlsx", compression: true });
  return filename;
}
