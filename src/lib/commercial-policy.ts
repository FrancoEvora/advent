export type InterestTier = { max_installments: number; monthly_interest_rate: number };
export type CommercialPolicy = {
  monthly_interest_rate: number; max_installments: number; min_down_payment_pct: number;
  max_down_payment_installments: number; down_payment_interest_rate: number;
  balloon_limit_pct?: number; balloon_frequency_months: number;
  parameters?: Record<string, unknown>;
};

export function interestTiers(policy: CommercialPolicy): InterestTier[] {
  const values = policy.parameters?.interest_rate_tiers;
  if (!Array.isArray(values)) return [{ max_installments: policy.max_installments, monthly_interest_rate: Number(policy.monthly_interest_rate) }];
  return values.filter((value): value is InterestTier => value !== null && typeof value === "object" && Number.isInteger(value.max_installments) && value.max_installments > 0 && Number.isFinite(value.monthly_interest_rate) && value.monthly_interest_rate >= 0 && value.monthly_interest_rate <= 0.1).sort((a, b) => a.max_installments - b.max_installments);
}

export function policyMonthlyRate(policy: CommercialPolicy | undefined, months: number): number {
  if (!policy || !Number.isInteger(months) || months < 1 || months > policy.max_installments) return 0;
  return interestTiers(policy).find(tier => months <= tier.max_installments)?.monthly_interest_rate ?? Number(policy.monthly_interest_rate);
}

export function policyEntryRate(policy: CommercialPolicy | undefined, count: number): number {
  if (!policy || count <= 1) return 0;
  const options = policy.parameters?.down_payment_options;
  if (Array.isArray(options)) {
    const option = options.filter(value => value && Number.isInteger(value.installments) && value.installments >= count && Number.isFinite(value.monthly_interest_rate) && value.monthly_interest_rate >= 0).sort((a, b) => a.installments - b.installments)[0];
    if (option) return Number(option.monthly_interest_rate);
  }
  return Number(policy.down_payment_interest_rate || 0);
}

export function maximumBalloons(policy: CommercialPolicy | undefined, months: number): number {
  if (!policy) return 0;
  const configured = Number(policy.parameters?.annual_balloon_max_count ?? 4);
  const frequency = Math.max(1, policy.balloon_frequency_months || 12);
  return Math.max(0, Math.min(30, Number.isInteger(configured) ? configured : 4, Math.floor(months / frequency)));
}

export const percentLabel = (fraction: number) => `${(fraction * 100).toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 3 })}%`;
