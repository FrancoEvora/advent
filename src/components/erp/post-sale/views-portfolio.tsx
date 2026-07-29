"use client";
import { useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ErpData } from "../types";
import type {
  PostSaleData,
  PostSaleJourney,
  PostSaleSection,
} from "./types";
import { brl, contractContext, journeyStages, stageLabel } from "./utils";
export function PostSaleOverview({
  data,
  ps,
  setSection,
}: {
  data: ErpData;
  ps: PostSaleData;
  setSection: (s: PostSaleSection) => void;
}) {
  const active = ps.contracts.filter((c) => c.status === "assinado");
  const contexts = active.map((c) => contractContext(data, ps, c.id));
  const open = contexts.reduce((s, c) => s + c.openAmount, 0);
  const overdue = contexts.reduce((s, c) => s + c.overdueAmount, 0);
  const tickets = ps.tickets.filter(
    (t) => !["resolvido", "cancelado"].includes(t.status),
  );
  const avgNps = ps.surveys.length
    ? ps.surveys.reduce((s, x) => s + x.score, 0) / ps.surveys.length
    : 0;
  const deeds = ps.deeds.filter(
    (d) => !["registrado", "concluido"].includes(d.status),
  );
  const risks = ps.journeys.filter((j) =>
    ["alto", "critico"].includes(j.risk_level),
  );
  return (
    <div className="post-sale-stack">
      <section className="post-sale-hero">
        <div>
          <small>PÓS-VENDA 360°</small>
          <h2>Carteira, relacionamento e receita protegida.</h2>
          <p>
            Da assinatura à quitação, entrega, escritura e relacionamento
            pós-entrega.
          </p>
        </div>
        <div className="post-sale-period">
          <button onClick={() => setSection("portfolio")}>
            Abrir carteira
          </button>
          <button onClick={() => setSection("tickets")}>
            Central de atendimento
          </button>
        </div>
      </section>
      <section className="post-sale-kpis">
        <article>
          <small>Contratos ativos</small>
          <strong>{active.length}</strong>
          <span>
            {brl.format(
              contexts.reduce(
                (s, c) => s + Number(c.proposal?.sale_price || 0),
                0,
              ),
            )}{" "}
            contratados
          </span>
        </article>
        <article>
          <small>Saldo a receber</small>
          <strong>{brl.format(open)}</strong>
          <span>{contexts.reduce((s, c) => s + c.open.length, 0)} títulos</span>
        </article>
        <article className={overdue > 0 ? "risk" : ""}>
          <small>Inadimplência</small>
          <strong>{brl.format(overdue)}</strong>
          <span>
            {contexts.reduce((s, c) => s + c.overdue.length, 0)} vencidos
          </span>
        </article>
        <article>
          <small>Chamados abertos</small>
          <strong>{tickets.length}</strong>
          <span>
            {
              tickets.filter(
                (t) => t.sla_due_at && new Date(t.sla_due_at) < new Date(),
              ).length
            }{" "}
            fora do SLA
          </span>
        </article>
        <article>
          <small>Escrituras pendentes</small>
          <strong>{deeds.length}</strong>
          <span>processos ativos</span>
        </article>
        <article>
          <small>NPS médio</small>
          <strong>{avgNps.toFixed(1)}</strong>
          <span>{ps.surveys.length} respostas</span>
        </article>
      </section>
      {risks.length > 0 && (
        <section className="post-sale-alert">
          <strong>{risks.length} cliente(s) exigem atenção imediata.</strong>
          <button onClick={() => setSection("journey")}>Revisar riscos</button>
        </section>
      )}
      <section className="post-sale-grid two">
        <article className="post-sale-panel">
          <header>
            <div>
              <small>CARTEIRA</small>
              <h3>Clientes por etapa</h3>
            </div>
          </header>
          <div className="stage-bars">
            {journeyStages.map((stage) => {
              const n = ps.journeys.filter(
                (j) => j.current_stage === stage,
              ).length;
              return (
                <div key={stage}>
                  <span>{stageLabel[stage]}</span>
                  <i>
                    <b
                      style={{
                        width: `${active.length ? (n / active.length) * 100 : 0}%`,
                      }}
                    />
                  </i>
                  <strong>{n}</strong>
                </div>
              );
            })}
          </div>
        </article>
        <article className="post-sale-panel">
          <header>
            <div>
              <small>PRIORIDADES</small>
              <h3>Próximas ações</h3>
            </div>
          </header>
          <div className="post-sale-list">
            {ps.journeys
              .filter((j) => j.next_action)
              .sort((a, b) =>
                (a.next_action_at || "9999").localeCompare(
                  b.next_action_at || "9999",
                ),
              )
              .slice(0, 8)
              .map((j) => {
                const c = contractContext(data, ps, j.contract_id);
                return (
                  <button key={j.id} onClick={() => setSection("journey")}>
                    <div>
                      <strong>
                        {c.proposal?.customer_name ||
                          c.contract?.contract_number}
                      </strong>
                      <small>{j.next_action}</small>
                    </div>
                    <time>
                      {j.next_action_at
                        ? new Date(j.next_action_at).toLocaleDateString("pt-BR")
                        : "Sem data"}
                    </time>
                  </button>
                );
              })}
          </div>
        </article>
      </section>
    </div>
  );
}
export function PortfolioView({
  data,
  ps,
}: {
  data: ErpData;
  ps: PostSaleData;
}) {
  const [search, setSearch] = useState("");
  const [projectId, setProjectId] = useState("");
  const [contractStatus, setContractStatus] = useState("");
  const [riskLevel, setRiskLevel] = useState("");
  const [overdueOnly, setOverdueOnly] = useState(false);

  const allRows = useMemo(
    () =>
      ps.contracts
        .map((contract) => contractContext(data, ps, contract.id))
        .filter((context) => Boolean(context.contract)),
    [data, ps],
  );

  const journeysByContract = useMemo(
    () =>
      new Map(
        ps.journeys.map((journey) => [journey.contract_id, journey] as const),
      ),
    [ps.journeys],
  );

  const projects = useMemo(() => {
    const uniqueProjects = new Map<string, string>();
    allRows.forEach((context) => {
      if (context.project?.id && context.project.name) {
        uniqueProjects.set(context.project.id, context.project.name);
      }
    });
    return [...uniqueProjects.entries()].sort((a, b) =>
      a[1].localeCompare(b[1], "pt-BR"),
    );
  }, [allRows]);

  const contractStatuses = useMemo(
    () =>
      [...new Set(allRows.map((context) => context.contract?.status))]
        .filter((status): status is string => Boolean(status))
        .sort((a, b) => a.localeCompare(b, "pt-BR")),
    [allRows],
  );

  const riskLevels = useMemo(
    () =>
      [
        ...new Set(
          allRows.map(
            (context) =>
              journeysByContract.get(context.contract?.id || "")?.risk_level ||
              "baixo",
          ),
        ),
      ].sort((a, b) => a.localeCompare(b, "pt-BR")),
    [allRows, journeysByContract],
  );

  const normalizedSearch = search.trim().toLocaleLowerCase("pt-BR");
  const rows = useMemo(
    () =>
      allRows.filter((context) => {
        const journey = journeysByContract.get(context.contract?.id || "");
        const searchable = [
          context.proposal?.customer_name,
          context.contact?.name,
          context.contract?.contract_number,
          context.unit?.unit_code,
          context.project?.name,
        ]
          .filter(Boolean)
          .join(" ")
          .toLocaleLowerCase("pt-BR");

        return (
          (!normalizedSearch || searchable.includes(normalizedSearch)) &&
          (!projectId || context.project?.id === projectId) &&
          (!contractStatus ||
            context.contract?.status === contractStatus) &&
          (!riskLevel || (journey?.risk_level || "baixo") === riskLevel) &&
          (!overdueOnly || context.overdueAmount > 0)
        );
      }),
    [
      allRows,
      contractStatus,
      journeysByContract,
      normalizedSearch,
      overdueOnly,
      projectId,
      riskLevel,
    ],
  );

  const summarize = (contexts: typeof allRows) => ({
    contracted: contexts.reduce(
      (sum, context) => sum + Number(context.proposal?.sale_price || 0),
      0,
    ),
    received: contexts.reduce(
      (sum, context) => sum + context.received,
      0,
    ),
    open: contexts.reduce(
      (sum, context) => sum + context.openAmount,
      0,
    ),
    overdue: contexts.reduce(
      (sum, context) => sum + context.overdueAmount,
      0,
    ),
    contracts: contexts.length,
    clients: new Set(
      contexts.map(
        (context) =>
          context.contract?.contact_id ||
          context.contact?.id ||
          context.proposal?.customer_name ||
          context.contract?.id,
      ),
    ).size,
  });

  const totals = summarize(rows);
  const generalTotals = summarize(allRows);
  const hasFilters =
    Boolean(search.trim()) ||
    Boolean(projectId) ||
    Boolean(contractStatus) ||
    Boolean(riskLevel) ||
    overdueOnly;

  function clearFilters() {
    setSearch("");
    setProjectId("");
    setContractStatus("");
    setRiskLevel("");
    setOverdueOnly(false);
  }

  function readableStatus(value: string) {
    return (
      stageLabel[value] ||
      value
        .replaceAll("_", " ")
        .replace(/^\p{L}/u, (character) => character.toLocaleUpperCase("pt-BR"))
    );
  }

  return (
    <div className="post-sale-stack">
      <section className="post-sale-heading">
        <div>
          <small>CARTEIRA ATIVA</small>
          <h2>Clientes e contratos</h2>
          <p>Posição contratual, financeira, documental e de atendimento.</p>
        </div>
      </section>

      <section className="post-sale-kpis compact" aria-label="Totais da carteira">
        <article>
          <small>Valor contratado</small>
          <strong>{brl.format(totals.contracted)}</strong>
          <span>de {brl.format(generalTotals.contracted)} na carteira</span>
        </article>
        <article>
          <small>Valor recebido</small>
          <strong>{brl.format(totals.received)}</strong>
          <span>de {brl.format(generalTotals.received)} na carteira</span>
        </article>
        <article>
          <small>Saldo em aberto</small>
          <strong>{brl.format(totals.open)}</strong>
          <span>de {brl.format(generalTotals.open)} na carteira</span>
        </article>
        <article className={totals.overdue > 0 ? "risk" : ""}>
          <small>Valor vencido</small>
          <strong>{brl.format(totals.overdue)}</strong>
          <span>de {brl.format(generalTotals.overdue)} na carteira</span>
        </article>
        <article>
          <small>Contratos</small>
          <strong>{totals.contracts}</strong>
          <span>de {generalTotals.contracts} cadastrados</span>
        </article>
        <article>
          <small>Clientes únicos</small>
          <strong>{totals.clients}</strong>
          <span>de {generalTotals.clients} na carteira</span>
        </article>
      </section>

      <section
        className="post-sale-panel portfolio-filters"
        aria-label="Filtros da carteira"
      >
        <div className="form-grid">
          <label>
            Buscar
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Cliente, contrato ou unidade"
            />
          </label>
          <label>
            Empreendimento
            <select
              value={projectId}
              onChange={(event) => setProjectId(event.target.value)}
            >
              <option value="">Todos os empreendimentos</option>
              {projects.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Situação contratual
            <select
              value={contractStatus}
              onChange={(event) => setContractStatus(event.target.value)}
            >
              <option value="">Todas as situações</option>
              {contractStatuses.map((status) => (
                <option key={status} value={status}>
                  {readableStatus(status)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Risco
            <select
              value={riskLevel}
              onChange={(event) => setRiskLevel(event.target.value)}
            >
              <option value="">Todos os níveis</option>
              {riskLevels.map((risk) => (
                <option key={risk} value={risk}>
                  {readableStatus(risk)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Valores vencidos
            <select
              value={overdueOnly ? "overdue" : "all"}
              onChange={(event) =>
                setOverdueOnly(event.target.value === "overdue")
              }
            >
              <option value="all">Todos os contratos</option>
              <option value="overdue">Somente com vencidos</option>
            </select>
          </label>
          <button type="button" onClick={clearFilters} disabled={!hasFilters}>
            Limpar filtros
          </button>
        </div>
        <p role="status" aria-live="polite">
          Exibindo <strong>{rows.length}</strong> de {allRows.length} contrato(s).
          Os totalizadores refletem os filtros aplicados.
        </p>
      </section>

      <section className="post-sale-table">
        <header>
          <span>Cliente / contrato</span>
          <span>Unidade</span>
          <span>Valor</span>
          <span>Recebido</span>
          <span>Em aberto</span>
          <span>Vencido</span>
          <span>Situação</span>
        </header>
        {rows.map((x) => {
          if (!x.contract) return null;
          const j = journeysByContract.get(x.contract.id);
          return (
            <article key={x.contract.id}>
              <strong>
                {x.proposal?.customer_name || x.contact?.name || "Sem nome"}
                <small>{x.contract.contract_number}</small>
              </strong>
              <span>
                {x.project?.name || "Sem empreendimento"}
                <small>{x.unit?.unit_code}</small>
              </span>
              <span>{brl.format(Number(x.proposal?.sale_price || 0))}</span>
              <span>{brl.format(x.received)}</span>
              <span>{brl.format(x.openAmount)}</span>
              <span className={x.overdueAmount > 0 ? "danger" : ""}>
                {brl.format(x.overdueAmount)}
              </span>
              <i data-risk={j?.risk_level || "baixo"}>
                {stageLabel[j?.current_stage || x.contract.status] ||
                  x.contract.status}
              </i>
            </article>
          );
        })}
        {!rows.length && (
          <div className="post-sale-empty" role="status">
            Nenhum contrato corresponde aos filtros selecionados.
          </div>
        )}
      </section>
    </div>
  );
}
export function JourneyView({
  data,
  ps,
  reload,
}: {
  data: ErpData;
  ps: PostSaleData;
  reload: () => Promise<void>;
}) {
  const [edit, setEdit] = useState<PostSaleJourney | null>(null);
  async function save(j: PostSaleJourney, form: FormData) {
    const client = getSupabase();
    if (!client) return;
    const stage = String(form.get("stage"));
    const progress = Math.max(0, Math.min(100, Number(form.get("progress"))));
    const r = await client
      .from("post_sale_journeys")
      .update({
        current_stage: stage,
        progress_pct: progress,
        documentation_status: String(form.get("documentation_status")),
        delivery_status: String(form.get("delivery_status")),
        deed_status: String(form.get("deed_status")),
        risk_level: String(form.get("risk_level")),
        next_action: String(form.get("next_action") || "") || null,
        next_action_at: String(form.get("next_action_at") || "") || null,
        notes: String(form.get("notes") || "") || null,
        updated_at: new Date().toISOString(),
      })
      .eq("id", j.id);
    if (r.error) throw r.error;
    await reload();
    setEdit(null);
  }
  return (
    <div className="post-sale-stack">
      <section className="post-sale-heading">
        <div>
          <small>JORNADA DO CLIENTE</small>
          <h2>Etapas, pendências e riscos</h2>
        </div>
      </section>
      <section className="journey-board">
        {ps.journeys.map((j) => {
          const c = contractContext(data, ps, j.contract_id);
          return (
            <article key={j.id}>
              <header>
                <div>
                  <small>{c.contract?.contract_number}</small>
                  <h3>{c.proposal?.customer_name}</h3>
                  <span>
                    {c.project?.name} · {c.unit?.unit_code}
                  </span>
                </div>
                <i data-risk={j.risk_level}>{j.risk_level}</i>
              </header>
              <div className="journey-progress">
                <i>
                  <b style={{ width: `${j.progress_pct}%` }} />
                </i>
                <strong>{j.progress_pct}%</strong>
              </div>
              <dl>
                <div>
                  <dt>Etapa</dt>
                  <dd>{stageLabel[j.current_stage] || j.current_stage}</dd>
                </div>
                <div>
                  <dt>Documentos</dt>
                  <dd>{j.documentation_status}</dd>
                </div>
                <div>
                  <dt>Entrega</dt>
                  <dd>{j.delivery_status}</dd>
                </div>
                <div>
                  <dt>Escritura</dt>
                  <dd>{j.deed_status}</dd>
                </div>
              </dl>
              <footer>
                <span>{j.next_action || "Sem próxima ação"}</span>
                <button onClick={() => setEdit(j)}>Atualizar</button>
              </footer>
            </article>
          );
        })}
      </section>
      {edit && (
        <div className="modal-backdrop" onMouseDown={() => setEdit(null)}>
          <form
            className="modal large"
            onSubmit={(e) => {
              e.preventDefault();
              save(edit, new FormData(e.currentTarget));
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              className="modal-close"
              onClick={() => setEdit(null)}
            >
              ×
            </button>
            <header>
              <small>JORNADA</small>
              <h2>Atualizar cliente</h2>
            </header>
            <div className="form-grid three">
              <label>
                Etapa
                <select name="stage" defaultValue={edit.current_stage}>
                  {journeyStages.map((s) => (
                    <option key={s} value={s}>
                      {stageLabel[s]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Progresso (%)
                <input
                  name="progress"
                  type="number"
                  min="0"
                  max="100"
                  defaultValue={edit.progress_pct}
                />
              </label>
              <label>
                Risco
                <select name="risk_level" defaultValue={edit.risk_level}>
                  <option>baixo</option>
                  <option>medio</option>
                  <option>alto</option>
                  <option>critico</option>
                </select>
              </label>
              <label>
                Documentação
                <select
                  name="documentation_status"
                  defaultValue={edit.documentation_status}
                >
                  <option>pendente</option>
                  <option>em_analise</option>
                  <option>completa</option>
                  <option>irregular</option>
                </select>
              </label>
              <label>
                Entrega
                <select
                  name="delivery_status"
                  defaultValue={edit.delivery_status}
                >
                  <option>nao_iniciada</option>
                  <option>planejada</option>
                  <option>agendada</option>
                  <option>concluida</option>
                </select>
              </label>
              <label>
                Escritura
                <select name="deed_status" defaultValue={edit.deed_status}>
                  <option>aguardando_quitacao</option>
                  <option>documentacao</option>
                  <option>cartorio</option>
                  <option>registrada</option>
                </select>
              </label>
              <label className="span-2">
                Próxima ação
                <input
                  name="next_action"
                  defaultValue={edit.next_action || ""}
                />
              </label>
              <label>
                Data
                <input
                  name="next_action_at"
                  type="datetime-local"
                  defaultValue={edit.next_action_at?.slice(0, 16) || ""}
                />
              </label>
              <label className="span-3">
                Observações
                <textarea
                  name="notes"
                  rows={3}
                  defaultValue={edit.notes || ""}
                />
              </label>
            </div>
            <footer>
              <button type="button" onClick={() => setEdit(null)}>
                Cancelar
              </button>
              <button className="primary">Salvar jornada</button>
            </footer>
          </form>
        </div>
      )}
    </div>
  );
}
