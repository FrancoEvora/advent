"use client";

import { useState } from "react";
import { normalizeBrokerSearch } from "@/lib/broker-funnel";
import type { CrmRecord } from "../types";
import styles from "./broker-workspace.module.css";

export function BrokerLeadSelect({ leads, value, onChange, disabled = false, required = false }: { leads: CrmRecord[]; value: string; onChange: (id: string) => void; disabled?: boolean; required?: boolean }) {
  const [query, setQuery] = useState("");
  const matching = leads.filter(lead => normalizeBrokerSearch(lead.person_name).includes(normalizeBrokerSearch(query)));
  // Keep an explicit selection visible while searching; typing must not silently change the linked lead.
  const options = leads.filter(lead => lead.id === value || matching.includes(lead));
  return <div className={styles.leadPicker}>
    {!disabled && <label>Buscar lead por nome<input type="search" placeholder="Digite o nome do lead" value={query} onChange={event => setQuery(event.target.value)} /></label>}
    <label>Lead vinculado<select name="lead" required={required} disabled={disabled} value={value} onChange={event => onChange(event.target.value)}>
      <option value="">{required ? "Selecione o lead" : "Compromisso pessoal (sem lead)"}</option>
      {options.map(lead => <option key={lead.id} value={lead.id}>{lead.person_name}</option>)}
    </select></label>
    {query && !matching.length && <small role="status">Nenhum lead encontrado para esta busca.{value ? " O lead selecionado foi mantido." : ""}</small>}
  </div>;
}
