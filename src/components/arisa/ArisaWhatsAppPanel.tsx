"use client";

import { useEffect, useRef, useState } from "react";
import { errorText } from "./chat-client";
import { displayDate, workspaceCall } from "./workspace-client";
import { whatsappDeliveryLabel, whatsappReceptionLabel, whatsappReconcileLabel, whatsappTemplateText, type WhatsAppChannelStatus, type WhatsAppMessage, type WhatsAppTemplate } from "./whatsapp-display";
import styles from "./workspace.module.css";

export default function ArisaWhatsAppPanel({ organizationId }: { organizationId: string }) {
  const [status, setStatus] = useState<WhatsAppChannelStatus | null>(null), [templates, setTemplates] = useState<WhatsAppTemplate[]>([]), [messages, setMessages] = useState<WhatsAppMessage[]>([]);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [loading, setLoading] = useState(true);
  const [templatesLoaded, setTemplatesLoaded] = useState(false), [historyLoaded, setHistoryLoaded] = useState(false), [webhookConfirmed, setWebhookConfirmed] = useState(false);
  const [offset, setOffset] = useState(0), [hasMore, setHasMore] = useState(false), [nextOffset, setNextOffset] = useState(20), [revision, setRevision] = useState(0);
  const working = useRef(false);

  useEffect(() => {
    let alive = true;
    void Promise.allSettled([
      workspaceCall("arisa-whatsapp", { action: "status", organizationId }),
      workspaceCall("arisa-whatsapp", { action: "list", organizationId, args: { offset, limit: 20 } }),
    ]).then(([channel, history]) => {
      if (!alive) return;
      const errors: string[] = [];
      if (channel.status === "fulfilled") setStatus(channel.value);
      else errors.push(`Conexão: ${errorText(channel.reason)}`);
      if (history.status === "fulfilled") {
        setMessages(history.value.messages || []); setHasMore(history.value.has_more === true);
        setNextOffset(typeof history.value.next_offset === "number" ? history.value.next_offset : offset + 20); setHistoryLoaded(true);
      } else errors.push(`Histórico: ${errorText(history.reason)}`);
      if (errors.length) setError(errors.join(" "));
      setLoading(false);
    });
    return () => { alive = false; };
  }, [organizationId, offset, revision]);

  function refresh() { setError(""); setLoading(true); setRevision(value => value + 1); }
  async function perform(action: "configure" | "templates" | "reconcile", args: Record<string, unknown> = {}) {
    if (working.current) return;
    working.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const data = await workspaceCall("arisa-whatsapp", { action, organizationId, args });
      if (action === "templates") {
        const rows = Array.isArray(data.templates) ? data.templates as WhatsAppTemplate[] : [];
        setTemplates(rows); setTemplatesLoaded(true); setNotice(`${rows.length} template(s) aprovado(s) encontrado(s) na Meta.`);
      } else {
        if (action === "configure") setNotice(args.enabled ? "O envio de WhatsApp pela Arisa foi habilitado." : "O envio pela Arisa foi pausado. O histórico continua disponível.");
        else setNotice(whatsappReconcileLabel(data));
        refresh();
      }
    } catch (failure) { setError(errorText(failure)); }
    finally { working.current = false; setBusy(false); }
  }
  const webhookReady = status?.webhook_confirmed === true || Boolean(status?.webhook_verified_at);
  const canActivate = status?.configured === true && (webhookReady || webhookConfirmed);
  const callbackUrl = status?.webhook_url || `${typeof window === "undefined" ? "" : window.location.origin}/api/integrations/whatsapp/webhook?organizationId=${encodeURIComponent(organizationId)}`;

  return <section aria-labelledby="arisa-whatsapp-title">
    <div className={styles.card}>
      <div className={styles.meta}>WHATSAPP BUSINESS PLATFORM</div><h3 id="arisa-whatsapp-title">WhatsApp da Arisa</h3>
      <p>{!status ? loading ? "Verificando o canal…" : "Não foi possível verificar o canal. Atualize para consultar o estado." : status.ready ? `Envio habilitado${status.display_phone_number ? ` em ${status.display_phone_number}` : ""}.` : status.configured ? "A conexão está cadastrada. O envio pela Arisa ainda está pausado ou exige concluir a configuração." : "A configuração do WhatsApp precisa ser concluída antes de habilitar os envios."}</p>
      {status && <p>{whatsappReceptionLabel(status)}{status.last_inbound_at && <><br /><small>Última mensagem recebida: {displayDate(status.last_inbound_at)}</small></>}</p>}
      <p><small>Uma mensagem recebida abre 24 horas para texto livre. Para iniciar ou retomar a conversa fora dessa janela, a Arisa precisa de um template aprovado pela Meta. As preferências e os bloqueios do contato são respeitados.</small></p>
      <div className={styles.row}>
        <button disabled={busy || loading} onClick={refresh}>{loading ? "Atualizando…" : "Atualizar canal e histórico"}</button>
        <button disabled={busy || loading || !status?.configured} onClick={() => void perform("templates")}>Consultar templates aprovados</button>
        {status?.enabled && <button disabled={busy || loading} onClick={() => void perform("configure", { enabled: false })}>Pausar envios da Arisa</button>}
      </div>
    </div>
    {notice && <p role="status" className={styles.notice}>{notice}</p>}{error && <p role="alert" className={styles.error}>{error}</p>}
    <details className={styles.card} open={status ? !status.ready : false}>
      <summary>Conexão e recebimento</summary>
      {!status?.configured && <p>Cadastre no servidor o número empresarial e as credenciais da WhatsApp Cloud API para esta organização. A tela verifica a configuração sem exibir segredos.</p>}
      {status?.configured && <p>Credenciais cadastradas no servidor{status.display_phone_number ? ` para ${status.display_phone_number}` : ""}.</p>}
      <p>No aplicativo Meta que atende este número, cadastre a URL abaixo e o token de verificação já definido no servidor. Assine o evento <code>messages</code> para receber mensagens e atualizações de entrega.</p>
      <label>URL do webhook<input readOnly value={callbackUrl} onFocus={event => event.target.select()} /></label>
      {status?.webhook_verified_at && <p><small>Verificação do webhook registrada em {displayDate(status.webhook_verified_at)}.</small></p>}
      {!status?.enabled && <>
        {!webhookReady && <label className={styles.checkLabel}><input type="checkbox" checked={webhookConfirmed} onChange={event => setWebhookConfirmed(event.target.checked)} disabled={busy || !status?.configured} />Cadastrei este webhook no aplicativo da Meta e assinei o evento de mensagens.</label>}
        <button className={styles.primary} disabled={busy || loading || !canActivate} onClick={() => void perform("configure", { enabled: true, webhook_confirmed: webhookReady || webhookConfirmed })}>Habilitar envios da Arisa</button>
      </>}
    </details>
    {templatesLoaded && <section className={styles.card} aria-labelledby="arisa-whatsapp-templates">
      <h3 id="arisa-whatsapp-templates">Templates aprovados ({templates.length})</h3>
      <p>Os campos entre chaves recebem os dados da comunicação. A Arisa utiliza o texto aprovado e os parâmetros compatíveis com cada modelo.</p>
      {templates.length === 0 ? <p>Nenhum template aprovado foi encontrado. Para iniciar conversas, crie um modelo no Gerenciador do WhatsApp da Meta e aguarde a aprovação.</p> : templates.map(template => <article className={styles.template} key={`${template.name}:${template.language}`}>
        <strong>{template.name}</strong><div className={styles.meta}>{template.language}{template.category ? ` · ${template.category}` : ""}</div>
        <pre className={styles.content}>{whatsappTemplateText(template) || "Este modelo contém componentes de mídia ou botões. Confira esses componentes no Gerenciador do WhatsApp."}</pre>
      </article>)}
    </section>}
    <section aria-labelledby="arisa-whatsapp-history" aria-busy={loading}>
      <h3 id="arisa-whatsapp-history">Histórico de comunicações</h3>
      <p>Envios da Arisa e respostas recebidas neste canal, com conteúdo e status informado pelo WhatsApp. Aceite do envio, entrega e leitura são registrados separadamente.</p>
      {historyLoaded && !messages.length && <p>Nenhuma mensagem registrada nesta página.</p>}
      {messages.map(message => <article className={styles.card} key={message.id}>
        <div className={styles.meta}>{message.direction === "inbound" ? "Recebida" : "Envio da Arisa"} · {displayDate(message.occurred_at)}</div>
        <h4 className={styles.messageTitle}>{message.contact_name || message.phone || "Contato"}</h4>
        {message.contact_name && message.phone && <small>{message.phone}</small>}
        <p className={styles.delivery}>{whatsappDeliveryLabel(message)}</p>
        <pre className={styles.content}>{message.content || "Mensagem sem conteúdo de texto."}</pre>
        {message.template_name && <small>Template: {message.template_name}</small>}
        {message.direction === "outbound" && message.operation_id && ["unknown", "queued"].includes(message.status || "") && <div className={styles.row}><button disabled={busy || loading} onClick={() => void perform("reconcile", { operation_id: message.operation_id })}>Conferir resultado</button><small>A conferência não reenvia a mensagem.</small></div>}
      </article>)}
      <div className={styles.row}><button disabled={busy || loading || offset === 0} onClick={() => { setLoading(true); setOffset(value => Math.max(0, value - 20)); }}>Anteriores</button><small>Página {Math.floor(offset / 20) + 1}</small><button disabled={busy || loading || !hasMore} onClick={() => { setLoading(true); setOffset(nextOffset); }}>Próximas</button></div>
    </section>
    <p className={styles.notice}>Peça no chat: “Arisa, avise o fornecedor sobre a reunião pelo WhatsApp e envie o link do Meet”. A Arisa consulta o contato e registra o resultado de cada envio.</p>
  </section>;
}
