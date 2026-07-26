"use client";

import { FormEvent, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ConstructionWorkPackage, ErpData } from "../types";
import { Empty, Kpi, PanelTitle } from "../views-dashboard";
import { WorkProgressGauge } from "./work-progress-gauge";
import { calculateWorkProgress, type WorkProgressPackage } from "./work-progress";

type Mutate = (operation: () => Promise<void>, success: string) => Promise<void>;

function toProgressPackage(item: ConstructionWorkPackage): WorkProgressPackage {
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

const percent = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function WorkManagementView({
  data,
  mutate,
  can,
}: {
  data: ErpData;
  mutate: Mutate;
  can: (permission: string) => boolean;
}) {
  const projectsWithWork = data.projects.filter((project) =>
    data.constructionWorkPackages.some((item) => item.project_id === project.id),
  );
  const [projectId, setProjectId] = useState(projectsWithWork[0]?.id || "");
  const effectiveProjectId = projectsWithWork.some((item) => item.id === projectId)
    ? projectId
    : projectsWithWork[0]?.id || "";
  const leafPackages = useMemo(
    () =>
      data.constructionWorkPackages
        .filter((item) => !item.is_summary)
        .map(toProgressPackage),
    [data.constructionWorkPackages],
  );
  const projectPackages = data.constructionWorkPackages
    .filter((item) => item.project_id === effectiveProjectId && !item.is_summary)
    .sort((a, b) => a.sort_order - b.sort_order);
  const summary = calculateWorkProgress(projectPackages.map(toProgressPackage));
  const critical = summary.packages.filter(
    (item) => !item.accelerated && ["risco", "critico"].includes(item.zone),
  ).length;
  const completed = projectPackages.filter(
    (item) => Number(item.actual_progress) >= 100,
  ).length;
  const [editing, setEditing] = useState<ConstructionWorkPackage | null>(null);

  return (
    <div className="stack work-management">
      <section className="module-toolbar">
        <div>
          <small>PLANEJAMENTO E CONTROLE</small>
          <h2>Avanço físico das obras</h2>
          <p>
            Acompanhamento ponderado do realizado contra o previsto em cada etapa.
          </p>
        </div>
        <label className="work-toolbar-project">
          <span>Empreendimento</span>
          <select
            value={effectiveProjectId}
            onChange={(event) => setProjectId(event.target.value)}
          >
            {projectsWithWork.map((project) => (
              <option key={project.id} value={project.id}>
                {project.code} · {project.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      {!projectsWithWork.length ? (
        <section className="panel">
          <Empty text="Nenhuma estrutura de etapas foi cadastrada para as obras." />
        </section>
      ) : (
        <>
          <section className="kpi-grid four">
            <Kpi
              label="Avanço realizado"
              value={`${percent.format(summary.actual_pct)}%`}
              tone="positive"
              detail="Ponderado pelo peso das etapas"
            />
            <Kpi
              label="Avanço previsto"
              value={`${percent.format(summary.planned_pct)}%`}
              tone="gold"
              detail="Linha de base atual"
            />
            <Kpi
              label="Desvio físico"
              value={`${summary.variance_pp > 0 ? "+" : ""}${percent.format(summary.variance_pp)} pp`}
              tone={summary.variance_pp < 0 ? "danger" : "positive"}
              detail={`SPI ${summary.spi.toFixed(2)}`}
            />
            <Kpi
              label="Etapas em risco"
              value={String(critical)}
              tone={critical ? "warning" : "positive"}
              detail={`${completed} de ${projectPackages.length} concluídas`}
            />
          </section>

          <WorkProgressGauge
            key={effectiveProjectId}
            packages={leafPackages}
            projects={data.projects}
            initialProjectId={effectiveProjectId}
          />

          <section className="panel work-stage-control">
            <PanelTitle
              eyebrow="MEDIÇÃO POR ETAPA"
              title="Percentuais da estrutura analítica da obra"
            />
            <div className="work-stage-table">
              <div className="work-stage-table-head">
                <span>Etapa</span>
                <span>Peso</span>
                <span>Previsto</span>
                <span>Realizado</span>
                <span>Desvio</span>
                <span>Status</span>
                <span />
              </div>
              {projectPackages.map((item) => {
                const planned = Number(item.planned_progress);
                const actual = Number(item.actual_progress);
                return (
                  <article key={item.id}>
                    <div>
                      <small>{item.wbs_code || item.package_code || item.code}</small>
                      <strong>{item.name}</strong>
                    </div>
                    <span>{percent.format(Number(item.weight_pct))}%</span>
                    <span>{percent.format(planned)}%</span>
                    <span className="work-stage-measured">{percent.format(actual)}%</span>
                    <span className={actual - planned < 0 ? "negative" : "positive"}>
                      {actual - planned > 0 ? "+" : ""}
                      {percent.format(actual - planned)} pp
                    </span>
                    <span className={`work-status work-status-${item.status}`}>
                      {item.status.replaceAll("_", " ")}
                    </span>
                    <button
                      disabled={!can("construction.manage")}
                      onClick={() => setEditing(item)}
                    >
                      Atualizar
                    </button>
                  </article>
                );
              })}
            </div>
          </section>
        </>
      )}

      {editing && (
        <WorkProgressModal
          item={editing}
          mutate={mutate}
          close={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function WorkProgressModal({
  item,
  mutate,
  close,
}: {
  item: ConstructionWorkPackage;
  mutate: Mutate;
  close: () => void;
}) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const actualProgress = Number(form.get("actual_progress"));
    await mutate(async () => {
      if (!Number.isFinite(actualProgress) || actualProgress < 0 || actualProgress > 100) {
        throw new Error("O avanço realizado deve ficar entre 0% e 100%.");
      }
      const client = getSupabase();
      if (!client) throw new Error("Supabase indisponível.");
      const { error } = await client
        .from("construction_work_packages")
        .update({
          actual_progress: actualProgress,
          status: String(form.get("status")),
          actual_start: String(form.get("actual_start") || "") || null,
          actual_end: String(form.get("actual_end") || "") || null,
          notes: String(form.get("notes") || "") || null,
        })
        .eq("id", item.id)
        .eq("organization_id", item.organization_id);
      if (error) throw error;
    }, "Avanço físico da etapa atualizado.");
    close();
  }

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <form
        className="modal work-progress-modal"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <PanelTitle eyebrow="MEDIÇÃO FÍSICA" title={item.name} />
        <button className="modal-close" type="button" onClick={close}>
          ×
        </button>
        <div className="form-grid">
          <label>
            Realizado (%)
            <input
              name="actual_progress"
              type="number"
              min="0"
              max="100"
              step="0.1"
              defaultValue={Number(item.actual_progress)}
              required
            />
          </label>
          <label>
            Status
            <select name="status" defaultValue={item.status}>
              <option value="planejado">Planejado</option>
              <option value="liberado">Liberado</option>
              <option value="em_execucao">Em execução</option>
              <option value="bloqueado">Bloqueado</option>
              <option value="concluido">Concluído</option>
              <option value="cancelado">Cancelado</option>
            </select>
          </label>
          <label>
            Início real
            <input name="actual_start" type="date" defaultValue={item.actual_start || ""} />
          </label>
          <label>
            Término real
            <input name="actual_end" type="date" defaultValue={item.actual_end || ""} />
          </label>
          <label className="span-2">
            Observações
            <textarea name="notes" rows={3} defaultValue={item.notes || ""} />
          </label>
        </div>
        <div className="info-box">
          O painel executivo recalcula automaticamente o avanço ponderado, o
          desvio e a temperatura da obra após esta medição.
        </div>
        <footer>
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary">Salvar medição</button>
        </footer>
      </form>
    </div>
  );
}
