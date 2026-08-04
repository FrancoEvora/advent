"use client";

import { useMemo, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { Membership, Profile, Role } from "../types";
import type { AdminProps } from "../views-admin";
import { roleLabels, shortDate } from "../utils";
import { Empty, PanelTitle } from "../views-dashboard";
import { InviteModal } from "./invite-modal";
import { ProfileAvatar, ProfilePhotoModal } from "./profile-photo";
import { RolePermissionsView } from "./role-permissions-view";
import { UserSecurityModal } from "./user-security-modal";

type SecurityTarget = { member: Membership; profile?: Profile };

export function UsersView({ data, mutate }: AdminProps) {
  const [tab, setTab] = useState<"users" | "permissions">("users");
  const [invite, setInvite] = useState(false);
  const [photo, setPhoto] = useState<Profile | null>(null);
  const [security, setSecurity] = useState<SecurityTarget | null>(null);
  const profileMap = useMemo(
    () => new Map(data.profiles.map((profile) => [profile.id, profile])),
    [data.profiles],
  );
  const isAdministrator = data.membership.role === "admin";

  const update = async (
    member: Membership,
    action: "change_role" | "set_active",
    payload: Record<string, unknown>,
    success: string,
  ) =>
    mutate(async () => {
      const supabase = getSupabase();
      if (!supabase) throw new Error("Supabase indisponível.");
      const session = (await supabase.auth.getSession()).data.session;
      if (!session) throw new Error("A sessão expirou. Entre novamente.");
      const response = await fetch("/api/admin/users", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + session.access_token,
        },
        body: JSON.stringify({
          organizationId: data.organization.id,
          userId: member.user_id,
          action,
          ...payload,
        }),
      });
      const result = (await response.json()) as {
        error?: string;
      };
      if (!response.ok) {
        throw new Error(result.error || "A alteração de acesso falhou.");
      }
    }, success);

  return (
    <div className="stack">
      <section className="module-toolbar">
        <div>
          <small>CONTROLE DE ACESSO</small>
          <h2>Equipe, perfis e credenciais</h2>
          <p>
            Administre usuários, papéis, permissões por módulo e o ciclo
            completo de credenciais.
          </p>
        </div>
        {tab === "users" && isAdministrator && (
          <button className="primary" onClick={() => setInvite(true)}>
            + Convidar usuário
          </button>
        )}
      </section>

      <nav className="module-tabs">
        <button
          className={tab === "users" ? "active" : ""}
          onClick={() => setTab("users")}
        >
          Usuários e convites
        </button>
        <button
          className={tab === "permissions" ? "active" : ""}
          onClick={() => setTab("permissions")}
        >
          Perfis e permissões
        </button>
      </nav>

      {tab === "permissions" ? (
        <RolePermissionsView
          data={data}
          reload={async () => location.reload()}
        />
      ) : (
        <>
          <section className="panel">
            <PanelTitle
              eyebrow="USUÁRIOS DA ORGANIZAÇÃO"
              title="Membros, credenciais e acessos"
            />
            <div className="users-list users-list-v3">
              {data.members.map((member) => {
                const profile = profileMap.get(member.user_id);
                const isCurrent =
                  member.user_id === data.session.user.id;
                return (
                  <article key={member.id}>
                    <ProfileAvatar
                      profile={profile}
                      organizationId={data.organization.id}
                    />
                    <div>
                      <strong>
                        {profile?.full_name || "Usuário cadastrado"}
                      </strong>
                      <small>
                        {profile?.email ||
                          (isCurrent
                            ? data.session.user.email
                            : "E-mail não disponível")}{" "}
                        ·{" "}
                        {member.active
                          ? "Acesso ativo"
                          : "Acesso suspenso"}
                      </small>
                    </div>
                    <select
                      value={member.role}
                      disabled={
                        !isAdministrator ||
                        (isCurrent && member.role === "admin")
                      }
                      aria-label={`Perfil de ${profile?.full_name || "usuário"}`}
                      onChange={(event) =>
                        update(
                          member,
                          "change_role",
                          { role: event.target.value as Role },
                          "Perfil atualizado.",
                        )
                      }
                    >
                      {Object.entries(roleLabels).map(
                        ([value, label]) => (
                          <option key={value} value={value}>
                            {label}
                          </option>
                        ),
                      )}
                    </select>
                    <div className="user-actions">
                      {profile && isCurrent && (
                        <button onClick={() => setPhoto(profile)}>
                          Foto
                        </button>
                      )}
                      {isAdministrator && (
                        <button
                          className="user-security-button"
                          onClick={() =>
                            setSecurity({ member, profile })
                          }
                        >
                          Senha e perfil
                        </button>
                      )}
                      {isCurrent && !isAdministrator && (
                        <a
                          className="button-link"
                          href="/reset-password"
                        >
                          Alterar minha senha
                        </a>
                      )}
                      {isAdministrator && !isCurrent && (
                        <button
                          onClick={() =>
                            update(
                              member,
                              "set_active",
                              { active: !member.active },
                              member.active
                                ? "Acesso suspenso."
                                : "Acesso reativado.",
                            )
                          }
                        >
                          {member.active ? "Suspender" : "Reativar"}
                        </button>
                      )}
                    </div>
                  </article>
                );
              })}
            </div>
          </section>

          <section className="panel">
            <PanelTitle
              eyebrow="POLÍTICA DE CREDENCIAIS"
              title="Segurança dos acessos"
            />
            <div className="security-policy-grid">
              <article>
                <b>01</b>
                <strong>Senha protegida</strong>
                <p>
                  A administração pode definir uma nova credencial, mas
                  nunca visualiza nem recupera a senha anterior.
                </p>
              </article>
              <article>
                <b>02</b>
                <strong>Exclusão controlada</strong>
                <p>
                  O perfil e o login são removidos sem apagar
                  lançamentos, auditorias ou histórico empresarial.
                </p>
              </article>
              <article>
                <b>03</b>
                <strong>Perfis e alçadas</strong>
                <p>
                  Permissões detalhadas por módulo e ação, com exceções
                  individuais e acesso integral do administrador.
                </p>
              </article>
            </div>
          </section>

          <section className="panel">
            <PanelTitle eyebrow="CONVITES" title="Acessos pendentes" />
            <div className="card-table">
              {data.invitations.map((item) => (
                <article key={item.id}>
                  <div className="avatar-square">✉</div>
                  <div>
                    <strong>{item.full_name || item.email}</strong>
                    <small>
                      {item.email} · {roleLabels[item.role]}
                    </small>
                  </div>
                  <span
                    className={
                      item.accepted_at ? "active-dot" : "inactive-dot"
                    }
                  >
                    {item.accepted_at ? "Aceito" : "Pendente"}
                  </span>
                  <div>
                    <small>
                      Expira em{" "}
                      {shortDate.format(new Date(item.expires_at))}
                    </small>
                  </div>
                </article>
              ))}
              {!data.invitations.length && (
                <Empty text="Nenhum convite enviado." />
              )}
            </div>
          </section>
        </>
      )}

      {invite && (
        <InviteModal
          data={data}
          close={() => setInvite(false)}
          mutate={mutate}
        />
      )}
      {photo && (
        <ProfilePhotoModal
          data={data}
          profile={photo}
          close={() => setPhoto(null)}
          mutate={mutate}
        />
      )}
      {security && (
        <UserSecurityModal
          data={data}
          member={security.member}
          profile={security.profile}
          close={() => setSecurity(null)}
          mutate={mutate}
        />
      )}
    </div>
  );
}
