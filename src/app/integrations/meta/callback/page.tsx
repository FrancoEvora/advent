"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { metaConnectionRequest } from "@/components/erp/crm-v5/meta-connection-panel";

export default function MetaCallbackPage() {
  const once = useRef(false);
  const [message, setMessage] = useState("Concluindo a autorização do Instagram…");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (once.current) return;
    once.current = true;
    const params = new URLSearchParams(window.location.search);
    const organizationId = sessionStorage.getItem("evora_meta_callback_org");
    sessionStorage.removeItem("evora_meta_callback_org");
    window.history.replaceState({}, "", window.location.pathname);
    if (params.get("error") || !params.get("code") || !params.get("state") || !organizationId) {
      queueMicrotask(() => { setMessage("A autorização não foi concluída ou a sessão expirou. Volte aos canais e conecte novamente."); setFailed(true); }); return;
    }
    void metaConnectionRequest("/complete", organizationId, { code: params.get("code"), state: params.get("state") })
      .then(result => setMessage(result.message))
      .catch(error => { setFailed(true); setMessage(error instanceof Error ? error.message : "Não foi possível concluir a conexão."); });
  }, []);
  return <main style={{ maxWidth: 640, margin: "10vh auto", padding: 24, fontSize: 16 }}><h1>Conexão com a Meta</h1><p role={failed ? "alert" : "status"}>{message}</p><Link href="/crm/comunicacao">Voltar à central de comunicação</Link></main>;
}
