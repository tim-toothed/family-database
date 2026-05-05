import { YANDEX_DB_CONFIG, YANDEX_DB_TOOLS_CONFIG } from '../../config.js';
import {
  buildFunctionRouteUrl,
  getConfiguredApiToken,
  getConfiguredApiUrl,
} from './http-utils.js';

function getToolsApiUrl() {
  return getConfiguredApiUrl(YANDEX_DB_TOOLS_CONFIG, 'Yandex DB tools API URL не настроен в js/config.js.');
}

function getApiToken() {
  return getConfiguredApiToken([YANDEX_DB_TOOLS_CONFIG, YANDEX_DB_CONFIG]);
}

async function fetchYandexDbToolsApi(path, body = {}) {
  const url = buildFunctionRouteUrl(getToolsApiUrl(), path, 'https://family-db-tools.local');

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
    throw new Error(payload?.error || `Yandex DB tools API вернул ${response.status}.`);
  }

  return payload;
}

export async function runYandexDocumentNer(documentId, options = {}) {
  return fetchYandexDbToolsApi(`/documents/${encodeURIComponent(documentId)}/ner`, {
    includeNames: options.includeNames !== false,
    includeKinship: options.includeKinship !== false,
  });
}
