import { CONFIG } from './config.js';

function parseIndexYaml(text) {
  const raw = jsyaml.load(text);
  const byId = new Map();

  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (/^P\d+/i.test(key)) {
        byId.set(key.trim(), String(value).trim());
      }
    }
  }

  return byId;
}

async function fetchText(path) {
  const response = await fetch(path);
  if (!response.ok) {
    throw new Error(`Не удалось загрузить ${path}: ${response.status}`);
  }
  return response.text();
}

async function loadPersonYaml(id) {
  const path = `${CONFIG.peopleDir}/${id}${CONFIG.personFileExtension}`;
  const response = await fetch(path);
  if (!response.ok) {
    return null;
  }

  const text = await response.text();
  const data = jsyaml.load(text);
  return { id, data, path };
}

export async function loadDataset() {
  const indexText = await fetchText(CONFIG.peopleIndexPath);
  const indexById = parseIndexYaml(indexText);

  const ids = Array.from(indexById.keys()).sort();
  const people = new Map();
  const availableIds = new Set();

  const results = await Promise.all(ids.map((id) => loadPersonYaml(id)));
  for (const result of results) {
    if (result?.data) {
      people.set(result.id, result.data);
      availableIds.add(result.id);
    }
  }

  return { indexById, people, availableIds };
}
