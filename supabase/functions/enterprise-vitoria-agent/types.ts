export type JsonObject = Record<string, unknown>;
export type Reasoning = "none" | "low" | "medium" | "high" | "xhigh" | "max";
export type Stage = "welcome" | "discovery" | "qualification" | "contact" | "handoff" | "completed";
export type AgentAction =
  | "none"
  | "show_enterprise"
  | "show_inventory"
  | "show_policy"
  | "show_resources"
  | "request_hold"
  | "hold_status"
  | "generate_home_simulation";

export type Profile = {
  intent?: "morar" | "investir" | "conhecer" | "unknown";
  budget_min?: number | null;
  budget_max?: number | null;
  preferred_area_min?: number | null;
  preferred_area_max?: number | null;
  purchase_horizon?: "ate_3_meses" | "3_a_6_meses" | "6_a_12_meses" | "mais_de_12_meses" | "unknown";
  preferred_city?: string | null;
  financing_interest?: boolean | null;
  payment_capacity?: number | null;
  visit_interest?: boolean | null;
  selected_unit_code?: string | null;
  lead_score?: number;
  summary?: string;
};

export type ContactPatch = {
  name?: string | null;
  phone?: string | null;
  email?: string | null;
  city?: string | null;
  preferred_contact_method?: "telefone" | "whatsapp" | "email" | null;
};

export type SimulationSpec = {
  style?: string | null;
  floors?: number | null;
  bedrooms?: number | null;
  suites?: number | null;
  garage_spaces?: number | null;
  pool?: boolean | null;
  notes?: string | null;
  explicit_confirmation?: boolean;
};

export type Filters = {
  area_min?: number | null;
  area_max?: number | null;
  budget_max?: number | null;
  unit_code?: string | null;
  limit?: number;
};

export type Runtime = {
  apiKey: string;
  agentModel: string;
  agentReasoning: Reasoning;
  supervisorModel: string;
  supervisorReasoning: Reasoning;
};

export type OpenAiPayload = {
  id?: string;
  output?: Array<{
    type?: string;
    id?: string;
    status?: string;
    results?: unknown[];
    content?: Array<{ type?: string; text?: string; refusal?: string; annotations?: unknown[] }>;
  }>;
  error?: { code?: string; message?: string };
};

export type GeneratedReply = {
  reply: string;
  stage: Stage;
  profile: Profile;
  contactPatch: ContactPatch;
  serviceConsent: boolean | null;
  marketingConsent: boolean | null;
  requestContact: boolean;
  handoffRequested: boolean;
  quickReplies: string[];
  action: AgentAction;
  selectedUnitCode: string | null;
  filters: Filters;
  simulation: SimulationSpec;
  factsUsed: string[];
  riskFlags: string[];
  agentResponseId: string | null;
  supervisorResponseId: string | null;
  supervisorDecision: "approve" | "revise" | "block";
  fileSearchUsed: boolean;
};

export type ResponseCard =
  | { type: "enterprise"; title: string; items: unknown[] }
  | { type: "inventory"; title: string; data: JsonObject }
  | { type: "policy"; title: string; data: JsonObject }
  | { type: "resources"; title: string; items: unknown[] }
  | { type: "simulation"; title: string; imageUrl: string; caption: string; assetId: string }
  | { type: "hold"; title: string; data: JsonObject }
  | { type: "lead"; title: string; protocol: string };
