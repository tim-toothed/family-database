const MANIFEST_PATH = './data/misc/index.json';
const DEFAULT_ENTITIES_BASE_PATH = './data/misc/entities_experimental';
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
const ENTITY_BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote';
const ENTITY_SKIP_SELECTOR = 'script, style, .entity-candidate';

const state = {
  documents: [],
  currentDocumentId: null,
  currentLoadToken: 0,
  currentDocumentHtml: '',
  currentDocumentEntityData: null,
  outline: [],
  highlightedEntities: [],
};

const documentSelect = document.getElementById('documentSelect');
const documentCountBadge = document.getElementById('documentCountBadge');
const outlineCountBadge = document.getElementById('outlineCountBadge');
const documentList = document.getElementById('documentList');
const documentOutline = document.getElementById('documentOutline');
const documentLoadingState = document.getElementById('documentLoadingState');
const documentMeta = document.getElementById('documentMeta');
const documentTitle = document.getElementById('documentTitle');
const documentSourceLink = document.getElementById('documentSourceLink');
const documentReader = document.getElementById('documentReader');

function normalizeWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeForMatch(value) {
  return normalizeWhitespace(value).toLocaleLowerCase('ru').replaceAll('ё', 'е');
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function getDocumentRoot() {
  return documentReader.querySelector('.document-prose');
}

function showLoading(message) {
  documentLoadingState.textContent = message;
  documentLoadingState.classList.remove('hidden');
}

function hideLoading() {
  documentLoadingState.classList.add('hidden');
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
  return response.json();
}

async function fetchOptionalJson(path) {
  const response = await fetch(path);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
  return response.json();
}

async function fetchText(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
  return response.text();
}

async function fetchArrayBuffer(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to load ${path}: ${response.status}`);
  return response.arrayBuffer();
}

function normalizeDocumentEntry(entry, index) {
  const path = String(entry?.path || '').trim();
  const type = String(entry?.type || '').trim().toLowerCase();
  if (!path || !type) return null;

  return {
    id: String(entry?.id || `document-${index + 1}`).trim(),
    title: String(entry?.title || path).trim(),
    description: String(entry?.description || '').trim(),
    type,
    path,
    entitiesPath: String(
      entry?.entities_path || `${DEFAULT_ENTITIES_BASE_PATH}/${String(entry?.id || `document-${index + 1}`).trim()}.json`,
    ).trim(),
  };
}

async function loadDocumentManifest() {
  const manifest = await fetchJson(MANIFEST_PATH);
  const entries = Array.isArray(manifest?.documents) ? manifest.documents : [];
  const documents = entries.map(normalizeDocumentEntry).filter(Boolean);
  if (!documents.length) throw new Error('No documents in manifest.');
  return documents;
}

function renderDocumentList() {
  documentSelect.innerHTML = [
    '<option value="">Выберите документ...</option>',
    ...state.documents.map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.title)}</option>`),
  ].join('');

  documentList.innerHTML = state.documents.map((entry) => `
    <button type="button" class="document-list-item${entry.id === state.currentDocumentId ? ' is-active' : ''}" data-document-id="${escapeHtml(entry.id)}">
      <span class="document-list-title">${escapeHtml(entry.title)}</span>
      <span class="document-list-meta">${escapeHtml(entry.description || entry.type.toUpperCase())}</span>
    </button>
  `).join('');

  documentSelect.value = state.currentDocumentId || '';
  documentCountBadge.textContent = String(state.documents.length);
}

function syncLocation(documentId, headingId = '') {
  const url = new URL(window.location.href);
  if (documentId) {
    url.searchParams.set('doc', documentId);
  } else {
    url.searchParams.delete('doc');
  }

  url.hash = headingId;
  history.replaceState({}, '', url);
}

