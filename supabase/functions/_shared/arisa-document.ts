/** Bounded, deterministic financial document readers. No network, entity expansion or side effects. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_TRANSACTIONS = 500;
export type Obj = Record<string, unknown>;
export type PayableExtraction = {
  document_type: "invoice" | "boleto" | "receipt" | "contract" | "other";
  supplier_name: string | null; supplier_document: string | null; document_number: string | null;
  amount: number | null; due_date: string | null; issue_date: string | null; description: string | null;
  source_evidence: { amount: string | null; due_date: string | null; supplier_document: string | null };
  confidence: number; warnings: string[];
};
export type StatementTransaction = { external_id: string; posted_on: string; amount: number; description: string; document_reference?: string | null; counterparty_document?: string | null };
export type StatementExtraction = { document_type: "bank_statement"; transactions: StatementTransaction[]; bank_account_hint: string | null; warnings: string[] };
export class DocumentError extends Error {
  code: string;
  constructor(code: string) { super(code); this.name = "DocumentError"; this.code = code; }
}
export const isObject = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
function fail(code: string): never { throw new DocumentError(code); }
const clean = (v: unknown, max = 500): string | null => typeof v === "string" ? v.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").trim().slice(0, max) || null : null;

export function validTaxDocument(value: string | null): boolean {
  if (!value || !/^(?:\d{11}|\d{14})$/.test(value) || /^(\d)\1+$/.test(value)) return false;
  const numbers = [...value].map(Number);
  const digit = (base: number[], weights: number[]) => { const remainder = base.reduce((sum, n, i) => sum + n * weights[i], 0) % 11; return remainder < 2 ? 0 : 11 - remainder; };
  if (value.length === 11) return digit(numbers.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]) === numbers[9] && digit(numbers.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) === numbers[10];
  return digit(numbers.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === numbers[12] && digit(numbers.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === numbers[13];
}

export function isoDate(value: string, ofx = false): string {
  let date = value.trim();
  if (ofx) {
    if (!/^\d{8}(?:\d{6}(?:\.\d{1,6})?(?:\[[^\]\r\n]{1,30}\])?)?$/.test(date)) fail("INVALID_DATE");
    date = `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  } else if (/^\d{2}\/\d{2}\/\d{4}$/.test(date)) {
    date = `${date.slice(6)}-${date.slice(3, 5)}-${date.slice(0, 2)}`;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < "1900-01-01" || date > "2199-12-31") fail("INVALID_DATE");
  const parsed = new Date(`${date}T12:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) fail("INVALID_DATE");
  return date;
}

/** Rejects ambiguous grouping/precision instead of guessing a bank amount. */
export function money(value: string, decimalDotOnly = false): number {
  let text = value.trim().replace(/^R\$\s*/i, "").replace(/\s+/g, "");
  let direction = 0;
  if (/[DC]$/i.test(text)) { direction = /D$/i.test(text) ? -1 : 1; text = text.slice(0, -1); }
  const parentheses = /^\(.+\)$/.test(text);
  if (parentheses) text = `-${text.slice(1, -1)}`;
  if (decimalDotOnly) {
    if (!/^[+-]?\d+(?:\.\d{1,2})?$/.test(text)) fail("INVALID_AMOUNT");
  } else if (/^[+-]?\d{1,3}(?:\.\d{3})+,\d{2}$/.test(text)) {
    text = text.replace(/\./g, "").replace(",", ".");
  } else if (/^[+-]?\d{1,3}(?:,\d{3})+\.\d{2}$/.test(text)) {
    text = text.replace(/,/g, "");
  } else if (/^[+-]?\d+(?:[.,]\d{1,2})?$/.test(text)) {
    text = text.replace(",", ".");
  } else fail("AMBIGUOUS_AMOUNT");
  let amount = Number(text);
  if (!Number.isFinite(amount) || Math.abs(amount) > 999_999_999.99) fail("INVALID_AMOUNT");
  if (direction) {
    if ((text.startsWith("-") && direction === 1) || (text.startsWith("+") && direction === -1)) fail("CONFLICTING_AMOUNT_DIRECTION");
    amount = Math.abs(amount) * direction;
  }
  return Math.round(amount * 100) / 100;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>))].map(b => b.toString(16).padStart(2, "0")).join("");
}
export function decodeDocument(bytes: Uint8Array): string {
  if (!bytes.length || bytes.length > MAX_FILE_BYTES) fail("FILE_SIZE_INVALID");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { text = new TextDecoder("windows-1252").decode(bytes); }
  if (text.includes("\0")) fail("BINARY_DOCUMENT_UNSUPPORTED");
  return text.replace(/^\uFEFF/, "");
}

function csvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = []; let row: string[] = [], field = "", quoted = false, closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; closed = true; } }
      else field += c;
    } else if (c === '"') { if (field || closed) fail("CSV_INVALID_QUOTES"); quoted = true; }
    else if (c === delimiter) { row.push(field); field = ""; closed = false; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); if (row.some(v => v.trim())) rows.push(row); row = []; field = ""; closed = false;
      if (rows.length > MAX_TRANSACTIONS + 1) fail("TOO_MANY_TRANSACTIONS");
    } else { if (closed && c.trim()) fail("CSV_INVALID_QUOTES"); if (!closed) field += c; }
    if (field.length > 4000 || row.length > 40) fail("CSV_FIELD_TOO_LARGE");
  }
  if (quoted) fail("CSV_INVALID_QUOTES");
  row.push(field); if (row.some(v => v.trim())) rows.push(row);
  return rows;
}
const headerKey = (v: string) => v.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]/g, "");
const ALIASES = {
  date: ["data", "date", "datamovimento", "datalancamento", "postedon"],
  amount: ["valor", "amount", "valorlancamento", "valortransacao"],
  description: ["descricao", "description", "historico", "memo", "lancamento"],
  id: ["id", "fitid", "identificador", "externalid", "idtransacao"],
  debit: ["debito", "debit", "saida"], credit: ["credito", "credit", "entrada"],
  direction: ["tipo", "dc", "natureza", "debitocredito"],
  reference: ["documento", "documentreference", "referencia", "numerodocumento"],
  counterparty: ["cpfcnpj", "cnpjcpf", "counterpartydocument"],
};
export async function parseStatementCsv(text: string): Promise<StatementExtraction> {
  const headerLine = text.split(/\r?\n/)[0];
  const possible = [";", ",", "\t"].map(delimiter => { try { return { delimiter, headers: csvRows(headerLine, delimiter)[0] || [] }; } catch { return { delimiter, headers: [] }; } })
    .filter(v => v.headers.some(h => ALIASES.date.includes(headerKey(h))) && v.headers.some(h => [...ALIASES.amount, ...ALIASES.debit].includes(headerKey(h))));
  if (possible.length !== 1) fail("CSV_HEADER_REQUIRED");
  const rows = csvRows(text, possible[0].delimiter); const headers = rows.shift()!.map(headerKey);
  const col = (key: keyof typeof ALIASES): number => {
    const matches = headers.flatMap((header, index) => ALIASES[key].includes(header) ? [index] : []);
    if (matches.length > 1) fail("CSV_AMBIGUOUS_COLUMNS");
    return matches[0] ?? -1;
  };
  const columns = { date: col("date"), amount: col("amount"), description: col("description"), id: col("id"), debit: col("debit"), credit: col("credit"), direction: col("direction"), reference: col("reference"), counterparty: col("counterparty") };
  if (columns.date < 0 || columns.description < 0 || (columns.amount < 0 && (columns.debit < 0 || columns.credit < 0))) fail("CSV_HEADER_REQUIRED");
  if (columns.amount >= 0 && (columns.debit >= 0 || columns.credit >= 0)) fail("CSV_AMBIGUOUS_COLUMNS");
  if (!rows.length || rows.length > MAX_TRANSACTIONS) fail(rows.length ? "TOO_MANY_TRANSACTIONS" : "EMPTY_STATEMENT");
  const transactions: StatementTransaction[] = []; const ids = new Set<string>(); const occurrences = new Map<string, number>();
  let allCreditsExplicit = true;
  for (const row of rows) {
    if (row.length !== headers.length) fail("CSV_COLUMN_MISMATCH");
    const get = (key: keyof typeof columns) => (row[columns[key]] || "").trim();
    const posted_on = isoDate(get("date")); const description = clean(get("description"), 500);
    if (!description) fail("TRANSACTION_DESCRIPTION_REQUIRED");
    let amount: number;
    if (columns.amount >= 0) amount = money(get("amount"));
    else {
      const debit = get("debit") ? money(get("debit")) : 0, credit = get("credit") ? money(get("credit")) : 0;
      if (debit < 0 || credit < 0 || (debit && credit)) fail("CONFLICTING_AMOUNT_DIRECTION");
      amount = credit - debit;
    }
    const direction = headerKey(get("direction"));
    if (direction) {
      if (!["d", "c", "debito", "credito", "debit", "credit", "entrada", "saida"].includes(direction)) fail("TRANSACTION_DIRECTION_INVALID");
      const debit = ["d", "debito", "debit", "saida"].includes(direction);
      if ((!debit && amount < 0) || (debit && /^\+/.test(get("amount")))) fail("CONFLICTING_AMOUNT_DIRECTION");
      amount = Math.abs(amount) * (debit ? -1 : 1);
    }
    if (!amount) fail("ZERO_TRANSACTION");
    if (amount > 0 && columns.credit < 0 && !direction && !/^\+/.test(get("amount")) && !/C$/i.test(get("amount"))) allCreditsExplicit = false;
    const reference = clean(get("reference"), 160), counterparty = clean(get("counterparty"), 30)?.replace(/\D/g, "") || null;
    if (counterparty && ![11, 14].includes(counterparty.length)) fail("INVALID_COUNTERPARTY_DOCUMENT");
    const canonical = JSON.stringify([posted_on, amount.toFixed(2), description, reference, counterparty]);
    const occurrence = (occurrences.get(canonical) || 0) + 1; occurrences.set(canonical, occurrence);
    const external_id = get("id") || `csv:${await sha256(new TextEncoder().encode(`${canonical}:${occurrence}`))}`;
    if (external_id.length > 180 || ids.has(external_id)) fail("DUPLICATE_TRANSACTION_ID");
    ids.add(external_id); transactions.push({ external_id, posted_on, amount, description, document_reference: reference, counterparty_document: counterparty });
  }
  if (!transactions.some(transaction => transaction.amount < 0) && !allCreditsExplicit) fail("CSV_DIRECTION_REQUIRED");
  return { document_type: "bank_statement", transactions, bank_account_hint: null, warnings: [] };
}

