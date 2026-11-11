import { methodLabels, type AmortizationMethod, type PaymentRow } from "./broker-payment-plan";
import { proposalCorrectionDescription } from "./proposal-correction";

export type BrokerProposalDocument = {
  customer_name: string; project_name: string; unit_code: string; area: number;
  proposal_number?: string; sale_price: number; down_payment: number; balloon_total: number;
  monthly_interest_rate: number; indexer: string; amortization_method: AmortizationMethod;
  payment_plan: PaymentRow[]; conditions_text?: string | null;
};

export async function createBrokerProposalPdf(doc: BrokerProposalDocument): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  pdf.setTitle("Proposta para simples conferência - Évora Urbanismo");
  pdf.setAuthor("Évora Urbanismo");
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.09, 0.23, 0.29), green = rgb(0.35, 0.49, 0.18);
  const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  // Standard PDF fonts cover Latin names. Replace unsupported glyphs rather than failing the download.
  const clean = (text: string) => Array.from(text.normalize("NFC")).map(char => { try { regular.encodeText(char); return char; } catch { return "?"; } }).join("");
  let page = pdf.addPage([595.28, 841.89]);
  let y = 0;
  function header() {
    page.drawText("ÉVORA URBANISMO", { x: 42, y: 794, size: 17, font: bold, color: ink });
    page.drawText("PROPOSTA PARA SIMPLES CONFERÊNCIA", { x: 42, y: 771, size: 11, font: bold, color: green });
    page.drawLine({ start: { x: 42, y: 756 }, end: { x: 553, y: 756 }, color: green, thickness: 2 });
    y = 733;
  }
  function ensure(height: number) { if (y - height < 63) { page = pdf.addPage([595.28, 841.89]); header(); } }
  function line(text: string, strong = false, size = 10) {
    const font = strong ? bold : regular;
    const draw = (value: string) => { ensure(size + 7); page.drawText(value, { x: 42, y, size, font, color: ink }); y -= size + 7; };
    for (const paragraph of clean(text).split("\n")) {
      let buffer = "";
      for (const word of paragraph.split(/\s+/)) {
        const candidate = buffer ? buffer + " " + word : word;
        if (font.widthOfTextAtSize(candidate, size) <= 505) { buffer = candidate; continue; }
        if (buffer) draw(buffer);
        buffer = "";
        for (const char of word) {
          if (font.widthOfTextAtSize(buffer + char, size) > 505) { draw(buffer); buffer = ""; }
          buffer += char;
        }
      }
      draw(buffer);
    }
  }
  header();
  line(doc.proposal_number ? `Referência: ${doc.proposal_number}` : "Simulação não encaminhada para aprovação", true);
  line(`Lead: ${doc.customer_name}`, true, 12);
  line(`Empreendimento: ${doc.project_name}`);
  line(`Lote: ${doc.unit_code}  |  Área: ${doc.area} m²`);
  line(`Valor do imóvel: ${money.format(doc.sale_price)}`, true, 12);
  line(`Entrada: ${money.format(doc.down_payment)}  |  Balões nominais: ${money.format(doc.balloon_total)}`);
  line(`Sistema: ${methodLabels[doc.amortization_method]}`, true);
  line(`Taxa de juros mensal: ${(doc.monthly_interest_rate * 100).toLocaleString("pt-BR", { maximumFractionDigits: 5 })}%`);
  line(`Índice de correção monetária: ${proposalCorrectionDescription(doc.indexer)}`, true);
  const monthly = doc.payment_plan.filter(row => row.installment_type === "mensal");
  if (monthly.length) line(`${monthly.length} mensais: primeira ${money.format(monthly[0].amount)}; última ${money.format(monthly.at(-1)!.amount)}.`);
  line(doc.amortization_method === "sacoc" ? "Gradiente: parcela k = (saldo da série mensal / número de parcelas) × (1 + taxa mensal)^k, com k iniciando em 1." : "Price: prestações mensais constantes, calculadas pela equivalência financeira à taxa mensal informada.");
  line("A entrada segue sua própria taxa e frequência. Balões são nominais. Correções futuras pelo indexador não estão projetadas. A carência apenas posterga datas, sem juros adicionais de carência.");
  line("Somente conferência. Não constitui aceite, contrato ou confirmação de reserva. A contratação depende da aprovação da Diretoria, da disponibilidade do lote e da formalização das condições.", true);
  if (doc.conditions_text) { y -= 6; line("Condições solicitadas", true); line(doc.conditions_text); }
  y -= 8; line(`Total nominal do cronograma: ${money.format(doc.payment_plan.reduce((sum, row) => sum + Number(row.amount), 0))}`, true);
  line("CRONOGRAMA DE PAGAMENTOS", true, 12);
  const labels = { entrada: "Entrada", mensal: "Mensal", balao: "Balão" };
  let tablePage = -1;
  for (const row of [...doc.payment_plan].sort((a, b) => a.due_date.localeCompare(b.due_date) || a.installment_number - b.installment_number)) {
    ensure(42);
    if (tablePage !== pdf.getPageCount()) {
      for (const [value, x] of [["Nº", 42], ["Tipo", 110], ["Vencimento", 245], ["Valor", 405]] as const) page.drawText(value, { x, y, size: 10, font: bold, color: ink });
      y -= 20; tablePage = pdf.getPageCount();
    }
    const date = row.due_date.split("-").reverse().join("/");
    for (const [value, x] of [[String(row.installment_number), 42], [labels[row.installment_type], 110], [date, 245], [money.format(row.amount), 405]] as const) page.drawText(value, { x, y, size: 10, font: regular, color: ink });
    y -= 20;
  }
  pdf.getPages().forEach((item, index) => {
    item.drawText(`CONFERÊNCIA - SEM ACEITE  |  ${index + 1}/${pdf.getPageCount()}`, { x: 42, y: 34, size: 9, font: bold, color: green });
  });
  return pdf.save();
}
