"use client";

import { FormEvent, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ConstructionWorkPackage, ErpData } from "../types";
import { Empty, Kpi, PanelTitle } from "../views-dashboard";
import { EapManagement } from "./eap-management";
import { WorkProgressGauge } from "./work-progress-gauge";
import {
  buildConstructionProjectProgress,
  listConstructionProjects,
  toWorkProgressPackage,
} from "./work-progress";

type Mutate = (operation: () => Promise<void>, success: string) => Promise<void>;

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
  const projects = listConstructionProjects(
    data.projects,
    data.constructionWorkPackages,
  );
  const [projectId, setProjectId] = useState(projects[0]?.id || "");
  const effectiveProjectId = projects.some((item) => item.id === projectId)
    ? projectId
    : projects[0]?.id || "";
  const currentProject = projects.find((item) => item.id === effectiveProjectId);
  const leafPackages = useMemo(
    () =>
      data.constructionWorkPackages
        .filter((item) => !item.is_summary)
        .map(toWorkProgressPackage),
    [data.constructionWorkPackages],
  );
  const progress = currentProject
    ? buildConstructionProjectProgress(
        currentProject,
        data.constructionWorkPackages,
      )
    : null;
  const allProjectPackages = progress?.all_packages ?? [];
  const projectPackages = progress?.leaf_packages ?? [];
  const summary = progress?.summary;
  const hasProjectBaseline = progress?.has_baseline ?? false;
  const critical = progress?.critical_packages ?? 0;
  const completed = progress?.completed_packages ?? 0;
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
            onChange={(event) => {
              setEditing(null);
              setProjectId(event.target.value);
            }}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.code} · {project.name}
              </option>
            ))}
          </select>
        </label>
      </section>

      {!projects.length ? (
        <section className="panel">
          <Empty text="Cadastre um empreendimento para criar a estrutura da obra." />
        </section>
      ) : (
        <>
          {!!projectPackages.length && summary && (
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
                  tone={
                    !hasProjectBaseline
                      ? "gold"
                      : summary.variance_pp < 0
                        ? "danger"
                        : "positive"
                  }
                  detail={
                    hasProjectBaseline
                      ? `SPI ${summary.spi.toFixed(2)}`
                      : "Sem linha de base"
                  }
                />
                <Kpi
                  label="Etapas em risco"
                  value={String(critical)}
                  tone={
                    !hasProjectBaseline
                      ? "gold"
                      : critical
                        ? "warning"
                        : "positive"
                  }
                  detail={
                    hasProjectBaseline
                      ? `${completed} de ${projectPackages.length} concluídas`
                      : "Aguardando percentuais previstos"
                  }
                />
              </section>

              <WorkProgressGauge
                key={effectiveProjectId}
                packages={leafPackages}
                projects={currentProject ? [currentProject] : []}
                initialProjectId={effectiveProjectId}
              />
            </>
          )}

          {currentProject && (
            <EapManagement
              key={effectiveProjectId}
              data={data}
              project={currentProject}
              packages={allProjectPackages}
              mutate={mutate}
              canManage={can("construction.manage")}
              onMeasure={setEditing}
            />
          )}
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
          updated_at: new Date().toISOString(),
        })
        .eq("id", item.id)
        .eq("organization_id", item.organization_id)
        .eq("project_id", item.project_id);
      if (error) throw error;
    }, "Avanço físico da etapa atualizado.");
    close();
  }

  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <form
        className="modal work-progress-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Medir ${item.name}`}
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
        }}
      >
        <PanelTitle eyebrow="MEDIÇÃO FÍSICA" title={item.name} />
        <button
          className="modal-close"
          type="button"
          aria-label="Fechar medição"
          autoFocus
          onClick={close}
        >
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
