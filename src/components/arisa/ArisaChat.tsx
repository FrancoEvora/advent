"use client";

import Link from "next/link";
import Image from "next/image";
import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { Session } from "@supabase/supabase-js";
import { callManager, client, errorText, openFile, uploadFile, UUID, type Action, type ChatFile, type Message, type Thread } from "./chat-client";

function Icon({ kind }: { kind: "send" | "mic" | "attach" | "stop" | "menu" | "close" }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true">{kind === "send" ? <path d="m3 3 19 9-19 9 4-9-4-9Zm4 9h15" /> : kind === "mic" ? <><rect x="9" y="2" width="6" height="13" rx="3" /><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8" /></> : kind === "attach" ? <path d="m9 17 8-8a3 3 0 0 0-4-4l-9 9a5 5 0 0 0 7 7l10-10M7 15l9-9" /> : kind === "stop" ? <rect x="5" y="5" width="14" height="14" rx="2" /> : kind === "close" ? <path d="m6 6 12 12M6 18 18 6" /> : <path d="M4 6h16M4 12h16M4 18h16" />}</svg>;
}
function useChatViewport() {
  useEffect(() => {
    const viewport = window.visualViewport, root = document.documentElement; let frame = 0;
    const sync = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(() => {
      root.style.setProperty("--public-agent-viewport-height", `${Math.round(viewport?.height || innerHeight)}px`);
      root.style.setProperty("--public-agent-viewport-width", `${Math.round(viewport?.width || innerWidth)}px`);
      root.style.setProperty("--public-agent-viewport-top", `${Math.max(0, Math.round(viewport?.offsetTop || 0))}px`);
      root.style.setProperty("--public-agent-viewport-left", `${Math.max(0, Math.round(viewport?.offsetLeft || 0))}px`);
    }); };
    root.classList.add("public-agent-active"); document.body.classList.add("public-agent-active"); sync();
    viewport?.addEventListener("resize", sync); viewport?.addEventListener("scroll", sync); window.addEventListener("resize", sync);
    return () => { cancelAnimationFrame(frame); viewport?.removeEventListener("resize", sync); viewport?.removeEventListener("scroll", sync); window.removeEventListener("resize", sync); root.classList.remove("public-agent-active"); document.body.classList.remove("public-agent-active"); ["height", "width", "top", "left"].forEach(name => root.style.removeProperty("--public-agent-viewport-" + name)); };
  }, []);
}
function Header({ menu }: { menu?: () => void }) {
  return <header className="public-agent-chat-head"><div className="public-agent-avatar arisa-avatar"><Image src="/arisa-profile.webp" alt="Foto de perfil da Arisa" width={42} height={42} priority /></div><div><strong>Arisa</strong><span>Administradora da plataforma</span><small>Évora Urbanismo</small></div>{menu && <button className="arisa-icon-button" onClick={menu} aria-label="Abrir conversas e opções"><Icon kind="menu" /></button>}</header>;
}
type Membership = { organization_id: string; organizations: { name: string; trade_name: string | null; active: boolean } | null };
export default function ArisaChat({ initialThreadId }: { initialThreadId: string | null }) {
  useChatViewport();
  const [session, setSession] = useState<Session | null>(null), [loading, setLoading] = useState(true), [memberships, setMemberships] = useState<Membership[]>([]), [org, setOrg] = useState("");
  const [error, setError] = useState(""), [busy, setBusy] = useState(false);
  useEffect(() => {
    let alive = true;
    const supabase = client();
    supabase.auth.getSession().then(({ data, error }) => { if (alive) { setSession(data.session); setLoading(false); if (error) setError(errorText(error)); } });
    const subscription = supabase.auth.onAuthStateChange((_event, value) => { if (alive) { setSession(value); setLoading(false); if (!value) { setMemberships([]); setOrg(""); } } });
    return () => { alive = false; subscription.data.subscription.unsubscribe(); };
  }, []);
  const userId = session?.user.id;
  useEffect(() => {
    if (!userId) return;
    let alive = true;
    client().from("organization_members").select("organization_id,organizations(name,trade_name,active)").eq("user_id", userId).eq("active", true).eq("role", "admin").then(({ data, error }) => {
      if (!alive) return;
      if (error) { setError(errorText(error)); return; }
      const items = (data as unknown as Membership[] || []).filter(item => item.organizations?.active);
      setMemberships(items); setOrg(items.length === 1 ? items[0].organization_id : "");
      if (!items.length) setError("Este acesso é exclusivo de administradores ativos da plataforma.");
    });
    return () => { alive = false; };
  }, [userId]);
  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setError(""); const form = new FormData(event.currentTarget);
    try { const result = await client().auth.signInWithPassword({ email: String(form.get("email")), password: String(form.get("password")) }); if (result.error) throw new Error("Não foi possível entrar. Confira o e-mail e a senha."); } catch (error) { setError(errorText(error)); } finally { setBusy(false); }
  }
  if (userId && org) return <Conversation key={`${userId}:${org}`} userId={userId} organizationId={org} initialThreadId={initialThreadId} organizationName={memberships.find(item => item.organization_id === org)?.organizations?.trade_name || "Évora Urbanismo"} />;
  return <main id="conteudo-principal" className="public-agent-page bia-whatsapp arisa-chat"><div className="public-agent-shell"><section className="public-agent-chat-card"><Header /><div className="public-agent-messages arisa-login"><div className="public-agent-message assistant"><div className="public-agent-message-content"><p>Oi! Eu sou a Arisa, sua gestora da plataforma. Entre com sua conta administrativa para consultar informações, enviar documentos e me pedir para executar tarefas.</p></div></div>{loading ? <p role="status">Verificando sua sessão…</p> : !session ? <form onSubmit={signIn}><label>E-mail<input name="email" type="email" autoComplete="username" required /></label><label>Senha<input name="password" type="password" autoComplete="current-password" required /></label><button disabled={busy}>{busy ? "Entrando…" : "Conversar com a Arisa"}</button><small>Use o mesmo e-mail e senha da plataforma.</small></form> : <div><label>Organização<select value={org} onChange={event => setOrg(event.target.value)}><option value="">Selecione a organização</option>{memberships.map(item => <option key={item.organization_id} value={item.organization_id}>{item.organizations?.trade_name || item.organizations?.name}</option>)}</select></label><button onClick={() => void client().auth.signOut()}>Trocar de conta</button></div>}{error && <p role="alert">{error}</p>}<Link href="/">Voltar à plataforma</Link></div><footer className="arisa-login-footer">Arisa · Évora Gestão 6.29 · Acesso privado</footer></section></div></main>;
}

