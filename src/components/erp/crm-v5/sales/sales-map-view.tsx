"use client";
import { useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ErpData } from "../../types";
import type { CrmSection } from "../types";
import type { InventoryStatus, InventoryUnit, SalesData } from "./types";
import { brl, statusLabel } from "./utils";
import { ReservationModal, UnitEditor } from "./unit-editor";

const inventoryStatuses: InventoryStatus[] = [
  "disponivel",
  "reservado",
  "vendido",
  "bloqueio_estrategico",
  "bloqueio_comercial",
  "indisponivel",
];

export function SalesMapView({
  data,
  sales,
  reload,
  setSection,
}: {
  data: ErpData;
  sales: SalesData;
  reload: () => Promise<void>;
  setSection: (s: CrmSection) => void;
}) {
  const [project, setProject] = useState(data.projects[0]?.id || "");
  const [statusFilter, setStatusFilter] = useState<InventoryStatus | null>(null);
  const [selected, setSelected] = useState<InventoryUnit | null>(null);
  const [edit, setEdit] = useState<InventoryUnit | null | "new">(null);
  const [reserve, setReserve] = useState<{
    unit: InventoryUnit;
    strategic?: boolean;
  } | null>(null);
  const units = useMemo(
    () => sales.units.filter((u) => u.project_id === project && u.active),
    [sales.units, project],
  );
  const filteredUnits = useMemo(
    () =>
      statusFilter
        ? units.filter((unit) => unit.status === statusFilter)
        : units,
    [statusFilter, units],
  );
  const blocks = useMemo(
    () => [...new Set(filteredUnits.map((unit) => unit.block_code))].sort(),
    [filteredUnits],
  );
  const totals = useMemo(
    () =>
      Object.fromEntries(
        inventoryStatuses.map((status) => [
          status,
          units.filter((unit) => unit.status === status).length,
        ]),
      ) as Record<InventoryStatus, number>,
    [units],
  );

  function clearStatusFilter() {
    setStatusFilter(null);
    setSelected(null);
  }

  function toggleStatusFilter(status: InventoryStatus) {
    setStatusFilter((current) => (current === status ? null : status));
    setSelected(null);
  }

  function changeProject(projectId: string) {
    setProject(projectId);
    setStatusFilter(null);
    setSelected(null);
  }

  async function release(unit: InventoryUnit) {
    const client = getSupabase();
    if (!client) return;
    await client
      .from("crm_unit_reservations")
      .update({ status: "cancelada" })
      .eq("unit_id", unit.id)
      .eq("status", "ativa");
    await client
      .from("crm_inventory_units")
      .update({
        status: "disponivel",
        strategic_reason: null,
        reserved_until: null,
      })
      .eq("id", unit.id);
    await reload();
    setSelected(null);
  }
  function createProposal(unit: InventoryUnit) {
    localStorage.setItem("evora-proposal-unit", unit.id);
    setSection("proposals" as CrmSection);
  }
  return (
    <div className="crm5-stack">
      <section className="crm5-section-header">
        <div>
          <small>COMERCIALIZAÇÃO IMOBILIÁRIA</small>
          <h2>Mapa de vendas</h2>
          <p>
            Estoque, disponibilidade, reservas, bloqueios e vendas por
            empreendimento e quadra.
          </p>
        </div>
        <div className="toolbar-actions">
          <select
            value={project}
            onChange={(event) => changeProject(event.target.value)}
          >
            {data.projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <button onClick={() => setEdit("new")}>+ Unidade</button>
        </div>
      </section>
      <section
        className="sales-status-summary"
        aria-label="Filtrar lotes por status"
      >
        {inventoryStatuses.map((status) => (
          <button
            key={status}
            type="button"
            data-status={status}
            className={statusFilter === status ? "active" : ""}
            aria-pressed={statusFilter === status}
            aria-label={`${statusLabel[status]}: ${totals[status]} unidades`}
            onClick={() => toggleStatusFilter(status)}
          >
            <strong>{totals[status]}</strong>
            <span>{statusLabel[status]}</span>
          </button>
        ))}
      </section>
      {!!units.length && (
        <div className="sales-map-filter-status" aria-live="polite">
          <span>
            {statusFilter
              ? `${filteredUnits.length} de ${units.length} unidades · ${statusLabel[statusFilter]}`
              : `${units.length} unidades · todos os status`}
          </span>
          {statusFilter && (
            <button type="button" onClick={clearStatusFilter}>
              Exibir todos
            </button>
          )}
        </div>
      )}
      {!units.length ? (
        <section className="crm5-empty">
          <strong>Nenhuma unidade cadastrada</strong>
          <p>Cadastre manualmente ou importe o estoque pela tela Unidades.</p>
          <button
            className="primary"
            onClick={() => setSection("inventory" as CrmSection)}
          >
            Abrir estoque
          </button>
        </section>
      ) : !filteredUnits.length ? (
        <section className="crm5-empty">
          <strong>Nenhuma unidade com este status</strong>
          <p>
            Não há lotes classificados como{" "}
            {statusFilter ? statusLabel[statusFilter] : ""} neste
            empreendimento.
          </p>
          <button className="primary" type="button" onClick={clearStatusFilter}>
            Exibir todos os lotes
          </button>
        </section>
      ) : (
        <section className="sales-map">
          {blocks.map((block) => (
            <article className="sales-block" key={block}>
              <header>
                <div>
                  <small>QUADRA</small>
                  <h3>{block}</h3>
                </div>
                <span>
                  {
                    filteredUnits.filter((unit) => unit.block_code === block)
                      .length
                  }{" "}
                  unidades
                </span>
              </header>
              <div className="sales-lot-grid">
                {filteredUnits
                  .filter((u) => u.block_code === block)
                  .map((unit) => (
                    <button
                      key={unit.id}
                      className={selected?.id === unit.id ? "selected" : ""}
                      data-status={unit.status}
                      onClick={() => setSelected(unit)}
                      title={`${unit.unit_code} · ${brl.format(Number(unit.list_price))}`}
                    >
                      <b>{unit.lot_number}</b>
                      <small>{unit.area} m²</small>
                      <span>{brl.format(Number(unit.list_price))}</span>
                    </button>
                  ))}
              </div>
            </article>
          ))}
        </section>
      )}
      {selected && (
        <aside className="sales-unit-drawer">
          <button className="close" onClick={() => setSelected(null)}>
            ×
          </button>
          <small>{statusLabel[selected.status]}</small>
          <h3>{selected.unit_code}</h3>
          <dl>
            <div>
              <dt>Quadra / lote</dt>
              <dd>
                {selected.block_code} / {selected.lot_number}
              </dd>
            </div>
            <div>
              <dt>Área</dt>
              <dd>{selected.area} m²</dd>
            </div>
            <div>
              <dt>Preço</dt>
              <dd>{brl.format(Number(selected.list_price))}</dd>
            </div>
            <div>
              <dt>Valor/m²</dt>
              <dd>
                {brl.format(
                  Number(
                    selected.price_per_sqm ||
                      selected.list_price / Math.max(selected.area, 1),
                  ),
                )}
              </dd>
            </div>
            <div>
              <dt>Preço mínimo</dt>
              <dd>
                {selected.minimum_price
                  ? brl.format(Number(selected.minimum_price))
                  : "Não definido"}
              </dd>
            </div>
            <div>
              <dt>Características</dt>
              <dd>
                {[
                  selected.corner ? "Esquina" : null,
                  selected.topography,
                  selected.orientation,
                ]
                  .filter(Boolean)
                  .join(" · ") || "—"}
              </dd>
            </div>
          </dl>
          {selected.strategic_reason && (
            <p className="feedback">{selected.strategic_reason}</p>
          )}
          <div className="sales-drawer-actions">
            {selected.status === "disponivel" && (
              <>
                <button
                  className="primary"
                  onClick={() => createProposal(selected)}
                >
                  Criar proposta
                </button>
                <button onClick={() => setReserve({ unit: selected })}>
                  Reservar
                </button>
                <button
                  onClick={() =>
                    setReserve({ unit: selected, strategic: true })
                  }
                >
                  Bloquear
                </button>
              </>
            )}
            {[
              "reservado",
              "bloqueio_estrategico",
              "bloqueio_comercial",
            ].includes(selected.status) && (
              <button onClick={() => release(selected)}>Liberar unidade</button>
            )}
            <button onClick={() => setEdit(selected)}>Editar cadastro</button>
          </div>
        </aside>
      )}
      {edit && (
        <UnitEditor
          data={data}
          unit={edit === "new" ? null : edit}
          close={() => setEdit(null)}
          reload={reload}
        />
      )}{" "}
      {reserve && (
        <ReservationModal
          data={data}
          sales={sales}
          unit={reserve.unit}
          strategic={reserve.strategic}
          close={() => setReserve(null)}
          reload={reload}
        />
      )}
    </div>
  );
}
