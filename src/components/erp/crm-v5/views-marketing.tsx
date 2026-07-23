"use client";

import { FormEvent, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ErpData } from "../types";
import { money } from "../utils";
import type { CrmCampaign, CrmEnterpriseData } from "./types";
import type { NegotiationPolicy } from "./sales/types";
import { CrmKpi, CrmSectionHeader, EmptyState, Status } from "./shared";

export function CampaignsView({ data, crm, policies, reload }: { data: ErpData; crm: CrmEnterpriseData; policies: NegotiationPolicy[]; reload: () => Promise<void> }) {
  const [editing, setEditing] = useState<CrmCampaign | "new" | null>(null);
  const attributed = crm.records.filter((record) => record.campaign_id);
  const spent = crm.campaigns.reduce((sum, campaign) => sum + Number(campaign.spent || 0), 0);
  const sales = attributed.filter((record) => record.record_status === "ganha");

  return (
    <div className="crm5-stack">
      <CrmSectionHeader
        eyebrow="MARKETING E AQUISIÇÃO"
        title="Campanhas comerciais"
        description="Orçamento, canais, UTM, leads, custo por lead, conversão e receita atribuída."
        actions={<button className="primary" onClick={() => setEditing("new")}>+ Nova campanha</button>}
      />
      <section className="crm5-kpis four">
        <CrmKpi label="Investimento" value={money.format(spent)} detail="Gasto informado" tone="blue" />
        <CrmKpi label="Leads atribuídos" value={attributed.length} detail="Com campanha identificada" tone="lime" />
        <CrmKpi label="CPL médio" value={money.format(attributed.length ? spent / attributed.length : 0)} detail="Investimento / leads" tone="orange" />
        <CrmKpi label="Vendas atribuídas" value={sales.length} detail={money.format(sales.reduce((sum, item) => sum + Number(item.estimated_value || 0), 0))} tone="green" />
      </section>
      <section className="crm5-campaign-grid">
        {crm.campaigns.map((campaign) => {
          const leads = crm.records.filter((record) => record.campaign_id === campaign.id);
          const won = leads.filter((record) => record.record_status === "ganha");
          const cpl = leads.length ? Number(campaign.spent || 0) / leads.length : 0;
          const policy = policies.find((item) => item.id === campaign.negotiation_policy_id);
          return (
            <article key={campaign.id}>
              <header>
                <Status tone={campaign.status === "ativa" ? "success" : campaign.status === "encerrada" ? "neutral" : "info"}>{campaign.status}</Status>
                <span>{campaign.channel || campaign.campaign_type}</span>
              </header>
              <h3>{campaign.name}</h3>
              <p>{campaign.objective || "Objetivo não informado"}</p>
              <p className="campaign-policy-label"><small>POLÍTICA COMERCIAL</small><strong>{policy?.name || (campaign.project_id ? "Política padrão do empreendimento" : "Defina um empreendimento")}</strong></p>
              <dl>
                <div><dt>Orçamento</dt><dd>{money.format(Number(campaign.budget || 0))}</dd></div>
                <div><dt>Investido</dt><dd>{money.format(Number(campaign.spent || 0))}</dd></div>
                <div><dt>Leads</dt><dd>{leads.length}</dd></div>
                <div><dt>CPL</dt><dd>{money.format(cpl)}</dd></div>
                <div><dt>Vendas</dt><dd>{won.length}</dd></div>
                <div><dt>Receita</dt><dd>{money.format(won.reduce((sum, item) => sum + Number(item.estimated_value || 0), 0))}</dd></div>
              </dl>
              <footer><button onClick={() => setEditing(campaign)}>Editar campanha</button></footer>
            </article>
          );
        })}
        {!crm.campaigns.length && <EmptyState title="Nenhuma campanha" text="Cadastre campanhas para medir origem, CPL e conversão." />}
      </section>
      {editing && <CampaignModal data={data} policies={policies} campaign={editing === "new" ? null : editing} close={() => setEditing(null)} reload={reload} />}
    </div>
  );
}

