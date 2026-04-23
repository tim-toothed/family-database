import { CONFIG, SUPABASE_CONFIG } from './config.js';
import { getSchemaClient, requireAuth } from './auth.js';
import { buildDocumentSnippet } from './document-links.js';

const MANIFEST_PATH = './data/docs_processed/index.json';
const DEFAULT_ENTITIES_BASE_PATH = './data/docs_processed/entities';
const LINKABLE_TEXT_SKIP_SELECTOR = 'script, style';
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
const ENTITY_BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote';
const ENTITY_SKIP_SELECTOR = 'script, style, .entity-candidate';
const SELECTION_QUOTE_LIMIT = 160;
const DATA_SOURCE_VALUES = new Set(['auto', 'local', 'supabase']);

const state = {
  documents: [],
  documentsSource: null,
  currentDocumentId: null,
  currentLoadToken: 0,
  currentDocumentHtml: '',
  currentDocumentEntityData: null,
  currentDocumentLoadSource: null,
  outline: [],
  highlightedEntities: [],
  shareSelection: null,
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
const copySelectionLinkButton = document.getElementById('copySelectionLinkButton');
const copySelectionLinkStatus = document.getElementById('copySelectionLinkStatus');
const documentReader = document.getElementById('documentReader');
const documentReaderShell = document.querySelector('.document-reader-shell');
const selectionLinkBubble = document.getElementById('selectionLinkBubble');
let copySelectionLinkStatusTimer = 0;
let selectionLinkBubbleStateTimer = 0;

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

function setCopySelectionLinkStatus(message = '', tone = 'neutral') {
  if (copySelectionLinkStatus) {
    copySelectionLinkStatus.textContent = message;
    copySelectionLinkStatus.dataset.tone = tone;
  }

  if (copySelectionLinkStatusTimer) {
    window.clearTimeout(copySelectionLinkStatusTimer);
    copySelectionLinkStatusTimer = 0;
  }

  if (message) {
    copySelectionLinkStatusTimer = window.setTimeout(() => {
      if (copySelectionLinkStatus) {
        copySelectionLinkStatus.textContent = '';
        copySelectionLinkStatus.dataset.tone = 'neutral';
      }
      copySelectionLinkStatusTimer = 0;
    }, 2200);
  }
}

function setSelectionLinkBubbleCopiedState(isCopied) {
  if (!selectionLinkBubble) return;
  selectionLinkBubble.classList.toggle('is-copied', Boolean(isCopied));

  if (selectionLinkBubbleStateTimer) {
    window.clearTimeout(selectionLinkBubbleStateTimer);
    selectionLinkBubbleStateTimer = 0;
  }

  if (isCopied) {
    selectionLinkBubbleStateTimer = window.setTimeout(() => {
      selectionLinkBubble.classList.remove('is-copied');
      selectionLinkBubbleStateTimer = 0;
    }, 1200);
  }
}

function updateCopySelectionLinkButton() {
  if (!copySelectionLinkButton) return;
  copySelectionLinkButton.disabled = !state.shareSelection || !state.currentDocumentId;
}

function setShareSelection(selection) {
  state.shareSelection = selection;
  updateCopySelectionLinkButton();
}

function clearShareSelection() {
  setShareSelection(null);
  hideSelectionLinkBubble();
}

function hideSelectionLinkBubble() {
  if (!selectionLinkBubble) return;
  selectionLinkBubble.classList.remove('is-copied');
  selectionLinkBubble.classList.add('hidden');
}

function showSelectionLinkBubble() {
  if (!selectionLinkBubble) return;
  selectionLinkBubble.classList.remove('hidden');
}

function positionSelectionLinkBubble(range) {
  if (!selectionLinkBubble) return;

  const rects = Array.from(range.getClientRects()).filter((item) => item.width || item.height);
  const rect = rects[0] || range.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) {
    hideSelectionLinkBubble();
    return;
  }

  showSelectionLinkBubble();
  selectionLinkBubble.style.left = '0px';
  selectionLinkBubble.style.top = '0px';

  const bubbleRect = selectionLinkBubble.getBoundingClientRect();
  const margin = 12;
  const preferredTop = rect.top - bubbleRect.height - margin;
  const fallbackTop = rect.bottom + margin;
  const top = preferredTop >= margin
    ? preferredTop
    : Math.min(window.innerHeight - bubbleRect.height - margin, fallbackTop);
  const centerX = rect.left + (rect.width / 2);
  const left = Math.min(
    Math.max(margin, centerX - (bubbleRect.width / 2)),
    window.innerWidth - bubbleRect.width - margin,
  );

  selectionLinkBubble.style.left = `${Math.round(left)}px`;
  selectionLinkBubble.style.top = `${Math.round(top)}px`;
}

