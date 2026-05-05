import { YANDEX_DB_CONFIG } from '../../config.js';
import {
  buildFunctionRouteUrl,
  getConfiguredApiToken,
  getConfiguredApiUrl,
} from './http-utils.js';

function getApiUrl() {
  return getConfiguredApiUrl(YANDEX_DB_CONFIG, 'Yandex DB API URL не настроен в js/config.js.');
}

function getApiToken() {
  return getConfiguredApiToken([YANDEX_DB_CONFIG]);
}

export async function fetchYandexDbApi(path, options = {}) {
  const url = buildFunctionRouteUrl(getApiUrl(), path, 'https://family-db.local');
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