function CampaignModal({ data, policies, campaign, close, reload }: { data: ErpData; policies: NegotiationPolicy[]; campaign: CrmCampaign | null; close: () => void; reload: () => Promise<void> }) {
  const [projectId, setProjectId] = useState(campaign?.project_id || "");
  const [policyId, setPolicyId] = useState(campaign?.negotiation_policy_id || "");
  const availablePolicies = policies.filter((item) => item.project_id === projectId && item.active);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const client = getSupabase();
    if (!client) throw new Error("Supabase indisponível.");
    const payload = {
      organization_id: data.organization.id,
      name: String(form.get("name")), campaign_type: String(form.get("campaign_type")), channel: String(form.get("channel") || "") || null,
      status: String(form.get("status")), project_id: String(form.get("project_id") || "") || null,
      negotiation_policy_id: projectId ? policyId || null : null,
      owner_user_id: String(form.get("owner_user_id") || "") || null,
      budget: Number(form.get("budget") || 0), spent: Number(form.get("spent") || 0),
      start_date: String(form.get("start_date") || "") || null, end_date: String(form.get("end_date") || "") || null,
      objective: String(form.get("objective") || "") || null, audience: String(form.get("audience") || "") || null,
      utm_source: String(form.get("utm_source") || "") || null, utm_medium: String(form.get("utm_medium") || "") || null,
      utm_campaign: String(form.get("utm_campaign") || "") || null, landing_page: String(form.get("landing_page") || "") || null,
      notes: String(form.get("notes") || "") || null, created_by: data.session.user.id, updated_at: new Date().toISOString(),
    };
    const result = campaign
      ? await client.from("crm_campaigns").update(payload).eq("id", campaign.id)
      : await client.from("crm_campaigns").insert(payload);
    if (result.error) throw new Error(result.error.message);
    await reload(); close();
  }
  return (
    <div className="modal-backdrop" onMouseDown={close}>
      <form className="modal large crm5-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}>
        <button type="button" className="modal-close" onClick={close}>×</button>
        <header><small>CAMPANHA</small><h2>{campaign?.name || "Nova campanha comercial"}</h2></header>
        <div className="form-grid three">
          <label className="span-2">Nome<input name="name" defaultValue={campaign?.name || ""} required /></label>
          <label>Status<select name="status" defaultValue={campaign?.status || "planejada"}><option value="planejada">Planejada</option><option value="ativa">Ativa</option><option value="pausada">Pausada</option><option value="encerrada">Encerrada</option></select></label>
          <label>Tipo<select name="campaign_type" defaultValue={campaign?.campaign_type || "digital"}><option value="digital">Digital</option><option value="evento">Evento</option><option value="plantao">Plantão</option><option value="indicacao">Indicação</option><option value="midia_offline">Mídia offline</option><option value="remarketing">Remarketing</option></select></label>
          <label>Canal<select name="channel" defaultValue={campaign?.channel || "instagram"}><option>instagram</option><option>facebook</option><option>google</option><option>whatsapp</option><option>site</option><option>radio</option><option>outdoor</option><option>evento</option></select></label>
          <label>Empreendimento<select name="project_id" value={projectId} onChange={(event) => { setProjectId(event.target.value); setPolicyId(""); }}><option value="">Corporativo</option>{data.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
          <label>Política comercial<select name="negotiation_policy_id" value={policyId} onChange={(event) => setPolicyId(event.target.value)} disabled={!projectId}><option value="">Política padrão do empreendimento</option>{availablePolicies.map((policy) => <option key={policy.id} value={policy.id}>{policy.name}{policy.is_default ? " · padrão" : ""}</option>)}</select></label>
          <label>Responsável<select name="owner_user_id" defaultValue={campaign?.owner_user_id || data.session.user.id}>{data.members.map((member) => <option key={member.user_id} value={member.user_id}>{data.profiles.find((profile) => profile.id === member.user_id)?.full_name || member.role}</option>)}</select></label>
          <label>Orçamento<input name="budget" type="number" step="0.01" defaultValue={campaign?.budget || 0} /></label>
          <label>Investido<input name="spent" type="number" step="0.01" defaultValue={campaign?.spent || 0} /></label>
          <label>Início<input name="start_date" type="date" defaultValue={campaign?.start_date || ""} /></label>
          <label>Fim<input name="end_date" type="date" defaultValue={campaign?.end_date || ""} /></label>
          <label className="span-2">Objetivo<input name="objective" defaultValue={campaign?.objective || ""} /></label>
          <label className="span-3">Público-alvo<textarea name="audience" rows={2} defaultValue={campaign?.audience || ""} /></label>
          <label>UTM source<input name="utm_source" defaultValue={campaign?.utm_source || ""} /></label>
          <label>UTM medium<input name="utm_medium" defaultValue={campaign?.utm_medium || ""} /></label>
          <label>UTM campaign<input name="utm_campaign" defaultValue={campaign?.utm_campaign || ""} /></label>
          <label className="span-3">Landing page<input name="landing_page" type="url" defaultValue={campaign?.landing_page || ""} /></label>
          <label className="span-3">Observações<textarea name="notes" rows={3} defaultValue={campaign?.notes || ""} /></label>
        </div>
        <footer><button type="button" onClick={close}>Cancelar</button><button className="primary">Salvar campanha</button></footer>
      </form>
    </div>
  );
}

