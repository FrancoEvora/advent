"use client";
import { type FormEvent, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ErpData } from "../types";
import type { CrmTemplate } from "./types";
import styles from "./communication-hub.module.css";

export function QuickReplies({ data, templates, reload }: { data: ErpData; templates: CrmTemplate[]; reload: () => Promise<void> }) {
  const [search, setSearch] = useState(""), [editing, setEditing] = useState<CrmTemplate | "new" | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState(""), [error, setError] = useState("");
  const canManage = ["admin", "diretoria", "gestor_crm", "marketing"].includes(data.membership.role);
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (!canManage || busy) return;
    const form = new FormData(event.currentTarget), client = getSupabase(); if (!client) return;
    setBusy(true); setError("");
    const body = String(form.get("body") || "").trim();
    const payload = { organization_id: data.organization.id, name: String(form.get("name") || "").trim(), channel: String(form.get("channel")), body, subject: editing && editing !== "new" ? editing.subject : null, category: String(form.get("category") || "").trim() || null, variables: [...new Set([...body.matchAll(/\{\{\s*([\w]+)\s*\}\}/g)].map(match => match[1]))], active: form.get("active") === "on" };
    try {
      const result = editing && editing !== "new" ? await client.from("crm_templates").update(payload).eq("organization_id", data.organization.id).eq("id", editing.id).select("id").single() : await client.from("crm_templates").insert(payload).select("id").single();
      if (result.error) throw new Error("Não foi possível salvar. Verifique sua permissão e tente novamente.");
      await reload(); setEditing(null); setNotice("Resposta rápida salva para a equipe. Nenhuma mensagem foi enviada.");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar."); }
    finally { setBusy(false); }
  }
  async function copy(text: string) { try { await navigator.clipboard.writeText(text); setNotice("Texto copiado. Revise os dados do cliente antes de usar."); } catch { setError("Não foi possível copiar automaticamente. Selecione e copie o texto da resposta."); } }
  const rows = templates.filter(item => `${item.name} ${item.category || ""} ${item.body}`.toLocaleLowerCase("pt-BR").includes(search.toLocaleLowerCase("pt-BR")));
  const selected = editing && editing !== "new" ? editing : null;
  return <section className={styles.stack}>
    <div className={styles.header}><div><h3>Respostas rápidas da equipe</h3><p>Textos reutilizáveis para atendimento. A aprovação de templates oficiais do WhatsApp é um processo separado na Meta.</p></div>{canManage && <button className="primary" onClick={() => { setEditing("new"); setError(""); }}>Nova resposta</button>}</div>
    <label>Buscar resposta<input value={search} onChange={event => setSearch(event.target.value)} placeholder="Nome, assunto ou conteúdo" /></label>
    {editing && <form className={`${styles.card} ${styles.form}`} onSubmit={save} key={selected?.id || "new"} aria-label="Editar resposta rápida"><h3>{selected ? "Editar resposta" : "Nova resposta rápida"}</h3><label>Nome<input name="name" required maxLength={160} defaultValue={selected?.name || ""} /></label><div className={styles.toolbar}><label>Canal<select name="channel" defaultValue={selected?.channel || "whatsapp"}><option value="whatsapp">WhatsApp</option><option value="instagram">Instagram</option><option value="email">E-mail</option><option value="internal">Interno</option></select></label><label>Categoria<input name="category" maxLength={100} defaultValue={selected?.category || ""} placeholder="Visita, proposta, pós-venda…" /></label></div><label>Texto<textarea name="body" required maxLength={4096} defaultValue={selected?.body || ""} /></label><small>Variáveis opcionais: {"{{nome}}"}, {"{{empreendimento}}"}. Preencha e revise antes de enviar.</small><label><span><input type="checkbox" name="active" defaultChecked={selected?.active ?? true} /> Disponível para a equipe</span></label><div className={styles.row}><button type="submit" className="primary" disabled={busy}>{busy ? "Salvando…" : "Salvar resposta"}</button><button type="button" disabled={busy} onClick={() => setEditing(null)}>Cancelar</button></div></form>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}{error && <p className={styles.error} role="alert">{error}</p>}
    <div className={styles.cards}>{rows.map(item => <article className={styles.card} key={item.id}><span className={styles.badge}>{item.channel} · {item.active ? "Disponível" : "Pausada"}</span><h3>{item.name}</h3><small>{item.category || "Geral"}</small><p className={styles.body}>{item.body}</p><div className={styles.row}><button onClick={() => void copy(item.body)}>Copiar texto</button>{canManage && <button onClick={() => { setEditing(item); setError(""); }}>Editar</button>}</div></article>)}</div>
    {!rows.length && <p className={styles.empty}>Nenhuma resposta encontrada. Cadastre os textos que a equipe utiliza com frequência.</p>}
  </section>;
}
