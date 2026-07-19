"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { demoEntries } from "@/lib/demo-data";
import { getSupabase, hasSupabaseConfig } from "@/lib/supabase";
import type { AppView, EntryStatus, EntryType, FinancialEntry, Profile } from "@/lib/types";

const money = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
const dateFmt = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric" });
const views: { id: AppView; label: string; icon: string }[] = [
  { id: "inicio", label: "Início", icon: "⌂" },
  { id: "lancamentos", label: "Lançamentos", icon: "≡" },
  { id: "caixa", label: "Caixa", icon: "▤" },
  { id: "alertas", label: "Alertas", icon: "◉" },
  { id: "mais", label: "Mais", icon: "•••" },
];

const asDate = (value: string) => new Date(`${value}T12:00:00`);
const daysUntil = (value: string) => {
  const now = new Date(); now.setHours(12, 0, 0, 0);
  return Math.ceil((asDate(value).getTime() - now.getTime()) / 86400000);
};
const settled = (entry: FinancialEntry) => entry.status === "pago" || entry.status === "recebido";

export default function Home() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [entries, setEntries] = useState<FinancialEntry[]>([]);
  const [view, setView] = useState<AppView>("inicio");
  const [modal, setModal] = useState(false);
  const [notice, setNotice] = useState("");

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) {
      queueMicrotask(() => {
        const saved = localStorage.getItem("evora-demo-entries");
        setEntries(saved ? JSON.parse(saved) : demoEntries);
        setReady(true);
      });
      return;
    }
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setReady(true); });
    const { data } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => data.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session?.user) return;
    const supabase = getSupabase();
    if (!supabase) return;
    Promise.all([
      supabase.from("profiles").select("*").eq("id", session.user.id).maybeSingle(),
      supabase.from("financial_entries").select("*").order("due_date"),
    ]).then(([p, e]) => {
      if (e.error) setNotice(e.error.message);
      else setEntries((e.data ?? []) as FinancialEntry[]);
      setProfile((p.data as Profile | null) ?? null);
    });
  }, [session]);

  const persist = (next: FinancialEntry[]) => {
    setEntries(next);
    if (!hasSupabaseConfig) localStorage.setItem("evora-demo-entries", JSON.stringify(next));
  };

  async function addEntry(payload: Omit<FinancialEntry, "id" | "user_id" | "created_at" | "updated_at">) {
    const supabase = getSupabase();
    if (!supabase || !session?.user) {
      const now = new Date().toISOString();
      persist([...entries, { ...payload, id: crypto.randomUUID(), user_id: "demo-user", created_at: now, updated_at: now }]);
      setNotice("Lançamento incluído no modo demonstração.");
      return;
    }
    const { data, error } = await supabase.from("financial_entries").insert({ ...payload, user_id: session.user.id }).select().single();
    if (error) throw error;
    persist([...entries, data as FinancialEntry].sort((a, b) => a.due_date.localeCompare(b.due_date)));
    setNotice("Lançamento salvo no Supabase.");
  }

  async function conclude(entry: FinancialEntry) {
    const status: EntryStatus = entry.type === "entrada" ? "recebido" : "pago";
    const supabase = getSupabase();
    if (supabase && session?.user) {
      const { error } = await supabase.from("financial_entries").update({ status }).eq("id", entry.id);
      if (error) return setNotice(error.message);
    }
    persist(entries.map((item) => item.id === entry.id ? { ...item, status } : item));
  }

  async function remove(entry: FinancialEntry) {
    if (!confirm(`Excluir “${entry.description}”?`)) return;
    const supabase = getSupabase();
    if (supabase && session?.user) {
      const { error } = await supabase.from("financial_entries").delete().eq("id", entry.id);
      if (error) return setNotice(error.message);
    }
    persist(entries.filter((item) => item.id !== entry.id));
  }

  if (!ready) return <div className="center"><Brand /><div className="loader" /></div>;
  if (hasSupabaseConfig && !session) return <Auth />;

  const name = profile?.full_name || session?.user?.user_metadata?.full_name || "Franco Alves";
  return <div className="app">
    <aside className="sidebar"><Brand />
      <nav>{views.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><b>{item.icon}</b>{item.label}</button>)}</nav>
      <div className="user"><span>{initials(name)}</span><div><strong>{name}</strong><small>{profile?.role || "Administrador"}</small></div></div>
    </aside>
    <main>
      <header><div><small>Évora Urbanismo</small><h1>{views.find((item) => item.id === view)?.label}</h1></div><button className="primary" onClick={() => setModal(true)}>+ Novo lançamento</button></header>
      {!hasSupabaseConfig && <div className="demo"><strong>Modo demonstração</strong> Dados ficam salvos neste aparelho até a conexão com o Supabase.</div>}
      {notice && <button className="notice" onClick={() => setNotice("")}>{notice}<span>×</span></button>}
      <section className="content">
        {view === "inicio" && <Dashboard entries={entries} name={name} navigate={setView} create={() => setModal(true)} />}
        {view === "lancamentos" && <Entries entries={entries} conclude={conclude} remove={remove} />}
        {view === "caixa" && <Cash entries={entries} />}
        {view === "alertas" && <Alerts entries={entries} />}
        {view === "mais" && <More entries={entries} name={name} role={profile?.role || "Administrador"} signOut={() => getSupabase()?.auth.signOut()} />}
      </section>
    </main>
    <nav className="mobile-nav">{views.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><b>{item.icon}</b><small>{item.label}</small></button>)}</nav>
    {modal && <EntryModal save={addEntry} close={() => setModal(false)} />}
  </div>;
}

