"use client";

import { type FormEvent, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type {
  ContractMeasurement,
  ContractMeasurementItem,
  ContractMeasurementPeriod,
  ErpData,
  OperationalContract,
  OperationalContractItem,
} from "../types";
import { dateAtNoon, money, shortDate } from "../utils";
import { Empty, Kpi, PanelTitle } from "../views-dashboard";

type Mutate = (operation: () => Promise<void>, success: string) => Promise<void>;
type Can = (key: string) => boolean;

type ItemHours = {
  raw: number;
  downtime: number;
  productive: number;
  measured: number;
  value: number;
  latestMeter: number | null;
};

type MeasurementDraft = {
  enabled: boolean;
  meterStart: string;
  meterEnd: string;
  downtime: string;
  notes: string;
};

const hour = new Intl.NumberFormat("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
const number = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
const activeMeasurementStatuses = new Set(["submetida", "aprovada", "paga"]);
const openPeriodStatuses = new Set(["aberto", "reaberto"]);

const statusLabels: Record<string, string> = {
  em_aprovacao: "Em aprovação",
  vigente: "Vigente",
  suspenso: "Suspenso",
  encerrado: "Encerrado",
  cancelado: "Cancelado",
  submetida: "Submetida",
  aprovada: "Aprovada",
  paga: "Paga",
  rejeitada: "Rejeitada",
  aguardando_documentos: "Aguardando documentos",
  documentos_em_analise: "Documentos em análise",
  documentos_rejeitados: "Documentos rejeitados",
  pronto_para_aprovacao: "Pronta para aprovação",
};

function label(value: string) {
  return statusLabels[value] || value.replaceAll("_", " ");
}

function safeDate(value: string | null | undefined) {
  return value ? shortDate.format(dateAtNoon(value)) : "—";
}

function hoursFromMeasurement(item: ContractMeasurementItem) {
  if (item.meter_start === null || item.meter_end === null) return { raw: 0, downtime: 0, productive: 0 };
  const raw = Math.max(0, Number(item.meter_end) - Number(item.meter_start));
  const downtime = Math.max(0, Math.min(raw, Number(item.downtime_quantity || 0)));
  return { raw, downtime, productive: Math.max(0, raw - downtime) };
}

function statsForItem(
  itemId: string,
  measurements: ContractMeasurement[],
  measurementItems: ContractMeasurementItem[],
): ItemHours {
  const validMeasurementIds = new Set(
    measurements.filter(measurement => activeMeasurementStatuses.has(measurement.status)).map(measurement => measurement.id),
  );
  const rows = measurementItems.filter(row => row.contract_item_id === itemId && validMeasurementIds.has(row.measurement_id));
  const totals = rows.reduce((result, row) => {
    const measuredHours = hoursFromMeasurement(row);
    result.raw += measuredHours.raw;
    result.downtime += measuredHours.downtime;
    result.productive += measuredHours.productive;
    result.measured += Number(row.current_quantity || 0);
    result.value += Number(row.current_quantity || 0) * Number(row.unit_price_snapshot || 0);
    return result;
  }, { raw: 0, downtime: 0, productive: 0, measured: 0, value: 0 });
  const latest = rows
    .filter(row => row.meter_end !== null)
    .sort((a, b) => {
      const measurementA = measurements.find(measurement => measurement.id === a.measurement_id);
      const measurementB = measurements.find(measurement => measurement.id === b.measurement_id);
      return String(measurementB?.period_end || "").localeCompare(String(measurementA?.period_end || ""));
    })[0];
  return { ...totals, latestMeter: latest?.meter_end === null || latest?.meter_end === undefined ? null : Number(latest.meter_end) };
}

function isMachineItem(item: OperationalContractItem, contractType = "") {
  const unit = item.unit.toLowerCase();
  const method = item.measurement_method.toLowerCase();
  const type = contractType.toLowerCase();
  return item.item_type === "locacao"
    || Boolean(item.equipment_identifier)
    || type.includes("maquina")
    || type.includes("equipamento")
    || method.includes("hour")
    || method.includes("hor")
    || ["h", "hr", "hora", "horas"].includes(unit);
}

export function ContractsManagement({
  data,
  mutate,
  can,
}: {
  data: ErpData;
  mutate: Mutate;
  can: Can;
}) {
  const contracts = data.operationalContracts;
  const items = data.operationalContractItems;
  const measurements = data.contractMeasurements;
  const measurementItems = data.contractMeasurementItems;
  const periods = data.contractMeasurementPeriods;
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [projectId, setProjectId] = useState("");
  const [selectedId, setSelectedId] = useState("");
  const [measureContract, setMeasureContract] = useState<OperationalContract | null>(null);
  const [decision, setDecision] = useState<ContractMeasurement | null>(null);

  const filtered = useMemo(() => {
    const term = search.trim().toLocaleLowerCase("pt-BR");
    return contracts.filter(contract => {
      const supplier = data.contacts.find(contact => contact.id === contract.supplier_contact_id);
      const searchable = `${contract.contract_number} ${contract.title} ${contract.scope || ""} ${supplier?.name || ""} ${supplier?.trade_name || ""}`.toLocaleLowerCase("pt-BR");
      return (!term || searchable.includes(term))
        && (!status || contract.status === status)
        && (!projectId || contract.project_id === projectId);
    });
  }, [contracts, data.contacts, projectId, search, status]);

  const selected = filtered.find(contract => contract.id === selectedId)
    || contracts.find(contract => contract.id === selectedId)
    || filtered[0]
    || null;
  const visibleIds = new Set(filtered.map(contract => contract.id));
  const visibleItems = items.filter(item => {
    const contract = contracts.find(value => value.id === item.contract_id);
    return visibleIds.has(item.contract_id) && item.active && isMachineItem(item, contract?.contract_type);
  });
  const visibleMeasurements = measurements.filter(measurement => visibleIds.has(measurement.contract_id));
  const totalStats = visibleItems.reduce((result, item) => {
    const itemStats = statsForItem(item.id, visibleMeasurements, measurementItems);
    result.contracted += Number(item.contracted_quantity || 0);
    result.measured += itemStats.measured;
    result.raw += itemStats.raw;
    result.downtime += itemStats.downtime;
    result.productive += itemStats.productive;
    result.value += itemStats.value;
    return result;
  }, { contracted: 0, measured: 0, raw: 0, downtime: 0, productive: 0, value: 0 });
  const pending = visibleMeasurements.filter(measurement => measurement.status === "submetida").length;
  const efficiency = totalStats.raw > 0 ? totalStats.productive / totalStats.raw * 100 : 0;
  const canRegister = can("contracts.measure") || can("contracts.manage");
  const canApprove = can("contracts.approve");

  return <div className="stack contract-ops-view">
    <section className="module-toolbar contract-ops-toolbar">
      <div>
        <small>CONTRATOS OPERACIONAIS · MÁQUINAS E EQUIPAMENTOS</small>
        <h2>Horas, horímetros e medições</h2>
        <p>Controle horas brutas, paradas, produção, saldo contratado e valor medido.</p>
      </div>
      <button
        className="primary"
        disabled={!selected || selected.status !== "vigente" || !canRegister}
        onClick={() => selected && setMeasureContract(selected)}
        title={!canRegister ? "Requer permissão contracts.measure." : undefined}
      >
        + Registrar medição
      </button>
    </section>

    <section className="kpi-grid six contract-ops-kpis">
      <Kpi label="Contratos vigentes" value={String(filtered.filter(contract => contract.status === "vigente").length)} detail={`${visibleItems.length} máquinas monitoradas`} tone="positive" />
      <Kpi label="Horas contratadas" value={`${hour.format(totalStats.contracted)} h`} detail={`${hour.format(Math.max(0, totalStats.contracted - totalStats.measured))} h de saldo`} tone="gold" />
      <Kpi label="Horas brutas" value={`${hour.format(totalStats.raw)} h`} detail="Variação total dos horímetros" />
      <Kpi label="Horas produtivas" value={`${hour.format(totalStats.productive)} h`} detail={`${efficiency.toFixed(1)}% de aproveitamento`} tone="positive" />
      <Kpi label="Paradas registradas" value={`${hour.format(totalStats.downtime)} h`} detail={totalStats.raw ? `${(totalStats.downtime / totalStats.raw * 100).toFixed(1)}% das horas brutas` : "Sem apontamentos"} tone={totalStats.downtime ? "warning" : ""} />
      <Kpi label="Valor medido" value={money.format(totalStats.value)} detail={`${pending} medições aguardando aprovação`} tone={pending ? "warning" : "gold"} />
    </section>

    <section className="panel contract-ops-filter">
      <PanelTitle eyebrow="CARTEIRA" title="Contratos de locação e equipamentos" />
      <div className="form-grid three">
        <label>Buscar<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Número, máquina, fornecedor ou escopo" /></label>
        <label>Status<select value={status} onChange={event => setStatus(event.target.value)}><option value="">Todos os status</option>{[...new Set(contracts.map(contract => contract.status))].map(value => <option key={value} value={value}>{label(value)}</option>)}</select></label>
        <label>Empreendimento<select value={projectId} onChange={event => setProjectId(event.target.value)}><option value="">Todos os empreendimentos</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.code} · {project.name}</option>)}</select></label>
      </div>
    </section>

    <section className="contract-ops-layout">
      <div className="panel contract-ops-list">
        <PanelTitle eyebrow="CONTRATOS" title={`${filtered.length} resultados`} />
        <div>
          {filtered.map(contract => {
            const supplier = data.contacts.find(contact => contact.id === contract.supplier_contact_id);
            const project = data.projects.find(item => item.id === contract.project_id);
            const contractItems = items.filter(item => item.contract_id === contract.id && item.active && isMachineItem(item, contract.contract_type));
            return <button key={contract.id} className={selected?.id === contract.id ? "active" : ""} onClick={() => setSelectedId(contract.id)}>
              <span className={`contract-ops-status ${contract.status}`}>{label(contract.status)}</span>
              <strong>{contract.contract_number} · {contract.title}</strong>
              <small>{supplier?.trade_name || supplier?.name || "Fornecedor não identificado"}</small>
              <small>{project?.name || "Corporativo"} · {contractItems.length} equipamento(s)</small>
              <b>{money.format(Number(contract.current_amount || 0))}</b>
            </button>;
          })}
          {!filtered.length && <Empty text="Nenhum contrato corresponde aos filtros." />}
        </div>
      </div>

      <div className="panel contract-ops-detail">
        {selected
          ? <ContractDetail
              contract={selected}
              data={data}
              items={items}
              measurements={measurements}
              measurementItems={measurementItems}
              periods={periods}
              canApprove={canApprove}
              onMeasure={() => setMeasureContract(selected)}
              onDecision={setDecision}
              canRegister={canRegister}
            />
          : <Empty text="Selecione um contrato para acompanhar os horímetros." />}
      </div>
    </section>

    {measureContract && <MeasurementModal
      key={measureContract.id}
      contract={measureContract}
      data={data}
      items={items}
      measurements={measurements}
      measurementItems={measurementItems}
      periods={periods}
      mutate={mutate}
      can={can}
      close={() => setMeasureContract(null)}
    />}
    {decision && <MeasurementDecisionModal
      measurement={decision}
      periods={periods}
      mutate={mutate}
      close={() => setDecision(null)}
    />}
  </div>;
}

