"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type {
  EntryStatus,
  EntryType,
  ErpData,
  FinancialEntry,
  RevenueCenter,
} from "../types";
import {
  canWriteFinance,
  dateAtNoon,
  daysUntil,
  downloadCsv,
  financialPlanningDate,
  isPaymentScheduled,
  isSettled,
  money,
  shortDate,
  statusLabels,
} from "../utils";
import { overdueRecommendation } from "../analytics";
import { Empty } from "../views-dashboard";
import { EntityDocumentModal } from "../documents/entity-document-modal";
import type { ActivityDeepLinkTarget } from "../activities/activity-links";
import { EntryModal } from "./entry-modal";

type FinanceDateBasis = "planning" | "due" | "issue" | "settlement";
type PeriodPreset =
  | "todos"
  | "hoje"
  | "este_mes"
  | "mes_anterior"
  | "ultimos_30"
  | "proximos_30"
  | "ano_atual"
  | "custom";

interface FinanceTotals {
  entries: number;
  exits: number;
  balance: number;
  count: number;
}

function localDateIso(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function presetRange(preset: Exclude<PeriodPreset, "custom">) {
  if (preset === "todos") return { from: "", to: "" };

  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const from = new Date(today);
  const to = new Date(today);

  if (preset === "este_mes") {
    from.setDate(1);
    to.setMonth(to.getMonth() + 1, 0);
  } else if (preset === "mes_anterior") {
    from.setMonth(from.getMonth() - 1, 1);
    to.setDate(0);
  } else if (preset === "ultimos_30") {
    from.setDate(from.getDate() - 29);
  } else if (preset === "proximos_30") {
    to.setDate(to.getDate() + 29);
  } else if (preset === "ano_atual") {
    from.setMonth(0, 1);
    to.setMonth(11, 31);
  }

  return { from: localDateIso(from), to: localDateIso(to) };
}

function financeDate(entry: FinancialEntry, basis: FinanceDateBasis) {
  if (basis === "planning") return financialPlanningDate(entry);
  if (basis === "due") return entry.due_date;
  if (basis === "issue") return entry.issue_date;
  return entry.settlement_date;
}

function summarize(entries: FinancialEntry[]): FinanceTotals {
  const totals = entries.reduce(
    (result, entry) => {
      const amount = Number(entry.amount) || 0;
      if (entry.type === "entrada") result.entries += amount;
      else result.exits += amount;
      return result;
    },
    { entries: 0, exits: 0 },
  );

  return {
    ...totals,
    balance: totals.entries - totals.exits,
    count: entries.length,
  };
}

export function FinanceView({
  data,
  mutate,
  focus,
}: {
  data: ErpData;
  mutate: (operation: () => Promise<void>, success: string) => Promise<void>;
  focus?: ActivityDeepLinkTarget | null;
}) {
  const [modal, setModal] = useState<FinancialEntry | "new" | null>(null);
  const [documentEntry, setDocumentEntry] = useState<FinancialEntry | null>(null);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<"todos" | EntryType>("todos");
  const [status, setStatus] = useState<"todos" | EntryStatus>("todos");
  const [classification, setClassification] = useState("todos");
  const [dateBasis, setDateBasis] = useState<FinanceDateBasis>("planning");
  const [periodPreset, setPeriodPreset] = useState<PeriodPreset>("todos");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [revenueCenters, setRevenueCenters] = useState<RevenueCenter[]>(
    data.revenueCenters ?? [],
  );
  const focusedEntryId =
    focus?.sourceType === "financial_entries" ? focus.recordId : null;

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) return;
    supabase
      .from("revenue_centers")
      .select("*")
      .eq("organization_id", data.organization.id)
      .order("code")
      .then(({ data: rows }) => setRevenueCenters(rows ?? []));
  }, [data.organization.id]);

  const filteredList = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("pt-BR");
    const normalizedFrom =
      dateFrom && dateTo && dateFrom > dateTo ? dateTo : dateFrom;
    const normalizedTo =
      dateFrom && dateTo && dateFrom > dateTo ? dateFrom : dateTo;

    return data.entries
      .filter((entry) => {
        const classMatch =
          classification === "todos" ||
          (classification.startsWith("cost:") &&
            entry.cost_center_id === classification.slice(5)) ||
          (classification.startsWith("revenue:") &&
            entry.revenue_center_id === classification.slice(8));
        const contact = data.contacts.find((item) => item.id === entry.contact_id);
        const project = data.projects.find((item) => item.id === entry.project_id);
        const category =
          data.categories.find((item) => item.id === entry.category_id)?.name ??
          entry.category;
        const searchMatch =
          !normalizedQuery ||
          [
            entry.description,
            entry.document_number,
            entry.category,
            category,
            contact?.name,
            contact?.trade_name,
            project?.name,
          ]
            .filter(Boolean)
            .join(" ")
            .toLocaleLowerCase("pt-BR")
            .includes(normalizedQuery);
        const entryDate = financeDate(entry, dateBasis);
        const periodMatch =
          !normalizedFrom && !normalizedTo
            ? true
            : Boolean(
                entryDate &&
                  (!normalizedFrom || entryDate >= normalizedFrom) &&
                  (!normalizedTo || entryDate <= normalizedTo),
              );

        return (
          (type === "todos" || entry.type === type) &&
          (status === "todos" || entry.status === status) &&
          classMatch &&
          searchMatch &&
          periodMatch
        );
      })
      .sort(
        (a, b) =>
          financialPlanningDate(a).localeCompare(financialPlanningDate(b)) ||
          a.due_date.localeCompare(b.due_date),
      );
  }, [
    classification,
    data.categories,
    data.contacts,
    data.entries,
    data.projects,
    dateBasis,
    dateFrom,
    dateTo,
    query,
    status,
    type,
  ]);

  const list = useMemo(() => {
    if (
      !focusedEntryId ||
      filteredList.some((entry) => entry.id === focusedEntryId)
    ) {
      return filteredList;
    }

    const focusedEntry = data.entries.find((entry) => entry.id === focusedEntryId);
    return focusedEntry ? [focusedEntry, ...filteredList] : filteredList;
  }, [data.entries, filteredList, focusedEntryId]);

  const focusedEntryVisible = Boolean(
    focusedEntryId && list.some((entry) => entry.id === focusedEntryId),
  );
  const overdue = filteredList.filter(
    (entry) =>
      !isSettled(entry) &&
      entry.status !== "cancelado" &&
      daysUntil(entry.due_date) < 0,
  );
  const filteredTotals = useMemo(() => summarize(filteredList), [filteredList]);
  const selectedEntries = useMemo(
    () => list.filter((entry) => selectedIds.has(entry.id)),
    [list, selectedIds],
  );
  const selectedTotals = useMemo(
    () => summarize(selectedEntries),
    [selectedEntries],
  );
  const allFilteredSelected =
    filteredList.length > 0 &&
    filteredList.every((entry) => selectedIds.has(entry.id));
  const someFilteredSelected =
    !allFilteredSelected &&
    filteredList.some((entry) => selectedIds.has(entry.id));

  useEffect(() => {
    if (!focusedEntryId || !focusedEntryVisible) return;
    const frame = requestAnimationFrame(() => {
      const target = document.querySelector<HTMLElement>(
        `[data-record-id="${focusedEntryId}"]`,
      );
      target?.scrollIntoView({ behavior: "smooth", block: "center" });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedEntryId, focusedEntryVisible]);

  function applyPreset(value: PeriodPreset) {
    setPeriodPreset(value);
    if (value === "custom") return;
    const range = presetRange(value);
    setDateFrom(range.from);
    setDateTo(range.to);
  }

  function clearPeriod() {
    setPeriodPreset("todos");
    setDateFrom("");
    setDateTo("");
  }

  function toggleSelection(entryId: string) {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  }

  function toggleAllFiltered() {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allFilteredSelected) {
        filteredList.forEach((entry) => next.delete(entry.id));
      } else {
        filteredList.forEach((entry) => next.add(entry.id));
      }
      return next;
    });
  }

  async function settle(entry: FinancialEntry) {
    await mutate(async () => {
      const supabase = getSupabase();
      if (!supabase) throw new Error("Supabase indisponível.");
      const nextStatus = entry.type === "entrada" ? "recebido" : "pago";
      const result = await supabase
        .from("financial_entries")
        .update({
          status: nextStatus,
          settlement_date: new Date().toISOString().slice(0, 10),
          treatment_status: "concluido",
        })
        .eq("id", entry.id);
      if (result.error) throw new Error(result.error.message);
    }, entry.type === "entrada"
      ? "Recebimento confirmado. Anexe o comprovante no lançamento."
      : "Pagamento confirmado. Anexe o comprovante no lançamento.");
  }

  async function remove(entry: FinancialEntry) {
    if (!confirm(`Excluir o lançamento “${entry.description}”?`)) return;
    await mutate(async () => {
      const supabase = getSupabase();
      if (!supabase) throw new Error("Supabase indisponível.");
      const result = await supabase
        .from("financial_entries")
        .delete()
        .eq("id", entry.id);
      if (result.error) throw new Error(result.error.message);
    }, "Lançamento excluído.");
  }

  function exportData() {
    downloadCsv(
      "evora-financeiro.csv",
      [
        "Tipo",
        "Descrição",
        "Classificação",
        "Categoria",
        "Contraparte",
        "Valor",
        "Emissão",
        "Vencimento contratual",
        "Pagamento programado",
        "Liquidação",
        "Status",
        "Aprovação",
        "Risco",
      ],
      filteredList.map((entry) => [
        entry.type,
        entry.description,
        entry.type === "saida"
          ? data.costCenters.find((center) => center.id === entry.cost_center_id)
              ?.name
          : revenueCenters.find(
              (center) => center.id === entry.revenue_center_id,
            )?.name,
        data.categories.find((category) => category.id === entry.category_id)
          ?.name || entry.category,
        data.contacts.find((contact) => contact.id === entry.contact_id)?.name,
        entry.amount,
        entry.issue_date,
        entry.due_date,
        entry.scheduled_payment_date,
        entry.settlement_date,
        entry.status,
        entry.approval_status,
        entry.cash_risk ? entry.cash_risk_level : "não",
      ]),
    );
  }

  return (
    <div className="stack">
      <section className="module-toolbar">
        <div className="search">
          <span>⌕</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar descrição, documento ou contraparte"
            aria-label="Buscar lançamentos financeiros"
          />
        </div>
        <div className="toolbar-actions">
          <button onClick={exportData}>⇩ Exportar filtrados</button>
          {canWriteFinance(data.membership.role) && (
            <button className="primary" onClick={() => setModal("new")}>
              + Adicionar lançamento
            </button>
          )}
        </div>
      </section>

      <section className="filters" aria-label="Filtros financeiros">
        <select
          value={type}
          onChange={(event) => setType(event.target.value as typeof type)}
          aria-label="Tipo de lançamento"
        >
          <option value="todos">Contas a pagar e receber</option>
          <option value="saida">Contas a pagar</option>
          <option value="entrada">Contas a receber</option>
        </select>
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value as typeof status)}
          aria-label="Status do lançamento"
        >
          <option value="todos">Todos os status</option>
          {Object.entries(statusLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
        <select
          value={classification}
          onChange={(event) => setClassification(event.target.value)}
          aria-label="Classificação financeira"
        >
          <option value="todos">Todas as classificações</option>
          <optgroup label="Centros de custo">
            {data.costCenters
              .filter((center) => center.active)
              .map((center) => (
                <option key={center.id} value={`cost:${center.id}`}>
                  {center.code} · {center.name}
                </option>
              ))}
          </optgroup>
          <optgroup label="Centros de recebimento">
            {revenueCenters
              .filter((center) => center.active)
              .map((center) => (
                <option key={center.id} value={`revenue:${center.id}`}>
                  {center.code} · {center.name}
                </option>
              ))}
          </optgroup>
        </select>
        <span>{filteredList.length} registros filtrados</span>
      </section>

      <section className="panel">
        <div className="panel-title">
          <div>
            <small>FILTRO TEMPORAL</small>
            <h3>Período dos lançamentos</h3>
          </div>
          {(dateFrom || dateTo) && (
            <button type="button" onClick={clearPeriod}>
              Limpar período
            </button>
          )}
        </div>
        <div className="form-grid three">
          <label>
            Base da data
            <select
              value={dateBasis}
              onChange={(event) =>
                setDateBasis(event.target.value as FinanceDateBasis)
              }
            >
              <option value="planning">Programação ou vencimento</option>
              <option value="due">Vencimento contratual</option>
              <option value="issue">Emissão</option>
              <option value="settlement">Liquidação</option>
            </select>
          </label>
          <label>
            Período rápido
            <select
              value={periodPreset}
              onChange={(event) =>
                applyPreset(event.target.value as PeriodPreset)
              }
            >
              <option value="todos">Todo o período</option>
              <option value="hoje">Hoje</option>
              <option value="este_mes">Este mês</option>
              <option value="mes_anterior">Mês anterior</option>
              <option value="ultimos_30">Últimos 30 dias</option>
              <option value="proximos_30">Próximos 30 dias</option>
              <option value="ano_atual">Ano atual</option>
              <option value="custom">Personalizado</option>
            </select>
          </label>
          <label>
            Data inicial
            <input
              type="date"
              value={dateFrom}
              onChange={(event) => {
                setDateFrom(event.target.value);
                setPeriodPreset("custom");
              }}
            />
          </label>
          <label>
            Data final
            <input
              type="date"
              value={dateTo}
              onChange={(event) => {
                setDateTo(event.target.value);
                setPeriodPreset("custom");
              }}
            />
          </label>
        </div>
      </section>

      <section className="kpi-grid four" aria-label="Totais filtrados">
        <article className="kpi positive">
          <small>Entradas filtradas</small>
          <strong className="kpi-value-currency">
            {money.format(filteredTotals.entries)}
          </strong>
          <span>Recalculado com os filtros atuais</span>
        </article>
        <article className="kpi negative">
          <small>Saídas filtradas</small>
          <strong className="kpi-value-currency">
            {money.format(filteredTotals.exits)}
          </strong>
          <span>Recalculado com os filtros atuais</span>
        </article>
        <article
          className={`kpi ${filteredTotals.balance < 0 ? "negative" : "positive"}`}
        >
          <small>Saldo do recorte</small>
          <strong className="kpi-value-currency">
            {money.format(filteredTotals.balance)}
          </strong>
          <span>Entradas menos saídas</span>
        </article>
        <article className="kpi">
          <small>Registros no recorte</small>
          <strong>{filteredTotals.count}</strong>
          <span>Quantidade após todos os filtros</span>
        </article>
      </section>

      {selectedTotals.count > 0 && (
        <section className="panel" aria-live="polite">
          <div className="panel-title">
            <div>
              <small>SELEÇÃO ATUAL</small>
              <h3>{selectedTotals.count} lançamentos selecionados</h3>
            </div>
            <button type="button" onClick={() => setSelectedIds(new Set())}>
              Limpar seleção
            </button>
          </div>
          <div className="kpi-grid four">
            <article className="kpi positive">
              <small>Entradas selecionadas</small>
              <strong className="kpi-value-currency">
                {money.format(selectedTotals.entries)}
              </strong>
              <span>Soma das entradas marcadas</span>
            </article>
            <article className="kpi negative">
              <small>Saídas selecionadas</small>
              <strong className="kpi-value-currency">
                {money.format(selectedTotals.exits)}
              </strong>
              <span>Soma das saídas marcadas</span>
            </article>
            <article
              className={`kpi ${
                selectedTotals.balance < 0 ? "negative" : "positive"
              }`}
            >
              <small>Saldo selecionado</small>
              <strong className="kpi-value-currency">
                {money.format(selectedTotals.balance)}
              </strong>
              <span>Entradas menos saídas selecionadas</span>
            </article>
            <article className="kpi">
              <small>Quantidade selecionada</small>
              <strong>{selectedTotals.count}</strong>
              <span>Linhas marcadas na tabela</span>
            </article>
          </div>
        </section>
      )}

      {overdue.length > 0 && (
        <section className="overdue-strip">
          <div>
            <b>{overdue.length}</b>
            <span>
              <strong>Títulos vencidos exigem tratativa</strong>
              <small>
                {money.format(
                  overdue.reduce(
                    (sum, entry) => sum + Number(entry.amount),
                    0,
                  ),
                )}{" "}
                em exposição vencida
              </small>
            </span>
          </div>
          <p>{overdueRecommendation(overdue[0])}</p>
        </section>
      )}

      <section className="panel finance-table">
        <div className="table-header">
          <span className="finance-select-all">
            <SelectionCheckbox
              checked={allFilteredSelected}
              indeterminate={someFilteredSelected}
              disabled={!filteredList.length}
              onChange={toggleAllFiltered}
              label="Selecionar todos os lançamentos filtrados"
            />
            Lançamento
          </span>
          <span>Classificação</span>
          <span>Vencimento / programação</span>
          <span>Status</span>
          <span>Valor</span>
          <span />
        </div>
        {list.map((entry) => (
          <FinanceRow
            key={entry.id}
            entry={entry}
            data={data}
            revenueCenters={revenueCenters}
            focused={entry.id === focusedEntryId}
            selected={selectedIds.has(entry.id)}
            onToggleSelection={() => toggleSelection(entry.id)}
            onEdit={() => setModal(entry)}
            onDocuments={() => setDocumentEntry(entry)}
            onSettle={() => settle(entry)}
            onRemove={() => remove(entry)}
          />
        ))}
        {!list.length && <Empty text="Nenhum lançamento encontrado." />}
      </section>

      {modal && (
        <EntryModal
          data={data}
          revenueCenters={revenueCenters}
          entry={modal === "new" ? null : modal}
          close={() => setModal(null)}
          mutate={mutate}
        />
      )}
      {documentEntry && (
        <EntityDocumentModal
          data={data}
          mutate={mutate}
          entityType="financial_entry"
          entityId={documentEntry.id}
          close={() => setDocumentEntry(null)}
        />
      )}
    </div>
  );
}

