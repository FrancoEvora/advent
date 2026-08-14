import { randomUUID } from "node:crypto";

import { CrmAiConfigError, getCrmAiQueueConfig } from "./config";
import {
  claimCrmAiJobs,
  completeCrmAiShadowJob,
  CrmAiGatewayError,
  failCrmAiJob,
  loadCrmAiLeadContext,
} from "./gateway";
import { CrmAiModelError, generateSupervisedShadowDraft } from "./openai";
import type { ClaimedCrmAiJob } from "./types";

export type CrmAiProcessingResult = {
  claimed: number;
  completed: number;
  blocked: number;
  failed: number;
  retryable: number;
};

type SafeFailure = {
  code: string;
  message: string;
  retryable: boolean;
};

function safeFailure(error: unknown): SafeFailure {
  if (error instanceof CrmAiModelError) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof CrmAiGatewayError) {
    return {
      code: error.code,
      message: "A persistência ou leitura do agente IA não foi concluída.",
      retryable: error.retryable,
    };
  }
  if (error instanceof CrmAiConfigError) {
    return {
      code: error.code,
      message: "A configuração server-side do agente IA está incompleta.",
      retryable: true,
    };
  }
  return {
    code: "CRM_AI_UNEXPECTED_FAILURE",
    message: "O agente IA encontrou uma falha não classificada.",
    retryable: true,
  };
}

async function processJob(
  job: ClaimedCrmAiJob,
): Promise<"completed" | "blocked" | "failed" | "retryable"> {
  try {
    if (job.mode !== "shadow") {
      await failCrmAiJob(job, {
        code: "CRM_AI_MODE_NOT_ENABLED",
        message: "O worker atual aceita apenas modo sombra.",
        retryable: false,
      });
      return "failed";
    }

    const context = await loadCrmAiLeadContext(job);
    const result = await generateSupervisedShadowDraft(context);
    await completeCrmAiShadowJob(job, result);
    return result.decision === "block" ? "blocked" : "completed";
  } catch (error) {
    const failure = safeFailure(error);
    try {
      await failCrmAiJob(job, failure);
    } catch (failError) {
      console.error("CRM AI job failure could not be persisted", {
        jobId: job.id,
        failureCode: failure.code,
        persistenceError:
          failError instanceof Error ? failError.name : "UnknownError",
      });
    }
    return failure.retryable ? "retryable" : "failed";
  }
}

export async function processCrmAiShadowQueue(options?: {
  limit?: number;
}): Promise<CrmAiProcessingResult> {
  const config = getCrmAiQueueConfig();
  const limit = Math.max(1, Math.min(options?.limit ?? config.batchSize, 25));
  const workerId = `evora-crm-ai-${randomUUID()}`;
  const jobs = await claimCrmAiJobs(workerId, limit, config.leaseSeconds);
  if (jobs.length === 0) {
    return { claimed: 0, completed: 0, blocked: 0, failed: 0, retryable: 0 };
  }

  let cursor = 0;
  const outcomes: Array<"completed" | "blocked" | "failed" | "retryable"> = [];
  const worker = async () => {
    while (cursor < jobs.length) {
      const job = jobs[cursor];
      cursor += 1;
      outcomes.push(await processJob(job));
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(config.concurrency, jobs.length) },
      () => worker(),
    ),
  );

  return {
    claimed: jobs.length,
    completed: outcomes.filter((outcome) => outcome === "completed").length,
    blocked: outcomes.filter((outcome) => outcome === "blocked").length,
    failed: outcomes.filter((outcome) => outcome === "failed").length,
    retryable: outcomes.filter((outcome) => outcome === "retryable").length,
  };
}
