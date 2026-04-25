import {
  MANIFEST_PATH,
  getRequestedDataSource,
  normalizeDocumentEntry,
} from './config.js';
import { cacheDocumentManifest, cacheDocumentPayload, getCachedDocumentManifest, getCachedDocumentPayload } from './cache.js';
import { escapeHtml } from './utils.js';
import {
  fetchRemoteDocumentChunkRows,
  fetchRemoteDocumentManifestRows,
  fetchRemoteDocumentPayloadRows,
} from '../db/documents-store.js';
import { getRemoteDataSource } from '../db/source.js';

const REMOTE_DOCUMENT_CHUNK_SIZE = 200;
const MARKED_CDN_URL = 'https://cdn.jsdelivr.net/npm/marked/marked.min.js';
const MAMMOTH_CDN_URL = 'https://cdn.jsdelivr.net/npm/mammoth@1.8.0/mammoth.browser.min.js';

const externalScriptPromises = new Map();

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Не удалось загрузить ${path}: ${response.status}`);
  return response.json();
}

async function fetchOptionalJson(path) {
  const response = await fetch(path);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Не удалось загрузить ${path}: ${response.status}`);
  return response.json();
}

async function fetchText(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Не удалось загрузить ${path}: ${response.status}`);
  return response.text();
}

async function fetchArrayBuffer(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Не удалось загрузить ${path}: ${response.status}`);
  return response.arrayBuffer();
}

function loadExternalScript(src) {
  if (externalScriptPromises.has(src)) {
    return externalScriptPromises.get(src);
  }

  const promise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${src}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error(`Не удалось загрузить ${src}.`)), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error(`Не удалось загрузить ${src}.`));
    document.head.append(script);
  });

  externalScriptPromises.set(src, promise);
  return promise;
}

async function ensureMarked() {
  if (!window.marked?.parse) {
    await loadExternalScript(MARKED_CDN_URL);
  }
  if (!window.marked?.parse) {
    throw new Error('Markdown parser is unavailable.');
  }
}

async function ensureMammoth() {
  if (!window.mammoth?.convertToHtml) {
    await loadExternalScript(MAMMOTH_CDN_URL);
  }
  if (!window.mammoth?.convertToHtml) {
    throw new Error('DOCX parser is unavailable.');
  }
}

async function loadLocalDocumentManifest() {
  const cachedDocuments = getCachedDocumentManifest('local');
  if (cachedDocuments) {
    return cachedDocuments;
  }

  const manifest = await fetchJson(MANIFEST_PATH);
  const entries = Array.isArray(manifest?.documents) ? manifest.documents : [];
  const documents = entries
    .map((entry, index) => normalizeDocumentEntry({ ...entry, storage: 'local' }, index))
    .filter(Boolean);
  if (!documents.length) throw new Error('В локальном манифесте нет документов.');
  cacheDocumentManifest('local', documents);
  return documents;
}

async function loadRemoteDocumentManifest(source) {
  const cachedDocuments = getCachedDocumentManifest(source);
  if (cachedDocuments) {
    return cachedDocuments;
  }

  const rows = await fetchRemoteDocumentManifestRows(source);

  const documents = rows
    .map((row, index) => normalizeDocumentEntry({ ...row, storage: source }, index))
    .filter(Boolean);

  if (!documents.length) {
    throw new Error(`В ${source} не найдено ни одного документа.`);
  }

  cacheDocumentManifest(source, documents);
  return documents;
}

export async function loadDocumentManifest() {
  const source = getRequestedDataSource();

  if (source === 'local') {
    return loadLocalDocumentManifest();
  }

  try {
    return await loadRemoteDocumentManifest(getRemoteDataSource(source));
  } catch (error) {
    if (source === 'supabase' || source === 'yandex') {
      throw error;
    }

    console.warn('Удаленная БД недоступна для документов, загружаю локальные файлы.', error);
    return loadLocalDocumentManifest();
  }
}

function formatBlockTextAsHtml(text) {
  return escapeHtml(String(text).replaceAll('\r\n', '\n').replaceAll('\r', '\n')).replaceAll('\n', '<br>');
}

function renderRemoteDocumentHtml(blocks) {
  const parts = [];
  let listItems = [];

  const flushList = () => {
    if (!listItems.length) return;
    parts.push(`<ul>${listItems.join('')}</ul>`);
    listItems = [];
  };

  for (const block of blocks) {
    const rawText = String(block?.text || '');
    if (!rawText.trim()) continue;

    if (block.kind === 'list_item') {
      listItems.push(`<li>${formatBlockTextAsHtml(rawText)}</li>`);
      continue;
    }

    flushList();

    if (block.kind === 'heading') {
      parts.push(`<h2>${formatBlockTextAsHtml(rawText)}</h2>`);
      continue;
    }

    parts.push(`<p>${formatBlockTextAsHtml(rawText)}</p>`);
  }

  flushList();
  return parts.join('');
}

function normalizeRemoteMention(mention) {
  return {
    id: `S${Number(mention?.block_index || 0) + 1}-${Number(mention?.mention_index || 0) + 1}`,
    kind: mention?.kind === 'kinship' ? 'kinship' : 'name',
    text: String(mention?.text || ''),
    start: Number(mention?.start_offset || 0),
    end: Number(mention?.end_offset || 0),
    prefix: '',
    suffix: '',
    source: String(mention?.source || ''),
    confidence: '',
  };
}

