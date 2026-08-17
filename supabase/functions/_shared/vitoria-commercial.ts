export type BalloonPlan = {
  requested: boolean;
  count: number | null;
  amount: number | null;
};

const PAYMENT_REQUEST_PATTERN = /\b(?:simular|simule|simulação|simulacao|simulações|simulacoes|calcular|calcule|cálculo|calculo|parcela|parcelas|parcelamento|condições de pagamento|condicoes de pagamento)\b/i;

function commercialClauses(message: string): string[] {
  return message
    .split(/[;!?\n]+|[.,]\s+(?=[\p{L}])|\s+(?:mas|porém|porem|e\s+sim)\s+/iu)
    .map((clause) => clause.trim())
    .filter(Boolean);
}

function isRejectedClause(clause: string): boolean {
  return /\b(?:não|nao|nunca)\b/i.test(clause);
}

function explicitlyExcludesBalloons(clause: string): boolean {
  return /\bsem\s+(?:nenhum(?:a)?\s+)?bal(?:ão|ões|ao|oes)\b/i.test(clause)
    || /\b(?:não|nao|nunca)\s+(?:(?:quero|desejo|pretendo)\s+(?:(?:incluir|usar|considerar|colocar|adicionar)\s+)?|(?:inclua|use|considere|coloque|adicione)\s+)?(?:nenhum(?:a)?\s+|os?\s+)?bal(?:ão|ões|ao|oes)\b/i.test(clause)
    || /\b(?:retire|remova|exclua|tire)\s+(?:todos?\s+)?(?:os?\s+)?bal(?:ão|ões|ao|oes)\b/i.test(clause);
}

export function parseEntryPercentage(message: string): number | null {
  const clauses = commercialClauses(message);
  const entryWasMentioned = /\bentrada\b/i.test(message);
  let percentage: number | null = null;

  for (const clause of clauses) {
    if (isRejectedClause(clause)) continue;
    const explicit = clause.match(
      /(?:entrada\s+(?:de\s+)?)(\d{1,2}(?:[,.]\d+)?)\s*%|(\d{1,2}(?:[,.]\d+)?)\s*%\s*(?:de\s+)?entrada/i,
    );
    const correction = entryWasMentioned
      ? clause.match(/\b(?:use|considere|prefiro|quero|coloque|ajuste)\s+(?:uma\s+entrada\s+(?:de\s+)?)?(\d{1,2}(?:[,.]\d+)?)\s*%/i)
      : null;
    const value = explicit?.[1] || explicit?.[2] || correction?.[1];
    if (!value) continue;
    const parsed = Number(value.replace(",", "."));
    if (Number.isFinite(parsed)) percentage = parsed / 100;
  }

  return percentage;
}

export function parseTermMonths(message: string): number | null {
  let selectedTerm: number | null = null;

  for (const clause of commercialClauses(message)) {
    if (isRejectedClause(clause)) continue;
    const prioritized = clause.match(
      /\b(?:prazo|saldo|restante|resto)\b[^.!?\n]{0,48}?\b(\d{2,3})\s*(?:mes(?:es)?|parcelas?|x)\b/i,
    );
    if (prioritized) {
      const months = Number(prioritized[1]);
      if (Number.isInteger(months) && months >= 12 && months <= 600) {
        selectedTerm = months;
        continue;
      }
    }
    const withoutEntryInstallments = clause.replace(
      /\bentrada\b[^.!?\n]{0,60}?\b\d{1,2}\s*(?:x|parcelas?)\b/gi,
      " ",
    );
    for (const match of withoutEntryInstallments.matchAll(/\b(\d{2,3})\s*(?:mes(?:es)?|parcelas?|x)\b/gi)) {
      const months = Number(match[1]);
      if (Number.isInteger(months) && months >= 12 && months <= 600) {
        selectedTerm = months;
        break;
      }
    }
  }

  return selectedTerm;
}

