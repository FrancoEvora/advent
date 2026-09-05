"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import {
  CrmReconciliationError,
  isCrmOperationsSnapshot,
  runCrmReconciliation,
  type CrmOperationCategory,
  type CrmOperationsSnapshot,
} from "@/lib/crm/operations";
import type { ErpData } from "../types";
import styles from "./crm-operations.module.css";

const categories: { id: CrmOperationCategory; label: string; description: string }[] = [
  { id: "decision", label: "Precisam de decisão", description: "Atendimentos e próximos passos" },
  { id: "missing_data", label: "Falta informação", description: "Cadastros que impedem avançar" },
  { id: "failed", label: "Falhas", description: "Execuções e envios interrompidos" },
  { id: "completed", label: "Concluídas", description: "Sincronizações nos últimos 30 dias" },
];

function dateLabel(value: string | null | undefined) {
  if (!value) return "Sem data";
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime())
    ? parsed.toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "Data indisponível";
}

export function ArisaCrmOperations({ data, can, onRefresh, onOpenLead }: {
  data: ErpData;
  can?: (permission: string) => boolean;
  onRefresh?: () => Promise<void> | void;
  onOpenLead?: (id: string) => void;
}) {
  const organizationId = data.organization.id;
  const canView = can ? can("crm.view") : true;
  const [snapshot, setSnapshot] = useState<CrmOperationsSnapshot | null>(null);
  const [category, setCategory] = useState<CrmOperationCategory>("decision");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef(0);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    if (!canView) return;
    const current = ++generation.current;
    setLoading(true);
    try {
      const client = getSupabase();
      if (!client) throw new Error("Serviço indisponível.");
      const result = await client.rpc("get_arisa_crm_operations", { p_organization_id: organizationId });
      if (result.error || !isCrmOperationsSnapshot(result.data)) throw new Error("Não foi possível consultar a operação do CRM. Tente atualizar.");
      if (current === generation.current && mounted.current) {
        setSnapshot(result.data);
        setError("");
      }
    } catch (caught) {
      if (current === generation.current && mounted.current) {
        setError(caught instanceof Error ? caught.message : "Operação do CRM indisponível.");
      }
    } finally {
      if (current === generation.current && mounted.current) setLoading(false);
    }
  }, [canView, organizationId]);

  useEffect(() => {
    mounted.current = true;
    const initialLoad = window.setTimeout(() => void load(), 0);
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void load();
    }, 30_000);
    return () => {
      mounted.current = false;
      generation.current += 1;
      window.clearTimeout(initialLoad);
      window.clearInterval(interval);
    };
  }, [load]);

  async function synchronize() {
    if (running || !snapshot?.can_reconcile || (can && !can("crm.manage"))) return;
    const client = getSupabase();
    if (!client) { setError("Serviço indisponível."); return; }
    setRunning(true);
    setError("");
    setNotice("Conferindo o histórico de contatos e a agenda...");
    try {
      const result = await runCrmReconciliation(afterId => client.rpc("reconcile_arisa_crm_operations", {
        p_organization_id: organizationId,
        p_after_id: afterId,
        p_limit: 100,
      }), progress => {
        if (mounted.current) setNotice(`${progress.reviewed} oportunidades conferidas · ${progress.changed} atualizadas.`);
      });
      if (mounted.current) {
        setNotice(`${result.reviewed} oportunidades conferidas. ${result.changed} atualizadas com evidências do histórico e da agenda.`);
        if (result.changed) setCategory("completed");
      }
      await load();
      try { await onRefresh?.(); } catch { /* A confirmação da operação permanece válida. */ }
    } catch (caught) {
      if (mounted.current) {
        const progress = caught instanceof CrmReconciliationError ? caught.progress : null;
        setNotice(progress?.reviewed ? `${progress.reviewed} oportunidades conferidas; ${progress.changed} atualizações já concluídas.` : "");
        setError(caught instanceof Error ? caught.message : "Não foi possível concluir a sincronização.");
      }
    } finally {
      if (mounted.current) setRunning(false);
    }
  }

  if (!canView) return <p className={styles.empty}>Seu perfil não possui acesso à operação comercial.</p>;
  const items = snapshot?.items.filter(item => item.category === category) || [];
  const total = snapshot?.summary[category] || 0;
  return <section className={styles.root} aria-label="Operação do CRM pela Arisa">
    <header className={styles.header}>
      <div><span className={styles.eyebrow}>CONTINUIDADE COMERCIAL</span><h2>O CRM acompanha o atendimento</h2>
        <p>A Arisa mantém o último contato e a próxima atividade ligados ao histórico. A Bia continua conduzindo os atendimentos nos canais já configurados.</p></div>
      <div className={styles.actions}>
        <button type="button" onClick={() => void load()} disabled={loading || running}>Atualizar fila</button>
        {snapshot?.can_reconcile && (!can || can("crm.manage")) && <button type="button" className={styles.primary} onClick={() => void synchronize()} disabled={running || loading}>{running ? "Sincronizando..." : "Sincronizar CRM"}</button>}
      </div>
    </header>
    <div className={styles.context}>
      <span><i aria-hidden="true" />Atualização automática a cada nova interação registrada</span>
      <span>{snapshot ? `${snapshot.summary.processing} execuções da Bia em processamento` : "Consultando a operação"}</span>
    </div>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    <div className={styles.filters} role="group" aria-label="Filtrar atividades do CRM">
      {categories.map(item => <button key={item.id} type="button" className={category === item.id ? styles.selected : ""} aria-pressed={category === item.id} onClick={() => setCategory(item.id)}>
        <span>{item.label}</span><strong>{snapshot ? snapshot.summary[item.id].toLocaleString("pt-BR") : "—"}</strong><small>{item.description}</small>
      </button>)}
    </div>
    <div className={styles.list} aria-busy={loading}>
      {!snapshot && loading ? <p className={styles.empty}>Carregando a fila operacional...</p>
        : !items.length ? <p className={styles.empty}>{error ? "Atualize a fila para consultar os registros." : category === "completed" ? "As próximas sincronizações concluídas aparecerão aqui com as alterações realizadas." : "Nenhum item nesta categoria."}</p>
        : items.map(item => <article className={styles.item} key={item.id}>
          <div className={`${styles.marker} ${styles[item.category]}`} aria-hidden="true">{item.category === "completed" ? "✓" : item.category === "failed" ? "!" : "·"}</div>
          <div className={styles.itemContent}><div className={styles.itemHeading}><strong>{item.title}</strong><time>{dateLabel(item.occurred_at)}</time></div>
            <b className={styles.lead}>{item.lead_name}</b><p>{item.detail}</p>
            {item.changes && <dl className={styles.changes}>{Object.entries(item.changes).map(([field, change]) => <div key={field}><dt>{field === "last_contact_at" ? "Último contato" : field === "next_action_at" ? "Próxima atividade" : "Atualização"}</dt><dd>{dateLabel(change.before)} → {dateLabel(change.after)}</dd></div>)}</dl>}
          </div>
          {onOpenLead && <button type="button" className={styles.openLead} onClick={() => onOpenLead(item.lead_id)}>Abrir lead <span aria-hidden="true">↗</span></button>}
        </article>)}
    </div>
    <footer className={styles.footer}>
      <span>{total > items.length ? `Mostrando ${items.length} de ${total} itens, por prioridade.` : `${items.length} ${items.length === 1 ? "item" : "itens"} nesta categoria.`}</span>
      <span>{snapshot ? `Atualizado ${dateLabel(snapshot.generated_at)} · Brasília` : ""}</span>
    </footer>
  </section>;
}