function buildNormalizedRemoteBlocks(blocks, mentions) {
  const mentionsByBlockIndex = new Map();
  for (const mention of mentions) {
    const blockIndex = Number(mention?.block_index);
    if (!Number.isFinite(blockIndex)) continue;

    if (!mentionsByBlockIndex.has(blockIndex)) {
      mentionsByBlockIndex.set(blockIndex, []);
    }

    mentionsByBlockIndex.get(blockIndex).push(normalizeRemoteMention(mention));
  }

  return blocks.map((block, index) => ({
    index: Number.isFinite(Number(block?.block_index)) ? Number(block.block_index) : index,
    kind: String(block?.kind || 'paragraph'),
    text: String(block?.text || ''),
    entities: (mentionsByBlockIndex.get(Number(block?.block_index)) || [])
      .filter((entity) => entity.text && entity.end > entity.start),
  }));
}

async function loadDocumentHtml(documentEntry) {
  if (documentEntry.type === 'markdown') {
    await ensureMarked();
    return window.marked.parse(await fetchText(documentEntry.path), {
      gfm: true,
      breaks: true,
      headerIds: false,
      mangle: false,
    });
  }

  if (documentEntry.type === 'docx') {
    await ensureMammoth();
    const result = await window.mammoth.convertToHtml({ arrayBuffer: await fetchArrayBuffer(documentEntry.path) });
    return result.value;
  }

  throw new Error(`Unsupported document type: ${documentEntry.type}`);
}

async function loadDocumentEntityData(documentEntry) {
  const payload = await fetchOptionalJson(documentEntry.entitiesPath);
  if (!payload || !Array.isArray(payload.blocks)) {
    return null;
  }

  const normalizedBlocks = payload.blocks
    .map((block, index) => {
      const rawEntities = Array.isArray(block?.entities)
        ? block.entities
        : Array.isArray(block?.mentions)
          ? block.mentions
          : [];

      const entities = rawEntities
        .map((entity, entityIndex) => ({
          id: String(entity.id || `E${index + 1}-${entityIndex + 1}`),
          kind: entity.kind === 'kinship' ? 'kinship' : 'name',
          text: String(entity.text || ''),
          start: Number(entity.start || 0),
          end: Number(entity.end || 0),
          prefix: String(entity.prefix || ''),
          suffix: String(entity.suffix || ''),
          source: String(entity.source || ''),
          confidence: String(entity.confidence || ''),
        }))
        .filter((entity) => entity.text && entity.end > entity.start);

      return {
        index: Number.isFinite(block.index) ? Number(block.index) : index,
        kind: String(block.kind || 'paragraph'),
        text: String(block.text || ''),
        entities,
      };
    })
    .filter((block) => block.entities.length);

  if (!normalizedBlocks.length) {
    return null;
  }

  return {
    documentId: String(payload.document_id || documentEntry.id),
    extractor: payload.extractor || null,
    generatedAt: payload.generated_at || '',
    blocks: normalizedBlocks,
  };
}

async function loadRemoteDocumentPayload(documentEntry) {
  const source = getRemoteDataSource(documentEntry.storage);
  const [blocks, mentions] = await fetchRemoteDocumentPayloadRows(source, documentEntry.id);

  if (!blocks.length) {
    throw new Error(`В ${source} не найдены блоки документа ${documentEntry.id}.`);
  }

  const normalizedBlocks = buildNormalizedRemoteBlocks(blocks, mentions);

  return {
    html: renderRemoteDocumentHtml(normalizedBlocks),
    entityData: {
      documentId: documentEntry.id,
      extractor: null,
      generatedAt: documentEntry.generatedAt || '',
      blocks: normalizedBlocks.filter((block) => block.entities.length),
    },
    loadSource: source,
  };
}

export async function loadRemoteDocumentChunk(documentEntry, options = {}) {
  const from = Number.isFinite(Number(options.from)) ? Number(options.from) : 0;
  const chunkSize = Number(options.chunkSize) > 0 ? Number(options.chunkSize) : REMOTE_DOCUMENT_CHUNK_SIZE;
  const to = from + chunkSize - 1;
  const source = getRemoteDataSource(documentEntry.storage);

  const { blocks, mentions } = await fetchRemoteDocumentChunkRows(source, documentEntry.id, { from, to });

  if (!blocks.length) {
    return null;
  }

  const normalizedBlocks = buildNormalizedRemoteBlocks(blocks, mentions);
  const loadedBlocks = from + blocks.length;
  const totalBlocks = Number.isFinite(documentEntry.blockCount) ? documentEntry.blockCount : loadedBlocks;

  return {
    html: renderRemoteDocumentHtml(normalizedBlocks),
    entityBlocks: normalizedBlocks.filter((block) => block.entities.length),
    loadedBlocks,
    totalBlocks,
    done: loadedBlocks >= totalBlocks,
  };
}

async function loadLocalDocumentPayload(documentEntry) {
  const [html, entityData] = await Promise.all([
    loadDocumentHtml(documentEntry),
    loadDocumentEntityData(documentEntry),
  ]);

  return {
    html,
    entityData,
    loadSource: 'local',
  };
}

export async function loadDocumentPayload(documentEntry) {
  const cachedPayload = getCachedDocumentPayload(documentEntry);
  if (cachedPayload) {
    return cachedPayload;
  }

  const source = getRequestedDataSource();
  let payload;

  if (source === 'local' || documentEntry.storage === 'local') {
    payload = await loadLocalDocumentPayload(documentEntry);
    cacheDocumentPayload(documentEntry, payload);
    return payload;
  }

  try {
    payload = await loadRemoteDocumentPayload(documentEntry);
    cacheDocumentPayload(documentEntry, payload);
    return payload;
  } catch (error) {
    if (source === 'supabase' || source === 'yandex') {
      throw error;
    }

    console.warn(`Удаленная БД недоступна для документа ${documentEntry.id}, пробую локальный файл.`, error);
    payload = await loadLocalDocumentPayload({
      ...documentEntry,
      storage: 'local',
    });
    cacheDocumentPayload(documentEntry, payload);
    return payload;
  }
}
