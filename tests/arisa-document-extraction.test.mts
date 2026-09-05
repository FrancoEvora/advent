import assert from "node:assert/strict";
import test from "node:test";
const { parseStatementCsv, parseStatementOfx, parseNfeXml, money, isoDate, validatePayableModel, validTaxDocument, decodeDocument } = await import(new URL("../supabase/functions/_shared/arisa-document.ts", import.meta.url).href);
const errorCode = (code: string) => (error: unknown) => error instanceof Error && error.message === code;

test("CSV preserves Brazilian decimals, debit signs, quoted names and legitimate equal transactions", async () => {
  const csv = '"Data";"Valor";"Histórico"\r\n04/09/2026;-1.234,56;"Fornecedor; materiais"\r\n04/09/2026;200,00;Recebimento\r\n04/09/2026;200,00;Recebimento';
  const result = await parseStatementCsv(csv);
  assert.deepEqual(result.transactions.map((t: { amount: number }) => t.amount), [-1234.56, 200, 200]);
  assert.equal(result.transactions[0].description, "Fornecedor; materiais");
  assert.equal(result.transactions[0].posted_on, "2026-09-04");
  assert.notEqual(result.transactions[1].external_id, result.transactions[2].external_id);
  assert.deepEqual(result, await parseStatementCsv(csv));
});
test("CSV accepts bank debit/credit columns and multiline escaped descriptions", async () => {
  const result = await parseStatementCsv('Data;Débito;Crédito;Descrição\n2026-09-04;150,99;;"Serviço ""A""\nEtapa 2"\n2026-09-05;;850,00;Recebimento');
  assert.equal(result.transactions[0].amount, -150.99);
  assert.equal(result.transactions[1].amount, 850);
  assert.equal(result.transactions[0].description, 'Serviço "A"\nEtapa 2');
});
test("CSV rejects conflicting debit/credit, malformed rows, duplicates and precision ambiguity", async () => {
  await assert.rejects(parseStatementCsv("Data;Débito;Crédito;Descrição\n2026-09-04;100,00;10,00;Teste"), errorCode("CONFLICTING_AMOUNT_DIRECTION"));
  await assert.rejects(parseStatementCsv("Data;Valor;Descrição\n2026-09-04;100,00;Teste;Extra"), errorCode("CSV_COLUMN_MISMATCH"));
  await assert.rejects(parseStatementCsv("Data;Valor;Descrição;ID\n2026-09-04;100,00;Um;1\n2026-09-05;50,00;Dois;1"), errorCode("DUPLICATE_TRANSACTION_ID"));
  await assert.rejects(parseStatementCsv("Data;Valor;Descrição\n2026-09-04;1.234;Teste"), errorCode("AMBIGUOUS_AMOUNT"));
});
test("CSV never silently skips an invalid date, missing description or zero movement", async () => {
  await assert.rejects(parseStatementCsv("Data;Valor;Descrição\n31/02/2026;10,00;Teste"), errorCode("INVALID_DATE"));
  await assert.rejects(parseStatementCsv("Data;Valor;Descrição\n2026-09-04;10,00;"), errorCode("TRANSACTION_DESCRIPTION_REQUIRED"));
  await assert.rejects(parseStatementCsv("Data;Valor;Descrição\n2026-09-04;0,00;Saldo"), errorCode("ZERO_TRANSACTION"));
});
test("CSV rejects more than 500 movements instead of importing a partial file", async () => {
  await assert.rejects(parseStatementCsv("Data;Valor;Descrição\n" + Array.from({ length: 501 }, () => "2026-09-04;1,00;Teste").join("\n")), errorCode("TOO_MANY_TRANSACTIONS"));
});
test("CSV handles declared D/C but rejects contradictory positive signs", async () => {
  const result = await parseStatementCsv("Data;Valor;Histórico;D/C\n2026-09-04;100,00;Pagamento;D\n2026-09-04;80,00;Recebimento;C");
  assert.deepEqual(result.transactions.map((t: { amount: number }) => t.amount), [-100, 80]);
  await assert.rejects(parseStatementCsv("Data;Valor;Histórico;D/C\n2026-09-04;+100,00;Pagamento;D"), errorCode("CONFLICTING_AMOUNT_DIRECTION"));
});
test("CSV with only unsigned positive values requires an explicit bank direction convention", async () => {
  await assert.rejects(parseStatementCsv("Data;Valor;Descrição\n2026-09-04;100,00;Teste"), errorCode("CSV_DIRECTION_REQUIRED"));
  const result = await parseStatementCsv("Data;Valor;Descrição\n2026-09-04;+100,00;Teste");
  assert.equal(result.transactions[0].amount, 100);
  assert.equal(result.document_type, "bank_statement");
});