function Conversation({ userId, organizationId, organizationName, initialThreadId }: { userId: string; organizationId: string; organizationName: string; initialThreadId: string | null }) {
  const [threads, setThreads] = useState<Thread[]>([]), [threadId, setThreadId] = useState<string | null>(initialThreadId && UUID.test(initialThreadId) ? initialThreadId : null);
  const [messages, setMessages] = useState<Message[]>([]), [files, setFiles] = useState<ChatFile[]>([]), [actions, setActions] = useState<Action[]>([]), [draftFiles, setDraftFiles] = useState<ChatFile[]>([]);
  const [draft, setDraft] = useState(""), [busy, setBusy] = useState(false), [loading, setLoading] = useState(Boolean(initialThreadId)), [error, setError] = useState(""), [menu, setMenu] = useState(false), [recording, setRecording] = useState(false), [older, setOlder] = useState(false);
  const pane = useRef<HTMLDivElement>(null), input = useRef<HTMLTextAreaElement>(null), fileInput = useRef<HTMLInputElement>(null), pinned = useRef(true), creating = useRef<Promise<string> | null>(null), activeThread = useRef(threadId), working = useRef(false);
  const recorder = useRef<MediaRecorder | null>(null), recordTimer = useRef<ReturnType<typeof setTimeout> | null>(null), alive = useRef(true);
  const [clock, setClock] = useState(() => Date.now());
  const refreshThreads = useCallback(async () => { const value = await client().from("arisa_chat_threads").select("id,title,updated_at").eq("organization_id", organizationId).eq("owner_user_id", userId).order("updated_at", { ascending: false }).limit(100); if (value.error) throw value.error; if (alive.current) setThreads(value.data || []); }, [organizationId, userId]);
  const refresh = useCallback(async (id: string, olderThan?: string) => {
    let query = client().from("arisa_chat_messages").select("id,role,content,file_ids,status,parent_id,created_at,lease_expires_at,metadata").eq("thread_id", id).order("created_at", { ascending: false }).order("id", { ascending: false }).limit(100);
    if (olderThan) query = query.lt("created_at", olderThan);
    const [result, attached] = await Promise.all([query, client().from("arisa_chat_files").select("id,file_name,mime_type,storage_path,size_bytes,operation_item_id").eq("thread_id", id).order("created_at").limit(1000)]);
    if (result.error || attached.error) throw result.error || attached.error;
    if (!alive.current || activeThread.current !== id) return;
    const rows = (result.data || []).reverse() as Message[];
    const actionResult = rows.length ? await client().from("arisa_chat_actions").select("id,message_id,action,entity,record_id,summary,created_at").in("message_id", rows.filter(row => row.role === "user").map(row => row.id)).order("created_at").limit(1000) : { data: [], error: null };
    if (actionResult.error) throw actionResult.error;
    if (!alive.current || activeThread.current !== id) return;
    setMessages(previous => olderThan ? [...rows, ...previous.filter(row => !rows.some(item => item.id === row.id))] : rows);
    setActions(previous => olderThan ? [...actionResult.data as Action[], ...previous.filter(row => !actionResult.data?.some(item => item.id === row.id))] : actionResult.data as Action[]);
    setFiles(attached.data as ChatFile[]); setOlder(rows.length === 100); setClock(Date.now());
  }, []);
  useEffect(() => { alive.current = true; void refreshThreads().catch(error => setError(errorText(error))); return () => { alive.current = false; if (recordTimer.current) clearTimeout(recordTimer.current); const value = recorder.current; if (value) { value.onstop = null; if (value.state !== "inactive") value.stop(); value.stream.getTracks().forEach(track => track.stop()); } }; }, [refreshThreads]);
  useEffect(() => {
    if (!threadId) return;
    let cancelled = false;
    void refresh(threadId).catch(error => { if (!cancelled) setError(errorText(error)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [threadId, refresh]);
  const pending = messages.some(message => message.role === "user" && message.status === "processing");
  useEffect(() => { if (!threadId || !pending) return; const timer = setInterval(() => { void refresh(threadId).catch(() => {}); }, 6000); return () => clearInterval(timer); }, [threadId, pending, refresh]);
  useEffect(() => { const frame = requestAnimationFrame(() => { if (pinned.current && pane.current) pane.current.scrollTop = pane.current.scrollHeight; }); return () => cancelAnimationFrame(frame); }, [messages, busy, draftFiles]);
  function switchThread(id: string | null) {
    if (busy || recording || working.current) return;
    setThreadId(id); activeThread.current = id; setLoading(Boolean(id)); setMessages([]); setActions([]); setFiles([]); setDraftFiles([]); setDraft(""); setError(""); setMenu(false); pinned.current = true;
    window.history.pushState({}, "", id ? `/arisa?conversa=${id}` : "/arisa");
  }
  useEffect(() => { const pop = () => { if (working.current) return; const id = new URL(window.location.href).searchParams.get("conversa"); const next = id && UUID.test(id) ? id : null; activeThread.current = next; setThreadId(next); setLoading(Boolean(next)); setMessages([]); setDraft(""); setDraftFiles([]); }; window.addEventListener("popstate", pop); return () => window.removeEventListener("popstate", pop); }, []);
  async function ensureThread(): Promise<string> {
    if (activeThread.current) return activeThread.current;
    if (creating.current) return creating.current;
    creating.current = (async () => { const value = await client().rpc("arisa_chat_create_thread", { p_organization_id: organizationId }); if (value.error || !value.data?.id) throw value.error || new Error("Não foi possível iniciar a conversa."); const id = String(value.data.id); activeThread.current = id; setThreadId(id); window.history.replaceState({}, "", `/arisa?conversa=${id}`); await refreshThreads(); return id; })();
    try { return await creating.current; } finally { creating.current = null; }
  }
  async function send(retry?: Message) {
    if (working.current || recording || (!retry && !draft.trim() && !draftFiles.length)) return;
    working.current = true; setBusy(true); setError(""); pinned.current = true;
    let id: string | null = null;
    try {
      id = await ensureThread(); let messageId = retry?.id;
      if (!messageId) {
        messageId = crypto.randomUUID();
        const saved = await client().rpc("arisa_chat_send", { p_thread_id: id, p_message_id: messageId, p_content: draft.trim(), p_file_ids: draftFiles.map(file => file.id) });
        if (saved.error) {
          // A lost response is not proof of rollback: recover by this exact client-generated ID.
          const exists = await client().from("arisa_chat_messages").select("id").eq("id", messageId).maybeSingle();
          if (exists.error || !exists.data) throw saved.error;
        }
        setDraft(""); setDraftFiles([]); if (input.current) input.current.style.height = "46px";
      }
      await refresh(id);
      await callManager({ action: "chat", organizationId, messageId });
    } catch (error) { if (alive.current) setError(errorText(error)); }
    finally { if (id) await refresh(id).catch(() => {}); await refreshThreads().catch(() => {}); working.current = false; if (alive.current) setBusy(false); }
  }
  async function attach(incoming: File[]) {
    if (working.current || !incoming.length) return;
    if (draftFiles.length + incoming.length > 5) { setError("Envie até 5 arquivos por mensagem."); return; }
    working.current = true; setBusy(true); setError("");
    try { const id = await ensureThread(); for (const file of incoming) { const stored = await uploadFile(file, organizationId, userId, id); if (alive.current) setDraftFiles(previous => [...previous, stored]); } } catch (error) { setError(errorText(error)); } finally { working.current = false; if (alive.current) setBusy(false); }
  }
  async function startRecording() {
    if (working.current || draftFiles.length >= 5) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setError("Este navegador não permite gravação. Você pode anexar um áudio ou digitar."); return; }
    setError(""); working.current = true; setBusy(true);
    try {
      const id = await ensureThread();
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!alive.current) { stream.getTracks().forEach(track => track.stop()); return; }
      const mime = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm"].find(type => MediaRecorder.isTypeSupported(type));
      const value = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined); recorder.current = value;
      const chunks: Blob[] = []; value.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
      value.onerror = () => { stream.getTracks().forEach(track => track.stop()); setRecording(false); setError("A gravação foi interrompida. Tente novamente."); };
      value.onstop = async () => {
        stream.getTracks().forEach(track => track.stop()); if (recordTimer.current) clearTimeout(recordTimer.current); recorder.current = null;
        if (!alive.current) return; setRecording(false); working.current = true; setBusy(true);
        try {
          const type = value.mimeType.split(";")[0] || "audio/webm", file = new File(chunks, `audio-${Date.now()}.${type === "audio/mp4" ? "m4a" : "webm"}`, { type });
          const stored = await uploadFile(file, organizationId, userId, id); if (!alive.current) return; setDraftFiles(previous => [...previous, stored]);
          const transcribed = await callManager({ action: "transcribe", organizationId, fileId: stored.id });
          if (alive.current) { setDraft(previous => [previous, transcribed.text].filter(Boolean).join("\n").slice(0, 6000)); input.current?.focus(); }
        } catch (error) { if (alive.current) setError(errorText(error)); } finally { working.current = false; if (alive.current) setBusy(false); }
      };
      value.start(500); setRecording(true); recordTimer.current = setTimeout(() => { if (value.state !== "inactive") value.stop(); }, 90000);
    } catch (error) { setError(errorText(error)); } finally { working.current = false; setBusy(false); }
  }
  const fileMap = new Map([...files, ...draftFiles].map(file => [file.id, file]));
  const fileButton = (file: ChatFile) => <button className="arisa-file" key={file.id} onClick={() => void openFile(file).catch(error => setError(errorText(error)))}><Icon kind="attach" /><span>{file.file_name}<small>{Math.max(1, Math.round(file.size_bytes / 1024))} KB{file.operation_item_id ? " · Na fila documental" : ""}</small></span></button>;
  return <main id="conteudo-principal" className="public-agent-page bia-whatsapp arisa-chat"><div className="public-agent-shell"><section className="public-agent-chat-card"><Header menu={() => setMenu(previous => !previous)} />
    {menu && <aside className="arisa-conversations" aria-label="Conversas"><div className="arisa-menu-head"><strong>Suas conversas</strong><button onClick={() => setMenu(false)} aria-label="Fechar menu"><Icon kind="close" /></button></div><small>{organizationName}</small><button onClick={() => switchThread(null)} disabled={busy || recording}>+ Nova conversa</button><nav>{threads.map(thread => <button key={thread.id} aria-current={threadId === thread.id ? "page" : undefined} onClick={() => switchThread(thread.id)} disabled={busy || recording}>{thread.title}</button>)}</nav><div className="arisa-menu-links"><Link href="/">Abrir plataforma</Link><Link href="/?view=arisa">Fila de documentos</Link><Link href="/agenda">Agenda</Link><button disabled={busy || recording} onClick={() => void client().auth.signOut()}>Sair da conta</button></div></aside>}
    <div ref={pane} className="public-agent-messages" role="log" aria-label="Conversa com a Arisa" aria-live="polite" onScroll={() => { const value = pane.current; if (value) pinned.current = value.scrollHeight - value.scrollTop - value.clientHeight < 90; }}>
      {older && messages[0] && <button className="arisa-load-older" onClick={() => { pinned.current = false; void refresh(threadId!, messages[0].created_at).catch(error => setError(errorText(error))); }}>Carregar mensagens anteriores</button>}
      {!messages.length && !loading && <div className="public-agent-message assistant"><div className="public-agent-message-content"><p>Oi! Eu sou a Arisa, gestora da plataforma Évora. Posso consultar informações, analisar o financeiro, organizar o CRM e executar suas tarefas administrativas. Você também pode me enviar boletos, notas fiscais e outros documentos. O que vamos resolver?</p></div></div>}
      {loading && <p role="status">Carregando conversa…</p>}
      {messages.map(message => <div className={`public-agent-message ${message.role}`} key={message.id}><div className="public-agent-message-content">{message.content && <p>{message.content}</p>}{message.file_ids.map(id => fileMap.get(id)).filter((file): file is ChatFile => Boolean(file)).map(fileButton)}{actions.filter(action => action.message_id === (message.parent_id || message.id)).filter(() => message.role === "assistant" || !messages.some(reply => reply.parent_id === message.id)).map(action => <details className="arisa-action" key={action.id}><summary>✓ {action.action === "rpc" ? "Rotina executada" : action.summary}</summary>{action.action === "rpc" && <p>Solicitação: {action.summary}</p>}<p>Operação registrada na plataforma. Referência: {action.id.slice(0, 8)}.</p><Link href="/?view=auditoria">Consultar auditoria</Link></details>)}<div className="public-agent-message-meta"><time dateTime={message.created_at}>{new Date(message.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", timeZone: "America/Sao_Paulo" })}</time>{message.role === "user" && <span>{message.status === "completed" ? "✓✓" : message.status === "processing" ? "Processando" : message.status === "failed" ? "Interrompida" : "Salva"}</span>}</div>{message.role === "user" && (message.status === "failed" || message.status === "queued" || message.status === "processing" && message.lease_expires_at && new Date(message.lease_expires_at).getTime() < clock) && <button className="arisa-retry" disabled={busy} onClick={() => void send(message)}>Retomar esta mensagem</button>}{message.status === "failed" && message.metadata.message && <small className="arisa-message-error">{message.metadata.message}</small>}</div></div>)}
      {busy && <div className="arisa-working" role="status">Arisa está trabalhando…</div>}
    </div>
    {error && <div className="public-agent-alert" role="alert">{error}<button onClick={() => setError("")} aria-label="Fechar aviso">×</button></div>}
    {!!draftFiles.length && <div className="arisa-draft-files">{draftFiles.map(file => <div key={file.id}>{fileButton(file)}<button disabled={busy} onClick={() => setDraftFiles(previous => previous.filter(item => item.id !== file.id))} aria-label={`Remover ${file.file_name} da mensagem`}>×</button></div>)}</div>}
    <input type="file" ref={fileInput} hidden multiple accept=".pdf,.png,.jpg,.jpeg,.webp,.xml,.csv,.ofx,.txt,.mp3,.m4a,.wav,.webm" onChange={event => { const selected = Array.from(event.target.files || []); event.target.value = ""; void attach(selected); }} />
    {recording ? <div className="arisa-recording" role="status"><span>● Gravando áudio · até 90 segundos</span><button onClick={() => recorder.current?.stop()} aria-label="Concluir gravação"><Icon kind="stop" /></button></div> : <form className="public-agent-composer arisa-composer" onSubmit={event => { event.preventDefault(); void send(); }}><button className="arisa-attach" type="button" disabled={busy} onClick={() => fileInput.current?.click()} aria-label="Anexar documento"><Icon kind="attach" /></button><textarea ref={input} value={draft} maxLength={6000} rows={1} aria-label="Mensagem para Arisa" placeholder="Mensagem" disabled={busy} onChange={event => { setDraft(event.target.value); event.target.style.height = "46px"; event.target.style.height = Math.min(112, event.target.scrollHeight) + "px"; }} onKeyDown={event => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing && window.matchMedia("(pointer:fine)").matches) { event.preventDefault(); void send(); } }} />{draft.trim() || draftFiles.length ? <button type="submit" disabled={busy} aria-label="Enviar mensagem"><Icon kind="send" /></button> : <button type="button" disabled={busy} onClick={() => void startRecording()} aria-label="Gravar mensagem de voz"><Icon kind="mic" /></button>}</form>}
    <details className="bia-chat-privacy"><summary>Gestão com IA · Acesso privado</summary><div><p>Conversas e documentos ficam vinculados à sua conta e organização. Os pedidos são executados com sua alçada administrativa e registrados na auditoria.</p><p>Não envie senhas. A Arisa registra e programa operações financeiras; não realiza transferências bancárias. Revise a transcrição de voz antes de enviar.</p><Link href="/">Évora Gestão · Versão 6.29</Link></div></details>
  </section></div></main>;
}
