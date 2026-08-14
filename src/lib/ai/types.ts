export type CrmAiJobType =
  | "lead_created"
  | "message_received"
  | "follow_up"
  | "manual_review";

export type CrmAiMode = "shadow" | "supervised" | "autonomous";

export interface ClaimedCrmAiJob {
  id: string;
  lockToken: string;
  organizationId: string;
  crmRecordId: string;
  contactId: string | null;
  jobType: CrmAiJobType;
  mode: CrmAiMode;
  attemptCount: number;
}

export interface CrmAiLeadContext {
  lead: {
    id: string;
    name: string;
    recordStatus: string;
    source: string | null;
    sourceChannel: string | null;
    stage: string | null;
    probability: number;
    leadScore: number;
    temperature: string | null;
    priority: string | null;
    attempts: number;
    firstResponseAt: string | null;
    lastContactAt: string | null;
    nextActionAt: string | null;
    slaDueAt: string | null;
    budgetMin: number | null;
    budgetMax: number | null;
    preferredAreaMin: number | null;
    preferredAreaMax: number | null;
    financingInterest: boolean | null;
    paymentCapacity: number | null;
  };
  contact: {
    name: string;
    city: string | null;
    state: string | null;
    preferredChannel: string | null;
    marketingConsentStatus: string | null;
    doNotContact: boolean;
  } | null;
  project: {
    id: string;
    name: string;
    city: string | null;
    state: string | null;
  } | null;
  campaign: {
    id: string;
    name: string;
    objective: string | null;
    audience: string | null;
  } | null;
  attribution: {
    provider: string;
    channel: string;
    campaignName: string | null;
    adsetName: string | null;
    adName: string | null;
    creativeName: string | null;
    formName: string | null;
    pageName: string | null;
    placement: string | null;
    capturedAt: string;
  } | null;
  recentActions: Array<{
    actionType: string;
    channel: string | null;
    subject: string;
    outcome: string | null;
    status: string;
    scheduledAt: string | null;
    completedAt: string | null;
  }>;
  recommendation: {
    kind: "complete_contact" | "first_contact" | "qualify" | "follow_up" | "handoff" | "review";
    reason: string;
  };
}

export interface VitoriaDraft {
  message: string;
  objective:
    | "first_contact"
    | "qualification"
    | "follow_up"
    | "handoff"
    | "do_not_contact";
  recommended_next_step:
    | "wait_for_reply"
    | "qualify"
    | "human_review"
    | "human_handoff"
    | "do_not_contact";
  questions_asked: string[];
  facts_used: string[];
  risk_flags: string[];
  should_handoff: boolean;
}

export interface SupervisorReview {
  decision: "approve" | "revise" | "block";
  final_message: string;
  objective: VitoriaDraft["objective"];
  recommended_next_step: VitoriaDraft["recommended_next_step"];
  quality_score: number;
  issues: string[];
  review_summary: string;
}

export interface CrmAiShadowResult extends SupervisorReview {
  agent: "vitoria";
  mode: "shadow";
  draft_message: string;
  generated_at: string;
  agent_response_id: string | null;
  supervisor_response_id: string | null;
}
