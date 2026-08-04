"use client";

import { useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { Membership, Profile } from "../types";
import type { AdminProps } from "../views-admin";
import { roleLabels } from "../utils";

type SecurityMode = "password" | "delete";

export function UserSecurityModal({
  data,
  member,
  profile,
  close,
  mutate,
}: AdminProps & {
  member: Membership;
  profile?: Profile;
  close: () => void;
}) {
  const [mode, setMode] = useState<SecurityMode>("password");
  const [password, setPassword] = useState("");
  const [passwordConfirmation, setPasswordConfirmation] = useState("");
  const [deleteConfirmation, setDeleteConfirmation] = useState("");
  const [administratorPassword, setAdministratorPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const isCurrent = member.user_id === data.session.user.id;
  const displayName =
    profile?.full_name || profile?.email || "Usuário cadastrado";
  const passwordIsStrong =
    password.length >= 12 &&
    /[a-z]/.test(password) &&
    /[A-Z]/.test(password) &&
    /\d/.test(password) &&
    /[^A-Za-z0-9]/.test(password);

  async function request(action: "change_password" | "delete_profile") {
    setError("");
    if (data.membership.role !== "admin") {
      setError("Somente o administrador pode executar esta ação.");
      return;
    }
    if (action === "change_password" && password !== passwordConfirmation) {
      setError("A confirmação da nova senha não confere.");
      return;
    }
    if (action === "delete_profile" && deleteConfirmation !== "EXCLUIR") {
      setError("Digite EXCLUIR para confirmar a remoção.");
      return;
    }
    if (!administratorPassword) {
      setError("Confirme sua senha de administrador.");
      return;
    }

    setBusy(true);
    try {
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
          password: action === "change_password" ? password : undefined,
          administratorPassword,
          confirmation:
            action === "delete_profile" ? deleteConfirmation : undefined,
        }),
      });
      const result = (await response.json()) as {
        error?: string;
        message?: string;
        auditWarning?: boolean;
      };
      if (!response.ok) {
        throw new Error(result.error || "A ação administrativa falhou.");
      }

      await mutate(
        async () => Promise.resolve(),
        (result.message ||
          (action === "change_password"
            ? "Senha de " + displayName + " alterada."
            : "Perfil de " + displayName + " excluído e histórico preservado.")) +
          (result.auditWarning
            ? " Atenção: a senha foi alterada, mas a confirmação final da auditoria deve ser revisada."
            : ""),
      );
      close();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível concluir a ação.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={() => {
        if (!busy) close();
      }}
    >
      <section
        className="modal user-security-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-security-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="modal-close"
          type="button"
          aria-label="Fechar gestão de segurança"
          disabled={busy}
          onClick={close}
        >
          ×
        </button>
        <header>
          <small>SEGURANÇA E CICLO DE ACESSO</small>
          <h2 id="user-security-title">Gerenciar {displayName}</h2>
          <p>
            {profile?.email || "E-mail não disponível"} ·{" "}
            {roleLabels[member.role]}
          </p>
        </header>

        <nav className="user-security-tabs" aria-label="Ações do usuário">
          <button
            type="button"
            className={mode === "password" ? "active" : ""}
            onClick={() => {
              setMode("password");
              setError("");
            }}
          >
            Alterar senha
          </button>
          <button
            type="button"
            className={mode === "delete" ? "active danger" : ""}
            onClick={() => {
              setMode("delete");
              setError("");
            }}
          >
            Excluir perfil
          </button>
        </nav>

        {mode === "password" ? (
          <div className="user-security-content">
            <div className="user-security-callout">
              <b>Nova credencial administrativa</b>
              <p>
                A senha não será exibida nem armazenada pela Évora. Informe-a
                ao usuário por um canal seguro.
              </p>
            </div>
            <label>
              Nova senha
              <input
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                maxLength={128}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Mínimo de 12 caracteres"
              />
            </label>
            <label>
              Confirmar nova senha
              <input
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                maxLength={128}
                value={passwordConfirmation}
                onChange={(event) =>
                  setPasswordConfirmation(event.target.value)
                }
              />
            </label>
            <label className="user-password-toggle">
              <input
                type="checkbox"
                checked={showPassword}
                onChange={(event) => setShowPassword(event.target.checked)}
              />
              Exibir a senha durante a conferência
            </label>
            <small className="user-password-rule">
              Use maiúscula, minúscula, número e símbolo. A administração nunca
              consegue recuperar a senha anterior.
              {isCurrent &&
                " Por segurança, entre novamente com a nova senha nos seus outros dispositivos."}
            </small>
          </div>
        ) : (
          <div className="user-security-content danger-zone">
            <div className="user-security-callout danger">
              <b>
                {isCurrent
                  ? "Seu próprio perfil está protegido"
                  : "Exclusão controlada"}
              </b>
              <p>
                {isCurrent
                  ? "O administrador conectado não pode excluir o próprio perfil."
                  : "O login e o perfil serão removidos. Designações abertas serão encerradas, mas auditorias, lançamentos e histórico empresarial permanecerão íntegros."}
              </p>
            </div>
            <label>
              Confirmação
              <input
                value={deleteConfirmation}
                disabled={isCurrent}
                onChange={(event) =>
                  setDeleteConfirmation(event.target.value)
                }
                placeholder="Digite EXCLUIR"
              />
            </label>
          </div>
        )}

        <div className="user-security-reauth">
          <label>
            Confirme sua senha de administrador
            <input
              type="password"
              autoComplete="current-password"
              maxLength={128}
              value={administratorPassword}
              onChange={(event) =>
                setAdministratorPassword(event.target.value)
              }
              placeholder="Validação obrigatória desta operação"
            />
          </label>
          <small>
            Esta confirmação protege alterações de senha e exclusões mesmo
            quando uma sessão administrativa fica aberta em outro dispositivo.
          </small>
        </div>

        {error && <div className="feedback error">{error}</div>}

        <footer>
          <button type="button" disabled={busy} onClick={close}>
            Cancelar
          </button>
          {mode === "password" ? (
            <button
              type="button"
              className="primary"
              disabled={
                busy ||
                !passwordIsStrong ||
                password !== passwordConfirmation ||
                !administratorPassword
              }
              onClick={() => request("change_password")}
            >
              {busy ? "Alterando..." : "Confirmar nova senha"}
            </button>
          ) : (
            <button
              type="button"
              className="danger-button"
              disabled={
                busy ||
                isCurrent ||
                deleteConfirmation !== "EXCLUIR" ||
                !administratorPassword
              }
              onClick={() => request("delete_profile")}
            >
              {busy ? "Excluindo..." : "Excluir perfil e revogar acesso"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}
