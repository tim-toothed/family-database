import { SUPABASE_CONFIG } from '../../config.js';

const SUPABASE_ESM_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

let supabaseClientPromise = null;

function hasSupabaseConfig() {
  return Boolean(SUPABASE_CONFIG?.url && SUPABASE_CONFIG?.publishableKey);
}

export function ensureSupabaseConfig(message = 'Supabase не настроен в js/config.js.') {
  if (!hasSupabaseConfig()) {
    throw new Error(message);
  }
}

export async function getSupabaseClient() {
  ensureSupabaseConfig();

  if (!supabaseClientPromise) {
    supabaseClientPromise = (async () => {
      const { createClient } = await import(SUPABASE_ESM_URL);
      return createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.publishableKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
          storageKey: 'family-database-auth',
        },
      });
    })();
  }

  return supabaseClientPromise;
}

export async function getSchemaClient() {
  const supabase = await getSupabaseClient();
  return SUPABASE_CONFIG.schema ? supabase.schema(SUPABASE_CONFIG.schema) : supabase;
}

export async function getSupabaseAuthSession() {
  const supabase = await getSupabaseClient();
  return supabase.auth.getSession();
}

export async function signInWithSupabasePassword({ email, password }) {
  const supabase = await getSupabaseClient();
  return supabase.auth.signInWithPassword({ email, password });
}

export async function signOutFromSupabase() {
  const supabase = await getSupabaseClient();
  return supabase.auth.signOut();
}
