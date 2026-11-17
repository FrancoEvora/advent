"use client";
import type { ErpData } from "../../types";
import type { SalesData } from "./types";
import { ProposalSimulator } from "../../broker/proposal-simulator";
export function ProposalModalV52({ data, sales, initialUnitId, close, reload, embedded = false }: { embedded?: boolean; data: ErpData; sales: SalesData; initialUnitId?: string; close: () => void; reload: () => Promise<void> }) {
  const loaded = { data, crm: { records: data.crmRecords }, units: sales.units.filter(unit => ["disponivel", "reservado"].includes(unit.status)), commerce: { policies: sales.policies.filter(policy => policy.active).map(policy => ({ ...policy, is_default: true })), lead_policies: [] } };
  return <ProposalSimulator embedded={embedded} loaded={loaded} sales={sales} initialUnitId={initialUnitId} close={close} done={reload} />;
}
