import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseIntegrationConfig } from "@/lib/integrations/meta/server-config";
import type {
  ClaimedCrmAiJob,
  CrmAiJobType,
  CrmAiLeadContext,
  CrmAiMode,
  CrmAiShadowResult,
} from "./types";

type JsonObject = Record<string, unknown>;

export class CrmAiGatewayError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(operation: string, databaseCode?: string, retryable = true) {
    super(`A operação do agente IA falhou em ${operation}.`);
    this.name = "CrmAiGatewayError";
    this.code = databaseCode
      ? `CRM_AI_${operation.toUpperCase()}_${databaseCode}`
      : `CRM_AI_${operation.toUpperCase()}_FAILED`;
    this.retryable = retryable;
  }
}

let serviceClient: SupabaseClient | null = null;

function database(): SupabaseClient {
  if (serviceClient) return serviceClient;
  const config = getSupabaseIntegrationConfig();
  serviceClient = createClient(config.url, config.serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    global: {
      headers: { "X-Client-Info": "evora-crm-ai/1.0" },
    },
  });
  return serviceClient;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function databaseCode(error: unknown): string | undefined {
  if (!isObject(error) || typeof error.code !== "string") return undefined;
  return error.code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberOrNull(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export async function enqueueCrmAiJob(input: {
  organizationId: string;
  crmRecordId: string;
  contactId: string | null;
  jobType: CrmAiJobType;
  triggerKey: string;
  mode?: CrmAiMode;
}): Promise<{ jobId: string; inserted: boolean }> {
  const { data, error } = await database().rpc("enqueue_crm_ai_job", {
    p_organization_id: input.organizationId,
    p_crm_record_id: input.crmRecordId,
    p_contact_id: input.contactId,
    p_job_type: input.jobType,
    p_trigger_key: input.triggerKey,
    p_mode: input.mode || "shadow",
  });
  if (error) throw new CrmAiGatewayError("enqueue", databaseCode(error));
  const row = Array.isArray(data) ? data[0] : data;
  if (!isObject(row) || typeof row.job_id !== "string" || typeof row.inserted !== "boolean") {
    throw new CrmAiGatewayError("enqueue_contract", undefined, false);
  }
  return { jobId: row.job_id, inserted: row.inserted };
}

function parseClaimedJob(value: unknown): ClaimedCrmAiJob | null {
  if (!isObject(value)) return null;
  const jobType = value.job_type;
  const mode = value.mode;
  if (
    typeof value.job_id !== "string" ||
    typeof value.lock_token !== "string" ||
    typeof value.organization_id !== "string" ||
    typeof value.crm_record_id !== "string" ||
    (value.contact_id !== null && typeof value.contact_id !== "string") ||
    !["lead_created", "message_received", "follow_up", "manual_review"].includes(
      String(jobType),
    ) ||
    !["shadow", "supervised", "autonomous"].includes(String(mode)) ||
    !Number.isSafeInteger(value.attempt_count)
  ) {
    return null;
  }
  return {
    id: value.job_id,
    lockToken: value.lock_token,
    organizationId: value.organization_id,
    crmRecordId: value.crm_record_id,
    contactId: value.contact_id as string | null,
    jobType: jobType as CrmAiJobType,
    mode: mode as CrmAiMode,
    attemptCount: Number(value.attempt_count),
  };
}

export async function claimCrmAiJobs(
  workerId: string,
  limit: number,
  leaseSeconds: number,
): Promise<ClaimedCrmAiJob[]> {
  const { data, error } = await database().rpc("claim_crm_ai_jobs", {
    p_worker_id: workerId,
    p_limit: limit,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw new CrmAiGatewayError("claim", databaseCode(error));
  const candidates = Array.isArray(data) ? data : [];
  const jobs = candidates.map(parseClaimedJob).filter((job) => job !== null);
  if (jobs.length !== candidates.length) {
    throw new CrmAiGatewayError("claim_contract", undefined, false);
  }
  return jobs;
}

function recommendationFor(context: Omit<CrmAiLeadContext, "recommendation">) {
  if (context.contact?.doNotContact) {
    return {
      kind: "review" as const,
      reason: "O contato possui bloqueio explícito de comunicação.",
    };
  }
  if (["denied", "revoked"].includes(context.contact?.marketingConsentStatus || "")) {
    return {
      kind: "review" as const,
      reason: "O contato possui consentimento de marketing negado ou revogado.",
    };
  }
  if (context.lead.recordStatus !== "aberta") {
    return {
      kind: "review" as const,
      reason: "A oportunidade não está aberta e não deve receber nova abordagem automática.",
    };
  }
  if (context.lead.attempts >= 5) {
    return {
      kind: "review" as const,
      reason: "A cadência chegou ao limite seguro e exige revisão humana.",
    };
  }
  if (!context.lead.firstResponseAt) {
    return {
      kind: "first_contact" as const,
      reason: "A oportunidade ainda não possui primeira resposta registrada.",
    };
  }
  if (
    !context.project ||
    context.lead.budgetMax === null ||
    context.lead.preferredAreaMin === null
  ) {
    return {
      kind: "qualify" as const,
      reason: "Empreendimento, orçamento ou área de interesse ainda precisam de qualificação.",
    };
  }
  return {
    kind: "follow_up" as const,
    reason: "A oportunidade está apta a um acompanhamento contextual.",
  };
}

export async function loadCrmAiLeadContext(
  job: ClaimedCrmAiJob,
): Promise<CrmAiLeadContext> {
  const recordResult = await database()
    .from("crm_records")
    .select(
      "id,organization_id,contact_id,project_id,campaign_id,person_name,record_status,source,source_channel,stage,probability,lead_score,temperature,priority,attempts,first_response_at,last_contact_at,next_action_at,sla_due_at,budget_min,budget_max,preferred_area_min,preferred_area_max,financing_interest,payment_capacity",
    )
    .eq("organization_id", job.organizationId)
    .eq("id", job.crmRecordId)
    .maybeSingle();

  if (recordResult.error) {
    throw new CrmAiGatewayError("load_record", databaseCode(recordResult.error));
  }
  if (!recordResult.data) {
    throw new CrmAiGatewayError("record_not_found", undefined, false);
  }

  const record = recordResult.data as JsonObject;
  const contactId = stringOrNull(record.contact_id);
  const projectId = stringOrNull(record.project_id);
  const campaignId = stringOrNull(record.campaign_id);

  const [contactResult, projectResult, campaignResult, attributionResult, actionsResult] =
    await Promise.all([
      contactId
        ? database()
            .from("contacts")
            .select(
              "id,name,city,state,preferred_channel,marketing_consent_status,do_not_contact_at",
            )
            .eq("organization_id", job.organizationId)
            .eq("id", contactId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      projectId
        ? database()
            .from("projects")
            .select("id,name,city,state")
            .eq("organization_id", job.organizationId)
            .eq("id", projectId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      campaignId
        ? database()
            .from("crm_campaigns")
            .select("id,name,objective,audience")
            .eq("organization_id", job.organizationId)
            .eq("id", campaignId)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      database()
        .from("crm_opportunity_attributions")
        .select(
          "provider,channel,campaign_name,adset_name,ad_name,creative_name,form_name,page_name,placement,captured_at",
        )
        .eq("organization_id", job.organizationId)
        .eq("crm_record_id", job.crmRecordId)
        .order("is_primary", { ascending: false })
        .order("captured_at", { ascending: false })
        .limit(1)
        .maybeSingle(),
      database()
        .from("crm_actions")
        .select(
          "action_type,channel,subject,outcome,action_status,scheduled_at,completed_at,created_at",
        )
        .eq("organization_id", job.organizationId)
        .eq("crm_record_id", job.crmRecordId)
        .order("created_at", { ascending: false })
        .limit(8),
    ]);

  const firstError = [
    contactResult.error,
    projectResult.error,
    campaignResult.error,
    attributionResult.error,
    actionsResult.error,
  ].find(Boolean);
  if (firstError) {
    throw new CrmAiGatewayError("load_context", databaseCode(firstError));
  }

  const contact = contactResult.data as JsonObject | null;
  const project = projectResult.data as JsonObject | null;
  const campaign = campaignResult.data as JsonObject | null;
  const attribution = attributionResult.data as JsonObject | null;
  const actionRows = Array.isArray(actionsResult.data) ? actionsResult.data : [];

  const baseContext: Omit<CrmAiLeadContext, "recommendation"> = {
    lead: {
      id: String(record.id),
      name: String(record.person_name || contact?.name || "Interessado").slice(0, 180),
      recordStatus: String(record.record_status || ""),
      source: stringOrNull(record.source),
      sourceChannel: stringOrNull(record.source_channel),
      stage: stringOrNull(record.stage),
      probability: numberOrNull(record.probability) || 0,
      leadScore: numberOrNull(record.lead_score) || 0,
      temperature: stringOrNull(record.temperature),
      priority: stringOrNull(record.priority),
      attempts: numberOrNull(record.attempts) || 0,
      firstResponseAt: stringOrNull(record.first_response_at),
      lastContactAt: stringOrNull(record.last_contact_at),
      nextActionAt: stringOrNull(record.next_action_at),
      slaDueAt: stringOrNull(record.sla_due_at),
      budgetMin: numberOrNull(record.budget_min),
      budgetMax: numberOrNull(record.budget_max),
      preferredAreaMin: numberOrNull(record.preferred_area_min),
      preferredAreaMax: numberOrNull(record.preferred_area_max),
      financingInterest: booleanOrNull(record.financing_interest),
      paymentCapacity: numberOrNull(record.payment_capacity),
    },
    contact: contact
      ? {
          name: String(contact.name || record.person_name || "Interessado").slice(0, 180),
          city: stringOrNull(contact.city),
          state: stringOrNull(contact.state),
          preferredChannel: stringOrNull(contact.preferred_channel),
          marketingConsentStatus: stringOrNull(contact.marketing_consent_status),
          doNotContact: Boolean(contact.do_not_contact_at),
        }
      : null,
    project: project
      ? {
          id: String(project.id),
          name: String(project.name || "Empreendimento").slice(0, 180),
          city: stringOrNull(project.city),
          state: stringOrNull(project.state),
        }
      : null,
    campaign: campaign
      ? {
          id: String(campaign.id),
          name: String(campaign.name || "Campanha").slice(0, 180),
          objective: stringOrNull(campaign.objective),
          audience: stringOrNull(campaign.audience),
        }
      : null,
    attribution: attribution
      ? {
          provider: String(attribution.provider || "unknown").slice(0, 80),
          channel: String(attribution.channel || "unknown").slice(0, 80),
          campaignName: stringOrNull(attribution.campaign_name),
          adsetName: stringOrNull(attribution.adset_name),
          adName: stringOrNull(attribution.ad_name),
          creativeName: stringOrNull(attribution.creative_name),
          formName: stringOrNull(attribution.form_name),
          pageName: stringOrNull(attribution.page_name),
          placement: stringOrNull(attribution.placement),
          capturedAt: String(attribution.captured_at || ""),
        }
      : null,
    recentActions: actionRows.map((row) => ({
      actionType: String(row.action_type || "atividade").slice(0, 80),
      channel: stringOrNull(row.channel),
      subject: String(row.subject || "Atividade").slice(0, 240),
      outcome: stringOrNull(row.outcome),
      status: String(row.action_status || "").slice(0, 80),
      scheduledAt: stringOrNull(row.scheduled_at),
      completedAt: stringOrNull(row.completed_at),
    })),
  };

  return {
    ...baseContext,
    recommendation: recommendationFor(baseContext),
  };
}

export async function completeCrmAiShadowJob(
  job: ClaimedCrmAiJob,
  result: CrmAiShadowResult,
): Promise<void> {
  const { error } = await database().rpc("complete_crm_ai_shadow_job", {
    p_job_id: job.id,
    p_lock_token: job.lockToken,
    p_result: result,
  });
  if (error) throw new CrmAiGatewayError("complete", databaseCode(error));
}

export async function failCrmAiJob(
  job: ClaimedCrmAiJob,
  input: { code: string; message: string; retryable: boolean },
): Promise<void> {
  const { error } = await database().rpc("fail_crm_ai_job", {
    p_job_id: job.id,
    p_lock_token: job.lockToken,
    p_error_code: input.code.slice(0, 128),
    p_error_message: input.message.slice(0, 1024),
    p_retryable: input.retryable,
  });
  if (error) throw new CrmAiGatewayError("fail", databaseCode(error));
}
