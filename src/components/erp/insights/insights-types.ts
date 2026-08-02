export type InsightArea =
  | "financeiro"
  | "vendas_crm_sdr"
  | "obras"
  | "compras"
  | "combustiveis"
  | "contratos"
  | "pos_venda_agenda"
  | "rh"
  | "governanca"
  | string;

export type InsightSeverity = "info" | "warning" | "high" | "critical" | string;
export type InsightPriority = "low" | "medium" | "high" | "urgent" | string;
export type InsightStatus = "novo" | "reconhecido" | "em_tratamento" | "resolvido" | "descartado" | string;

export interface ManagementInsightRun {
  id: string;
  organization_id: string;
  idempotency_key: string;
  status: "started" | "completed" | "failed" | string;
  trigger_source: "scheduled" | "manual" | "implantacao" | string;
  period_start: string;
  period_end: string;
  started_at: string;
  completed_at: string | null;
  areas_analyzed: string[];
  data_coverage_pct: number;
  generated_by: string | null;
  executive_summary: unknown;
  error_message: string | null;
  engine_version: string;
  created_at: string;
}

export interface ManagementInsight {
  id: string;
  organization_id: string;
  run_id: string;
  area: InsightArea;
  title: string;
  summary: string;
  evidence: unknown;
  impact: unknown;
  recommendation: string;
  severity: InsightSeverity;
  priority: InsightPriority;
  status: InsightStatus;
  due_at: string | null;
  confidence_pct: number | null;
  responsible_user_id: string | null;
  related_view: string | null;
  related_entity_type: string | null;
  related_entity_id: string | null;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  resolved_at: string | null;
  resolved_by: string | null;
  created_at: string;
}

export interface InsightTrendPoint {
  label?: string;
  at?: string;
  date?: string;
  period?: string;
  value: number;
}

export interface ManagementInsightMetric {
  id: string;
  organization_id: string;
  run_id: string;
  area: InsightArea;
  metric_key: string;
  label: string;
  numeric_value: number;
  comparison_value: number | null;
  variation_pct: number | null;
  unit: string;
  period_start: string | null;
  period_end: string | null;
  trend_points: unknown;
  created_at: string;
}

export interface ManagementInsightSettings {
  organization_id: string;
  enabled: boolean;
  run_times: string[];
  timezone: string;
  next_run_at: string | null;
  areas: string[];
  thresholds: unknown;
  created_at: string;
  updated_by: string | null;
  updated_at: string;
}

export interface InsightDataset {
  runs: ManagementInsightRun[];
  insights: ManagementInsight[];
  metrics: ManagementInsightMetric[];
  settings: ManagementInsightSettings | null;
}