export function parseDownPaymentInstallments(message: string): number | null {
  let selectedInstallments: number | null = null;
  for (const clause of commercialClauses(message)) {
    if (isRejectedClause(clause)) continue;
    const match = clause.match(
      /\bentrada\b[^.!?\n]{0,40}?\b(?:em\s+)?(\d{1,2})\s*(?:x|parcelas?)\b/i,
    );
    if (!match) continue;
    const installments = Number(match[1]);
    if (Number.isInteger(installments) && installments >= 1 && installments <= 24) {
      selectedInstallments = installments;
    }
  }
  return selectedInstallments;
}

export function wantsPaymentSimulation(message: string): boolean {
  const actionableClauses = commercialClauses(message).filter((clause) => !isRejectedClause(clause));
  if (actionableClauses.some((clause) => PAYMENT_REQUEST_PATTERN.test(clause))) {
    return true;
  }
  const adjustsEntry = actionableClauses.some((clause) => (
    /\b(?:mudar|ajustar|alterar|modificar)\s+(?:a\s+)?entrada\b/i.test(clause)
  ));
  const adjustsTerm = actionableClauses.some((clause) => (
    /\b(?:mudar|ajustar|alterar|modificar)\s+(?:o\s+)?prazo\b/i.test(clause)
  ));
  if (adjustsEntry || adjustsTerm) return true;
  const balloonPlan = parseBalloonPlan(message);
  if (
    parseEntryPercentage(message) !== null
    || parseTermMonths(message) !== null
    || parseDownPaymentInstallments(message) !== null
    || (balloonPlan.requested && (balloonPlan.count !== null || balloonPlan.amount !== null))
  ) return true;
  const signals = [
    parseEntryPercentage(message) !== null,
    parseTermMonths(message) !== null,
    /\bbal(?:ão|ões|ao|oes)\b/i.test(message),
  ].filter(Boolean).length;
  return signals >= 2;
}

/**
 * Distinguishes an informational question about the commercial policy from a
 * request for an exact calculation. The policy can always be explained without
 * choosing — much less reserving — a unit. Exact monetary scenarios still use a
 * live unit price as their canonical basis.
 */