function Brand() { return <div className="brand"><i><span /><span /><span /></i><div><strong>Évora Gestão</strong><small>VERSÃO MÓBILE</small></div></div>; }
function initials(name: string) { return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase(); }

function Auth() {
  const [signup, setSignup] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage("");
    const form = new FormData(event.currentTarget), email = String(form.get("email")), password = String(form.get("password")), fullName = String(form.get("name") || "");
    const supabase = getSupabase(); if (!supabase) return;
    const result = signup ? await supabase.auth.signUp({ email, password, options: { data: { full_name: fullName } } }) : await supabase.auth.signInWithPassword({ email, password });
    setBusy(false); if (result.error) setMessage(result.error.message); else if (signup && !result.data.session) setMessage("Cadastro realizado. Confirme o e-mail para entrar.");
  }
  return <div className="auth"><section><Brand /><div><small>INTELIGÊNCIA FINANCEIRA IMOBILIÁRIA</small><h1>Controle para decidir. Visão para crescer.</h1><p>Fluxo de caixa, vencimentos e gestão executiva em uma experiência segura para desktop e smartphone.</p></div></section><form onSubmit={submit}><small>ACESSO SEGURO</small><h2>{signup ? "Criar conta" : "Bem-vindo"}</h2><p>{signup ? "Cadastre o primeiro usuário autorizado." : "Entre para acessar o ambiente da Évora."}</p>{signup && <label>Nome completo<input name="name" required /></label>}<label>E-mail<input type="email" name="email" required /></label><label>Senha<input type="password" name="password" minLength={8} required /></label>{message && <div className="feedback">{message}</div>}<button className="primary" disabled={busy}>{busy ? "Processando..." : signup ? "Cadastrar" : "Entrar"}</button><button type="button" className="link" onClick={() => setSignup(!signup)}>{signup ? "Já possuo acesso" : "Criar primeiro acesso"}</button></form></div>;
}

function Dashboard({ entries, name, navigate, create }: { entries: FinancialEntry[]; name: string; navigate: (v: AppView) => void; create: () => void }) {
  const received = total(entries, "entrada", true), paid = total(entries, "saida", true), pendingIn = total(entries, "entrada", false), pendingOut = total(entries, "saida", false);
  const next = [...entries].filter((e) => !settled(e)).sort((a, b) => a.due_date.localeCompare(b.due_date)).slice(0, 5);
  return <div className="grid"><section className="hero"><small>Bom dia, {name.split(" ")[0]}</small><h2>Posição financeira consolidada</h2><strong>{money.format(received - paid)}</strong><p>Saldo realizado com base nos lançamentos liquidados.</p><button onClick={() => navigate("caixa")}>Ver projeção →</button></section><section className="metrics"><Card label="A receber" value={money.format(pendingIn)} tone="green" /><Card label="A pagar" value={money.format(pendingOut)} tone="red" /><Card label="Resultado projetado" value={money.format(pendingIn - pendingOut)} tone="gold" /><Card label="Movimentos" value={String(entries.length)} /></section><section className="panel span"><div className="panel-title"><div><small>PRÓXIMOS MOVIMENTOS</small><h3>Agenda financeira</h3></div><button onClick={() => navigate("lancamentos")}>Ver todos</button></div>{next.map((e) => <EntryLine key={e.id} entry={e} />)}{!next.length && <Empty />}</section><section className="panel quick"><div className="panel-title"><div><small>ATALHOS</small><h3>Ações rápidas</h3></div></div><button onClick={create}>＋<span>Novo lançamento</span></button><button onClick={() => navigate("alertas")}>◷<span>Revisar alertas</span></button><button onClick={() => navigate("mais")}>⇩<span>Exportar dados</span></button></section></div>;
}

