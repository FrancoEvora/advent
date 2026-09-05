"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { errorText, UUID } from "./chat-client";
import { workspaceCall } from "./workspace-client";

export default function ArisaGoogleCallback() {
  const started = useRef(false), [message, setMessage] = useState("Concluindo a autorização da conta da Arisa…"), [failed, setFailed] = useState(false);
  useEffect(() => {
    if (started.current) return; started.current = true;
    const params = new URLSearchParams(window.location.search), organizationId = sessionStorage.getItem("arisa-google-organization");
    window.history.replaceState({}, "", "/arisa/email/callback"); sessionStorage.removeItem("arisa-google-organization");
    async function complete() {
      if (params.has("error")) throw new Error("A autorização Google não foi concluída. Você pode iniciar uma nova conexão.");
      if (!organizationId || !UUID.test(organizationId) || !params.get("state") || !params.get("code")) throw new Error("Inicie a conexão pelo painel de e-mail da Arisa, usando este mesmo navegador.");
      await workspaceCall("arisa-mail", { action: "complete", organizationId, state: params.get("state"), code: params.get("code") });
      setMessage("Conta conectada. Abrindo o painel de e-mail…"); window.location.replace("/arisa?painel=email");
    }
    void complete().catch(error => { setFailed(true); setMessage(errorText(error)); });
  }, []);
  return <main style={{ maxWidth: 560, margin: "max(40px, env(safe-area-inset-top)) auto", padding: 24, fontFamily: "sans-serif", lineHeight: 1.6 }}><p style={{ color: "#355719", fontWeight: 700 }}>ARISA · ÉVORA URBANISMO</p><h1>E-mail da Arisa</h1><p role={failed ? "alert" : "status"}>{message}</p><Link href="/arisa?painel=email">Voltar ao painel de e-mail</Link></main>;
}