function SelectionCheckbox({
  checked,
  indeterminate = false,
  disabled = false,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={inputRef}
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={onChange}
      aria-label={label}
      className="finance-selection-checkbox"
    />
  );
}

function FinanceRow({
  entry,
  data,
  revenueCenters,
  focused,
  selected,
  onToggleSelection,
  onEdit,
  onDocuments,
  onSettle,
  onRemove,
}: {
  entry: FinancialEntry;
  data: ErpData;
  revenueCenters: RevenueCenter[];
  focused: boolean;
  selected: boolean;
  onToggleSelection: () => void;
  onEdit: () => void;
  onDocuments: () => void;
  onSettle: () => void;
  onRemove: () => void;
}) {
  const classification =
    entry.type === "saida"
      ? data.costCenters.find((center) => center.id === entry.cost_center_id)
      : revenueCenters.find(
          (center) => center.id === entry.revenue_center_id,
        );
  const category = data.categories.find(
    (item) => item.id === entry.category_id,
  );
  const contact = data.contacts.find((item) => item.id === entry.contact_id);
  const project = data.projects.find((item) => item.id === entry.project_id);
  const late =
    !isSettled(entry) &&
    entry.status !== "cancelado" &&
    daysUntil(entry.due_date) < 0;
  const documentCount = data.documents.filter(
    (item) =>
      item.entity_type === "financial_entry" && item.entity_id === entry.id,
  ).length;

  return (
    <article
      data-record-id={entry.id}
      tabIndex={focused ? -1 : undefined}
      className={`finance-row ${entry.cash_risk ? "cash-risk-row" : ""} ${
        focused ? "agenda-linked-target" : ""
      }`}
    >
      <div className="finance-main">
        <SelectionCheckbox
          checked={selected}
          onChange={onToggleSelection}
          label={`Selecionar lançamento ${entry.description}`}
        />
        <i className={entry.type}>{entry.type === "entrada" ? "↓" : "↑"}</i>
        <span>
          <strong>{entry.description}</strong>
          <small>
            {contact?.trade_name ||
              contact?.name ||
              "Contraparte não informada"}{" "}
            · {project?.name || "Corporativo"}
          </small>
        </span>
      </div>
      <div>
        <strong>{category?.name || entry.category}</strong>
        <small>
          {classification
            ? `${classification.code || ""} · ${classification.name}`
            : entry.type === "saida"
              ? "Sem centro de custo"
              : "Sem centro de recebimento"}
        </small>
      </div>
      <div>
        <strong className={late ? "late" : ""}>
          Vence {shortDate.format(dateAtNoon(entry.due_date))}
        </strong>
        <small>
          {isPaymentScheduled(entry)
            ? `Programado para ${shortDate.format(
                dateAtNoon(entry.scheduled_payment_date!),
              )}`
            : late
              ? `${Math.abs(
                  daysUntil(entry.due_date),
                )} dias em atraso · sem programação`
              : entry.type === "saida"
                ? "Pagamento ainda não programado"
                : entry.installment_total > 1
                  ? `${entry.installment_number}/${entry.installment_total}`
                  : "Parcela única"}
        </small>
      </div>
      <div>
        <span className={`status ${entry.status}`}>
          {statusLabels[entry.status]}
        </span>
        <small className={`approval ${entry.approval_status}`}>
          {entry.approval_status}
        </small>
        {entry.cash_risk && (
          <small className={`risk-badge ${entry.cash_risk_level}`}>
            Risco {entry.cash_risk_level}
          </small>
        )}
      </div>
      <b className={entry.type}>
        {entry.type === "saida" ? "−" : "+"}
        {money.format(Number(entry.amount))}
      </b>
      <div className="row-actions">
        <button onClick={onDocuments} title="Documentos">
          ▧{documentCount ? <sup>{documentCount}</sup> : null}
        </button>
        <button onClick={onEdit} title="Editar">
          ✎
        </button>
        {!isSettled(entry) && entry.approval_status === "aprovado" && (
          <button onClick={onSettle} title="Liquidar">
            ✓
          </button>
        )}
        <button onClick={onRemove} title="Excluir">
          ×
        </button>
      </div>
      {late && (
        <div className="row-recommendation">
          <strong>Recomendação:</strong> {overdueRecommendation(entry)}
        </div>
      )}
    </article>
  );
}
