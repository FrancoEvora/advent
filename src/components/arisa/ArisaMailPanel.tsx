"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { client, errorText, uploadFile, type ChatFile } from "./chat-client";
import { displayDate, downloadStored, workspaceCall } from "./workspace-client";
import styles from "./workspace.module.css";
import ArisaCalendarPanel from "./ArisaCalendarPanel";

type Status = { configured: boolean; connected: boolean; calendar_authorized?: boolean; sender_email: string; connected_email: string | null; client_id: string | null; redirect_uri: string; last_sync_at: string | null; sync_error: string | null };
type Mail = { id: string; sender: string; recipients: string[]; subject: string; body: string; status: string; occurred_at: string; raw_path: string | null; attachments: { bucket?: string; path?: string; name: string }[] };
const labels: Record<string, string> = { draft: "Arquivado · ainda não enviado", sending: "Envio em conferência", sent: "Aceito pelo Gmail", received: "Recebido", failed: "Envio recusado", unknown: "Resultado em conferência", archive_pending: "Arquivamento em andamento" };

export default function ArisaMailPanel({ organizationId, userId }: { organizationId: string; userId: string }) {
  const [status, setStatus] = useState<Status | null>(null), [mails, setMails] = useState<Mail[]>([]), [page, setPage] = useState(0), [revision, setRevision] = useState(0);
  const [error, setError] = useState(""), [notice, setNotice] = useState(""), [busy, setBusy] = useState(false), [compose, setCompose] = useState(false), [files, setFiles] = useState<ChatFile[]>([]), [locked, setLocked] = useState(false);
  const requestId = useRef<string>(crypto.randomUUID()), attachmentThread = useRef<string | null>(null), working = useRef(false), editor = useRef<HTMLFormElement>(null);
  useEffect(() => {
    let alive = true;
    void workspaceCall("arisa-mail", { action: "status", organizationId }).then(data => { if (alive) setStatus(data); }).catch(error => { if (alive) setError(errorText(error)); });
    return () => { alive = false; };
  }, [organizationId, revision]);
  useEffect(() => {
    let alive = true;
    void client().from("arisa_mail_messages").select("id,sender,recipients,subject,body,status,occurred_at,raw_path,attachments").eq("organization_id", organizationId).order("occurred_at", { ascending: false }).order("id", { ascending: false }).range(page * 20, page * 20 + 19).then(result => {
      if (alive) { if (result.error) setError(errorText(result.error)); else setMails(result.data || []); }
    });
    return () => { alive = false; };
  }, [organizationId, page, revision]);
  const perform = useCallback(async (action: string, values: Record<string, unknown> = {}) => {
    if (working.current) return null;
    working.current = true; setBusy(true); setError(""); setNotice("");
    try { const data = await workspaceCall("arisa-mail", { action, organizationId, ...values }); setRevision(n => n + 1); return data; }
    catch (error) { setError(errorText(error)); setRevision(n => n + 1); return null; }
    finally { working.current = false; setBusy(false); }
  }, [organizationId]);
  async function configure(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); const form = event.currentTarget, values = new FormData(form);
    const result = await perform("configure", { clientId: String(values.get("clientId")).trim(), clientSecret: String(values.get("clientSecret")).trim() });
    const secret = form.elements.namedItem("clientSecret"); if (secret instanceof HTMLInputElement) secret.value = "";
    if (result) setNotice("Credenciais salvas. Agora conecte a conta da Arisa pelo Google.");
  }
  async function connect(purpose: "mail" | "calendar" = "mail") {
    const result = await perform("connect", { purpose });
    if (typeof result?.url === "string") {
      const url = new URL(result.url);
      if (url.origin !== "https://accounts.google.com") { setError("O endereço de autorização não foi validado."); return; }
      sessionStorage.setItem("arisa-google-organization", organizationId); window.location.assign(url.toString());
    }
  }
  async function attach(incoming: File[]) {
    if (working.current || locked) return;
    if (files.length + incoming.length > 10) { setError("Use até 10 anexos por e-mail."); return; }
    working.current = true; setBusy(true); setError("");
    try {
      if (!attachmentThread.current) { const result = await client().rpc("arisa_chat_create_thread", { p_organization_id: organizationId }); if (result.error || !result.data?.id) throw result.error || new Error("Não foi possível registrar os anexos."); attachmentThread.current = result.data.id; }
      for (const file of incoming) { const saved = await uploadFile(file, organizationId, userId, attachmentThread.current!); setFiles(previous => [...previous, saved]); }
    } catch (error) { setError(errorText(error)); } finally { working.current = false; setBusy(false); }
  }
  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); if (working.current || locked) return;
    const values = new FormData(event.currentTarget), split = (value: FormDataEntryValue | null) => String(value || "").split(/[,;]+/).map(value => value.trim()).filter(Boolean);
    // Keep the same request ID after a lost response; the server records one intent.
    setLocked(true);
    const result = await perform("send", { requestId: requestId.current, to: split(values.get("to")), cc: split(values.get("cc")), subject: String(values.get("subject")), body: String(values.get("body")), fileIds: files.map(file => file.id) });
    if (result?.status === "sent") { setNotice("E-mail aceito pelo Gmail e arquivado com os anexos. Isso não confirma entrega ou leitura."); setCompose(false); setFiles([]); requestId.current = crypto.randomUUID(); setLocked(false); }
    else setNotice("Consulte o registro abaixo antes de repetir o envio. O conteúdo do formulário foi preservado.");
  }
  async function download(bucket: string, path: string, name: string) { try { await downloadStored(bucket, path, name); } catch (error) { setError(errorText(error)); } }
  return <section><div className={styles.card}><div className={styles.meta}>GOOGLE WORKSPACE</div><h3>arisa@evoraurbanismo.com.br</h3><p>{!status ? "Verificando a conexão…" : status.connected ? "Conta conectada para envio e arquivamento de e-mails." : "A conta precisa ser autorizada no Google para começar a enviar e sincronizar mensagens."}</p><small>Última sincronização: {displayDate(status?.last_sync_at)}</small>{status?.sync_error && <p role="status">A sincronização requer atenção: {status.sync_error}. Os conteúdos já arquivados estão preservados.</p>}<div className={styles.row}><button className={styles.primary} disabled={busy || !status?.configured} onClick={() => void connect()}>{status?.connected ? "Renovar conexão Google" : "Conectar Google Workspace"}</button>{status?.connected && <><button disabled={busy} onClick={async () => { const result = await perform("sync"); if (result) setNotice(result.busy ? "Já existe uma sincronização em andamento." : `${result.archived || 0} mensagens verificadas. A sincronização continuará automaticamente.`); }}>Sincronizar agora</button><button disabled={busy} onClick={async () => { if (await perform("disconnect")) setNotice("Conta desconectada. O arquivo foi preservado."); }}>Desconectar conta</button></>}</div></div>
    {error && <p role="alert" className={styles.error}>{error}</p>}{notice && <p role="status" className={styles.notice}>{notice}</p>}
    <details className={styles.card} open={status ? !status.configured : false}><summary>Configuração Google Workspace</summary><p>No projeto Google Cloud da Évora, ative a Gmail API e crie um cliente OAuth do tipo <strong>Aplicativo da Web</strong>, com público interno da organização.</p><label>URI de redirecionamento autorizada<input readOnly value="https://advent-tau.vercel.app/arisa/email/callback" onFocus={e => e.target.select()} /></label><p>Habilite os escopos <code>gmail.send</code> e <code>gmail.readonly</code>. Para a agenda, ative também a Google Calendar API; a autorização dos escopos de Agenda e Meet é feita pelo botão específico abaixo. Depois salve as credenciais abaixo e use o botão de conexão para autorizar a conta da Arisa.</p><a href="https://developers.google.com/identity/protocols/oauth2/web-server" target="_blank" rel="noreferrer">Documentação de configuração do Google</a><form onSubmit={configure}><label>ID do cliente OAuth<input name="clientId" defaultValue={status?.client_id || ""} placeholder="…apps.googleusercontent.com" required autoComplete="off" /></label><label>Segredo do cliente OAuth<input name="clientSecret" type="password" minLength={12} maxLength={500} required autoComplete="new-password" /></label><small>O segredo fica criptografado no servidor e não é exibido novamente. Use as credenciais OAuth, não a senha da caixa de e-mail.</small><div className={styles.row}><button disabled={busy} type="submit">Salvar credenciais</button></div></form></details>
    <div className={styles.row}><button disabled={!status?.connected || busy} onClick={() => setCompose(value => !value)}>{compose ? "Recolher mensagem" : "Escrever e-mail"}</button><small>Você também pode pedir o envio diretamente no chat da Arisa.</small></div>
    {compose && <form ref={editor} className={styles.card} onSubmit={send}><h3>Novo e-mail da Arisa</h3><fieldset disabled={busy || locked} style={{ border: 0, margin: 0, padding: 0 }}><label>Para<input name="to" required placeholder="nome@empresa.com.br" /></label><label>Cópia<input name="cc" placeholder="Separe os endereços por vírgula" /></label><label>Assunto<input name="subject" maxLength={250} required /></label><label>Mensagem<textarea name="body" rows={8} maxLength={150000} required /></label><label>Anexar documentos, imagens ou áudio<input type="file" multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.xml,.csv,.ofx,.txt,.webm,.m4a,.mp3,.wav" onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ""; void attach(files); }} /></label><small>Até 8 MB por arquivo e 18 MB no total. A assinatura da Arisa será adicionada ao e-mail.</small><ul>{files.map(file => <li key={file.id}>{file.file_name} <button type="button" onClick={() => setFiles(previous => previous.filter(item => item.id !== file.id))}>Retirar anexo</button></li>)}</ul><button type="submit" className={styles.primary}>Enviar e arquivar</button></fieldset>{locked && <div className={styles.row}><button type="button" disabled={busy} onClick={async () => { await perform("reconcile"); }}>Conferir resultado no Gmail</button><button type="button" disabled={busy} onClick={() => { setLocked(false); }}>Retomar este mesmo pedido</button></div>}</form>}
    <ArisaCalendarPanel organizationId={organizationId} connected={status?.connected === true} authorized={status?.calendar_authorized === true} busy={busy} onConnect={() => void connect("calendar")} />
    <h3>Mensagens arquivadas</h3><p>Envio, recebimento e anexos ficam registrados na plataforma. A sincronização automática verifica a caixa a cada 5 minutos.</p>{mails.map(mail => <article className={styles.card} key={mail.id}><div className={styles.meta}>{labels[mail.status] || mail.status} · {displayDate(mail.occurred_at)}</div><h3>{mail.subject}</h3><small>De: {mail.sender}<br />Para: {mail.recipients.join(", ")}</small><details><summary>Ler mensagem e ver anexos</summary><pre className={styles.content}>{mail.body}</pre><div className={styles.row}>{mail.raw_path && <button onClick={() => void download("arisa-mail", mail.raw_path!, "email-original.eml")}>Baixar e-mail original</button>}{mail.attachments.map((file, index) => file.path && file.bucket ? <button key={`${file.path}:${index}`} onClick={() => void download(file.bucket!, file.path!, file.name)}>{file.name}</button> : null)}</div>{["unknown", "sending"].includes(mail.status) && <button disabled={busy || !status?.connected} onClick={async () => { const result = await perform("reconcile", { id: mail.id }); if (result) setNotice(result.confirmed ? "Envio localizado no Gmail e confirmado no arquivo." : "Ainda não foi possível confirmar este envio. Nenhuma nova mensagem foi enviada."); }}>Conferir no Gmail</button>}</details></article>)}{!mails.length && <p>Nenhuma mensagem arquivada nesta conta ainda.</p>}<div className={styles.row}><button disabled={page === 0} onClick={() => setPage(n => n - 1)}>Anteriores</button><small>Página {page + 1}</small><button disabled={mails.length < 20} onClick={() => setPage(n => n + 1)}>Próximos</button></div>
  </section>;
}
