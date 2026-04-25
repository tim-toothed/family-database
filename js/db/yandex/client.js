import { YANDEX_DB_CONFIG } from '../../config.js';

function getApiUrl() {
  const apiUrl = String(YANDEX_DB_CONFIG?.apiUrl || '').trim().replace(/\/+$/, '');
  if (!apiUrl) {
    throw new Error('Yandex DB API URL не настроен в js/config.js.');
  }
  return apiUrl;
}

function getApiToken() {
  return String(
    YANDEX_DB_CONFIG?.apiToken
    || globalThis.localStorage?.getItem('family-db-api-token')
    || ''
  ).trim();
}

export async function fetchYandexDbApi(path, options = {}) {
  const normalizedPath = String(path || '').startsWith('/') ? path : `/${path}`;
  const url = new URL(getApiUrl());
  const routeUrl = new URL(normalizedPath, 'https://family-db.local');
  url.searchParams.set('route', routeUrl.pathname);
  for (const [key, value] of routeUrl.searchParams.entries()) {
    url.searchParams.set(key, value);
  }
  const headers = {
    Accept: 'application/json',
    ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };
  const token = getApiToken();
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url.toString(), {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `Yandex DB API вернул ${response.status}.`);
  }

  return payload;
}