export function MaterialsView({ data, crm, reload }: { data: ErpData; crm: CrmEnterpriseData; reload: () => Promise<void> }) {
  const [folder, setFolder] = useState("todos");
  const [show, setShow] = useState(false);
  const assets = useMemo(() => crm.assets.filter((asset) => folder === "todos" || asset.folder_id === folder), [crm.assets, folder]);
  async function openAsset(asset: CrmEnterpriseData["assets"][number]) {
    if (asset.external_url) { window.open(asset.external_url, "_blank"); return; }
    if (!asset.storage_path) return;
    const client = getSupabase(); if (!client) return;
    const result = await client.storage.from("erp-documents").createSignedUrl(asset.storage_path, 120);
    if (result.data?.signedUrl) window.open(result.data.signedUrl, "_blank");
  }
  return (
    <div className="crm5-stack">
      <CrmSectionHeader eyebrow="CENTRAL DE CONTEÚDO" title="Materiais de marketing" description="Books, vídeos, imagens, tabelas, plantas e documentos por empreendimento." actions={<button className="primary" onClick={() => setShow(true)}>+ Material</button>} />
      <section className="crm5-toolbar"><select value={folder} onChange={(event) => setFolder(event.target.value)}><option value="todos">Todos os diretórios</option>{crm.folders.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><span>{assets.length} materiais</span></section>
      <section className="crm5-assets">
        {assets.map((asset) => <article key={asset.id}><div className="crm5-asset-icon">{asset.asset_type === "video" ? "▶" : asset.asset_type === "link" ? "↗" : "▧"}</div><div><small>{asset.asset_type} · {data.projects.find((project) => project.id === asset.project_id)?.name || "Corporativo"}</small><h3>{asset.name}</h3><p>{asset.description || "Sem descrição"}</p><div>{(asset.tags || []).map((tag) => <i key={tag}>{tag}</i>)}</div></div><button onClick={() => openAsset(asset)}>Abrir</button></article>)}
        {!assets.length && <EmptyState title="Biblioteca vazia" text="Cadastre books, tabelas, imagens, vídeos e links comerciais." />}
      </section>
      {show && <AssetModal data={data} crm={crm} close={() => setShow(false)} reload={reload} />}
    </div>
  );
}

function AssetModal({ data, crm, close, reload }: { data: ErpData; crm: CrmEnterpriseData; close: () => void; reload: () => Promise<void> }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = new FormData(event.currentTarget); const client = getSupabase(); if (!client) return;
    const file = form.get("file") as File; let storagePath: string | null = null;
    if (file?.size) { storagePath = `${data.organization.id}/marketing/${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`; const upload = await client.storage.from("erp-documents").upload(storagePath, file); if (upload.error) throw upload.error; }
    const result = await client.from("crm_marketing_assets").insert({ organization_id: data.organization.id, folder_id: String(form.get("folder_id") || "") || null, project_id: String(form.get("project_id") || "") || null, name: String(form.get("name")), asset_type: String(form.get("asset_type")), description: String(form.get("description") || "") || null, storage_path: storagePath, external_url: String(form.get("external_url") || "") || null, mime_type: file?.type || null, size_bytes: file?.size || null, tags: String(form.get("tags") || "").split(",").map((value) => value.trim()).filter(Boolean), audience: String(form.get("audience") || "") || null, created_by: data.session.user.id });
    if (result.error) throw result.error; await reload(); close();
  }
  return <div className="modal-backdrop" onMouseDown={close}><form className="modal crm5-modal" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}><button type="button" className="modal-close" onClick={close}>×</button><header><small>BIBLIOTECA</small><h2>Novo material de marketing</h2></header><div className="form-grid"><label className="span-2">Nome<input name="name" required /></label><label>Tipo<select name="asset_type"><option value="arquivo">Arquivo</option><option value="imagem">Imagem</option><option value="video">Vídeo</option><option value="apresentacao">Apresentação</option><option value="link">Link externo</option><option value="planta">Planta / mapa</option><option value="tabela">Tabela comercial</option></select></label><label>Diretório<select name="folder_id"><option value="">Geral</option>{crm.folders.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Empreendimento<select name="project_id"><option value="">Corporativo</option>{data.projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label><label>Público<input name="audience" /></label><label className="span-2">Arquivo<input name="file" type="file" /></label><label className="span-2">URL externa<input name="external_url" type="url" /></label><label className="span-2">Tags<input name="tags" /></label><label className="span-2">Descrição<textarea name="description" rows={3} /></label></div><footer><button type="button" onClick={close}>Cancelar</button><button className="primary">Salvar material</button></footer></form></div>;
}
