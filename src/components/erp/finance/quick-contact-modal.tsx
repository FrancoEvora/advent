"use client";

import { FormEvent } from "react";
import { getSupabase } from "@/lib/supabase";
import type { EntryType, ErpData } from "../types";
import { PanelTitle } from "../views-dashboard";

export function QuickContactModal({ entryType, data, mutate, close, onCreated }: { entryType: EntryType; data: ErpData; mutate: (operation: () => Promise<void>, success: string) => Promise<void>; close: () => void; onCreated: (id: string) => void }) {
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let createdId = "";
    await mutate(async () => {
      const supabase = getSupabase(); if (!supabase) throw new Error("Supabase indisponível.");
      const payload = {
        organization_id: data.organization.id,
        contact_type: entryType === "saida" ? "fornecedor" : "cliente",
        name: String(form.get("name")).trim(),
        trade_name: String(form.get("trade_name") || "") || null,
        document: String(form.get("document") || "") || null,
        email: String(form.get("email") || "") || null,
        phone: String(form.get("phone") || "") || null,
        notes: String(form.get("notes") || "") || null,
        active: true,
      };
      const { data: created, error } = await supabase.from("contacts").insert(payload).select().single();
      if (error) throw new Error(error.message);
      createdId = created.id;
    }, entryType === "saida" ? "Fornecedor cadastrado." : "Cliente cadastrado.");
    if (createdId) { onCreated(createdId); close(); }
  }

  return <div className="nested-modal-backdrop" onMouseDown={close}><form className="modal compact" onSubmit={submit} onMouseDown={(event) => event.stopPropagation()}><PanelTitle eyebrow="CADASTRO RÁPIDO" title={entryType === "saida" ? "Novo fornecedor" : "Novo cliente"} /><button className="modal-close" type="button" onClick={close}>×</button><div className="form-grid"><label className="span-2">Nome / razão social<input name="name" required /></label><label className="span-2">Nome fantasia<input name="trade_name" /></label><label>CPF / CNPJ<input name="document" /></label><label>Telefone<input name="phone" /></label><label className="span-2">E-mail<input name="email" type="email" /></label><label className="span-2">Observações<textarea name="notes" rows={2} /></label></div><footer><button type="button" onClick={close}>Cancelar</button><button className="primary">Cadastrar e selecionar</button></footer></form></div>;
}
