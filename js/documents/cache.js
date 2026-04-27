const DOCUMENT_MANIFEST_CACHE_PREFIX = 'family-doc-manifest:v1:';
const DOCUMENT_PAYLOAD_CACHE_PREFIX = 'family-doc-payload:v1:';
const DOCUMENT_MANIFEST_MEMORY_LIMIT = 2;
const DOCUMENT_PAYLOAD_MEMORY_LIMIT = 6;
const DOCUMENT_PAYLOAD_MEMORY_BUDGET = 12 * 1024 * 1024;
const DOCUMENT_PAYLOAD_SESSION_BUDGET = 3 * 1024 * 1024;
const DOCUMENT_PAYLOAD_SESSION_ITEM_LIMIT = 750 * 1024;

const documentManifestMemoryCache = new Map();
const documentPayloadMemoryCache = new Map();

function getApproximateByteSize(value) {
  return new Blob([value]).size;
}

function getManifestCacheKey(source) {
  return `${DOCUMENT_MANIFEST_CACHE_PREFIX}${source}`;
}

function getDocumentPayloadMemoryEntrySize(payload) {
  return getApproximateByteSize(payload.html || '') + getApproximateByteSize(JSON.stringify(payload.entityData || null));
}

function getMemoryCacheTotalSize(cache) {
  let totalSize = 0;
  for (const entry of cache.values()) {
    totalSize += Number(entry?.size || 0);
  }
  return totalSize;
}

function touchMemoryCacheEntry(cache, cacheKey) {
  const hit = cache.get(cacheKey);
  if (!hit) return null;
  cache.delete(cacheKey);
  cache.set(cacheKey, hit);
  return hit;
}

function setMemoryCacheEntry(cache, cacheKey, value) {
  cache.delete(cacheKey);
  cache.set(cacheKey, value);
}

function getDocumentPayloadCacheKey(documentEntry) {
  return [
    documentEntry.storage || 'unknown',
    documentEntry.id || '',
    documentEntry.generatedAt || '',
    Number.isFinite(documentEntry.blockCount) ? documentEntry.blockCount : 0,
    Number.isFinite(documentEntry.mentionCount) ? documentEntry.mentionCount : 0,
  ].join('::');
}

function getDocumentPayloadSessionStorageKey(documentEntry) {
  return `${DOCUMENT_PAYLOAD_CACHE_PREFIX}${getDocumentPayloadCacheKey(documentEntry)}`;
}

function normalizeCachedDocumentManifest(documents) {
  if (!Array.isArray(documents)) return null;

  const normalized = documents
    .filter((entry) => (
      entry
      && typeof entry === 'object'
      && typeof entry.id === 'string'
      && typeof entry.type === 'string'
      && typeof entry.path === 'string'
    ))
    .map((entry) => ({ ...entry }));

  return normalized.length ? normalized : null;
}

function trimManifestMemoryCache() {
  while (documentManifestMemoryCache.size > DOCUMENT_MANIFEST_MEMORY_LIMIT) {
    const oldestKey = documentManifestMemoryCache.keys().next().value;
    if (!oldestKey) break;
    documentManifestMemoryCache.delete(oldestKey);
  }
}

function readSessionStorageJson(cacheKey) {
  try {
    const raw = window.sessionStorage?.getItem(cacheKey);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function getCachedDocumentManifest(source) {
  const cacheKey = getManifestCacheKey(source);
  const memoryHit = touchMemoryCacheEntry(documentManifestMemoryCache, cacheKey);
  if (memoryHit) {
    return memoryHit.documents;
  }

  const parsed = readSessionStorageJson(cacheKey);
  const normalized = normalizeCachedDocumentManifest(parsed?.documents);
  if (!normalized) {
    window.sessionStorage?.removeItem(cacheKey);
    return null;
  }

  setMemoryCacheEntry(documentManifestMemoryCache, cacheKey, { documents: normalized });
  trimManifestMemoryCache();
  return normalized;
}

export function cacheDocumentManifest(source, documents) {
  const normalized = normalizeCachedDocumentManifest(documents);
  if (!normalized) return;

  const cacheKey = getManifestCacheKey(source);
  setMemoryCacheEntry(documentManifestMemoryCache, cacheKey, { documents: normalized });
  trimManifestMemoryCache();

  try {
    window.sessionStorage?.setItem(cacheKey, JSON.stringify({ documents: normalized }));
  } catch {
    // Ignore storage quota errors for manifest cache.
  }
}

export function clearDocumentManifestCache(source) {
  const cacheKey = getManifestCacheKey(source);
  documentManifestMemoryCache.delete(cacheKey);
  try {
    window.sessionStorage?.removeItem(cacheKey);
  } catch {
    // Ignore storage access errors.
  }
}

function normalizeCachedDocumentPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.html !== 'string') return null;
  if (!['supabase', 'yandex', 'local'].includes(payload.loadSource)) return null;

  return {
    html: payload.html,
    entityData: payload.entityData && typeof payload.entityData === 'object'
      ? payload.entityData
      : null,
    loadSource: payload.loadSource,
  };
}

