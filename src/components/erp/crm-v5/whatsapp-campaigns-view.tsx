"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

import { getSupabase } from "@/lib/supabase";
import type { ErpData } from "../types";
import { CrmKpi, CrmSectionHeader, EmptyState, Status } from "./shared";

type OutreachSetting = {
  id: string;
  projectId: string;
  templateName: string;
  name: string;
  enabled: boolean;
};

type BulkCampaign = {
  id: string;
  name: string;
  status: "scheduled" | "running" | "paused" | "completed" | "cancelled";
  startsAt: string;
  pacePerMinute: number;
  total: number;
  eligible: number;
  blocked: number;
  sent: number;
  delivered: number;
  read: number;
  replied: number;
  failed: number;
  pending: number;
  skipped: number;
  createdAt: string;
};

type Overview = {
  channel: { enabled?: boolean; verified?: boolean };
  settings: OutreachSetting[];
  campaigns: BulkCampaign[];
};

type Preview = {
  total: number;
  eligible: number;
  blocked: number;
  reasons: Record<string, number>;
};

const reasonLabels: Record<string, string> = {
  ELIGIBLE: "Elegíveis",
  BIA_BULK_CONSENT_REQUIRED: "Sem opt-in de WhatsApp documentado",
  BIA_BULK_DUPLICATE_PHONE: "Telefone duplicado na base",
  BIA_PHONE_INVALID: "Telefone inválido",
  BIA_CONTACT_PAUSED: "Contato pausado ou bloqueado",
  BIA_CAMPAIGN_ALREADY_CONTACTED: "Já atendido pela Bia",
  BIA_CAMPAIGN_DISABLED: "Campanha de origem desabilitada",
  BIA_CAMPAIGN_LEAD_INACTIVE: "Lead inativo",
};

const statusLabels: Record<BulkCampaign["status"], string> = {
  scheduled: "Agendada",
  running: "Em andamento",
  paused: "Pausada",
  completed: "Concluída",
  cancelled: "Cancelada",
};

function statusTone(status: BulkCampaign["status"]) {
  if (status === "completed") return "success" as const;
  if (status === "running") return "info" as const;
  if (status === "cancelled") return "neutral" as const;
  if (status === "paused") return "warning" as const;
  return "blue" as const;
}

