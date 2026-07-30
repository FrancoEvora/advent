"use client";

import { useMemo, useState } from "react";
import type {
  LandownerSalesMap,
  LandownerSalesMapStatus,
  LandownerSalesMapUnit,
} from "./partner-types";

type SalesMapFilter = LandownerSalesMapStatus | "todos";

const statusOptions: Array<{
  value: SalesMapFilter;
  label: string;
}> = [
  { value: "todos", label: "Todos" },
  { value: "disponivel", label: "Disponíveis" },
  { value: "reservado", label: "Reservados" },
  { value: "vendido", label: "Vendidos" },
  { value: "bloqueado", label: "Bloqueados" },
  { value: "indisponivel", label: "Indisponíveis" },
];

const statusLabels: Record<LandownerSalesMapStatus, string> = {
  disponivel: "Disponível",
  reservado: "Reservado",
  vendido: "Vendido",
  bloqueado: "Bloqueado",
  indisponivel: "Indisponível",
};

const shortDate = new Intl.DateTimeFormat("pt-BR");
const area = new Intl.NumberFormat("pt-BR", {
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});

function positionDate(value: string) {
  const parsed = new Date(`${value.slice(0, 10)}T12:00:00`);
  return Number.isNaN(parsed.getTime()) ? "—" : shortDate.format(parsed);
}

function statusCount(map: LandownerSalesMap, status: SalesMapFilter) {
  if (status === "todos") return map.total_units || map.units.length;
  return Number(map.counts?.[status] || 0);
}