function ContractDetail({
  contract,
  data,
  items,
  measurements,
  measurementItems,
  periods,
  canApprove,
  onMeasure,
  onDecision,
  canRegister,
}: {
  contract: OperationalContract;
  data: ErpData;
  items: OperationalContractItem[];
  measurements: ContractMeasurement[];
  measurementItems: ContractMeasurementItem[];
  periods: ContractMeasurementPeriod[];
  canApprove: boolean;
  onMeasure: () => void;
  onDecision: (measurement: ContractMeasurement) => void;
  canRegister: boolean;
}) {
  const supplier = data.contacts.find(contact => contact.id === contract.supplier_contact_id);
  const project = data.projects.find(item => item.id === contract.project_id);
  const rows = items.filter(item => item.contract_id === contract.id && item.active && isMachineItem(item, contract.contract_type));
  const contractMeasurements = measurements
    .filter(measurement => measurement.contract_id === contract.id)
    .sort((a, b) => b.measurement_number - a.measurement_number);
  const contractPeriods = periods.filter(period => period.contract_id === contract.id);

  return <div className="contract-ops-detail-content">
    <header>
      <div>
        <small>{contract.contract_number} · {label(contract.contract_type)}</small>
        <h3>{contract.title}</h3>
        <p>{supplier?.trade_name || supplier?.name || "Fornecedor não identificado"} · {project?.name || "Corporativo"}</p>
      </div>
      <span className={`contract-ops-status ${contract.status}`}>{label(contract.status)}</span>
    </header>
    <div className="contract-ops-summary">
      <span><small>Vigência</small><strong>{safeDate(contract.start_date)} a {safeDate(contract.end_date)}</strong></span>
      <span><small>Valor atual</small><strong>{money.format(Number(contract.current_amount || 0))}</strong></span>
      <span><small>Períodos</small><strong>{contractPeriods.length} cadastrados</strong></span>
      <span><small>Escopo</small><strong>{contract.scope || "Não informado"}</strong></span>
    </div>

    <section className="contract-ops-items">
      <div className="contract-ops-section-title"><div><small>CONTROLE POR EQUIPAMENTO</small><h4>Horímetros e saldo de horas</h4></div><button className="primary" disabled={contract.status !== "vigente" || !canRegister} onClick={onMeasure}>Nova medição</button></div>
      <div className="contract-ops-item-table">
        <header><span>Máquina / item</span><span>Último horímetro</span><span>Horas brutas</span><span>Paradas</span><span>Produtivas</span><span>Contratado / saldo</span><span>Valor medido</span></header>
        {rows.map(item => {
          const stats = statsForItem(item.id, contractMeasurements, measurementItems);
          const remaining = Math.max(0, Number(item.contracted_quantity || 0) - stats.measured);
          return <article key={item.id}>
            <div><strong>{item.equipment_identifier || item.description}</strong><small>{item.code} · {item.description}</small></div>
            <strong>{stats.latestMeter === null ? "—" : `${number.format(stats.latestMeter)} h`}</strong>
            <span>{hour.format(stats.raw)} h</span>
            <span className={stats.downtime ? "warning" : ""}>{hour.format(stats.downtime)} h</span>
            <strong>{hour.format(stats.productive)} h</strong>
            <span>{hour.format(Number(item.contracted_quantity || 0))} h<small>{hour.format(remaining)} h restantes</small></span>
            <strong>{money.format(stats.value)}</strong>
          </article>;
        })}
        {!rows.length && <Empty text="Este contrato não possui itens de máquinas ativos." />}
      </div>
    </section>

    <section className="contract-ops-measurements">
      <div className="contract-ops-section-title"><div><small>HISTÓRICO</small><h4>Medições e aprovação</h4></div></div>
      <div className="contract-ops-measurement-list">
        {contractMeasurements.map(measurement => {
          const itemRows = measurementItems.filter(item => item.measurement_id === measurement.id);
          const hours = itemRows.reduce((sum, item) => {
            const result = hoursFromMeasurement(item);
            sum.raw += result.raw;
            sum.downtime += result.downtime;
            sum.productive += result.productive;
            return sum;
          }, { raw: 0, downtime: 0, productive: 0 });
          const ready = measurement.status === "submetida" && measurement.document_workflow_status === "pronto_para_aprovacao";
          return <article key={measurement.id}>
            <div><span className={`contract-ops-status ${measurement.status}`}>{label(measurement.status)}</span><strong>{measurement.measurement_code || `Medição ${measurement.measurement_number}`}</strong><small>{safeDate(measurement.period_start)} a {safeDate(measurement.period_end)} · {label(measurement.document_workflow_status)}</small></div>
            <span><small>Brutas</small><strong>{hour.format(hours.raw)} h</strong></span>
            <span><small>Paradas</small><strong>{hour.format(hours.downtime)} h</strong></span>
            <span><small>Produtivas</small><strong>{hour.format(hours.productive)} h</strong></span>
            <span><small>Valor bruto</small><strong>{money.format(Number(measurement.gross_amount || 0))}</strong></span>
            {ready && canApprove && <button className="primary" onClick={() => onDecision(measurement)}>Analisar</button>}
          </article>;
        })}
        {!contractMeasurements.length && <Empty text="Nenhuma medição registrada para este contrato." />}
      </div>
    </section>
  </div>;
}

