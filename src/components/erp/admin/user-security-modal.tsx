"use client";

import { useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { Membership, Profile } from "../types";
import type { AdminProps } from "../views-admin";
import { roleLabels } from "../utils";

type SecurityMode = "password" | "delete";

type AdminApiResult = {
  error?: string;
  message?: string;
  auditWarning?: boolean;
  code?: string;
  supportReference?: string;
};

type SecurityFeedback = {
  title: string;
  detail: string;
  reference?: string;
};

function requestFailure(
  response: Response,
  result: AdminApiResult,
): SecurityFeedback {
  const detail =
    result.error || "O servidor não forneceu detalhes sobre esta tentativa.";
  const reference = result.supportReference;

  switch (result.code) {
    case "SESSION_REQUIRED":
    case "SESSION_EXPIRED":
      return {
        title: "Sua sessão administrativa expirou.",
        detail: "Entre novamente na plataforma antes de repetir a operação.",
        reference,
      };
    case "ADMIN_REAUTH_REQUIRED":
      return {
        title: "Confirmação do administrador necessária.",
        detail,
        reference,
      };
    case "ADMIN_REAUTH_FAILED":
      return {
        title: "Senha de administrador não confirmada.",
        detail:
          "Confira a senha da conta que está conectada. A credencial do usuário selecionado não foi alterada.",
        reference,
      };
    case "PASSWORD_POLICY":
      return {
        title: "A nova senha não atende à política de segurança.",
        detail,
        reference,
      };
    case "RATE_LIMITED":
      return {
        title: "Limite temporário de segurança atingido.",
        detail,
        reference,
      };
    case "ADMIN_SERVICE_UNAVAILABLE":
      return {
        title: "Serviço administrativo temporariamente indisponível.",
        detail:
          "A configuração segura do servidor precisa ser concluída. Nenhuma nova credencial foi aplicada nesta tentativa.",
        reference,
      };
    case "ADMIN_OPERATION_FAILED":
      return {
        title: "A conclusão da operação não pôde ser confirmada.",
        detail,
        reference,
      };
    default:
      if (response.status === 401) {
        return {
          title: "Validação administrativa não concluída.",
          detail,
          reference,
        };
      }
      if (response.status === 403) {
        return {
          title: "Ação não autorizada.",
          detail,
          reference,
        };
      }
      if (response.status === 429) {
        return {
          title: "Muitas tentativas em pouco tempo.",
          detail,
          reference,
        };
      }
      if (response.status >= 500) {
        return {
          title: "O serviço não conseguiu concluir a operação.",
          detail,
          reference,
        };
      }
      return {
        title: "Revise os dados informados.",
        detail,
        reference,
      };
  }
}

async function readAdminResult(response: Response): Promise<AdminApiResult> {
  try {
    return (await response.json()) as AdminApiResult;
  } catch {
    return {
      error:
        response.status >= 500
          ? "O serviço administrativo retornou uma resposta inválida. Tente novamente mais tarde."
          : "Não foi possível interpretar a resposta da operação.",
      code:
        response.status >= 500 ? "ADMIN_OPERATION_FAILED" : undefined,
    };
  }
}

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
  const [error, setError] = useState<SecurityFeedback | null>(null);
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
    setError(null);
    if (data.membership.role !== "admin") {
      setError({
        title: "Ação não autorizada.",
        detail: "Somente o administrador pode executar esta ação.",
      });
      return;
    }
    if (action === "change_password" && password !== passwordConfirmation) {
      setError({
        title: "Revise a nova senha.",
        detail: "A confirmação da nova senha não confere.",
      });
      return;
    }
    if (action === "delete_profile" && deleteConfirmation !== "EXCLUIR") {
      setError({
        title: "Confirmação de exclusão incompleta.",
        detail: "Digite EXCLUIR para confirmar a remoção.",
      });
      return;
    }
    if (!administratorPassword) {
      setError({
        title: "Confirmação do administrador necessária.",
        detail: "Informe a senha da conta administrativa conectada.",
      });
      return;
    }

    setBusy(true);
    try {
      const supabase = getSupabase();
      if (!supabase) {
        throw new Error(
          "O serviço de autenticação está indisponível neste navegador. Atualize a página e tente novamente.",
        );
      }
      const session = (await supabase.auth.getSession()).data.session;
      if (!session) {
        setError({
          title: "Sua sessão administrativa expirou.",
          detail: "Entre novamente na plataforma antes de repetir a operação.",
        });
        return;
      }

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
      const result = await readAdminResult(response);
      if (!response.ok) {
        setError(requestFailure(response, result));
        return;
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
      setError({
        title: "Não foi possível comunicar com o serviço administrativo.",
        detail:
          caught instanceof Error
            ? caught.message
            : "Verifique sua conexão e tente novamente. Nenhuma conclusão foi confirmada.",
      });
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
        aria-busy={busy}
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
            disabled={busy}
            onClick={() => {
              setMode("password");
              setError(null);
            }}
          >
            Alterar senha
          </button>
          <button
            type="button"
            className={mode === "delete" ? "active danger" : ""}
            disabled={busy}
            onClick={() => {
              setMode("delete");
              setError(null);
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
                disabled={busy}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Mínimo de 12 caracteres"
                aria-describedby="new-password-requirements"
                aria-invalid={password.length > 0 && !passwordIsStrong}
              />
            </label>
            <label>
              Confirmar nova senha
              <input
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
                maxLength={128}
                disabled={busy}
                value={passwordConfirmation}
                onChange={(event) =>
                  setPasswordConfirmation(event.target.value)
                }
              />
            </label>
            <label className="user-password-toggle">
              <input
                type="checkbox"
                disabled={busy}
                checked={showPassword}
                onChange={(event) => setShowPassword(event.target.checked)}
              />
              Exibir a senha durante a conferência
            </label>
            <small
              id="new-password-requirements"
              className={`user-password-rule${password && passwordIsStrong ? " valid" : ""}`}
            >
              Use maiúscula, minúscula, número e símbolo. A administração nunca
              consegue recuperar a senha anterior.
              {password && passwordIsStrong && " A nova senha atende aos requisitos."}
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
                disabled={isCurrent || busy}
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
              disabled={busy}
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

        {busy && (
          <div className="user-security-progress" role="status" aria-live="polite">
            <span aria-hidden="true" />
            <div>
              <strong>
                {mode === "password"
                  ? "Validando e alterando a credencial..."
                  : "Validando e revogando o acesso..."}
              </strong>
              <small>Não feche esta janela até a confirmação final.</small>
            </div>
          </div>
        )}

        {error && (
          <div
            className="feedback error user-security-feedback"
            role="alert"
            aria-live="assertive"
          >
            <strong>{error.title}</strong>
            <span>{error.detail}</span>
            {error.reference && (
              <small>Referência para suporte: {error.reference}</small>
            )}
          </div>
        )}

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
