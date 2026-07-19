"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";
import type { ErpData, ViewId } from "./types";
import { canAdmin, initials, roleLabels } from "./utils";
import { DashboardView, CashView } from "./views-dashboard";
import { FinanceView } from "./views-finance";
import { MastersView } from "./views-masters";
import { AdminView } from "./views-admin";
import { ProcurementView } from "./operations/procurement-view";
import { HrView } from "./hr/hr-view";
import { DocumentManager } from "./documents/document-manager";
import { CrmView } from "./crm/crm-view";
import { loadOperationalData } from "./operational-data";

const nav: Array<{ id: ViewId; label: string; icon: string; group: string }> = [
  { id: "dashboard", label: "Visão executiva", icon: "⌂", group: "Gestão" },
  { id: "crm", label: "CRM comercial", icon: "◈", group: "Gestão" },
  { id: "financeiro", label: "Financeiro", icon: "≡", group: "Gestão" },
  { id: "caixa", label: "Fluxo de caixa", icon: "▤", group: "Gestão" },
  { id: "aprovacoes", label: "Aprovações", icon: "✓", group: "Gestão" },
  { id: "compras", label: "Compras e serviços", icon: "▣", group: "Operações" },
  { id: "rh", label: "Gestão de RH", icon: "♧", group: "Operações" },
  { id: "documentos", label: "Documentos", icon: "▧", group: "Operações" },
  { id: "centros", label: "Centros de custos e recebíveis", icon: "◫", group: "Cadastros" },
  { id: "cadastros", label: "Cadastros gerais", icon: "◎", group: "Cadastros" },
  { id: "projetos", label: "Empreendimentos", icon: "◇", group: "Cadastros" },
  { id: "usuarios", label: "Usuários e acessos", icon: "♙", group: "Administração" },
  { id: "relatorios", label: "Relatórios", icon: "▥", group: "Administração" },
  { id: "auditoria", label: "Auditoria", icon: "◉", group: "Administração" },
  { id: "configuracoes", label: "Configurações", icon: "⚙", group: "Administração" },
];

