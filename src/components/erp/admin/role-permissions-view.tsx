"use client";

import { useEffect, useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ErpData, Role } from "../types";
import {
  allPermissionKeys,
  permissionGroups,
  permissionItems,
  roleNames,
  roles,
} from "./permissions-config";

type Row = {
  id?: string;
  role: Role;
  permission_key: string;
  allowed: boolean;
};

const permissionByKey = new Map(
  permissionItems.map((permission) => [permission.key, permission]),
);

function requiredKeys(key: string, result = new Set<string>()) {
  permissionByKey.get(key)?.requires?.forEach((required) => {
    if (result.has(required)) return;
    result.add(required);
    requiredKeys(required, result);
  });
  return result;
}

function dependentKeys(key: string, result = new Set<string>()) {
  permissionItems.forEach((permission) => {
    if (!permission.requires?.includes(key) || result.has(permission.key)) return;
    result.add(permission.key);
    dependentKeys(permission.key, result);
  });
  return result;
}

function normalizePermissionMap(source: Record<string, boolean>) {
  const normalized = { ...source };
  Object.entries(normalized).forEach(([key, allowed]) => {
    if (!allowed) return;
    requiredKeys(key).forEach((required) => {
      normalized[required] = true;
    });
  });
  return normalized;
}

function normalizeOverridesForSave(
  source: Record<string, boolean | undefined>,
  inherited: Record<string, boolean>,
) {
  const normalized = Object.fromEntries(
    Object.entries(source).filter(([, value]) => typeof value === "boolean"),
  ) as Record<string, boolean>;

  Object.entries(normalized).forEach(([key, allowed]) => {
    if (allowed) return;
    dependentKeys(key).forEach((dependent) => {
      normalized[dependent] = false;
    });
  });

  const effective = { ...inherited, ...normalized };
  Object.entries(effective).forEach(([key, allowed]) => {
    if (!allowed) return;
    requiredKeys(key).forEach((required) => {
      if (effective[required]) return;
      normalized[required] = true;
      effective[required] = true;
    });
  });

  return normalized;
}

function updateRolePermission(
  rows: Row[],
  role: Role,
  permissionKey: string,
  allowed: boolean,
) {
  const existing = rows.find(
    (row) => row.role === role && row.permission_key === permissionKey,
  );
  if (existing) {
    return rows.map((row) =>
      row === existing ? { ...row, allowed } : row,
    );
  }
  return [
    ...rows,
    { role, permission_key: permissionKey, allowed },
  ];
}

