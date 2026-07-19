"use client";

import { CurrencyInput } from "../currency-input";
import { money } from "../utils";

export type PurchaseLine = { id: string; description: string; quantity: number; unit: string; unitPrice: number };
export const newPurchaseLine = (): PurchaseLine => ({ id: crypto.randomUUID(), description: "", quantity: 1, unit: "un", unitPrice: 0 });

export function PurchaseLines({ lines, setLines }: { lines: PurchaseLine[]; setLines: (value: PurchaseLine[]) => void }) {
  const update = (id: string, payload: Partial<PurchaseLine>) => setLines(lines.map(line => line.id === id ? { ...line, ...payload } : line));
  return <div className="form-section"><div className="section-title-row"><h4>Itens e serviços</h4><button type="button" onClick={() => setLines([...lines, newPurchaseLine()])}>+ Adicionar item</button></div><div className="purchase-lines">{lines.map((line, index) => <article key={line.id}><span>{index + 1}</span><input placeholder="Descrição do material ou serviço" value={line.description} onChange={event => update(line.id, { description: event.target.value })} /><input type="number" min="0.001" step="0.001" value={line.quantity} onChange={event => update(line.id, { quantity: Number(event.target.value) })} /><input placeholder="Un." value={line.unit} onChange={event => update(line.id, { unit: event.target.value })} /><CurrencyInput name={`unit-${line.id}`} defaultValue={line.unitPrice} onValueChange={value => update(line.id, { unitPrice: value })} /><strong>{money.format(line.quantity * line.unitPrice)}</strong><button type="button" onClick={() => setLines(lines.filter(item => item.id !== line.id))}>×</button></article>)}</div><div className="purchase-total"><span>Total estimado</span><strong>{money.format(lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0))}</strong></div></div>;
}
