import { requireAuth } from '../auth.js';
import { cacheDocumentPayload, getCachedDocumentPayload } from './cache.js';
import { getRequestedDataSource } from './config.js';
import {
  applyDocumentPayload,
  appendStreamingDocumentChunk as appendStreamingStateChunk,
  beginDocumentLoad,
  elements,
  getDocumentRoot,
  initializeStreamingDocument,
  isActiveDocumentLoad,
  finishStreamingDocument,
  resetDocumentViewState,
  state,
} from './context.js';
import { loadDocumentManifest, loadDocumentPayload, loadRemoteDocumentChunk } from './data.js';
import {
  copySelectionLinkSilently,
  hideSelectionLinkBubble,
  readRequestedTextSelection,
  refreshSelectionLinkBubblePosition,
  scheduleSelectionRefresh,
  updateShareSelectionFromDom,
  clearShareSelection,
} from './selection.js';
import {
  appendStreamingDocumentChunk,
  initializeStreamingDocumentView,
  renderDocumentList,
  renderDocumentView,
  refreshDocumentMeta,
  showReaderError,
  syncLocation,
  updateDocumentSourceLink,
} from './render.js';

function showLoading(message) {
  elements.documentLoadingState.textContent = message;
  elements.documentLoadingState.classList.remove('hidden');
}

function hideLoading() {
  elements.documentLoadingState.classList.add('hidden');
}

function shouldStreamRemoteDocument(documentEntry) {
  const source = getRequestedDataSource();
  return (
    (source === 'supabase' || source === 'yandex')
    && documentEntry.storage === source
    && !getCachedDocumentPayload(documentEntry)
  );
}

async function streamRemoteDocument(documentEntry, loadToken, options = {}) {
  const source = getRequestedDataSource();
  initializeStreamingDocument(source, documentEntry.id, documentEntry.generatedAt || '');
  initializeStreamingDocumentView();
  updateDocumentSourceLink(documentEntry, source);
  syncLocation(documentEntry.id, '', { preserveSelection: options.preserveSelection });

  let from = 0;
  let firstChunkRendered = false;

  while (isActiveDocumentLoad(loadToken)) {
    const chunk = await loadRemoteDocumentChunk(documentEntry, { from });
    if (!chunk) {
      if (!firstChunkRendered) {
        throw new Error(`В ${source} не найдены блоки документа ${documentEntry.id}.`);
      }
      break;
    }

    appendStreamingStateChunk(chunk);
    appendStreamingDocumentChunk(chunk);
    from = chunk.loadedBlocks;

    if (!firstChunkRendered) {
      hideLoading();
      firstChunkRendered = true;
    }

    if (chunk.done) {
      break;
    }

    await new Promise((resolve) => {
      window.requestAnimationFrame(() => resolve());
    });
  }

  if (!isActiveDocumentLoad(loadToken)) return;

  finishStreamingDocument();
  refreshDocumentMeta();

  const payload = {
    html: state.currentDocumentHtml,
    entityData: state.currentDocumentEntityData,
    loadSource: source,
  };
  cacheDocumentPayload(documentEntry, payload);
}

async function loadAndRenderDocument(documentId, options = {}) {
  const documentEntry = state.documents.find((entry) => entry.id === documentId);
  if (!documentEntry) throw new Error('Документ не найден.');

  resetDocumentViewState();
  const loadToken = beginDocumentLoad(documentEntry.id);
  renderDocumentList();
  showLoading('Загрузка документа...');

  try {
    if (shouldStreamRemoteDocument(documentEntry)) {
      elements.documentTitle.textContent = documentEntry.title;
      await streamRemoteDocument(documentEntry, loadToken, options);
      return;
    }

    const payload = await loadDocumentPayload(documentEntry);
    if (!isActiveDocumentLoad(loadToken)) return;

    applyDocumentPayload(payload);
    elements.documentTitle.textContent = documentEntry.title;
    updateDocumentSourceLink(documentEntry, payload.loadSource);
    renderDocumentView();
    syncLocation(documentEntry.id, '', { preserveSelection: options.preserveSelection });
  } catch (error) {
    if (!isActiveDocumentLoad(loadToken)) return;
    showReaderError(error instanceof Error ? error.message : String(error));
  } finally {
    if (isActiveDocumentLoad(loadToken)) {
      hideLoading();
    }
  }
}

function bindEvents() {
  elements.documentSelect?.addEventListener('change', (event) => {
    if (event.target.value) {
      loadAndRenderDocument(event.target.value);
    }
  });

  elements.documentList?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-document-id]');
    if (button) {
      loadAndRenderDocument(button.dataset.documentId);
    }
  });

  elements.documentOutline?.addEventListener('click', (event) => {
    const button = event.target.closest('[data-heading-id]');
    const heading = button ? document.getElementById(button.dataset.headingId) : null;
    if (!heading) return;

    heading.scrollIntoView({ behavior: 'smooth', block: 'start' });
    syncLocation(state.currentDocumentId, button.dataset.headingId);
  });

  elements.selectionLinkBubble?.addEventListener('click', () => {
    copySelectionLinkSilently();
  });

  elements.selectionLinkBubble?.addEventListener('mousedown', (event) => {
    event.preventDefault();
  });

  document.addEventListener('selectionchange', () => {
    updateShareSelectionFromDom();
  });

  document.addEventListener('pointerdown', (event) => {
    if (elements.selectionLinkBubble?.contains(event.target)) {
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

  elements.documentReaderShell?.addEventListener('scroll', () => {
    refreshSelectionLinkBubblePosition();
  });
}

async function init() {
  bindEvents();

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