function refreshSelectionLinkBubblePosition() {
  const root = getDocumentRoot();
  const selection = window.getSelection();
  if (!root || !state.shareSelection || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
    clearShareSelection();
    return;
  }

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    clearShareSelection();
    return;
  }

  positionSelectionLinkBubble(range);
}

function scheduleSelectionRefresh() {
  window.requestAnimationFrame(() => {
    updateShareSelectionFromDom();
  });
}

function showLoading(message) {
  documentLoadingState.textContent = message;
  documentLoadingState.classList.remove('hidden');
}

function hideLoading() {
  documentLoadingState.classList.add('hidden');
}

function normalizeDataSource(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return DATA_SOURCE_VALUES.has(normalized) ? normalized : 'auto';
}

function getRequestedDataSource() {
  const configured = normalizeDataSource(CONFIG.dataSource);
  const params = new URLSearchParams(globalThis.location?.search || '');
  const override = normalizeDataSource(params.get('dataSource') || params.get('source'));
  return override === 'auto' && !params.has('dataSource') && !params.has('source')
    ? configured
    : override;
}

function hasSupabaseConfig() {
  return Boolean(
    SUPABASE_CONFIG?.url
    && SUPABASE_CONFIG?.publishableKey
    && SUPABASE_CONFIG?.tables?.textDocuments
    && SUPABASE_CONFIG?.tables?.textDocumentBlocks
    && SUPABASE_CONFIG?.tables?.textDocumentMentions,
  );
}

async function getSupabaseDataClient() {
  if (!hasSupabaseConfig()) {
    throw new Error('Supabase не настроен для документов в js/config.js.');
  }
  return getSchemaClient();
}

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

function normalizeDocumentEntry(entry, index) {
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
    storage: String(entry?.storage || 'local').trim().toLowerCase() === 'supabase' ? 'supabase' : 'local',
    blockCount: Number(entry?.block_count || 0),
    mentionCount: Number(entry?.mention_count || 0),
    generatedAt: String(entry?.generated_at || '').trim(),
  };
}

async function loadLocalDocumentManifest() {
  const manifest = await fetchJson(MANIFEST_PATH);
  const entries = Array.isArray(manifest?.documents) ? manifest.documents : [];
  const documents = entries
    .map((entry, index) => normalizeDocumentEntry({ ...entry, storage: 'local' }, index))
    .filter(Boolean);
  if (!documents.length) throw new Error('В локальном манифесте нет документов.');
  return documents;
}

async function fetchSupabasePagedRows(table, selectClause, options = {}) {
  const client = await getSupabaseDataClient();
  const pageSize = Number(options.pageSize) > 0 ? Number(options.pageSize) : 1000;
  const rows = [];

  for (let from = 0; ; from += pageSize) {
    let query = client
      .from(table)
      .select(selectClause)
      .range(from, from + pageSize - 1);

    for (const order of options.orders || []) {
      query = query.order(order.column, { ascending: order.ascending !== false });
    }

    for (const filter of options.filters || []) {
      query = query.eq(filter.column, filter.value);
    }

    const { data, error } = await query;
    if (error) {
      throw new Error(error.message);
    }

    const page = Array.isArray(data) ? data : [];
    rows.push(...page);

    if (page.length < pageSize) {
      break;
    }
  }

  return rows;
}

