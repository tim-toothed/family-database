import {
  DATA_SOURCE_VALUES,
  getRequestedDataSource,
} from '../db/source.js';

export const MANIFEST_PATH = './data/docs_processed/index.json';
export const DEFAULT_ENTITIES_BASE_PATH = './data/docs_processed/entities';
export const LINKABLE_TEXT_SKIP_SELECTOR = 'script, style';
export const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
export const ENTITY_BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote';
export const ENTITY_SKIP_SELECTOR = 'script, style, .entity-candidate';
export const SELECTION_QUOTE_LIMIT = 160;
export { getRequestedDataSource };

export function normalizeDocumentEntry(entry, index) {
  const id = String(entry?.id || `document-${index + 1}`).trim();
  const path = String(entry?.path || entry?.source_path || '').trim();
  const type = String(entry?.type || entry?.source_type || '').trim().toLowerCase();
  if (!path || !type) return null;

  return {
    id,
    title: String(entry?.title || path).trim(),
    description: String(entry?.description || '').trim(),
    type,
    path,
    entitiesPath: String(
      entry?.entities_path || `${DEFAULT_ENTITIES_BASE_PATH}/${id}.json`,
    ).trim(),
    storage: DATA_SOURCE_VALUES.has(String(entry?.storage || '').trim().toLowerCase())
      ? String(entry.storage).trim().toLowerCase()
      : 'local',
    blockCount: Number(entry?.block_count || 0),
    mentionCount: Number(entry?.mention_count || 0),
    generatedAt: String(entry?.generated_at || '').trim(),
  };
}
