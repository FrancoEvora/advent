"use client";

import { useMemo, useState } from "react";
import type { PublicAgentCommercialContext, PublicAgentCommercialUnit } from "@/lib/public-agent/types";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL", maximumFractionDigits: 0 });
const preciseMoney = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const numeric = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const area = (v: unknown) => numeric(v) ? `${v.toLocaleString("pt-BR")} m²` : "Área a confirmar";
const price = (v: unknown) => numeric(v) ? money.format(v) : "Preço a consultar";

function lotLabel(unit: PublicAgentCommercialUnit) {
  const match = /^([A-Z0-9]+)-([A-Z0-9]+)-([A-Z0-9]+)$/i.exec(unit.unitCode);
  const block = unit.blockCode || match?.[2];
  const lot = unit.lotNumber || match?.[3];
  return block && lot ? `Quadra ${block} · Lote ${lot}` : unit.unitCode;
}

export function CommercialUnitsView({ commercial, disabled, onSimulate }: {
  commercial: PublicAgentCommercialContext;
  disabled: boolean;
  onSimulate: (unit: PublicAgentCommercialUnit) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const units = useMemo(() => {
    const unique = new Map<string, PublicAgentCommercialUnit>();
    for (const unit of commercial.units || []) {
      if (unit?.unitCode && !unique.has(unit.unitCode)) unique.set(unit.unitCode, unit);
    }
    return [...unique.values()].sort((a, b) => {
      const pa = numeric(a.listPrice) ? a.listPrice : Infinity;
      const pb = numeric(b.listPrice) ? b.listPrice : Infinity;
      return pa === pb ? a.unitCode.localeCompare(b.unitCode, "pt-BR", { numeric: true }) : pa - pb;
    });
  }, [commercial.units]);
  if (!units.length) return null;
  const visible = expanded ? units : units.slice(0, 3);
  const comparison = units.slice(0, 3);
  const consultedAt = commercial.asOf && Number.isFinite(Date.parse(commercial.asOf))
    ? new Date(commercial.asOf).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short", timeZone: "America/Sao_Paulo" })
    : null;

  return <section className="bia-lots" aria-label="Opções de lotes">
    <header className="bia-lots-heading">
      <strong>{units.length === 1 ? "Lote consultado" : "Opções para você"}</strong>
      {units.length > 1 && <span>Por menor preço nesta seleção</span>}
    </header>
    <ol className="bia-lots-list">
      {visible.map((unit, index) => <li className="bia-lot" key={unit.unitCode} data-featured={index === 0}>
        <div className="bia-lot-top"><strong>{lotLabel(unit)}</strong><span>{area(unit.area)}</span></div>
        <div className="bia-lot-price">{price(unit.listPrice)}</div>
        <div className="bia-lot-actions">
          <button type="button" className="bia-lot-simulate" onClick={() => onSimulate(unit)} disabled={disabled} aria-label={`Simular parcelas do lote ${unit.unitCode}`}>Simular parcelas</button>
          <details className="bia-lot-details">
            <summary aria-label={`Ver detalhes do lote ${unit.unitCode}`}>Detalhes</summary>
            <dl>
              <div><dt>Identificação</dt><dd>{unit.unitCode}</dd></div>
              {numeric(unit.pricePerSqm) && <div><dt>Valor por m²</dt><dd>{preciseMoney.format(unit.pricePerSqm)}</dd></div>}
              {numeric(unit.frontage) && <div><dt>Frente</dt><dd>{unit.frontage.toLocaleString("pt-BR")} m</dd></div>}
              {numeric(unit.depth) && <div><dt>Profundidade</dt><dd>{unit.depth.toLocaleString("pt-BR")} m</dd></div>}
              {unit.corner === true && <div><dt>Posição</dt><dd>Esquina</dd></div>}
              {unit.topography && <div><dt>Topografia</dt><dd>{unit.topography}</dd></div>}
              {unit.orientation && <div><dt>Orientação</dt><dd>{unit.orientation}</dd></div>}
            </dl>
          </details>
        </div>
      </li>)}
    </ol>
    {units.length > 3 && <button type="button" className="bia-lots-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "Mostrar só 3 opções" : `Ver mais ${units.length - 3} opções consultadas`}</button>}
    {comparison.length > 1 && <details className="bia-lots-compare"><summary>Comparar {comparison.length} opções</summary><table><caption>Comparação das opções de menor preço nesta seleção</caption><thead><tr><th scope="col">Lote</th><th scope="col">Área</th><th scope="col">Valor</th></tr></thead><tbody>{comparison.map(unit => <tr key={unit.unitCode}><th scope="row">{unit.unitCode}</th><td>{area(unit.area)}</td><td>{price(unit.listPrice)}</td></tr>)}</tbody></table></details>}
    <p className="bia-lots-note">{consultedAt ? `Consulta em ${consultedAt}. ` : "Valores consultados neste atendimento. "}Disponibilidade sujeita à confirmação.</p>
  </section>;
}