function buildOutline(root) {
  state.outline = Array.from(root.querySelectorAll(HEADING_SELECTOR)).map((heading, index) => {
    const id = `section-${index + 1}`;
    heading.id = id;

    return {
      id,
      level: Number(heading.tagName.slice(1)),
      title: normalizeWhitespace(heading.textContent) || `Раздел ${index + 1}`,
    };
  });

  outlineCountBadge.textContent = String(state.outline.length);
  documentOutline.innerHTML = state.outline.length
    ? state.outline.map((entry) => `
      <button type="button" class="document-outline-item" data-heading-id="${escapeHtml(entry.id)}" style="--outline-level:${entry.level};">
        ${escapeHtml(entry.title)}
      </button>
    `).join('')
    : '<div class="documents-empty-state documents-empty-state-compact">В документе не найдено заголовков.</div>';
}

function collectRenderableBlocks(root) {
  const elements = Array.from(root.querySelectorAll(ENTITY_BLOCK_SELECTOR))
    .filter((element) => normalizeWhitespace(element.textContent));

  return elements.filter((element) => !elements.some((other) => other !== element && element.contains(other)));
}

function areBlockTextsCompatible(sourceText, renderedText) {
  const left = normalizeForMatch(sourceText);
  const right = normalizeForMatch(renderedText);
  if (!left || !right) return false;
  if (left === right) return true;
  if (left.length > 24 && right.includes(left)) return true;
  if (right.length > 24 && left.includes(right)) return true;

  const leftStart = left.slice(0, 36);
  const rightStart = right.slice(0, 36);
  const leftEnd = left.slice(-36);
  const rightEnd = right.slice(-36);
  return leftStart === rightStart || leftEnd === rightEnd;
}

function findMatchingRenderedBlock(sourceBlock, renderedBlocks, startIndex = 0) {
  for (let index = startIndex; index < Math.min(renderedBlocks.length, startIndex + 8); index += 1) {
    if (areBlockTextsCompatible(sourceBlock.text, renderedBlocks[index].textContent)) {
      return index;
    }
  }

  for (let index = 0; index < renderedBlocks.length; index += 1) {
    if (areBlockTextsCompatible(sourceBlock.text, renderedBlocks[index].textContent)) {
      return index;
    }
  }

  return -1;
}

function findTextPositionWithin(element, targetOffset) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest(ENTITY_SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let traversed = 0;
  let lastTextNode = null;

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const length = node.nodeValue.length;
    lastTextNode = node;

    if (targetOffset <= traversed + length) {
      return {
        node,
        offset: targetOffset - traversed,
      };
    }

    traversed += length;
  }

  if (lastTextNode) {
    return {
      node: lastTextNode,
      offset: lastTextNode.nodeValue.length,
    };
  }

  return null;
}

function resolveEntityOffsetsInBlock(blockText, entity) {
  const directText = blockText.slice(entity.start, entity.end);
  if (directText === entity.text) {
    return { start: entity.start, end: entity.end };
  }

  const matches = [];
  let searchFrom = 0;
  while (searchFrom < blockText.length) {
    const foundAt = blockText.indexOf(entity.text, searchFrom);
    if (foundAt < 0) break;
    matches.push(foundAt);
    searchFrom = foundAt + Math.max(1, entity.text.length);
  }

  if (!matches.length) {
    return null;
  }

  let bestStart = matches[0];
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidateStart of matches) {
    let score = Math.abs(candidateStart - entity.start);

    if (entity.prefix) {
      const prefixStart = Math.max(0, candidateStart - entity.prefix.length);
      const prefix = blockText.slice(prefixStart, candidateStart);
      if (prefix.endsWith(entity.prefix)) {
        score -= 1000;
      }
    }

    if (entity.suffix) {
      const suffix = blockText.slice(
        candidateStart + entity.text.length,
        candidateStart + entity.text.length + entity.suffix.length,
      );
      if (suffix.startsWith(entity.suffix)) {
        score -= 1000;
      }
    }

    if (score < bestScore) {
      bestScore = score;
      bestStart = candidateStart;
    }
  }

  return {
    start: bestStart,
    end: bestStart + entity.text.length,
  };
}

