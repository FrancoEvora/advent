"use client";

import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import Image from "next/image";
import Link from "next/link";
import { getSupabase } from "@/lib/supabase";
import type { Membership, Organization, Profile, Project, Role } from "../types";

type PermissionRow = {
  role: Role;
  permission_key: string;
  allowed: boolean;
};

export type StandaloneModuleContext = {
  session: Session;
  organization: Organization;
  membership: Membership;
  profile: Profile | null;
  projects: Project[];
  members: Membership[];
  profiles: Profile[];
  can: (permission: string) => boolean;
};

export function ModuleShell({
  title,
  eyebrow,
  children,
}: {
  title: string;
  eyebrow: string;
  children: (context: StandaloneModuleContext) => React.ReactNode;
}) {
  const [ctx, setCtx] = useState<StandaloneModuleContext | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      const client = getSupabase();
      if (!client) {
        setError("Supabase indisponível.");
        return;
      }
      const { data: { session } } = await client.auth.getSession();
      if (!session) {
        location.href = "/";
        return;
      }
      const { data: membership, error: membershipError } = await client
        .from("organization_members")
        .select("*")
        .eq("user_id", session.user.id)
        .eq("active", true)
        .limit(1)
        .maybeSingle();
      if (membershipError || !membership) {
        setError(membershipError?.message || "Usuário sem organização ativa.");
        return;
      }

      const organizationId = membership.organization_id;
      const [organization, profile, projects, members, profiles, permissionRows] = await Promise.all([
        client.from("organizations").select("*").eq("id", organizationId).single(),
        client.from("profiles").select("*").eq("id", session.user.id).maybeSingle(),
        client.from("projects").select("*").eq("organization_id", organizationId).order("name"),
        client.from("organization_members").select("*").eq("organization_id", organizationId).eq("active", true),
        client.from("profiles").select("*"),
        client.from("role_permissions").select("role,permission_key,allowed").eq("organization_id", organizationId),
      ]);
      const failed = [organization, projects, members, permissionRows].find(result => result.error);
      if (failed?.error) {
        setError(failed.error.message);
        return;
      }

      const rows = (permissionRows.data || []) as PermissionRow[];
      const can = (permission: string) => {
        if (membership.role === "admin") return true;
        if (Object.prototype.hasOwnProperty.call(membership.permissions || {}, permission)) {
          return membership.permissions[permission] === true;
        }
        return rows.some(row =>
          row.role === membership.role
          && row.permission_key === permission
          && row.allowed,
        );
      };

      setCtx({
        session,
        organization: organization.data,
        membership,
        profile: profile.data,
        projects: projects.data || [],
        members: members.data || [],
        profiles: profiles.data || [],
        can,
      });
    })();
  }, []);

  if (error) return <div className="standalone-error"><Image src="/evora-brand.svg" alt="Évora Urbanismo" width={180} height={60} priority /><h1>Não foi possível abrir o módulo</h1><p>{error}</p><Link href="/">Voltar à plataforma</Link></div>;
  if (!ctx) return <div className="splash"><Image src="/evora-brand.svg" alt="Évora Urbanismo" width={180} height={60} priority /><div className="spinner" /><p>Preparando módulo...</p></div>;
  return <div className="standalone-module"><header><div><small>{eyebrow}</small><h1>{title}</h1><p>{ctx.organization.trade_name || ctx.organization.name}</p></div><Link href="/">Voltar ao ERP</Link></header><main>{children(ctx)}</main></div>;
}