function trimDocumentPayloadMemoryCache() {
  while (
    documentPayloadMemoryCache.size > DOCUMENT_PAYLOAD_MEMORY_LIMIT
    || getMemoryCacheTotalSize(documentPayloadMemoryCache) > DOCUMENT_PAYLOAD_MEMORY_BUDGET
  ) {
    const oldestKey = documentPayloadMemoryCache.keys().next().value;
    if (!oldestKey) break;
    documentPayloadMemoryCache.delete(oldestKey);
  }
}

function trimSessionStorageByPrefix(prefix, incomingSize, totalBudget) {
  const keys = [];
  let totalSize = 0;

  for (let index = 0; index < window.sessionStorage.length; index += 1) {
    const key = window.sessionStorage.key(index);
    if (!key || !key.startsWith(prefix)) continue;

    const value = window.sessionStorage.getItem(key) || '';
    totalSize += getApproximateByteSize(value);
    keys.push(key);
  }

  while (keys.length && totalSize + incomingSize > totalBudget) {
    const oldestKey = keys.shift();
    const existingValue = oldestKey ? (window.sessionStorage.getItem(oldestKey) || '') : '';
    if (oldestKey) {
      totalSize -= getApproximateByteSize(existingValue);
      window.sessionStorage.removeItem(oldestKey);
    }
  }
}

function storePayloadInMemory(cacheKey, payload) {
  setMemoryCacheEntry(documentPayloadMemoryCache, cacheKey, {
    payload,
    size: getDocumentPayloadMemoryEntrySize(payload),
  });
  trimDocumentPayloadMemoryCache();
}

export function getCachedDocumentPayload(documentEntry) {
  const cacheKey = getDocumentPayloadCacheKey(documentEntry);
  const memoryHit = touchMemoryCacheEntry(documentPayloadMemoryCache, cacheKey);
  if (memoryHit) {
    return memoryHit.payload;
  }

  const storageKey = getDocumentPayloadSessionStorageKey(documentEntry);
  const cached = normalizeCachedDocumentPayload(readSessionStorageJson(storageKey));
  if (!cached) {
    window.sessionStorage?.removeItem(storageKey);
    return null;
  }

  storePayloadInMemory(cacheKey, cached);
  return cached;
}

export function cacheDocumentPayload(documentEntry, payload) {
  const normalized = normalizeCachedDocumentPayload(payload);
  if (!normalized) return;

  const cacheKey = getDocumentPayloadCacheKey(documentEntry);
  storePayloadInMemory(cacheKey, normalized);

  try {
    const serialized = JSON.stringify(normalized);
    const serializedSize = getApproximateByteSize(serialized);
    if (serializedSize <= DOCUMENT_PAYLOAD_SESSION_ITEM_LIMIT) {
      trimSessionStorageByPrefix(
        DOCUMENT_PAYLOAD_CACHE_PREFIX,
        serializedSize,
        DOCUMENT_PAYLOAD_SESSION_BUDGET,
      );
      window.sessionStorage?.setItem(
        getDocumentPayloadSessionStorageKey(documentEntry),
        serialized,
      );
    }
  } catch {
    // Ignore storage quota errors; in-memory cache already covers active navigation.
  }
}
