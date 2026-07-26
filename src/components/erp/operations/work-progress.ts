import type { ConstructionWorkPackage, Project } from "../types";

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

export interface ConstructionProjectProgress {
  project: Project;
  all_packages: ConstructionWorkPackage[];
  leaf_packages: ConstructionWorkPackage[];
  progress_packages: WorkProgressPackage[];
  summary: WorkProgressSummary;
  has_baseline: boolean;
  critical_packages: number;
  completed_packages: number;
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

export function toWorkProgressPackage(
  item: ConstructionWorkPackage,
): WorkProgressPackage {
  return {
    id: item.id,
    project_id: item.project_id,
    code: item.wbs_code || item.package_code || item.code,
    name: item.name,
    weight_pct: Number(item.weight_pct),
    actual_progress_pct: Number(item.actual_progress),
    planned_progress_pct: Number(item.planned_progress),
    sequence: item.sort_order,
    active: !["cancelada", "cancelado"].includes(item.status),
  };
}

export function listConstructionProjects(
  projects: readonly Project[],
  packages: readonly ConstructionWorkPackage[],
): Project[] {
  return projects.filter(
    (project) =>
      project.active || packages.some((item) => item.project_id === project.id),
  );
}

export function buildConstructionProjectProgress(
  project: Project,
  packages: readonly ConstructionWorkPackage[],
): ConstructionProjectProgress {
  const allPackages = packages
    .filter((item) => item.project_id === project.id)
    .sort((left, right) => left.sort_order - right.sort_order);
  const leafPackages = allPackages.filter(
    (item) =>
      !item.is_summary &&
      !["cancelada", "cancelado"].includes(item.status),
  );
  const progressPackages = leafPackages.map(toWorkProgressPackage);
  const summary = calculateWorkProgress(progressPackages);

  return {
    project,
    all_packages: allPackages,
    leaf_packages: leafPackages,
    progress_packages: progressPackages,
    summary,
    has_baseline: summary.planned_pct > 0,
    critical_packages: summary.packages.filter(
      (item) => !item.accelerated && ["risco", "critico"].includes(item.zone),
    ).length,
    completed_packages: leafPackages.filter(
      (item) => Number(item.actual_progress) >= 100,
    ).length,
  };
}
