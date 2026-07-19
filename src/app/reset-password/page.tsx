"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";

const EXPIRED_MESSAGE = "O link expirou ou já foi utilizado. Solicite uma nova recuperação.";

type RecoveryData = {
  accessToken?: string;
  refreshToken?: string;
  code?: string;
  tokenHash?: string;
  type?: string;
  error?: string;
};

function readRecoveryData(rawUrl: string): RecoveryData {
  try {
    const url = new URL(rawUrl, window.location.origin);
    const hash = new URLSearchParams(url.hash.replace(/^#/, ""));
    const query = url.searchParams;

    return {
      accessToken: hash.get("access_token") || undefined,
      refreshToken: hash.get("refresh_token") || undefined,
      code: query.get("code") || undefined,
      tokenHash: query.get("token_hash") || query.get("token") || undefined,
      type: query.get("type") || hash.get("type") || undefined,
      error: query.get("error_description") || hash.get("error_description") || undefined,
    };
  } catch {
    return { error: "O endereço informado não é um link de recuperação válido." };
  }
}

export default function ResetPasswordPage() {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Validando link de recuperação...");
  const [completed, setCompleted] = useState(false);
  const [manualLink, setManualLink] = useState("");

  const processRecovery = useCallback(async (rawUrl: string) => {
    const supabase = getSupabase();
    if (!supabase) {
      setMessage("Configuração de autenticação indisponível.");
      return false;
    }

    const recovery = readRecoveryData(rawUrl);
    if (recovery.error) {
      setMessage(decodeURIComponent(recovery.error.replace(/\+/g, " ")));
      return false;
    }

    try {
      if (recovery.code) {
        const { error } = await supabase.auth.exchangeCodeForSession(recovery.code);
        if (error) throw error;
      } else if (recovery.tokenHash && recovery.type === "recovery") {
        const { error } = await supabase.auth.verifyOtp({
          token_hash: recovery.tokenHash,
          type: "recovery",
        });
        if (error) throw error;
      } else if (recovery.accessToken && recovery.refreshToken) {
        const { error } = await supabase.auth.setSession({
          access_token: recovery.accessToken,
          refresh_token: recovery.refreshToken,
        });
        if (error) throw error;
      }

      const { data, error } = await supabase.auth.getSession();
      if (error) throw error;
      if (!data.session) return false;

      setReady(true);
      setMessage("");
      window.history.replaceState({}, document.title, "/reset-password");
      return true;
    } catch (error) {
      setReady(false);
      setMessage(error instanceof Error ? error.message : EXPIRED_MESSAGE);
      return false;
    }
  }, []);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) {
      setMessage("Configuração de autenticação indisponível.");
      return;
    }

    let active = true;

    processRecovery(window.location.href).then(async (processed) => {
      if (!active || processed) return;
      const { data } = await supabase.auth.getSession();
      if (data.session) {
        setReady(true);
        setMessage("");
      } else {
        setMessage("Abra um link novo de recuperação ou cole abaixo o link recebido por e-mail.");
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (!active) return;
      if (event === "PASSWORD_RECOVERY" || session) {
        setReady(true);
        setMessage("");
      }
    });

    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [processRecovery]);

  async function validateManualLink() {
    if (!manualLink.trim()) {
      setMessage("Cole o link completo recebido por e-mail.");
      return;
    }
    setBusy(true);
    setMessage("Validando o link informado...");
    const success = await processRecovery(manualLink.trim());
    if (!success && !message) setMessage(EXPIRED_MESSAGE);
    setBusy(false);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password"));
    const confirmation = String(form.get("confirmation"));

    if (password.length < 10) {
      setMessage("A nova senha deve ter pelo menos 10 caracteres.");
      return;
    }
    if (password !== confirmation) {
      setMessage("As senhas informadas não coincidem.");
      return;
    }

    const supabase = getSupabase();
    if (!supabase) return;

    setBusy(true);
    setMessage("");
    const { error } = await supabase.auth.updateUser({ password });
    setBusy(false);

    if (error) {
      setMessage(error.message);
      return;
    }

    setCompleted(true);
    setMessage("Senha atualizada com sucesso.");
    await supabase.auth.signOut({ scope: "global" });
  }

  return (
    <div className="auth-page">
      <section>
        <div className="brand">
          <i><span /><span /><span /></i>
          <div><strong>Évora Gestão</strong><small>ERP IMOBILIÁRIO</small></div>
        </div>
        <div>
          <small>SEGURANÇA DE ACESSO</small>
          <h1>Defina uma nova senha.</h1>
          <p>Use uma senha exclusiva, forte e diferente das utilizadas em outros serviços.</p>
        </div>
      </section>

      <form onSubmit={submit}>
        <small>RECUPERAÇÃO DE CONTA</small>
        <h2>{completed ? "Senha atualizada" : "Nova senha"}</h2>
        <p>{completed ? "Seu acesso está pronto para ser utilizado novamente." : ready ? "Informe e confirme sua nova senha." : "Valide o link recebido para continuar."}</p>

        {!completed && !ready && (
          <>
            <label>
              Link recebido por e-mail
              <textarea
                value={manualLink}
                onChange={(event) => setManualLink(event.target.value)}
                rows={4}
                placeholder="Cole aqui o endereço completo do botão de recuperação"
                disabled={busy}
              />
            </label>
            <button className="primary" type="button" onClick={validateManualLink} disabled={busy}>
              {busy ? "Validando..." : "Validar link de recuperação"}
            </button>
          </>
        )}

        {!completed && ready && (
          <>
            <label>Nova senha<input name="password" type="password" minLength={10} autoComplete="new-password" required disabled={busy} /></label>
            <label>Confirmar nova senha<input name="confirmation" type="password" minLength={10} autoComplete="new-password" required disabled={busy} /></label>
          </>
        )}

        {message && <div className="feedback">{message}</div>}

        {completed ? (
          <a className="primary" href="/" style={{ display: "grid", placeItems: "center", textDecoration: "none" }}>Voltar ao ERP</a>
        ) : ready ? (
          <button className="primary" disabled={busy}>{busy ? "Atualizando..." : "Salvar nova senha"}</button>
        ) : (
          <a href="/" className="link" style={{ textAlign: "center", textDecoration: "none" }}>Voltar ao acesso</a>
        )}
      </form>
    </div>
  );
}
