const MANIFEST_PATH = './data/misc/index.json';
const STORAGE_KEY = 'family-document-annotations-v1';
const HEADING_SELECTOR = 'h1, h2, h3, h4, h5, h6';
const ANNOTATION_SKIP_SELECTOR = 'script, style, textarea, select, option, .annotation-mark';
const CANDIDATE_SKIP_SELECTOR = 'script, style, textarea, select, option, .annotation-mark, .entity-candidate';
const ENTITY_BLOCK_SELECTOR = 'h1, h2, h3, h4, h5, h6, p, li, td, th, blockquote';
const NAME_TOKEN_PATTERN = '[А-ЯЁ][а-яё]+(?:-[А-ЯЁ][а-яё]+)?';
const NAME_REGEX = new RegExp(`${NAME_TOKEN_PATTERN}(?:\\s+${NAME_TOKEN_PATTERN}){0,2}`, 'gu');
const KINSHIP_MODIFIER_PATTERN = '(?:старш(?:ий|ая|ее|ие|его|ему|им|ей|ую|их|ими)|младш(?:ий|ая|ее|ие|его|ему|им|ей|ую|их|ими)|родн(?:ой|ая|ое|ые|ого|ому|ым|ой|ую|ых|ыми)|двоюродн(?:ый|ая|ое|ые|ого|ому|ым|ой|ую|ых|ыми)|сводн(?:ый|ая|ое|ые|ого|ому|ым|ой|ую|ых|ыми)|приемн(?:ый|ая|ое|ые|ого|ому|ым|ой|ую|ых|ыми)|приёмн(?:ый|ая|ое|ые|ого|ому|ым|ой|ую|ых|ыми)|мой|моя|моё|мои|наш|наша|наше|наши|его|ее|её|их)\\s+';
const KINSHIP_BASES = [
  'дед(?:ушка)?',
  'бабушк[аеиоуы]',
  'брат(?:а|у|ом|е|ы|ьев|ьям|ьями|ьях)?',
  'сестр(?:а|ы|е|у|ой|ою|ами|ах)?',
  'мам(?:а|ы|е|у|ой|ою)?',
  'пап(?:а|ы|е|у|ой|ою)?',
  'мат(?:ь|ери|ерью|ерям|ерями|ерях)?',
  'от(?:е[цц]|ца|цу|цом|це)',
  'сын(?:а|у|ом|е|овья|овей|овьям|овьями|овьях)?',
  'доч(?:ь|ери|ерью|ерям|ерями|ерях)?',
  'жена',
  'женой',
  'муж',
  'мужа',
  'мужем',
  'супруг(?:а|е|у|ой|ом|и)?',
  'невестк(?:а|и|е|у|ой|ою|ами|ах)?',
  'свекров(?:ь|и|ью|ям|ями|ях)?',
  'св[её]кор(?:а|у|ом|е|ы|ов|ам|ами|ах)?',
  'т[её]щ(?:а|и|е|у|ой|ою|ами|ах)?',
  'тест(?:ь|я|ю|ем|е|и|ям|ями|ях)?',
  'дяд(?:я|и|е|ю|ей|ями|ях)?',
  'т[её]т(?:я|и|е|ю|ей|ями|ях)?',
  'отчим(?:а|у|ом|е|ы|ов|ам|ами|ах)?',
  'мачех(?:а|и|е|у|ой|ою|ами|ах)?',
  'внук(?:а|у|ом|е|и|ов|ам|ами|ах)?',
  'внучк(?:а|и|е|у|ой|ою|ами|ах)?',
  'племянник(?:а|у|ом|е|и|ов|ам|ами|ах)?',
  'племянниц(?:а|ы|е|у|ей|ами|ах)?',
  'родственник(?:а|у|ом|е|и|ов|ам|ами|ах)?',
  'родственниц(?:а|ы|е|у|ей|ами|ах)?',
];
const KINSHIP_REGEX = new RegExp(`(?:${KINSHIP_MODIFIER_PATTERN}){0,2}(?:${KINSHIP_BASES.join('|')})`, 'giu');
const NAME_CONTEXT_REGEX = new RegExp(`(?:${KINSHIP_MODIFIER_PATTERN}){0,2}(?:${KINSHIP_BASES.join('|')})\\s+$`, 'iu');
const NAME_HINT_REGEX = /\b(?:звали|назвали|по имени|имя|прозвали)\s+$/iu;
const SINGLE_TOKEN_NAME_EXCLUSIONS = new Set([
  'август',
  'апрель',
  'будто',
  'было',
  'весна',
  'воскресенье',
  'вторник',
  'декабрь',
  'затем',
  'зима',
  'июль',
  'июнь',
  'кажется',
  'когда',
  'лето',
  'май',
  'март',
  'может',
  'ноябрь',
  'октябрь',
  'осень',
  'позже',
  'пока',
  'помню',
  'понедельник',
  'потом',
  'почему',
  'пятница',
  'разве',
  'сегодня',
  'сентябрь',
  'сейчас',
  'скорее',
  'следом',
  'среда',
  'суббота',
  'тогда',
  'теперь',
  'утром',
  'февраль',
  'четверг',
  'январь',
]);

