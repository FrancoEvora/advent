import { type NextRequest, NextResponse } from "next/server";

import { secureTextEqual, verifyMetaWebhookSignature } from "@/lib/integrations/meta/webhook-core";
import {
  getWhatsAppCredentialsByOrganization,
  getWhatsAppCredentialsByPhoneNumberId,
  serviceDatabase,
} from "@/lib/integrations/whatsapp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

const MAX_BYTES = 1024 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const META_ID = /^\d{1,64}$/;

type Obj = Record<string, unknown>;
const object = (value: unknown): value is Obj => value !== null && typeof value === "object" && !Array.isArray(value);

async function rawBody(request: NextRequest) {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BYTES)) throw new Error("PAYLOAD_TOO_LARGE");
  const buffer = new Uint8Array(await request.arrayBuffer());
  if (buffer.byteLength > MAX_BYTES) throw new Error("PAYLOAD_TOO_LARGE");
  return buffer;
}

function parsePayload(raw: Uint8Array): Obj {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(raw)); } catch { throw new Error("INVALID_JSON"); }
  if (!object(value) || value.object !== "whatsapp_business_account" || !Array.isArray(value.entry)) throw new Error("INVALID_WHATSAPP_PAYLOAD");
  return value;
}

function changes(payload: Obj) {
  const out: Obj[] = [];
  for (const entry of Array.isArray(payload.entry) ? payload.entry.slice(0, 100) : []) {
    if (!object(entry)) continue;
    for (const change of Array.isArray(entry.changes) ? entry.changes.slice(0, 100) : []) {
      if (object(change) && change.field === "messages" && object(change.value)) out.push(change.value);
    }
  }
  return out;
}

function phoneNumberIds(payload: Obj) {
  const ids = new Set<string>();
  for (const value of changes(payload)) {
    const metadata = object(value.metadata) ? value.metadata : null;
    const id = metadata && typeof metadata.phone_number_id === "string" ? metadata.phone_number_id : "";
    if (META_ID.test(id)) ids.add(id);
  }
  return [...ids];
}

function unixDate(value: unknown) {
  const raw = typeof value === "string" ? Number(value) : value;
  return typeof raw === "number" && Number.isSafeInteger(raw) && raw > 0 ? new Date(raw * 1000).toISOString() : new Date().toISOString();
}

export async function GET(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get("hub.mode");
  const token = request.nextUrl.searchParams.get("hub.verify_token") || "";
  const challenge = request.nextUrl.searchParams.get("hub.challenge") || "";
  const organizationId = request.nextUrl.searchParams.get("organizationId") || "";
  if (mode !== "subscribe" || !UUID.test(organizationId) || challenge.length > 2048) return new NextResponse("Forbidden", { status: 403 });
  try {
    const runtime = await getWhatsAppCredentialsByOrganization(organizationId);
    if (!runtime || !secureTextEqual(token, runtime.verifyToken)) return new NextResponse("Forbidden", { status: 403 });
    return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" } });
  } catch {
    return new NextResponse("Unavailable", { status: 503 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const raw = await rawBody(request);
    const payload = parsePayload(raw);
    const ids = phoneNumberIds(payload);
    if (ids.length !== 1) return NextResponse.json({ ok: false, error: "WHATSAPP_PHONE_CONTEXT_INVALID" }, { status: 400 });
    const runtime = await getWhatsAppCredentialsByPhoneNumberId(ids[0]);
    if (!runtime) return NextResponse.json({ ok: false, error: "WHATSAPP_RUNTIME_NOT_FOUND" }, { status: 404 });
    if (!verifyMetaWebhookSignature(raw, request.headers.get("x-hub-signature-256"), runtime.appSecret)) {
      return NextResponse.json({ ok: false, error: "WHATSAPP_SIGNATURE_INVALID" }, { status: 401 });
    }

    let inbound = 0;
    let statuses = 0;
    for (const value of changes(payload)) {
      const metadata = object(value.metadata) ? value.metadata : {};
      const phoneNumberId = typeof metadata.phone_number_id === "string" ? metadata.phone_number_id : "";
      const contacts = Array.isArray(value.contacts) ? value.contacts : [];
      const profileName = object(contacts[0]) && object(contacts[0].profile) && typeof contacts[0].profile.name === "string" ? contacts[0].profile.name : null;

      for (const message of Array.isArray(value.messages) ? value.messages.slice(0, 100) : []) {
        if (!object(message) || message.type !== "text" || !object(message.text) || typeof message.text.body !== "string") continue;
        if (typeof message.id !== "string" || typeof message.from !== "string") continue;
        const { error } = await serviceDatabase().rpc("ingest_whatsapp_inbound_message", {
          p_organization_id: runtime.organizationId,
          p_provider_message_id: message.id,
          p_from_phone: message.from,
          p_profile_name: profileName,
          p_content: message.text.body,
          p_occurred_at: unixDate(message.timestamp),
          p_phone_number_id: phoneNumberId,
          p_message_type: "text",
        });
        if (error) throw error;
        inbound += 1;
      }

      for (const status of Array.isArray(value.statuses) ? value.statuses.slice(0, 200) : []) {
        if (!object(status) || typeof status.id !== "string" || typeof status.status !== "string") continue;
        const errors = Array.isArray(status.errors) ? status.errors : [];
        const firstError = object(errors[0]) ? errors[0] : null;
        const errorCode = firstError && (typeof firstError.code === "string" || typeof firstError.code === "number") ? String(firstError.code) : null;
        const { error } = await serviceDatabase().rpc("apply_whatsapp_message_status", {
          p_organization_id: runtime.organizationId,
          p_provider_message_id: status.id,
          p_status: status.status,
          p_occurred_at: unixDate(status.timestamp),
          p_error_code: errorCode,
        });
        if (error) throw error;
        statuses += 1;
      }
    }
    return NextResponse.json({ ok: true, inbound, statuses }, { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("WhatsApp webhook failed", { errorCode: error instanceof Error ? error.name : "UnknownError" });
    const code = error instanceof Error ? error.message : "WHATSAPP_WEBHOOK_FAILED";
    const status = code === "PAYLOAD_TOO_LARGE" ? 413 : code.startsWith("INVALID_") ? 400 : 503;
    return NextResponse.json({ ok: false, error: status === 503 ? "WHATSAPP_WEBHOOK_UNAVAILABLE" : code }, { status });
  }
}