function rejectEntities(text: string) { if (/<!DOCTYPE|<!ENTITY|<!\[CDATA\[/i.test(text)) fail("XML_UNSAFE_DECLARATION"); }
function entities(text: string): string {
  if (/&(?!amp;|lt;|gt;|quot;|apos;|#\d{1,7};|#x[0-9a-f]{1,6};)/i.test(text)) fail("XML_INVALID_ENTITY");
  return text.replace(/&(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);/gi, (_, key: string) => {
    if (key.startsWith("#")) {
      const point = key.startsWith("#x") ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10);
      if (point < 32 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff)) fail("XML_INVALID_ENTITY");
      return String.fromCodePoint(point);
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[key.toLowerCase()];
  });
}
export function parseStatementOfx(text: string): StatementExtraction {
  rejectEntities(text);
  if (!/<OFX(?:\s[^>]*)?>/i.test(text)) fail("OFX_INVALID");
  const accountBlocks = text.match(/<(?:BANKMSGSRSV1|CREDITCARDMSGSRSV1)\b/gi) || [];
  const accountIds = [...text.matchAll(/<ACCTID>\s*([^<\r\n]+)/gi)].map(m => m[1].trim());
  if (accountBlocks.length !== 1 || accountIds.length !== 1) fail("OFX_SINGLE_ACCOUNT_REQUIRED");
  const currency = [...text.matchAll(/<CURDEF>\s*([^<\r\n]+)/gi)].map(m => m[1].trim().toUpperCase());
  if (currency.length !== 1 || currency[0] !== "BRL") fail("STATEMENT_CURRENCY_UNSUPPORTED");
  const blocks = [...text.matchAll(/<STMTTRN>\s*([\s\S]*?)<\/STMTTRN>/gi)];
  if (blocks.length !== (text.match(/<STMTTRN>/gi) || []).length) fail("OFX_INVALID_TRANSACTION");
  if (!blocks.length || blocks.length > MAX_TRANSACTIONS) fail(blocks.length ? "TOO_MANY_TRANSACTIONS" : "EMPTY_STATEMENT");
  const ids = new Set<string>();
  const transactions = blocks.map(block => {
    const value = (tag: string) => {
      const matches = [...block[1].matchAll(new RegExp(`<${tag}>\\s*([^<\\r\\n]*)`, "gi"))];
      if (matches.length > 1) fail("OFX_DUPLICATE_FIELD");
      return entities(matches[0]?.[1].trim() || "");
    };
    const external_id = value("FITID"), posted_on = isoDate(value("DTPOSTED"), true), amount = money(value("TRNAMT"), true);
    if (!external_id || external_id.length > 180 || ids.has(external_id)) fail("DUPLICATE_TRANSACTION_ID");
    if (!amount) fail("ZERO_TRANSACTION"); ids.add(external_id);
    const description = clean([value("NAME"), value("MEMO")].filter(Boolean).join(" · "), 500);
    if (!description) fail("TRANSACTION_DESCRIPTION_REQUIRED");
    return { external_id, posted_on, amount, description, document_reference: clean(value("CHECKNUM"), 160) };
  });
  return { document_type: "bank_statement", transactions, bank_account_hint: clean(accountIds[0], 100), warnings: [] };
}

type XmlNode = { name: string; text: string; children: XmlNode[] };
/** Strict small XML subset used by NF-e. Unknown external declarations are rejected, never resolved. */
function xmlTree(text: string): XmlNode {
  rejectEntities(text);
  const root: XmlNode = { name: "$", text: "", children: [] }; const stack = [root]; let end = 0, count = 0;
  const tokens = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<[^>]*>|[^<]+/g;
  for (const token of text.matchAll(tokens)) {
    if (token.index !== end) fail("XML_INVALID"); const part = token[0]; end += part.length;
    if (++count > 150000 || stack.length > 40) fail("XML_TOO_COMPLEX");
    if (part.startsWith("<!--") || part.startsWith("<?xml ")) continue;
    const close = part.match(/^<\/([A-Za-z_][\w.:-]*)\s*>$/);
    if (close) { if (stack.length < 2 || stack.pop()!.name !== close[1]) fail("XML_INVALID"); continue; }
    if (part.startsWith("<")) {
      const open = part.match(/^<([A-Za-z_][\w.:-]*)(?:\s+[A-Za-z_][\w.:-]*\s*=\s*(?:"[^"<]*"|'[^'<]*'))*\s*(\/?)>$/);
      if (!open) fail("XML_INVALID");
      const node: XmlNode = { name: open[1], text: "", children: [] }; stack[stack.length - 1].children.push(node);
      if (!open[2]) stack.push(node);
    } else stack[stack.length - 1].text += entities(part);
  }
  if (end !== text.length || stack.length !== 1 || root.children.length !== 1 || root.text.trim()) fail("XML_INVALID");
  return root.children[0];
}
const localName = (node: XmlNode) => node.name.split(":").pop();
const children = (node: XmlNode, name: string) => node.children.filter(child => localName(child) === name);
const one = (node: XmlNode, name: string): XmlNode | null => { const nodes = children(node, name); if (nodes.length > 1) fail("XML_DUPLICATE_FIELD"); return nodes[0] || null; };
const value = (node: XmlNode | null, name: string) => { const child = node ? one(node, name) : null; if (child?.children.length) fail("XML_INVALID_FIELD"); return clean(child?.text, 1000); };

export function parseNfeXml(text: string): PayableExtraction {
  const root = xmlTree(text); const nfe = localName(root) === "nfeProc" ? one(root, "NFe") : localName(root) === "NFe" ? root : null;
  if (!nfe) fail("XML_NFE_REQUIRED"); const info = one(nfe, "infNFe"); if (!info) fail("XML_NFE_REQUIRED");
  const emit = one(info, "emit"), ide = one(info, "ide"), total = one(info, "total"), charge = one(info, "cobr");
  const amountText = value(total ? one(total, "ICMSTot") : null, "vNF");
  const supplierDocument = value(emit, "CNPJ") || value(emit, "CPF");
  const duplicates = charge ? children(charge, "dup") : [];
  const warnings: string[] = [];
  let amount = amountText ? money(amountText, true) : null, due_date: string | null = null, amountEvidence = amountText;
  if (duplicates.length > 1) { warnings.push("MULTIPLE_INSTALLMENTS_REQUIRES_REVIEW"); amount = null; }
  else if (duplicates.length === 1) {
    const installmentAmount = value(duplicates[0], "vDup"), due = value(duplicates[0], "dVenc");
    if (installmentAmount) { amount = money(installmentAmount, true); amountEvidence = installmentAmount; }
    if (due) due_date = isoDate(due);
  }
  const issue = value(ide, "dhEmi") || value(ide, "dEmi");
  const issue_date = issue ? isoDate(issue.slice(0, 10)) : null;
  if (!due_date) warnings.push("DUE_DATE_NOT_IN_DOCUMENT");
  if (!validTaxDocument(supplierDocument)) warnings.push("SUPPLIER_DOCUMENT_MISSING_OR_INVALID");
  if (!amount || amount < 0) { amount = null; warnings.push("AMOUNT_NOT_CONFIRMED"); }
  const payment = one(info, "pag");
  const details = payment ? children(payment, "detPag") : [];
  if (details.some(detail => value(detail, "indPag") === "0" && value(detail, "tPag") !== "90")) warnings.push("IMMEDIATE_PAYMENT_INDICATED_REQUIRES_REVIEW");
  const purpose = value(ide, "finNFe");
  if (purpose && purpose !== "1") warnings.push("NFE_ADJUSTMENT_OR_RETURN_REQUIRES_REVIEW");
  const protocol = localName(root) === "nfeProc" ? one(root, "protNFe") : null;
  const protocolInfo = protocol ? one(protocol, "infProt") : null;
  const authorization = value(protocolInfo, "cStat");
  if (!authorization || authorization !== "100") warnings.push("NFE_AUTHORIZATION_NOT_CONFIRMED");
  return {
    document_type: "invoice", supplier_name: value(emit, "xNome"), supplier_document: supplierDocument,
    document_number: value(ide, "nNF"), amount, due_date, issue_date,
    description: clean(value(ide, "natOp"), 500),
    source_evidence: { amount: amountEvidence, due_date, supplier_document: supplierDocument },
    confidence: warnings.length ? 0.7 : 0.99, warnings,
  };
}

const nullable = { type: ["string", "null"] };
export const PAYABLE_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    document_type: { type: "string", enum: ["invoice", "boleto", "receipt", "contract", "other"] },
    supplier_name: nullable, supplier_document: nullable, document_number: nullable,
    amount: { type: ["number", "null"] }, due_date: nullable, issue_date: nullable, description: nullable,
    source_evidence: { type: "object", additionalProperties: false, properties: { amount: nullable, due_date: nullable, supplier_document: nullable }, required: ["amount", "due_date", "supplier_document"] },
    confidence: { type: "number" }, warnings: { type: "array", items: { type: "string" } },
    ambiguous_amount: { type: "boolean" }, multiple_installments: { type: "boolean" }, payment_already_made: { type: "boolean" },
  },
  required: ["document_type", "supplier_name", "supplier_document", "document_number", "amount", "due_date", "issue_date", "description", "source_evidence", "confidence", "warnings", "ambiguous_amount", "multiple_installments", "payment_already_made"],
};
export function validatePayableModel(raw: unknown): PayableExtraction {
  if (!isObject(raw) || !isObject(raw.source_evidence) || !["invoice", "boleto", "receipt", "contract", "other"].includes(String(raw.document_type))) fail("AI_INVALID_EXTRACTION");
  if (!Array.isArray(raw.warnings) || raw.warnings.some(v => typeof v !== "string") || typeof raw.confidence !== "number" || !Number.isFinite(raw.confidence) || [raw.ambiguous_amount, raw.multiple_installments, raw.payment_already_made].some(v => typeof v !== "boolean")) fail("AI_INVALID_EXTRACTION");
  const warnings = raw.warnings.map(v => clean(v, 200)).filter((v): v is string => !!v).slice(0, 20);
  let amount = typeof raw.amount === "number" && raw.amount > 0 && raw.amount <= 999_999_999.99 && Number.isFinite(raw.amount) && Math.abs(raw.amount * 100 - Math.round(raw.amount * 100)) < 0.00001 ? raw.amount : null;
  const evidence = { amount: clean(raw.source_evidence.amount), due_date: clean(raw.source_evidence.due_date), supplier_document: clean(raw.source_evidence.supplier_document) };
  if (!amount || !evidence.amount) { amount = null; warnings.push("AMOUNT_NOT_EVIDENCED"); }
  else {
    const candidates = evidence.amount.match(/[+-]?\d[\d.,]*/g) || [];
    if (!candidates.some(candidate => { try { return money(candidate) === amount; } catch { return false; } })) { amount = null; warnings.push("AMOUNT_EVIDENCE_MISMATCH"); }
  }
  if (raw.ambiguous_amount || raw.multiple_installments) { amount = null; warnings.push(raw.multiple_installments ? "MULTIPLE_INSTALLMENTS_REQUIRES_REVIEW" : "AMBIGUOUS_AMOUNT_REQUIRES_REVIEW"); }
  const date = (key: "due_date" | "issue_date") => { try { return clean(raw[key]) ? isoDate(String(raw[key])) : null; } catch { warnings.push(`${key.toUpperCase()}_INVALID`); return null; } };
  let due_date = date("due_date");
  if (!evidence.due_date || !(evidence.due_date.match(/\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4}/g) || []).some(candidate => { try { return isoDate(candidate) === due_date; } catch { return false; } })) due_date = null;
  if (!due_date) warnings.push("DUE_DATE_NOT_IN_DOCUMENT");
  const supplier_document = clean(raw.supplier_document, 40)?.replace(/\D/g, "") || null;
  if (!validTaxDocument(supplier_document) || !supplier_document || !evidence.supplier_document?.replace(/\D/g, "").includes(supplier_document)) warnings.push("SUPPLIER_DOCUMENT_MISSING_OR_INVALID");
  const document_type = raw.payment_already_made ? "receipt" : raw.document_type as PayableExtraction["document_type"];
  if (document_type === "receipt") warnings.push("RECEIPT_DOES_NOT_CREATE_PAYABLE");
  if (document_type === "contract" || document_type === "other") warnings.push("DOCUMENT_REQUIRES_REVIEW");
  const issue_date = date("issue_date");
  return { document_type, supplier_name: clean(raw.supplier_name, 250), supplier_document, document_number: clean(raw.document_number, 100), amount, due_date, issue_date, description: clean(raw.description), source_evidence: evidence, confidence: warnings.length ? Math.min(Math.max(raw.confidence, 0), 0.7) : Math.min(Math.max(raw.confidence, 0), 1), warnings: [...new Set(warnings)] };
}
