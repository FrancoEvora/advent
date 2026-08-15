"use client";

import Image from "next/image";
import { getSupabase } from "@/lib/supabase";
import type { ErpData } from "../types";
import type { CrmEnterpriseData } from "./types";
import { AiRuntimeSettings } from "./ai-runtime-settings";
import { VitoriaKnowledgeSettings } from "./vitoria-knowledge-settings";
import { CrmSectionHeader, Status } from "./shared";
import { MetaCampaignControlSettings } from "./meta-campaign-control-settings";
import { WhatsAppRuntimeSettings } from "./whatsapp-runtime-settings";

export function SettingsView({ data, crm, reload, can = () => false }: { data: ErpData; crm: CrmEnterpriseData; reload: () => Promise<void>; can?: (permission: string) => boolean }) {
  const providers = ["whatsapp", "meta", "site_forms", "email", "google_calendar", "maps", "webhook"];
  const canManage = can("crm.integrations.manage");
  async function save(provider: string, status: string) {
    if (!canManage || provider === "meta" || provider === "whatsapp") return;
    const client = getSupabase(); if (!client) return;
    const result = await client.from("crm_integrations").upsert({ organization_id: data.organization.id, provider, display_name: providerLabel(provider), status, updated_at: new Date().toISOString() }, { onConflict: "organization_id,provider" });
    if (result.error) throw result.error; await reload();
  }
  return <div className="crm5-stack">
    <CrmSectionHeader eyebrow="CONFIGURAÇÃO" title="Parâmetros e integrações" description="Canais de entrada, comunicação, SLAs, distribuição, inteligência comercial e governança do CRM. A conexão Meta usa exatamente o mesmo processo do Évora Campaign Control." />
    <section className="crm5-panel crm5-version"><Image src="/evora-brand.svg" alt="Évora Urbanismo" width={310} height={90} /><div><small>PLATAFORMA PROPRIETÁRIA</small><h3>Évora Gestão CRM</h3><strong>Versão 5.0 Enterprise</strong><p>© 2026 Évora Urbanismo. Uso interno e titularidade exclusiva da Évora Urbanismo.</p></div></section>
    <section className="crm5-integrations">{providers.map((provider) => {
      const current = crm.integrations.find((item) => item.provider === provider);
      const metaActive = provider === "meta" && crm.metaLeadRoutes.some((item) => item.active);
      const status = provider === "meta" ? (metaActive ? "conectado" : crm.metaLeadRoutes.length ? "configuração pendente" : "não configurado") : current?.status || "não configurado";
      const description = provider === "meta"
        ? "Mesmo conector do Campaign Control · ativos Meta + formulários + leads → CRM"
        : provider === "whatsapp"
          ? "WhatsApp Business Platform · Cloud API · Vitória + Supervisor"
          : current?.last_sync_at ? `Sincronizado em ${new Date(current.last_sync_at).toLocaleString("pt-BR")}` : "Credenciais externas necessárias";
      return <article key={provider}><div className="crm5-integration-icon">{providerIcon(provider)}</div><div><strong>{providerLabel(provider)}</strong><small>{description}</small></div><Status tone={provider === "meta" && metaActive ? "success" : status === "conectado" ? "success" : "neutral"}>{status}</Status><button disabled={!canManage} onClick={() => provider === "meta" ? document.getElementById("meta-campaign-control-setup")?.scrollIntoView({ behavior: "smooth", block: "start" }) : provider === "whatsapp" ? document.getElementById("whatsapp-cloud-setup")?.scrollIntoView({ behavior: "smooth", block: "start" }) : save(provider, current?.status === "conectado" ? "desconectado" : "configuracao_pendente")}>{provider === "meta" ? "Configurar Meta Leads" : provider === "whatsapp" ? "Configurar WhatsApp" : "Configurar"}</button></article>;
    })}</section>
    <MetaCampaignControlSettings data={data} crm={crm} reload={reload} canManage={canManage} />
    <AiRuntimeSettings data={data} canManage={canManage} />
    <VitoriaKnowledgeSettings data={data} canManage={canManage} />
    <WhatsAppRuntimeSettings data={data} canManage={canManage} />
    <section className="crm5-panel"><header><div><small>POLÍTICAS</small><h3>Parâmetros operacionais recomendados</h3></div></header><div className="crm5-policy-grid"><article><strong>1 hora</strong><span>SLA de primeiro atendimento</span></article><article><strong>24 horas</strong><span>Alerta de lead sem contato</span></article><article><strong>3 tentativas</strong><span>Cadência inicial mínima</span></article><article><strong>48 horas</strong><span>Alerta de estagnação por etapa</span></article><article><strong>Score 70</strong><span>Classificação de lead quente</span></article><article><strong>Round robin</strong><span>Distribuição padrão para SDR</span></article></div></section>
  </div>;
}

const providerLabel = (value: string) => ({ whatsapp: "WhatsApp Business", meta: "Meta Leads — Facebook e Instagram", site_forms: "Formulários do site", email: "E-mail corporativo", google_calendar: "Google Calendar", maps: "Mapa de lotes / Google Maps", webhook: "Webhooks e API" } as Record<string, string>)[value] || value;
const providerIcon = (value: string) => ({ whatsapp: "◉", meta: "∞", site_forms: "⌘", email: "✉", google_calendar: "▦", maps: "⌖", webhook: "↔" } as Record<string, string>)[value] || "◇";
