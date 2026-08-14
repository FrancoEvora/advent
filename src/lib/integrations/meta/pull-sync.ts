import { createHash, createHmac } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { enqueueMetaLeadDelivery } from "./supabase-gateway";
import { getMetaGraphConfig, getSupabaseIntegrationConfig } from "./server-config";
import type { MetaLeadNotification } from "./webhook-core";

type Obj = Record<string, unknown>;
type PollRoute = {
  id: string;
  organization_id: string;
  page_id: string;
  form_id: string;
  metadata: Obj;
};

const META_ID = /^\d{1,64}$/;
const MAX_ROUTES_PER_RUN = 20;
const MAX_PAGES_PER_FORM = 5;
const LOOKBACK_MS = 36 * 60 * 60 * 1000;

let serviceClient: SupabaseClient | null = null;

function database() {
  if (serviceClient) return serviceClient;
  const config = getSupabaseIntegrationConfig();
  serviceClient = createClient(config.url, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { "X-Client-Info": "evora-meta-poll/1.0" } },
  });
  return serviceClient;
}

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function id(value: unknown): string | null {
  const raw = typeof value === "string" || typeof value === "number" ? String(value) : "";
  return META_ID.test(raw) ? raw : null;
}

function timestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ingressMode(metadata: Obj) {
  return typeof metadata.ingress_mode === "string" ? metadata.ingress_mode.toLowerCase() : "";
}

async function graphPage(url: URL, accessToken: string, appSecret: string | null, timeout: number) {
  url.searchParams.delete("access_token");
  if (appSecret) {
    url.searchParams.set(
      "appsecret_proof",
      createHmac("sha256", appSecret).update(accessToken).digest("hex"),
    );
  } else {
    url.searchParams.delete("appsecret_proof");
  }
  const response = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${accessToken}` },
    cache: "no-store",
    signal: AbortSignal.timeout(timeout),
  });
  const body = await response.json().catch(() => null) as unknown;
  if (!response.ok || !isObj(body) || isObj(body.error)) {
    throw new Error("META_POLL_GRAPH_FAILED");
  }
  return body;
}

async function recentLeads(route: PollRoute) {
  const config = await getMetaGraphConfig(route.organization_id, route.page_id);
  const cutoff = Date.now() - LOOKBACK_MS;
  const leads: Obj[] = [];
  let next: URL | null = new URL(
    `https://graph.facebook.com/${config.apiVersion}/${route.form_id}/leads`,
  );
  next.searchParams.set("fields", "id,created_time,ad_id,form_id");
  next.searchParams.set("limit", "100");

  for (let page = 0; next && page < MAX_PAGES_PER_FORM; page += 1) {
    const body = await graphPage(next, config.accessToken, config.appSecret, config.requestTimeoutMs);
    if (!Array.isArray(body.data)) throw new Error("META_POLL_GRAPH_INVALID");
    let oldest = Number.POSITIVE_INFINITY;
    for (const candidate of body.data) {
      if (!isObj(candidate)) continue;
      const createdAt = timestamp(candidate.created_time);
      if (createdAt !== null) oldest = Math.min(oldest, createdAt);
      if (createdAt === null || createdAt >= cutoff) leads.push(candidate);
    }
    const paging = isObj(body.paging) ? body.paging : null;
    const nextUrl = paging && typeof paging.next === "string" ? paging.next : null;
    next = nextUrl ? new URL(nextUrl) : null;
    if (oldest < cutoff) break;
  }
  return leads;
}

async function routesForPolling(): Promise<PollRoute[]> {
  const result = await database()
    .from("crm_meta_lead_routes")
    .select("id,organization_id,page_id,form_id,metadata")
    .eq("active", true)
    .limit(MAX_ROUTES_PER_RUN);
  if (result.error) throw result.error;
  return (result.data || []).flatMap((row): PollRoute[] => {
    const pageId = id(row.page_id);
    const formId = id(row.form_id);
    const metadata = isObj(row.metadata) ? row.metadata : {};
    const mode = ingressMode(metadata);
    if (!pageId || !formId || !["polling", "hybrid"].includes(mode)) return [];
    return [{
      id: String(row.id),
      organization_id: String(row.organization_id),
      page_id: pageId,
      form_id: formId,
      metadata,
    }];
  });
}

async function enqueueRoute(route: PollRoute, leads: Obj[]) {
  const notifications: MetaLeadNotification[] = leads.flatMap((lead, index) => {
    const leadId = id(lead.id);
    if (!leadId) return [];
    const createdAt = timestamp(lead.created_time);
    const createdTime = createdAt === null ? null : Math.floor(createdAt / 1000);
    const formId = id(lead.form_id) || route.form_id;
    return [{
      eventKey: `meta:leadgen:${leadId}`,
      leadgenId: leadId,
      pageId: route.page_id,
      formId,
      adId: id(lead.ad_id),
      createdTime,
      entryIndex: 0,
      changeIndex: index,
      value: {
        leadgen_id: leadId,
        page_id: route.page_id,
        form_id: formId,
        ad_id: id(lead.ad_id),
        created_time: createdTime,
      },
    }];
  });

  let inserted = 0;
  let duplicates = 0;
  let unmapped = 0;
  for (let index = 0; index < notifications.length; index += 500) {
    const batch = notifications.slice(index, index + 500);
    if (!batch.length) continue;
    const receivedAt = new Date().toISOString();
    const rawBody = {
      source: "enterprise_campaign_control_poll",
      page_id: route.page_id,
      form_id: route.form_id,
      lead_ids: batch.map((item) => item.leadgenId),
    };
    const rawText = JSON.stringify(rawBody);
    const result = await enqueueMetaLeadDelivery({
      notifications: batch,
      rawBodySha256: createHash("sha256").update(rawText).digest("hex"),
      rawBody,
      correlationId: `POLL-${crypto.randomUUID()}`,
      receivedAt,
      requestHeaders: {
        "content-type": "application/json",
        "user-agent": "evora-enterprise-campaign-control-poll",
        "x-hub-signature-256": "internal-graph-verified",
      },
    });
    inserted += result.insertedEvents;
    duplicates += result.duplicateEvents;
    unmapped += result.unmappedEvents;
  }
  return { inserted, duplicates, unmapped };
}

export async function pullMetaLeadRoutes() {
  const routes = await routesForPolling();
  let fetched = 0;
  let inserted = 0;
  let duplicates = 0;
  let unmapped = 0;
  const errors: Array<{ routeId: string; code: string }> = [];

  for (const route of routes) {
    try {
      const leads = await recentLeads(route);
      fetched += leads.length;
      const queued = await enqueueRoute(route, leads);
      inserted += queued.inserted;
      duplicates += queued.duplicates;
      unmapped += queued.unmapped;
      await database().from("crm_meta_lead_routes").update({
        metadata: {
          ...route.metadata,
          ingress_mode: ingressMode(route.metadata) || "polling",
          campaign_control_connector: true,
          last_poll_at: new Date().toISOString(),
        },
        updated_at: new Date().toISOString(),
      }).eq("id", route.id).eq("organization_id", route.organization_id);
    } catch (error) {
      errors.push({
        routeId: route.id,
        code: error instanceof Error ? error.message.slice(0, 128) : "META_POLL_FAILED",
      });
    }
  }

  return { routes: routes.length, fetched, inserted, duplicates, unmapped, errors };
}
