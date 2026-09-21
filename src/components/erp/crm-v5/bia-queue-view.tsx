"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { CrmRecord, ErpData } from "../types";
import type { CrmEnterpriseData } from "./types";
import { CrmKpi, CrmSectionHeader, EmptyState, Status } from "./shared";
import styles from "./bia-queue-view.module.css";

type QueueStatus = "staged" | "dispatched" | "cancelled";

type QueueItem = {
  id: string;
  crmRecordId: string;
  name: string;
  phone: string | null;
  projectId: string | null;
  projectName: string | null;
  source: string;
  temperature: string | null;
  score: number;
  status: QueueStatus;
  lastError: string | null;
  recommendedSettingsId: string | null;
  dispatchedSettingsId: string | null;
  campaignId: string | null;
  queuedAt: string;
  dispatchedAt: string | null;
};

type QueueSetting = {
  id: string;
  projectId: string;
  templateName: string;
  name: string;
  openingIntent: string | null;
  enabled: boolean;
};

type QueueOverview = {
  channel: { enabled?: boolean; verified?: boolean; phone?: string | null };
  settings: QueueSetting[];
  counts: {
    staged: number;
    dispatched: number;
    cancelled: number;
    alerts: number;
  };
  items: QueueItem[];
};

const reasonLabels: Record<string, string> = {
  BIA_TEMPLATE_PROJECT_MISMATCH:
    "A mensagem escolhida não pertence ao empreendimento deste lead.",
  BIA_BULK_CONSENT_REQUIRED:
    "Não há opt-in de WhatsApp documentado para esta abordagem.",
  BIA_CAMPAIGN_ALREADY_CONTACTED:
    "A Bia já possui conversa anterior com este contato.",
  BIA_CONTACT_PAUSED:
    "O contato está pausado, bloqueado ou pediu atendimento humano.",
  BIA_PHONE_INVALID: "Telefone inválido para WhatsApp.",
  BIA_CAMPAIGN_DISABLED:
    "Não há configuração ativa para este empreendimento.",
  BIA_CAMPAIGN_LEAD_INACTIVE:
    "O lead deixou de estar elegível para esta abordagem.",
};

function normalize(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleString("pt-BR")
    : "—";
}

