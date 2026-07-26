export type WorkPaceZone = "saudavel" | "atencao" | "risco" | "critico";

/**
 * Pacote físico de uma obra. Os nomes seguem o formato das linhas retornadas
 * pelo Supabase, como os demais modelos operacionais do ERP.
 */
export interface WorkProgressPackage {
  id: string;
  project_id: string;
  code: string;
  name: string;
  weight_pct: number;
  actual_progress_pct: number;
  planned_progress_pct: number;
  sequence?: number | null;
  active?: boolean;
}

export interface WorkPackageProgress {
  package: WorkProgressPackage;
  normalized_weight_pct: number;
  actual_pct: number;
  planned_pct: number;
  variance_pp: number;
  spi: number;
  score: number;
  zone: WorkPaceZone;
  accelerated: boolean;
}

export interface WorkProgressSummary {
  actual_pct: number;
  planned_pct: number;
  variance_pp: number;
  spi: number;
  score: number;
  zone: WorkPaceZone;
  accelerated: boolean;
  total_weight_pct: number;
  packages: WorkPackageProgress[];
}

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value : minimum));

const percent = (value: number) => clamp(Number(value), 0, 100);
const round = (value: number, places = 2) => {
  const factor = 10 ** places;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};

export function workPaceZone(score: number): WorkPaceZone {
  if (score >= 90) return "saudavel";
  if (score >= 75) return "atencao";
  if (score >= 60) return "risco";
  return "critico";
}

/**
 * O índice de ritmo combina aderência relativa (SPI) e desvio absoluto.
 * Um atraso de 10 pontos percentuais zera a parcela absoluta do índice.
 */
export function calculatePace(
  actualProgressPct: number,
  plannedProgressPct: number,
): Omit<
  WorkProgressSummary,
  "actual_pct" | "planned_pct" | "total_weight_pct" | "packages"
> {
  const actual = percent(actualProgressPct);
  const planned = percent(plannedProgressPct);
  const variance = actual - planned;
  const spi = planned > 0 ? actual / planned : 1;
  const relativeComponent = clamp(spi, 0, 1);
  const absoluteComponent = clamp(1 + variance / 10, 0, 1);
  const score = Math.round(
    100 * (relativeComponent * 0.7 + absoluteComponent * 0.3),
  );
  const accelerated = actual >= planned + 3;

  return {
    variance_pp: round(variance),
    spi: round(spi, 3),
    score,
    zone: accelerated ? "saudavel" : workPaceZone(score),
    accelerated,
  };
}

/**
 * Calcula o avanço da obra normalizando os pesos dos pacotes ativos.
 * Se nenhum peso válido tiver sido informado, aplica pesos iguais para não
 * esconder os dados já medidos.
 */
export function calculateWorkProgress(
  inputPackages: readonly WorkProgressPackage[],
): WorkProgressSummary {
  const packages = inputPackages.filter((item) => item.active !== false);
  const declaredWeight = packages.reduce(
    (sum, item) => sum + Math.max(0, Number(item.weight_pct) || 0),
    0,
  );
  const useEqualWeights = declaredWeight === 0 && packages.length > 0;

  const normalized = packages.map((item) => {
    const rawWeight = Math.max(0, Number(item.weight_pct) || 0);
    const normalizedWeight = useEqualWeights
      ? 100 / packages.length
      : (rawWeight / Math.max(declaredWeight, 1)) * 100;
    const actual = percent(item.actual_progress_pct);
    const planned = percent(item.planned_progress_pct);

    return {
      item,
      normalizedWeight,
      actual,
      planned,
    };
  });

  const actual = normalized.reduce(
    (sum, item) => sum + (item.actual * item.normalizedWeight) / 100,
    0,
  );
  const planned = normalized.reduce(
    (sum, item) => sum + (item.planned * item.normalizedWeight) / 100,
    0,
  );
  const pace = calculatePace(actual, planned);

  return {
    actual_pct: round(actual),
    planned_pct: round(planned),
    ...pace,
    total_weight_pct: round(declaredWeight),
    packages: normalized.map((item) => {
      const itemPace = calculatePace(item.actual, item.planned);
      return {
        package: item.item,
        normalized_weight_pct: round(item.normalizedWeight),
        actual_pct: item.actual,
        planned_pct: item.planned,
        ...itemPace,
      };
    }),
  };
}

export function calculateProjectWorkProgress(
  packages: readonly WorkProgressPackage[],
  projectId: string,
): WorkProgressSummary {
  return calculateWorkProgress(
    packages.filter((item) => item.project_id === projectId),
  );
}