export function asksGeneralPaymentConditions(message: string): boolean {
  const actionableClauses = commercialClauses(message).filter((clause) => !isRejectedClause(clause));
  if (!actionableClauses.length) return false;
  const actionableText = actionableClauses.join(" ");

  const asksForCalculation = actionableClauses.some((clause) => (
    /\b(?:simular|simule|simulação|simulacao|calcular|calcule|cálculo|calculo|recalcular|recalcule)\b/i.test(clause)
    || /\b(?:quanto|como)\s+(?:fica|ficaria|daria)\b/i.test(clause)
    || /\bvalor\s+(?:da|das|de)\s+parcelas?\b/i.test(clause)
    || /\bqual(?:\s+seria)?\b[^.!?\n]{0,56}\b(?:valor\s+(?:da|das|de)\s+)?parcelas?\b/i.test(clause)
    || /\bquanto\s+(?:eu\s+)?(?:pago|pagaria|vou\s+pagar)\b[^.!?\n]{0,48}\b(?:por\s+mês|por\s+mes|mensalmente|de\s+parcela)\b/i.test(clause)
    || /\bparcelas?\b[^.!?\n]{0,56}\b(?:seria|seriam|fica|ficam|ficaria|ficariam)\s+quanto\b/i.test(clause)
  ));
  if (asksForCalculation) return false;

  const hasQuestionForm = message.includes("?") || actionableClauses.some((clause) => (
    /^(?:a\s+|o\s+)?(?:entrada|prazo|juros?|correção|correcao|bal(?:ão|ões|ao|oes))\b[^.!?\n]{0,40}\b(?:é|e|são|sao|seria|pode|podem)\b/i.test(clause)
    || /^(?:posso|pode|podem|aceita|permite|tem\s+como|há\s+como|ha\s+como|é\s+possível|e\s+possivel)\b/i.test(clause)
    || /^(?:quero|gostaria\s+de)\s+(?:saber|confirmar|entender)\s+se\b/i.test(clause)
  ));
  const hasPolicyNumber = (
    /\bentrada\b[^.!?\n]{0,32}\b\d{1,2}(?:[,.]\d+)?\s*%\b/i.test(actionableText)
    || /\b\d{2,3}\s*(?:mes(?:es)?|parcelas?|x)\b/i.test(actionableText)
    || /\b\d{1,2}\s*bal(?:ão|ões|ao|oes)\b/i.test(actionableText)
    || /\b\d{1,2}(?:[,.]\d+)?\s*%\s*(?:a\.?m\.?|ao\s+mês|ao\s+mes)\b/i.test(actionableText)
  );
  const calculatorCommandText = actionableText.replace(
    /\b(?:quero|gostaria\s+de)\s+(?:saber|confirmar|entender|conhecer)\b/gi,
    "",
  );
  const hasCalculatorCommand = /\b(?:simular|simule|calcular|calcule|recalcular|recalcule|faça|faca|use|considere|coloque|ajuste|mude|altere|quero|prefiro)\b/i.test(
    calculatorCommandText,
  );
  const confirmsPolicyWithNumber = hasQuestionForm && hasPolicyNumber && !hasCalculatorCommand;

  const asksForTerms = actionableClauses.some((clause) => (
    /\bcondi(?:ção|ções|cao|coes)(?:\s+(?:de\s+)?pagamento)?\b/i.test(clause)
    || /\bformas?\s+de\s+pagamento\b/i.test(clause)
    || /\bcomo\s+funciona(?:m)?\s+(?:(?:o|a)\s+)?(?:pagamento|parcelamento|entrada|financiamento)\b/i.test(clause)
    || /\b(?:qual|quais|quanto)\b[^.!?\n]{0,56}\b(?:entrada\s+mínima|entrada\s+minima|prazos?|juros|correção|correcao|IPCA|bal(?:ão|ões|ao|oes))\b/i.test(clause)
    || /\b(?:entrada\s+mínima|entrada\s+minima|prazos?\s+disponíveis|prazos?\s+disponiveis|juros|correção\s+por\s+IPCA|correcao\s+por\s+IPCA)\b/i.test(clause)
  ));

  if (confirmsPolicyWithNumber) return true;

  return asksForTerms
    && parseEntryPercentage(message) === null
    && parseTermMonths(message) === null
    && parseDownPaymentInstallments(message) === null
    && !parseBalloonPlan(message).requested;
}

export function parseBalloonPlan(message: string): BalloonPlan {
  const requested = /\bbal(?:ão|ões|ao|oes)\b/i.test(message);
  if (!requested) return { requested: false, count: 0, amount: 0 };
  let selectedPlan: BalloonPlan = { requested: true, count: null, amount: null };

  for (const clause of commercialClauses(message)) {
    if (!/\bbal(?:ão|ões|ao|oes)\b/i.test(clause)) continue;
    if (explicitlyExcludesBalloons(clause)) {
      selectedPlan = { requested: true, count: 0, amount: 0 };
      continue;
    }
    if (isRejectedClause(clause)) continue;
    const countMatch = clause.match(/\b(\d{1,2})\s*bal(?:ão|ões|ao|oes)\b/i);
    const amountMatch = clause.match(
      /\bbal(?:ão|ões|ao|oes)(?:\s+anuais?)?\s+(?:de|no\s+valor\s+de|com\s+valor\s+de)\s+(?:R\$\s*)?([\d.]+(?:,\d{1,2})?)\s*(mil)?\b/i,
    );
    const parsedCount = countMatch ? Number(countMatch[1]) : null;
    const count = parsedCount !== null && Number.isInteger(parsedCount) && parsedCount > 0
      ? parsedCount
      : null;
    const rawAmount = amountMatch
      ? Number(amountMatch[1].replace(/\./g, "").replace(",", "."))
      : null;
    const amount = rawAmount !== null
      ? (amountMatch?.[2] ? rawAmount * 1_000 : rawAmount)
      : null;
    selectedPlan = {
      requested: true,
      count,
      amount: amount !== null && Number.isFinite(amount) && amount > 0 ? amount : null,
    };
  }

  return selectedPlan;
}