export function RolePermissionsView({
  data,
  reload,
}: {
  data: ErpData;
  reload: () => Promise<void>;
}) {
  const [selectedRole, setSelectedRole] = useState<Role>("diretoria");
  const [rows, setRows] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [memberId, setMemberId] = useState("");
  const [overrides, setOverrides] = useState<
    Record<string, boolean | undefined>
  >({});

  async function load() {
    const client = getSupabase();
    if (!client) {
      setMessage("Supabase indisponível.");
      return;
    }
    const result = await client
      .from("role_permissions")
      .select("*")
      .eq("organization_id", data.organization.id);
    if (result.error) {
      setMessage(result.error.message);
      return;
    }
    setRows((result.data || []) as Row[]);
  }

  useEffect(() => {
    let active = true;
    const client = getSupabase();
    if (!client) return;
    void client
      .from("role_permissions")
      .select("*")
      .eq("organization_id", data.organization.id)
      .then((result) => {
        if (!active) return;
        if (result.error) {
          setMessage(result.error.message);
          return;
        }
        setRows((result.data || []) as Row[]);
      });
    return () => {
      active = false;
    };
  }, [data.organization.id]);

  const roleMap = useMemo<Record<string, boolean>>(
    () =>
      normalizePermissionMap(Object.fromEntries(
        rows
          .filter((row) => row.role === selectedRole)
          .map((row) => [row.permission_key, row.allowed]),
      )),
    [rows, selectedRole],
  );

  const allowedCount =
    selectedRole === "admin"
      ? allPermissionKeys.length
      : allPermissionKeys.filter((key) => roleMap[key]).length;

  const selectedMember = data.members.find(
    (member) => member.user_id === memberId,
  );
  const selectedMemberIsAdmin = selectedMember?.role === "admin";
  const selectedMemberRoleMap = useMemo(
    () =>
      normalizePermissionMap(
        Object.fromEntries(
          rows
            .filter((row) => row.role === selectedMember?.role)
            .map((row) => [row.permission_key, row.allowed]),
        ),
      ),
    [rows, selectedMember?.role],
  );

  function toggle(key: string, value: boolean) {
    setRows((current) => {
      let next = updateRolePermission(current, selectedRole, key, value);
      const related = value ? requiredKeys(key) : dependentKeys(key);
      related.forEach((relatedKey) => {
        next = updateRolePermission(
          next,
          selectedRole,
          relatedKey,
          value,
        );
      });
      return next;
    });
  }

  function updateOverride(
    key: string,
    value: "inherit" | "allow" | "deny",
  ) {
    setOverrides((current) => {
      const next = { ...current };
      if (value === "inherit") {
        delete next[key];
        return next;
      }
      const allowed = value === "allow";
      next[key] = allowed;
      const related = allowed ? requiredKeys(key) : dependentKeys(key);
      related.forEach((relatedKey) => {
        next[relatedKey] = allowed;
      });
      return next;
    });
  }

  function chooseMember(userId: string) {
    setMemberId(userId);
    const member = data.members.find((item) => item.user_id === userId);
    setOverrides(member?.permissions || {});
  }

  async function saveRole() {
    setBusy(true);
    setMessage("");
    const client = getSupabase();
    if (!client) {
      setBusy(false);
      setMessage("Supabase indisponível.");
      return;
    }
    const payload = allPermissionKeys.map((key) => ({
      organization_id: data.organization.id,
      role: selectedRole,
      permission_key: key,
      allowed:
        selectedRole === "admin"
          ? true
          : Boolean(roleMap[key]),
      updated_by: data.session.user.id,
      updated_at: new Date().toISOString(),
    }));
    const result = await client
      .from("role_permissions")
      .upsert(payload, {
        onConflict: "organization_id,role,permission_key",
      });
    setBusy(false);
    setMessage(
      result.error ? result.error.message : "Perfil salvo com sucesso.",
    );
    if (!result.error) {
      await load();
      await reload();
    }
  }

  async function saveUser() {
    if (!memberId || selectedMemberIsAdmin) return;
    setBusy(true);
    setMessage("");
    const client = getSupabase();
    if (!client) {
      setBusy(false);
      setMessage("Supabase indisponível.");
      return;
    }
    const clean = normalizeOverridesForSave(
      overrides,
      selectedMemberRoleMap,
    );
    const result = await client
      .from("organization_members")
      .update({
        permissions: clean,
        updated_at: new Date().toISOString(),
      })
      .eq("organization_id", data.organization.id)
      .eq("user_id", memberId);
    setBusy(false);
    setMessage(
      result.error
        ? result.error.message
        : "Exceções individuais salvas.",
    );
    if (!result.error) await reload();
  }

  return (
    <div className="permission-admin">
      <section className="admin-heading permission-heading">
        <div>
          <small>PERFIS E ALÇADAS</small>
          <h1>Níveis de acesso</h1>
          <p>
            Defina o que cada perfil pode visualizar, registrar, revisar e
            aprovar em cada setor. O administrador mantém acesso integral.
          </p>
        </div>
        <aside>
          <strong>{allPermissionKeys.length}</strong>
          <span>controles disponíveis</span>
        </aside>
      </section>

      {message && (
        <button className="notice" onClick={() => setMessage("")}>
          {message}
        </button>
      )}

      <section className="permission-layout">
        <aside className="role-selector">
          {roles.map((role) => (
            <button
              key={role}
              className={selectedRole === role ? "active" : ""}
              onClick={() => setSelectedRole(role)}
            >
              <strong>{roleNames[role]}</strong>
              <small>
                {data.members.filter((member) => member.role === role).length}{" "}
                usuário(s)
              </small>
            </button>
          ))}
        </aside>

        <article className="admin-card">
          <header>
            <div>
              <small>PERFIL SELECIONADO</small>
              <h2>{roleNames[selectedRole]}</h2>
              <p>
                {allowedCount} de {allPermissionKeys.length} controles
                habilitados
              </p>
            </div>
            <button
              className="primary"
              onClick={saveRole}
              disabled={busy || selectedRole === "admin"}
            >
              {selectedRole === "admin" ? "Acesso integral" : "Salvar perfil"}
            </button>
          </header>

          <p className="permission-dependency-note">
            Ao liberar uma operação, os acessos necessários para visualizá-la
            também são habilitados. Ao bloquear uma visualização, as operações
            dependentes são bloqueadas.
          </p>

          <div className="permission-groups">
            {permissionGroups.map((group) => (
              <section key={group.name}>
                <header>
                  <h3>{group.name}</h3>
                  <p>{group.description}</p>
                </header>
                {group.items.map((item) => (
                  <label key={item.key}>
                    <span>
                      <strong>{item.label}</strong>
                      {item.description && <em>{item.description}</em>}
                      <small>{item.key}</small>
                    </span>
                    <input
                      type="checkbox"
                      checked={selectedRole === "admin" || Boolean(roleMap[item.key])}
                      disabled={selectedRole === "admin"}
                      onChange={(event) => toggle(item.key, event.target.checked)}
                    />
                  </label>
                ))}
              </section>
            ))}
          </div>
        </article>
      </section>

      <section className="admin-card individual-permissions">
        <header>
          <div>
            <small>EXCEÇÕES INDIVIDUAIS</small>
            <h2>Personalização por usuário</h2>
            <p>
              Uma exceção individual substitui o perfil apenas para o usuário
              selecionado.
            </p>
          </div>
        </header>

        <label>
          Usuário
          <select
            value={memberId}
            onChange={(event) => chooseMember(event.target.value)}
          >
            <option value="">Selecione</option>
            {data.members.map((member) => {
              const profile = data.profiles.find(
                (item) => item.id === member.user_id,
              );
              return (
                <option
                  key={member.user_id}
                  value={member.user_id}
                  disabled={member.role === "admin"}
                >
                  {profile?.full_name || profile?.email || member.user_id} ·{" "}
                  {roleNames[member.role]}
                  {member.role === "admin" ? " · acesso integral" : ""}
                </option>
              );
            })}
          </select>
        </label>

        {memberId && !selectedMemberIsAdmin && (
          <div className="override-groups">
            {permissionGroups.map((group) => (
              <section key={group.name}>
                <h3>{group.name}</h3>
                <div className="override-grid">
                  {group.items.map((item) => (
                    <label key={item.key}>
                      <span>
                        <strong>{item.label}</strong>
                        <small>{item.key}</small>
                      </span>
                      <select
                        value={
                          overrides[item.key] === true
                            ? "allow"
                            : overrides[item.key] === false
                              ? "deny"
                              : "inherit"
                        }
                        onChange={(event) =>
                          updateOverride(
                            item.key,
                            event.target.value as
                              | "inherit"
                              | "allow"
                              | "deny",
                          )
                        }
                      >
                        <option value="inherit">Herdar do perfil</option>
                        <option value="allow">Permitir</option>
                        <option value="deny">Bloquear</option>
                      </select>
                    </label>
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}

        <button
          className="primary"
          disabled={!memberId || selectedMemberIsAdmin || busy}
          onClick={saveUser}
        >
          Salvar exceções
        </button>
      </section>
    </div>
  );
}
