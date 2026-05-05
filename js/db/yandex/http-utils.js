import { ensureLeadingSlash, stripTrailingSlashes } from '../../utils/normalize.js';

export function getConfiguredApiUrl(config, errorMessage) {
  const apiUrl = stripTrailingSlashes(config?.apiUrl);
  if (!apiUrl) {
    throw new Error(errorMessage);
  }
  return apiUrl;
}

export function getConfiguredApiToken(configs, localStorageKey = 'family-db-api-token') {
  for (const config of configs) {
    const token = String(config?.apiToken || '').trim();
    if (token) return token;
  }
  return String(globalThis.localStorage?.getItem(localStorageKey) || '').trim();
}

export function buildFunctionRouteUrl(apiUrl, path, localBaseUrl) {
  const url = new URL(apiUrl);
  const routeUrl = new URL(ensureLeadingSlash(path), localBaseUrl);
  url.searchParams.set('route', routeUrl.pathname);
  for (const [key, value] of routeUrl.searchParams.entries()) {
    url.searchParams.set(key, value);
  }
  return url;
}
