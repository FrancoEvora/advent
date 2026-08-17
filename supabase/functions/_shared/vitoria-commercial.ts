export type BalloonPlan = {
  requested: boolean;
  count: number | null;
  amount: number | null;
};

export function parseEntryPercentage(message: string): number | null {
  const match = message.match(
    /(?:entrada\s+(?:de\s+)?)(\d{1,2}(?:[,.]\d+)?)\s*%|(\d{1,2}(?:[,.]\d+)?)\s*%\s*(?:de\s+)?entrada/i,
  );
  const value = match?.[1] || match?.[2];
  if (!value) return null;
  const percentage = Number(value.replace(",", "."));
  return Number.isFinite(percentage) ? percentage / 100 : null;
}

export function parseTermMonths(message: string): number | null {
  const prioritized = message.match(
    /\b(?:prazo|saldo|restante|resto)\b[^.!?\n]{0,48}?\b(\d{2,3})\s*(?:mes(?:es)?|parcelas?|x)\b/i,
  );
  if (prioritized) {
    const months = Number(prioritized[1]);
    if (Number.isInteger(months) && months >= 12 && months <= 600) return months;
  }
  const withoutEntryInstallments = message.replace(
    /\bentrada\b[^.!?\n]{0,60}?\b\d{1,2}\s*(?:x|parcelas?)\b/gi,
    " ",
  );
  for (const match of withoutEntryInstallments.matchAll(/\b(\d{2,3})\s*(?:mes(?:es)?|parcelas?|x)\b/gi)) {
    const months = Number(match[1]);
    if (Number.isInteger(months) && months >= 12 && months <= 600) return months;
  }
  return null;
}

export function parseDownPaymentInstallments(message: string): number | null {
  const match = message.match(
    /\bentrada\b[^.!?\n]{0,40}?\b(?:em\s+)?(\d{1,2})\s*(?:x|parcelas?)\b/i,
  );
  if (!match) return null;
  const installments = Number(match[1]);
  return Number.isInteger(installments) && installments >= 1 && installments <= 24
    ? installments
    : null;
}

export function wantsPaymentSimulation(message: string): boolean {
  if (/\b(?:simular|simule|simulação|simulacao|calcular|calcule|cálculo|calculo|parcela|parcelas|parcelamento|condições de pagamento|condicoes de pagamento)\b/i.test(message)) {
    return true;
  }
  const balloonPlan = parseBalloonPlan(message);
  if (
    parseEntryPercentage(message) !== null
    || parseTermMonths(message) !== null
    || parseDownPaymentInstallments(message) !== null
    || (balloonPlan.requested && balloonPlan.count !== null && balloonPlan.amount !== null)
  ) return true;
  const signals = [
    parseEntryPercentage(message) !== null,
    parseTermMonths(message) !== null,
    /\bbal(?:ão|ões|ao|oes)\b/i.test(message),
  ].filter(Boolean).length;
  return signals >= 2;
}

export function parseBalloonPlan(message: string): BalloonPlan {
  const requested = /\bbal(?:ão|ões|ao|oes)\b/i.test(message);
  if (!requested) return { requested: false, count: 0, amount: 0 };
  if (/\bsem\s+bal(?:ão|ões|ao|oes)\b/i.test(message)) {
    return { requested: true, count: 0, amount: 0 };
  }
  const match = message.match(
    /\b(\d{1,2})\s*bal(?:ão|ões|ao|oes)(?:\s+anuais?)?(?:\s+(?:de|no valor de))?\s+(?:R\$\s*)?([\d.]+(?:,\d{1,2})?)(\s*mil)?/i,
  );
  if (!match) return { requested: true, count: null, amount: null };
  const count = Number(match[1]);
  const rawAmount = Number(match[2].replace(/\./g, "").replace(",", "."));
  const amount = match[3] ? rawAmount * 1_000 : rawAmount;
  return {
    requested: true,
    count: Number.isInteger(count) && count > 0 ? count : null,
    amount: Number.isFinite(amount) && amount > 0 ? amount : null,
  };
}
