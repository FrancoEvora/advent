"use client";
import { useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ErpData } from "../../types";
import { buyerSnapshot } from "../buyer-profile";
import type { SalesData } from "./types";
import { buildPlan, proposalCompliance } from "./utils";
export function useProposalBuilder(
  data: ErpData,
  sales: SalesData,
  initialUnitId?: string,
) {
  const initial = sales.units.find((u) => u.id === initialUnitId);
  const initialProject = initial?.project_id || data.projects[0]?.id || "";
  const today = new Date().toISOString().slice(0, 10);
  function resolvePolicy(projectId: string, campaignId: string) {
    const eligible = sales.policies.filter(
      (item) =>
        item.project_id === projectId &&
        item.active &&
        (!item.valid_from || item.valid_from <= today) &&
        (!item.valid_until || item.valid_until >= today),
    );
    const campaign = sales.campaigns.find(
      (item) => item.id === campaignId && (!item.project_id || item.project_id === projectId),
    );
    return (
      eligible.find((item) => item.id === campaign?.negotiation_policy_id) ||
      eligible.find((item) => item.is_default) ||
      eligible[0]
    );
  }
  const initialPolicy = resolvePolicy(initialProject, "");
  const [project, setProject] = useState(initialProject);
  const [unitId, setUnitId] = useState(initial?.id || "");
  const [leadId, setLeadId] = useState("");
  const [campaignId, setCampaignId] = useState("");
  const campaigns = sales.campaigns.filter(
    (item) =>
      (!item.project_id || item.project_id === project) &&
      !["encerrada", "cancelada"].includes(item.status),
  );
  const campaign = campaigns.find((item) => item.id === campaignId);
  const policy = resolvePolicy(project, campaignId);
  const units = sales.units.filter(
    (u) =>
      u.project_id === project &&
      (u.status === "disponivel" || u.id === initialUnitId),
  );
  const unit = units.find((u) => u.id === unitId);
  const [price, setPrice] = useState(Number(initial?.list_price || 0));
  const [down, setDown] = useState(
    Number(initial?.list_price || 0) *
      (initialPolicy?.min_down_payment_pct || 0.2),
  );
  const [downCount, setDownCount] = useState(1);
  const [downFirstDue, setDownFirstDue] = useState(
    new Date(
      new Date().getTime() +
        Number(initialPolicy?.down_payment_first_due_days || 0) * 86400000,
    )
      .toISOString()
      .slice(0, 10),
  );
  const [months, setMonths] = useState(
    initialPolicy?.max_installments || 120,
  );
  const [balloons, setBalloons] = useState(0);
  const [balloonCount, setBalloonCount] = useState(0);
  const [firstDue, setFirstDue] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const lead = data.crmRecords.find((r) => r.id === leadId);
  function applyPolicyDefaults(
    nextPolicy: typeof policy,
    nextUnit: typeof unit,
    referencePrice = price,
  ) {
    const basePrice = referencePrice || Number(nextUnit?.list_price || 0);
    setDown(basePrice * (nextPolicy?.min_down_payment_pct || 0.2));
    setDownCount(1);
    setMonths(nextPolicy?.max_installments || 120);
    setDownFirstDue(
      new Date(
        Date.now() +
          Number(nextPolicy?.down_payment_first_due_days || 0) * 86400000,
      )
        .toISOString()
        .slice(0, 10),
    );
  }
  function changeProject(id: string) {
    const currentLead = data.crmRecords.find((record) => record.id === leadId);
    const keepLead = !currentLead?.project_id || currentLead.project_id === id;
    const nextCampaignId =
      keepLead &&
      sales.campaigns.some(
        (item) =>
          item.id === currentLead?.campaign_id &&
          (!item.project_id || item.project_id === id),
      )
        ? currentLead?.campaign_id || ""
        : "";
    setProject(id);
    setUnitId("");
    if (!keepLead) setLeadId("");
    setCampaignId(nextCampaignId);
    setPrice(0);
    applyPolicyDefaults(resolvePolicy(id, nextCampaignId), undefined, 0);
  }
  function changeLead(id: string) {
    setLeadId(id);
    const nextLead = data.crmRecords.find((record) => record.id === id);
    if (!nextLead) {
      setCampaignId("");
      applyPolicyDefaults(resolvePolicy(project, ""), unit);
      return;
    }
    const nextProject = nextLead.project_id || project;
    const nextCampaignId = sales.campaigns.some(
      (item) =>
        item.id === nextLead.campaign_id &&
        (!item.project_id || item.project_id === nextProject) &&
        !["encerrada", "cancelada"].includes(item.status),
    )
      ? nextLead.campaign_id || ""
      : "";
    if (nextProject !== project) {
      setProject(nextProject);
      setUnitId("");
      setPrice(0);
    }
    setCampaignId(nextCampaignId);
    applyPolicyDefaults(
      resolvePolicy(nextProject, nextCampaignId),
      nextProject === project ? unit : undefined,
      nextProject === project ? price : 0,
    );
  }
  function changeCampaign(id: string) {
    setCampaignId(id);
    applyPolicyDefaults(resolvePolicy(project, id), unit);
  }
  function changeUnit(id: string) {
    setUnitId(id);
    const u = units.find((x) => x.id === id);
    if (u) {
      setPrice(Number(u.list_price));
      setDown(Number(u.list_price) * (policy?.min_down_payment_pct || 0.2));
      setDownCount(1);
    }
  }
  const plan = useMemo(
    () =>
      unit
        ? buildPlan({
            salePrice: price,
            downPayment: down,
            downPaymentInstallments: downCount,
            downPaymentFirstDueDate: downFirstDue,
            downPaymentFrequencyDays: Number(
              policy?.down_payment_frequency_days || 30,
            ),
            downPaymentRate: Number(policy?.down_payment_interest_rate || 0),
            installments: months,
            monthlyRate: Number(policy?.monthly_interest_rate || 0),
            graceMonths: Number(policy?.grace_months || 0),
            balloonTotal: balloons,
            balloonCount,
            balloonFrequency: Number(policy?.balloon_frequency_months || 12),
            firstDueDate: firstDue,
          })
        : [],
    [
      unit,
      price,
      down,
      downCount,
      downFirstDue,
      months,
      balloons,
      balloonCount,
      firstDue,
      policy,
    ],
  );
  const compliance = unit
    ? proposalCompliance(unit, policy, {
        salePrice: price,
        downPayment: down,
        downPaymentInstallments: downCount,
        installments: months,
        balloonTotal: balloons,
      })
    : { requiresApproval: false, reasons: [] };
  async function save(form: FormData) {
    if (!unit) throw new Error("Selecione a unidade");
    if (!policy)
      throw new Error(
        "Nenhuma política comercial vigente foi definida para este empreendimento.",
      );
    const client = getSupabase();
    if (!client) throw new Error("Supabase indisponível");
    const payload = {
      organization_id: data.organization.id,
      project_id: project,
      unit_id: unit.id,
      crm_record_id: leadId || null,
      contact_id: lead?.contact_id || null,
      campaign_id: campaignId || null,
      negotiation_policy_id: policy.id,
      customer_name: lead?.person_name || String(form.get("customer_name")),
      customer_document:
        lead?.cpf_cnpj || String(form.get("customer_document") || "") || null,
      customer_email:
        lead?.email || String(form.get("customer_email") || "") || null,
      customer_phone:
        lead?.phone || String(form.get("customer_phone") || "") || null,
      customer_address: {
        postal_code: lead?.postal_code,
        street: lead?.street,
        address_number: lead?.address_number,
        complement: lead?.complement,
        neighborhood: lead?.neighborhood,
        city: lead?.city,
        state: lead?.state,
        country: lead?.country,
      },
      customer_profile: buyerSnapshot(lead),
      status: "submetida",
      list_price: Number(unit.list_price),
      sale_price: price,
      down_payment: down,
      down_payment_installments_count: downCount,
      down_payment_first_due_date: downFirstDue,
      installments_count: months,
      monthly_interest_rate: Number(policy?.monthly_interest_rate || 0),
      indexer: policy?.indexer || "IPCA",
      grace_months: Number(policy?.grace_months || 0),
      balloon_total: balloons,
      payment_plan: plan,
      conditions_text: String(form.get("conditions_text") || "") || null,
      valid_until: new Date(
        Date.now() + (policy?.proposal_validity_days || 5) * 86400000,
      ).toISOString(),
      requires_approval: compliance.requiresApproval,
      created_by: data.session.user.id,
    };
    const inserted = await client
      .from("crm_proposals")
      .insert(payload)
      .select("*")
      .single();
    if (inserted.error) throw inserted.error;
    const proposal = inserted.data;
    const rows = plan.map((i) => ({
      organization_id: data.organization.id,
      proposal_id: proposal.id,
      installment_number: i.installment_number,
      installment_type: i.installment_type,
      due_date: i.due_date,
      amount: i.amount,
      status: "planejada",
    }));
    if (rows.length) {
      const r = await client.from("crm_proposal_installments").insert(rows);
      if (r.error) throw r.error;
    }
    if (
      compliance.requiresApproval ||
      proposal.approval_status === "pendente"
    ) {
      const r = await client
        .from("crm_proposal_approvals")
        .insert({
          organization_id: data.organization.id,
          proposal_id: proposal.id,
          requested_by: data.session.user.id,
          status: "pendente",
          reason: compliance.reasons.join(" · "),
          snapshot: {
            unit: unit.unit_code,
            list_price: unit.list_price,
            sale_price: price,
            down_payment: down,
            down_payment_installments: downCount,
            installments: months,
            balloon_total: balloons,
            campaign_id: campaignId || null,
            campaign_name: campaign?.name || null,
            negotiation_policy_id: policy.id,
            negotiation_policy_name: policy.name,
          },
        });
      if (r.error) throw r.error;
    } else
      await client
        .from("crm_proposals")
        .update({ status: "aprovada" })
        .eq("id", proposal.id);
    return proposal;
  }
  return {
    project,
    setProject: changeProject,
    unitId,
    setUnitId: changeUnit,
    leadId,
    setLeadId: changeLead,
    campaignId,
    setCampaignId: changeCampaign,
    campaigns,
    campaign,
    policy,
    units,
    unit,
    price,
    setPrice,
    down,
    setDown,
    downCount,
    setDownCount,
    downFirstDue,
    setDownFirstDue,
    months,
    setMonths,
    balloons,
    setBalloons,
    balloonCount,
    setBalloonCount,
    firstDue,
    setFirstDue,
    plan,
    compliance,
    lead,
    save,
  };
}
