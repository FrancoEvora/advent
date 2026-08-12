"use client";

import { type FormEvent, useEffect, useMemo, useState } from "react";

import { getSupabase } from "@/lib/supabase";
import type {
  MetaCredentialState,
  MetaCredentialStatus,
} from "@/lib/integrations/meta/credential-contract";
import { Status } from "./shared";
import styles from "./meta-lead-settings.module.css";

type CredentialKind = "app_secret" | "verify_token" | "access_token" | "page_registration";

function dateLabel(value: string | null): string {
  return value ? new Date(value).toLocaleString("pt-BR") : "ainda não configurada";
}

function versionLabel(value: MetaCredentialState): string {
  return value.configured && value.version
    ? `versão ${value.version} · ${dateLabel(value.updatedAt || value.configuredAt)}`
    : dateLabel(null);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function sessionAuthorization(): Promise<string> {
  const client = getSupabase();
  if (!client) throw new Error("SUPABASE_UNAVAILABLE");
  const { data, error } = await client.auth.getSession();
  if (error || !data.session?.access_token) throw new Error("SESSION_EXPIRED");
  return `Bearer ${data.session.access_token}`;
}

async function credentialRequest(
  organizationId: string,
  options?: { method: "PUT" | "DELETE"; body: string },
  signal?: AbortSignal,
): Promise<MetaCredentialStatus> {
  const authorization = await sessionAuthorization();
  const response = await fetch(
    options
      ? "/api/integrations/meta/credentials"
      : `/api/integrations/meta/credentials?organizationId=${encodeURIComponent(organizationId)}`,
    {
      method: options?.method || "GET",
      headers: {
        Authorization: authorization,
        ...(options ? { "Content-Type": "application/json" } : {}),
      },
      ...(options ? { body: options.body } : {}),
      cache: "no-store",
      credentials: "same-origin",
      signal,
    },
  );
  let result: unknown = null;
  try {
    result = await response.json() as unknown;
  } catch {
    // A mensagem abaixo permanece genérica e não incorpora a resposta externa.
  }
  if (!response.ok || !isObject(result) || !isObject(result.status)) {
    const code = isObject(result) && typeof result.error === "string" ? result.error : "REQUEST_FAILED";
    throw new Error(code);
  }
  return result.status as unknown as MetaCredentialStatus;
}

function safeUiError(error: unknown): string {
  const code = error instanceof Error ? error.message : "REQUEST_FAILED";
  if (code === "SESSION_EXPIRED" || code === "SESSION_REQUIRED") {
    return "Sua sessão expirou. Entre novamente na plataforma.";
  }
  if (code === "INVALID_CREDENTIAL_VALUE") {
    return "Revise a credencial: ela não pode conter espaços e deve respeitar o tamanho mínimo.";
  }
  if (code === "INVALID_META_PAGE") return "Informe um Page ID numérico válido.";
  return "Não foi possível atualizar as credenciais Meta. Nenhum segredo foi exibido ou retornado.";
}

export function MetaCredentialSettings({
  organizationId,
  pageId,
  canManage,
  onStatusChange,
  reloadRoutes,
}: {
  organizationId: string;
  pageId: string;
  canManage: boolean;
  onStatusChange?: (status: MetaCredentialStatus) => void;
  reloadRoutes: () => Promise<void>;
}) {
  const [status, setStatus] = useState<MetaCredentialStatus | null>(null);
  const [busy, setBusy] = useState<"load" | "save" | CredentialKind | null>(
    canManage ? "load" : null,
  );
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!canManage) return;
    const controller = new AbortController();
    credentialRequest(organizationId, undefined, controller.signal)
      .then((nextStatus) => {
        setStatus(nextStatus);
        onStatusChange?.(nextStatus);
        setError("");
      })
      .catch((cause: unknown) => {
        if (cause instanceof Error && cause.name === "AbortError") return;
        setError(safeUiError(cause));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy(null);
      });
    return () => controller.abort();
  }, [canManage, onStatusChange, organizationId]);

  const currentPage = useMemo(
    () => status?.pages.find((item) => item.pageId === pageId) || null,
    [pageId, status?.pages],
  );

  async function saveCredentials(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManage) return;
    if (!/^\d{1,64}$/.test(pageId)) {
      setError("Informe um Page ID numérico válido na rota antes de cadastrar o token.");
      return;
    }
    const form = event.currentTarget;
    const formData = new FormData(form);
    const appSecret = String(formData.get("meta_app_secret") || "");
    const verifyToken = String(formData.get("meta_verify_token") || "");
    const accessToken = String(formData.get("meta_page_access_token") || "");
    const hasCredentialChange = Boolean(appSecret || verifyToken || accessToken);
    const requestBody = JSON.stringify({
      organizationId,
      pageId,
      ...(appSecret ? { appSecret } : {}),
      ...(verifyToken ? { verifyToken } : {}),
      ...(accessToken ? { accessToken } : {}),
    });
    form.reset();
    setBusy("save");
    setFeedback("");
    setError("");
    try {
      const nextStatus = await credentialRequest(organizationId, {
        method: "PUT",
        body: requestBody,
      });
      setStatus(nextStatus);
      onStatusChange?.(nextStatus);
      setFeedback(hasCredentialChange
        ? "Credenciais cadastradas ou rotacionadas. Os valores não podem ser consultados novamente."
        : `Página ${pageId} registrada no cofre. A rota permanece inativa até concluir a configuração.`);
    } catch (cause) {
      setError(safeUiError(cause));
    } finally {
      setBusy(null);
    }
  }

  async function revokeCredential(credential: CredentialKind) {
    if (!canManage) return;
    const label = credential === "app_secret"
      ? "App Secret"
      : credential === "verify_token"
        ? "token de verificação"
        : credential === "access_token"
          ? `token da Página ${pageId}`
          : `vínculo da Página ${pageId}`;
    const confirmation = credential === "page_registration"
      ? `Liberar o vínculo da Página ${pageId}? Ela poderá ser cadastrada por outra organização.`
      : `Revogar ${label}? As rotas ativas afetadas serão pausadas automaticamente e o recebimento de leads será interrompido.`;
    if (!window.confirm(confirmation)) return;
    setBusy(credential);
    setFeedback("");
    setError("");
    try {
      const nextStatus = await credentialRequest(organizationId, {
        method: "DELETE",
        body: JSON.stringify({
          organizationId,
          credential,
          ...(credential === "access_token" || credential === "page_registration" ? { pageId } : {}),
        }),
      });
      setStatus(nextStatus);
      onStatusChange?.(nextStatus);
      try {
        await reloadRoutes();
        setFeedback(credential === "page_registration"
          ? `${label} liberado com registro de auditoria.`
          : `${label} revogado com auditoria; as rotas afetadas foram pausadas.`);
      } catch {
        setFeedback(credential === "page_registration"
          ? `${label} liberado. Atualize a tela para renovar a listagem.`
          : `${label} revogado e rotas pausadas. Atualize a tela para renovar a listagem.`);
      }
    } catch (cause) {
      setError(safeUiError(cause));
    } finally {
      setBusy(null);
    }
  }

  if (!canManage) return null;

  return <section className={styles.credentials} aria-labelledby="meta-credentials-title">
    <header className={styles.credentialsHeader}>
      <div>
        <small>COFRE DE CREDENCIAIS</small>
        <h4 id="meta-credentials-title">Autenticação da Meta</h4>
        <p>Os valores seguem diretamente ao servidor e são armazenados no Vault do Supabase. Esta tela mostra somente o estado e a versão.</p>
      </div>
      <Status tone={status?.ready.webhookVerification && status.ready.signatureValidation && currentPage?.accessToken.configured ? "success" : "warning"}>
        {status?.ready.webhookVerification && status.ready.signatureValidation && currentPage?.accessToken.configured ? "credenciais prontas" : "configuração pendente"}
      </Status>
    </header>

    <div className={styles.credentialStatusGrid} aria-live="polite">
      <article>
        <div><strong>App Secret</strong><span>{status ? versionLabel(status.appSecret) : "consultando..."}</span></div>
        <Status tone={status?.appSecret.configured ? "success" : "neutral"}>{status?.appSecret.configured ? "configurado" : "pendente"}</Status>
        {status?.appSecret.configured && <button type="button" disabled={busy !== null} onClick={() => revokeCredential("app_secret")}>Revogar</button>}
      </article>
      <article>
        <div><strong>Token de verificação</strong><span>{status ? versionLabel(status.verifyToken) : "consultando..."}</span></div>
        <Status tone={status?.verifyToken.configured ? "success" : "neutral"}>{status?.verifyToken.configured ? "configurado" : "pendente"}</Status>
        {status?.verifyToken.configured && <button type="button" disabled={busy !== null} onClick={() => revokeCredential("verify_token")}>Revogar</button>}
      </article>
      <article>
        <div><strong>Token da Página {pageId || "—"}</strong><span>{currentPage ? versionLabel(currentPage.accessToken) : "ainda não configurada"}</span></div>
        <Status tone={currentPage?.accessToken.configured ? "success" : "neutral"}>{currentPage?.accessToken.configured ? "configurado" : "pendente"}</Status>
        {currentPage?.accessToken.configured && <button type="button" disabled={busy !== null} onClick={() => revokeCredential("access_token")}>Revogar</button>}
      </article>
    </div>

    <form className={styles.credentialForm} onSubmit={saveCredentials} autoComplete="off">
      <p>Preencha somente o que deseja cadastrar ou rotacionar. Campos vazios preservam a versão atual; salvar todos vazios registra apenas o Page ID.</p>
      <div>
        <label>App Secret<input type="password" name="meta_app_secret" minLength={24} maxLength={512} autoComplete="off" spellCheck={false} data-lpignore="true" data-1p-ignore="true" /></label>
        <label>Token de verificação<input type="password" name="meta_verify_token" minLength={24} maxLength={512} autoComplete="off" spellCheck={false} data-lpignore="true" data-1p-ignore="true" /></label>
        <label>Token de acesso da Página<input type="password" name="meta_page_access_token" minLength={32} maxLength={8192} autoComplete="off" spellCheck={false} data-lpignore="true" data-1p-ignore="true" /></label>
      </div>
      <footer>
        <span>Após salvar, os valores são apagados do formulário e não voltam na resposta.</span>
        <button type="submit" className="primary" disabled={busy !== null || !/^\d{1,64}$/.test(pageId)}>{busy === "save" ? "Protegendo..." : "Registrar página / credenciais"}</button>
      </footer>
    </form>
    {currentPage && currentPage.routeCount === 0 && !currentPage.accessToken.configured && <div className={styles.pageRelease}>
      <span>Sem rotas e sem token. Este vínculo pode ser liberado para uso por outra organização.</span>
      <button type="button" disabled={busy !== null} onClick={() => revokeCredential("page_registration")}>Liberar vínculo da Página</button>
    </div>}
    {busy === "load" && <div className="feedback">Consultando o cofre de credenciais...</div>}
    {error && <div className="feedback error">{error}</div>}
    {feedback && <div className="feedback">{feedback}</div>}
  </section>;
}
