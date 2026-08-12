import type { CrmRecord, ErpData } from "../types";
import type { CrmEnterpriseData } from "./types";
import { buyerPayload } from "./buyer-profile";

export function buildLeadPayload(
  form: FormData,
  data: ErpData,
  crm: CrmEnterpriseData,
  lead: CrmRecord | null,
) {
  const pipelineId = String(form.get("pipeline_id") || "");
  const pipeline = crm.pipelines.find((item) => item.id === pipelineId)
    || crm.pipelines.find((item) => item.is_default);
  const stageId = String(form.get("stage_id") || "");
  const stage = crm.stages.find(
    (item) => item.id === stageId && item.pipeline_id === pipeline?.id,
  ) || crm.stages.find(
    (item) => item.pipeline_id === pipeline?.id && item.position === 1 && item.active,
  );
  const phone = String(form.get("phone") || "").trim();
  const email = String(form.get("email") || "").trim();
  const projectId = String(form.get("project_id") || "") || null;
  const requestedProductId = String(form.get("product_id") || "") || null;
  const productId = crm.products.find(
    (item) => item.id === requestedProductId
      && item.project_id === projectId
      && (item.active || item.id === lead?.product_id),
  )?.id || null;
  const requestedLeadSourceId = String(form.get("lead_source_id") || "") || null;
  const leadSourceId = crm.leadSources.find(
    (item) => item.id === requestedLeadSourceId
      && ((item.active && item.manual_selectable) || item.id === lead?.lead_source_id),
  )?.id || null;
  const requestedCampaignId = String(form.get("campaign_id") || "") || null;
  const campaignId = crm.campaigns.find(
    (item) => item.id === requestedCampaignId && item.project_id === projectId,
  )?.id || null;
  const requestedLossReasonId = String(form.get("loss_reason_id") || "") || null;
  const lossReasonId = stage?.is_lost
    ? crm.lossReasons.find(
      (item) => item.id === requestedLossReasonId
        && (item.active || item.id === lead?.loss_reason_id),
    )?.id || null
    : null;
  const nextActionRaw = String(form.get("next_action_at") || "");
  const nextActionAt = nextActionRaw ? new Date(nextActionRaw).toISOString() : null;
  const budgetMax = Number(form.get("budget_max") || 0);
  const estimate = Number(form.get("estimated_value") || 0);
  const calculatedScore = Math.min(
    100,
    (phone ? 15 : 0)
      + (email ? 10 : 0)
      + (projectId ? 20 : 0)
      + (budgetMax ? 20 : 0)
      + (estimate ? 15 : 0)
      + ((form.get("source") || leadSourceId) ? 10 : 0),
  );
  const score = lead ? Number(lead.lead_score ?? calculatedScore) : calculatedScore;
  const now = new Date();
  const stageChanged = !lead || stage?.id !== lead.stage_id;

  return {
    score,
    payload: {
      organization_id: data.organization.id,
      person_name: String(form.get("person_name")).trim(),
      company_name: String(form.get("company_name") || "") || null,
      email: email || null,
      phone: phone || null,
      project_id: projectId,
      product_id: productId,
      lead_source_id: leadSourceId,
      pipeline_id: pipeline?.id || null,
      stage_id: stage?.id || null,
      stage: stage?.code || "novo",
      record_status: stage?.is_won ? "ganha" : stage?.is_lost ? "perdida" : "aberta",
      source: String(form.get("source") || "") || null,
      source_channel: String(form.get("source_channel") || "") || null,
      campaign_id: campaignId,
      estimated_value: estimate,
      probability: Number(stage?.probability || 10),
      expected_close_date: String(form.get("expected_close_date") || "") || null,
      next_action_at: nextActionAt,
      priority: String(form.get("priority") || "normal"),
      temperature: String(form.get("temperature") || "morno"),
      lead_score: score,
      budget_min: Number(form.get("budget_min") || 0) || null,
      budget_max: budgetMax || null,
      preferred_area_min: Number(form.get("preferred_area_min") || 0) || null,
      preferred_area_max: Number(form.get("preferred_area_max") || 0) || null,
      preferred_city: String(form.get("preferred_city") || "") || null,
      financing_interest: form.get("financing_interest") === "on",
      payment_capacity: Number(form.get("payment_capacity") || 0) || null,
      loss_reason_id: lossReasonId,
      tags: String(form.get("tags") || "").split(",").map((value) => value.trim()).filter(Boolean),
      utm_source: String(form.get("utm_source") || "") || null,
      utm_medium: String(form.get("utm_medium") || "") || null,
      utm_campaign: String(form.get("utm_campaign") || "") || null,
      notes: String(form.get("notes") || "") || null,
      sla_due_at: stageChanged
        ? new Date(now.getTime() + Number(stage?.sla_hours || 24) * 3_600_000).toISOString()
        : lead?.sla_due_at || null,
      stagnation_at: stageChanged ? now.toISOString() : lead?.stagnation_at || now.toISOString(),
      ...buyerPayload(form),
      created_by: lead?.created_by || data.session.user.id,
      updated_at: now.toISOString(),
    },
  };
}