function ofx(transactions: string, account = "12345") { return `OFXHEADER:100\nDATA:OFXSGML\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL\n<BANKACCTFROM><BANKID>123\n<ACCTID>${account}\n</BANKACCTFROM><BANKTRANLIST>${transactions}</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`; }
const movement = '<STMTTRN><TRNTYPE>DEBIT\n<DTPOSTED>20260904120000[-3:BRT]\n<TRNAMT>-1234.56\n<FITID>bank-001\n<NAME>Materiais &amp; serviços\n<MEMO>NF 123\n</STMTTRN>';
test("OFX SGML extracts signed values and posted date without timezone shifting", () => {
  const result = parseStatementOfx(ofx(movement));
  assert.equal(result.bank_account_hint, "12345");
  assert.deepEqual(result.transactions[0], { external_id: "bank-001", posted_on: "2026-09-04", amount: -1234.56, description: "Materiais & serviços · NF 123", document_reference: null });
});
test("OFX rejects duplicate FITID, multiple accounts, non-BRL and unclosed transaction", () => {
  assert.throws(() => parseStatementOfx(ofx(movement + movement)), errorCode("DUPLICATE_TRANSACTION_ID"));
  assert.throws(() => parseStatementOfx(ofx(movement, "123\n<ACCTID>456")), errorCode("OFX_SINGLE_ACCOUNT_REQUIRED"));
  assert.throws(() => parseStatementOfx(ofx(movement).replace("BRL", "USD")), errorCode("STATEMENT_CURRENCY_UNSUPPORTED"));
  assert.throws(() => parseStatementOfx(ofx(movement.replace("</STMTTRN>", ""))), errorCode("OFX_INVALID_TRANSACTION"));
});
test("date and money parsing reject overflow and ambiguous precision", () => {
  assert.equal(isoDate("29/02/2024"), "2024-02-29");
  assert.throws(() => isoDate("29/02/2025"), errorCode("INVALID_DATE"));
  assert.equal(money("R$ 1.250,40 D"), -1250.4);
  assert.equal(money("(250.50)"), -250.5);
  assert.throws(() => money("12.345"), errorCode("AMBIGUOUS_AMOUNT"));
  assert.throws(() => money("-10,00 C"), errorCode("CONFLICTING_AMOUNT_DIRECTION"));
  assert.throws(() => money("1,23", true), errorCode("INVALID_AMOUNT"));
});

