"use client";

import { FormEvent, useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";

export default function ResetPasswordPage() {
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("Validando link de recuperação...");
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    const supabase = getSupabase();
    if (!supabase) {
      setMessage("Configuração de autenticação indisponível.");
      return;
    }

    supabase.auth.getSession().then(({ data }) => {
      if (data.session) {
        setReady(true);
        setMessage("");
      }
    });

    const { data: listener } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === "PASSWORD_RECOVERY" || session) {
        setReady(true);
        setMessage("");
      }
    });

    const timeout = window.setTimeout(() => {
      setMessage((current) => current || "O link expirou ou já foi utilizado. Solicite uma nova recuperação.");
    }, 8000);

    return () => {
      window.clearTimeout(timeout);
      listener.subscription.unsubscribe();
    };
  }, []);

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
    await supabase.auth.signOut();
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
        <p>{completed ? "Seu acesso está pronto para ser utilizado novamente." : "Informe e confirme sua nova senha."}</p>

        {!completed && (
          <>
            <label>Nova senha<input name="password" type="password" minLength={10} autoComplete="new-password" required disabled={!ready || busy} /></label>
            <label>Confirmar nova senha<input name="confirmation" type="password" minLength={10} autoComplete="new-password" required disabled={!ready || busy} /></label>
          </>
        )}

        {message && <div className="feedback">{message}</div>}

        {completed ? (
          <a className="primary" href="/" style={{ display: "grid", placeItems: "center", textDecoration: "none" }}>Voltar ao ERP</a>
        ) : (
          <button className="primary" disabled={!ready || busy}>{busy ? "Atualizando..." : "Salvar nova senha"}</button>
        )}
      </form>
    </div>
  );
}
