"use client";

import { useEffect, useState } from "react";
import { getSupabase } from "@/lib/supabase";
import type { ErpData } from "../types";
import { organizationTables, bytes, dateTime } from "./backup-config";
import { checksum, checksumBytes, createTarGzip, downloadBlob, jsonBytes, textBytes, type ArchiveEntry } from "./backup-utils";

type Run = {
  id: string;
  status: string;
  file_name: string | null;
  storage_path: string | null;
  size_bytes: number | null;
  checksum: string | null;
  created_at: string;
  verified_at: string | null;
  includes_documents?: boolean;
  table_counts: Record<string, number>;
  errors: string[];
};

type StorageReference = { bucket: "erp-documents" | "profile-photos"; path: string; source: string };
type StorageManifestItem = StorageReference & { archive_path: string; size_bytes: number; checksum: string };
type Row = Record<string, unknown>;

const MAX_SOURCE_BYTES = 85 * 1024 * 1024;

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function collectStorageReferences(tables: Record<string, unknown[]>) {
  const unique = new Map<string, StorageReference>();
  const add = (bucket: StorageReference["bucket"], pathValue: unknown, source: string) => {
    const path = text(pathValue);
    if (!path || /^https?:\/\//i.test(path)) return;
    unique.set(`${bucket}:${path}`, { bucket, path, source });
  };

  for (const item of (tables.document_attachments || []) as Row[]) add("erp-documents", item.storage_path, "document_attachments");
  for (const item of (tables.crm_marketing_assets || []) as Row[]) add("erp-documents", item.storage_path, "crm_marketing_assets");
  for (const item of (tables.crm_contracts || []) as Row[]) add("erp-documents", item.document_path, "crm_contracts");
  for (const item of (tables.profiles || []) as Row[]) add("profile-photos", item.avatar_path, "profiles");
  return [...unique.values()];
}

function restoreReadme() {
  return `ÉVORA GESTÃO — BACKUP INTEGRAL\n\nEste pacote contém:\n- database.json: dados exportados por organização;\n- storage-manifest.json: inventário e checksums dos arquivos;\n- storage/: documentos, materiais e fotos originais;\n- validation-summary.json: contagens e eventuais falhas.\n\nA restauração deve ser executada em ambiente de homologação antes da produção.\nNão edite os arquivos do pacote sem recalcular os checksums.\n`;
}

export function BackupCenter({ data }: { data: ErpData }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [message, setMessage] = useState("");

  async function load() {
    const client = getSupabase();
    if (!client) return;
    const result = await client.from("backup_runs").select("*").eq("organization_id", data.organization.id).order("created_at", { ascending: false });
    if (!result.error) setRuns((result.data || []) as Run[]);
  }

  useEffect(() => { load(); }, []);

  async function createBackup() {
    setBusy(true);
    setMessage("");
    const client = getSupabase();
    if (!client) { setBusy(false); return; }

    const start = await client.from("backup_runs").insert({
      organization_id: data.organization.id,
      backup_type: "integral",
      status: "processando",
      includes_documents: true,
      created_by: data.session.user.id,
    }).select("id").single();

    if (start.error) { setMessage(start.error.message); setBusy(false); return; }

    const counts: Record<string, number> = {};
    const errors: string[] = [];
    const tables: Record<string, unknown[]> = {};

    try {
      for (let index = 0; index < organizationTables.length; index += 1) {
        const table = organizationTables[index];
        setProgress(`Exportando ${index + 1}/${organizationTables.length}: ${table}`);
        const query = table === "organizations"
          ? client.from(table).select("*").eq("id", data.organization.id)
          : client.from(table).select("*").eq("organization_id", data.organization.id);
        const result = await query;
        if (result.error) {
          errors.push(`${table}: ${result.error.message}`);
          tables[table] = [];
        } else {
          tables[table] = result.data || [];
          counts[table] = (result.data || []).length;
        }
      }

      const memberIds = data.members.map(member => member.user_id);
      if (memberIds.length) {
        const result = await client.from("profiles").select("*").in("id", memberIds);
        if (result.error) errors.push(`profiles: ${result.error.message}`);
        tables.profiles = result.data || [];
        counts.profiles = (result.data || []).length;
      }

      const purchaseIds = ((tables.purchase_requests || []) as Array<{ id: string }>).map(item => item.id);
      if (purchaseIds.length) {
        const result = await client.from("purchase_request_items").select("*").in("purchase_request_id", purchaseIds);
        if (result.error) errors.push(`purchase_request_items: ${result.error.message}`);
        tables.purchase_request_items = result.data || [];
        counts.purchase_request_items = (result.data || []).length;
      }

      const payrollIds = ((tables.hr_payroll_runs || []) as Array<{ id: string }>).map(item => item.id);
      if (payrollIds.length) {
        const result = await client.from("hr_payroll_items").select("*").in("payroll_run_id", payrollIds);
        if (result.error) errors.push(`hr_payroll_items: ${result.error.message}`);
        tables.hr_payroll_items = result.data || [];
        counts.hr_payroll_items = (result.data || []).length;
      }

      const archiveEntries: ArchiveEntry[] = [];
      const storageManifest: StorageManifestItem[] = [];
      const references = collectStorageReferences(tables);
      let storageBytes = 0;

      for (let index = 0; index < references.length; index += 1) {
        const reference = references[index];
        setProgress(`Copiando arquivo ${index + 1}/${references.length}: ${reference.path.split("/").pop()}`);
        const result = await client.storage.from(reference.bucket).download(reference.path);
        if (result.error || !result.data) {
          errors.push(`${reference.bucket}/${reference.path}: ${result.error?.message || "arquivo indisponível"}`);
          continue;
        }
        const fileBytes = new Uint8Array(await result.data.arrayBuffer());
        storageBytes += fileBytes.byteLength;
        if (storageBytes > MAX_SOURCE_BYTES) throw new Error("Os arquivos ultrapassam o limite seguro de 85 MB para backup pelo navegador. Divida os documentos ou utilize a rotina de infraestrutura.");
        const archivePath = `storage/${reference.bucket}/${reference.path}`;
        const fileChecksum = await checksumBytes(fileBytes);
        archiveEntries.push({ path: archivePath, data: fileBytes });
        storageManifest.push({ ...reference, archive_path: archivePath, size_bytes: fileBytes.byteLength, checksum: fileChecksum });
      }

      counts.__storage_files = storageManifest.length;
      counts.__storage_bytes = storageBytes;
      const generatedAt = new Date().toISOString();
      const databasePayload = {
        format: "evora-backup",
        version: "5.7",
        generated_at: generatedAt,
        organization: data.organization,
        created_by: data.session.user.id,
        includes_original_files: true,
        tables,
      };
      const summary = {
        generated_at: generatedAt,
        table_counts: counts,
        storage_files: storageManifest.length,
        storage_bytes: storageBytes,
        errors,
        verification: errors.length ? "parcial" : "integral",
      };

      archiveEntries.unshift(
        { path: "README-RESTAURACAO.txt", data: textBytes(restoreReadme()) },
        { path: "database.json", data: jsonBytes(databasePayload) },
        { path: "storage-manifest.json", data: jsonBytes(storageManifest) },
        { path: "validation-summary.json", data: jsonBytes(summary) },
      );

      setProgress("Compactando e verificando o pacote integral...");
      const archive = await createTarGzip(archiveEntries);
      const packageChecksum = await checksum(archive.blob);
      const stamp = generatedAt.replace(/[:.]/g, "-");
      const fileName = `evora-backup-integral-${stamp}.${archive.extension}`;
      const storagePath = `${data.organization.id}/${start.data.id}/${fileName}`;
      const upload = await client.storage.from("erp-backups").upload(storagePath, archive.blob, { contentType: "application/octet-stream", upsert: false });
      if (upload.error) throw upload.error;

      const status = errors.length ? "parcial" : "verificado";
      const update = await client.from("backup_runs").update({
        status,
        file_name: fileName,
        storage_path: storagePath,
        size_bytes: archive.blob.size,
        checksum: packageChecksum,
        includes_documents: true,
        table_counts: counts,
        errors,
        completed_at: new Date().toISOString(),
        verified_at: errors.length ? null : new Date().toISOString(),
      }).eq("id", start.data.id);
      if (update.error) throw update.error;

      downloadBlob(archive.blob, fileName);
      setMessage(errors.length
        ? `Backup parcial criado com ${storageManifest.length} arquivo(s). Consulte as falhas antes de limpar a base.`
        : `Backup integral verificado: ${storageManifest.length} arquivo(s) e ${bytes(storageBytes)} de documentos.`);
      await load();
    } catch (error) {
      const errorText = error instanceof Error ? error.message : "erro";
      await client.from("backup_runs").update({ status: "erro", errors: [...errors, errorText], completed_at: new Date().toISOString() }).eq("id", start.data.id);
      setMessage(errorText);
    } finally {
      setBusy(false);
      setProgress("");
    }
  }

  async function download(run: Run) {
    if (!run.storage_path) return;
    const client = getSupabase();
    if (!client) return;
    const result = await client.storage.from("erp-backups").download(run.storage_path);
    if (result.error || !result.data) { setMessage(result.error?.message || "Backup indisponível"); return; }
    downloadBlob(result.data, run.file_name || "evora-backup.tar.gz");
  }

  return <div className="backup-center">
    <section className="admin-heading"><div><small>CONTINUIDADE E PROTEÇÃO</small><h2>Backup integral e recuperação</h2><p>Gere um pacote verificável com banco, documentos, materiais de marketing, contratos e fotos de perfil antes de limpar a base.</p></div><button className="primary" onClick={createBackup} disabled={busy}>{busy ? "Gerando..." : "Criar backup integral"}</button></section>
    {progress && <div className="feedback">{progress}</div>}
    {message && <button className="notice" onClick={() => setMessage("")}>{message}</button>}
    <section className="admin-card"><header><div><small>HISTÓRICO</small><h3>Backups disponíveis</h3></div></header><div className="backup-list">{runs.map(run => <article key={run.id}><div><strong>{run.file_name || "Backup em processamento"}</strong><small>{dateTime(run.created_at)} · {run.size_bytes ? bytes(run.size_bytes) : "—"} · {run.table_counts?.__storage_files || 0} arquivo(s)</small></div><i data-status={run.status}>{run.status}</i><span>{run.checksum ? `SHA-256 ${run.checksum.slice(0, 16)}…` : "Aguardando verificação"}</span><button onClick={() => download(run)} disabled={!run.storage_path}>Baixar</button></article>)}{!runs.length && <p>Nenhum backup criado.</p>}</div></section>
    <p className="hint">A limpeza da base deve utilizar somente backups com status “verificado”. Pacotes “parciais” preservam os dados, mas possuem arquivos indisponíveis e não liberam a reinicialização segura.</p>
  </div>;
}