function MeasurementModal({
  contract,
  data,
  items,
  measurements,
  measurementItems,
  periods,
  mutate,
  can,
  close,
}: {
  contract: OperationalContract;
  data: ErpData;
  items: OperationalContractItem[];
  measurements: ContractMeasurement[];
  measurementItems: ContractMeasurementItem[];
  periods: ContractMeasurementPeriod[];
  mutate: Mutate;
  can: Can;
  close: () => void;
}) {
  const machineItems = items.filter(item => item.contract_id === contract.id && item.active && isMachineItem(item, contract.contract_type));
  const openPeriods = periods.filter(period => period.contract_id === contract.id && openPeriodStatuses.has(period.status));
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;
  const defaultStart = [contract.start_date, monthStart].sort().at(-1) || contract.start_date;
  const defaultEnd = contract.end_date && contract.end_date < today ? contract.end_date : today;
  const [periodMode, setPeriodMode] = useState<"existing" | "new">(openPeriods.length ? "existing" : "new");
  const [periodId, setPeriodId] = useState(openPeriods[0]?.id || "");
  const [periodStart, setPeriodStart] = useState(defaultStart);
  const [periodEnd, setPeriodEnd] = useState(defaultEnd < defaultStart ? defaultStart : defaultEnd);
  const [submissionDeadline, setSubmissionDeadline] = useState("");
  const [expectedPaymentDate, setExpectedPaymentDate] = useState("");
  const [notes, setNotes] = useState("");
  const [error, setError] = useState("");
  const [drafts, setDrafts] = useState<Record<string, MeasurementDraft>>(() => Object.fromEntries(machineItems.map((item, index) => {
    const stats = statsForItem(item.id, measurements.filter(measurement => measurement.contract_id === contract.id), measurementItems);
    return [item.id, {
      enabled: index === 0,
      meterStart: stats.latestMeter === null ? "" : String(stats.latestMeter),
      meterEnd: "",
      downtime: "0",
      notes: "",
    }];
  })));

  const projections = machineItems.map(item => {
    const draft = drafts[item.id];
    const start = Number(draft?.meterStart);
    const end = Number(draft?.meterEnd);
    const downtime = Number(draft?.downtime || 0);
    const complete = draft?.meterStart !== "" && draft?.meterEnd !== "";
    const raw = complete ? Math.max(0, end - start) : 0;
    const productive = Math.max(0, raw - Math.max(0, downtime));
    const billable = Math.max(productive, Number(item.minimum_billable_quantity || 0));
    const previous = statsForItem(item.id, measurements.filter(measurement => measurement.contract_id === contract.id), measurementItems).measured;
    return { item, draft, raw, downtime, productive, billable, previous, estimate: billable * Number(item.unit_price || 0) };
  });
  const selectedProjections = projections.filter(row => row.draft?.enabled);
  const estimatedTotal = selectedProjections.reduce((sum, row) => sum + row.estimate, 0);
  const canCreatePeriod = can("contracts.period.manage") || can("contracts.measure");

  function update(itemId: string, patch: Partial<MeasurementDraft>) {
    setDrafts(current => ({ ...current, [itemId]: { ...current[itemId], ...patch } }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!can("contracts.measure") && !can("contracts.manage")) {
      setError("Seu perfil não possui permissão para registrar medições.");
      return;
    }
    if (!selectedProjections.length) {
      setError("Selecione ao menos uma máquina.");
      return;
    }
    if (periodMode === "existing" && !periodId) {
      setError("Selecione um período de medição aberto.");
      return;
    }
    if (periodMode === "new" && (!periodStart || !periodEnd || periodEnd < periodStart)) {
      setError("Informe um período válido.");
      return;
    }
    for (const row of selectedProjections) {
      if (!row.draft.meterStart || !row.draft.meterEnd) {
        setError(`Informe o horímetro inicial e final de ${row.item.equipment_identifier || row.item.description}.`);
        return;
      }
      if (!Number.isFinite(Number(row.draft.meterStart)) || !Number.isFinite(Number(row.draft.meterEnd))) {
        setError(`Os horímetros de ${row.item.equipment_identifier || row.item.description} são inválidos.`);
        return;
      }
      if (Number(row.draft.meterEnd) < Number(row.draft.meterStart)) {
        setError(`O horímetro final de ${row.item.equipment_identifier || row.item.description} não pode ser menor que o inicial.`);
        return;
      }
      if (row.downtime < 0 || row.downtime > row.raw) {
        setError(`As paradas de ${row.item.equipment_identifier || row.item.description} devem estar entre zero e ${hour.format(row.raw)} h.`);
        return;
      }
      if (row.billable <= 0) {
        setError(`A quantidade produtiva de ${row.item.equipment_identifier || row.item.description} deve ser positiva.`);
        return;
      }
      if (row.previous + row.billable > Number(row.item.contracted_quantity || 0) + 0.0001) {
        setError(`A medição de ${row.item.equipment_identifier || row.item.description} excede o saldo contratado.`);
        return;
      }
    }

    await mutate(async () => {
      const supabase = getSupabase();
      if (!supabase) throw new Error("Supabase indisponível.");
      const selectedPeriod = openPeriods.find(period => period.id === periodId);
      let measurementPeriodId = selectedPeriod?.id || "";
      let effectivePeriodStart = selectedPeriod?.period_start || periodStart;
      let effectivePeriodEnd = selectedPeriod?.period_end || periodEnd;
      if (periodMode === "new") {
        const periodResult = await supabase.rpc("create_measurement_period", {
          p_contract_id: contract.id,
          p_period: {
            organization_id: data.organization.id,
            period_start: periodStart,
            period_end: periodEnd,
            submission_deadline: submissionDeadline || null,
            expected_payment_date: expectedPaymentDate || null,
            notes: notes || "Período criado no apontamento de horímetros.",
          },
        });
        if (periodResult.error) throw new Error(periodResult.error.message);
        const response = periodResult.data as { period_id?: string } | null;
        measurementPeriodId = response?.period_id || "";
        if (!measurementPeriodId) throw new Error("O período foi criado sem um identificador válido.");
        effectivePeriodStart = periodStart;
        effectivePeriodEnd = periodEnd;
      }
      if (!measurementPeriodId) throw new Error("Selecione ou crie um período de medição.");
      const result = await supabase.rpc("submit_contract_measurement", {
        p_measurement: {
          organization_id: data.organization.id,
          contract_id: contract.id,
          project_id: contract.project_id,
          measurement_period_id: measurementPeriodId,
          period_start: effectivePeriodStart,
          period_end: effectivePeriodEnd,
          notes: notes || "Apontamento de horas e horímetros de máquinas.",
        },
        p_items: selectedProjections.map(row => ({
          contract_item_id: row.item.id,
          current_quantity: row.productive,
          meter_start: Number(row.draft.meterStart),
          meter_end: Number(row.draft.meterEnd),
          downtime_quantity: row.downtime,
          notes: row.draft.notes || null,
        })),
      });
      if (result.error) throw new Error(result.error.message);
    }, "Medição registrada e encaminhada ao fluxo de documentos e aprovação.");
    close();
  }

  return <div className="modal-backdrop" onMouseDown={close}>
    <form className="modal large contract-ops-modal" onSubmit={submit} onMouseDown={event => event.stopPropagation()}>
      <PanelTitle eyebrow="NOVA MEDIÇÃO" title={`${contract.contract_number} · ${contract.title}`} />
      <button className="modal-close" type="button" onClick={close}>×</button>
      <div className="form-section contract-ops-period">
        <h4>Período de medição</h4>
        {openPeriods.length > 0 && <div className="module-tabs">
          <button type="button" className={periodMode === "existing" ? "active" : ""} onClick={() => setPeriodMode("existing")}>Usar período aberto</button>
          <button type="button" className={periodMode === "new" ? "active" : ""} disabled={!canCreatePeriod} onClick={() => setPeriodMode("new")}>Criar período</button>
        </div>}
        {periodMode === "existing"
          ? <div className="form-grid"><label>Período aberto<select value={periodId} onChange={event => setPeriodId(event.target.value)} required><option value="">Selecione</option>{openPeriods.map(period => <option key={period.id} value={period.id}>{period.period_code} · {safeDate(period.period_start)} a {safeDate(period.period_end)}</option>)}</select></label></div>
          : <div className="form-grid four">
              <label>Início<input type="date" value={periodStart} min={contract.start_date} max={contract.end_date || undefined} onChange={event => setPeriodStart(event.target.value)} required /></label>
              <label>Fim<input type="date" value={periodEnd} min={periodStart || contract.start_date} max={contract.end_date || undefined} onChange={event => setPeriodEnd(event.target.value)} required /></label>
              <label>Prazo de entrega<input type="date" value={submissionDeadline} min={periodStart || undefined} onChange={event => setSubmissionDeadline(event.target.value)} /></label>
              <label>Pagamento esperado<input type="date" value={expectedPaymentDate} min={periodEnd || undefined} onChange={event => setExpectedPaymentDate(event.target.value)} /></label>
            </div>}
      </div>

      <div className="form-section contract-ops-hour-entry">
        <h4>Apontamento de máquinas</h4>
        <div className="contract-ops-entry-table">
          <header><span>Medir</span><span>Máquina / item</span><span>Horímetro inicial</span><span>Horímetro final</span><span>Paradas (h)</span><span>Produtivas</span><span>Saldo após medição</span><span>Valor estimado</span></header>
          {projections.map(row => {
            const remaining = Number(row.item.contracted_quantity || 0) - row.previous - row.billable;
            return <article key={row.item.id} className={row.draft?.enabled ? "active" : ""}>
              <label className="contract-ops-check"><input type="checkbox" checked={Boolean(row.draft?.enabled)} onChange={event => update(row.item.id, { enabled: event.target.checked })} /><span>Selecionar</span></label>
              <div><strong>{row.item.equipment_identifier || row.item.description}</strong><small>{row.item.code} · {money.format(Number(row.item.unit_price || 0))}/{row.item.unit}</small></div>
              <input aria-label="Horímetro inicial" type="number" min="0" step="0.01" value={row.draft?.meterStart || ""} disabled={!row.draft?.enabled} onChange={event => update(row.item.id, { meterStart: event.target.value })} />
              <input aria-label="Horímetro final" type="number" min="0" step="0.01" value={row.draft?.meterEnd || ""} disabled={!row.draft?.enabled} onChange={event => update(row.item.id, { meterEnd: event.target.value })} />
              <input aria-label="Horas de parada" type="number" min="0" step="0.01" value={row.draft?.downtime || "0"} disabled={!row.draft?.enabled} onChange={event => update(row.item.id, { downtime: event.target.value })} />
              <strong>{hour.format(row.productive)} h</strong>
              <span className={remaining < 0 ? "danger" : ""}>{hour.format(Math.max(0, remaining))} h</span>
              <strong>{money.format(row.estimate)}</strong>
              <label className="contract-ops-entry-note">Observação<input value={row.draft?.notes || ""} disabled={!row.draft?.enabled} onChange={event => update(row.item.id, { notes: event.target.value })} placeholder="Ocorrências, operador, frente de serviço..." /></label>
            </article>;
          })}
          {!machineItems.length && <Empty text="Não há máquinas ativas neste contrato." />}
        </div>
      </div>

      <label>Observações gerais<textarea rows={3} value={notes} onChange={event => setNotes(event.target.value)} placeholder="Serviços executados, condições da máquina e justificativas." /></label>
      <div className="contract-ops-estimate"><span>Horas produtivas</span><strong>{hour.format(selectedProjections.reduce((sum, row) => sum + row.productive, 0))} h</strong><span>Valor estimado da medição</span><strong>{money.format(estimatedTotal)}</strong></div>
      {error && <div className="feedback error">{error}</div>}
      <footer><button type="button" onClick={close}>Cancelar</button><button className="primary" disabled={!machineItems.length}>Registrar e enviar para aprovação</button></footer>
    </form>
  </div>;
}

function MeasurementDecisionModal({
  measurement,
  periods,
  mutate,
  close,
}: {
  measurement: ContractMeasurement;
  periods: ContractMeasurementPeriod[];
  mutate: Mutate;
  close: () => void;
}) {
  const period = periods.find(item => item.id === measurement.measurement_period_id);
  const [decision, setDecision] = useState<"aprovada" | "rejeitada">("aprovada");
  const [dueDate, setDueDate] = useState(period?.expected_payment_date || measurement.period_end);
  const [notes, setNotes] = useState("Horas, paradas e valor conferidos conforme evidências da medição.");
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (!notes.trim()) {
      setError("Registre a justificativa da decisão.");
      return;
    }
    if (decision === "aprovada" && !dueDate) {
      setError("Informe a data de pagamento aprovada.");
      return;
    }
    await mutate(async () => {
      const supabase = getSupabase();
      if (!supabase) throw new Error("Supabase indisponível.");
      const result = await supabase.rpc("decide_contract_measurement", {
        p_measurement_id: measurement.id,
        p_decision: decision,
        p_notes: notes.trim(),
        p_due_date: decision === "aprovada" ? dueDate : null,
        p_risk_snapshot: { source: "contract_hours_dashboard" },
      });
      if (result.error) throw new Error(result.error.message);
    }, decision === "aprovada" ? "Medição aprovada e pagamento liberado conforme o fluxo documental." : "Medição rejeitada e devolvida para correção.");
    close();
  }

  return <div className="modal-backdrop" onMouseDown={close}>
    <form className="modal contract-ops-decision-modal" onSubmit={submit} onMouseDown={event => event.stopPropagation()}>
      <PanelTitle eyebrow="DECISÃO DE MEDIÇÃO" title={measurement.measurement_code || `Medição ${measurement.measurement_number}`} />
      <button className="modal-close" type="button" onClick={close}>×</button>
      <div className="contract-ops-decision-summary"><span><small>Período</small><strong>{safeDate(measurement.period_start)} a {safeDate(measurement.period_end)}</strong></span><span><small>Valor bruto</small><strong>{money.format(Number(measurement.gross_amount || 0))}</strong></span><span><small>Fluxo documental</small><strong>{label(measurement.document_workflow_status)}</strong></span></div>
      <label>Decisão<select value={decision} onChange={event => setDecision(event.target.value as "aprovada" | "rejeitada")}><option value="aprovada">Aprovar medição</option><option value="rejeitada">Rejeitar medição</option></select></label>
      {decision === "aprovada" && <label>Data de pagamento aprovada<input type="date" value={dueDate} onChange={event => setDueDate(event.target.value)} required /></label>}
      <label>Justificativa<textarea rows={4} value={notes} onChange={event => setNotes(event.target.value)} required /></label>
      {error && <div className="feedback error">{error}</div>}
      <footer><button type="button" onClick={close}>Cancelar</button><button className={decision === "aprovada" ? "primary" : "danger"}>{decision === "aprovada" ? "Aprovar medição" : "Confirmar rejeição"}</button></footer>
    </form>
  </div>;
}