function defaultStart() {
  const date = new Date(Date.now() + 30 * 60 * 1000);
  date.setSeconds(0, 0);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function friendlyError(message: string) {
  if (message.includes("BIA_BULK_NO_ELIGIBLE_RECIPIENTS")) return "Nenhum lead possui autorização de WhatsApp documentada para esta campanha.";
  if (message.includes("BIA_BULK_SCOPE_TOO_LARGE")) return "O público ultrapassa o limite de 1.000 registros. Refine o público antes de agendar.";
  if (message.includes("BIA_BULK_SETTINGS_REQUIRED")) return "Selecione uma configuração de campanha válida.";
  if (message.includes("BIA_BULK_START_INVALID")) return "Escolha uma data e hora válidas, entre agora e os próximos 90 dias.";
  if (message.includes("BIA_BULK_FORBIDDEN")) return "Seu perfil não possui permissão para administrar disparos da Bia.";
  return message || "Não foi possível concluir a operação.";
}

export function WhatsAppCampaignsView({
  data,
  can,
}: {
  data: ErpData;
  can: (permission: string) => boolean;
}) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [settingsId, setSettingsId] = useState("");
  const [startsAt, setStartsAt] = useState(defaultStart);
  const [pace, setPace] = useState(3);
  const [name, setName] = useState("Recuperação de leads sem atendimento");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const allowed = data.membership.role === "admin" || can("crm.manage");

  const rpc = useCallback(
    async (action: string, args: Record<string, unknown> = {}) => {
      const client = getSupabase();
      if (!client) throw new Error("Supabase indisponível.");
      const result = await client.rpc("bia_bulk_campaign_admin", {
        p_organization_id: data.organization.id,
        p_action: action,
        p_args: args,
      });
      if (result.error) throw new Error(result.error.message);
      return result.data as unknown;
    },
    [data.organization.id],
  );

  const loadOverview = useCallback(async () => {
    if (!allowed) return;
    try {
      const value = (await rpc("overview")) as Overview;
      setOverview(value);
      setSettingsId((current) => current || value.settings.find((item) => item.enabled)?.id || "");
      setError("");
    } catch (caught) {
      setError(friendlyError(caught instanceof Error ? caught.message : ""));
    }
  }, [allowed, rpc]);

  const loadPreview = useCallback(async () => {
    if (!allowed || !settingsId) {
      setPreview(null);
      return;
    }
    try {
      const value = (await rpc("preview", {
        settingsId,
        onlyUnserved: true,
      })) as Preview;
      setPreview(value);
      setError("");
    } catch (caught) {
      setPreview(null);
      setError(friendlyError(caught instanceof Error ? caught.message : ""));
    }
  }, [allowed, rpc, settingsId]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    void loadPreview();
  }, [loadPreview]);

  const selected = useMemo(
    () => overview?.settings.find((item) => item.id === settingsId) || null,
    [overview?.settings, settingsId],
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!preview?.eligible || !settingsId) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = (await rpc("create", {
        settingsId,
        name,
        startsAt: new Date(startsAt).toISOString(),
        pacePerMinute: pace,
        onlyUnserved: true,
      })) as { eligible?: number; blocked?: number };
      setNotice(
        `Campanha agendada com ${Number(result.eligible || 0)} destinatários elegíveis; ${Number(result.blocked || 0)} registros ficaram bloqueados.`,
      );
      await loadOverview();
      await loadPreview();
    } catch (caught) {
      setError(friendlyError(caught instanceof Error ? caught.message : ""));
    } finally {
      setBusy(false);
    }
  }

  async function changeCampaign(id: string, action: "pause" | "resume" | "cancel") {
    if (action === "cancel" && !window.confirm("Cancelar os envios ainda pendentes desta campanha?")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await rpc(action, { id });
      setNotice(action === "pause" ? "Campanha pausada." : action === "resume" ? "Campanha retomada." : "Campanha cancelada.");
      await loadOverview();
    } catch (caught) {
      setError(friendlyError(caught instanceof Error ? caught.message : ""));
    } finally {
      setBusy(false);
    }
  }

  if (!allowed) {
    return (
      <div className="crm5-stack">
        <CrmSectionHeader
          eyebrow="BIA · WHATSAPP"
          title="Campanhas de WhatsApp"
          description="Agendamento e acompanhamento de reativação de leads."
        />
        <div className="feedback error">Seu perfil não possui permissão para administrar campanhas de WhatsApp.</div>
      </div>
    );
  }

  const channelReady = overview?.channel.enabled === true && overview?.channel.verified === true;

  return (
    <div className="crm5-stack">
      <CrmSectionHeader
        eyebrow="BIA · WHATSAPP BUSINESS"
        title="Campanhas de WhatsApp"
        description="Reative leads sem atendimento usando o mesmo número e a mesma infraestrutura da Bia, com consentimento, deduplicação e fila controlada."
        actions={<button onClick={() => void Promise.all([loadOverview(), loadPreview()])}>↻ Atualizar</button>}
      />

      {notice && <button className="notice" onClick={() => setNotice("")}>{notice}<span>×</span></button>}
      {error && <div className="feedback error">{error}</div>}

      <section className="crm5-kpis four">
        <CrmKpi label="Leads sem ação" value={preview?.total ?? "—"} detail="Abertos no empreendimento" tone="blue" />
        <CrmKpi label="Elegíveis" value={preview?.eligible ?? "—"} detail="Com opt-in válido e telefone único" tone="green" />
        <CrmKpi label="Bloqueados" value={preview?.blocked ?? "—"} detail="Não entram na fila" tone="orange" />
        <CrmKpi label="Canal da Bia" value={channelReady ? "Ativo" : "Atenção"} detail={channelReady ? "Webhook verificado" : "Revise a integração"} tone={channelReady ? "lime" : "orange"} />
      </section>

      <section className="crm5-campaign-grid">
        <article>
          <header>
            <Status tone={channelReady ? "success" : "warning"}>{channelReady ? "canal pronto" : "canal indisponível"}</Status>
            <span>PRÉVIA DO PÚBLICO</span>
          </header>
          <h3>Elegibilidade antes de qualquer envio</h3>
          <p>O sistema considera somente oportunidades abertas sem ação registrada e exige evidência de autorização para contato pelo WhatsApp.</p>
          <dl>
            {Object.entries(preview?.reasons || {}).sort((a, b) => b[1] - a[1]).map(([reason, count]) => (
              <div key={reason}><dt>{reasonLabels[reason] || reason}</dt><dd>{count}</dd></div>
            ))}
          </dl>
        </article>

        <article>
          <header>
            <Status tone={selected ? "info" : "warning"}>{selected ? "configurado" : "sem template"}</Status>
            <span>MODELO META</span>
          </header>
          <h3>{selected?.name || "Selecione a campanha"}</h3>
          <p>{selected ? `Template: ${selected.templateName}` : "Nenhuma configuração de abertura automática está disponível."}</p>
          <label>
            Configuração
            <select value={settingsId} onChange={(event) => setSettingsId(event.target.value)}>
              <option value="">Selecione</option>
              {(overview?.settings || []).filter((item) => item.enabled).map((item) => (
                <option key={item.id} value={item.id}>{item.name} · {item.templateName}</option>
              ))}
            </select>
          </label>
        </article>
      </section>

      <section className="crm5-campaign-grid">
        <article>
          <header><Status tone="info">agendamento</Status><span>NOVA CAMPANHA</span></header>
          <h3>Programar reativação</h3>
          <form onSubmit={submit}>
            <div className="form-grid">
              <label className="span-2">Nome da campanha<input value={name} onChange={(event) => setName(event.target.value)} required minLength={3} maxLength={120} /></label>
              <label>Início<input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} required /></label>
              <label>Ritmo por minuto<select value={pace} onChange={(event) => setPace(Number(event.target.value))}><option value={1}>1 lead/min</option><option value={2}>2 leads/min</option><option value={3}>3 leads/min</option></select></label>
              <label className="span-2"><input type="checkbox" checked readOnly /> Somente leads abertos sem ação registrada</label>
            </div>
            <p>Leads duplicados, contatos pausados, números inválidos, pessoas já atendidas pela Bia e registros sem opt-in válido são excluídos automaticamente.</p>
            <footer>
              <button type="button" disabled={busy} onClick={() => void loadPreview()}>Recalcular público</button>
              <button className="primary" disabled={busy || !channelReady || !preview?.eligible || !settingsId}>
                {busy ? "Processando..." : preview?.eligible ? `Agendar ${preview.eligible} envios` : "Sem leads elegíveis"}
              </button>
            </footer>
          </form>
        </article>
      </section>

      <CrmSectionHeader
        eyebrow="ACOMPANHAMENTO"
        title="Campanhas programadas"
        description="Status consolidados de envio, entrega, leitura e resposta. Uma resposta passa imediatamente para a conversa normal da Bia."
      />
      <section className="crm5-campaign-grid">
        {(overview?.campaigns || []).map((campaign) => (
          <article key={campaign.id}>
            <header>
              <Status tone={statusTone(campaign.status)}>{statusLabels[campaign.status]}</Status>
              <span>{new Date(campaign.startsAt).toLocaleString("pt-BR")}</span>
            </header>
            <h3>{campaign.name}</h3>
            <p>{campaign.pacePerMinute} por minuto · {campaign.eligible} elegíveis · {campaign.blocked} bloqueados</p>
            <dl>
              <div><dt>Enviados</dt><dd>{campaign.sent}</dd></div>
              <div><dt>Entregues</dt><dd>{campaign.delivered}</dd></div>
              <div><dt>Lidos</dt><dd>{campaign.read}</dd></div>
              <div><dt>Responderam</dt><dd>{campaign.replied}</dd></div>
              <div><dt>Pendentes</dt><dd>{campaign.pending}</dd></div>
              <div><dt>Falhas</dt><dd>{campaign.failed}</dd></div>
            </dl>
            <footer>
              {(campaign.status === "scheduled" || campaign.status === "running") && <button disabled={busy} onClick={() => void changeCampaign(campaign.id, "pause")}>Pausar</button>}
              {campaign.status === "paused" && <button disabled={busy} onClick={() => void changeCampaign(campaign.id, "resume")}>Retomar</button>}
              {!["completed", "cancelled"].includes(campaign.status) && <button disabled={busy} onClick={() => void changeCampaign(campaign.id, "cancel")}>Cancelar</button>}
            </footer>
          </article>
        ))}
        {overview && !overview.campaigns.length && <EmptyState title="Nenhuma campanha programada" text="Faça a prévia de elegibilidade e programe o primeiro lote quando houver opt-ins válidos." />}
      </section>
    </div>
  );
}
