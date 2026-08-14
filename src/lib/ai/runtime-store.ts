import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseIntegrationConfig } from "@/lib/integrations/meta/server-config";
import {
  CrmAiConfigError,
  getCrmAiOpenAiConfig,
  isCrmAiShadowEnabled,
  type CrmAiReasoningEffort,
} from "./config";

type JsonObject = Record<string, unknown>;

export type CrmAiRuntime = {
  organizationId: string;
  enabled: boolean;
  mode: "shadow";
  apiKey: string | null;
  apiKeyVersion: number;
  agentModel: string;
  agentReasoning: CrmAiReasoningEffort;
  supervisorModel: string;
  supervisorReasoning: CrmAiReasoningEffort;
  updatedAt: string | null;
  source: "vault" | "environment" | "disabled";
};

export class CrmAiRuntimeStoreError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, retryable = true) {
    super(code);
    this.name = "CrmAiRuntimeStoreError";
    this.code = code;
    this.retryable = retryable;
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MODEL = /^[A-Za-z0-9._:-]{2,120}$/;
const REASONING = new Set<CrmAiReasoningEffort>([
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);

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
    global: { headers: { "X-Client-Info": "evora-crm-ai-runtime/1.0" } },
  });
  return serviceClient;
}

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function databaseCode(error: unknown): string {
  if (!isObject(error) || typeof error.code !== "string") return "UNKNOWN";
  return error.code.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "UNKNOWN";
}

function string(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function reasoning(value: unknown): CrmAiReasoningEffort | null {
  return typeof value === "string" && REASONING.has(value as CrmAiReasoningEffort)
    ? (value as CrmAiReasoningEffort)
    : null;
}

function parseVaultRuntime(
  organizationId: string,
  value: unknown,
): CrmAiRuntime {
  if (!isObject(value) || value.organization_id !== organizationId) {
    throw new CrmAiRuntimeStoreError("CRM_AI_RUNTIME_INVALID_CONTRACT", false);
  }

  const enabled = value.enabled === true;
  const mode = value.mode === "shadow" ? "shadow" : null;
  const agentModel = string(value.agent_model);
  const supervisorModel = string(value.supervisor_model);
  const agentReasoning = reasoning(value.agent_reasoning);
  const supervisorReasoning = reasoning(value.supervisor_reasoning);
  const apiKeyVersion = Number(value.api_key_version || 0);
  const updatedAt = value.updated_at === null ? null : string(value.updated_at);
  const rawApiKey = value.api_key === null ? null : string(value.api_key);
  const apiKey =
    rawApiKey &&
    rawApiKey.length >= 32 &&
    rawApiKey.length <= 512 &&
    rawApiKey.trim() === rawApiKey &&
    !/\s/.test(rawApiKey)
      ? rawApiKey
      : null;

  if (
    !mode ||
    !agentModel ||
    !MODEL.test(agentModel) ||
    !supervisorModel ||
    !MODEL.test(supervisorModel) ||
    !agentReasoning ||
    !supervisorReasoning ||
    !Number.isSafeInteger(apiKeyVersion) ||
    apiKeyVersion < 0 ||
    (value.updated_at !== null && !updatedAt) ||
    (enabled && !apiKey)
  ) {
    throw new CrmAiRuntimeStoreError("CRM_AI_RUNTIME_INVALID_CONTRACT", false);
  }

  return {
    organizationId,
    enabled,
    mode,
    apiKey: enabled ? apiKey : null,
    apiKeyVersion,
    agentModel,
    agentReasoning,
    supervisorModel,
    supervisorReasoning,
    updatedAt,
    source: enabled ? "vault" : "disabled",
  };
}

function environmentFallback(organizationId: string): CrmAiRuntime | null {
  if (!isCrmAiShadowEnabled()) return null;
  try {
    const config = getCrmAiOpenAiConfig();
    return {
      organizationId,
      enabled: true,
      mode: "shadow",
      apiKey: config.apiKey,
      apiKeyVersion: 0,
      agentModel: config.agentModel,
      agentReasoning: config.agentReasoning,
      supervisorModel: config.supervisorModel,
      supervisorReasoning: config.supervisorReasoning,
      updatedAt: null,
      source: "environment",
    };
  } catch (error) {
    if (error instanceof CrmAiConfigError) return null;
    throw error;
  }
}

function disabledRuntime(organizationId: string): CrmAiRuntime {
  return {
    organizationId,
    enabled: false,
    mode: "shadow",
    apiKey: null,
    apiKeyVersion: 0,
    agentModel: "gpt-5.6-sol",
    agentReasoning: "medium",
    supervisorModel: "gpt-5.6-sol",
    supervisorReasoning: "high",
    updatedAt: null,
    source: "disabled",
  };
}

export async function fetchCrmAiRuntime(
  organizationId: string,
): Promise<CrmAiRuntime> {
  if (!UUID.test(organizationId)) {
    throw new CrmAiRuntimeStoreError("CRM_AI_RUNTIME_INVALID_ORGANIZATION", false);
  }

  const { data, error } = await database().rpc("get_crm_ai_runtime_credentials", {
    p_organization_id: organizationId,
  });

  if (error) {
    const code = databaseCode(error);
    if (["PGRST202", "42883"].includes(code)) {
      return environmentFallback(organizationId) || disabledRuntime(organizationId);
    }
    throw new CrmAiRuntimeStoreError(`CRM_AI_RUNTIME_${code}`, true);
  }

  const runtime = parseVaultRuntime(organizationId, data);
  // Compatibilidade de transicao: ausencia de linha persistida vem com
  // updated_at=null e versao 0. Nesse caso apenas, um flag legado explicitamente
  // ativo pode fornecer o runtime pelo ambiente.
  if (
    !runtime.enabled &&
    runtime.updatedAt === null &&
    runtime.apiKeyVersion === 0
  ) {
    return environmentFallback(organizationId) || runtime;
  }
  return runtime;
}

export async function isCrmAiRuntimeEnabled(
  organizationId: string,
): Promise<boolean> {
  const runtime = await fetchCrmAiRuntime(organizationId);
  return runtime.enabled && runtime.mode === "shadow" && Boolean(runtime.apiKey);
}
