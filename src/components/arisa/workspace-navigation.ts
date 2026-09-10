export const workspacePanels = ["leads", "simulations", "email", "agenda", "whatsapp", "archive", "memory"] as const;
export type WorkspacePanel = typeof workspacePanels[number];
export const workspaceLabels: Record<WorkspacePanel, string> = {
  leads: "Leads e funil", simulations: "Simulações", email: "E-mail", agenda: "Agenda e Meet", whatsapp: "WhatsApp", archive: "Arquivo", memory: "Memória",
};

export function workspacePanel(value: unknown): WorkspacePanel | null {
  return typeof value === "string" && workspacePanels.some(panel => panel === value) ? value as WorkspacePanel : null;
}

export function workspaceUrl(panel: WorkspacePanel | null, threadId: string | null = null, assistant: "arisa" | "bia" = "arisa") {
  const query = new URLSearchParams();
  if (threadId) query.set("conversa", threadId);
  if (panel) query.set("painel", panel);
  return `/${assistant}${query.size ? `?${query}` : ""}`;
}
