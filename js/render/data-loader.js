import { CONFIG } from '../config.js';
import { buildFamilyGroups } from '../visualization/table-family-groups.js';
import { getPersonDisplayName } from './person-name.js';
import { buildPeopleTableData } from '../visualization/table-view.js';
import { normalizeLoadedPerson } from '../person/model.js';
import { parseYaml } from '../lib/yaml.js';

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

export async function loadDataset() {
  const ids = await listPersonIds();
  const indexById = new Map();
  const people = new Map();
  const availableIds = new Set();

  const results = await Promise.all(ids.map((id) => loadPersonYaml(id)));
  for (const result of results) {
    if (result?.data) {
      const person = normalizeLoadedPerson(result.data, result.id);

      people.set(result.id, person);
      availableIds.add(result.id);
      indexById.set(result.id, getPersonDisplayName(person, result.id));
    }
  }

  const dataset = { indexById, people, availableIds };
  dataset.peopleTable = buildPeopleTableData(dataset, {
    anchorId: people.has('P049') ? 'P049' : Array.from(people.keys()).sort()[0],
  });
  dataset.familyGroups = buildFamilyGroups(dataset, dataset.peopleTable);

  return dataset;
}
