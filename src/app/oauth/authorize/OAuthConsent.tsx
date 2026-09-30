"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";

import { getSupabase } from "@/lib/supabase";

type Props = { params: Record<string, string> };

type SessionState = {
  accessToken: string;
  email: string;
};

export default function OAuthConsent({ params }: Props) {
  const supabase = useMemo(() => getSupabase(), []);
  const [session, setSession] = useState<SessionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let mounted = true;
    async function load() {
      if (!supabase) {
        if (mounted) {
          setError("A autenticação do Enterprise não está disponível.");
          setLoading(false);
        }
        return;
      }
      const { data } = await supabase.auth.getSession();
      if (!mounted) return;
      if (data.session) {
        setSession({
          accessToken: data.session.access_token,
          email: data.session.user.email || "Conta administrativa",
        });
      }
      setLoading(false);
    }
    void load();
    return () => { mounted = false; };
  }, [supabase]);

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setError("");
    setWorking(true);
    try {
      if (!supabase) throw new Error("Autenticação indisponível.");
      const { data, error: signInError } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });
      if (signInError || !data.session) throw new Error("E-mail ou senha inválidos.");
      setSession({
        accessToken: data.session.access_token,
        email: data.session.user.email || email.trim(),
      });
      setPassword("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível entrar.");
    } finally {
      setWorking(false);
    }
  }

  async function decide(decision: "approve" | "deny") {
    setError("");
    setWorking(true);
    try {
      const response = await fetch("/api/oauth/decision", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(session?.accessToken ? { Authorization: `Bearer ${session.accessToken}` } : {}),
        },
        body: JSON.stringify({ decision, ...params }),
        cache: "no-store",
      });
      const body = await response.json() as { redirect_url?: string; error_description?: string };
      if (!response.ok || !body.redirect_url) {
        throw new Error(body.error_description || "Não foi possível concluir a autorização.");
      }
      window.location.assign(body.redirect_url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Não foi possível concluir a autorização.");
      setWorking(false);
    }
  }

  const shell: React.CSSProperties = {
    minHeight: "100dvh",
    background: "#f4f6f3",
    display: "grid",
    placeItems: "center",
    padding: 20,
    fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    color: "#143243",
  };
  const card: React.CSSProperties = {
    width: "min(100%, 520px)",
    background: "#fff",
    border: "1px solid #dfe5dc",
    borderRadius: 22,
    padding: 28,
    boxShadow: "0 18px 50px rgba(26,55,45,.12)",
  };
  const button: React.CSSProperties = {
    width: "100%",
    border: 0,
    borderRadius: 12,
    padding: "12px 16px",
    fontSize: 15,
    fontWeight: 700,
    cursor: working ? "wait" : "pointer",
  };
  const field: React.CSSProperties = {
    width: "100%",
    boxSizing: "border-box",
    border: "1px solid #ccd6cf",
    borderRadius: 10,
    padding: "11px 12px",
    fontSize: 15,
    marginTop: 6,
  };

  return (
    <main style={shell}>
      <section style={card}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 20 }}>
          <div style={{
            width: 42, height: 42, borderRadius: 12, background: "#79B82B",
            display: "grid", placeItems: "center", color: "#fff", fontWeight: 900,
          }}>E</div>
          <div>
            <strong style={{ display: "block", fontSize: 18 }}>Conectar ChatGPT à Évora</strong>
            <span style={{ color: "#617267", fontSize: 13 }}>Bia · Solaris · somente leitura</span>
          </div>
        </div>

        <p style={{ lineHeight: 1.55, margin: "0 0 16px" }}>
          O ChatGPT solicita permissão para consultar, em seu nome, dados comerciais do
          Residencial Solaris no Évora Enterprise.
        </p>

        <div style={{
          background: "#f5f8f3", border: "1px solid #dce7d6", borderRadius: 14,
          padding: 15, marginBottom: 18, fontSize: 14, lineHeight: 1.55,
        }}>
          <strong>Permissão solicitada</strong>
          <div>• consultar empreendimento, leads e estoque do Solaris;</div>
          <div>• visualizar preço de tabela cadastrado;</div>
          <div>• sem enviar WhatsApp, alterar lead, reservar lote ou mudar preço.</div>
        </div>

        {loading ? (
          <p>Verificando sua sessão administrativa…</p>
        ) : !session ? (
          <form onSubmit={signIn}>
            <label style={{ display: "block", fontSize: 13, fontWeight: 700 }}>
              E-mail
              <input
                style={field}
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </label>
            <label style={{ display: "block", fontSize: 13, fontWeight: 700, marginTop: 12 }}>
              Senha
              <input
                style={field}
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            <button
              disabled={working}
              style={{ ...button, marginTop: 18, background: "#143243", color: "#fff" }}
              type="submit"
            >
              {working ? "Entrando…" : "Entrar no Enterprise"}
            </button>
          </form>
        ) : (
          <>
            <p style={{ fontSize: 13, color: "#617267", margin: "0 0 14px" }}>
              Conectando como <strong>{session.email}</strong>.
            </p>
            <button
              disabled={working}
              style={{ ...button, background: "#79B82B", color: "#102b1d" }}
              onClick={() => void decide("approve")}
              type="button"
            >
              {working ? "Autorizando…" : "Autorizar acesso ao Solaris"}
            </button>
            <button
              disabled={working}
              style={{ ...button, marginTop: 10, background: "#edf0ee", color: "#143243" }}
              onClick={() => void decide("deny")}
              type="button"
            >
              Cancelar
            </button>
          </>
        )}

        {error ? (
          <p role="alert" style={{ marginTop: 14, color: "#9f2d24", fontSize: 13 }}>
            {error}
          </p>
        ) : null}

        <p style={{ margin: "18px 0 0", color: "#78877d", fontSize: 12, lineHeight: 1.45 }}>
          A autorização pode ser revogada invalidando a conexão no ChatGPT. O servidor
          revalida seu vínculo administrativo na Évora em cada consulta.
        </p>
      </section>
    </main>
  );
}