async function loadSupabaseDocumentManifest() {
  const rows = await fetchSupabasePagedRows(
    SUPABASE_CONFIG.tables.textDocuments,
    'id,title,description,source_type,source_path,block_count,mention_count,generated_at',
    {
      orders: [{ column: 'title', ascending: true }],
      pageSize: 500,
    },
  );

  const documents = rows
    .map((row, index) => normalizeDocumentEntry({ ...row, storage: 'supabase' }, index))
    .filter(Boolean);

  if (!documents.length) {
    throw new Error('В Supabase не найдено ни одного документа.');
  }

  return documents;
}

async function loadDocumentManifest() {
  const source = getRequestedDataSource();

  if (source === 'local') {
    const documents = await loadLocalDocumentManifest();
    state.documentsSource = { type: 'local' };
    return documents;
  }

  try {
    const documents = await loadSupabaseDocumentManifest();
    state.documentsSource = { type: 'supabase' };
    return documents;
  } catch (error) {
    if (source === 'supabase') {
      throw error;
    }

    console.warn('Supabase недоступен для документов, загружаю локальные файлы.', error);
    const documents = await loadLocalDocumentManifest();
    state.documentsSource = {
      type: 'local',
      fallbackFrom: 'supabase',
      fallbackReason: error?.message || String(error),
    };
    return documents;
  }
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

function syncLocation(documentId, headingId = '', options = {}) {
  const preserveSelection = Boolean(options?.preserveSelection);
  const url = new URL(window.location.href);
  if (documentId) {
    url.searchParams.set('doc', documentId);
  } else {
    url.searchParams.delete('doc');
  }

  if (!preserveSelection) {
    url.searchParams.delete('start');
    url.searchParams.delete('end');
    url.searchParams.delete('quote');
  }

  if (headingId) {
    url.hash = headingId;
  } else if (!preserveSelection) {
    url.hash = '';
  }

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

function findTextPositionWithin(element, targetOffset, options = {}) {
  const skipSelector = options.skipSelector ?? ENTITY_SKIP_SELECTOR;
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (skipSelector && node.parentElement?.closest(skipSelector)) return NodeFilter.FILTER_REJECT;
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

function getTextOffsetWithin(root, container, offset) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(container, offset);
  return range.toString().length;
}

function getNearestHeadingId(root, node) {
  const headings = Array.from(root.querySelectorAll(HEADING_SELECTOR));
  let nearestHeadingId = '';

  for (const heading of headings) {
    if (heading.contains(node)) {
      return heading.id || nearestHeadingId;
    }

    const position = heading.compareDocumentPosition(node);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) {
      nearestHeadingId = heading.id || nearestHeadingId;
    }
  }

  return nearestHeadingId;
}

function readRequestedTextSelection() {
  const params = new URLSearchParams(window.location.search);
  const documentId = params.get('doc') || '';
  const start = Number(params.get('start'));
  const end = Number(params.get('end'));
  const quote = params.get('quote') || '';

  if (!documentId || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return null;
  }

  return {
    documentId,
    start,
    end,
    quote,
  };
}

function resolveRequestedSelectionOffsets(root, selectionTarget) {
  const fullText = root.textContent || '';
  const quote = String(selectionTarget?.quote || '');
  const normalizedQuote = normalizeWhitespace(quote);

  if (selectionTarget.end <= fullText.length) {
    const directText = fullText.slice(selectionTarget.start, selectionTarget.end);
    if (!normalizedQuote || normalizeWhitespace(directText) === normalizedQuote) {
      return {
        start: selectionTarget.start,
        end: selectionTarget.end,
      };
    }
  }

  if (!quote) {
    return null;
  }

  const matches = [];
  let searchFrom = 0;
  while (searchFrom < fullText.length) {
    const foundAt = fullText.indexOf(quote, searchFrom);
    if (foundAt < 0) break;
    matches.push(foundAt);
    searchFrom = foundAt + Math.max(1, quote.length);
  }

  if (!matches.length) {
    return null;
  }

  const nearestStart = matches.reduce((best, candidate) => (
    Math.abs(candidate - selectionTarget.start) < Math.abs(best - selectionTarget.start) ? candidate : best
  ), matches[0]);

  return {
    start: nearestStart,
    end: nearestStart + quote.length,
  };
}

function wrapTextRangePortion(textNode, startOffset, endOffset, className, title) {
  if (!textNode || startOffset >= endOffset) return null;

  const range = document.createRange();
  range.setStart(textNode, startOffset);
  range.setEnd(textNode, endOffset);

  const wrapper = document.createElement('mark');
  wrapper.className = className;
  if (title) wrapper.title = title;

  range.surroundContents(wrapper);
  return wrapper;
}

function markTextRangeByOffsets(root, startOffset, endOffset, options = {}) {
  const portions = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (options.skipSelector && node.parentElement?.closest(options.skipSelector)) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let traversed = 0;
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const nextTraversed = traversed + node.nodeValue.length;

    if (nextTraversed <= startOffset) {
      traversed = nextTraversed;
      continue;
    }

    if (traversed >= endOffset) break;

    const localStart = Math.max(0, startOffset - traversed);
    const localEnd = Math.min(node.nodeValue.length, endOffset - traversed);
    portions.push({ node, localStart, localEnd });

    traversed = nextTraversed;
  }

  return portions
    .reverse()
    .map((portion) => wrapTextRangePortion(
      portion.node,
      portion.localStart,
      portion.localEnd,
      options.className,
      options.title,
    ))
    .filter(Boolean)
    .reverse();
}

