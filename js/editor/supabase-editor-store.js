import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_CONFIG } from '../config.js';
import { normalizeLoadedPerson } from '../person/model.js';

const { url, publishableKey, schema, tables } = SUPABASE_CONFIG;

if (!url || !publishableKey) {
  throw new Error('Supabase URL или publishable key не настроены в js/config.js.');
}

const supabase = createClient(url, publishableKey, {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
  },
});
const schemaClient = schema ? supabase.schema(schema) : supabase;

function normalizePersonPayload(personId, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error(`Некорректный payload для ${personId}.`);
  }

  return normalizeLoadedPerson(payload, personId);
}

export async function loadPeopleIndex() {
  const { data, error } = await schemaClient
    .from(tables.people)
    .select('id, display_name');

  if (error) {
    throw new Error(error.message);
  }

  return new Map(
    (data || []).map((row) => [
      String(row.id || '').trim(),
      String(row.display_name || row.id || '').trim(),
    ])
  );
}

export async function loadEditablePerson(personId) {
  const { data, error } = await schemaClient
    .from(tables.yaml)
    .select('id, payload')
    .eq('id', personId)
    .maybeSingle();

  if (error) {
    throw new Error(error.message);
  }

  if (!data) return null;
  return normalizePersonPayload(data.id, data.payload);
}

export async function saveEditablePerson(personId, payload) {
  const normalized = normalizePersonPayload(personId, payload);
  const { error } = await schemaClient
    .from(tables.yaml)
    .upsert({
      id: personId,
      payload: normalized,
    }, {
      onConflict: 'id',
    });

  if (error) {
    throw new Error(error.message);
  }
}

export async function createEditablePerson(personId, payload) {
  const normalized = normalizePersonPayload(personId, payload);
  const { error } = await schemaClient
    .from(tables.yaml)
    .insert({
      id: personId,
      payload: normalized,
    });

  if (error) {
    throw new Error(error.message);
  }
}
