import { CONFIG, SUPABASE_CONFIG } from '../config.js';
import { getSchemaClient } from '../auth.js';
import { buildFamilyGroups } from '../visualization/table-family-groups.js';
import { getPersonDisplayName } from './person-name.js';
import { buildPeopleTableData } from '../visualization/table-view.js';
import { normalizeLoadedPerson } from '../person/model.js';
import { parseYaml } from '../lib/yaml.js';

const DATA_SOURCE_VALUES = new Set(['auto', 'local', 'supabase']);

async function fetchText(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Не удалось загрузить ${path}: ${response.status}`);
  }
  return response.text();
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Не удалось загрузить ${path}: ${response.status}`);
  }
  return response.json();
}

async function loadPersonYaml(id) {
  const path = `${CONFIG.peopleDir}/${id}${CONFIG.personFileExtension}`;
  const response = await fetch(path);
  if (!response.ok) {
    return null;
  }

  const text = await response.text();
  const data = await parseYaml(text);
  return { id, data, path };
}

function normalizeDataSource(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return DATA_SOURCE_VALUES.has(normalized) ? normalized : 'auto';
}

function getRequestedDataSource() {
  const configured = normalizeDataSource(CONFIG.dataSource);
  const params = new URLSearchParams(globalThis.location?.search || '');
  const override = normalizeDataSource(params.get('dataSource') || params.get('source'));
  return override === 'auto' && !params.has('dataSource') && !params.has('source')
    ? configured
    : override;
}

function hasSupabaseConfig() {
  return Boolean(SUPABASE_CONFIG?.url && SUPABASE_CONFIG?.publishableKey && SUPABASE_CONFIG?.tables?.yaml);
}

async function getSupabaseDataClient() {
  if (!hasSupabaseConfig()) {
    throw new Error('Supabase не настроен в js/config.js.');
  }
  return getSchemaClient();
}

async function fetchSupabaseRows() {
  const client = await getSupabaseDataClient();
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

function extractPersonIdFromHref(href) {
  const cleanHref = decodeURIComponent(String(href || '').split('#')[0].split('?')[0]);
  const fileName = cleanHref.split('/').pop();
  if (!fileName || !fileName.endsWith(CONFIG.personFileExtension)) {
    return null;
  }

  const id = fileName.slice(0, -CONFIG.personFileExtension.length).trim();
  return /^P\d+$/i.test(id) ? id : null;
}

function normalizePersonIds(ids) {
  return [...new Set(
    ids
      .map((id) => String(id || '').trim())
      .filter((id) => /^P\d+$/i.test(id))
  )].sort();
}

async function listPersonIdsFromManifest() {
  const manifest = await fetchJson(CONFIG.peopleManifestPath);
  const ids = Array.isArray(manifest)
    ? manifest
    : Array.isArray(manifest?.people)
      ? manifest.people
      : [];

  const uniqueIds = normalizePersonIds(ids);
  if (!uniqueIds.length) {
    throw new Error(`Манифест пуст: ${CONFIG.peopleManifestPath}`);
  }

  return uniqueIds;
}

async function listPersonIdsFromDirectory() {
  const directoryHtml = await fetchText(`${CONFIG.peopleDir}/`);
  const document = new DOMParser().parseFromString(directoryHtml, 'text/html');
  const ids = Array.from(document.querySelectorAll('a[href]'))
    .map((link) => extractPersonIdFromHref(link.getAttribute('href')))
    .filter(Boolean);

  const uniqueIds = normalizePersonIds(ids);
  if (!uniqueIds.length) {
    throw new Error(`Не удалось получить список YAML-карточек из ${CONFIG.peopleDir}/`);
  }

  return uniqueIds;
}

async function listPersonIds() {
  try {
    return await listPersonIdsFromManifest();
  } catch (error) {
    console.warn('Манифест недоступен, пробую прочитать список файлов из директории.', error);
  }

  return listPersonIdsFromDirectory();
}

function buildDatasetFromPeople(people, sourceInfo) {
  const indexById = new Map();
  const availableIds = new Set(people.keys());

  for (const [id, person] of people.entries()) {
    indexById.set(id, getPersonDisplayName(person, id));
  }

  const dataset = {
    indexById,
    people,
    availableIds,
    source: sourceInfo,
  };
  dataset.peopleTable = buildPeopleTableData(dataset, {
    anchorId: people.has('P049') ? 'P049' : Array.from(people.keys()).sort()[0],
  });
  dataset.familyGroups = buildFamilyGroups(dataset, dataset.peopleTable);

  return dataset;
}

async function loadLocalPeople() {
  const ids = await listPersonIds();
  const people = new Map();
  const results = await Promise.all(ids.map((id) => loadPersonYaml(id)));

  for (const result of results) {
    if (!result?.data) continue;
    people.set(result.id, normalizeLoadedPerson(result.data, result.id));
  }

  if (!people.size) {
    throw new Error('Не найдено ни одной локальной YAML-карточки.');
  }

  return buildDatasetFromPeople(people, { type: 'local' });
}

async function loadSupabasePeople() {
  const rows = await fetchSupabaseRows();
  const people = new Map();

  for (const row of rows) {
    const id = String(row?.id || '').trim();
    if (!id || !row?.payload || typeof row.payload !== 'object' || Array.isArray(row.payload)) {
      continue;
    }
    people.set(id, normalizeLoadedPerson(row.payload, id));
  }

  if (!people.size) {
    throw new Error('В Supabase нет корректных карточек.');
  }

  return buildDatasetFromPeople(people, { type: 'supabase' });
}

export async function loadDataset() {
  const source = getRequestedDataSource();

  if (source === 'local') {
    return loadLocalPeople();
  }

  try {
    return await loadSupabasePeople();
  } catch (error) {
    if (source === 'supabase') {
      throw error;
    }

    console.warn('Supabase недоступен, загружаю локальные YAML.', error);
    const dataset = await loadLocalPeople();
    dataset.source = {
      type: 'local',
      fallbackFrom: 'supabase',
      fallbackReason: error?.message || String(error),
    };
    return dataset;
  }
}