export function LandownerSalesMapView({
  map,
}: {
  map: LandownerSalesMap;
}) {
  const units = useMemo(
    () =>
      [...(map.units || [])].sort(
        (left, right) =>
          left.block_code.localeCompare(right.block_code, "pt-BR", {
            numeric: true,
          }) ||
          left.lot_number.localeCompare(right.lot_number, "pt-BR", {
            numeric: true,
          }) ||
          left.unit_code.localeCompare(right.unit_code, "pt-BR", {
            numeric: true,
          }),
      ),
    [map.units],
  );
  const [status, setStatus] = useState<SalesMapFilter>("todos");
  const [block, setBlock] = useState("todos");
  const [query, setQuery] = useState("");
  const [selectedCode, setSelectedCode] = useState("");

  const blocks = useMemo(
    () =>
      [...new Set(units.map(unit => unit.block_code))].sort((left, right) =>
        left.localeCompare(right, "pt-BR", { numeric: true }),
      ),
    [units],
  );
  const normalizedQuery = query.trim().toLocaleLowerCase("pt-BR");
  const filteredUnits = useMemo(
    () =>
      units.filter(unit => {
        const matchesStatus =
          status === "todos" || unit.status === status;
        const matchesBlock =
          block === "todos" || unit.block_code === block;
        const searchable =
          `${unit.unit_code} ${unit.block_code} ${unit.lot_number}`.toLocaleLowerCase(
            "pt-BR",
          );
        return (
          matchesStatus &&
          matchesBlock &&
          (!normalizedQuery || searchable.includes(normalizedQuery))
        );
      }),
    [block, normalizedQuery, status, units],
  );
  const visibleBlocks = useMemo(
    () =>
      [...new Set(filteredUnits.map(unit => unit.block_code))].sort(
        (left, right) =>
          left.localeCompare(right, "pt-BR", { numeric: true }),
      ),
    [filteredUnits],
  );
  const selectedUnit =
    units.find(unit => unit.unit_code === selectedCode) || null;
  const hasFilters =
    status !== "todos" || block !== "todos" || Boolean(normalizedQuery);

  function resetFilters() {
    setStatus("todos");
    setBlock("todos");
    setQuery("");
    setSelectedCode("");
  }

  function changeStatus(nextStatus: SalesMapFilter) {
    setStatus(nextStatus);
    setSelectedCode("");
  }

  return (
    <article className="landowner-public-card landowner-sales-map-card">
      <header>
        <div>
          <small>MAPA COMERCIAL PUBLICADO</small>
          <h3>Posição dos lotes por quadra</h3>
          <p>
            Consulte a situação de cada unidade sem dados pessoais de
            compradores ou informações comerciais internas.
          </p>
        </div>
        <strong>{map.total_units || units.length} lotes</strong>
      </header>

      <div className="landowner-sales-map-position">
        <span aria-hidden="true">✓</span>
        <p>
          Posição congelada em <b>{positionDate(map.position_date)}</b>.
          Alterações posteriores aparecerão somente em uma nova publicação.
        </p>
      </div>

      <nav
        className="landowner-sales-map-statuses"
        aria-label="Filtrar lotes por situação"
      >
        {statusOptions.map(option => (
          <button
            key={option.value}
            type="button"
            data-status={
              option.value === "todos" ? undefined : option.value
            }
            className={status === option.value ? "active" : ""}
            aria-pressed={status === option.value}
            onClick={() => changeStatus(option.value)}
          >
            <strong>{statusCount(map, option.value)}</strong>
            <span>{option.label}</span>
          </button>
        ))}
      </nav>

      <div className="landowner-sales-map-toolbar">
        <label>
          <span>Buscar lote</span>
          <input
            type="search"
            value={query}
            onChange={event => {
              setQuery(event.target.value);
              setSelectedCode("");
            }}
            placeholder="Código, quadra ou lote"
          />
        </label>
        <label>
          <span>Quadra</span>
          <select
            value={block}
            onChange={event => {
              setBlock(event.target.value);
              setSelectedCode("");
            }}
          >
            <option value="todos">Todas as quadras</option>
            {blocks.map(item => (
              <option key={item} value={item}>
                Quadra {item}
              </option>
            ))}
          </select>
        </label>
        <button type="button" onClick={resetFilters} disabled={!hasFilters}>
          Limpar filtros
        </button>
      </div>

      <div className="landowner-sales-map-result" aria-live="polite">
        <span>
          Exibindo <b>{filteredUnits.length}</b> de{" "}
          <b>{map.total_units || units.length}</b> lotes
        </span>
        <div aria-label="Legenda do mapa">
          {statusOptions.slice(1).map(option => (
            <span
              key={option.value}
              data-status={option.value}
            >
              <i aria-hidden="true" />
              {option.label}
            </span>
          ))}
        </div>
      </div>

      {!filteredUnits.length ? (
        <div className="landowner-sales-map-empty">
          <strong>Nenhum lote encontrado</strong>
          <p>Altere os filtros para consultar outras unidades.</p>
          <button type="button" onClick={resetFilters}>
            Exibir todos
          </button>
        </div>
      ) : (
        <div className="landowner-sales-map-grid">
          {visibleBlocks.map(blockCode => (
            <section key={blockCode}>
              <header>
                <div>
                  <small>QUADRA</small>
                  <h4>{blockCode}</h4>
                </div>
                <span>
                  {
                    filteredUnits.filter(
                      unit => unit.block_code === blockCode,
                    ).length
                  }{" "}
                  lote(s)
                </span>
              </header>
              <div>
                {filteredUnits
                  .filter(unit => unit.block_code === blockCode)
                  .map(unit => (
                    <LotButton
                      key={`${unit.block_code}-${unit.lot_number}-${unit.unit_code}`}
                      unit={unit}
                      selected={selectedCode === unit.unit_code}
                      select={() =>
                        setSelectedCode(current =>
                          current === unit.unit_code
                            ? ""
                            : unit.unit_code,
                        )
                      }
                    />
                  ))}
              </div>
            </section>
          ))}
        </div>
      )}

      {selectedUnit && (
        <aside
          className="landowner-sales-map-detail"
          data-status={selectedUnit.status}
          aria-live="polite"
        >
          <div>
            <small>{statusLabels[selectedUnit.status]}</small>
            <h4>{selectedUnit.unit_code}</h4>
          </div>
          <dl>
            <div>
              <dt>Quadra</dt>
              <dd>{selectedUnit.block_code}</dd>
            </div>
            <div>
              <dt>Lote</dt>
              <dd>{selectedUnit.lot_number}</dd>
            </div>
            <div>
              <dt>Área</dt>
              <dd>{area.format(Number(selectedUnit.area || 0))} m²</dd>
            </div>
            <div>
              <dt>Situação publicada</dt>
              <dd>{statusLabels[selectedUnit.status]}</dd>
            </div>
          </dl>
          <button
            type="button"
            onClick={() => setSelectedCode("")}
            aria-label={`Fechar detalhes do lote ${selectedUnit.lot_number}`}
          >
            Fechar detalhes
          </button>
        </aside>
      )}

      <p className="landowner-sales-map-basis">{map.basis}</p>
    </article>
  );
}

function LotButton({
  unit,
  selected,
  select,
}: {
  unit: LandownerSalesMapUnit;
  selected: boolean;
  select: () => void;
}) {
  return (
    <button
      type="button"
      data-status={unit.status}
      className={selected ? "selected" : ""}
      aria-pressed={selected}
      aria-label={`Quadra ${unit.block_code}, lote ${unit.lot_number}, ${area.format(
        Number(unit.area || 0),
      )} metros quadrados, ${statusLabels[unit.status]}`}
      onClick={select}
    >
      <b>{unit.lot_number}</b>
      <small>{area.format(Number(unit.area || 0))} m²</small>
      <span>{statusLabels[unit.status]}</span>
    </button>
  );
}
