export class CrmAiConfigError extends Error {
  readonly code = "CRM_AI_NOT_CONFIGURED";

  constructor(variableName: string) {
    super(`A variável de servidor ${variableName} não foi configurada corretamente.`);
    this.name = "CrmAiConfigError";
  }
}

export type CrmAiReasoningEffort =
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

function requiredSecret(
  name: string,
  minimumLength = 24,
  maximumLength = 16_384,
): string {
  const value = process.env[name]?.trim();
  if (
    !value ||
    value.length < minimumLength ||
    value.length > maximumLength ||
    /\s/.test(value)
  ) {
    throw new CrmAiConfigError(name);
  }
  return value;
}

function positiveInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new CrmAiConfigError(name);
  }
  return value;
}

function modelName(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  if (!/^[A-Za-z0-9._:-]{2,120}$/.test(value)) {
    throw new CrmAiConfigError(name);
  }
  return value;
}

function reasoningEffort(
  name: string,
  fallback: CrmAiReasoningEffort,
): CrmAiReasoningEffort {
  const value = (process.env[name]?.trim().toLowerCase() || fallback) as string;
  if (!["none", "low", "medium", "high", "xhigh", "max"].includes(value)) {
    throw new CrmAiConfigError(name);
  }
  return value as CrmAiReasoningEffort;
}

export function isCrmAiShadowEnabled(): boolean {
  return process.env.CRM_AI_SHADOW_ENABLED?.trim().toLowerCase() === "true";
}

export function getCrmAiQueueConfig() {
  return {
    batchSize: positiveInteger("CRM_AI_BATCH_SIZE", 5, 1, 25),
    leaseSeconds: positiveInteger("CRM_AI_LEASE_SECONDS", 180, 30, 600),
    concurrency: positiveInteger("CRM_AI_CONCURRENCY", 2, 1, 5),
  };
}

export function getCrmAiOpenAiConfig() {
  return {
    apiKey: requiredSecret("OPENAI_API_KEY", 32, 16_384),
    agentModel: modelName("OPENAI_AGENT_MODEL", "gpt-5.6-sol"),
    agentReasoning: reasoningEffort("OPENAI_AGENT_REASONING", "medium"),
    supervisorModel: modelName("OPENAI_SUPERVISOR_MODEL", "gpt-5.6-sol"),
    supervisorReasoning: reasoningEffort("OPENAI_SUPERVISOR_REASONING", "high"),
    requestTimeoutMs: positiveInteger(
      "OPENAI_REQUEST_TIMEOUT_MS",
      25_000,
      3_000,
      60_000,
    ),
  };
}

export function getCrmAiWorkerToken(): string {
  const direct = process.env.CRM_AI_WORKER_TOKEN?.trim();
  if (direct && direct.length >= 32 && direct.length <= 512 && !/\s/.test(direct)) {
    return direct;
  }
  const cronSecret = process.env.CRON_SECRET?.trim();
  if (
    cronSecret &&
    cronSecret.length >= 32 &&
    cronSecret.length <= 512 &&
    !/\s/.test(cronSecret)
  ) {
    return cronSecret;
  }
  throw new CrmAiConfigError("CRM_AI_WORKER_TOKEN");
}
