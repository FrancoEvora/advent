export type CrmOperationCategory = "decision" | "missing_data" | "failed" | "completed";

export type CrmOperationItem = {
  id: string;
  lead_id: string;
  lead_name: string;
  category: CrmOperationCategory;
  title: string;
  detail: string;
  occurred_at: string | null;
  changes: Record<string, { before: string | null; after: string | null }> | null;
};

export type CrmOperationsSnapshot = {
  generated_at: string;
  summary: Record<CrmOperationCategory | "processing", number>;
  items: CrmOperationItem[];
  category_limit: number;
  can_reconcile: boolean;
};

export type CrmReconciliationBatch = {
  reviewed: number;
  changed: number;
  next_after_id: string | null;
  has_more: boolean;
  external_delivery: false;
};

export type CrmReconciliationProgress = { reviewed: number; changed: number };

export class CrmReconciliationError extends Error {
  readonly progress: CrmReconciliationProgress;
  constructor(message: string, progress: CrmReconciliationProgress) {
    super(message);
    this.name = "CrmReconciliationError";
    this.progress = progress;
  }
}

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null };

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function parseBatch(value: unknown): CrmReconciliationBatch | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const batch = value as Record<string, unknown>;
  if (!nonNegativeInteger(batch.reviewed) || !nonNegativeInteger(batch.changed)
    || batch.changed > batch.reviewed || batch.reviewed > 250
    || typeof batch.has_more !== "boolean" || batch.external_delivery !== false
    || !(batch.next_after_id === null || typeof batch.next_after_id === "string")) return null;
  if (batch.has_more && (!batch.next_after_id || batch.reviewed === 0)) return null;
  return batch as CrmReconciliationBatch;
}

/** Keyset pagination ensures every lead is considered once per run. A failed
 * later batch reports already committed work instead of claiming full success. */
export async function runCrmReconciliation(
  requestBatch: (afterId: string | null) => PromiseLike<RpcResult>,
  onProgress?: (progress: CrmReconciliationProgress) => void,
): Promise<CrmReconciliationProgress> {
  let afterId: string | null = null;
  const cursors = new Set<string>();
  const progress = { reviewed: 0, changed: 0 };
  for (let page = 0; page < 100; page += 1) {
    let result: RpcResult;
    try {
      result = await requestBatch(afterId);
    } catch {
      throw new CrmReconciliationError("A conexão foi interrompida. É possível retomar a sincronização com segurança.", { ...progress });
    }
    if (result.error) {
      throw new CrmReconciliationError(result.error.code === "42501"
        ? "Seu perfil não pode sincronizar o CRM."
        : "Não foi possível concluir a sincronização. Tente novamente.", { ...progress });
    }
    const batch = parseBatch(result.data);
    if (!batch || (batch.has_more && cursors.has(batch.next_after_id!))) {
      throw new CrmReconciliationError("A sincronização não retornou uma confirmação válida. Atualize a fila antes de continuar.", { ...progress });
    }
    progress.reviewed += batch.reviewed;
    progress.changed += batch.changed;
    onProgress?.({ ...progress });
    if (!batch.has_more) return progress;
    afterId = batch.next_after_id;
    cursors.add(afterId!);
  }
  throw new CrmReconciliationError("A revisão atingiu o limite desta execução. Os registros já sincronizados foram preservados.", { ...progress });
}

export function isCrmOperationsSnapshot(value: unknown): value is CrmOperationsSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (!snapshot.summary || typeof snapshot.summary !== "object" || !Array.isArray(snapshot.items)
    || typeof snapshot.generated_at !== "string" || typeof snapshot.can_reconcile !== "boolean"
    || !nonNegativeInteger(snapshot.category_limit)) return false;
  const summary = snapshot.summary as Record<string, unknown>;
  if (!["decision", "missing_data", "failed", "completed", "processing"].every(key => nonNegativeInteger(summary[key]))) return false;
  return snapshot.items.every(item => item && typeof item === "object"
    && typeof item.id === "string" && typeof item.lead_id === "string"
    && typeof item.lead_name === "string" && typeof item.title === "string"
    && typeof item.detail === "string"
    && (item.occurred_at === null || typeof item.occurred_at === "string")
    && ["decision", "missing_data", "failed", "completed"].includes(item.category)
    && (item.changes === null || (typeof item.changes === "object" && !Array.isArray(item.changes)
      && Object.values(item.changes).every(change => change && typeof change === "object"
        && ("before" in change) && (change.before === null || typeof change.before === "string")
        && ("after" in change) && (change.after === null || typeof change.after === "string")))));
}
