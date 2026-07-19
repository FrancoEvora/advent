"use client";

import { getSupabase } from "@/lib/supabase";
import type { ErpData } from "../types";
import type { CrmEnterpriseData } from "./types";
import { CrmSectionHeader, Status } from "./shared";

export function SettingsView({ data, crm, reload }: { data: ErpData; crm: CrmEnterpriseData; reload: () => Promise<void> }) {
  const providers = ["whatsapp", "meta", "site_forms", "email", "google_calendar", "maps", "webhook"];
  async function save(provider: string, status: string) {
    const client = getSupabase(); if (!client) return;
    const result = await client.from("crm_integrations").upsert({ organization_id: data.organization.id, provider, display_name: providerLabel(provider), status, updated_at: new Date().toISOString() }, { onConflict: "organization_id,provider" });
    if (result.error) throw result.error; await reload();
  }
  return <div className="crm5-stack">
    <CrmSectionHeader eyebrow="CONFIGURAÇÃO" title="Parâmetros e integrações" description="Canais de entrada, comunicação, SLAs, distribuição e governança do CRM." />
    <section className="crm5-panel crm5-version"><img src="/evora-brand.svg" alt="Évora Urbanismo" /><div><small>PLATAFORMA PROPRIETÁRIA</small><h3>Évora Gestão CRM</h3><strong>Versão 5.0 Enterprise</strong><p>© 2026 Évora Urbanismo. Uso interno e titularidade exclusiva da Évora Urbanismo.</p></div></section>
    <section className="crm5-integrations">{providers.map((provider) => { const current = crm.integrations.find((item) => item.provider === provider); return <article key={provider}><div className="crm5-integration-icon">{providerIcon(provider)}</div><div><strong>{providerLabel(provider)}</strong><small>{current?.last_sync_at ? `Sincronizado em ${new Date(current.last_sync_at).toLocaleString("pt-BR")}` : "Credenciais externas necessárias"}</small></div><Status tone={current?.status === "conectado" ? "success" : "neutral"}>{current?.status || "não configurado"}</Status><button onClick={() => save(provider, current?.status === "conectado" ? "desconectado" : "configuracao_pendente")}>Configurar</button></article>; })}</section>
    <section className="crm5-panel"><header><div><small>POLÍTICAS</small><h3>Parâmetros operacionais recomendados</h3></div></header><div className="crm5-policy-grid"><article><strong>1 hora</strong><span>SLA de primeiro atendimento</span></article><article><strong>24 horas</strong><span>Alerta de lead sem contato</span></article><article><strong>3 tentativas</strong><span>Cadência inicial mínima</span></article><article><strong>48 horas</strong><span>Alerta de estagnação por etapa</span></article><article><strong>Score 70</strong><span>Classificação de lead quente</span></article><article><strong>Round robin</strong><span>Distribuição padrão para SDR</span></article></div></section>
  </div>;
}

const providerLabel = (value: string) => ({ whatsapp: "WhatsApp Business", meta: "Meta Leads — Facebook e Instagram", site_forms: "Formulários do site", email: "E-mail corporativo", google_calendar: "Google Calendar", maps: "Mapa de lotes / Google Maps", webhook: "Webhooks e API" } as Record<string, string>)[value] || value;
const providerIcon = (value: string) => ({ whatsapp: "◉", meta: "∞", site_forms: "⌘", email: "✉", google_calendar: "▦", maps: "⌖", webhook: "↔" } as Record<string, string>)[value] || "◇";