function applyDetectedEntitiesToElement(element, entities) {
  const blockText = element.textContent;

  const sorted = entities
    .slice()
    .sort((left, right) => {
      if (left.start !== right.start) return left.start - right.start;
      if (left.end !== right.end) return right.end - left.end;
      if (left.kind !== right.kind) return left.kind === 'kinship' ? -1 : 1;
      return 0;
    });

  const renderable = [];
  for (const entity of sorted) {
    const overlap = renderable.find((candidate) => entity.start < candidate.end && entity.end > candidate.start);
    if (!overlap) {
      renderable.push(entity);
      continue;
    }

    const entityScore = [
      entity.kind === 'kinship' ? 1 : 0,
      entity.end - entity.start,
    ];
    const overlapScore = [
      overlap.kind === 'kinship' ? 1 : 0,
      overlap.end - overlap.start,
    ];

    if (entityScore[0] > overlapScore[0] || (entityScore[0] === overlapScore[0] && entityScore[1] > overlapScore[1])) {
      const overlapIndex = renderable.indexOf(overlap);
      renderable.splice(overlapIndex, 1, entity);
    }
  }

  const byOffsetDescending = renderable
    .slice()
    .sort((left, right) => right.start - left.start || right.end - left.end);

  for (const entity of byOffsetDescending) {
    const resolved = resolveEntityOffsetsInBlock(blockText, entity);
    if (!resolved) continue;

    const start = findTextPositionWithin(element, resolved.start);
    const end = findTextPositionWithin(element, resolved.end);
    if (!start || !end || (start.node === end.node && start.offset === end.offset)) {
      continue;
    }

    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);

    const wrapper = document.createElement('span');
    wrapper.className = `entity-candidate entity-kind-${entity.kind}`;
    wrapper.dataset.entityKind = entity.kind;
    wrapper.dataset.entityText = normalizeWhitespace(entity.text);
    wrapper.dataset.entitySource = entity.source;
    wrapper.title = entity.kind === 'kinship'
      ? 'Родственное описание из NLP-извлечения'
      : 'Имя из NLP-извлечения';

    const extracted = range.extractContents();
    wrapper.append(extracted);
    range.insertNode(wrapper);

    state.highlightedEntities.push({
      kind: entity.kind,
      text: normalizeWhitespace(wrapper.textContent),
      source: entity.source,
    });
  }
}

function applyDetectedCandidates(root) {
  state.highlightedEntities = [];

  if (!state.currentDocumentEntityData?.blocks?.length) {
    return;
  }

  const renderedBlocks = collectRenderableBlocks(root);
  let renderedIndex = 0;

  for (const block of state.currentDocumentEntityData.blocks) {
    if (!block.entities.length) continue;
    const matchedIndex = findMatchingRenderedBlock(block, renderedBlocks, renderedIndex);
    if (matchedIndex < 0) continue;
    renderedIndex = matchedIndex + 1;
    applyDetectedEntitiesToElement(renderedBlocks[matchedIndex], block.entities);
  }
}

function getHighlightedEntityStats() {
  const stats = {
    total: state.highlightedEntities.length,
    names: 0,
    kinship: 0,
  };

  for (const entity of state.highlightedEntities) {
    if (entity.kind === 'kinship') {
      stats.kinship += 1;
    } else if (entity.kind === 'name') {
      stats.names += 1;
    }
  }

  return stats;
}

