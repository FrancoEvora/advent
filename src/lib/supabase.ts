import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null | undefined;

const defaultUrl = "https://qsdffayasuzsmngteika.supabase.co";
const defaultKey = "sb_publishable_nMCXNDXMvU0EbMSSmnEfQg_0uE_lVOW";

const configuredUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || defaultUrl;
const configuredKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || defaultKey;

export const hasSupabaseConfig = Boolean(configuredUrl && configuredKey);

export function getSupabase(): SupabaseClient | null {
  if (client !== undefined) return client;

  const url = configuredUrl;
  const key = configuredKey;

  if (!url || !key) {
    client = null;
    return client;
  }

  client = createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,
    },
  });

  return client;
}
