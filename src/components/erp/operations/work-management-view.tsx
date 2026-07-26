"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ConstructionWorkPackage, ErpData } from "../types";
import { Empty, Kpi, PanelTitle } from "../views-dashboard";
import { WorkProgressGauge } from "./work-progress-gauge";
import { calculateWorkProgress, type WorkProgressPackage } from "./work-progress";

type Mutate = (operation: () => Promise<void>, success: string) => Promise<void>;

type EapTemplate = { template_code:string; name:string; description:string; category:string; icon:string; estimated_duration_days:number; active:boolean; sort_order:number };
type EapTemplateItem = { template_code:string; item_key:string; wbs_code:string; name:string; sequence:number; is_summary:boolean };

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
  const [showTemplates,setShowTemplates]=useState(false);
  const [templates,setTemplates]=useState<EapTemplate[]>([]);
  const [templateItems,setTemplateItems]=useState<EapTemplateItem[]>([]);
  const [selectedTemplate,setSelectedTemplate]=useState<string | null>(null);

  useEffect(()=>{
    const client=getSupabase(); if(!client)return;
    Promise.all([
      client.from("construction_eap_templates").select("*").eq("active",true).order("sort_order"),
      client.from("construction_eap_template_items").select("template_code,item_key,wbs_code,name,sequence,is_summary").order("template_code").order("sequence"),
    ]).then(([templateResult,itemResult])=>{
      if(!templateResult.error)setTemplates((templateResult.data||[]) as EapTemplate[]);
      if(!itemResult.error)setTemplateItems((itemResult.data||[]) as EapTemplateItem[]);
    });
  },[]);

  async function applyTemplate(template:EapTemplate){
    if(!effectiveProjectId)return;
    const project=data.projects.find(item=>item.id===effectiveProjectId);
    const start=window.prompt("Data inicial da linha de base (AAAA-MM-DD)",project?.start_date||new Date().toISOString().slice(0,10));
    if(!start)return;
    const budget=Number(window.prompt("Orçamento total da obra em R$",String(project?.total_budget||0))||0);
    if(!window.confirm(`Aplicar o modelo ${template.name}? Pacotes já existentes não serão duplicados.`))return;
    await mutate(async()=>{
      const client=getSupabase(); if(!client)throw new Error("Supabase indisponível.");
      const {error}=await client.rpc("apply_construction_eap_template",{p_organization_id:data.organization.id,p_project_id:effectiveProjectId,p_template_code:template.template_code,p_start_date:start,p_total_budget:Number.isFinite(budget)?budget:0});
      if(error)throw error;
    },`Modelo ${template.name} aplicado à obra.`);
    setShowTemplates(false);
  }

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
        <button type="button" onClick={()=>setShowTemplates(value=>!value)}>▦ Modelos de EAP</button>
      </section>

      {showTemplates&&<section className="work-template-library"><header><div><small>BIBLIOTECA DE EAP</small><h3>Modelos editáveis para loteamentos</h3><p>Use uma estrutura de referência e ajuste datas, pesos, responsáveis e orçamento depois da aplicação.</p></div><span>{templates.length} modelos</span></header><div>{templates.map(template=>{const items=templateItems.filter(item=>item.template_code===template.template_code),executive=items.filter(item=>!item.is_summary).length;return <article key={template.template_code} className={selectedTemplate===template.template_code?"selected":""} onClick={()=>setSelectedTemplate(template.template_code)}><i>{template.icon||"▦"}</i><small>{template.category}</small><h4>{template.name}</h4><p>{template.description}</p><footer><span>{executive} pacotes executivos</span><span>{template.estimated_duration_days} dias</span></footer>{selectedTemplate===template.template_code&&<div className="work-template-preview">{items.slice(0,6).map(item=><span key={item.item_key}><b>{item.wbs_code}</b>{item.name}</span>)}<button className="primary" onClick={event=>{event.stopPropagation();applyTemplate(template)}}>Usar como base</button></div>}</article>})}</div></section>}

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
                    <span className="work-table-progress"><i><b style={{width:`${Math.min(100,Math.max(0,planned))}%`}} /></i><em>{percent.format(planned)}%</em></span>
                    <span className="work-table-progress work-table-progress-actual"><i><b style={{width:`${Math.min(100,Math.max(0,actual))}%`}} /></i><em>{percent.format(actual)}%</em></span>
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
