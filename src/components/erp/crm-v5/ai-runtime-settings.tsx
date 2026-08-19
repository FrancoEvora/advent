"use client";

import { useCallback, useEffect, useState } from "react";

import type { ErpData } from "../types";
import { Status } from "./shared";

type RuntimeStatus = {
  organization_id?: string;
  api_key?: {
    configured?: boolean;
    version?: number;
    configured_at?: string | null;
    updated_at?: string | null;
  };
  enabled?: boolean;
  mode?: string;
  agent_model?: string;
  agent_reasoning?: string;
  supervisor_model?: string;
  supervisor_reasoning?: string;
  ready?: boolean;
  updated_at?: string | null;
};

type ApiResponse = {
  ok?: boolean;
  runtime?: RuntimeStatus;
  error?: string;
};

const reasoningOptions = [
  ["low", "Baixo"],
  ["medium", "Médio"],
  ["high", "Alto"],
  ["xhigh", "Muito alto"],
] as const;

function errorMessage(code?: string) {
  const messages: Record<string, string> = {
    AI_RUNTIME_PERMISSION_REQUIRED: "Seu perfil não possui permissão para alterar a Bia.",
    INVALID_OPENAI_KEY: "A chave OpenAI informada não é válida.",
    AI_WORKER_RUNTIME_UNAVAILABLE: "O worker seguro da Bia ainda não está disponível.",
    AI_RUNTIME_CONFIG_FAILED: "A configuração não pôde ser salva. Revise a chave e tente novamente.",
    AI_RUNTIME_REVOKE_FAILED: "A chave não pôde ser revogada.",
  };
  return messages[code || ""] || "Não foi possível concluir a operação da Bia.";
}

