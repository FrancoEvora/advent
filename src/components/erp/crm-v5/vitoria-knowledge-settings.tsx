"use client";

import { ChangeEvent, useCallback, useEffect, useMemo, useState } from "react";

import type { ErpData } from "../types";
import { Status } from "./shared";

type KnowledgeSource = {
  id: string;
  project_id?: string | null;
  scope: "organization" | "project";
  source_type: "text" | "file";
  title: string;
  content_preview?: string | null;
  original_filename?: string | null;
  mime_type?: string | null;
  bytes?: number | null;
  vector_file_status: "pending" | "processing" | "completed" | "failed";
  active: boolean;
  updated_at?: string | null;
};

type ApiPayload = {
  ok?: boolean;
  error?: string;
  sources?: KnowledgeSource[];
  id?: string;
  status?: string;
};

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || "https://qsdffayasuzsmngteika.supabase.co";
const ENDPOINT = `${SUPABASE_URL.replace(/\/$/, "")}/functions/v1/enterprise-vitoria-knowledge`;
const ALLOWED_EXTENSIONS = ".pdf,.txt,.md,.doc,.docx";
const MAX_FILE_BYTES = 20 * 1024 * 1024;

function statusLabel(status: KnowledgeSource["vector_file_status"]) {
  return ({ pending: "pendente", processing: "indexando", completed: "disponível", failed: "falhou" } as Record<string, string>)[status] || status;
}

function statusTone(status: KnowledgeSource["vector_file_status"]): "success" | "info" | "danger" | "neutral" {
  if (status === "completed") return "success";
  if (status === "processing") return "info";
  if (status === "failed") return "danger";
  return "neutral";
}

