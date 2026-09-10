"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { client } from "./chat-client";
import styles from "./notifications.module.css";

type Notice = { id: string; title: string; message: string; read_at: string | null; created_at: string };
export default function ArisaNotificationBell({ organizationId, assistantName = "Arisa" }: { organizationId: string; assistantName?: string }) {
  const [items, setItems] = useState<Notice[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const mounted = useRef(false);
  const request = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++request.current;
    const result = await client().rpc("arisa_my_notifications", { p_organization_id: organizationId, p_limit: 20 });
    if (!mounted.current || current !== request.current) return;
    if (result.error) { setError("Não foi possível atualizar os avisos. Tente novamente."); return; }
    setItems(result.data?.items || []); setUnread(Number(result.data?.unread_count || 0)); setError("");
  }, [organizationId]);
  useEffect(() => {
    mounted.current = true;
    const sync = () => { if (document.visibilityState === "visible") void refresh(); };
    void refresh();
    const timer = window.setInterval(sync, 30000);
    window.addEventListener("focus", sync); document.addEventListener("visibilitychange", sync);
    return () => { mounted.current = false; request.current++; clearInterval(timer); window.removeEventListener("focus", sync); document.removeEventListener("visibilitychange", sync); };
  }, [refresh]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);
  async function markRead(ids: string[]) {
    setBusy(true);
    const result = await client().rpc("arisa_mark_notifications_read", { p_organization_id: organizationId, p_ids: ids });
    if (mounted.current) { if (result.error) setError("Não foi possível marcar o aviso como lido."); else await refresh(); setBusy(false); }
  }
  return <div ref={root} className={styles.root}>
    <button ref={trigger} type="button" className="arisa-icon-button" aria-label={`Avisos da ${assistantName}${unread ? `, ${unread} não lidos` : ""}`} aria-expanded={open} aria-controls="arisa-notifications" onClick={() => { setOpen(value => !value); void refresh(); }}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></svg>
      {unread > 0 && <span className={styles.badge} aria-hidden="true">{unread > 99 ? "99+" : unread}</span>}
    </button>
    {open && <section id="arisa-notifications" className={styles.panel} aria-label={`Avisos da ${assistantName}`}>
      <div className={styles.heading}><strong>Novidades para você</strong><button type="button" onClick={() => setOpen(false)} aria-label="Fechar avisos">×</button></div>
      <p>Pedidos de reunião, recados e assuntos que aguardam sua atenção.</p>
      {error && <p role="alert">{error} <button type="button" onClick={() => void refresh()}>Atualizar</button></p>}
      {unread > 0 && items.some(item => !item.read_at) && <button type="button" disabled={busy} onClick={() => void markRead(items.filter(item => !item.read_at).map(item => item.id))}>Marcar os avisos exibidos como lidos</button>}
      <div className={styles.list}>
        {items.map(item => <article key={item.id} className={item.read_at ? styles.read : styles.unread}>
          <strong>{item.title}</strong><p>{item.message}</p>
          <time dateTime={item.created_at}>{new Date(item.created_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}</time>
          {!item.read_at && <button type="button" disabled={busy} onClick={() => void markRead([item.id])}>Marcar como lido</button>}
        </article>)}
        {!items.length && !error && <p>Nenhum aviso registrado para você.</p>}
      </div>
      <Link href="/agenda">Ver todas as notificações na plataforma</Link>
      <small>Você também pode perguntar à {assistantName}: “Tem alguma novidade para mim?”</small>
    </section>}
  </div>;
}
