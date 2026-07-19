"use client";

import { useCallback, useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { getSupabase } from "@/lib/supabase";
import type { ErpData } from "../types";
import { CrmView } from "./crm-view";

export function CrmStandalone() {
  const [session, setSession] = useState<Session | null>(null);
  const [data, setData] = useState<ErpData | null>(null);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async (activeSession?: Session | null) => {
    const client = getSupabase(); const current = activeSession || session;
    if (!client || !current?.user) { setLoading(false); return; }
    setLoading(true);
    try {
      const membershipResult = await client.from("organization_members").select("*").eq("user_id", current.user.id).eq("active", true).limit(1).single();
      if (membershipResult.error) throw membershipResult.error;
      const membership = membershipResult.data; const orgId = membership.organization_id;
      const [organization, profile, contacts, projects, members, profiles, crmRecords, crmActions] = await Promise.all([
        client.from("organizations").select("*").eq("id", orgId).single(),
        client.from("profiles").select("*").eq("id", current.user.id).maybeSingle(),
        client.from("contacts").select("*").eq("organization_id", orgId).order("name"),
        client.from("projects").select("*").eq("organization_id", orgId).order("name"),
        client.from("organization_members").select("*").eq("organization_id", orgId),
        client.from("profiles").select("*"),
        client.from("crm_records").select("*").eq("organization_id", orgId).order("updated_at", { ascending: false }),
        client.from("crm_actions").select("*").eq("organization_id", orgId).order("scheduled_at", { ascending: true }),
      ]);
      const failed = [organization, profile, contacts, projects, members, profiles, crmRecords, crmActions].find(result => result.error);
      if (failed?.error) throw failed.error;
      setData({ session: current, organization: organization.data, membership, profile: profile.data, contacts: contacts.data ?? [], projects: projects.data ?? [], members: members.data ?? [], profiles: profiles.data ?? [], crmRecords: crmRecords.data ?? [], crmActions: crmActions.data ?? [], entries: [], costCenters: [], revenueCenters: [], categories: [], bankAccounts: [], invitations: [], approvals: [], auditLogs: [], documents: [], purchaseRequests: [], purchaseItems: [], hrEmployees: [], hrEvents: [], hrPayrollRuns: [], hrPayrollItems: [], settings: { organization_id: orgId, approval_threshold: 0, require_approval: false, default_due_alert_days: 7 } });
    } catch (error) { setNotice(error instanceof Error ? error.message : "Não foi possível abrir o CRM."); }
    finally { setLoading(false); }
  }, [session]);

  useEffect(() => {
    const client = getSupabase();
    if (!client) { setLoading(false); return; }
    client.auth.getSession().then(({ data: auth }) => { setSession(auth.session); refresh(auth.session); });
  }, [refresh]);

  const mutate = async (operation: () => Promise<void>, success: string) => {
    setNotice(""); setLoading(true);
    try { await operation(); setNotice(success); await refresh(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Operação não concluída."); }
    finally { setLoading(false); }
  };

  if (loading && !data) return <div className="crm-standalone-state"><strong>Carregando CRM Évora...</strong></div>;
  if (!session) return <div className="crm-standalone-state"><strong>Sessão não encontrada.</strong><a href="/">Voltar ao acesso do ERP</a></div>;
  if (!data) return <div className="crm-standalone-state"><strong>{notice || "CRM indisponível."}</strong><a href="/">Voltar ao ERP</a></div>;

  return <main className="crm-standalone"><header><div><small>ÉVORA URBANISMO · ERP</small><h1>CRM comercial</h1></div><a href="/">← Voltar ao ERP</a></header>{notice && <button className="notice" onClick={() => setNotice("")}>{notice}<span>×</span></button>}{loading && <div className="progress"><i /></div>}<CrmView data={data} mutate={mutate} /></main>;
}