"use client";
import type { BrokerData } from "./load-broker-data";
import { ProposalSimulator } from "./proposal-simulator";
export function BrokerProposalModal(props: { loaded: BrokerData; initialLeadId?: string; initialUnitId?: string; close: () => void; done: (message: string) => Promise<void> }) {
  return <ProposalSimulator {...props} />;
}
