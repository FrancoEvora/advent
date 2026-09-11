"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { client } from '../arisa/chat-client';
import { channelDetails, deliveryLabel, outboundError } from './whatsapp-panel-client';

type Template = { body: string; footer?: string; buttons?: string[]; hash: string; name: string; language: string };
type Result = { id: string; status: string; phone?: string; threadId?: string; errorCode?: string };
export function AssistantStartConversation({ organizationId, userId, assistant, initialPhone = '', onClose }: {
  assistant: "arisa" | "bia"; organizationId: string; userId: string; initialPhone?: string; onClose: (threadId?: string) => void;
}) {
  const channel = channelDetails(assistant);
  const explainError = useCallback((code: string) => outboundError(assistant, code), [assistant]);
  const [recipientName, setRecipientName] = useState('');
  const [phone, setPhone] = useState(initialPhone), [consent, setConsent] = useState(false);
  const [template, setTemplate] = useState<Template | null>(null), [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const requestId = useRef(''), inFlight = useRef(false), alive = useRef(true);
  const storageKey = `${assistant}-outbound-v1:${userId}:${organizationId}`;
  const invoke = useCallback(async (action: string, args: Record<string, unknown> = {}) => {
    const response = await client().functions.invoke(channel.outbound, { body: assistant === "bia" ? { organizationId, action, ...args } : { organizationId, action: `outbound_${action}`, args } });
    if (response.error) {
      let code = '';
      try { code = (await response.error.context?.json())?.error || ''; } catch { /* Transport errors have no JSON body. */ }
      throw new Error(code || 'SEND_UNCONFIRMED');
    }
    if (!response.data?.ok) throw new Error(response.data?.error || 'SEND_UNCONFIRMED');
    return response.data.data;
  }, [organizationId, assistant, channel.outbound]);
  const checkStatus = useCallback(async (id: string) => {
    try {
      const next = await invoke('status', { id }) as Result;
      if (alive.current) { setResult(next); setError(''); if (next.phone) setPhone('+' + next.phone); }
    } catch (e) { if (alive.current) setError(explainError(e instanceof Error ? e.message : '')); }
  }, [invoke, explainError]);
  const loadTemplate = useCallback(async () => {
    setBusy(true); setError('');
    try { const next = await invoke('preview'); if (alive.current) setTemplate(next as Template); }
    catch (e) { if (alive.current) setError(explainError(e instanceof Error ? e.message : 'BIA_TEMPLATE_UNAVAILABLE')); }
    finally { if (alive.current) setBusy(false); }
  }, [invoke, explainError]);
  useEffect(() => {
    alive.current = true;
    const timer = setTimeout(() => {
      let pending = '';
      try { pending = sessionStorage.getItem(storageKey) || ''; } catch { /* Server idempotency still protects retries. */ }
      if (/^[0-9a-f-]{36}$/.test(pending)) { requestId.current = pending; setResult({ id: pending, status: 'unknown' }); void checkStatus(pending); }
      else requestId.current = crypto.randomUUID();
      void loadTemplate();
    }, 0);
    return () => { alive.current = false; clearTimeout(timer); };
  }, [storageKey, checkStatus, loadTemplate]);
  const pendingId = result && ['sending', 'accepted', 'sent', 'unknown'].includes(result.status) ? result.id : '';
  useEffect(() => {
    if (!pendingId) return;
    let polls = 0;
    const timer = setInterval(() => { if (++polls > 12) { clearInterval(timer); return; } void checkStatus(pendingId); }, 5000);
    return () => clearInterval(timer);
  }, [pendingId, checkStatus]);
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !template || !consent || (result && result.status !== 'not_found')) return;
    inFlight.current = true; setBusy(true); setError('');
    const id = requestId.current || crypto.randomUUID(); requestId.current = id;
    try { sessionStorage.setItem(storageKey, id); } catch { /* No phone or message is stored in the browser. */ }
    try {
      const next = await invoke('send', { id, phone, recipientName, consent, hash: template.hash }) as Result;
      if (alive.current) setResult(next);
    } catch (e) {
      if (!alive.current) return;
      const code = e instanceof Error ? e.message : 'SEND_UNCONFIRMED';
      setError(explainError(code));
      if (code === 'SEND_UNCONFIRMED') { setResult({ id, status: 'unknown' }); void checkStatus(id); }
    } finally { inFlight.current = false; if (alive.current) setBusy(false); }
  }
  function close() {
    if (busy) return;
    if (!result || !['unknown', 'sending'].includes(result.status)) {
      try { sessionStorage.removeItem(storageKey); } catch { /* Optional storage. */ }
    }
    onClose(result?.threadId);
  }
  const sent = result && result.status !== 'not_found';
  return <section className="bia-start-conversation" aria-labelledby={`${assistant}-start-title`}>
    <div className="bia-inbox-toolbar"><h2 id={`${assistant}-start-title`}>Iniciar conversa pelo WhatsApp</h2><button type="button" disabled={busy} onClick={close}>Voltar aos atendimentos</button></div>
    <form onSubmit={send}>
      <label>WhatsApp do destinatário, com DDD<input type="tel" name="recipient" autoComplete="tel" placeholder="(34) 99999-9999" required maxLength={30} value={phone} disabled={busy || Boolean(sent)} onChange={e => setPhone(e.target.value)} /></label>
      <label>Nome do contato (opcional)<input type="text" autoComplete="name" maxLength={80} value={recipientName} disabled={busy || Boolean(sent)} onChange={e => setRecipientName(e.target.value)} /></label>
      <p>{assistant === "bia" ? "O nome será preenchido com o cadastro do CRM, se disponível. Sem nome, a saudação será “Olá, tudo bem!”." : "A mensagem inicial aprovada será enviada pelo WhatsApp da Arisa."}</p>
      <div className="bia-opening-preview"><strong>{assistant === "bia" ? "Indicação de investimento aprovada" : "Mensagem inicial aprovada"}</strong>{template ? <><p>{template.body.replace('{{1}}', recipientName.trim() || '[nome do contato]')}</p>{template.footer&&<p className="bia-opening-footer">{template.footer}</p>}{Boolean(template.buttons?.length)&&<div className="bia-opening-options" aria-label="Opções da mensagem">{template.buttons?.map(label=><span key={label}>{label}</span>)}</div>}</> : <p>Consultando a mensagem aprovada na Meta…</p>}</div>
      {!sent && <><label className="bia-outbound-consent"><input type="checkbox" checked={consent} required disabled={busy} onChange={e => setConsent(e.target.checked)} /><span>Confirmo que este contato autorizou receber mensagens da {channel.name} pelo WhatsApp.</span></label>
        <div className="bia-opening-actions"><button type="submit" disabled={busy || !template || !consent || !phone}>{busy ? 'Aguarde…' : (assistant === "bia" ? "Enviar indicação de investimento" : "Enviar mensagem inicial")}</button><button type="button" disabled={busy} onClick={() => void loadTemplate()}>Atualizar mensagem</button></div></>}
      {result && <div className="bia-opening-status" role="status"><strong>{deliveryLabel[result.status] || result.status}</strong>{result.phone && <span>Destinatário: +{result.phone}</span>}
        {result.errorCode && <p>{explainError(result.errorCode)}</p>}
        {['accepted', 'sent'].includes(result.status) && <p>Aguardando a confirmação de entrega do WhatsApp.</p>}
        {result.status === 'unknown' && <p>O envio pode ter ocorrido. Consulte o status; a mensagem não será repetida automaticamente.</p>}
        {['delivered', 'read'].includes(result.status) && <p>Quando o contato responder, a {channel.name} dará continuidade ao atendimento.</p>}
        <button type="button" disabled={busy} onClick={() => void checkStatus(result.id)}>Consultar status</button>
      </div>}
      {error && <p role="alert">{error}</p>}
    </form>
  </section>;
}