function total(entries: FinancialEntry[], type: EntryType, isDone: boolean) { return entries.filter((e) => e.type === type && settled(e) === isDone).reduce((sum, e) => sum + Number(e.amount), 0); }
function Card({ label, value, tone = "" }: { label: string; value: string; tone?: string }) { return <article className={`card ${tone}`}><small>{label}</small><strong>{value}</strong></article>; }
function EntryLine({ entry, actions }: { entry: FinancialEntry; actions?: React.ReactNode }) { return <article className="entry"><i className={entry.type}>{entry.type === "entrada" ? "↓" : "↑"}</i><div><strong>{entry.description}</strong><small>{entry.category} · {dateFmt.format(asDate(entry.due_date))}</small></div><span className={entry.type}>{entry.type === "saida" ? "−" : "+"}{money.format(Number(entry.amount))}</span>{actions}</article>; }

function Entries({ entries, conclude, remove }: { entries: FinancialEntry[]; conclude: (e: FinancialEntry) => void; remove: (e: FinancialEntry) => void }) {
  const [filter, setFilter] = useState<"todos" | EntryType>("todos"), [query, setQuery] = useState("");
  const list = entries.filter((e) => (filter === "todos" || e.type === filter) && `${e.description} ${e.category}`.toLowerCase().includes(query.toLowerCase())).sort((a, b) => a.due_date.localeCompare(b.due_date));
  return <section className="panel wide"><div className="toolbar"><input placeholder="Buscar lançamentos" value={query} onChange={(e) => setQuery(e.target.value)} /><div>{(["todos", "saida", "entrada"] as const).map((f) => <button key={f} className={filter === f ? "active" : ""} onClick={() => setFilter(f)}>{f === "todos" ? "Todos" : f === "saida" ? "A pagar" : "A receber"}</button>)}</div></div><div className="entry-list">{list.map((e) => <EntryLine key={e.id} entry={e} actions={<div className="entry-actions">{!settled(e) && <button onClick={() => conclude(e)}>Liquidar</button>}<button onClick={() => remove(e)}>Excluir</button></div>} />)}{!list.length && <Empty />}</div></section>;
}

function Cash({ entries }: { entries: FinancialEntry[] }) {
  const [period, setPeriod] = useState(30);
  const relevant = entries.filter((e) => !settled(e) && daysUntil(e.due_date) <= period), incoming = relevant.filter((e) => e.type === "entrada").reduce((s, e) => s + Number(e.amount), 0), outgoing = relevant.filter((e) => e.type === "saida").reduce((s, e) => s + Number(e.amount), 0), max = Math.max(incoming, outgoing, 1);
  return <div className="grid"><section className="cash-head"><div><small>FLUXO PROJETADO EM {period} DIAS</small><strong>{money.format(incoming - outgoing)}</strong><p>Resultado entre entradas e saídas pendentes.</p></div><div>{[7, 30, 90].map((p) => <button key={p} className={p === period ? "active" : ""} onClick={() => setPeriod(p)}>{p} dias</button>)}</div></section><section className="metrics"><Card label="Entradas previstas" value={money.format(incoming)} tone="green" /><Card label="Saídas previstas" value={money.format(outgoing)} tone="red" /><Card label="Cobertura" value={outgoing ? `${Math.round(incoming / outgoing * 100)}%` : "—"} tone="gold" /></section><section className="panel span chart"><div className="panel-title"><div><small>COMPARATIVO</small><h3>Entradas versus saídas</h3></div></div><div><label>Entradas<strong>{money.format(incoming)}</strong></label><span><i className="in" style={{ width: `${incoming / max * 100}%` }} /></span><label>Saídas<strong>{money.format(outgoing)}</strong></label><span><i className="out" style={{ width: `${outgoing / max * 100}%` }} /></span></div></section></div>;
}