function nfe(charge: string, options = { supplier: "11222333000181", purpose: "1", payment: "" }) {
  return `<?xml version="1.0" encoding="UTF-8"?><nfeProc xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe123" versao="4.00"><ide><nNF>123</nNF><dhEmi>2026-09-04T10:00:00-03:00</dhEmi><natOp>Venda de materiais</natOp><finNFe>${options.purpose}</finNFe></ide><emit><CNPJ>${options.supplier}</CNPJ><xNome>Fornecedor &amp; Cia</xNome></emit><dest><CNPJ>99999999000199</CNPJ><xNome>Comprador</xNome></dest><total><ICMSTot><vNF>1250.40</vNF></ICMSTot></total>${charge}${options.payment}</infNFe></NFe><protNFe><infProt><cStat>100</cStat></infProt></protNFe></nfeProc>`;
}
const singleCharge = "<cobr><dup><nDup>001</nDup><dVenc>2026-09-15</dVenc><vDup>1250.40</vDup></dup></cobr>";
test("NF-e reads issuer, not recipient, and one evidenced installment", () => {
  const extracted = parseNfeXml(nfe(singleCharge));
  assert.equal(extracted.supplier_name, "Fornecedor & Cia");
  assert.equal(extracted.supplier_document, "11222333000181");
  assert.equal(extracted.amount, 1250.4);
  assert.equal(extracted.due_date, "2026-09-15");
  assert.equal(extracted.issue_date, "2026-09-04");
  assert.equal(extracted.confidence, 0.99);
  assert.deepEqual(extracted.warnings, []);
});
test("NF-e never substitutes issue date for missing due date", () => {
  const extracted = parseNfeXml(nfe(""));
  assert.equal(extracted.due_date, null);
  assert.ok(extracted.warnings.includes("DUE_DATE_NOT_IN_DOCUMENT"));
});
test("NF-e multiple installments cannot become one payable for invoice total", () => {
  const extracted = parseNfeXml(nfe("<cobr><dup><dVenc>2026-09-15</dVenc><vDup>625.20</vDup></dup><dup><dVenc>2026-10-15</dVenc><vDup>625.20</vDup></dup></cobr>"));
  assert.equal(extracted.amount, null);
  assert.equal(extracted.due_date, null);
  assert.ok(extracted.warnings.includes("MULTIPLE_INSTALLMENTS_REQUIRES_REVIEW"));
});
test("NF-e flags invalid CNPJ, return, unconfirmed authorization and immediate payment", () => {
  const extracted = parseNfeXml(nfe(singleCharge, { supplier: "11111111000111", purpose: "4", payment: "<pag><detPag><indPag>0</indPag><tPag>01</tPag></detPag></pag>" }).replace("<cStat>100", "<cStat>101"));
  assert.ok(extracted.warnings.includes("SUPPLIER_DOCUMENT_MISSING_OR_INVALID"));
  assert.ok(extracted.warnings.includes("NFE_ADJUSTMENT_OR_RETURN_REQUIRES_REVIEW"));
  assert.ok(extracted.warnings.includes("NFE_AUTHORIZATION_NOT_CONFIRMED"));
  assert.ok(extracted.warnings.includes("IMMEDIATE_PAYMENT_INDICATED_REQUIRES_REVIEW"));
});
test("XML never expands DTD, external entities or processes extra documents", () => {
  assert.throws(() => parseNfeXml('<!DOCTYPE NFe [<!ENTITY secret SYSTEM "file:///etc/passwd">]>' + nfe(singleCharge)), errorCode("XML_UNSAFE_DECLARATION"));
  assert.throws(() => parseNfeXml(nfe(singleCharge).replace("Fornecedor &amp; Cia", "&unknown;")), errorCode("XML_INVALID_ENTITY"));
  assert.throws(() => parseNfeXml(nfe(singleCharge) + "<NFe/>"), errorCode("XML_INVALID"));
  assert.throws(() => parseNfeXml(nfe(singleCharge).replace("</emit>", "</dest>")), errorCode("XML_INVALID"));
});
test("CPF/CNPJ check digits are validated, not just length", () => {
  assert.equal(validTaxDocument("11222333000181"), true);
  assert.equal(validTaxDocument("11222333000180"), false);
  assert.equal(validTaxDocument("00000000000000"), false);
  assert.equal(validTaxDocument("52998224725"), true);
});
const modelBase = () => ({ document_type: "invoice", supplier_name: "Fornecedor", supplier_document: "11.222.333/0001-81", document_number: "123", amount: 1250.4, due_date: "2026-09-15", issue_date: "2026-09-04", description: "Materiais", source_evidence: { amount: "Total R$ 1.250,40", due_date: "Vencimento: 15/09/2026", supplier_document: "CNPJ: 11.222.333/0001-81" }, confidence: 0.99, warnings: [], ambiguous_amount: false, multiple_installments: false, payment_already_made: false });
test("AI result preserves valid extraction and converts paid evidence to receipt", () => {
  const result = validatePayableModel(modelBase()); assert.equal(result.amount, 1250.4); assert.equal(result.confidence, 0.99);
  const receipt = validatePayableModel({ ...modelBase(), payment_already_made: true });
  assert.equal(receipt.document_type, "receipt"); assert.ok(receipt.warnings.includes("RECEIPT_DOES_NOT_CREATE_PAYABLE"));
});
test("AI amounts and dates must match quoted source evidence", () => {
  const result = validatePayableModel({ ...modelBase(), amount: 12504, due_date: "2026-10-15" });
  assert.equal(result.amount, null); assert.equal(result.due_date, null); assert.ok(result.warnings.includes("AMOUNT_EVIDENCE_MISMATCH"));
});
test("AI ambiguity or missing evidence cannot silently become a valid payable", () => {
  const ambiguous = validatePayableModel({ ...modelBase(), multiple_installments: true }); assert.equal(ambiguous.amount, null);
  const absent = validatePayableModel({ ...modelBase(), source_evidence: { amount: null, due_date: null, supplier_document: null } });
  assert.equal(absent.amount, null); assert.equal(absent.due_date, null); assert.ok(absent.confidence <= 0.7);
  assert.throws(() => validatePayableModel({ ...modelBase(), ambiguous_amount: "false" }), errorCode("AI_INVALID_EXTRACTION"));
});
test("decoder reads legacy bank exports but rejects binary uploads", () => {
  assert.equal(decodeDocument(new Uint8Array([68, 101, 115, 99, 114, 105, 231, 227, 111])), "Descrição");
  assert.throws(() => decodeDocument(new Uint8Array([65, 0, 66])), errorCode("BINARY_DOCUMENT_UNSUPPORTED"));
});
