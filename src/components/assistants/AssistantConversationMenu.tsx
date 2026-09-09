"use client";
import { useEffect, useRef, type ReactNode } from "react";

export function AssistantConversationMenu({ organization, conversations, selectedId, busy, onClose, onNew, onSelect, children }: {
  organization: string; conversations: { id: string; title: string }[]; selectedId: string | null;
  busy: boolean; onClose: () => void; onNew: () => void; onSelect: (id: string) => void; children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement;
    panel.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const items = panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled),a[href]");
      if (!items?.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("keydown", key); if (previous instanceof HTMLElement && previous.isConnected) previous.focus(); };
  }, [onClose]);
  return <aside ref={panel} className="arisa-conversations" role="dialog" aria-modal="true" aria-label="Conversas e opções">
    <div className="arisa-menu-head"><strong>Suas conversas</strong><button onClick={onClose} aria-label="Fechar menu"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18" /></svg></button></div>
    <small>{organization}</small>
    <button onClick={onNew} disabled={busy}>+ Nova conversa</button>
    <nav aria-label="Conversas anteriores">{conversations.map(conversation => <button key={conversation.id} aria-current={selectedId === conversation.id ? "page" : undefined} onClick={() => onSelect(conversation.id)} disabled={busy}>{conversation.title}</button>)}</nav>
    <div className="arisa-menu-links">{children}</div>
  </aside>;
}
