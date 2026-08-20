"use client";

import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import type { ErpData } from "../types";
import { Status } from "./shared";

type KnowledgeStatus = {
  apiKeyConfigured: boolean;
  vectorStoreConfigured: boolean;
  biaEnabled: boolean;
  apiKeyVersion: number;
  runtimeError: string | null;
  readyDocuments: number;
  processingDocuments: number;
};

type KnowledgeDocument = {
  id: string;
  title: string;
  description: string | null;
  sourceType: "file" | "text";
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  status: "processing" | "ready" | "failed" | "deleting";
  preview: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

type ApiPayload = {
  ok?: boolean;
  status?: KnowledgeStatus;
  documents?: KnowledgeDocument[];
  document?: KnowledgeDocument;
  error?: string;
};

type SourceType = "file" | "text";

const MAX_FILE_BYTES = 10 * 1024 * 1024;

function errorMessage(code?: string) {
  const messages: Record<string, string> = {
    AI_KNOWLEDGE_PERMISSION_REQUIRED:
      "Seu perfil não possui permissão para administrar a base da Bia.",
    AI_KNOWLEDGE_OPENAI_KEY_REQUIRED:
      "Cadastre a chave OpenAI da Bia antes de incluir conhecimento.",
    KNOWLEDGE_FILE_REQUIRED: "Selecione um arquivo para continuar.",
    KNOWLEDGE_FILE_TOO_LARGE: "O arquivo excede o limite de 10 MB.",
    KNOWLEDGE_FILE_TYPE_NOT_ALLOWED:
      "Formato não permitido. Use TXT, Markdown, PDF, DOCX, CSV, JSON ou HTML.",
    INVALID_KNOWLEDGE_TEXT:
      "Informe um texto válido com até 100 mil caracteres.",
    INVALID_KNOWLEDGE_TITLE: "Informe um título com até 180 caracteres.",
    INVALID_KNOWLEDGE_DESCRIPTION:
      "A descrição deve ter no máximo 1.000 caracteres.",
    AI_KNOWLEDGE_CATALOG_SAVE_FAILED:
      "O arquivo foi processado, mas o catálogo interno não pôde ser atualizado.",
    AI_KNOWLEDGE_LIST_FAILED:
      "A base de conhecimento não pôde ser consultada.",
    AI_KNOWLEDGE_DELETE_FAILED:
      "O material não pôde ser excluído da base da Bia.",
    KNOWLEDGE_DOCUMENT_NOT_FOUND: "O material não foi localizado.",
    OPENAI_RATE_LIMIT_EXCEEDED:
      "O provedor de IA atingiu o limite temporário. Tente novamente em alguns minutos.",
  };
  if (code?.startsWith("OPENAI_")) {
    return "O provedor de IA não concluiu a operação. Tente novamente ou revise a configuração da Bia.";
  }
  return messages[code || ""] || "Não foi possível concluir a operação.";
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function statusTone(status: KnowledgeDocument["status"]) {
  if (status === "ready") return "success";
  if (status === "failed") return "danger";
  if (status === "processing") return "warning";
  return "neutral";
}

function statusLabel(status: KnowledgeDocument["status"]) {
  if (status === "ready") return "Disponível para a Bia";
  if (status === "failed") return "Falha na indexação";
  if (status === "processing") return "Processando";
  return "Excluindo";
}

export function BiaKnowledgeBase({
  data,
  canManage,
}: {
  data: ErpData;
  canManage: boolean;
}) {
  const [status, setStatus] = useState<KnowledgeStatus | null>(null);
  const [documents, setDocuments] = useState<KnowledgeDocument[]>([]);
  const [sourceType, setSourceType] = useState<SourceType>("file");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [textContent, setTextContent] = useState("");
  const [selectedFileName, setSelectedFileName] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const fileInput = useRef<HTMLInputElement | null>(null);

  const organizationId = data.organization.id;
  const token = data.session.access_token;

  const load = useCallback(async () => {
    if (!canManage || !token) return;
    setBusy("load");
    try {
      const response = await fetch(
        `/api/ai/knowledge?organizationId=${encodeURIComponent(organizationId)}`,
        {
          headers: { Authorization: `Bearer ${token}` },
          cache: "no-store",
        },
      );
      const payload = (await response.json()) as ApiPayload;
      if (!response.ok || !payload.status || !payload.documents) {
        throw new Error(payload.error || "AI_KNOWLEDGE_LIST_FAILED");
      }
      setStatus(payload.status);
      setDocuments(payload.documents);
      setError("");
    } catch (reason) {
      setError(errorMessage(reason instanceof Error ? reason.message : undefined));
    } finally {
      setBusy("");
    }
  }, [canManage, organizationId, token]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  function resetForm() {
    setTitle("");
    setDescription("");
    setTextContent("");
    setSelectedFileName("");
    if (fileInput.current) fileInput.current.value = "";
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token) return;
    setMessage("");
    setError("");

    const file = fileInput.current?.files?.[0] || null;
    if (sourceType === "file" && !file) {
      setError(errorMessage("KNOWLEDGE_FILE_REQUIRED"));
      return;
    }
    if (file && file.size > MAX_FILE_BYTES) {
      setError(errorMessage("KNOWLEDGE_FILE_TOO_LARGE"));
      return;
    }
    if (sourceType === "text" && !textContent.trim()) {
      setError(errorMessage("INVALID_KNOWLEDGE_TEXT"));
      return;
    }

    setBusy("save");
    try {
      const form = new FormData();
      form.set("organizationId", organizationId);
      form.set("sourceType", sourceType);
      form.set("title", title.trim());
      form.set("description", description.trim());
      if (sourceType === "text") form.set("textContent", textContent.trim());
      if (file) form.set("file", file);

      const response = await fetch("/api/ai/knowledge", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      const payload = (await response.json()) as ApiPayload;
      if (!response.ok || !payload.document) {
        throw new Error(payload.error || "AI_KNOWLEDGE_UNAVAILABLE");
      }

      resetForm();
      setMessage(
        payload.document.status === "ready"
          ? "Material incluído e já disponível para consulta pela Bia."
          : "Material incluído. A indexação continuará em segundo plano.",
      );
      await load();
    } catch (reason) {
      setError(errorMessage(reason instanceof Error ? reason.message : undefined));
    } finally {
      setBusy("");
    }
  }

  async function remove(document: KnowledgeDocument) {
    if (!token || busy) return;
    if (
      !window.confirm(
        `Excluir “${document.title}” da base de conhecimento da Bia?`,
      )
    ) {
      return;
    }

    setMessage("");
    setError("");
    setBusy(`delete-${document.id}`);
    try {
      const response = await fetch("/api/ai/knowledge", {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ organizationId, documentId: document.id }),
      });
      const payload = (await response.json()) as ApiPayload;
      if (!response.ok) {
        throw new Error(payload.error || "AI_KNOWLEDGE_DELETE_FAILED");
      }
      setDocuments((current) =>
        current.filter((item) => item.id !== document.id),
      );
      setMessage("Material excluído da base de conhecimento da Bia.");
      await load();
    } catch (reason) {
      setError(errorMessage(reason instanceof Error ? reason.message : undefined));
    } finally {
      setBusy("");
    }
  }

  if (!canManage) return null;

  const runtimeBlocked =
    status?.runtimeError === "AI_KNOWLEDGE_OPENAI_KEY_REQUIRED";

  return (
    <section className="crm5-panel bia-knowledge" id="bia-knowledge-base">
      <header className="bia-knowledge-header">
        <div>
          <small>CONHECIMENTO APROVADO</small>
          <h3>Base de conhecimento da Bia</h3>
          <p>
            Inclua documentos e orientações comerciais que a Bia poderá
            pesquisar durante o atendimento. Somente materiais com status
            disponível entram nas respostas.
          </p>
        </div>
        <div className="bia-knowledge-status">
          <Status
            tone={
              runtimeBlocked
                ? "danger"
                : status?.readyDocuments
                  ? "success"
                  : "neutral"
            }
          >
            {runtimeBlocked
              ? "Configure a chave OpenAI"
              : `${status?.readyDocuments || 0} material(is) ativo(s)`}
          </Status>
          <button type="button" onClick={() => void load()} disabled={Boolean(busy)}>
            {busy === "load" ? "Atualizando..." : "Atualizar"}
          </button>
        </div>
      </header>

      <div className="bia-knowledge-summary">
        <article>
          <strong>{status?.readyDocuments || 0}</strong>
          <span>Prontos para consulta</span>
        </article>
        <article>
          <strong>{status?.processingDocuments || 0}</strong>
          <span>Em processamento</span>
        </article>
        <article>
          <strong>{status?.vectorStoreConfigured ? "Ativa" : "Automática"}</strong>
          <span>Biblioteca vetorial</span>
        </article>
        <article>
          <strong>{status?.biaEnabled ? "Ligada" : "Desligada"}</strong>
          <span>Atendimento da Bia</span>
        </article>
      </div>

      <form className="bia-knowledge-form" onSubmit={submit}>
        <div
          className="bia-knowledge-source-tabs"
          role="tablist"
          aria-label="Tipo de conhecimento"
        >
          <button
            type="button"
            role="tab"
            aria-selected={sourceType === "file"}
            className={sourceType === "file" ? "active" : ""}
            onClick={() => setSourceType("file")}
          >
            Enviar arquivo
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={sourceType === "text"}
            className={sourceType === "text" ? "active" : ""}
            onClick={() => setSourceType("text")}
          >
            Cadastrar texto
          </button>
        </div>

        <div className="form-grid">
          <label>
            Título
            <input
              value={title}
              maxLength={180}
              required={sourceType === "text"}
              onChange={(event) => setTitle(event.target.value)}
              placeholder={
                sourceType === "file"
                  ? "Opcional — usa o nome do arquivo"
                  : "Ex.: Política comercial do Solaris"
              }
            />
          </label>
          <label>
            Descrição interna
            <input
              value={description}
              maxLength={1000}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="Finalidade, vigência ou responsável pelo conteúdo"
            />
          </label>

          {sourceType === "file" ? (
            <label className="span-2 bia-knowledge-file">
              Arquivo
              <input
                ref={fileInput}
                type="file"
                required
                accept=".txt,.md,.pdf,.docx,.csv,.json,.html,.htm"
                onChange={(event) =>
                  setSelectedFileName(event.target.files?.[0]?.name || "")
                }
              />
              <span>
                {selectedFileName ||
                  "TXT, Markdown, PDF, DOCX, CSV, JSON ou HTML · até 10 MB"}
              </span>
            </label>
          ) : (
            <label className="span-2">
              Conteúdo
              <textarea
                value={textContent}
                maxLength={100000}
                rows={8}
                required
                onChange={(event) => setTextContent(event.target.value)}
                placeholder="Cole aqui informações institucionais, perguntas frequentes, regras comerciais, diferenciais, orientações de atendimento ou respostas aprovadas."
              />
            </label>
          )}
        </div>

        <footer>
          <span>
            A Bia utiliza este conteúdo como fonte de consulta; preços,
            estoque, simulações e disponibilidade continuam vindo do ERP.
          </span>
          <button
            className="primary"
            disabled={Boolean(busy) || runtimeBlocked}
          >
            {busy === "save" ? "Incluindo..." : "Incluir na base da Bia"}
          </button>
        </footer>
      </form>

      {(message || error) && (
        <div
          className={`bia-knowledge-feedback ${error ? "error" : ""}`}
          role={error ? "alert" : "status"}
        >
          <span>{error || message}</span>
          <button
            type="button"
            aria-label="Fechar aviso"
            onClick={() => {
              setError("");
              setMessage("");
            }}
          >
            ×
          </button>
        </div>
      )}

      <div className="bia-knowledge-list">
        <header>
          <div>
            <small>MATERIAIS INDEXADOS</small>
            <strong>{documents.length} registro(s)</strong>
          </div>
          <span>
            A exclusão remove o material da pesquisa da Bia e do provedor de
            IA.
          </span>
        </header>

        {documents.map((document) => (
          <article key={document.id}>
            <div className="bia-knowledge-icon" aria-hidden="true">
              {document.sourceType === "text" ? "T" : "▤"}
            </div>
            <div>
              <strong>{document.title}</strong>
              <small>
                {document.fileName} · {formatBytes(document.sizeBytes)} ·{" "}
                {formatDate(document.createdAt)}
              </small>
              {document.description && <p>{document.description}</p>}
              {document.preview && document.sourceType === "text" && (
                <p className="bia-knowledge-preview">{document.preview}</p>
              )}
              {document.error && (
                <p className="bia-knowledge-error">{document.error}</p>
              )}
            </div>
            <Status tone={statusTone(document.status)}>
              {statusLabel(document.status)}
            </Status>
            <button
              type="button"
              className="danger-button"
              disabled={Boolean(busy) || document.status === "deleting"}
              onClick={() => void remove(document)}
            >
              {busy === `delete-${document.id}` ? "Excluindo..." : "Excluir"}
            </button>
          </article>
        ))}

        {!documents.length && (
          <div className="bia-knowledge-empty">
            <b>＋</b>
            <div>
              <strong>Nenhum material cadastrado</strong>
              <p>
                Inclua o primeiro arquivo ou texto aprovado para ampliar o
                repertório da Bia.
              </p>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
