"use client";

import { type FormEvent, useCallback, useEffect, useState } from "react";

import { getSupabase } from "@/lib/supabase";

import type { ErpData } from "../types";

type Item = {
  id: string;
  content_type: string;
  title: string;
  subtitle: string | null;
  body: string | null;
  media_url: string | null;
  cta_label: string | null;
  cta_url: string | null;
  featured: boolean;
  active: boolean;
  project_id: string | null;
  created_at: string;
};

export function PortalContentManager({ data }: { data: ErpData }) {
  const [items, setItems] = useState<Item[]>([]);
  const [show, setShow] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    const supabase = getSupabase();
    if (!supabase) return;

    const result = await supabase
      .from("portal_content_items")
      .select("*")
      .eq("organization_id", data.organization.id)
      .order("featured", { ascending: false })
      .order("created_at", { ascending: false });

    if (result.error) {
      setMessage(`Não foi possível carregar as publicações: ${result.error.message}`);
      return;
    }

    setItems((result.data || []) as Item[]);
  }, [data.organization.id]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timeout);
  }, [load]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const supabase = getSupabase();
    if (!supabase) return;

    setMessage("");
    const result = await supabase.from("portal_content_items").insert({
      organization_id: data.organization.id,
      project_id: form.get("project_id") || null,
      content_type: form.get("content_type"),
      title: form.get("title"),
      subtitle: form.get("subtitle") || null,
      body: form.get("body") || null,
      media_url: form.get("media_url") || null,
      cta_label: form.get("cta_label") || null,
      cta_url: form.get("cta_url") || null,
      featured: form.get("featured") === "on",
      active: true,
      created_by: data.session.user.id,
    });

    if (result.error) {
      setMessage(`Não foi possível publicar o conteúdo: ${result.error.message}`);
      return;
    }

    setShow(false);
    setMessage("Publicação criada com sucesso.");
    await load();
  }

  async function toggle(item: Item) {
    const supabase = getSupabase();
    if (!supabase) return;

    setMessage("");
    const result = await supabase
      .from("portal_content_items")
      .update({ active: !item.active, updated_at: new Date().toISOString() })
      .eq("id", item.id)
      .eq("organization_id", data.organization.id);

    if (result.error) {
      setMessage(`Não foi possível atualizar a publicação: ${result.error.message}`);
      return;
    }

    setMessage(item.active ? "Publicação desativada." : "Publicação ativada.");
    await load();
  }

  return (
    <section className="portal-editor-card">
      <header>
        <div>
          <small>CONTEÚDO COMERCIAL</small>
          <h2>Publicações do portal</h2>
          <p>Avanços de obra, notícias, vídeos, orientações e chamadas comerciais.</p>
        </div>
        <button className="primary" type="button" onClick={() => setShow(true)}>
          + Nova publicação
        </button>
      </header>

      {message && (
        <div className="notice" role="status" aria-live="polite">
          {message}
        </div>
      )}

      <div className="portal-editor-list">
        {items.map((item) => (
          <article key={item.id} className={!item.active ? "inactive" : ""}>
            <div className="portal-content-icon" aria-hidden="true">
              {item.content_type === "video"
                ? "▶"
                : item.content_type === "imagem"
                  ? "▧"
                  : "T"}
            </div>
            <div>
              <small>
                {item.content_type} · {item.featured ? "destaque" : "publicação"}
              </small>
              <strong>{item.title}</strong>
              <p>{item.subtitle || item.body || "Sem descrição"}</p>
            </div>
            <span>
              {item.project_id
                ? data.projects.find((project) => project.id === item.project_id)?.name
                : "Todos os empreendimentos"}
            </span>
            <button type="button" onClick={() => void toggle(item)}>
              {item.active ? "Desativar" : "Ativar"}
            </button>
          </article>
        ))}
        {!items.length && <p>Nenhuma publicação criada.</p>}
      </div>

      {show && (
        <div className="modal-backdrop" onMouseDown={() => setShow(false)}>
          <form
            className="modal large"
            role="dialog"
            aria-modal="true"
            aria-labelledby="portal-content-title"
            onSubmit={save}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="modal-close"
              aria-label="Fechar publicação"
              onClick={() => setShow(false)}
            >
              ×
            </button>
            <header>
              <small>NOVA PUBLICAÇÃO</small>
              <h2 id="portal-content-title">Conteúdo do portal</h2>
            </header>
            <div className="form-grid three">
              <label className="span-2">
                Título
                <input name="title" required />
              </label>
              <label>
                Tipo
                <select name="content_type">
                  <option value="texto">Texto / notícia</option>
                  <option value="video">Vídeo</option>
                  <option value="imagem">Imagem</option>
                  <option value="obra">Avanço de obra</option>
                  <option value="comunicado">Comunicado</option>
                  <option value="oferta">Oportunidade</option>
                </select>
              </label>
              <label className="span-2">
                Subtítulo
                <input name="subtitle" />
              </label>
              <label>
                Empreendimento
                <select name="project_id">
                  <option value="">Todos</option>
                  {data.projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="span-3">
                Texto
                <textarea name="body" rows={6} />
              </label>
              <label className="span-3">
                URL de imagem ou vídeo
                <input
                  name="media_url"
                  type="url"
                  placeholder="YouTube, Vimeo, imagem ou tour virtual"
                />
              </label>
              <label>
                Texto do botão
                <input name="cta_label" placeholder="Saiba mais" />
              </label>
              <label className="span-2">
                Link do botão
                <input name="cta_url" type="url" />
              </label>
              <label>
                <input name="featured" type="checkbox" /> Publicação em destaque
              </label>
            </div>
            <footer>
              <button type="button" onClick={() => setShow(false)}>
                Cancelar
              </button>
              <button className="primary">Publicar conteúdo</button>
            </footer>
          </form>
        </div>
      )}
    </section>
  );
}