function renderDocumentView() {
  if (!state.currentDocumentHtml) return;

  documentReader.innerHTML = `<div class="document-prose">${state.currentDocumentHtml}</div>`;
  const root = getDocumentRoot();

  buildOutline(root);
  applyDetectedCandidates(root);

  const stats = getHighlightedEntityStats();
  const currentDocument = state.documents.find((entry) => entry.id === state.currentDocumentId);
  const entityLabel = stats.total
    ? `${stats.total} NLP-подсветок`
    : 'без NLP-подсветок';

  documentMeta.textContent = [
    currentDocument?.type === 'markdown' ? 'Markdown' : 'DOCX',
    state.outline.length ? `${state.outline.length} заголовков` : 'без заголовков',
    entityLabel,
  ].filter(Boolean).join(' · ');
}

async function loadDocumentHtml(documentEntry) {
  if (documentEntry.type === 'markdown') {
    if (!window.marked?.parse) throw new Error('Markdown parser is unavailable.');
    return window.marked.parse(await fetchText(documentEntry.path), {
      gfm: true,
      breaks: true,
      headerIds: false,
      mangle: false,
    });
  }

  if (documentEntry.type === 'docx') {
    if (!window.mammoth?.convertToHtml) throw new Error('DOCX parser is unavailable.');
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

function showReaderError(message) {
  documentReader.innerHTML = `<div class="error-box">${escapeHtml(message)}</div>`;
  documentOutline.innerHTML = '<div class="documents-empty-state documents-empty-state-compact">Оглавление недоступно.</div>';
  outlineCountBadge.textContent = '0';
  documentMeta.textContent = 'Ошибка чтения документа';
  documentTitle.textContent = 'Документ не удалось открыть';
  documentSourceLink.classList.add('hidden');
  documentSourceLink.removeAttribute('href');
  state.currentDocumentHtml = '';
  state.currentDocumentEntityData = null;
  state.highlightedEntities = [];
}

async function loadAndRenderDocument(documentId) {
  const documentEntry = state.documents.find((entry) => entry.id === documentId);
  if (!documentEntry) throw new Error('Document not found.');

  state.currentDocumentId = documentEntry.id;
  state.currentDocumentEntityData = null;
  renderDocumentList();
  showLoading('Загрузка документа...');

  const loadToken = ++state.currentLoadToken;

  try {
    const [html, entityData] = await Promise.all([
      loadDocumentHtml(documentEntry),
      loadDocumentEntityData(documentEntry),
    ]);
    if (loadToken !== state.currentLoadToken) return;

    state.currentDocumentHtml = html;
    state.currentDocumentEntityData = entityData;
    documentTitle.textContent = documentEntry.title;
    documentSourceLink.href = documentEntry.path;
    documentSourceLink.classList.remove('hidden');
    renderDocumentView();
    syncLocation(documentEntry.id);
  } catch (error) {
    if (loadToken !== state.currentLoadToken) return;
    showReaderError(error instanceof Error ? error.message : String(error));
  } finally {
    if (loadToken === state.currentLoadToken) {
      hideLoading();
    }
  }
}

documentSelect?.addEventListener('change', (event) => {
  if (event.target.value) {
    loadAndRenderDocument(event.target.value);
  }
});

documentList?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-document-id]');
  if (button) {
    loadAndRenderDocument(button.dataset.documentId);
  }
});

documentOutline?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-heading-id]');
  const heading = button ? document.getElementById(button.dataset.headingId) : null;
  if (!heading) return;

  heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
  syncLocation(state.currentDocumentId, button.dataset.headingId);
});

async function init() {
  try {
    state.documents = await loadDocumentManifest();
    renderDocumentList();

    const requestedId = new URLSearchParams(window.location.search).get('doc');
    const initialDocument = requestedId && state.documents.some((entry) => entry.id === requestedId)
      ? requestedId
      : state.documents[0]?.id;

    if (!initialDocument) {
      throw new Error('No document available.');
    }

    await loadAndRenderDocument(initialDocument);

    const requestedHash = window.location.hash ? window.location.hash.slice(1) : '';
    if (requestedHash) {
      document.getElementById(requestedHash)?.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
  } catch (error) {
    showReaderError(error instanceof Error ? error.message : String(error));
    hideLoading();
  }
}

init();
