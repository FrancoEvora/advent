export const workspacePanels = ["whatsapp-conversations", "leads", "simulations", "email", "agenda", "whatsapp", "archive", "memory"] as const;
export type WorkspacePanel = typeof workspacePanels[number];
export const workspaceLabels: Record<WorkspacePanel, string> = {
  "whatsapp-conversations": "Conversas do WhatsApp", leads: "Leads e funil", simulations: "Simulações", email: "E-mail", agenda: "Agenda e Meet", whatsapp: "WhatsApp", archive: "Arquivo", memory: "Memória",
};

export function assistantWorkspacePanels(assistant: "arisa" | "bia") {
  return workspacePanels.filter(key => assistant === "bia" ? key !== "whatsapp-conversations" : !["leads", "simulations"].includes(key));
}

export function workspaceLabel(panel: WorkspacePanel, assistant: "arisa" | "bia" = "arisa", includeAssistant = false) {
  if (panel === "whatsapp" && assistant === "bia") return "Conversas da Bia";
  return workspaceLabels[panel] + (includeAssistant ? ` da ${assistant === "bia" ? "Bia" : "Arisa"}` : "");
}

export function workspacePanel(value: unknown): WorkspacePanel | null {
  return typeof value === "string" && workspacePanels.some(panel => panel === value) ? value as WorkspacePanel : null;
}

export function workspaceUrl(panel: WorkspacePanel | null, threadId: string | null = null, assistant: "arisa" | "bia" = "arisa") {
  const query = new URLSearchParams();
  if (threadId) query.set("conversa", threadId);
  if (panel) query.set("painel", panel);
  return `/${assistant}${query.size ? `?${query}` : ""}`;
}