function Alerts({ entries }: { entries: FinancialEntry[] }) {
  const alerts = useMemo(() => entries.filter((e) => !settled(e) && daysUntil(e.due_date) <= 15).sort((a, b) => a.due_date.localeCompare(b.due_date)), [entries]);
  return <section className="panel wide"><div className="alert-summary"><strong>{alerts.filter((e) => daysUntil(e.due_date) <= 3).length}</strong><div><h2>alertas críticos</h2><p>Exigem atenção nos próximos 3 dias.</p></div></div>{alerts.map((e) => { const days = daysUntil(e.due_date); return <article className={`alert ${days < 0 ? "critical" : days <= 3 ? "warning" : "info"}`} key={e.id}><i>{days < 0 ? "!" : "◷"}</i><div><strong>{days < 0 ? "Vencido" : days === 0 ? "Vence hoje" : `Vence em ${days} dias`}</strong><span>{e.description}</span><small>{e.category} · {dateFmt.format(asDate(e.due_date))}</small></div><b>{money.format(Number(e.amount))}</b></article>; })}{!alerts.length && <Empty />}</section>;
}

function More({ entries, name, role, signOut }: { entries: FinancialEntry[]; name: string; role: string; signOut: () => void }) {
  function csv() { const lines = ["tipo,descricao,categoria,valor,vencimento,status", ...entries.map((e) => [e.type, `"${e.description.replaceAll('"', '""')}"`, e.category, e.amount, e.due_date, e.status].join(","))]; const url = URL.createObjectURL(new Blob(["\ufeff" + lines.join("\n")], { type: "text/csv" })); const a = document.createElement("a"); a.href = url; a.download = "evora-gestao.csv"; a.click(); URL.revokeObjectURL(url); }
  return <div className="settings"><section className="profile"><span>{initials(name)}</span><div><small>USUÁRIO CONECTADO</small><h2>{name}</h2><p>{role}</p></div></section><section className="panel"><div className="panel-title"><div><small>RELATÓRIOS</small><h3>Exportação e administração</h3></div></div><button className="setting" onClick={csv}><b>CSV</b><span><strong>Exportar lançamentos</strong><small>Arquivo compatível com Excel</small></span>›</button><button className="setting" onClick={() => window.print()}><b>PDF</b><span><strong>Relatório executivo</strong><small>Imprimir ou salvar em PDF</small></span>›</button><div className="setting"><b>PWA</b><span><strong>Instalar no smartphone</strong><small>Safari → Compartilhar → Adicionar à Tela de Início</small></span></div></section>{hasSupabaseConfig && <button className="logout" onClick={signOut}>Sair da conta</button>}<p className="version">Évora Gestão v1.0 · Next.js + Supabase · Desktop e smartphone</p></div>;
}

function EntryModal({ save, close }: { save: (p: Omit<FinancialEntry, "id" | "user_id" | "created_at" | "updated_at">) => Promise<void>; close: () => void }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); const f = new FormData(event.currentTarget); try { await save({ type: f.get("type") as EntryType, description: String(f.get("description")), category: String(f.get("category")), amount: Number(f.get("amount")), due_date: String(f.get("due_date")), status: "pendente", notes: String(f.get("notes") || "") || null }); close(); } catch (e) { setError(e instanceof Error ? e.message : "Não foi possível salvar."); setBusy(false); } }
  return <div className="backdrop" onMouseDown={close}><form className="modal" onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}><div className="panel-title"><div><small>NOVO MOVIMENTO</small><h2>Adicionar lançamento</h2></div><button type="button" onClick={close}>×</button></div><div className="form-grid"><label>Tipo<select name="type"><option value="saida">Conta a pagar</option><option value="entrada">Conta a receber</option></select></label><label>Vencimento<input name="due_date" type="date" required defaultValue={new Date().toISOString().slice(0, 10)} /></label><label className="full">Descrição<input name="description" required /></label><label>Categoria<input name="category" required /></label><label>Valor<input name="amount" type="number" min="0.01" step="0.01" required /></label><label className="full">Observações<textarea name="notes" rows={3} /></label></div>{error && <div className="feedback">{error}</div>}<footer><button type="button" onClick={close}>Cancelar</button><button className="primary" disabled={busy}>{busy ? "Salvando..." : "Salvar lançamento"}</button></footer></form></div>;
}
function Empty() { return <div className="empty"><b>◇</b><strong>Nenhum lançamento encontrado</strong><p>Inclua um novo movimento ou altere os filtros.</p></div>; }
