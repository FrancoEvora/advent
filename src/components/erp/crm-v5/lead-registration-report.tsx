"use client";

import { useEffect, useRef, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import { buildLeadReport, downloadLeadWorkbook, EXPORT_PAGE_SIZE, readAllLeadPages, relatedSources, type ExportRow } from "@/lib/crm-lead-export";
import type { ErpData } from "../types";

export function LeadRegistrationReport({ data }: { data: ErpData }) {
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), [data.organization.id, data.session.user.id]);

  async function generate() {
    if (controller.current) return;
    const client = getSupabase();
    if (!client) { setError("Conexão com o Enterprise indisponível."); return; }
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true); setError(""); setStatus("Conferindo acesso à organização…");
    const generatedAt = new Date().toISOString();
    const orgId = data.organization.id;
    const userId = data.session.user.id;
    try {
      const auth = await client.auth.getUser();
      if (auth.error || auth.data.user?.id !== userId) throw new Error("Sua sessão expirou ou foi alterada. Entre novamente no Enterprise.");
      const membership = await client.from("organization_members").select("organization_id").eq("organization_id", orgId).eq("user_id", userId).eq("active", true).abortSignal(abort.signal).maybeSingle();
      if (membership.error || !membership.data) throw new Error("Não foi possível confirmar seu acesso à organização.");
      const records = await readAllLeadPages(async (after, first) => {
        let query = client.from("crm_records").select("*", first ? { count: "exact" } : {}).eq("organization_id", orgId).order("id", { ascending: true }).limit(EXPORT_PAGE_SIZE).abortSignal(abort.signal);
        if (after) query = query.gt("id", after);
        const result = await query;
        if (result.error) throw new Error(`Falha ao consultar os leads: ${result.error.message}`);
        return { rows: (result.data || []) as ExportRow[], total: result.count };
      }, (loaded, total) => setStatus(`Consultando todos os leads: ${loaded.toLocaleString("pt-BR")} de ${total.toLocaleString("pt-BR")}…`), abort.signal);
      if (!records.length) throw new Error("Nenhum lead foi retornado para sua organização e suas permissões. Nenhum arquivo vazio foi gerado.");
      setStatus("Preparando dados cadastrais e contatos vinculados…");
      const readRelated = async (table: string, ids: string[], columns: string): Promise<ExportRow[]> => {
        const result: ExportRow[] = [];
        for (let index = 0; index < ids.length; index += 100) {
          abort.signal.throwIfAborted();
          let query = client.from(table).select(columns).in("id", ids.slice(index, index + 100)).limit(100).abortSignal(abort.signal);
          if (table !== "profiles") query = query.eq("organization_id", orgId);
          const page = await query;
          if (page.error) throw new Error(`${table}: ${page.error.message}`);
          result.push(...(page.data || []) as unknown as ExportRow[]);
        }
        return result;
      };
      const idsFor = (field: string) => [...new Set(records.map(row => row[field]).filter((id): id is string => typeof id === "string" && !!id))];
      const warnings: string[] = [];
      const contactIds = idsFor("contact_id");
      const contacts = await readRelated("contacts", contactIds, "*");
      if (contacts.length !== contactIds.length) warnings.push(`${contactIds.length - contacts.length} contato(s) vinculado(s) não acessível(is) ou não encontrado(s). Os IDs estão preservados na aba Leads.`);
      const resolved: Record<string, Record<string, string>> = {};
      await Promise.all(relatedSources.map(async source => {
        const ids = idsFor(source.field);
        if (!ids.length) return;
        try {
          const rows = await readRelated(source.table, ids, `id,${source.nameField}`);
          resolved[source.field] = Object.fromEntries(rows.map(row => [String(row.id), String(row[source.nameField] || row.id)]));
          if (rows.length < ids.length) warnings.push(`${source.label}: ${ids.length - rows.length} nome(s) relacionado(s) não acessível(is); IDs mantidos.`);
        } catch {
          abort.signal.throwIfAborted();
          warnings.push(`Nomes de ${source.label.toLowerCase()} indisponíveis. Os IDs originais foram mantidos.`);
        }
      }));
      abort.signal.throwIfAborted();
      const latestAuth = await client.auth.getUser();
      if (latestAuth.error || latestAuth.data.user?.id !== userId) throw new Error("A sessão foi alterada durante a consulta. Gere o relatório novamente.");
      const finalCount = await client.from("crm_records").select("id", { count: "exact", head: true }).eq("organization_id", orgId).abortSignal(abort.signal);
      if (finalCount.error || finalCount.count !== records.length) throw new Error("A base mudou durante a consulta ou o total não pôde ser conferido. Gere o relatório novamente.");
      const sheets = buildLeadReport(records, contacts, resolved, { organization: data.organization.name, generatedAt, sourceUrl: `${window.location.origin}/crm/relatorios`, warnings });
      setStatus("Gerando arquivo Excel…");
      abort.signal.throwIfAborted();
      const filename = await downloadLeadWorkbook(sheets, generatedAt, abort.signal);
      setStatus(`${records.length.toLocaleString("pt-BR")} leads exportados. Arquivo: ${filename}${warnings.length ? " Consulte os avisos na aba Resumo." : ""}`);
    } catch (cause) {
      if (abort.signal.aborted) { setStatus("Exportação cancelada. Nenhum cadastro foi alterado."); }
      else { setError(cause instanceof Error ? cause.message : "Não foi possível gerar o relatório. Tente novamente."); setStatus(""); }
    } finally { controller.current = null; setBusy(false); }
  }

  return <section aria-labelledby="lead-registration-report-title" style={{ padding: "20px 24px", marginBottom: 20, border: "1px solid #cadbd5", borderRadius: 14, background: "#f4f9f6" }}>
    <div style={{ display: "flex", justifyContent: "space-between", gap: 20, alignItems: "center", flexWrap: "wrap" }}>
      <div style={{ flex: "1 1 340px" }}>
        <h2 id="lead-registration-report-title" style={{ margin: "0 0 8px", fontSize: 20 }}>Relatório de leads cadastrados</h2>
        <p style={{ margin: 0, lineHeight: 1.6 }}>Todos os leads da organização, incluindo arquivados, com dados cadastrais, contatos, empreendimento, origem e situação comercial. A exportação não usa os filtros nem o limite de registros da tela.</p>
      </div>
      <button className="primary" type="button" disabled={busy} onClick={() => void generate()} style={{ padding: "12px 18px", minHeight: 44, whiteSpace: "nowrap" }}>{busy ? "Gerando relatório…" : "Baixar todos os leads (.xlsx)"}</button>
      {busy && <button type="button" onClick={() => controller.current?.abort()}>Cancelar</button>}
    </div>
    <p style={{ fontSize: 12, margin: "12px 0 0", opacity: 0.8 }}>Uso interno · Dados atualizados na geração · Acesso limitado às permissões da sua sessão · Nenhum cadastro é alterado.</p>
    {status && <p role="status" aria-live="polite" style={{ marginBottom: 0 }}>{status}</p>}
    {error && <p role="alert" style={{ color: "#a42525", marginBottom: 0 }}>{error}</p>}
  </section>;
}
