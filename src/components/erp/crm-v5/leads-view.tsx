"use client";

import { useEffect, useMemo, useState } from "react";

import type { CrmRecord, ErpData } from "../types";
import { CrmSectionHeader, EmptyState, Status, UserName } from "./shared";
import type { CrmEnterpriseData } from "./types";
import styles from "./leads-view.module.css";

type LeadSort =
  | "origin_desc"
  | "origin_asc"
  | "name_asc"
  | "name_desc"
  | "project_asc"
  | "next_action_asc"
  | "score_desc"
  | "sla_asc";

const leadCollator = new Intl.Collator("pt-BR", {
  sensitivity: "base",
  numeric: true,
});

const leadDateFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
});

const leadTimeFormatter = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function urgency(lead: CrmRecord) {
  if (lead.record_status !== "aberta") return "neutral";
  if (lead.sla_due_at && new Date(lead.sla_due_at) < new Date()) return "danger";
  if (lead.priority === "urgente" || lead.temperature === "quente") return "warning";
  return "info";
}

function originDate(lead: CrmRecord) {
  return lead.originated_at || lead.created_at || null;
}

function dateNumber(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareOptionalDates(
  first: string | null | undefined,
  second: string | null | undefined,
  direction: "asc" | "desc",
) {
  const left = dateNumber(first);
  const right = dateNumber(second);
  if (left === null && right === null) return 0;
  if (left === null) return 1;
  if (right === null) return -1;
  return direction === "asc" ? left - right : right - left;
}

function formatOriginDate(value: string | null) {
  const timestamp = dateNumber(value);
  if (timestamp === null) return "Não informado";
  const date = new Date(timestamp);
  return `${leadDateFormatter.format(date)} · ${leadTimeFormatter.format(date)}`;
}

function isMetaLead(lead: CrmRecord) {
  return (
    lead.source_channel === "meta_lead_ads" ||
    lead.utm_source?.toLowerCase() === "meta" ||
    (lead.source || "").toLowerCase().includes("meta lead") ||
    (lead.tags || []).some((tag) => tag.toLowerCase() === "meta")
  );
}

export function LeadsView({
  data,
  crm,
  openLead,
  openActivity,
  focusId = null,
}: {
  data: ErpData;
  crm: CrmEnterpriseData;
  openLead: (lead?: CrmRecord) => void;
  openActivity: (lead?: CrmRecord) => void;
  focusId?: string | null;
}) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState(focusId ? "todos" : "aberta");
  const [temperature, setTemperature] = useState("todos");
  const [sort, setSort] = useState<LeadSort>("origin_desc");

  const projectById = useMemo(
    () => new Map(data.projects.map((project) => [project.id, project.name])),
    [data.projects],
  );

  const rows = useMemo(() => {
    const query = q.trim().toLocaleLowerCase("pt-BR");
    const filtered = crm.records.filter((item) => {
      if (status !== "todos" && item.record_status !== status) return false;
      if (temperature !== "todos" && item.temperature !== temperature) return false;
      if (!query) return true;
      const project = item.project_id ? projectById.get(item.project_id) || "" : "";
      return `${item.person_name} ${item.company_name || ""} ${item.phone || ""} ${
        item.email || ""
      } ${project} ${item.source || ""}`
        .toLocaleLowerCase("pt-BR")
        .includes(query);
    });

    return filtered.slice().sort((first, second) => {
      let result = 0;
      switch (sort) {
        case "origin_asc":
          result = compareOptionalDates(originDate(first), originDate(second), "asc");
          break;
        case "name_asc":
          result = leadCollator.compare(first.person_name || "", second.person_name || "");
          break;
        case "name_desc":
          result = leadCollator.compare(second.person_name || "", first.person_name || "");
          break;
        case "project_asc":
          result = leadCollator.compare(
            (first.project_id && projectById.get(first.project_id)) || "Não definido",
            (second.project_id && projectById.get(second.project_id)) || "Não definido",
          );
          break;
        case "next_action_asc":
          result = compareOptionalDates(first.next_action_at, second.next_action_at, "asc");
          break;
        case "score_desc":
          result = Number(second.lead_score || 0) - Number(first.lead_score || 0);
          break;
        case "sla_asc":
          result = compareOptionalDates(first.sla_due_at, second.sla_due_at, "asc");
          break;
        case "origin_desc":
        default:
          result = compareOptionalDates(originDate(first), originDate(second), "desc");
          break;
      }
      if (result !== 0) return result;
      const byName = leadCollator.compare(first.person_name || "", second.person_name || "");
      return byName || first.id.localeCompare(second.id);
    });
  }, [crm.records, projectById, q, sort, status, temperature]);

  useEffect(() => {
    if (!focusId || !rows.some((item) => item.id === focusId)) return;
    const frame = requestAnimationFrame(() => {
      const target = document.getElementById(`agenda-record-${focusId}`);
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusId, rows]);

  return (
    <div className="crm5-stack">
      <CrmSectionHeader
        eyebrow="CARTEIRA COMERCIAL"
        title="Leads e clientes potenciais"
        description="Pesquisa, segmentação, score, responsáveis, prioridade, origem e próxima ação."
        actions={
          <button className="primary" onClick={() => openLead()}>
            + Novo lead
          </button>
        }
      />

      <section className={`crm5-toolbar ${styles.toolbar}`}>
        <input
          value={q}
          onChange={(event) => setQ(event.target.value)}
          placeholder="Buscar por nome, empresa, telefone ou e-mail"
        />
        <select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="aberta">Em aberto</option>
          <option value="ganha">Ganhos</option>
          <option value="perdida">Perdidos</option>
          <option value="todos">Todos</option>
        </select>
        <select
          value={temperature}
          onChange={(event) => setTemperature(event.target.value)}
        >
          <option value="todos">Todas as temperaturas</option>
          <option value="quente">Quentes</option>
          <option value="morno">Mornos</option>
          <option value="frio">Frios</option>
        </select>
        <select
          aria-label="Ordenar leads"
          value={sort}
          onChange={(event) => setSort(event.target.value as LeadSort)}
        >
          <option value="origin_desc">Cadastro: mais recentes</option>
          <option value="origin_asc">Cadastro: mais antigos</option>
          <option value="name_asc">Nome: A a Z</option>
          <option value="name_desc">Nome: Z a A</option>
          <option value="project_asc">Empreendimento: A a Z</option>
          <option value="next_action_asc">Próxima ação: mais próxima</option>
          <option value="score_desc">Score: maior primeiro</option>
          <option value="sla_asc">SLA: mais urgente</option>
        </select>
        <span>{rows.length} registros</span>
      </section>

      <section className="crm5-panel">
        <div className={`crm5-lead-table ${styles.table}`}>
          <header>
            <span>Lead</span>
            <span>Empreendimento</span>
            <span>Cadastro</span>
            <span>Score</span>
            <span>Responsáveis</span>
            <span>Próxima ação</span>
            <span>Ações</span>
          </header>

          {rows.map((lead) => (
            <article
              id={`agenda-record-${lead.id}`}
              data-record-id={lead.id}
              tabIndex={lead.id === focusId ? -1 : undefined}
              className={lead.id === focusId ? "agenda-linked-target" : undefined}
              key={lead.id}
            >
              <div>
                <strong>{lead.person_name}</strong>
                <small>{lead.company_name || lead.phone || lead.email || "Sem contato"}</small>
                <div className="crm5-tags">
                  {(lead.tags || []).slice(0, 3).map((tag) => (
                    <i key={tag}>{tag}</i>
                  ))}
                </div>
              </div>

              <div>
                <strong>
                  {(lead.project_id && projectById.get(lead.project_id)) || "Não definido"}
                </strong>
                <small>{lead.source || lead.source_channel || "Origem não informada"}</small>
              </div>

              <div className={styles.origin}>
                <strong>{formatOriginDate(originDate(lead))}</strong>
                <small>{isMetaLead(lead) ? "Cadastro na Meta" : "Cadastro no CRM"}</small>
              </div>

              <div>
                <b
                  className={`crm5-score ${
                    Number(lead.lead_score || 0) >= 70 ? "hot" : ""
                  }`}
                >
                  {lead.lead_score || 0}
                </b>
                <Status tone={urgency(lead)}>{lead.temperature || "morno"}</Status>
              </div>

              <div>
                <small>
                  SDR: <UserName id={lead.sdr_user_id} data={data} />
                </small>
                <small>
                  Corretor: <UserName id={lead.broker_user_id} data={data} />
                </small>
              </div>

              <div>
                <strong>
                  {lead.next_action_at
                    ? new Date(lead.next_action_at).toLocaleString("pt-BR", {
                        timeZone: "America/Sao_Paulo",
                        day: "2-digit",
                        month: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })
                    : "Não agendada"}
                </strong>
                <small>
                  {lead.sla_due_at
                    ? `SLA ${new Date(lead.sla_due_at).toLocaleString("pt-BR", {
                        timeZone: "America/Sao_Paulo",
                        day: "2-digit",
                        month: "2-digit",
                        hour: "2-digit",
                        minute: "2-digit",
                      })}`
                    : "Sem SLA"}
                </small>
              </div>

              <div>
                <button onClick={() => openActivity(lead)}>Atividade</button>
                <button onClick={() => openLead(lead)}>Editar</button>
              </div>
            </article>
          ))}

          {!rows.length && (
            <EmptyState
              title="Nenhum lead encontrado"
              text="Ajuste os filtros ou cadastre uma nova oportunidade."
            />
          )}
        </div>
      </section>
    </div>
  );
}