export function BiaQueueView({
  data,
  crm,
  openLead,
}: {
  data: ErpData;
  crm: CrmEnterpriseData;
  openLead: (lead: CrmRecord) => void;
}) {
  const [overview, setOverview] = useState<QueueOverview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [settingsId, setSettingsId] = useState("");
  const [status, setStatus] = useState<"staged" | "all">("staged");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const rpc = useCallback(
    async (action: string, args: Record<string, unknown> = {}) => {
      const client = getSupabase();
      if (!client) throw new Error("Supabase indisponível.");
      const result = await client.rpc("bia_strategy_queue_admin", {
        p_organization_id: data.organization.id,
        p_action: action,
        p_args: args,
      });
      if (result.error) throw new Error(result.error.message);
      return result.data as unknown;
    },
    [data.organization.id],
  );

  const load = useCallback(async () => {
    try {
      const value = (await rpc("overview")) as QueueOverview;
      setOverview(value);
      setSettingsId((current) => {
        if (current && value.settings.some((item) => item.id === current))
          return current;
        return value.settings[0]?.id || "";
      });
      setSelected((current) => {
        const staged = new Set(
          value.items
            .filter((item) => item.status === "staged")
            .map((item) => item.id),
        );
        return new Set([...current].filter((id) => staged.has(id)));
      });
      setError("");
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível carregar a fila da Bia.",
      );
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = normalize(query);
    return (overview?.items || []).filter((item) => {
      if (status === "staged" && item.status !== "staged") return false;
      if (!needle) return true;
      return normalize(
        [
          item.name,
          item.phone || "",
          item.projectName || "",
          item.source,
          item.temperature || "",
          reasonLabels[item.lastError || ""] || item.lastError || "",
        ].join(" "),
      ).includes(needle);
    });
  }, [overview?.items, query, status]);

  const stagedVisible = visible.filter((item) => item.status === "staged");
  const allVisibleSelected =
    stagedVisible.length > 0 &&
    stagedVisible.every((item) => selected.has(item.id));
  const selectedCount = selected.size;
  const selectedSetting =
    overview?.settings.find((item) => item.id === settingsId) || null;
  const channelReady =
    overview?.channel.enabled === true && overview?.channel.verified === true;

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleAllVisible() {
    setSelected((current) => {
      const next = new Set(current);
      if (allVisibleSelected) {
        for (const item of stagedVisible) next.delete(item.id);
      } else {
        for (const item of stagedVisible) next.add(item.id);
      }
      return next;
    });
  }

  async function fire() {
    if (!selectedCount || !settingsId || !selectedSetting) return;
    if (
      !window.confirm(
        `Disparar a mensagem inicial “${selectedSetting.name}” para ${selectedCount} lead${selectedCount === 1 ? "" : "s"} selecionado${selectedCount === 1 ? "" : "s"}?`,
      )
    )
      return;

    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = (await rpc("fire", {
        settingsId,
        queueIds: [...selected],
      })) as {
        ok?: boolean;
        eligible?: number;
        blocked?: number;
        reason?: string;
        campaignId?: string;
      };
      if (!result.ok) {
        throw new Error(
          result.reason === "BIA_QUEUE_NO_ELIGIBLE_RECIPIENTS"
            ? "Nenhum dos leads selecionados está elegível para esta mensagem inicial."
            : result.reason || "Não foi possível disparar a fila.",
        );
      }
      setNotice(
        `Disparo iniciado para ${Number(result.eligible || 0)} lead${Number(result.eligible || 0) === 1 ? "" : "s"}. ${Number(result.blocked || 0)} ficaram fora do envio por guardrails do WhatsApp.`,
      );
      setSelected(new Set());
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível iniciar o disparo.",
      );
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function cancelSelected() {
    if (!selectedCount) return;
    if (!window.confirm(`Remover ${selectedCount} lead(s) da fila de disparo?`))
      return;
    setBusy(true);
    setError("");
    try {
      await rpc("cancel", { queueIds: [...selected] });
      setSelected(new Set());
      setNotice("Leads removidos da fila de disparo.");
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível remover os leads da fila.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="crm5-stack">
      <CrmSectionHeader
        eyebrow="BIA · WHATSAPP"
        title="Fila da Bia"
        description="Revise os leads colocados em fila, escolha a mensagem inicial aprovada e só então autorize o disparo."
        actions={
          <button onClick={() => void load()} disabled={busy}>
            ↻ Atualizar
          </button>
        }
      />

      {notice && (
        <button className="notice" onClick={() => setNotice("")}>
          {notice}
          <span>×</span>
        </button>
      )}
      {error && <div className="feedback error">{error}</div>}

      <section className="crm5-kpis four">
        <CrmKpi
          label="Em fila"
          value={overview?.counts.staged ?? "—"}
          detail="Aguardando seleção e disparo"
          tone="blue"
        />
        <CrmKpi
          label="Selecionados"
          value={selectedCount}
          detail="Serão avaliados no disparo"
          tone="green"
        />
        <CrmKpi
          label="Disparados"
          value={overview?.counts.dispatched ?? "—"}
          detail="Já encaminhados ao worker da Bia"
          tone="lime"
        />
        <CrmKpi
          label="Com alerta"
          value={overview?.counts.alerts ?? "—"}
          detail="Falharam em alguma validação recente"
          tone="orange"
        />
      </section>

      <section className="crm5-panel">
        <header>
          <div>
            <small>CONTROLE DE DISPARO</small>
            <h3>Mensagem inicial</h3>
          </div>
          <Status tone={channelReady ? "success" : "warning"}>
            {channelReady ? "WhatsApp pronto" : "Canal indisponível"}
          </Status>
        </header>

        <div className={styles.dispatchBox}>
          <label>
            Mensagem / modelo inicial
            <select
              value={settingsId}
              onChange={(event) => setSettingsId(event.target.value)}
            >
              <option value="">Selecione</option>
              {(overview?.settings || []).map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>
          <div className={styles.messagePreview}>
            <small>MODELO META</small>
            <strong>{selectedSetting?.name || "Nenhuma mensagem selecionada"}</strong>
            <span>
              {selectedSetting?.openingIntent ||
                "Selecione um modelo aprovado para ver a finalidade da abertura."}
            </span>
            {selectedSetting && (
              <code>{selectedSetting.templateName}</code>
            )}
          </div>
          <div className={styles.dispatchActions}>
            <button
              className="primary"
              disabled={busy || !channelReady || !settingsId || !selectedCount}
              onClick={() => void fire()}
            >
              {busy
                ? "Processando..."
                : selectedCount
                  ? `Disparar · ${selectedCount}`
                  : "Disparar"}
            </button>
            <small>
              O backend revalida consentimento, telefone, opt-out, duplicidade,
              empreendimento e template antes de cada inclusão na campanha.
            </small>
          </div>
        </div>
      </section>

      <section className="crm5-panel">
        <header>
          <div>
            <small>LEADS EM STAGING</small>
            <h3>Selecionar destinatários</h3>
          </div>
          <span>{visible.length} registros exibidos</span>
        </header>

        <div className={styles.toolbar}>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar nome, telefone, empreendimento ou origem..."
          />
          <select
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as "staged" | "all")
            }
          >
            <option value="staged">Somente em fila</option>
            <option value="all">Fila + histórico</option>
          </select>
          <button
            type="button"
            disabled={!stagedVisible.length}
            onClick={toggleAllVisible}
          >
            {allVisibleSelected ? "Desmarcar todos" : "Selecionar todos"}
          </button>
          <button
            type="button"
            disabled={busy || !selectedCount}
            onClick={() => void cancelSelected()}
          >
            Remover da fila
          </button>
        </div>

        {visible.length ? (
          <div className={styles.table}>
            <div className={styles.headerRow}>
              <span></span>
              <span>Lead</span>
              <span>Empreendimento</span>
              <span>Origem</span>
              <span>Score</span>
              <span>Status</span>
              <span></span>
            </div>
            {visible.map((item) => {
              const lead = crm.records.find(
                (record) => record.id === item.crmRecordId,
              );
              return (
                <div className={styles.row} key={item.id}>
                  <label className={styles.checkbox}>
                    <input
                      type="checkbox"
                      checked={selected.has(item.id)}
                      disabled={item.status !== "staged" || busy}
                      onChange={() => toggle(item.id)}
                      aria-label={`Selecionar ${item.name}`}
                    />
                  </label>
                  <div>
                    <strong>{item.name}</strong>
                    <small>
                      {item.phone || "Sem telefone"} ·{" "}
                      {item.temperature || "sem temperatura"}
                    </small>
                    {item.lastError && (
                      <em>
                        {reasonLabels[item.lastError] || item.lastError}
                      </em>
                    )}
                  </div>
                  <span>{item.projectName || "—"}</span>
                  <span>{item.source}</span>
                  <b>{Math.round(Number(item.score) || 0)}</b>
                  <div>
                    <Status
                      tone={
                        item.status === "staged"
                          ? item.lastError
                            ? "warning"
                            : "info"
                          : item.status === "dispatched"
                            ? "success"
                            : "neutral"
                      }
                    >
                      {item.status === "staged"
                        ? "Em fila"
                        : item.status === "dispatched"
                          ? "Disparado"
                          : "Removido"}
                    </Status>
                    <small>
                      {item.status === "dispatched"
                        ? formatDate(item.dispatchedAt)
                        : formatDate(item.queuedAt)}
                    </small>
                  </div>
                  <button
                    type="button"
                    disabled={!lead}
                    onClick={() => lead && openLead(lead)}
                  >
                    Abrir
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState
            title="Nenhum lead na fila"
            text={
              status === "staged"
                ? "Use a ação “Enviar para fila da Bia” na Estratégia IA para adicionar leads."
                : "Nenhum registro corresponde aos filtros atuais."
            }
          />
        )}
      </section>
    </div>
  );
}