function bytesLabel(bytes?: number | null) {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function errorLabel(code?: string) {
  const map: Record<string, string> = {
    SESSION_REQUIRED: "Faça login novamente para gerenciar a base da Vitória.",
    SESSION_EXPIRED: "Sua sessão expirou. Entre novamente.",
    AI_RUNTIME_PERMISSION_REQUIRED: "Seu perfil não possui permissão para gerenciar a base da Vitória.",
    OPENAI_KEY_REQUIRED: "Cadastre a chave OpenAI na configuração da Vitória antes de indexar conhecimento.",
    INVALID_KNOWLEDGE_TEXT: "O texto precisa ter entre 10 e 120.000 caracteres.",
    INVALID_KNOWLEDGE_FILE: "O arquivo precisa ter até 20 MB.",
    UNSUPPORTED_KNOWLEDGE_FILE: "Formato não suportado. Use PDF, TXT, Markdown, DOC ou DOCX.",
    KNOWLEDGE_INDEXING_FAILED: "A OpenAI não conseguiu indexar este conteúdo agora.",
    KNOWLEDGE_FILE_UPLOAD_FAILED: "O arquivo não pôde ser enviado para a base da Vitória.",
    KNOWLEDGE_STORAGE_FAILED: "O arquivo não pôde ser armazenado com segurança.",
  };
  return map[code || ""] || "Não foi possível concluir a operação da base de conhecimento.";
}

export function VitoriaKnowledgeSettings({ data, canManage }: { data: ErpData; canManage: boolean }) {
  const [sources, setSources] = useState<KnowledgeSource[]>([]);
  const [mode, setMode] = useState<"text" | "file">("text");
  const [scope, setScope] = useState<"organization" | "project">("organization");
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const token = data.session.access_token;
  const organizationId = data.organization.id;
  const activeProjects = useMemo(() => data.projects.filter((project) => project.active).sort((a, b) => a.name.localeCompare(b.name, "pt-BR")), [data.projects]);

  const call = useCallback(async (body: Record<string, unknown>) => {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ organizationId, ...body }),
      cache: "no-store",
    });
    const payload = (await response.json().catch(() => null)) as ApiPayload | null;
    if (!response.ok || !payload?.ok) throw new Error(payload?.error || "KNOWLEDGE_UNAVAILABLE");
    return payload;
  }, [organizationId, token]);

  const load = useCallback(async () => {
    if (!canManage || !token) return;
    setLoading(true);
    try {
      const payload = await call({ action: "list" });
      setSources(payload.sources || []);
      setError(null);
    } catch (reason) {
      setError(errorLabel(reason instanceof Error ? reason.message : undefined));
    } finally {
      setLoading(false);
    }
  }, [call, canManage, token]);

  useEffect(() => { void load(); }, [load]);

  function reset() {
    setTitle("");
    setText("");
    setFile(null);
  }

  async function addText() {
    if (!title.trim() || text.trim().length < 10) {
      setError("Informe um título e um texto útil para a Vitória.");
      return;
    }
    if (scope === "project" && !projectId) {
      setError("Selecione o empreendimento ao qual este conhecimento pertence.");
      return;
    }
    setBusy(true); setError(null); setMessage(null);
    try {
      await call({ action: "add_text", title: title.trim(), text: text.trim(), scope, projectId: scope === "project" ? projectId : null });
      reset();
      setMessage("Conteúdo adicionado. A Vitória poderá consultá-lo nas próximas conversas.");
      await load();
    } catch (reason) {
      setError(errorLabel(reason instanceof Error ? reason.message : undefined));
    } finally { setBusy(false); }
  }

  async function addFile() {
    if (!title.trim() || !file) {
      setError("Informe um título e selecione um arquivo.");
      return;
    }
    if (file.size > MAX_FILE_BYTES) {
      setError("O arquivo deve ter no máximo 20 MB.");
      return;
    }
    if (scope === "project" && !projectId) {
      setError("Selecione o empreendimento ao qual este arquivo pertence.");
      return;
    }
    setBusy(true); setError(null); setMessage(null);
    try {
      const form = new FormData();
      form.set("action", "add_file");
      form.set("organizationId", organizationId);
      form.set("title", title.trim());
      form.set("scope", scope);
      if (scope === "project") form.set("projectId", projectId);
      form.set("file", file, file.name);
      const response = await fetch(ENDPOINT, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: form, cache: "no-store" });
      const payload = (await response.json().catch(() => null)) as ApiPayload | null;
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || "KNOWLEDGE_UNAVAILABLE");
      reset();
      setMessage("Arquivo recebido e enviado para indexação na base da Vitória.");
      await load();
    } catch (reason) {
      setError(errorLabel(reason instanceof Error ? reason.message : undefined));
    } finally { setBusy(false); }
  }

  async function remove(source: KnowledgeSource) {
    if (!window.confirm(`Remover “${source.title}” da base da Vitória?`)) return;
    setBusy(true); setError(null); setMessage(null);
    try {
      await call({ action: "delete", sourceId: source.id });
      setMessage("Fonte removida da base de conhecimento.");
      await load();
    } catch (reason) {
      setError(errorLabel(reason instanceof Error ? reason.message : undefined));
    } finally { setBusy(false); }
  }

  function chooseFile(event: ChangeEvent<HTMLInputElement>) {
    const selected = event.target.files?.[0] || null;
    setFile(selected);
    if (selected && !title.trim()) setTitle(selected.name.replace(/\.[^.]+$/, "").slice(0, 180));
  }

  if (!canManage) return null;

  return <section className="crm5-panel" id="vitoria-knowledge-setup">
    <header>
      <div>
        <small>CONHECIMENTO CORPORATIVO</small>
        <h3>Base de conhecimento da Vitória</h3>
        <p>Ensine a Vitória sobre a Évora Urbanismo, seus empreendimentos, conceitos, diferenciais, políticas comerciais e materiais institucionais. Ela consulta essa base para responder com mais precisão.</p>
      </div>
      <Status tone={sources.length ? "success" : "neutral"}>{sources.length ? `${sources.length} fonte${sources.length === 1 ? "" : "s"}` : "base inicial"}</Status>
    </header>

    <div className="crm5-policy-grid">
      <article><strong>Évora primeiro</strong><span>A empresa e seus empreendimentos são a especialidade prioritária da Vitória</span></article>
      <article><strong>Busca documental</strong><span>PDF, Word, texto e Markdown ficam disponíveis para consulta sem entrar no prompt inteiro</span></article>
      <article><strong>Base privada</strong><span>Arquivos originais ficam em armazenamento privado e não são publicados no site</span></article>
      <article><strong>Governança</strong><span>Em conflito de informações, a Vitória deve pedir confirmação em vez de inventar</span></article>
    </div>

    <div className="crm5-actions" style={{ marginTop: 16 }}>
      <button className={mode === "text" ? "primary" : ""} onClick={() => setMode("text")} disabled={busy}>Adicionar texto</button>
      <button className={mode === "file" ? "primary" : ""} onClick={() => setMode("file")} disabled={busy}>Adicionar arquivo</button>
      <button onClick={() => void load()} disabled={busy || loading}>{loading ? "Atualizando..." : "Atualizar lista"}</button>
    </div>

    <div className="crm5-form-grid" style={{ marginTop: 14 }}>
      <label><span>Escopo</span><select value={scope} disabled={busy} onChange={(event) => { const next=event.target.value === "project" ? "project" : "organization"; setScope(next); if(next === "organization") setProjectId(""); }}><option value="organization">Toda a Évora Urbanismo</option><option value="project">Empreendimento específico</option></select></label>
      {scope === "project" && <label><span>Empreendimento</span><select value={projectId} disabled={busy} onChange={(event) => setProjectId(event.target.value)}><option value="">Selecione</option>{activeProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
      <label><span>Título da fonte</span><input value={title} disabled={busy} maxLength={180} onChange={(event) => setTitle(event.target.value)} placeholder="Ex.: Conceito do Parque das Árvores" /></label>
    </div>

    {mode === "text" ? <label className="crm5-field" style={{ marginTop: 14 }}><span>Texto / orientação</span><textarea value={text} disabled={busy} maxLength={120000} rows={9} onChange={(event) => setText(event.target.value)} placeholder="Cole aqui informações institucionais, diferenciais, posicionamento, perguntas frequentes, regras de atendimento ou qualquer conteúdo que a Vitória deva conhecer..." /><small>{text.length.toLocaleString("pt-BR")} / 120.000 caracteres</small></label> : <div className="crm5-field" style={{ marginTop: 14 }}><span>Arquivo</span><input type="file" accept={ALLOWED_EXTENSIONS} disabled={busy} onChange={chooseFile} />{file && <small>{file.name} · {bytesLabel(file.size)}</small>}<small>PDF, TXT, Markdown, DOC ou DOCX · até 20 MB</small></div>}

    <div className="crm5-actions" style={{ marginTop: 14 }}><button className="primary" disabled={busy} onClick={() => void (mode === "text" ? addText() : addFile())}>{busy ? "Processando..." : mode === "text" ? "Adicionar à base da Vitória" : "Enviar e indexar arquivo"}</button></div>
    {message && <p className="crm5-callout success">{message}</p>}
    {error && <p className="crm5-callout danger">{error}</p>}
    <p className="crm5-muted">Use somente materiais que a Évora pode utilizar no atendimento. Não envie listas de clientes, documentos pessoais, CPF/RG ou dados sensíveis para esta base.</p>

    <div className="crm5-stack" style={{ marginTop: 18 }}>
      {sources.length === 0 && !loading ? <p className="crm5-muted">Nenhuma fonte adicional cadastrada. A Vitória já possui uma base institucional inicial e ganhará profundidade conforme os materiais forem adicionados aqui.</p> : sources.map((source) => {
        const project = source.project_id ? data.projects.find((item) => item.id === source.project_id) : null;
        return <article className="crm5-panel" key={source.id} style={{ margin: 0, padding: 14 }}><header style={{ marginBottom: 8 }}><div><strong>{source.title}</strong><small>{source.scope === "organization" ? "Évora Urbanismo · escopo geral" : project?.name || "Empreendimento específico"}{source.original_filename ? ` · ${source.original_filename}` : ""}{source.bytes ? ` · ${bytesLabel(source.bytes)}` : ""}</small></div><Status tone={statusTone(source.vector_file_status)}>{statusLabel(source.vector_file_status)}</Status></header>{source.content_preview && <p className="crm5-muted">{source.content_preview}</p>}<div className="crm5-actions"><button disabled={busy} onClick={() => void remove(source)}>Remover</button></div></article>;
      })}
    </div>
  </section>;
}