const state = {
  documents: [],
  currentDocumentId: null,
  currentLoadToken: 0,
  currentDocumentHtml: '',
  currentDocumentEntityData: null,
  outline: [],
  selection: null,
  currentFilterQuery: '',
  annotationGroups: [],
  activeGroupKey: null,
  activeMentions: [],
  currentMentionIndex: -1,
  detectedCandidates: [],
};

const documentSelect = document.getElementById('documentSelect');
const documentSearchInput = document.getElementById('documentSearchInput');
const searchPrevButton = document.getElementById('searchPrevButton');
const searchNextButton = document.getElementById('searchNextButton');
const documentCountBadge = document.getElementById('documentCountBadge');
const outlineCountBadge = document.getElementById('outlineCountBadge');
const documentList = document.getElementById('documentList');
const documentOutline = document.getElementById('documentOutline');
const documentLoadingState = document.getElementById('documentLoadingState');
const documentMeta = document.getElementById('documentMeta');
const documentTitle = document.getElementById('documentTitle');
const documentSourceLink = document.getElementById('documentSourceLink');
const searchStatus = document.getElementById('searchStatus');
const documentReader = document.getElementById('documentReader');
const annotationCountBadge = document.getElementById('annotationCountBadge');
const annotationSummary = document.getElementById('annotationSummary');
const selectionPreview = document.getElementById('selectionPreview');
const annotationForm = document.getElementById('annotationForm');
const annotationTypeInput = document.getElementById('annotationTypeInput');
const annotationLabelInput = document.getElementById('annotationLabelInput');
const annotationPersonIdInput = document.getElementById('annotationPersonIdInput');
const annotationNoteInput = document.getElementById('annotationNoteInput');
const clearSelectionButton = document.getElementById('clearSelectionButton');
const annotationFormStatus = document.getElementById('annotationFormStatus');
const activeAnnotationCard = document.getElementById('activeAnnotationCard');
const activeAnnotationTitle = document.getElementById('activeAnnotationTitle');
const activeAnnotationMeta = document.getElementById('activeAnnotationMeta');
const activeAnnotationDetails = document.getElementById('activeAnnotationDetails');
const clearActiveAnnotationButton = document.getElementById('clearActiveAnnotationButton');
const deleteAnnotationGroupButton = document.getElementById('deleteAnnotationGroupButton');
const annotationEmpty = document.getElementById('annotationEmpty');
const annotationList = document.getElementById('annotationList');

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

function setFormStatus(message, tone = 'neutral') {
  annotationFormStatus.textContent = message;
  annotationFormStatus.dataset.tone = tone;
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
    entitiesPath: String(entry?.entities_path || `./data/misc/entities/${String(entry?.id || `document-${index + 1}`).trim()}.json`).trim(),
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

function readAnnotationStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeAnnotationStore(store) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}

function getAnnotationsForDocument(documentId) {
  const store = readAnnotationStore();
  const annotations = store[documentId];
  return Array.isArray(annotations) ? annotations : [];
}

