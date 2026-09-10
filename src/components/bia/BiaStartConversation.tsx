"use client";
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { client } from '../arisa/chat-client';
import { biaDeliveryLabel, biaOutboundError } from './outbound-display';

type Template = { body: string; footer?: string; buttons?: string[]; hash: string; name: string; language: string };
type Result = { id: string; status: string; phone?: string; threadId?: string; errorCode?: string };
export function BiaStartConversation({ organizationId, userId, initialPhone = '', onClose }: {
  organizationId: string; userId: string; initialPhone?: string; onClose: (threadId?: string) => void;
}) {
  const [phone, setPhone] = useState(initialPhone), [consent, setConsent] = useState(false);
  const [template, setTemplate] = useState<Template | null>(null), [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const requestId = useRef(''), inFlight = useRef(false), alive = useRef(true);
  const storageKey = `bia-outbound-v1:${userId}:${organizationId}`;
  const invoke = useCallback(async (action: string, args: Record<string, unknown> = {}) => {
    const response = await client().functions.invoke('bia-whatsapp-outbound', { body: { organizationId, action, ...args } });
    if (response.error) {
      let code = '';
      try { code = (await response.error.context?.json())?.error || ''; } catch { /* Transport errors have no JSON body. */ }
      throw new Error(code || 'SEND_UNCONFIRMED');
    }
    if (!response.data?.ok) throw new Error(response.data?.error || 'BIA_OUTBOUND_UNAVAILABLE');
    return response.data.data;
  }, [organizationId]);
  const checkStatus = useCallback(async (id: string) => {
    try {
      const next = await invoke('status', { id }) as Result;
      if (alive.current) { setResult(next); setError(''); if (next.phone) setPhone('+' + next.phone); }
    } catch (e) { if (alive.current) setError(biaOutboundError(e instanceof Error ? e.message : '')); }
  }, [invoke]);
  const loadTemplate = useCallback(async () => {
    setBusy(true); setError('');
    try { const next = await invoke('preview'); if (alive.current) setTemplate(next as Template); }
    catch (e) { if (alive.current) setError(biaOutboundError(e instanceof Error ? e.message : 'BIA_TEMPLATE_UNAVAILABLE')); }
    finally { if (alive.current) setBusy(false); }
  }, [invoke]);
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
      const next = await invoke('send', { id, phone, consent, hash: template.hash }) as Result;
      if (alive.current) setResult(next);
    } catch (e) {
      if (!alive.current) return;
      const code = e instanceof Error ? e.message : 'SEND_UNCONFIRMED';
      setError(biaOutboundError(code));
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
  return <section className="bia-start-conversation" aria-labelledby="bia-start-title">
    <div className="bia-inbox-toolbar"><h2 id="bia-start-title">Iniciar conversa pelo WhatsApp</h2><button type="button" disabled={busy} onClick={close}>Voltar aos atendimentos</button></div>
    <form onSubmit={send}>
      <label>WhatsApp do destinatário, com DDD<input type="tel" name="recipient" autoComplete="tel" placeholder="(34) 99999-9999" required maxLength={30} value={phone} disabled={busy || Boolean(sent)} onChange={e => setPhone(e.target.value)} /></label>
      <div className="bia-opening-preview"><strong>Mensagem de boas-vindas aprovada</strong>{template ? <><p>{template.body}</p>{template.footer&&<p className="bia-opening-footer">{template.footer}</p>}{Boolean(template.buttons?.length)&&<div className="bia-opening-options" aria-label="Opções da mensagem">{template.buttons?.map(label=><span key={label}>{label}</span>)}</div>}</> : <p>Consultando a mensagem aprovada na Meta…</p>}</div>
      {!sent && <><label className="bia-outbound-consent"><input type="checkbox" checked={consent} required disabled={busy} onChange={e => setConsent(e.target.checked)} /><span>Confirmo que este contato autorizou receber mensagens da Bia pelo WhatsApp.</span></label>
        <div className="bia-opening-actions"><button type="submit" disabled={busy || !template || !consent || !phone}>{busy ? 'Aguarde…' : 'Enviar mensagem de boas-vindas'}</button><button type="button" disabled={busy} onClick={() => void loadTemplate()}>Atualizar mensagem</button></div></>}
      {result && <div className="bia-opening-status" role="status"><strong>{biaDeliveryLabel[result.status] || result.status}</strong>{result.phone && <span>Destinatário: +{result.phone}</span>}
        {result.errorCode && <p>{biaOutboundError(result.errorCode)}</p>}
        {['accepted', 'sent'].includes(result.status) && <p>Aguardando a confirmação de entrega do WhatsApp.</p>}
        {result.status === 'unknown' && <p>O envio pode ter ocorrido. Consulte o status; a mensagem não será repetida automaticamente.</p>}
        {['delivered', 'read'].includes(result.status) && <p>Quando o contato responder, a Bia dará continuidade ao atendimento.</p>}
        <button type="button" disabled={busy} onClick={() => void checkStatus(result.id)}>Consultar status</button>
      </div>}
      {error && <p role="alert">{error}</p>}
    </form>
  </section>;
}
