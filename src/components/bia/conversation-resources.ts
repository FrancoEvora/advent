import type { PublicAgentAttachment, PublicAgentResources, PublicAgentSimulation } from "../../lib/public-agent/types";

export function collectBiaResources(resources: PublicAgentResources[]) {
  const simulations = new Map<string, PublicAgentSimulation>();
  const attachments = new Map<string, PublicAgentAttachment>();
  for (const resource of resources) {
    if (resource.simulation) simulations.set(JSON.stringify(resource.simulation), resource.simulation);
    for (const attachment of resource.attachments || []) {
      if (!attachment.url) continue;
      try {
        const url = new URL(attachment.url);
        if (url.protocol === "https:") attachments.set(url.href, attachment);
      } catch { /* Ignore unavailable or unsafe resource URLs. */ }
    }
  }
  return { simulations: [...simulations.values()], attachments: [...attachments.values()] };
}