export default function ErpApp({ initialView = "dashboard" }: { initialView?: ViewId }) {
  const [session, setSession] = useState<Session | null>(null);
  const [ready, setReady] = useState(false);
  const [data, setData] = useState<ErpData | null>(null);
  const [view, setView] = useState<ViewId>(initialView);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) { setReady(true); return; }
    supabase.auth.getSession().then(({ data: auth }) => { setSession(auth.session); setReady(true); });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, next) => setSession(next));
    return () => listener.subscription.unsubscribe();
  }, []);

  const refresh = useCallback(async (currentSession = session) => {
    const supabase = getSupabase();
    if (!supabase || !currentSession?.user) return;
    setLoading(true);
    try {
      const { data: membership, error: membershipError } = await supabase.from("organization_members").select("*").eq("user_id", currentSession.user.id).eq("active", true).limit(1).maybeSingle();
      if (membershipError) throw membershipError;
      if (!membership) throw new Error("Seu usuário ainda não está vinculado a uma organização. Solicite acesso à diretoria.");
      const orgId = membership.organization_id;
      const [org, profile, entries, centers, categories, accounts, contacts, projects, members, profiles, invitations, approvals, audit, settings, operational] = await Promise.all([
        supabase.from("organizations").select("*").eq("id", orgId).single(),
        supabase.from("profiles").select("*").eq("id", currentSession.user.id).maybeSingle(),
        supabase.from("financial_entries").select("*").eq("organization_id", orgId).order("due_date", { ascending: true }),
        supabase.from("cost_centers").select("*").eq("organization_id", orgId).order("code"),
        supabase.from("financial_categories").select("*").eq("organization_id", orgId).order("code"),
        supabase.from("bank_accounts").select("*").eq("organization_id", orgId).order("name"),
        supabase.from("contacts").select("*").eq("organization_id", orgId).order("name"),
        supabase.from("projects").select("*").eq("organization_id", orgId).order("name"),
        supabase.from("organization_members").select("*").eq("organization_id", orgId).order("created_at"),
        supabase.from("profiles").select("*"),
        supabase.from("user_invitations").select("*").eq("organization_id", orgId).order("created_at", { ascending: false }),
        supabase.from("approval_requests").select("*").eq("organization_id", orgId).order("created_at", { ascending: false }),
        supabase.from("audit_logs").select("*").eq("organization_id", orgId).order("created_at", { ascending: false }).limit(500),
        supabase.from("system_settings").select("*").eq("organization_id", orgId).maybeSingle(),
        loadOperationalData(orgId),
      ]);
      const failed = [org, profile, entries, centers, categories, accounts, contacts, projects, members, profiles, invitations, approvals, settings].find(result => result.error);
      if (failed?.error) throw failed.error;
      setData({ session: currentSession, organization: org.data, membership, profile: profile.data, entries: entries.data ?? [], costCenters: centers.data ?? [], categories: categories.data ?? [], bankAccounts: accounts.data ?? [], contacts: contacts.data ?? [], projects: projects.data ?? [], members: members.data ?? [], profiles: profiles.data ?? [], invitations: invitations.data ?? [], approvals: approvals.data ?? [], auditLogs: audit.error ? [] : (audit.data ?? []), settings: settings.data ?? { organization_id: orgId, approval_threshold: 10000, require_approval: true, default_due_alert_days: 7, minimum_cash_buffer: 0, forecast_horizon_days: 365, procurement_approval_required: true, salary_payment_day: 5, default_employer_charge_rate: 0, termination_reserve_rate: 0.4, document_max_size_mb: 20 }, ...operational });
    } catch (error) {
      const message = error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String((error as { message?: unknown }).message || "") : "";
      setNotice(message || "Não foi possível carregar o ERP.");
    } finally { setLoading(false); }
  }, [session]);

  useEffect(() => { if (session) refresh(session); else setData(null); }, [session, refresh]);

  const mutate = async (operation: () => Promise<void>, success: string) => {
    setLoading(true); setNotice("");
    try { await operation(); setNotice(success); await refresh(); }
    catch (error) {
      const message = error instanceof Error ? error.message : typeof error === "object" && error && "message" in error ? String((error as { message?: unknown }).message || "") : "";
      setNotice(message || "A operação não foi concluída.");
    } finally { setLoading(false); }
  };

  if (!ready) return <Splash />;
  if (!session) return <Auth />;
  if (!data) return <Splash message={notice || "Preparando ambiente executivo..."} />;

  const userName = data.profile?.full_name || session.user.user_metadata?.full_name || session.user.email || "Usuário";
  const permittedNav = nav.filter(item => {
    if (["usuarios", "auditoria", "configuracoes", "rh"].includes(item.id)) return canAdmin(data.membership.role);
    if (item.id === "crm") return ["admin", "diretoria", "financeiro", "comercial"].includes(data.membership.role);
    if (item.id === "compras") return ["admin", "diretoria", "financeiro", "compras", "engenharia"].includes(data.membership.role);
    if (item.id === "documentos") return ["admin", "diretoria", "financeiro", "compras", "engenharia"].includes(data.membership.role);
    return true;
  });
  const title = nav.find(item => item.id === view)?.label ?? "Évora Gestão";

  return <div className="erp-shell"><aside className="erp-sidebar"><Brand /><div className="org-pill"><span>AMBIENTE</span><strong>{data.organization.trade_name || data.organization.name}</strong></div>{[...new Set(permittedNav.map(item => item.group))].map(group => <div className="nav-group" key={group}><small>{group}</small>{permittedNav.filter(item => item.group === group).map(item => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><b>{item.icon}</b><span>{item.label}</span></button>)}</div>)}<div className="sidebar-user"><span>{initials(userName)}</span><div><strong>{userName}</strong><small>{roleLabels[data.membership.role]}</small></div></div></aside><main className="erp-main"><header className="erp-header"><div><small>ÉVORA URBANISMO · ERP</small><h1>{title}</h1></div><div className="header-actions"><button className="icon-button" onClick={() => refresh()} title="Atualizar">↻</button><button className="primary" onClick={() => setView("financeiro")}>+ Novo lançamento</button></div></header>{notice && <button className="notice" onClick={() => setNotice("")}>{notice}<span>×</span></button>}{loading && <div className="progress"><i /></div>}<section className="erp-content">{view === "dashboard" && <DashboardView data={data} go={setView} />}{view === "crm" && <CrmView data={data} mutate={mutate} />}{view === "caixa" && <CashView data={data} />}{view === "financeiro" && <FinanceView data={data} mutate={mutate} />}{view === "compras" && <ProcurementView data={data} mutate={mutate} />}{view === "rh" && <HrView data={data} mutate={mutate} />}{view === "documentos" && <DocumentManager data={data} mutate={mutate} />}{view === "centros" && <MastersView mode="centros" data={data} mutate={mutate} />}{view === "cadastros" && <MastersView mode="cadastros" data={data} mutate={mutate} />}{view === "projetos" && <MastersView mode="projetos" data={data} mutate={mutate} />}{["aprovacoes", "usuarios", "relatorios", "auditoria", "configuracoes"].includes(view) && <AdminView mode={view} data={data} mutate={mutate} />}</section></main><nav className="mobile-nav">{permittedNav.slice(0, 5).map(item => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => setView(item.id)}><b>{item.icon}</b><small>{item.label.split(" ")[0]}</small></button>)}</nav></div>;
}

function Splash({ message = "Carregando Évora Gestão..." }: { message?: string }) { return <div className="splash"><Brand /><div className="spinner" /><p>{message}</p></div>; }
function Brand() { return <div className="brand"><i><span /><span /><span /></i><div><strong>Évora Gestão</strong><small>ERP IMOBILIÁRIO</small></div></div>; }
function Auth() { const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); async function submit(event: FormEvent<HTMLFormElement>) { event.preventDefault(); setBusy(true); setMessage(""); const form = new FormData(event.currentTarget); const supabase = getSupabase(); if (!supabase) { setMessage("Configuração do Supabase não encontrada."); setBusy(false); return; } const { error } = await supabase.auth.signInWithPassword({ email: String(form.get("email")), password: String(form.get("password")) }); setBusy(false); if (error) setMessage(error.message); } return <div className="auth-page"><section><Brand /><div><small>PLATAFORMA CORPORATIVA</small><h1>Gestão integrada para decisões de alto impacto.</h1><p>Financeiro, CRM, compras, RH, documentos, empreendimentos, aprovações e governança em uma única plataforma.</p></div></section><form onSubmit={submit}><small>ACESSO SEGURO</small><h2>Bem-vindo</h2><p>Entre com seu usuário autorizado.</p><label>E-mail<input name="email" type="email" autoComplete="email" required /></label><label>Senha<input name="password" type="password" autoComplete="current-password" required /></label>{message && <div className="feedback">{message}</div>}<button className="primary" disabled={busy}>{busy ? "Autenticando..." : "Entrar no ERP"}</button></form></div>; }
