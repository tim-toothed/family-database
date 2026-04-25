import { fetchYandexDbApi } from './client.js';

export async function fetchYandexDocumentManifestRows() {
  const payload = await fetchYandexDbApi('/documents');
  return Array.isArray(payload?.rows) ? payload.rows : [];
}

export async function fetchYandexDocumentPayloadRows(documentId) {
  const payload = await fetchYandexDbApi(`/documents/${encodeURIComponent(documentId)}`);
  return [
    Array.isArray(payload?.blocks) ? payload.blocks : [],
    Array.isArray(payload?.mentions) ? payload.mentions : [],
  ];
}

export async function fetchYandexDocumentChunkRows(documentId, { from, to }) {
  const chunkSize = Math.max(1, (Number(to) - Number(from)) + 1);
  const payload = await fetchYandexDbApi(
    `/documents/${encodeURIComponent(documentId)}/chunk?from=${encodeURIComponent(from)}&chunkSize=${encodeURIComponent(chunkSize)}`
  );
  return {
    blocks: Array.isArray(payload?.blocks) ? payload.blocks : [],
    mentions: Array.isArray(payload?.mentions) ? payload.mentions : [],
  };
}
