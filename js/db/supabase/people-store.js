import { SUPABASE_CONFIG } from '../../config.js';
import { ensureSupabaseConfig, getSchemaClient } from './client.js';

function ensurePeopleConfig() {
  ensureSupabaseConfig('Supabase не настроен в js/config.js.');
  if (!SUPABASE_CONFIG?.tables?.yaml) {
    throw new Error('Таблица YAML не настроена в js/config.js.');
  }
}

export async function fetchSupabasePeopleRows() {
  ensurePeopleConfig();

  const client = await getSchemaClient();
  const { data, error } = await client
    .from(SUPABASE_CONFIG.tables.yaml)
    .select('id, payload')
    .order('id', { ascending: true })
    .limit(5000);

  if (error) {
    throw new Error(error.message);
  }

  if (!Array.isArray(data) || !data.length) {
    throw new Error('В Supabase не найдено ни одной карточки.');
  }

  return data;
}
