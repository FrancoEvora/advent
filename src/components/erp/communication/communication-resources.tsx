"use client";

import {
  FormEvent,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { getSupabase } from "@/lib/supabase";
import type { DocumentAttachment, ErpData } from "../types";

type LinkItem = {
  id: string;
  title: string;
  url: string;
  notes: string | null;
  created_at: string;
};

type MarketingAsset = {
  id: string;
  name: string;
  asset_type: string;
  storage_path: string | null;
  public_url: string | null;
  source: "crm" | "marketing";
  project_id: string | null;
  expires_at: string | null;
  tags: string[] | null;
};

export type CommunicationShareTarget = {
  name: string;
  phone?: string | null;
  email?: string | null;
  subject?: string;
  message?: string;
  projectId?: string | null;
};

export type CommunicationShareChannel = "whatsapp" | "email" | "copy";

const safe = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .slice(-100);

function normalizeWhatsApp(value: string) {
  const digits = value.replace(/\D/g, "");
  if (!digits) return "";
  return digits.startsWith("55") ? digits : "55" + digits;
}

export function CommunicationResources({
  data,
  entityType,
  entityId,
  shareTarget,
  onPrepared,
}: {
  data: ErpData;
  entityType: string;
  entityId: string;
  shareTarget?: CommunicationShareTarget;
  onPrepared?: (channel: CommunicationShareChannel) => Promise<void> | void;
}) {
  const [files, setFiles] = useState<DocumentAttachment[]>([]);
  const [links, setLinks] = useState<LinkItem[]>([]);
  const [library, setLibrary] = useState<MarketingAsset[]>([]);
  const [selectedAssetId, setSelectedAssetId] = useState("");
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    const supabase = getSupabase();
    if (!supabase) return;
    const today = new Date().toISOString().slice(0, 10);
    const [fileResult, linkResult, crmAssetResult, marketingAssetResult] =
      await Promise.all([
      supabase
        .from("document_attachments")
        .select("*")
        .eq("organization_id", data.organization.id)
        .eq("entity_type", entityType)
        .eq("entity_id", entityId)
        .order("created_at", { ascending: false }),
      supabase
        .from("communication_links")
        .select("*")
        .eq("organization_id", data.organization.id)
        .eq("entity_type", entityType)
        .eq("entity_id", entityId)
        .order("created_at", { ascending: false }),
        supabase
          .from("crm_marketing_assets")
          .select(
            "id,name,asset_type,storage_path,external_url,project_id,tags,active",
          )
          .eq("organization_id", data.organization.id)
          .eq("active", true)
          .order("name"),
        supabase
          .from("marketing_assets")
          .select(
            "id,name,asset_type,storage_path,public_url,project_id,status,expires_at,tags",
          )
          .eq("organization_id", data.organization.id)
          .in("status", ["aprovado", "publicado"])
          .or("expires_at.is.null,expires_at.gte." + today)
          .order("name"),
      ]);

    if (fileResult.error || linkResult.error) {
      setError(
        fileResult.error?.message ||
          linkResult.error?.message ||
          "Não foi possível carregar os materiais.",
      );
      return;
    }
    setFiles((fileResult.data || []) as DocumentAttachment[]);
    setLinks((linkResult.data || []) as LinkItem[]);
    const projectId = shareTarget?.projectId || null;
    const crmAssets = crmAssetResult.error
      ? []
      : (crmAssetResult.data || []).map((asset) => ({
          id: asset.id,
          name: asset.name,
          asset_type: asset.asset_type,
          storage_path: asset.storage_path,
          public_url: asset.external_url,
          source: "crm" as const,
          project_id: asset.project_id,
          expires_at: null,
          tags: asset.tags,
        }));
    const marketingAssets = marketingAssetResult.error
      ? []
      : (marketingAssetResult.data || []).map((asset) => ({
          id: asset.id,
          name: asset.name,
          asset_type: asset.asset_type,
          storage_path: asset.storage_path,
          public_url: asset.public_url,
          source: "marketing" as const,
          project_id: asset.project_id,
          expires_at: asset.expires_at,
          tags: asset.tags,
        }));
    setLibrary(
      [...crmAssets, ...marketingAssets].filter(
        (asset) => !projectId || !asset.project_id || asset.project_id === projectId,
      ),
    );
  }, [
    data.organization.id,
    entityId,
    entityType,
    shareTarget?.projectId,
  ]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const itemCount = files.length + links.length;
  const selectedAsset = useMemo(
    () => library.find((asset) => asset.id === selectedAssetId) || null,
    [library, selectedAssetId],
  );

  function resetMessages() {
    setError("");
    setMessage("");
  }

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    resetMessages();
    setBusy("upload");
    try {
      const form = new FormData(event.currentTarget);
      const file = form.get("file") as File;
      if (!file?.size) throw new Error("Selecione um arquivo.");
      const max =
        Number(data.settings.document_max_size_mb || 20) * 1024 * 1024;
      if (file.size > max) {
        throw new Error(
          "O arquivo supera " +
            (data.settings.document_max_size_mb || 20) +
            " MB.",
        );
      }
      const supabase = getSupabase();
      if (!supabase) throw new Error("Supabase indisponível.");
      const path =
        data.organization.id +
        "/" +
        entityType +
        "/" +
        entityId +
        "/" +
        crypto.randomUUID() +
        "-" +
        safe(file.name);
      const uploaded = await supabase.storage
        .from("erp-documents")
        .upload(path, file, {
          contentType: file.type || "application/octet-stream",
          upsert: false,
        });
      if (uploaded.error) throw uploaded.error;
      const metadata = await supabase.from("document_attachments").insert({
        organization_id: data.organization.id,
        entity_type: entityType,
        entity_id: entityId,
        document_type: "comunicacao",
        file_name: file.name,
        storage_path: path,
        mime_type: file.type || null,
        size_bytes: file.size,
        notes: String(form.get("notes") || "") || null,
        uploaded_by: data.session.user.id,
      });
      if (metadata.error) {
        await supabase.storage.from("erp-documents").remove([path]);
        throw metadata.error;
      }
      event.currentTarget.reset();
      setMessage("Arquivo anexado à comunicação.");
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível anexar o arquivo.",
      );
    } finally {
      setBusy("");
    }
  }

  async function addLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    resetMessages();
    setBusy("link");
    try {
      const form = new FormData(event.currentTarget);
      const raw = String(form.get("url") || "").trim();
      const parsed = new URL(raw);
      if (!["https:", "http:"].includes(parsed.protocol)) {
        throw new Error("Use um link iniciado por https:// ou http://.");
      }
      const url = parsed.toString();
      const supabase = getSupabase();
      if (!supabase) throw new Error("Supabase indisponível.");
      const result = await supabase.from("communication_links").insert({
        organization_id: data.organization.id,
        entity_type: entityType,
        entity_id: entityId,
        title: String(form.get("title") || "Link"),
        url,
        notes: String(form.get("notes") || "") || null,
        created_by: data.session.user.id,
      });
      if (result.error) throw result.error;
      event.currentTarget.reset();
      setMessage("Link adicionado à comunicação.");
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "O link informado é inválido.",
      );
    } finally {
      setBusy("");
    }
  }

  async function attachLibraryAsset() {
    resetMessages();
    if (!selectedAsset) {
      setError("Selecione um material aprovado da biblioteca.");
      return;
    }
    setBusy("library");
    try {
      const supabase = getSupabase();
      if (!supabase) throw new Error("Supabase indisponível.");
      if (selectedAsset.public_url) {
        if (links.some((item) => item.url === selectedAsset.public_url)) {
          throw new Error("Este material já está vinculado à comunicação.");
        }
        const result = await supabase.from("communication_links").insert({
          organization_id: data.organization.id,
          entity_type: entityType,
          entity_id: entityId,
          title: selectedAsset.name,
          url: selectedAsset.public_url,
          notes:
            (selectedAsset.source === "crm"
              ? "Biblioteca comercial"
              : "Biblioteca de marketing") +
            " · " +
            selectedAsset.asset_type,
          created_by: data.session.user.id,
        });
        if (result.error) throw result.error;
      } else if (selectedAsset.storage_path) {
        if (
          files.some(
            (item) => item.storage_path === selectedAsset.storage_path,
          )
        ) {
          throw new Error("Este material já está vinculado à comunicação.");
        }
        const result = await supabase.from("document_attachments").insert({
          organization_id: data.organization.id,
          entity_type: entityType,
          entity_id: entityId,
          document_type: "material_marketing",
          file_name: selectedAsset.name,
          storage_path: selectedAsset.storage_path,
          mime_type: null,
          size_bytes: null,
          notes:
            (selectedAsset.source === "crm"
              ? "Biblioteca comercial"
              : "Biblioteca de marketing") +
            " · " +
            selectedAsset.asset_type,
          uploaded_by: data.session.user.id,
        });
        if (result.error) throw result.error;
      } else {
        throw new Error("O material selecionado não possui arquivo ou link.");
      }
      setSelectedAssetId("");
      setMessage("Material da biblioteca vinculado à comunicação.");
      await load();
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível vincular o material.",
      );
    } finally {
      setBusy("");
    }
  }

  async function openFile(item: DocumentAttachment) {
    resetMessages();
    const supabase = getSupabase();
    if (!supabase) return;
    const result = await supabase.storage
      .from("erp-documents")
      .createSignedUrl(item.storage_path, 600);
    if (result.data?.signedUrl) {
      window.open(result.data.signedUrl, "_blank", "noopener,noreferrer");
    } else {
      setError(result.error?.message || "Não foi possível abrir o arquivo.");
    }
  }

  async function prepareShareText() {
    if (!itemCount) throw new Error("Inclua ao menos um material antes de encaminhar.");
    const supabase = getSupabase();
    if (!supabase) throw new Error("Supabase indisponível.");
    const signedFiles = await Promise.all(
      files.map(async (file) => {
        const result = await supabase.storage
          .from("erp-documents")
          .createSignedUrl(file.storage_path, 7 * 24 * 60 * 60);
        if (result.error || !result.data?.signedUrl) {
          throw new Error("Não foi possível preparar " + file.file_name + ".");
        }
        return { title: file.file_name, url: result.data.signedUrl };
      }),
    );
    const resources = [
      ...signedFiles,
      ...links.map((link) => ({ title: link.title, url: link.url })),
    ];
    const greeting = shareTarget?.name
      ? "Olá, " + shareTarget.name + "."
      : "Olá.";
    const introduction =
      shareTarget?.message ||
      "Conforme nosso atendimento, seguem os materiais selecionados:";
    return [
      greeting,
      introduction,
      "",
      ...resources.map((resource) => "• " + resource.title + ": " + resource.url),
      "",
      "Links de arquivos privados ficam disponíveis por 7 dias.",
    ].join("\n");
  }

  async function registerPreparedDispatch(channel: string) {
    if (entityType !== "crm_action") return;
    const supabase = getSupabase();
    if (!supabase) return;
    const current = await supabase
      .from("crm_actions")
      .select("metadata")
      .eq("organization_id", data.organization.id)
      .eq("id", entityId)
      .maybeSingle();
    if (current.error) throw new Error(current.error.message);
    const metadata =
      current.data?.metadata &&
      typeof current.data.metadata === "object" &&
      !Array.isArray(current.data.metadata)
        ? current.data.metadata
        : {};
    const update = await supabase
      .from("crm_actions")
      .update({
        metadata: {
          ...metadata,
          no_external_delivery: false,
          no_automatic_external_delivery: true,
          delivery_status: "prepared",
          external_delivery_handoff: true,
          delivery_confirmation_required: true,
          materials_prepared_at: new Date().toISOString(),
          materials_prepared_channel: channel,
          materials_count: itemCount,
        },
      })
      .eq("organization_id", data.organization.id)
      .eq("id", entityId);
    if (update.error) throw new Error(update.error.message);
  }

  async function share(channel: CommunicationShareChannel) {
    resetMessages();
    setBusy("share-" + channel);
    const popup =
      channel === "whatsapp"
        ? window.open("about:blank", "_blank")
        : null;
    try {
      const text = await prepareShareText();
      if (channel === "whatsapp") {
        const phone = normalizeWhatsApp(shareTarget?.phone || "");
        if (!phone) throw new Error("O lead não possui WhatsApp cadastrado.");
        await registerPreparedDispatch(channel);
        await onPrepared?.(channel);
        const whatsappUrl =
          "https://wa.me/" + phone + "?text=" + encodeURIComponent(text);
        if (popup) {
          popup.opener = null;
          popup.location.href = whatsappUrl;
        } else {
          window.location.href = whatsappUrl;
        }
        setMessage(
          "Mensagem preparada no WhatsApp. Confirme o envio no aplicativo.",
        );
      } else if (channel === "email") {
        const email = shareTarget?.email?.trim();
        if (!email) throw new Error("O lead não possui e-mail cadastrado.");
        const subject =
          shareTarget?.subject || "Materiais do atendimento Évora";
        await registerPreparedDispatch(channel);
        await onPrepared?.(channel);
        window.location.href =
          "mailto:" +
          encodeURIComponent(email) +
          "?subject=" +
          encodeURIComponent(subject) +
          "&body=" +
          encodeURIComponent(text);
        setMessage(
          "E-mail preparado. Revise o conteúdo antes de confirmar o envio.",
        );
      } else {
        await navigator.clipboard.writeText(text);
        await registerPreparedDispatch(channel);
        await onPrepared?.(channel);
        setMessage("Texto e links copiados para a área de transferência.");
      }
    } catch (caught) {
      popup?.close();
      setError(
        caught instanceof Error
          ? caught.message
          : "Não foi possível preparar o encaminhamento.",
      );
    } finally {
      setBusy("");
    }
  }

  return (
    <section className="communication-resources">
      <header>
        <div>
          <small>MATERIAIS DA COMUNICAÇÃO</small>
          <h4>Arquivos, vídeos, links e apresentações</h4>
          <p>
            Anexe um item novo ou reutilize um material aprovado da biblioteca.
          </p>
        </div>
        <span>{itemCount} item(ns)</span>
      </header>

      {library.length > 0 && (
        <div className="communication-library-picker">
          <div>
            <small>BIBLIOTECA APROVADA</small>
            <strong>Reutilizar material de marketing</strong>
          </div>
          <select
            value={selectedAssetId}
            onChange={(event) => setSelectedAssetId(event.target.value)}
          >
            <option value="">Selecione um material</option>
            {library.map((asset) => (
              <option key={asset.id} value={asset.id}>
                {asset.name} · {asset.asset_type}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={busy === "library" || !selectedAssetId}
            onClick={attachLibraryAsset}
          >
            {busy === "library" ? "Vinculando..." : "Vincular"}
          </button>
        </div>
      )}

      <div className="communication-resource-forms">
        <form onSubmit={upload}>
          <label>
            Arquivo, imagem ou vídeo
            <input
              name="file"
              type="file"
              accept="image/*,video/*,.pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.csv,.zip"
              required
            />
          </label>
          <label>
            Observação
            <input name="notes" placeholder="Ex.: apresentação institucional" />
          </label>
          <button className="primary" disabled={busy === "upload"}>
            {busy === "upload" ? "Enviando..." : "Anexar arquivo"}
          </button>
        </form>
        <form onSubmit={addLink}>
          <label>
            Título
            <input name="title" required />
          </label>
          <label>
            Link
            <input name="url" type="url" placeholder="https://" required />
          </label>
          <label>
            Observação
            <input name="notes" />
          </label>
          <button className="primary" disabled={busy === "link"}>
            {busy === "link" ? "Adicionando..." : "Adicionar link"}
          </button>
        </form>
      </div>

      {(error || message) && (
        <button
          type="button"
          className={"feedback " + (error ? "error" : "")}
          onClick={resetMessages}
        >
          {error || message}
        </button>
      )}

      <div className="communication-resource-list">
        {files.map((file) => (
          <button
            key={file.id}
            type="button"
            onClick={() => openFile(file)}
          >
            <b>{file.mime_type?.startsWith("video/") ? "▶" : "▧"}</b>
            <span>
              {file.file_name}
              <small>{file.notes || "Arquivo anexado"}</small>
            </span>
          </button>
        ))}
        {links.map((link) => (
          <a
            key={link.id}
            href={link.url}
            target="_blank"
            rel="noreferrer"
          >
            <b>↗</b>
            <span>
              {link.title}
              <small>{link.notes || link.url}</small>
            </span>
          </a>
        ))}
        {!itemCount && (
          <p className="communication-resource-empty">
            Nenhum material vinculado a esta comunicação.
          </p>
        )}
      </div>

      {shareTarget && itemCount > 0 && (
        <section className="communication-share">
          <div>
            <small>ENCAMINHAMENTO AO LEAD</small>
            <strong>Preparar envio para {shareTarget.name}</strong>
            <p>
              A plataforma prepara os materiais e abre o canal escolhido. O
              profissional revisa e confirma o envio.
            </p>
          </div>
          <div>
            {shareTarget.phone && (
              <button
                type="button"
                disabled={busy.startsWith("share-")}
                onClick={() => share("whatsapp")}
              >
                WhatsApp
              </button>
            )}
            {shareTarget.email && (
              <button
                type="button"
                disabled={busy.startsWith("share-")}
                onClick={() => share("email")}
              >
                E-mail
              </button>
            )}
            <button
              type="button"
              disabled={busy.startsWith("share-")}
              onClick={() => share("copy")}
            >
              Copiar links
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
