"use client";

import { FormEvent, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type {
  ErpData,
  FuelDispense,
  FuelRequest,
  OperationalContract,
  OperationalContractItem,
} from "../types";

type FuelType =
  | "gasolina_comum"
  | "gasolina_aditivada"
  | "etanol"
  | "diesel_s10"
  | "diesel_s500"
  | "arla32"
  | "outro";

type FuelManagementProps = {
  data: ErpData;
  mutate: (operation: () => Promise<void>, success: string) => Promise<void>;
  can: (key: string) => boolean;
};

type ModalState =
  | { type: "request" }
  | { type: "decision"; request: FuelRequest; decision: "aprovada" | "rejeitada" }
  | { type: "dispense"; request: FuelRequest }
  | null;

const fuelTypes: Array<{ value: FuelType; label: string }> = [
  { value: "gasolina_comum", label: "Gasolina comum" },
  { value: "gasolina_aditivada", label: "Gasolina aditivada" },
  { value: "etanol", label: "Etanol" },
  { value: "diesel_s10", label: "Diesel S10" },
  { value: "diesel_s500", label: "Diesel S500" },
  { value: "arla32", label: "ARLA 32" },
  { value: "outro", label: "Outro" },
];

const statusLabels: Record<string, string> = {
  rascunho: "Rascunho",
  solicitada: "Aguardando aprovação",
  submetida: "Aguardando aprovação",
  pendente: "Aguardando aprovação",
  pending: "Aguardando aprovação",
  submitted: "Aguardando aprovação",
  aprovada: "Aprovada",
  aprovado: "Aprovada",
  approved: "Aprovada",
  parcial: "Parcialmente abastecida",
  parcialmente_atendida: "Parcialmente abastecida",
  parcialmente_abastecida: "Parcialmente abastecida",
  partially_dispensed: "Parcialmente abastecida",
  atendida: "Abastecida",
  abastecida: "Abastecida",
  dispensada: "Abastecida",
  concluida: "Concluída",
  completed: "Concluída",
  fulfilled: "Concluída",
  rejeitada: "Rejeitada",
  rejeitado: "Rejeitada",
  rejected: "Rejeitada",
  cancelada: "Cancelada",
  cancelled: "Cancelada",
};

const brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const numberFormat = new Intl.NumberFormat("pt-BR", { maximumFractionDigits: 2 });
const dateTimeFormat = new Intl.DateTimeFormat("pt-BR", {
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

const normalizedStatus = (status: string) => status.trim().toLowerCase();
const isPending = (request: FuelRequest) =>
  ["solicitada", "submetida", "pendente", "pending", "submitted"].includes(normalizedStatus(request.status));
const isRejected = (request: FuelRequest) =>
  ["rejeitada", "rejeitado", "rejected", "cancelada", "cancelled"].includes(normalizedStatus(request.status));
const canReceiveDispense = (request: FuelRequest) =>
  [
    "aprovada",
    "aprovado",
    "approved",
    "parcial",
    "parcialmente_atendida",
    "parcialmente_abastecida",
    "partially_dispensed",
  ].includes(normalizedStatus(request.status));
const fuelLabel = (value: string) => fuelTypes.find((item) => item.value === value)?.label || value.replaceAll("_", " ");
const optionalText = (value: FormDataEntryValue | null) => {
  const text = String(value || "").trim();
  return text || null;
};
const optionalNumber = (value: FormDataEntryValue | null) => {
  const text = String(value || "").trim();
  if (!text) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
};
const toIsoDateTime = (value: FormDataEntryValue | null) => {
  const text = optionalText(value);
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
};
const formatDateTime = (value?: string | null) => {
  if (!value) return "Sem data definida";
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : dateTimeFormat.format(parsed);
};

export function FuelManagement({ data, mutate, can }: FuelManagementProps) {
  const requests = data.fuelRequests;
  const dispenses = data.fuelDispenses;
  const documents = data.fuelRequestDocuments;
  const contracts = data.operationalContracts;
  const contractItems = data.operationalContractItems;
  const [modal, setModal] = useState<ModalState>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("");
  const [projectId, setProjectId] = useState("");
  const [fuelType, setFuelType] = useState("");

  const dispensedByRequest = useMemo(() => {
    const totals = new Map<string, number>();
    for (const dispense of dispenses) {
      totals.set(dispense.request_id, (totals.get(dispense.request_id) || 0) + Number(dispense.liters || 0));
    }
    return totals;
  }, [dispenses]);

  const usedLiters = (request: FuelRequest) =>
    Math.max(Number(request.supplied_liters || 0), dispensedByRequest.get(request.id) || 0);
  const authorizedLiters = (request: FuelRequest) =>
    Number(request.approved_liters ?? request.requested_liters ?? 0);
  const remainingLiters = (request: FuelRequest) =>
    Math.max(authorizedLiters(request) - usedLiters(request), 0);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return requests.filter((request) => {
      const project = data.projects.find((item) => item.id === request.project_id);
      const haystack = [
        request.request_code,
        request.requester_name,
        request.driver_name,
        request.vehicle_identifier,
        request.plate_identifier,
        request.equipment_identifier,
        request.purpose,
        project?.name,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return (
        (!query || haystack.includes(query)) &&
        (!status || normalizedStatus(request.status) === status) &&
        (!projectId || request.project_id === projectId) &&
        (!fuelType || request.fuel_type === fuelType)
      );
    });
  }, [data.projects, fuelType, projectId, requests, search, status]);

  const currentMonth = new Date().toISOString().slice(0, 7);
  const monthDispenses = dispenses.filter((item) =>
    String(item.dispensed_at || item.created_at || "").startsWith(currentMonth),
  );
  const pending = requests.filter(isPending);
  const openAuthorized = requests.filter(canReceiveDispense);
  const pendingLiters = openAuthorized.reduce((sum, request) => sum + remainingLiters(request), 0);
  const monthLiters = monthDispenses.reduce((sum, item) => sum + Number(item.liters || 0), 0);
  const monthCost = monthDispenses.reduce(
    (sum, item) => sum + Number(item.total_amount ?? Number(item.liters || 0) * Number(item.unit_price || 0)),
    0,
  );

  return (
    <div className="fuel-management">
      <section className="fuel-toolbar">
        <div className="fuel-toolbar-copy">
          <small>CONTROLE OPERACIONAL E FINANCEIRO</small>
          <h2>Gestão de combustíveis</h2>
          <p>Solicitação, aprovação, abastecimento e rastreabilidade por obra, contrato, veículo e equipamento.</p>
        </div>
        {(can("fuel.request") || can("contracts.manage")) && (
          <button className="primary fuel-button fuel-button-primary" onClick={() => setModal({ type: "request" })}>
            + Nova solicitação
          </button>
        )}
      </section>

      <section className="fuel-kpis">
        <article className="fuel-kpi fuel-kpi-warning">
          <small>Aguardando aprovação</small>
          <strong>{pending.length}</strong>
          <span>{numberFormat.format(pending.reduce((sum, item) => sum + Number(item.requested_liters || 0), 0))} L solicitados</span>
        </article>
        <article className="fuel-kpi fuel-kpi-positive">
          <small>Saldo autorizado</small>
          <strong>{numberFormat.format(pendingLiters)} L</strong>
          <span>{openAuthorized.filter((item) => remainingLiters(item) > 0).length} solicitações abertas</span>
        </article>
        <article className="fuel-kpi fuel-kpi-info">
          <small>Abastecido no mês</small>
          <strong>{numberFormat.format(monthLiters)} L</strong>
          <span>{monthDispenses.length} registros de abastecimento</span>
        </article>
        <article className="fuel-kpi fuel-kpi-cost">
          <small>Custo realizado no mês</small>
          <strong>{brl.format(monthCost)}</strong>
          <span>{monthLiters ? `${brl.format(monthCost / monthLiters)}/L em média` : "Sem consumo registrado"}</span>
        </article>
      </section>

      <section className="fuel-panel">
        <header className="fuel-panel-header">
          <div>
            <small>SOLICITAÇÕES E ABASTECIMENTOS</small>
            <h3>Fila operacional</h3>
          </div>
          <span>{filtered.length} registro(s)</span>
        </header>
        <div className="fuel-filters">
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar veículo, placa, equipamento ou finalidade"
            aria-label="Buscar solicitações de combustível"
          />
          <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Filtrar por status">
            <option value="">Todos os status</option>
            {[...new Set(requests.map((request) => normalizedStatus(request.status)))].map((value) => (
              <option key={value} value={value}>
                {statusLabels[value] || value}
              </option>
            ))}
          </select>
          <select
            value={projectId}
            onChange={(event) => setProjectId(event.target.value)}
            aria-label="Filtrar por empreendimento"
          >
            <option value="">Todos os empreendimentos</option>
            {data.projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <select value={fuelType} onChange={(event) => setFuelType(event.target.value)} aria-label="Filtrar por combustível">
            <option value="">Todos os combustíveis</option>
            {fuelTypes.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>

        <div className="fuel-list">
          {filtered.map((request) => {
            const project = data.projects.find((item) => item.id === request.project_id);
            const contract = contracts.find((item) => item.id === request.contract_id);
            const consumed = usedLiters(request);
            const approved = authorizedLiters(request);
            const remaining = remainingLiters(request);
            const requestDocuments = documents.filter(
              (document) => document.request_id === request.id,
            ).length;
            const asset =
              request.vehicle_identifier ||
              request.plate_identifier ||
              request.equipment_identifier ||
              "Veículo/equipamento não identificado";
            const normalized = normalizedStatus(request.status);
            return (
              <article className="fuel-row" key={request.id}>
                <header className="fuel-row-header">
                  <div className="fuel-row-title">
                    <span className={`fuel-status fuel-status-${normalized}`}>
                      {statusLabels[normalized] || request.status}
                    </span>
                    <strong>{asset}</strong>
                    <small>
                      {request.request_code || `SOL-${request.id.slice(0, 8).toUpperCase()}`} · {fuelLabel(request.fuel_type)}
                    </small>
                  </div>
                  <div className="fuel-row-volume">
                    <strong>{numberFormat.format(Number(request.requested_liters || 0))} L</strong>
                    <small>solicitados</small>
                  </div>
                </header>
                <div className="fuel-row-details">
                  <span>
                    <small>Obra / empreendimento</small>
                    <strong>{project?.name || "Corporativo"}</strong>
                  </span>
                  <span>
                    <small>Contrato</small>
                    <strong>{contractLabel(contract)}</strong>
                  </span>
                  <span>
                    <small>Finalidade</small>
                    <strong>{request.purpose}</strong>
                  </span>
                  <span>
                    <small>Necessidade</small>
                    <strong>{formatDateTime(request.needed_at)}</strong>
                  </span>
                  <span>
                    <small>Leitura informada</small>
                    <strong>{meterSummary(request.odometer, request.hour_meter)}</strong>
                  </span>
                  <span>
                    <small>Documentos</small>
                    <strong>{requestDocuments}</strong>
                  </span>
                </div>
                {!isPending(request) && !isRejected(request) && (
                  <div className="fuel-row-progress">
                    <div className="fuel-progress-copy">
                      <span>
                        Abastecido: <b>{numberFormat.format(consumed)} L</b>
                      </span>
                      <span>
                        Autorizado: <b>{numberFormat.format(approved)} L</b>
                      </span>
                      <span>
                        Saldo: <b>{numberFormat.format(remaining)} L</b>
                      </span>
                    </div>
                    <i className="fuel-progress-track">
                      <b
                        className="fuel-progress-value"
                        style={{ width: `${Math.min(100, approved > 0 ? (consumed / approved) * 100 : 0)}%` }}
                      />
                    </i>
                  </div>
                )}
                {request.decision_notes && <p className="fuel-row-note">{request.decision_notes}</p>}
                <footer className="fuel-row-actions">
                  {can("fuel.approve") && isPending(request) && (
                    <>
                      <button
                        className="fuel-button fuel-button-secondary"
                        onClick={() => setModal({ type: "decision", request, decision: "rejeitada" })}
                      >
                        Rejeitar
                      </button>
                      <button
                        className="primary fuel-button fuel-button-primary"
                        onClick={() => setModal({ type: "decision", request, decision: "aprovada" })}
                      >
                        Analisar e aprovar
                      </button>
                    </>
                  )}
                  {can("fuel.dispense") && canReceiveDispense(request) && remaining > 0 && (
                    <button
                      className="primary fuel-button fuel-button-primary"
                      onClick={() => setModal({ type: "dispense", request })}
                    >
                      Registrar abastecimento
                    </button>
                  )}
                </footer>
              </article>
            );
          })}
          {!filtered.length && (
            <div className="fuel-empty">
              <b>◇</b>
              <strong>Nenhuma solicitação encontrada</strong>
              <p>Ajuste os filtros ou registre uma nova solicitação de combustível.</p>
            </div>
          )}
        </div>
      </section>

      {modal?.type === "request" && (
        <FuelRequestModal
          data={data}
          contracts={contracts}
          contractItems={contractItems}
          mutate={mutate}
          close={() => setModal(null)}
        />
      )}
      {modal?.type === "decision" && (
        <FuelDecisionModal
          data={data}
          request={modal.request}
          decision={modal.decision}
          mutate={mutate}
          close={() => setModal(null)}
        />
      )}
      {modal?.type === "dispense" && (
        <FuelDispenseModal
          request={modal.request}
          dispenses={dispenses}
          remainingLiters={remainingLiters(modal.request)}
          mutate={mutate}
          close={() => setModal(null)}
        />
      )}
    </div>
  );
}

function FuelRequestModal({
  data,
  contracts,
  contractItems,
  mutate,
  close,
}: {
  data: ErpData;
  contracts: OperationalContract[];
  contractItems: OperationalContractItem[];
  mutate: FuelManagementProps["mutate"];
  close: () => void;
}) {
  const [contractId, setContractId] = useState("");
  const [contractItemId, setContractItemId] = useState("");
  const [vehicleIdentifier, setVehicleIdentifier] = useState("");
  const [vehiclePlate, setVehiclePlate] = useState("");
  const [equipmentIdentifier, setEquipmentIdentifier] = useState("");
  const [odometer, setOdometer] = useState("");
  const [hourMeter, setHourMeter] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const availableItems = contractItems.filter(
    (item) => (!contractId || item.contract_id === contractId) && item.active !== false,
  );
  const requesterName =
    data.profile?.full_name || data.session.user.user_metadata?.full_name || data.session.user.email || "";

  const chooseItem = (itemId: string) => {
    setContractItemId(itemId);
    const item = contractItems.find((value) => value.id === itemId);
    if (!item) return;
    if (item.equipment_identifier) setEquipmentIdentifier(item.equipment_identifier);
  };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const requestedLiters = optionalNumber(form.get("requested_liters"));
    const vehiclePresent = Boolean(vehicleIdentifier.trim() || vehiclePlate.trim());
    const equipmentPresent = Boolean(equipmentIdentifier.trim());
    const odometerValue = optionalNumber(form.get("odometer"));
    const hourMeterValue = optionalNumber(form.get("hour_meter"));
    if (!vehiclePresent && !equipmentPresent) {
      setError("Identifique ao menos um veículo ou equipamento.");
      return;
    }
    if (vehiclePresent && odometerValue === null) {
      setError("Informe o odômetro atual do veículo.");
      return;
    }
    if (equipmentPresent && hourMeterValue === null) {
      setError("Informe o horímetro atual do equipamento.");
      return;
    }
    if (!requestedLiters || requestedLiters <= 0) {
      setError("A quantidade solicitada deve ser maior que zero.");
      return;
    }
    const purpose = String(form.get("purpose") || "").trim();
    if (!purpose) {
      setError("Informe a finalidade do abastecimento.");
      return;
    }
    if (contractItemId && !contractId) {
      setError("O item selecionado precisa estar vinculado a um contrato.");
      return;
    }

    const payload = {
      organization_id: data.organization.id,
      project_id: optionalText(form.get("project_id")),
      contract_id: contractId || null,
      contract_item_id: contractItemId || null,
      requester_name: optionalText(form.get("requester_name")),
      driver_name: optionalText(form.get("driver_name")),
      vehicle_identifier: vehicleIdentifier.trim() || null,
      plate_identifier: vehiclePlate.trim().toUpperCase() || null,
      equipment_identifier: equipmentIdentifier.trim() || null,
      fuel_type: String(form.get("fuel_type")) as FuelType,
      requested_liters: requestedLiters,
      odometer: odometerValue,
      hour_meter: hourMeterValue,
      purpose,
      needed_at: toIsoDateTime(form.get("needed_at")),
      notes: optionalText(form.get("notes")),
    };

    setBusy(true);
    let succeeded = false;
    try {
      await mutate(async () => {
        const client = getSupabase();
        if (!client) throw new Error("Supabase indisponível.");
        const result = await client.rpc("submit_fuel_request", { p_request: payload });
        if (result.error) throw new Error(result.error.message);
        succeeded = true;
      }, "Solicitação de combustível enviada para aprovação.");
      if (succeeded) close();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop fuel-modal-backdrop" onMouseDown={close}>
      <form
        className="modal large fuel-modal fuel-request-modal"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fuel-request-title"
      >
        <button className="modal-close fuel-modal-close" type="button" onClick={close} aria-label="Fechar">
          ×
        </button>
        <header className="fuel-modal-header">
          <small>NOVA SOLICITAÇÃO</small>
          <h2 id="fuel-request-title">Solicitar combustível</h2>
          <p>Vincule o consumo à obra, ao contrato e ao veículo ou equipamento que será abastecido.</p>
        </header>
        <section className="fuel-form-section">
          <h3>Responsabilidade e destino</h3>
          <div className="form-grid three fuel-form-grid">
            <label>
              Solicitante
              <input name="requester_name" defaultValue={requesterName} required />
            </label>
            <label>
              Motorista / operador
              <input name="driver_name" />
            </label>
            <label>
              Empreendimento / obra
              <select name="project_id">
                <option value="">Corporativo / não definido</option>
                {data.projects
                  .filter((project) => project.active)
                  .map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.code} · {project.name}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Contrato operacional
              <select
                value={contractId}
                onChange={(event) => {
                  setContractId(event.target.value);
                  setContractItemId("");
                }}
              >
                <option value="">Sem contrato vinculado</option>
                {contracts.map((contract) => (
                  <option key={contract.id} value={contract.id}>
                    {contractLabel(contract)}
                  </option>
                ))}
              </select>
            </label>
            <label className="span-2 fuel-span-2">
              Item contratado / equipamento
              <select
                value={contractItemId}
                onChange={(event) => chooseItem(event.target.value)}
                disabled={!contractId}
              >
                <option value="">Sem item específico</option>
                {availableItems.map((item) => (
                  <option key={item.id} value={item.id}>
                    {[item.code, item.description, item.equipment_identifier]
                      .filter(Boolean)
                      .join(" · ")}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </section>
        <section className="fuel-form-section">
          <h3>Veículo, equipamento e leitura</h3>
          <div className="form-grid three fuel-form-grid">
            <label>
              Veículo / frota
              <input
                value={vehicleIdentifier}
                onChange={(event) => setVehicleIdentifier(event.target.value)}
                placeholder="Ex.: Caminhão 03"
              />
            </label>
            <label>
              Placa
              <input
                value={vehiclePlate}
                onChange={(event) => setVehiclePlate(event.target.value.toUpperCase())}
                maxLength={10}
                placeholder="ABC1D23"
              />
            </label>
            <label>
              Odômetro atual
              <input
                name="odometer"
                type="number"
                min="0"
                step="0.1"
                value={odometer}
                onChange={(event) => setOdometer(event.target.value)}
                required={Boolean(vehicleIdentifier.trim() || vehiclePlate.trim())}
              />
            </label>
            <label className="span-2 fuel-span-2">
              Equipamento / máquina
              <input
                value={equipmentIdentifier}
                onChange={(event) => setEquipmentIdentifier(event.target.value)}
                placeholder="Ex.: Escavadeira hidráulica 01"
              />
            </label>
            <label>
              Horímetro atual
              <input
                name="hour_meter"
                type="number"
                min="0"
                step="0.1"
                value={hourMeter}
                onChange={(event) => setHourMeter(event.target.value)}
                required={Boolean(equipmentIdentifier.trim())}
              />
            </label>
          </div>
        </section>
        <section className="fuel-form-section">
          <h3>Combustível e necessidade</h3>
          <div className="form-grid three fuel-form-grid">
            <label>
              Combustível
              <select name="fuel_type" defaultValue="diesel_s10" required>
                {fuelTypes.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Litros solicitados
              <input name="requested_liters" type="number" min="0.01" step="0.01" required />
            </label>
            <label>
              Necessidade
              <input name="needed_at" type="datetime-local" />
            </label>
            <label className="span-3 fuel-span-3">
              Finalidade
              <input name="purpose" placeholder="Ex.: operação da drenagem — trecho B" required />
            </label>
            <label className="span-3 fuel-span-3">
              Observações
              <textarea name="notes" rows={3} />
            </label>
          </div>
        </section>
        {error && <div className="feedback error fuel-feedback fuel-feedback-error">{error}</div>}
        <footer className="fuel-modal-actions">
          <button className="fuel-button fuel-button-secondary" type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary fuel-button fuel-button-primary" disabled={busy}>
            {busy ? "Enviando..." : "Enviar para aprovação"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function FuelDecisionModal({
  data,
  request,
  decision,
  mutate,
  close,
}: {
  data: ErpData;
  request: FuelRequest;
  decision: "aprovada" | "rejeitada";
  mutate: FuelManagementProps["mutate"];
  close: () => void;
}) {
  const approving = decision === "aprovada";
  const [approvedLiters, setApprovedLiters] = useState(String(request.requested_liters || ""));
  const [estimatedUnitPrice, setEstimatedUnitPrice] = useState(String(request.estimated_unit_price || ""));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const notes = String(form.get("notes") || "").trim();
    const liters = optionalNumber(form.get("approved_liters"));
    if (!notes) {
      setError(approving ? "Registre as condições da aprovação." : "Informe o motivo da rejeição.");
      return;
    }
    if (approving && (!liters || liters <= 0 || liters > Number(request.requested_liters))) {
      setError("Os litros aprovados devem ser maiores que zero e não podem superar a quantidade solicitada.");
      return;
    }
    const stationContactId = optionalText(form.get("station_contact_id"));
    const estimatedUnitPrice = optionalNumber(form.get("estimated_unit_price"));
    const plannedDueDate = optionalText(form.get("planned_due_date"));
    if (approving && (!stationContactId || !estimatedUnitPrice || estimatedUnitPrice <= 0 || !plannedDueDate)) {
      setError("Informe posto fornecedor, preço estimado por litro e vencimento financeiro.");
      return;
    }

    const financial = approving
      ? {
          station_contact_id: stationContactId,
          estimated_unit_price: estimatedUnitPrice,
          planned_due_date: plannedDueDate,
          category_id: optionalText(form.get("category_id")),
          cost_center_id: optionalText(form.get("cost_center_id")),
        }
      : null;

    setBusy(true);
    let succeeded = false;
    try {
      await mutate(async () => {
        const client = getSupabase();
        if (!client) throw new Error("Supabase indisponível.");
        const result = await client.rpc("decide_fuel_request", {
          p_request_id: request.id,
          p_decision: decision,
          p_notes: notes,
          p_approved_liters: approving ? liters : null,
          p_financial: financial,
        });
        if (result.error) throw new Error(result.error.message);
        succeeded = true;
      }, approving ? "Solicitação de combustível aprovada." : "Solicitação de combustível rejeitada.");
      if (succeeded) close();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop fuel-modal-backdrop" onMouseDown={close}>
      <form
        className="modal large fuel-modal fuel-decision-modal"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fuel-decision-title"
      >
        <button className="modal-close fuel-modal-close" type="button" onClick={close} aria-label="Fechar">
          ×
        </button>
        <header className="fuel-modal-header">
          <small>DECISÃO ADMINISTRATIVA</small>
          <h2 id="fuel-decision-title">{approving ? "Aprovar combustível e compromisso financeiro" : "Rejeitar solicitação"}</h2>
          <p>
            {request.vehicle_identifier || request.equipment_identifier || request.plate_identifier} ·{" "}
            {numberFormat.format(Number(request.requested_liters))} L de {fuelLabel(request.fuel_type)}
          </p>
        </header>
        <section className="fuel-decision-summary">
          <article>
            <small>Finalidade</small>
            <strong>{request.purpose}</strong>
          </article>
          <article>
            <small>Leitura de origem</small>
            <strong>{meterSummary(request.odometer, request.hour_meter)}</strong>
          </article>
          <article>
            <small>Solicitante</small>
            <strong>{request.requester_name || "Não informado"}</strong>
          </article>
        </section>
        {approving && (
          <>
            <section className="fuel-form-section">
              <h3>Quantidade autorizada</h3>
              <div className="form-grid two fuel-form-grid">
                <label>
                  Litros aprovados
                  <input
                    name="approved_liters"
                    type="number"
                    min="0.01"
                    max={request.requested_liters}
                    step="0.01"
                    value={approvedLiters}
                    onChange={(event) => setApprovedLiters(event.target.value)}
                    required
                  />
                </label>
                <label>
                  Total estimado
                  <input
                    value={brl.format(Number(approvedLiters || 0) * Number(estimatedUnitPrice || 0))}
                    readOnly
                    tabIndex={-1}
                  />
                </label>
              </div>
            </section>
            <FuelFinancialFields
              data={data}
              request={request}
              estimatedUnitPrice={estimatedUnitPrice}
              setEstimatedUnitPrice={setEstimatedUnitPrice}
            />
          </>
        )}
        <label className="fuel-decision-notes">
          {approving ? "Condições, limites e observações da aprovação" : "Motivo da rejeição"}
          <textarea
            name="notes"
            rows={4}
            defaultValue={
              approving
                ? "Quantidade e condições financeiras analisadas e aprovadas."
                : "Solicitação rejeitada após análise administrativa."
            }
            required
          />
        </label>
        {!approving && <input name="approved_liters" type="hidden" value="" />}
        {error && <div className="feedback error fuel-feedback fuel-feedback-error">{error}</div>}
        <footer className="fuel-modal-actions">
          <button className="fuel-button fuel-button-secondary" type="button" onClick={close}>
            Cancelar
          </button>
          <button
            className={`${approving ? "primary fuel-button-primary" : "danger-button fuel-button-danger"} fuel-button`}
            disabled={busy}
          >
            {busy ? "Registrando..." : approving ? "Confirmar aprovação" : "Confirmar rejeição"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function FuelFinancialFields({
  data,
  request,
  estimatedUnitPrice,
  setEstimatedUnitPrice,
}: {
  data: ErpData;
  request: FuelRequest;
  estimatedUnitPrice: string;
  setEstimatedUnitPrice: (value: string) => void;
}) {
  const suppliers = data.contacts.filter(
    (contact) => contact.active && ["fornecedor", "ambos"].includes(contact.contact_type),
  );
  return (
    <section className="fuel-form-section">
      <h3>Planejamento financeiro</h3>
      <div className="form-grid two fuel-form-grid">
        <label>
          Posto / fornecedor
          <select name="station_contact_id" defaultValue={request.station_contact_id || ""} required>
            <option value="">Selecione</option>
            {suppliers.map((contact) => (
              <option key={contact.id} value={contact.id}>
                {contact.trade_name || contact.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Preço estimado por litro
          <input
            name="estimated_unit_price"
            type="number"
            min="0.01"
            step="0.001"
            value={estimatedUnitPrice}
            onChange={(event) => setEstimatedUnitPrice(event.target.value)}
            required
          />
        </label>
        <label>
          Vencimento previsto
          <input
            name="planned_due_date"
            type="date"
            defaultValue={request.planned_due_date || new Date().toISOString().slice(0, 10)}
            required
          />
        </label>
        <label>
          Centro de custo
          <select name="cost_center_id" defaultValue="">
            <option value="">Não definido</option>
            {data.costCenters
              .filter((center) => center.active)
              .map((center) => (
                <option key={center.id} value={center.id}>
                  {center.code} · {center.name}
                </option>
              ))}
          </select>
        </label>
        <label className="span-2 fuel-span-2">
          Categoria financeira
          <select name="category_id" defaultValue="">
            <option value="">Categoria padrão de combustível</option>
            {data.categories
              .filter((category) => category.active && ["saida", "ambos"].includes(category.movement_type))
              .map((category) => (
                <option key={category.id} value={category.id}>
                  {category.code} · {category.name}
                </option>
              ))}
          </select>
        </label>
      </div>
    </section>
  );
}

function FuelDispenseModal({
  request,
  dispenses,
  remainingLiters,
  mutate,
  close,
}: {
  request: FuelRequest;
  dispenses: FuelDispense[];
  remainingLiters: number;
  mutate: FuelManagementProps["mutate"];
  close: () => void;
}) {
  const requestDispenses = dispenses
    .filter((item) => item.request_id === request.id)
    .sort((left, right) =>
      String(right.dispensed_at || right.created_at || "").localeCompare(
        String(left.dispensed_at || left.created_at || ""),
      ),
    );
  const lastDispense = requestDispenses[0];
  const odometerBaseline = Number(lastDispense?.odometer ?? request.odometer ?? 0);
  const hourMeterBaseline = Number(lastDispense?.hour_meter ?? request.hour_meter ?? 0);
  const vehiclePresent = Boolean(request.vehicle_identifier || request.plate_identifier);
  const equipmentPresent = Boolean(request.equipment_identifier);
  const [liters, setLiters] = useState(String(remainingLiters || ""));
  const [unitPrice, setUnitPrice] = useState(String(request.estimated_unit_price || ""));
  const [odometer, setOdometer] = useState(vehiclePresent ? String(odometerBaseline || "") : "");
  const [hourMeter, setHourMeter] = useState(equipmentPresent ? String(hourMeterBaseline || "") : "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const form = new FormData(event.currentTarget);
    const litersValue = optionalNumber(form.get("liters"));
    const unitPriceValue = optionalNumber(form.get("unit_price"));
    const odometerValue = optionalNumber(form.get("odometer"));
    const hourMeterValue = optionalNumber(form.get("hour_meter"));
    if (!litersValue || litersValue <= 0 || litersValue > remainingLiters + 0.0001) {
      setError(`O abastecimento deve ser maior que zero e limitado ao saldo de ${numberFormat.format(remainingLiters)} L.`);
      return;
    }
    if (!unitPriceValue || unitPriceValue <= 0) {
      setError("Informe um preço por litro válido.");
      return;
    }
    if (vehiclePresent && (odometerValue === null || odometerValue < odometerBaseline)) {
      setError(`O odômetro não pode ser inferior à última leitura (${numberFormat.format(odometerBaseline)} km).`);
      return;
    }
    if (equipmentPresent && (hourMeterValue === null || hourMeterValue < hourMeterBaseline)) {
      setError(`O horímetro não pode ser inferior à última leitura (${numberFormat.format(hourMeterBaseline)} h).`);
      return;
    }

    const payload = {
      liters: litersValue,
      unit_price: unitPriceValue,
      hour_meter: hourMeterValue,
      odometer: odometerValue,
      notes: optionalText(form.get("notes")),
    };

    setBusy(true);
    let succeeded = false;
    try {
      await mutate(async () => {
        const client = getSupabase();
        if (!client) throw new Error("Supabase indisponível.");
        const result = await client.rpc("record_fuel_dispense", {
          p_request_id: request.id,
          p_dispense: payload,
        });
        if (result.error) throw new Error(result.error.message);
        succeeded = true;
      }, "Abastecimento registrado e saldo da autorização atualizado.");
      if (succeeded) close();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop fuel-modal-backdrop" onMouseDown={close}>
      <form
        className="modal large fuel-modal fuel-dispense-modal"
        onSubmit={submit}
        onMouseDown={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fuel-dispense-title"
      >
        <button className="modal-close fuel-modal-close" type="button" onClick={close} aria-label="Fechar">
          ×
        </button>
        <header className="fuel-modal-header">
          <small>ABASTECIMENTO CONTROLADO</small>
          <h2 id="fuel-dispense-title">Registrar abastecimento</h2>
          <p>
            {request.vehicle_identifier || request.equipment_identifier || request.plate_identifier} ·{" "}
            {fuelLabel(request.fuel_type)}
          </p>
        </header>
        <section className="fuel-dispense-summary">
          <article>
            <small>Saldo autorizado</small>
            <strong>{numberFormat.format(remainingLiters)} L</strong>
          </article>
          <article>
            <small>Último odômetro</small>
            <strong>{vehiclePresent ? `${numberFormat.format(odometerBaseline)} km` : "Não aplicável"}</strong>
          </article>
          <article>
            <small>Último horímetro</small>
            <strong>{equipmentPresent ? `${numberFormat.format(hourMeterBaseline)} h` : "Não aplicável"}</strong>
          </article>
        </section>
        <div className="form-grid two fuel-form-grid">
          <label>
            Litros abastecidos
            <input
              name="liters"
              type="number"
              min="0.01"
              max={remainingLiters}
              step="0.01"
              value={liters}
              onChange={(event) => setLiters(event.target.value)}
              required
            />
          </label>
          <label>
            Preço efetivo por litro
            <input
              name="unit_price"
              type="number"
              min="0.01"
              step="0.001"
              value={unitPrice}
              onChange={(event) => setUnitPrice(event.target.value)}
              required
            />
          </label>
          {vehiclePresent && (
            <label>
              Odômetro atual
              <input
                name="odometer"
                type="number"
                min={odometerBaseline}
                step="0.1"
                value={odometer}
                onChange={(event) => setOdometer(event.target.value)}
                required
              />
            </label>
          )}
          {!vehiclePresent && <input name="odometer" type="hidden" value="" />}
          {equipmentPresent && (
            <label>
              Horímetro atual
              <input
                name="hour_meter"
                type="number"
                min={hourMeterBaseline}
                step="0.1"
                value={hourMeter}
                onChange={(event) => setHourMeter(event.target.value)}
                required
              />
            </label>
          )}
          {!equipmentPresent && <input name="hour_meter" type="hidden" value="" />}
          <label className="span-2 fuel-span-2">
            Total do abastecimento
            <input value={brl.format(Number(liters || 0) * Number(unitPrice || 0))} readOnly tabIndex={-1} />
          </label>
          <label className="span-2 fuel-span-2">
            Observações / comprovante
            <textarea name="notes" rows={3} placeholder="Número do cupom, divergências ou ocorrências" />
          </label>
        </div>
        {error && <div className="feedback error fuel-feedback fuel-feedback-error">{error}</div>}
        <footer className="fuel-modal-actions">
          <button className="fuel-button fuel-button-secondary" type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary fuel-button fuel-button-primary" disabled={busy || remainingLiters <= 0}>
            {busy ? "Registrando..." : "Confirmar abastecimento"}
          </button>
        </footer>
      </form>
    </div>
  );
}

function meterSummary(odometer?: number | null, hourMeter?: number | null) {
  const values: string[] = [];
  if (odometer !== null && odometer !== undefined) values.push(`${numberFormat.format(Number(odometer))} km`);
  if (hourMeter !== null && hourMeter !== undefined) values.push(`${numberFormat.format(Number(hourMeter))} h`);
  return values.join(" · ") || "Não informada";
}

function contractLabel(contract?: OperationalContract) {
  if (!contract) return "Sem contrato";
  return [contract.contract_number, contract.title].filter(Boolean).join(" · ") || contract.id;
}