function applyRequestedSelection(root) {
  const selectionTarget = readRequestedTextSelection();
  if (!selectionTarget || selectionTarget.documentId !== state.currentDocumentId) {
    return false;
  }

  const resolved = resolveRequestedSelectionOffsets(root, selectionTarget);
  if (!resolved) {
    return false;
  }

  if (resolved.end <= resolved.start) {
    return false;
  }

  const wrappers = markTextRangeByOffsets(root, resolved.start, resolved.end, {
    className: 'document-shared-selection',
    title: 'Ссылка на фрагмент документа',
    skipSelector: LINKABLE_TEXT_SKIP_SELECTOR,
  });
  if (!wrappers.length) return false;

  wrappers[0].scrollIntoView({ behavior: 'auto', block: 'center' });
  return true;
}

function updateShareSelectionFromDom() {
  const root = getDocumentRoot();
  const selection = window.getSelection();

  if (!root || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
    clearShareSelection();
    return;
  }

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    clearShareSelection();
    return;
  }

  const preview = normalizeWhitespace(selection.toString());
  if (!preview) {
    clearShareSelection();
    return;
  }

  const start = getTextOffsetWithin(root, range.startContainer, range.startOffset);
  const end = getTextOffsetWithin(root, range.endContainer, range.endOffset);
  if (end <= start) {
    clearShareSelection();
    return;
  }

  setShareSelection({
    start,
    end,
    quote: String(selection.toString()).replace(/\s+/g, ' ').trim().slice(0, SELECTION_QUOTE_LIMIT),
    headingId: getNearestHeadingId(root, range.startContainer),
  });
  positionSelectionLinkBubble(range);
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }

  const fallback = document.createElement('textarea');
  fallback.value = text;
  fallback.setAttribute('readonly', '');
  fallback.style.position = 'fixed';
  fallback.style.opacity = '0';
  document.body.append(fallback);
  fallback.select();

  try {
    return document.execCommand('copy');
  } finally {
    fallback.remove();
  }
}

function buildSelectionLinkUrl() {
  if (!state.currentDocumentId || !state.shareSelection) {
    return null;
  }

  return buildDocumentSnippet({
    documentId: state.currentDocumentId,
    start: state.shareSelection.start,
    end: state.shareSelection.end,
    headingId: state.shareSelection.headingId || '',
  });
}

async function copySelectionLinkSilently() {
  const snippet = buildSelectionLinkUrl();
  if (!snippet) return;

  try {
    await copyTextToClipboard(snippet);
    setSelectionLinkBubbleCopiedState(true);
  } catch {
    setSelectionLinkBubbleCopiedState(false);
  }
}

