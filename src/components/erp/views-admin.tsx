"use client";
import type { ErpData, ViewId } from "./types";
import { ApprovalsView } from "./admin-approvals";
import { UsersView } from "./admin-users";
import { ReportsView } from "./admin-reports";
import { AuditView } from "./admin-audit";
import { SettingsView } from "./admin-settings";
import type { ActivityDeepLinkTarget } from "./activities/activity-links";

export type AdminProps = { data: ErpData; mutate: (operation: () => Promise<void>, success: string) => Promise<void>; can?: (permission: string) => boolean; focus?: ActivityDeepLinkTarget | null };
export function AdminView({ mode, data, mutate, can, focus }: AdminProps & { mode: ViewId }) {
  if (mode === "aprovacoes") return <ApprovalsView data={data} mutate={mutate} focus={focus} />;
  if (mode === "usuarios") return <UsersView data={data} mutate={mutate} />;
  if (mode === "relatorios") return <ReportsView data={data} can={can} />;
  if (mode === "auditoria") return <AuditView data={data} />;
  return <SettingsView data={data} mutate={mutate} />;
}
