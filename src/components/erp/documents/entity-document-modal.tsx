"use client";

import type { ErpData } from "../types";
import { DocumentManager } from "./document-manager";

export function EntityDocumentModal({ data, mutate, entityType, entityId, close }: { data: ErpData; mutate: (operation: () => Promise<void>, success: string) => Promise<void>; entityType: string; entityId: string; close: () => void }) {
  return <div className="modal-backdrop" onMouseDown={close}><div className="modal large" onMouseDown={event => event.stopPropagation()}><button className="modal-close" onClick={close}>×</button><DocumentManager data={data} mutate={mutate} compact initialEntityType={entityType} initialEntityId={entityId} /></div></div>;
}
