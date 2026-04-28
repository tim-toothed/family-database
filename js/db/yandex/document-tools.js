import { YANDEX_DB_CONFIG, YANDEX_DB_TOOLS_CONFIG } from '../../config.js';

function getToolsApiUrl() {
  const apiUrl = String(YANDEX_DB_TOOLS_CONFIG?.apiUrl || '').trim().replace(/\/+$/, '');
  if (!apiUrl) {
    throw new Error('Yandex DB tools API URL не настроен в js/config.js.');
  }
  return apiUrl;
}

function getApiToken() {
  return String(
    YANDEX_DB_TOOLS_CONFIG?.apiToken
    || YANDEX_DB_CONFIG?.apiToken
    || globalThis.localStorage?.getItem('family-db-api-token')
    || ''
  ).trim();
}

async function fetchYandexDbToolsApi(path, body = {}) {
  const normalizedPath = String(path || '').startsWith('/') ? path : `/${path}`;
  const url = new URL(getToolsApiUrl());
  const routeUrl = new URL(normalizedPath, 'https://family-db-tools.local');
  url.searchParams.set('route', routeUrl.pathname);

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