async function copySelectionLink() {
  if (!state.currentDocumentId || !state.shareSelection) {
    setCopySelectionLinkStatus('Сначала выделите фрагмент текста.', 'error');
    return;
  }

  const snippet = buildSelectionLinkUrl();
  if (!snippet) return;

  try {
    await copyTextToClipboard(snippet);
    setCopySelectionLinkStatus('Ссылка скопирована.', 'success');
  } catch (error) {
    setCopySelectionLinkStatus(error instanceof Error ? error.message : 'Не удалось скопировать ссылку.', 'error');
  }
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

function formatBlockTextAsHtml(text) {
  return escapeHtml(String(text).replaceAll('\r\n', '\n').replaceAll('\r', '\n')).replaceAll('\n', '<br>');
}

function renderSupabaseDocumentHtml(blocks) {
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

function renderDocumentView() {
  if (!state.currentDocumentHtml) return;

  documentReader.innerHTML = `<div class="document-prose">${state.currentDocumentHtml}</div>`;
  const root = getDocumentRoot();
  clearShareSelection();

  buildOutline(root);
  applyDetectedCandidates(root);
  applyRequestedSelection(root);

  const stats = getHighlightedEntityStats();
  const currentDocument = state.documents.find((entry) => entry.id === state.currentDocumentId);
  const sourceLabel = state.currentDocumentLoadSource === 'supabase'
    ? 'Supabase'
    : state.currentDocumentLoadSource === 'local'
      ? 'GitHub'
      : '';
  const entityLabel = stats.total
    ? `${stats.total} NLP-подсветок`
    : 'без NLP-подсветок';

  documentMeta.textContent = [
    sourceLabel,
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

async function loadSupabaseDocumentPayload(documentEntry) {
  const [blocks, mentions] = await Promise.all([
    fetchSupabasePagedRows(
      SUPABASE_CONFIG.tables.textDocumentBlocks,
      'block_index,kind,text,mention_count',
      {
        filters: [{ column: 'document_id', value: documentEntry.id }],
        orders: [{ column: 'block_index', ascending: true }],
        pageSize: 1000,
      },
    ),
    fetchSupabasePagedRows(
      SUPABASE_CONFIG.tables.textDocumentMentions,
      'block_index,mention_index,kind,text,start_offset,end_offset,source',
      {
        filters: [{ column: 'document_id', value: documentEntry.id }],
        orders: [
          { column: 'block_index', ascending: true },
          { column: 'mention_index', ascending: true },
        ],
        pageSize: 1000,
      },
    ),
  ]);

  if (!blocks.length) {
    throw new Error(`В Supabase не найдены блоки документа ${documentEntry.id}.`);
  }

  const mentionsByBlockIndex = new Map();
  for (const mention of mentions) {
    const blockIndex = Number(mention?.block_index);
    if (!Number.isFinite(blockIndex)) continue;

    if (!mentionsByBlockIndex.has(blockIndex)) {
      mentionsByBlockIndex.set(blockIndex, []);
    }

    mentionsByBlockIndex.get(blockIndex).push({
      id: `S${blockIndex + 1}-${Number(mention?.mention_index || 0) + 1}`,
      kind: mention?.kind === 'kinship' ? 'kinship' : 'name',
      text: String(mention?.text || ''),
      start: Number(mention?.start_offset || 0),
      end: Number(mention?.end_offset || 0),
      prefix: '',
      suffix: '',
      source: String(mention?.source || ''),
      confidence: '',
    });
  }

  const normalizedBlocks = blocks.map((block, index) => ({
    index: Number.isFinite(Number(block?.block_index)) ? Number(block.block_index) : index,
    kind: String(block?.kind || 'paragraph'),
    text: String(block?.text || ''),
    entities: (mentionsByBlockIndex.get(Number(block?.block_index)) || [])
      .filter((entity) => entity.text && entity.end > entity.start),
  }));

  return {
    html: renderSupabaseDocumentHtml(normalizedBlocks),
    entityData: {
      documentId: documentEntry.id,
      extractor: null,
      generatedAt: documentEntry.generatedAt || '',
      blocks: normalizedBlocks.filter((block) => block.entities.length),
    },
    loadSource: 'supabase',
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

async function loadDocumentPayload(documentEntry) {
  const source = getRequestedDataSource();

  if (source === 'local' || documentEntry.storage === 'local') {
    return loadLocalDocumentPayload(documentEntry);
  }

  try {
    return await loadSupabaseDocumentPayload(documentEntry);
  } catch (error) {
    if (source === 'supabase') {
      throw error;
    }

    console.warn(`Supabase недоступен для документа ${documentEntry.id}, пробую локальный файл.`, error);
    return loadLocalDocumentPayload({
      ...documentEntry,
      storage: 'local',
    });
  }
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
  state.currentDocumentLoadSource = null;
  state.highlightedEntities = [];
  clearShareSelection();
}

function updateDocumentSourceLink(documentEntry, loadSource) {
  if (!documentSourceLink) return;

  const canLinkToLocalSource = loadSource === 'local' && documentEntry?.path;
  if (!canLinkToLocalSource) {
    documentSourceLink.classList.add('hidden');
    documentSourceLink.removeAttribute('href');
    return;
  }

  documentSourceLink.href = documentEntry.path;
  documentSourceLink.classList.remove('hidden');
}

async function loadAndRenderDocument(documentId, options = {}) {
  const documentEntry = state.documents.find((entry) => entry.id === documentId);
  if (!documentEntry) throw new Error('Документ не найден.');

  state.currentDocumentId = documentEntry.id;
  state.currentDocumentEntityData = null;
  state.currentDocumentLoadSource = null;
  renderDocumentList();
  showLoading('Загрузка документа...');

  const loadToken = ++state.currentLoadToken;

  try {
    const payload = await loadDocumentPayload(documentEntry);
    if (loadToken !== state.currentLoadToken) return;

    state.currentDocumentHtml = payload.html;
    state.currentDocumentEntityData = payload.entityData;
    state.currentDocumentLoadSource = payload.loadSource;
    documentTitle.textContent = documentEntry.title;
    updateDocumentSourceLink(documentEntry, payload.loadSource);
    renderDocumentView();
    syncLocation(documentEntry.id, '', { preserveSelection: options.preserveSelection });
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

copySelectionLinkButton?.addEventListener('click', () => {
  copySelectionLink();
});

selectionLinkBubble?.addEventListener('click', () => {
  copySelectionLinkSilently();
});

selectionLinkBubble?.addEventListener('mousedown', (event) => {
  event.preventDefault();
});

document.addEventListener('selectionchange', () => {
  updateShareSelectionFromDom();
});

document.addEventListener('pointerdown', (event) => {
  if (selectionLinkBubble?.contains(event.target)) {
    return;
  }

  const root = getDocumentRoot();
  if (!root || !root.contains(event.target)) {
    window.getSelection()?.removeAllRanges();
    clearShareSelection();
    return;
  }

  hideSelectionLinkBubble();
});

document.addEventListener('pointerup', () => {
  scheduleSelectionRefresh();
});

document.addEventListener('keyup', () => {
  scheduleSelectionRefresh();
});

window.addEventListener('resize', () => {
  refreshSelectionLinkBubblePosition();
});

documentReaderShell?.addEventListener('scroll', () => {
  refreshSelectionLinkBubblePosition();
});

async function init() {
  try {
    await requireAuth();
    state.documents = await loadDocumentManifest();
    renderDocumentList();

    const requestedSelection = readRequestedTextSelection();
    const requestedId = new URLSearchParams(window.location.search).get('doc');
    const initialDocument = requestedId && state.documents.some((entry) => entry.id === requestedId)
      ? requestedId
      : state.documents[0]?.id;

    if (!initialDocument) {
      throw new Error('Нет доступных документов.');
    }

    await loadAndRenderDocument(initialDocument, {
      preserveSelection: Boolean(requestedSelection && requestedSelection.documentId === initialDocument),
    });

    const requestedHash = window.location.hash ? window.location.hash.slice(1) : '';
    if (requestedHash && !requestedSelection) {
      document.getElementById(requestedHash)?.scrollIntoView({ behavior: 'auto', block: 'start' });
    }
  } catch (error) {
    showReaderError(error instanceof Error ? error.message : String(error));
    hideLoading();
  }
}

init();
