import { createClient } from "npm:@supabase/supabase-js@2.110.7";
import { processBiaCampaignOutreach } from "../_shared/bia-campaign-outreach.ts";

const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { "cache-control": "no-store" } });
function serviceKey() {
  try { const keys = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}"); if (typeof keys.default === "string") return keys.default; } catch { /* Legacy key below. */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}
async function equal(a: string, b: string) {
  const digest = async (v: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  return x.reduce((n, v, i) => n | (v ^ y[i]), 0) === 0;
}
Deno.serve(async request => {
  if (request.method !== "POST") return json({ ok: false }, 405);
  const supplied = request.headers.get("x-arisa-worker-secret") || "";
  if (!supplied || supplied.length > 512) return json({ ok: false }, 401);
  const admin = createClient(Deno.env.get("SUPABASE_URL") || "", serviceKey(), { auth: { persistSession: false, autoRefreshToken: false } });
  const expected = await admin.rpc("arisa_background_secret");
  if (expected.error || typeof expected.data !== "string" || !expected.data || !await equal(supplied, expected.data)) return json({ ok: false }, 401);
  const rpc = async (name: string, args: Record<string, unknown>) => {
    const result = await admin.rpc(name, args);
    if (result.error) throw new Error(/^BIA_[A-Z_]+$/.test(result.error.message) ? result.error.message : "BIA_CAMPAIGN_UNAVAILABLE");
    return result.data;
  };
  try { return json({ ok: true, ...await processBiaCampaignOutreach(rpc) }); }
  catch { return json({ ok: false, error: "BIA_CAMPAIGN_UNAVAILABLE" }, 503); }
});

