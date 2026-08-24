"use client";

import { useCallback, useEffect, useState } from "react";

import { getSupabase } from "@/lib/supabase";

import type { ErpData } from "../types";
import type { PostSaleData } from "./types";
import { contractContext } from "./utils";

type Token = {
  id: string;
  contract_id: string;
  token: string;
  active: boolean;
  expires_at: string;
  last_access_at: string | null;
  created_at: string;
};

type PortalAccessLog = {
  contract_id: string;
};

function expirationInDays(days: number) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);
  return expiresAt.toISOString();
}

export function PortalLinks({ data, ps }: { data: ErpData; ps: PostSaleData }) {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [logs, setLogs] = useState<PortalAccessLog[]>([]);
  const [message, setMessage] = useState("");

  const organizationId = data.organization.id;
  const userId = data.session.user.id;

  const load = useCallback(async () => {
    const supabase = getSupabase();
    if (!supabase) return;

    const [tokenResult, logResult] = await Promise.all([
      supabase
        .from("post_sale_portal_tokens")
        .select("*")
        .eq("organization_id", organizationId)
        .order("created_at", { ascending: false }),
      supabase
        .from("post_sale_portal_access_logs")
        .select("contract_id")
        .eq("organization_id", organizationId)
        .order("accessed_at", { ascending: false })
        .limit(200),
    ]);

    if (tokenResult.error || logResult.error) {
      setMessage(
        tokenResult.error?.message ||
          logResult.error?.message ||
          "Não foi possível atualizar os links do portal.",
      );
      return;
    }

    setTokens((tokenResult.data || []) as Token[]);
    setLogs((logResult.data || []) as PortalAccessLog[]);
  }, [organizationId]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  async function createLink(contractId: string) {
    const supabase = getSupabase();
    if (!supabase) return;

    await supabase
      .from("post_sale_portal_tokens")
      .update({ active: false })
      .eq("contract_id", contractId)
      .eq("active", true);

    const result = await supabase
      .from("post_sale_portal_tokens")
      .insert({
        organization_id: organizationId,
        contract_id: contractId,
        created_by: userId,
        expires_at: expirationInDays(30),
      })
      .select("token")
      .single();

    if (result.error) {
      setMessage(result.error.message);
      return;
    }

    await navigator.clipboard.writeText(
      `${location.origin}/cliente/${result.data.token}`,
    );
    setMessage("Novo link copiado. Validade: 30 dias.");
    await load();
  }

  async function revoke(id: string) {
    const supabase = getSupabase();
    if (!supabase) return;

    const result = await supabase
      .from("post_sale_portal_tokens")
      .update({ active: false })
      .eq("id", id);

    setMessage(result.error ? result.error.message : "Acesso revogado.");
    if (!result.error) await load();
  }

  const signed = ps.contracts.filter((contract) => contract.status === "assinado");

  return (
    <section className="post-sale-panel">
      <header>
        <div>
          <small>ACESSOS INDIVIDUAIS</small>
          <h3>Links por contrato</h3>
        </div>
      </header>

      {message && (
        <button
          type="button"
          className="notice"
          aria-label={`${message} Fechar aviso`}
          onClick={() => setMessage("")}
        >
          {message}
        </button>
      )}

      <div className="portal-token-list">
        {signed.map((contract) => {
          const context = contractContext(data, ps, contract.id);
          const token = tokens.find(
            (item) =>
              item.contract_id === contract.id &&
              item.active &&
              new Date(item.expires_at) > new Date(),
          );
          const accesses = logs.filter(
            (log) => log.contract_id === contract.id,
          ).length;

          return (
            <article key={contract.id}>
              <div>
                <strong>{context.proposal?.customer_name}</strong>
                <small>
                  {contract.contract_number} · {context.project?.name} ·{" "}
                  {context.unit?.unit_code}
                </small>
              </div>
              <span>
                {token
                  ? `Ativo até ${new Date(token.expires_at).toLocaleDateString("pt-BR")}`
                  : "Sem link ativo"}
                <small>
                  {accesses} acesso(s)
                  {token?.last_access_at
                    ? ` · último ${new Date(token.last_access_at).toLocaleDateString("pt-BR")}`
                    : ""}
                </small>
              </span>
              <div>
                <button type="button" onClick={() => void createLink(contract.id)}>
                  {token ? "Renovar link" : "Gerar link"}
                </button>
                {token && (
                  <button
                    type="button"
                    onClick={() =>
                      void navigator.clipboard.writeText(
                        `${location.origin}/cliente/${token.token}`,
                      )
                    }
                  >
                    Copiar
                  </button>
                )}
                {token && (
                  <button
                    type="button"
                    onClick={() =>
                      window.open(
                        `/cliente/${token.token}`,
                        "_blank",
                        "noopener,noreferrer",
                      )
                    }
                  >
                    Abrir
                  </button>
                )}
                {token && (
                  <button
                    type="button"
                    className="danger-button"
                    onClick={() => void revoke(token.id)}
                  >
                    Revogar
                  </button>
                )}
              </div>
            </article>
          );
        })}
        {!signed.length && <p>Nenhum contrato assinado disponível.</p>}
      </div>
    </section>
  );
}
