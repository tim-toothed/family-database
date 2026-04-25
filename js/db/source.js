import { CONFIG } from '../config.js';

export const DATA_SOURCE_VALUES = new Set(['auto', 'local', 'supabase', 'yandex']);

export function normalizeDataSource(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return DATA_SOURCE_VALUES.has(normalized) ? normalized : 'auto';
}

export function getRequestedDataSource() {
  const configured = normalizeDataSource(CONFIG.dataSource);
  const params = new URLSearchParams(globalThis.location?.search || '');
  const override = normalizeDataSource(params.get('dataSource') || params.get('source'));
  return override === 'auto' && !params.has('dataSource') && !params.has('source')
    ? configured
    : override;
}

export function getRemoteDataSource(source = getRequestedDataSource()) {
  return source === 'yandex' ? 'yandex' : 'supabase';
}
