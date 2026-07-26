"use client";

import { useState } from "react";
import type { Project } from "../types";
import {
  calculateProjectWorkProgress,
  type WorkPaceZone,
  type WorkProgressPackage,
} from "./work-progress";

export interface WorkProgressGaugeProps {
  packages: readonly WorkProgressPackage[];
  projects: readonly Project[];
  initialProjectId?: string;
  title?: string;
  onOpenDetails?: () => void;
}

const zoneLabels: Record<WorkPaceZone, string> = {
  saudavel: "Saudável",
  atencao: "Atenção",
  risco: "Risco de atraso",
  critico: "Crítico",
};

const zoneColors: Record<WorkPaceZone, string> = {
  saudavel: "#16835d",
  atencao: "#c89722",
  risco: "#d97706",
  critico: "#c33c35",
};

const percentage = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});
const ratio = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 3,
});

const formatPercentage = (value: number) => `${percentage.format(value)}%`;
const formatVariance = (value: number) =>
  `${value > 0 ? "+" : ""}${percentage.format(value)} pp`;

function pointForScore(score: number, radius: number) {
  const radians = Math.PI * (1 - Math.min(100, Math.max(0, score)) / 100);
  return {
    x: 100 + radius * Math.cos(radians),
    y: 100 - radius * Math.sin(radians),
  };
}

function gaugeArc(startScore: number, endScore: number) {
  const start = pointForScore(startScore, 78);
  const end = pointForScore(endScore, 78);
  // The complete gauge spans 180 degrees, so every 0–100 interval is a
  // semicircle (or less) and must use SVG's minor arc. Using 50 as the
  // threshold incorrectly turned the 0–60 critical band into a 252° arc.
  const largeArc = Math.abs(endScore - startScore) > 100 ? 1 : 0;
  return `M ${start.x} ${start.y} A 78 78 0 ${largeArc} 1 ${end.x} ${end.y}`;
}