function saveAnnotationsForDocument(documentId, annotations) {
  const store = readAnnotationStore();
  store[documentId] = annotations;
  writeAnnotationStore(store);
}

function createAnnotationId() {
  return `A${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function createGroupKey(annotation) {
  const personId = normalizeWhitespace(annotation.personId).toUpperCase();
  if (personId) {
    return `person:${personId}`;
  }

  return `${annotation.type}:${normalizeForMatch(annotation.label)}`;
}

function getGroupTitle(group) {
  if (group.personId && group.label) {
    return `${group.label} (${group.personId})`;
  }

  return group.label || group.personId || 'Без подписи';
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

function getPointTextOffset(root, container, offset) {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(container, offset);
  return range.toString().length;
}

function getElementTextOffsets(root, element) {
  const beforeRange = document.createRange();
  beforeRange.selectNodeContents(root);
  beforeRange.setEndBefore(element);
  const start = beforeRange.toString().length;

  const afterRange = document.createRange();
  afterRange.selectNodeContents(root);
  afterRange.setEndAfter(element);
  const end = afterRange.toString().length;

  return { start, end };
}

function isWordLikeCharacter(character) {
  return /[\p{L}\p{N}]/u.test(character);
}

function hasEntityBoundary(text, start, end) {
  const before = text[start - 1] || '';
  const after = text[end] || '';
  return !(before && isWordLikeCharacter(before)) && !(after && isWordLikeCharacter(after));
}

function isPatronymicToken(token) {
  return /(вич|вна|ична|оглы|кызы)$/iu.test(String(token || ''));
}

function isSurnameLikeToken(token) {
  return /(ов|ова|ев|ева|ёв|ёва|ин|ина|ын|ына|ский|ская|цкий|цкая|ко|енко|ук|юк|ич|вили|дзе|ян|янц|улин|улина)$/iu.test(String(token || ''));
}

function isExcludedSingleTokenCandidate(token) {
  return SINGLE_TOKEN_NAME_EXCLUSIONS.has(normalizeForMatch(token));
}

function hasNameContextHint(text, start) {
  const context = text.slice(Math.max(0, start - 48), start);
  return NAME_CONTEXT_REGEX.test(context) || NAME_HINT_REGEX.test(context);
}

function isLikelyNameCandidate(candidate, text = '', start = 0) {
  const tokens = normalizeWhitespace(candidate).split(/\s+/).filter(Boolean);
  if (!tokens.length || tokens.length > 3) {
    return false;
  }

  if (tokens.length === 1) {
    const [token] = tokens;
    if (token.length < 3 || isExcludedSingleTokenCandidate(token)) {
      return false;
    }

    return isPatronymicToken(token) || isSurnameLikeToken(token) || hasNameContextHint(text, start);
  }

  const patronymicCount = tokens.filter(isPatronymicToken).length;
  const surnameCount = tokens.filter(isSurnameLikeToken).length;

  if (tokens.length === 3) {
    return patronymicCount >= 1 || surnameCount >= 1;
  }

  return patronymicCount >= 1 || surnameCount >= 1;
}

function addCandidateMatch(matches, candidate) {
  matches.push(candidate);
}

function collectCandidateMatches(text) {
  const matches = [];

  KINSHIP_REGEX.lastIndex = 0;
  for (const match of text.matchAll(KINSHIP_REGEX)) {
    const value = normalizeWhitespace(match[0]);
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (!value || !hasEntityBoundary(text, start, end)) continue;
    addCandidateMatch(matches, {
      start,
      end,
      text: text.slice(start, end),
      kind: 'kinship',
    });
  }

  NAME_REGEX.lastIndex = 0;
  for (const match of text.matchAll(NAME_REGEX)) {
    const value = normalizeWhitespace(match[0]);
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (!value || !hasEntityBoundary(text, start, end) || !isLikelyNameCandidate(value, text, start)) continue;
    addCandidateMatch(matches, {
      start,
      end,
      text: text.slice(start, end),
      kind: 'name',
    });
  }

  matches.sort((left, right) => {
    if (left.start !== right.start) return left.start - right.start;
    return (right.end - right.start) - (left.end - left.start);
  });

  const accepted = [];
  let currentEnd = -1;
  for (const match of matches) {
    if (match.start < currentEnd) continue;
    accepted.push(match);
    currentEnd = match.end;
  }

  return accepted;
}

function clearSelectionState(clearForm = false) {
  state.selection = null;
  selectionPreview.textContent = 'Сначала выделите в тексте имя, родственное описание или другой фрагмент.';
  selectionPreview.classList.add('is-empty');

  if (clearForm) {
    annotationLabelInput.value = '';
    annotationPersonIdInput.value = '';
    annotationNoteInput.value = '';
    annotationTypeInput.value = 'person';
  }
}

function setSelectionState(selection) {
  state.selection = selection;
  selectionPreview.textContent = selection.preview;
  selectionPreview.classList.remove('is-empty');

  if (!normalizeWhitespace(annotationLabelInput.value)) {
    const fallback = selection.preview.length > 72
      ? `${selection.preview.slice(0, 69).trim()}...`
      : selection.preview;
    annotationLabelInput.value = fallback;
  }
}

function captureSelectionFromDom() {
  const root = getDocumentRoot();
  const selection = window.getSelection();

  if (!root || !selection || selection.rangeCount === 0 || selection.isCollapsed) {
    clearSelectionState(false);
    return;
  }

  const range = selection.getRangeAt(0);
  const ancestor = range.commonAncestorContainer;
  const ancestorElement = ancestor.nodeType === Node.ELEMENT_NODE ? ancestor : ancestor.parentElement;

  if (!root.contains(ancestor) || ancestorElement?.closest(ANNOTATION_SKIP_SELECTOR)) {
    clearSelectionState(false);
    return;
  }

  const preview = normalizeWhitespace(selection.toString());
  if (!preview) {
    clearSelectionState(false);
    return;
  }

  const start = getPointTextOffset(root, range.startContainer, range.startOffset);
  const end = getPointTextOffset(root, range.endContainer, range.endOffset);

  if (end <= start) {
    clearSelectionState(false);
    return;
  }

  setSelectionState({
    start,
    end,
    quote: selection.toString(),
    preview,
  });
}

function overlapsExistingAnnotation(start, end, annotations) {
  return annotations.some((annotation) => start < annotation.end && end > annotation.start);
}

function wrapCandidateInTextNode(node, candidate) {
  const startNode = node.splitText(candidate.start);
  const tailNode = startNode.splitText(candidate.end - candidate.start);
  const wrapper = document.createElement('span');
  wrapper.className = `entity-candidate entity-kind-${candidate.kind}`;
  wrapper.dataset.entityKind = candidate.kind;
  wrapper.dataset.entityText = normalizeWhitespace(startNode.nodeValue);
  wrapper.title = candidate.kind === 'kinship' ? 'Родственное описание' : 'Возможное имя';

  startNode.parentNode?.insertBefore(wrapper, startNode);
  wrapper.append(startNode);

  return { wrapper, tailNode };
}

function findTextPosition(root, targetOffset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
      if (node.parentElement?.closest('script, style')) return NodeFilter.FILTER_REJECT;
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

function groupAnnotationsWithElements(annotations, root) {
  const groupsByKey = new Map();
  const elements = Array.from(root.querySelectorAll('.annotation-mark'));

  for (const annotation of annotations) {
    const key = createGroupKey(annotation);

    if (!groupsByKey.has(key)) {
      groupsByKey.set(key, {
        key,
        type: annotation.type,
        label: annotation.label,
        personId: normalizeWhitespace(annotation.personId).toUpperCase(),
        note: annotation.note,
        annotations: [],
        elements: [],
      });
    }

    groupsByKey.get(key).annotations.push(annotation);
  }

  for (const element of elements) {
    const key = element.dataset.groupKey;
    if (!groupsByKey.has(key)) continue;
    groupsByKey.get(key).elements.push(element);
  }

  return [...groupsByKey.values()].sort((left, right) => {
    if (right.annotations.length !== left.annotations.length) {
      return right.annotations.length - left.annotations.length;
    }

    return getGroupTitle(left).localeCompare(getGroupTitle(right), 'ru');
  });
}

function applyAnnotations(root) {
  const annotations = getAnnotationsForDocument(state.currentDocumentId)
    .slice()
    .sort((left, right) => right.start - left.start || right.end - left.end);

  for (const annotation of annotations) {
    const start = findTextPosition(root, annotation.start);
    const end = findTextPosition(root, annotation.end);

    if (!start || !end || start.node === end.node && start.offset === end.offset) {
      continue;
    }

    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);

    const wrapper = document.createElement('mark');
    wrapper.className = `annotation-mark annotation-type-${annotation.type}`;
    wrapper.dataset.annotationId = annotation.id;
    wrapper.dataset.groupKey = createGroupKey(annotation);
    wrapper.dataset.type = annotation.type;
    wrapper.dataset.label = annotation.label;
    wrapper.dataset.personId = normalizeWhitespace(annotation.personId).toUpperCase();
    wrapper.title = [annotation.label, annotation.personId].filter(Boolean).join(' · ');

    const extracted = range.extractContents();
    wrapper.append(extracted);
    range.insertNode(wrapper);
  }

  state.annotationGroups = groupAnnotationsWithElements(getAnnotationsForDocument(state.currentDocumentId), root);
  if (state.activeGroupKey && !state.annotationGroups.some((group) => group.key === state.activeGroupKey)) {
    state.activeGroupKey = null;
  }
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
      if (node.parentElement?.closest(CANDIDATE_SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
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
      const suffix = blockText.slice(candidateStart + entity.text.length, candidateStart + entity.text.length + entity.suffix.length);
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
    .sort((left, right) => right.start - left.start || right.end - left.end);

  for (const entity of sorted) {
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
      : 'Возможное имя из NLP-извлечения';

    const extracted = range.extractContents();
    wrapper.append(extracted);
    range.insertNode(wrapper);

    state.detectedCandidates.push({
      kind: entity.kind,
      text: normalizeWhitespace(wrapper.textContent),
      source: entity.source,
      element: wrapper,
    });
  }
}

function applyDetectedCandidates(root) {
  state.detectedCandidates = [];

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

function getDetectedCandidateStats() {
  const stats = {
    total: state.detectedCandidates.length,
    names: 0,
    kinship: 0,
  };

  for (const candidate of state.detectedCandidates) {
    if (candidate.kind === 'kinship') {
      stats.kinship += 1;
    } else if (candidate.kind === 'name') {
      stats.names += 1;
    }
  }

  return stats;
}

function selectCandidateElement(element) {
  const root = getDocumentRoot();
  if (!root) return;

  const preview = normalizeWhitespace(element.textContent);
  const { start, end } = getElementTextOffsets(root, element);
  if (!preview || end <= start) return;

  annotationTypeInput.value = element.dataset.entityKind === 'kinship' ? 'relation' : 'name';
  setSelectionState({
    start,
    end,
    quote: element.textContent || preview,
    preview,
  });
  setFormStatus('Автоподсветка выбрана. Можно сразу сохранить пометку или изменить поля справа.', 'neutral');
  window.getSelection()?.removeAllRanges();
}

function getFilteredGroups() {
  const query = normalizeForMatch(state.currentFilterQuery);
  if (!query) return state.annotationGroups;

  return state.annotationGroups.filter((group) => {
    const haystack = [
      group.label,
      group.personId,
      group.type,
      group.note,
      ...group.annotations.map((annotation) => annotation.quote),
    ].map(normalizeForMatch).join(' ');

    return haystack.includes(query);
  });
}

function renderAnnotationSidebar() {
  const filteredGroups = getFilteredGroups();
  const totalMentions = state.annotationGroups.reduce((sum, group) => sum + group.annotations.length, 0);
  const candidateStats = getDetectedCandidateStats();

  annotationCountBadge.textContent = String(state.annotationGroups.length);

  if (!state.annotationGroups.length) {
    annotationSummary.textContent = candidateStats.total
      ? `Автоподсвечено ${candidateStats.total} entity из NLP: ${candidateStats.names} имен и ${candidateStats.kinship} родственных описаний.`
      : 'В этом документе пока нет сохраненных пометок.';
    annotationEmpty.textContent = candidateStats.total
      ? 'Сохраненных пометок пока нет. Можно кликнуть по автоподсветке в тексте и превратить ее в свою пометку.'
      : 'В этом документе пока нет сохраненных пометок.';
    annotationEmpty.classList.remove('hidden');
    annotationList.classList.add('hidden');
    annotationList.innerHTML = '';
    activeAnnotationCard.classList.add('hidden');
    return;
  }

  annotationSummary.textContent = state.currentFilterQuery
    ? `Показано ${filteredGroups.length} групп по текущему фильтру.`
    : `Сохранено ${state.annotationGroups.length} групп и ${totalMentions} выделений.`;

  annotationEmpty.textContent = state.currentFilterQuery
    ? 'По текущему фильтру пометки не найдены.'
    : 'В этом документе пока нет сохраненных пометок.';
  annotationEmpty.classList.toggle('hidden', filteredGroups.length > 0);
  annotationList.classList.toggle('hidden', filteredGroups.length === 0);

  annotationList.innerHTML = filteredGroups.map((group) => `
    <button type="button" class="document-entity-item${group.key === state.activeGroupKey ? ' is-active' : ''}" data-group-key="${escapeHtml(group.key)}">
      <span class="document-entity-item-title">${escapeHtml(getGroupTitle(group))}</span>
      <span class="document-entity-item-meta">${escapeHtml(group.type)} · ${group.annotations.length} выдел.</span>
      <span class="document-entity-item-variants">${escapeHtml(group.note || group.annotations[0]?.quote || '')}</span>
    </button>
  `).join('');

  const activeGroup = state.activeGroupKey
    ? state.annotationGroups.find((group) => group.key === state.activeGroupKey)
    : null;

  activeAnnotationCard.classList.toggle('hidden', !activeGroup);
  if (!activeGroup) return;

  activeAnnotationTitle.textContent = getGroupTitle(activeGroup);
  activeAnnotationMeta.textContent = `${activeGroup.type} · ${activeGroup.annotations.length} выделений`;
  activeAnnotationDetails.textContent = [
    activeGroup.personId ? `ID: ${activeGroup.personId}` : '',
    activeGroup.note || '',
  ].filter(Boolean).join(' · ');
}

function updateSearchUi() {
  const candidateStats = getDetectedCandidateStats();

  if (state.activeGroupKey && state.activeMentions.length) {
    const activeGroup = state.annotationGroups.find((group) => group.key === state.activeGroupKey);
    searchStatus.textContent = `${getGroupTitle(activeGroup)}: ${state.currentMentionIndex + 1} из ${state.activeMentions.length}`;
  } else if (state.currentFilterQuery) {
    searchStatus.textContent = `${getFilteredGroups().length} групп по фильтру`;
  } else if (state.annotationGroups.length) {
    searchStatus.textContent = `${state.annotationGroups.length} групп пометок`;
  } else if (candidateStats.total) {
    searchStatus.textContent = `${candidateStats.total} автоподсвеченных entity`;
  } else {
    searchStatus.textContent = 'Пометки не созданы';
  }

  const canNavigate = state.activeMentions.length > 0;
  searchPrevButton.disabled = !canNavigate;
  searchNextButton.disabled = !canNavigate;
}

function clearAnnotationClasses() {
  for (const group of state.annotationGroups) {
    for (const element of group.elements) {
      element.classList.remove('is-active', 'is-current', 'is-dimmed');
    }
  }
}

function focusMention(index, scroll = true) {
  if (!state.activeMentions.length) {
    state.currentMentionIndex = -1;
    updateSearchUi();
    return;
  }

  const normalizedIndex = ((index % state.activeMentions.length) + state.activeMentions.length) % state.activeMentions.length;
  state.currentMentionIndex = normalizedIndex;

  for (const element of state.activeMentions) {
    element.classList.remove('is-current');
  }

  const current = state.activeMentions[normalizedIndex];
  current.classList.add('is-current');

  if (scroll) {
    current.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  updateSearchUi();
}

function updateAnnotationFocus(options = {}) {
  clearAnnotationClasses();

  const filteredGroups = getFilteredGroups();
  const filteredKeys = new Set(filteredGroups.map((group) => group.key));
  const activeGroup = state.activeGroupKey
    ? state.annotationGroups.find((group) => group.key === state.activeGroupKey)
    : null;

  if (activeGroup) {
    for (const group of state.annotationGroups) {
      const isActive = group.key === activeGroup.key;
      for (const element of group.elements) {
        element.classList.toggle('is-active', isActive);
        element.classList.toggle('is-dimmed', !isActive);
      }
    }

    state.activeMentions = activeGroup.elements;
    if (options.targetElement) {
      state.currentMentionIndex = Math.max(0, state.activeMentions.indexOf(options.targetElement));
    } else if (state.currentMentionIndex < 0 || state.currentMentionIndex >= state.activeMentions.length) {
      state.currentMentionIndex = 0;
    }

    renderAnnotationSidebar();
    focusMention(state.currentMentionIndex, options.scroll !== false);
    return;
  }

  state.activeMentions = [];
  state.currentMentionIndex = -1;

  if (state.currentFilterQuery) {
    for (const group of state.annotationGroups) {
      const isVisible = filteredKeys.has(group.key);
      for (const element of group.elements) {
        element.classList.toggle('is-active', isVisible);
        element.classList.toggle('is-dimmed', !isVisible);
      }
    }
  }

  renderAnnotationSidebar();
  updateSearchUi();
}

function renderDocumentView() {
  if (!state.currentDocumentHtml) return;

  documentReader.innerHTML = `<div class="document-prose">${state.currentDocumentHtml}</div>`;
  const root = getDocumentRoot();

  buildOutline(root);
  applyAnnotations(root);
  applyDetectedCandidates(root);

  const totalMentions = state.annotationGroups.reduce((sum, group) => sum + group.annotations.length, 0);
  const candidateStats = getDetectedCandidateStats();
  const currentDocument = state.documents.find((entry) => entry.id === state.currentDocumentId);
  documentMeta.textContent = [
    currentDocument?.type === 'markdown' ? 'Markdown' : 'DOCX',
    state.outline.length ? `${state.outline.length} заголовков` : 'без заголовков',
    candidateStats.total ? `${candidateStats.total} NLP-entity` : 'без автоentity',
    state.annotationGroups.length ? `${state.annotationGroups.length} групп` : 'без пометок',
    totalMentions ? `${totalMentions} выделений` : '',
  ].filter(Boolean).join(' · ');

  updateAnnotationFocus({ scroll: false });
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

  return {
    documentId: String(payload.document_id || documentEntry.id),
    extractor: payload.extractor || null,
    generatedAt: payload.generated_at || '',
    blocks: payload.blocks
      .filter((block) => Array.isArray(block?.entities) && block.entities.length)
      .map((block, index) => ({
        index: Number.isFinite(block.index) ? Number(block.index) : index,
        kind: String(block.kind || 'paragraph'),
        text: String(block.text || ''),
        entities: block.entities.map((entity, entityIndex) => ({
          id: String(entity.id || `E${index + 1}-${entityIndex + 1}`),
          kind: entity.kind === 'kinship' ? 'kinship' : 'name',
          text: String(entity.text || ''),
          start: Number(entity.start || 0),
          end: Number(entity.end || 0),
          prefix: String(entity.prefix || ''),
          suffix: String(entity.suffix || ''),
          source: String(entity.source || ''),
          confidence: String(entity.confidence || ''),
        })).filter((entity) => entity.text && entity.end > entity.start),
      })),
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
  state.detectedCandidates = [];
  state.annotationGroups = [];
  state.activeGroupKey = null;
  clearSelectionState(true);
  renderAnnotationSidebar();
  updateSearchUi();
}

async function loadAndRenderDocument(documentId) {
  const documentEntry = state.documents.find((entry) => entry.id === documentId);
  if (!documentEntry) throw new Error('Document not found.');

  state.currentDocumentId = documentEntry.id;
  state.activeGroupKey = null;
  state.currentDocumentEntityData = null;
  clearSelectionState(true);
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
    setFormStatus('Пометки сохраняются локально в браузере для текущего документа.', 'neutral');
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

function toggleActiveGroup(groupKey, options = {}) {
  state.activeGroupKey = state.activeGroupKey === groupKey && options.toggle ? null : groupKey;
  updateAnnotationFocus(options);
}

function saveAnnotation(event) {
  event.preventDefault();

  if (!state.currentDocumentId || !state.selection) {
    setFormStatus('Сначала выделите текст в документе.', 'error');
    return;
  }

  const annotations = getAnnotationsForDocument(state.currentDocumentId);
  if (overlapsExistingAnnotation(state.selection.start, state.selection.end, annotations)) {
    setFormStatus('Новая пометка пересекается с уже существующей. Пока пересечения не поддерживаются.', 'error');
    return;
  }

  const label = normalizeWhitespace(annotationLabelInput.value) || state.selection.preview;
  const annotation = {
    id: createAnnotationId(),
    type: annotationTypeInput.value,
    label,
    personId: normalizeWhitespace(annotationPersonIdInput.value).toUpperCase(),
    note: normalizeWhitespace(annotationNoteInput.value),
    quote: state.selection.preview,
    start: state.selection.start,
    end: state.selection.end,
    createdAt: new Date().toISOString(),
  };

  saveAnnotationsForDocument(state.currentDocumentId, [...annotations, annotation]);
  state.activeGroupKey = createGroupKey(annotation);
  clearSelectionState(true);
  renderDocumentView();
  setFormStatus('Пометка сохранена.', 'success');
  window.getSelection()?.removeAllRanges();
}

function deleteActiveGroup() {
  if (!state.currentDocumentId || !state.activeGroupKey) return;

  const remaining = getAnnotationsForDocument(state.currentDocumentId)
    .filter((annotation) => createGroupKey(annotation) !== state.activeGroupKey);

  saveAnnotationsForDocument(state.currentDocumentId, remaining);
  state.activeGroupKey = null;
  renderDocumentView();
  setFormStatus('Группа пометок удалена.', 'success');
}

document.addEventListener('selectionchange', () => {
  captureSelectionFromDom();
});

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

documentReader?.addEventListener('click', (event) => {
  const mark = event.target.closest('.annotation-mark');
  if (mark) {
    toggleActiveGroup(mark.dataset.groupKey, {
      targetElement: mark,
      toggle: true,
    });
    return;
  }

  const candidate = event.target.closest('.entity-candidate');
  if (candidate) {
    selectCandidateElement(candidate);
  }
});

annotationForm?.addEventListener('submit', saveAnnotation);

clearSelectionButton?.addEventListener('click', () => {
  clearSelectionState(true);
  window.getSelection()?.removeAllRanges();
  setFormStatus('Выделение сброшено.', 'neutral');
});

documentSearchInput?.addEventListener('input', (event) => {
  state.currentFilterQuery = event.target.value;
  if (state.activeGroupKey && !getFilteredGroups().some((group) => group.key === state.activeGroupKey)) {
    state.activeGroupKey = null;
  }
  updateAnnotationFocus({ scroll: false });
});

annotationList?.addEventListener('click', (event) => {
  const button = event.target.closest('[data-group-key]');
  if (!button) return;

  toggleActiveGroup(button.dataset.groupKey, { toggle: true });
});

clearActiveAnnotationButton?.addEventListener('click', () => {
  state.activeGroupKey = null;
  updateAnnotationFocus({ scroll: false });
});

deleteAnnotationGroupButton?.addEventListener('click', deleteActiveGroup);

searchPrevButton?.addEventListener('click', () => {
  focusMention(state.currentMentionIndex - 1);
});

searchNextButton?.addEventListener('click', () => {
  focusMention(state.currentMentionIndex + 1);
});

documentSearchInput?.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && state.activeMentions.length) {
    event.preventDefault();
    focusMention(state.currentMentionIndex + (event.shiftKey ? -1 : 1));
  }
});

async function init() {
  try {
    state.documents = await loadDocumentManifest();
    renderDocumentList();
    renderAnnotationSidebar();
    updateSearchUi();

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

clearSelectionState(true);
renderAnnotationSidebar();
updateSearchUi();
init();
