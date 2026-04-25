import {
  fetchSupabaseDocumentChunkRows,
  fetchSupabaseDocumentManifestRows,
  fetchSupabaseDocumentPayloadRows,
} from './supabase/documents-store.js';
import {
  fetchYandexDocumentChunkRows,
  fetchYandexDocumentManifestRows,
  fetchYandexDocumentPayloadRows,
} from './yandex/documents-store.js';

export async function fetchRemoteDocumentManifestRows(source) {
  return source === 'yandex'
    ? fetchYandexDocumentManifestRows()
    : fetchSupabaseDocumentManifestRows();
}

export async function fetchRemoteDocumentPayloadRows(source, documentId) {
  return source === 'yandex'
    ? fetchYandexDocumentPayloadRows(documentId)
    : fetchSupabaseDocumentPayloadRows(documentId);
}

export async function fetchRemoteDocumentChunkRows(source, documentId, options) {
  return source === 'yandex'
    ? fetchYandexDocumentChunkRows(documentId, options)
    : fetchSupabaseDocumentChunkRows(documentId, options);
}