export function AiRuntimeSettings({
  data,
  canManage,
}: {
  data: ErpData;
  canManage: boolean;
}) {
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [agentReasoning, setAgentReasoning] = useState("medium");
  const [supervisorReasoning, setSupervisorReasoning] = useState("high");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const token = data.session.access_token;
  const organizationId = data.organization.id;

  const load = useCallback(async () => {
    if (!token || !organizationId || !canManage) return;
    try {
      const response = await fetch(
        `/api/ai/runtime?organizationId=${encodeURIComponent(organizationId)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        },
      );
      const payload = (await response.json()) as ApiResponse;
      if (!response.ok || !payload.runtime) throw new Error(payload.error || "AI_RUNTIME_STATUS_FAILED");
      setRuntime(payload.runtime);
      setAgentReasoning(payload.runtime.agent_reasoning || "medium");
      setSupervisorReasoning(payload.runtime.supervisor_reasoning || "high");
      setError(null);
    } catch (reason) {
      setError(errorMessage(reason instanceof Error ? reason.message : undefined));
    }
  }, [canManage, organizationId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  async function update(payload: Record<string, unknown>, success: string) {
    if (!token || !canManage) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch("/api/ai/runtime", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ organizationId, ...payload }),
      });
      const body = (await response.json()) as ApiResponse;
      if (!response.ok || !body.runtime) throw new Error(body.error || "AI_RUNTIME_CONFIG_FAILED");
      setRuntime(body.runtime);
      setApiKey("");
      setMessage(success);
    } catch (reason) {
      setError(errorMessage(reason instanceof Error ? reason.message : undefined));
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings() {
    if (!apiKey && !runtime?.api_key?.configured) {
      setError("Informe uma chave OpenAI antes de salvar a configuração inicial.");
      return;
    }
    await update(
      {
        apiKey: apiKey || null,
        agentModel: "gpt-5.6-sol",
        agentReasoning,
        supervisorModel: "gpt-5.6-sol",
        supervisorReasoning,
      },
      apiKey ? "Chave e parâmetros da Bia salvos no Vault." : "Parâmetros da Bia atualizados.",
    );
  }

  async function toggleEnabled() {
    const next = !runtime?.enabled;
    if (next && !runtime?.api_key?.configured) {
      setError("Cadastre a chave OpenAI antes de ativar a Bia.");
      return;
    }
    await update(
      { enabled: next },
      next
        ? "Bia ativada para atendimento com IA."
        : "Bia desativada. Novos atendimentos não serão processados pela IA.",
    );
  }

  async function revoke() {
    if (!token || !canManage || !runtime?.api_key?.configured) return;
    if (!window.confirm("Revogar a chave OpenAI e desativar a Bia?")) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/ai/runtime?organizationId=${encodeURIComponent(organizationId)}`,
        { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
      );
      const body = (await response.json()) as ApiResponse;
      if (!response.ok || !body.runtime) throw new Error(body.error || "AI_RUNTIME_REVOKE_FAILED");
      setRuntime(body.runtime);
      setApiKey("");
      setMessage("Chave OpenAI revogada e Bia desativada.");
    } catch (reason) {
      setError(errorMessage(reason instanceof Error ? reason.message : undefined));
    } finally {
      setBusy(false);
    }
  }

  if (!canManage) return null;

  const configured = runtime?.api_key?.configured === true;
  const enabled = runtime?.enabled === true;

  return (
    <section className="crm5-panel" id="ai-runtime-setup">
      <header>
        <div>
          <small>INTELIGÊNCIA COMERCIAL</small>
          <h3>Bia · Agente Comercial IA</h3>
          <p>
            Atendimento com IA integrado ao CRM. A Bia conversa diretamente com o cliente e consulta
            o ERP por ferramentas controladas quando precisa de dados ou executar uma ação.
          </p>
        </div>
        <Status tone={enabled ? "success" : configured ? "info" : "neutral"}>
          {enabled ? "Bia ativa" : configured ? "configurada" : "não configurada"}
        </Status>
      </header>

      <div className="crm5-policy-grid">
        <article>
          <strong>{configured ? "Protegida no Vault" : "Não cadastrada"}</strong>
          <span>Chave OpenAI · nunca exibida após salvar</span>
        </article>
        <article>
          <strong>GPT-5.6 Sol</strong>
          <span>Modelo da Bia</span>
        </article>
        <article>
          <strong>{agentReasoning === "high" ? "Alto" : agentReasoning === "low" ? "Baixo" : agentReasoning === "xhigh" ? "Muito alto" : "Médio"}</strong>
          <span>Raciocínio do agente</span>
        </article>
        <article>
          <strong>{supervisorReasoning === "xhigh" ? "Muito alto" : supervisorReasoning === "medium" ? "Médio" : supervisorReasoning === "low" ? "Baixo" : "Alto"}</strong>
          <span>Supervisor de Excelência</span>
        </article>
      </div>

      <div className="crm5-form-grid">
        <label>
          <span>{configured ? "Nova chave OpenAI (somente para rotacionar)" : "Chave OpenAI"}</span>
          <input
            type="password"
            autoComplete="new-password"
            value={apiKey}
            disabled={busy}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={configured ? "Deixe em branco para manter a chave atual" : "Cole a chave da API OpenAI"}
          />
        </label>
        <label>
          <span>Raciocínio da Bia</span>
          <select value={agentReasoning} disabled={busy} onChange={(event) => setAgentReasoning(event.target.value)}>
            {reasoningOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>
          <span>Raciocínio do Supervisor</span>
          <select value={supervisorReasoning} disabled={busy} onChange={(event) => setSupervisorReasoning(event.target.value)}>
            {reasoningOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
      </div>

      <div className="crm5-actions">
        <button className="primary" disabled={busy} onClick={saveSettings}>
          {busy ? "Salvando..." : configured ? "Salvar parâmetros" : "Salvar chave no Vault"}
        </button>
        <button disabled={busy || !configured} onClick={toggleEnabled}>
          {enabled ? "Desativar Bia" : "Ativar Bia"}
        </button>
        <button disabled={busy || !configured} onClick={revoke}>
          Revogar chave
        </button>
      </div>

      {message && <p className="crm5-callout success">{message}</p>}
      {error && <p className="crm5-callout danger">{error}</p>}
      <p className="crm5-muted">
        Dados operacionais como preço, estoque, simulações, visitas e bloqueios continuam sujeitos
        às validações e ferramentas controladas do ERP.
      </p>
    </section>
  );
}
