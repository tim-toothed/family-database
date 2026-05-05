import { YANDEX_DB_CONFIG, YANDEX_DOC_IMPORT_CONFIG } from '../../config.js';
import {
  buildFunctionRouteUrl,
  getConfiguredApiToken,
  getConfiguredApiUrl,
} from './http-utils.js';

function getImportApiUrl() {
  return getConfiguredApiUrl(YANDEX_DOC_IMPORT_CONFIG, 'Yandex document import API URL не настроен в js/config.js.');
}

function getApiToken() {
  return getConfiguredApiToken([YANDEX_DOC_IMPORT_CONFIG, YANDEX_DB_CONFIG]);
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }

  return btoa(binary);
}

async function fetchYandexDocImportApi(path, body) {
  const url = buildFunctionRouteUrl(getImportApiUrl(), path, 'https://family-doc-import.local');

  const headers = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
  const token = getApiToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url.toString(), {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `Yandex document import API вернул ${response.status}.`);
  }

  return payload;
}

export async function importYandexDocumentFile(file) {
  const contentBase64 = arrayBufferToBase64(await file.arrayBuffer());
  const payload = await fetchYandexDocImportApi('/documents/import', {
    filename: file.name,
    title: file.name.replace(/\.[^.]+$/, ''),
    contentBase64,
  });
  return payload?.document || null;
}
