import { HEADING_SELECTOR, LINKABLE_TEXT_SKIP_SELECTOR, SELECTION_QUOTE_LIMIT } from './config.js';
import { state, elements, getDocumentRoot } from './context.js';
import { buildDocumentSnippet } from './deeplinks.js';
import { normalizeWhitespace } from '../utils/normalize.js';

let selectionLinkBubbleStateTimer = 0;

function setSelectionLinkBubbleCopiedState(isCopied) {
  if (!elements.selectionLinkBubble) return;
  elements.selectionLinkBubble.classList.toggle('is-copied', Boolean(isCopied));

  if (selectionLinkBubbleStateTimer) {
    window.clearTimeout(selectionLinkBubbleStateTimer);
    selectionLinkBubbleStateTimer = 0;
  }

  if (isCopied) {
    selectionLinkBubbleStateTimer = window.setTimeout(() => {
      elements.selectionLinkBubble.classList.remove('is-copied');
      selectionLinkBubbleStateTimer = 0;
    }, 1200);
  }
}

function setShareSelection(selection) {
  state.shareSelection = selection;
}

export function hideSelectionLinkBubble() {
  if (!elements.selectionLinkBubble) return;
  elements.selectionLinkBubble.classList.remove('is-copied');
  elements.selectionLinkBubble.classList.add('hidden');
}

function showSelectionLinkBubble() {
  if (!elements.selectionLinkBubble) return;
  elements.selectionLinkBubble.classList.remove('hidden');
}

export function clearShareSelection() {
  setShareSelection(null);
  hideSelectionLinkBubble();
}

function positionSelectionLinkBubble(range) {
  if (!elements.selectionLinkBubble) return;

  const rects = Array.from(range.getClientRects()).filter((item) => item.width || item.height);
  const rect = rects[0] || range.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) {
    hideSelectionLinkBubble();
    return;
  }

  showSelectionLinkBubble();
  elements.selectionLinkBubble.style.left = '0px';
  elements.selectionLinkBubble.style.top = '0px';

  const bubbleRect = elements.selectionLinkBubble.getBoundingClientRect();
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

  elements.selectionLinkBubble.style.left = `${Math.round(left)}px`;
  elements.selectionLinkBubble.style.top = `${Math.round(top)}px`;
}

export function refreshSelectionLinkBubblePosition() {
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

export function scheduleSelectionRefresh() {
  window.requestAnimationFrame(() => {
    updateShareSelectionFromDom();
  });
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

export function readRequestedTextSelection() {
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

export function applyRequestedSelection(root) {
  if (state.requestedSelectionApplied) {
    return true;
  }

  const selectionTarget = readRequestedTextSelection();
  if (!selectionTarget || selectionTarget.documentId !== state.currentDocumentId) {
    return false;
  }

  const resolved = resolveRequestedSelectionOffsets(root, selectionTarget);
  if (!resolved || resolved.end <= resolved.start) {
    return false;
  }

  const wrappers = markTextRangeByOffsets(root, resolved.start, resolved.end, {
    className: 'document-shared-selection',
    title: 'Ссылка на фрагмент документа',
    skipSelector: LINKABLE_TEXT_SKIP_SELECTOR,
  });
  if (!wrappers.length) return false;

  state.requestedSelectionApplied = true;
  wrappers[0].scrollIntoView({ behavior: 'auto', block: 'center' });
  return true;
}

export function updateShareSelectionFromDom() {
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

export async function copySelectionLinkSilently() {
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
  const snippet = buildSelectionLinkUrl();
  if (!snippet) return;

  try {
    await copyTextToClipboard(snippet);
  } catch (error) {
    console.warn('Не удалось скопировать ссылку на выделение.', error);
  }
}
