export const brokerSections = ["leads", "salesmap", "agenda", "materials"] as const;
export type BrokerSection = (typeof brokerSections)[number];

export function isBrokerSection(value: string): value is BrokerSection {
  return (brokerSections as readonly string[]).includes(value);
}

export function isPublicWorkspacePath(path: string) {
  return ["/privacidade", "/politica-de-privacidade", "/arisa/privacidade", "/reset-password", "/parceiro", "/solaris/atendimento"].includes(path)
    || ["/cliente/", "/parceiro/", "/proposta/", "/contrato/", "/verificar/", "/atendimento/", "/assinar/"].some(prefix => path.startsWith(prefix));
}

export function canBrokerUsePermission(key: string) {
  return key === "crm.view" || key === "crm.attend";
}
