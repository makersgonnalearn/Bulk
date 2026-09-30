import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type PublicSupabaseConfig = {
  supabaseUrl: string;
  supabaseAnonKey: string;
};

let cached:
  | {
      url: string;
      key: string;
      client: SupabaseClient;
    }
  | undefined;

export function getPublicSupabaseConfig(): PublicSupabaseConfig | null {
  const supabaseUrl = process.env.SUPABASE_URL?.trim();
  const supabaseAnonKey =
    process.env.SUPABASE_ANON_KEY?.trim() ||
    process.env.SUPABASE_PUBLISHABLE_KEY?.trim();

  if (!supabaseUrl || !supabaseAnonKey) return null;

  try {
    const parsedUrl = new URL(supabaseUrl);
    const isLocalHttp =
      parsedUrl.protocol === "http:" &&
      (parsedUrl.hostname === "localhost" || parsedUrl.hostname === "127.0.0.1");
    if (
      (parsedUrl.protocol !== "https:" && !isLocalHttp) ||
      parsedUrl.username ||
      parsedUrl.password ||
      parsedUrl.search ||
      parsedUrl.hash
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return { supabaseUrl, supabaseAnonKey };
}

export function getSupabaseClient(): SupabaseClient | null {
  const config = getPublicSupabaseConfig();
  if (!config) return null;

  if (
    cached?.url === config.supabaseUrl &&
    cached.key === config.supabaseAnonKey
  ) {
    return cached.client;
  }

  const client = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
  });

  cached = {
    url: config.supabaseUrl,
    key: config.supabaseAnonKey,
    client,
  };
  return client;
}