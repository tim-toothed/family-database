import { ENTITY_BLOCK_SELECTOR, ENTITY_SKIP_SELECTOR, HEADING_SELECTOR } from './config.js';
import { resetDocumentViewState, state, elements, getDocumentRoot } from './context.js';
import { applyRequestedSelection, clearShareSelection } from './selection.js';
import { escapeHtml, normalizeForMatch, normalizeWhitespace } from './utils.js';

export function renderDocumentList() {
  elements.documentSelect.innerHTML = [
    '<option value="">Выберите документ...</option>',
    ...state.documents.map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.title)}</option>`),
  ].join('');

  elements.documentList.innerHTML = [
    `
      <button type="button" class="document-list-item document-upload-button" data-document-upload>
        <span class="documents-item-icon documents-item-icon-import" aria-hidden="true"></span>
        <span class="document-list-title">Загрузить документ</span>
      </button>
    `,
    ...state.documents.map((entry) => `
      <div class="document-list-row${entry.id === state.currentDocumentId ? ' is-active' : ''}">
        <button type="button" class="document-list-item" data-document-id="${escapeHtml(entry.id)}">
          <span class="documents-item-icon documents-item-icon-document" aria-hidden="true"></span>
          <span class="document-list-title">${escapeHtml(entry.title)}</span>
        </button>
        <button type="button" class="document-delete-button" data-document-delete="${escapeHtml(entry.id)}" aria-label="Удалить документ ${escapeHtml(entry.title)}" title="Удалить документ">
          <span class="documents-item-icon documents-item-icon-delete" aria-hidden="true"></span>
        </button>
      </div>
    `),
  ].join('');

  elements.documentSelect.value = state.currentDocumentId || '';
  elements.documentCountBadge.textContent = String(state.documents.length);
}

export function syncLocation(documentId, headingId = '', options = {}) {
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

  elements.outlineCountBadge.textContent = String(state.outline.length);
  elements.documentOutline.innerHTML = state.outline.length
    ? state.outline.map((entry) => `
      <button type="button" class="document-outline-item" data-heading-id="${escapeHtml(entry.id)}" style="--outline-level:${entry.level};">
        ${escapeHtml(entry.title)}
      </button>
    `).join('')
    : '<div class="documents-empty-state documents-empty-state-compact">В документе не найдено заголовков.</div>';
}

function renderOutline() {
  elements.outlineCountBadge.textContent = String(state.outline.length);
  elements.documentOutline.innerHTML = state.outline.length
    ? state.outline.map((entry) => `
      <button type="button" class="document-outline-item" data-heading-id="${escapeHtml(entry.id)}" style="--outline-level:${entry.level};">
        ${escapeHtml(entry.title)}
      </button>
    `).join('')
    : '<div class="documents-empty-state documents-empty-state-compact">В документе не найдено заголовков.</div>';
}

function appendOutlineFromNodes(nodes) {
  const headings = [];

  for (const node of nodes) {
    if (!(node instanceof Element)) continue;
    if (node.matches(HEADING_SELECTOR)) headings.push(node);
    headings.push(...node.querySelectorAll(HEADING_SELECTOR));
  }

  for (const heading of headings) {
    const id = `section-${state.outline.length + 1}`;
    heading.id = id;
    state.outline.push({
      id,
      level: Number(heading.tagName.slice(1)),
      title: normalizeWhitespace(heading.textContent) || `Раздел ${state.outline.length + 1}`,
    });
  }

  renderOutline();
}

function collectRenderableBlocks(root) {
  const elementsList = Array.from(root.querySelectorAll(ENTITY_BLOCK_SELECTOR))
    .filter((element) => normalizeWhitespace(element.textContent));

  return elementsList.filter((element) => !elementsList.some((other) => other !== element && element.contains(other)));
}

function collectRenderableBlocksFromNodes(nodes) {
  const elementsList = [];

  for (const node of nodes) {
    if (!(node instanceof Element)) continue;
    if (node.matches(ENTITY_BLOCK_SELECTOR) && normalizeWhitespace(node.textContent)) {
      elementsList.push(node);
    }
    elementsList.push(
      ...Array.from(node.querySelectorAll(ENTITY_BLOCK_SELECTOR))
        .filter((element) => normalizeWhitespace(element.textContent)),
    );
  }

  return elementsList.filter((element) => !elementsList.some((other) => other !== element && element.contains(other)));
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

function applyDetectedCandidatesToNodes(nodes, sourceBlocks) {
  if (!sourceBlocks?.length) {
    return;
  }

  const renderedBlocks = collectRenderableBlocksFromNodes(nodes);
  let renderedIndex = 0;

  for (const block of sourceBlocks) {
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

export function syncEntityToolState() {
  const toolPairs = [
    [elements.toggleNamesTool, 'name'],
    [elements.toggleKinshipTool, 'kinship'],
  ];
  const stats = getHighlightedEntityStats();
  const countsByKind = {
    name: stats.names,
    kinship: stats.kinship,
  };

  for (const [button, kind] of toolPairs) {
    if (!button) continue;
    const enabled = Boolean(state.enabledEntityKinds[kind]);
    const hasMentions = countsByKind[kind] > 0;
    const loading = state.toolLoadingKind === kind;
    button.classList.toggle('is-active', enabled && hasMentions);
    button.classList.toggle('has-mentions', hasMentions);
    button.classList.toggle('is-loading', loading);
    button.setAttribute('aria-pressed', String(enabled && hasMentions));
    button.disabled = Boolean(state.toolLoadingKind);
  }
}

export function applyEntityKindVisibility(root = getDocumentRoot()) {
  if (!root) {
    syncEntityToolState();
    return;
  }

  for (const element of root.querySelectorAll('.entity-candidate')) {
    const kind = element.dataset.entityKind;
    const enabled = Boolean(state.enabledEntityKinds[kind]);
    element.classList.toggle('is-disabled-kind', !enabled);
  }
  syncEntityToolState();
}

export function showDocumentToolError(message) {
  if (!elements.documentToolError) return;
  elements.documentToolError.textContent = message;
  elements.documentToolError.classList.remove('hidden');
}

export function hideDocumentToolError() {
  if (!elements.documentToolError) return;
  elements.documentToolError.textContent = '';
  elements.documentToolError.classList.add('hidden');
}

function updateDocumentMeta() {
  const stats = getHighlightedEntityStats();
  const currentDocument = state.documents.find((entry) => entry.id === state.currentDocumentId);
  const sourceLabel = state.currentDocumentLoadSource === 'supabase'
    ? 'Supabase'
    : state.currentDocumentLoadSource === 'yandex'
      ? 'Yandex DB'
    : state.currentDocumentLoadSource === 'local'
      ? 'GitHub'
      : '';
  const entityLabel = stats.total
    ? `${stats.total} NLP-подсветок`
    : 'без NLP-подсветок';
  const progressLabel = state.currentDocumentProgress?.isStreaming
    ? `${state.currentDocumentProgress.loadedBlocks}/${state.currentDocumentProgress.totalBlocks || '?'} блоков`
    : '';

  elements.documentMeta.textContent = [
    sourceLabel,
    currentDocument?.type === 'markdown' ? 'Markdown' : 'DOCX',
    state.outline.length ? `${state.outline.length} заголовков` : 'без заголовков',
    entityLabel,
    progressLabel,
  ].filter(Boolean).join(' · ');
}

export function renderDocumentView() {
  if (!state.currentDocumentHtml) return;

  elements.documentReader.innerHTML = `<div class="document-prose">${state.currentDocumentHtml}</div>`;
  const root = getDocumentRoot();
  clearShareSelection();

  buildOutline(root);
  applyDetectedCandidates(root);
  applyEntityKindVisibility(root);
  applyRequestedSelection(root);
  updateDocumentMeta();
}

export function initializeStreamingDocumentView() {
  state.outline = [];
  state.highlightedEntities = [];
  elements.documentReader.innerHTML = '<div class="document-prose"></div>';
  clearShareSelection();
  renderOutline();
  updateDocumentMeta();
}

export function appendStreamingDocumentChunk(chunk) {
  const root = getDocumentRoot();
  if (!root) return;

  const template = document.createElement('template');
  template.innerHTML = chunk.html;
  const appendedNodes = Array.from(template.content.childNodes);
  root.append(...appendedNodes);

  appendOutlineFromNodes(appendedNodes);
  applyDetectedCandidatesToNodes(appendedNodes, chunk.entityBlocks);
  applyEntityKindVisibility(root);
  applyRequestedSelection(root);
  updateDocumentMeta();
}

export function refreshDocumentMeta() {
  updateDocumentMeta();
}

export function showReaderError(message) {
  elements.documentReader.innerHTML = `<div class="error-box">${escapeHtml(message)}</div>`;
  elements.documentOutline.innerHTML = '<div class="documents-empty-state documents-empty-state-compact">Оглавление недоступно.</div>';
  elements.outlineCountBadge.textContent = '0';
  elements.documentMeta.textContent = 'Ошибка чтения документа';
  elements.documentTitle.textContent = 'Документ не удалось открыть';
  elements.documentSourceLink.classList.add('hidden');
  elements.documentSourceLink.removeAttribute('href');
  resetDocumentViewState();
  state.outline = [];
  clearShareSelection();
}

export function updateDocumentSourceLink(documentEntry, loadSource) {
  if (!elements.documentSourceLink) return;

  const canLinkToLocalSource = loadSource === 'local' && documentEntry?.path;
  if (!canLinkToLocalSource) {
    elements.documentSourceLink.classList.add('hidden');
    elements.documentSourceLink.removeAttribute('href');
    return;
  }

  elements.documentSourceLink.href = documentEntry.path;
  elements.documentSourceLink.classList.remove('hidden');
}
