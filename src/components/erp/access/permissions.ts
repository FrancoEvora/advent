import type { ErpData, PermissionMap, Role } from "../types";

export const permissionCatalog = [
  { key: "dashboard.view", label: "Visão executiva", group: "Gestão" },
  { key: "crm.view", label: "Acessar CRM", group: "CRM" },
  { key: "crm.manage", label: "Editar leads, funis e propostas", group: "CRM" },
  { key: "post_sale.view", label: "Acessar Pós-venda", group: "Pós-venda" },
  { key: "post_sale.manage", label: "Gerenciar carteira e atendimento", group: "Pós-venda" },
  { key: "portal.manage", label: "Configurar e compartilhar portal", group: "Pós-venda" },
  { key: "finance.view", label: "Consultar financeiro", group: "Financeiro" },
  { key: "finance.manage", label: "Criar e editar lançamentos", group: "Financeiro" },
  { key: "cash.view", label: "Consultar fluxo de caixa", group: "Financeiro" },
  { key: "approvals.manage", label: "Aprovar operações", group: "Financeiro" },
  { key: "procurement.manage", label: "Compras e contratações", group: "Operações" },
  { key: "hr.manage", label: "Gestão de RH", group: "Operações" },
  { key: "documents.manage", label: "Documentos e anexos", group: "Operações" },
  { key: "masters.manage", label: "Cadastros e empreendimentos", group: "Cadastros" },
  { key: "users.manage", label: "Usuários e perfis", group: "Administração" },
  { key: "reports.view", label: "Relatórios", group: "Administração" },
  { key: "audit.view", label: "Auditoria", group: "Administração" },
  { key: "settings.manage", label: "Configurações", group: "Administração" },
  { key: "migration.manage", label: "Migração de dados", group: "Administração" },
  { key: "backup.manage", label: "Backup e continuidade", group: "Administração" },
  { key: "database.reset", label: "Reinicializar base", group: "Administração" },
] as const;

export type PermissionKey = (typeof permissionCatalog)[number]["key"];

export function rolePermissions(data: ErpData, role: Role): PermissionMap {
  return data.rolePermissionProfiles.find((profile) => profile.role === role)?.permissions || {};
}

export function effectivePermissions(data: ErpData): PermissionMap {
  if (data.membership.role === "admin") return Object.fromEntries(permissionCatalog.map((item) => [item.key, true]));
  return { ...rolePermissions(data, data.membership.role), ...(data.membership.permissions || {}) };
}

export function hasPermission(data: ErpData, permission: PermissionKey): boolean {
  return effectivePermissions(data)[permission] === true;
}