export function WorkProgressGauge({
  packages,
  projects,
  initialProjectId,
  title = "Temperatura do andamento da obra",
  onOpenDetails,
}: WorkProgressGaugeProps) {
  const projectsWithPackages = projects.filter((project) =>
    packages.some((item) => item.project_id === project.id),
  );
  const availableProjects =
    projectsWithPackages.length > 0 ? projectsWithPackages : projects;
  const defaultProjectId =
    (initialProjectId &&
      availableProjects.some((project) => project.id === initialProjectId) &&
      initialProjectId) ||
    availableProjects[0]?.id ||
    "";
  const [selectedProjectId, setSelectedProjectId] =
    useState(defaultProjectId);
  const effectiveProjectId = availableProjects.some(
    (project) => project.id === selectedProjectId,
  )
    ? selectedProjectId
    : defaultProjectId;
  const project = availableProjects.find(
    (item) => item.id === effectiveProjectId,
  );
  const summary = calculateProjectWorkProgress(
    packages,
    effectiveProjectId,
  );
  const hasBaseline = summary.packages.length > 0 && summary.planned_pct > 0;
  const needle = pointForScore(hasBaseline ? summary.score : 50, 58);
  const displayZone = hasBaseline ? summary.zone : "neutral";
  const gaugeColor = hasBaseline ? zoneColors[summary.zone] : "#82949b";
  const statusLabel = !hasBaseline
    ? "Sem linha de base"
    : summary.accelerated
      ? "Ritmo acelerado"
      : zoneLabels[summary.zone];
  const sortedPackages = [...summary.packages].sort((left, right) => {
    const sequenceDifference =
      (left.package.sequence ?? Number.MAX_SAFE_INTEGER) -
      (right.package.sequence ?? Number.MAX_SAFE_INTEGER);
    return (
      sequenceDifference ||
      left.package.name.localeCompare(right.package.name, "pt-BR")
    );
  });
  const ariaDescription = project
    ? hasBaseline
      ? `${project.name}: ${formatPercentage(summary.actual_pct)} realizado, ${formatPercentage(summary.planned_pct)} previsto, desvio de ${formatVariance(summary.variance_pp)} e índice de ritmo ${summary.score} de 100.`
      : `${project.name}: ${formatPercentage(summary.actual_pct)} realizado. O índice de ritmo aguarda uma linha de base prevista.`
    : "Nenhuma obra disponível para análise.";

  if (!availableProjects.length) {
    return (
      <section className="work-progress work-progress-empty">
        <h3>{title}</h3>
        <p>Nenhuma obra cadastrada para análise.</p>
      </section>
    );
  }

  return (
    <section
      className={`work-progress work-zone-${displayZone}`}
      aria-label={ariaDescription}
    >
      <header className="work-header">
        <div className="work-heading">
          <small>GESTÃO FÍSICA</small>
          <h3>{title}</h3>
        </div>
        <div className="work-header-controls">
          <label className="work-project-selector">
            <span>Empreendimento</span>
            <select
              value={effectiveProjectId}
              onChange={(event) => setSelectedProjectId(event.target.value)}
            >
              {availableProjects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.code ? ` · ${item.code}` : ""}
                </option>
              ))}
            </select>
          </label>
          {onOpenDetails && (
            <button
              className="dashboard-work-link"
              type="button"
              onClick={onOpenDetails}
            >
              Abrir gestão detalhada da obra →
            </button>
          )}
        </div>
      </header>

      <div className="work-executive">
        <figure className="work-gauge">
          <svg
            viewBox="0 0 200 126"
            preserveAspectRatio="xMidYMid meet"
            role="img"
            aria-label={
              hasBaseline
                ? `Índice de ritmo ${summary.score} de 100: ${statusLabel}`
                : "Índice de ritmo indisponível: linha de base ainda não informada"
            }
          >
            <path
              className="work-gauge-zone work-gauge-critical"
              d={gaugeArc(0, 60)}
              fill="none"
              stroke="#c33c35"
              strokeWidth="14"
            />
            <path
              className="work-gauge-zone work-gauge-risk"
              d={gaugeArc(60, 75)}
              fill="none"
              stroke="#d97706"
              strokeWidth="14"
            />
            <path
              className="work-gauge-zone work-gauge-attention"
              d={gaugeArc(75, 90)}
              fill="none"
              stroke="#c89722"
              strokeWidth="14"
            />
            <path
              className="work-gauge-zone work-gauge-healthy"
              d={gaugeArc(90, 100)}
              fill="none"
              stroke="#16835d"
              strokeWidth="14"
            />
            <line
              className="work-gauge-needle"
              x1="100"
              y1="100"
              x2={needle.x}
              y2={needle.y}
              stroke={gaugeColor}
              strokeWidth="4"
              strokeLinecap="round"
            />
            <circle
              className="work-gauge-center"
              cx="100"
              cy="100"
              r="7"
              fill={gaugeColor}
            />
            <text
              className="work-gauge-score"
              x="100"
              y="122"
              textAnchor="middle"
            >
              {hasBaseline ? `${summary.score}/100` : "—/100"}
            </text>
          </svg>
          <figcaption className="work-gauge-caption" aria-live="polite">
            <strong>{statusLabel}</strong>
            <span>Índice de ritmo da obra</span>
          </figcaption>
        </figure>

        <dl className="work-summary">
          <div className="work-summary-item work-summary-actual">
            <dt>Realizado</dt>
            <dd>{formatPercentage(summary.actual_pct)}</dd>
          </div>
          <div className="work-summary-item work-summary-planned">
            <dt>Previsto</dt>
            <dd>{formatPercentage(summary.planned_pct)}</dd>
          </div>
          <div className="work-summary-item work-summary-variance">
            <dt>Desvio</dt>
            <dd>{formatVariance(summary.variance_pp)}</dd>
          </div>
          <div className="work-summary-item work-summary-spi">
            <dt>SPI</dt>
            <dd>{hasBaseline ? ratio.format(summary.spi) : "—"}</dd>
          </div>
        </dl>
      </div>

      <div className="work-stages">
        <div className="work-stages-heading">
          <div>
            <small>ETAPAS FÍSICAS</small>
            <h4>Realizado versus previsto</h4>
          </div>
          <span>{sortedPackages.length} etapa(s)</span>
        </div>

        {sortedPackages.map((item) => {
          const itemHasBaseline = item.planned_pct > 0;
          const itemZone = itemHasBaseline ? item.zone : "neutral";
          const itemStatus = !itemHasBaseline
            ? "Sem linha de base"
            : item.accelerated
              ? "Acelerada"
              : zoneLabels[item.zone];
          return (
            <article
              className={`work-stage work-zone-${itemZone}`}
              key={item.package.id}
            >
              <header className="work-stage-header">
                <div>
                  <small>{item.package.code}</small>
                  <strong>{item.package.name}</strong>
                </div>
                <span className="work-stage-status">{itemStatus}</span>
              </header>
              <div className="work-stage-bars">
                <label>
                  <span>
                    Realizado <b>{formatPercentage(item.actual_pct)}</b>
                  </span>
                  <progress
                    className="work-stage-progress work-stage-progress-actual"
                    max={100}
                    value={item.actual_pct}
                    aria-label={`${item.package.name}: ${formatPercentage(item.actual_pct)} realizado`}
                  />
                </label>
                <label>
                  <span>
                    Previsto <b>{formatPercentage(item.planned_pct)}</b>
                  </span>
                  <progress
                    className="work-stage-progress work-stage-progress-planned"
                    max={100}
                    value={item.planned_pct}
                    aria-label={`${item.package.name}: ${formatPercentage(item.planned_pct)} previsto`}
                  />
                </label>
              </div>
              <footer className="work-stage-footer">
                <span>
                  Peso: {formatPercentage(item.normalized_weight_pct)}
                </span>
                <span>Desvio: {formatVariance(item.variance_pp)}</span>
              </footer>
            </article>
          );
        })}

        {!sortedPackages.length && (
          <p className="work-stages-empty">
            Nenhuma etapa física cadastrada para {project?.name ?? "esta obra"}.
          </p>
        )}
      </div>
    </section>
  );
}
