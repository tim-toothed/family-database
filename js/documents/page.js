import { requireAuth } from '../auth.js';
import {
  clearDocumentManifestCache,
  clearDocumentPayloadCache,
  cacheDocumentPayload,
  getCachedDocumentPayload,
} from './cache.js';
import { getRequestedDataSource } from './config.js';
import { importYandexDocumentFile } from '../db/yandex/document-import.js';
import { runYandexDocumentNer } from '../db/yandex/document-tools.js';
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
import { deleteRemoteDocument } from '../db/documents-store.js';
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
  applyEntityKindVisibility,
  hideDocumentToolError,
  initializeStreamingDocumentView,
  renderDocumentList,
  renderDocumentView,
  refreshDocumentMeta,
  showReaderError,
  showDocumentToolError,
  syncEntityToolState,
  syncLocation,
  updateDocumentSourceLink,
} from './render.js';

const SUPPORTED_UPLOAD_EXTENSIONS = new Set(['md', 'markdown', 'docx', 'pdf', 'txt']);

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

async function deleteDocument(documentId) {
  const documentEntry = state.documents.find((entry) => entry.id === documentId);
  if (!documentEntry) throw new Error('Документ не найден.');

  const confirmed = window.confirm(`Удалить документ "${documentEntry.title}" из базы?`);
  if (!confirmed) return;

  const source = getRequestedDataSource();
  if (source !== 'yandex') {
    throw new Error('Удаление документов сейчас подключено только для Yandex DB.');
  }

  showLoading('Удаление документа...');
  try {
    const deletedIndex = state.documents.findIndex((entry) => entry.id === documentId);
    await deleteRemoteDocument(source, documentId);
    clearDocumentManifestCache('yandex');
    state.documents = await loadDocumentManifest().catch(() => []);

    const nextDocument = state.documents[Math.min(deletedIndex, state.documents.length - 1)] || null;
    if (nextDocument) {
      await loadAndRenderDocument(nextDocument.id);
      return;
    }

    state.currentDocumentId = null;
    resetDocumentViewState();
    renderDocumentList();
    syncLocation('', '');
    elements.documentTitle.textContent = 'Документы отсутствуют';
    elements.documentMeta.textContent = 'Нет доступных документов';
    elements.documentSourceLink.classList.add('hidden');
    elements.documentReader.innerHTML = '<div class="documents-empty-state">Загрузите первый документ.</div>';
    elements.documentOutline.innerHTML = '<div class="documents-empty-state documents-empty-state-compact">Оглавление недоступно.</div>';
    elements.outlineCountBadge.textContent = '0';
  } finally {
    hideLoading();
  }
}

function toggleEntityKind(kind) {
  state.enabledEntityKinds[kind] = !state.enabledEntityKinds[kind];
  applyEntityKindVisibility();
}

async function runDocumentNerForKind(kind) {
  const documentEntry = state.documents.find((entry) => entry.id === state.currentDocumentId);
  if (!documentEntry) {
    showDocumentToolError('Документ не выбран.');
    return;
  }

  if (getRequestedDataSource() !== 'yandex') {
    showDocumentToolError('NLP-инструменты сейчас подключены только для Yandex DB.');
    return;
  }

  hideDocumentToolError();
  state.toolLoadingKind = kind;
  syncEntityToolState();

  try {
    const includeNames = kind === 'name' || state.enabledEntityKinds.name;
    const includeKinship = kind === 'kinship' || state.enabledEntityKinds.kinship;
    const previousScrollTop = elements.documentReaderShell?.scrollTop || 0;

    await runYandexDocumentNer(documentEntry.id, { includeNames, includeKinship });
    window.getSelection()?.removeAllRanges();
    clearShareSelection();
    clearDocumentManifestCache('yandex');
    clearDocumentPayloadCache(documentEntry);
    state.documents = await loadDocumentManifest();
    renderDocumentList();
    await loadAndRenderDocument(documentEntry.id);
    if (elements.documentReaderShell) {
      elements.documentReaderShell.scrollTop = previousScrollTop;
    }
    state.enabledEntityKinds[kind] = true;
    applyEntityKindVisibility();
  } catch (error) {
    showDocumentToolError(error instanceof Error ? error.message : String(error));
  } finally {
    state.toolLoadingKind = '';
    syncEntityToolState();
  }
}

function bindEvents() {
  syncEntityToolState();

  elements.documentSelect?.addEventListener('change', (event) => {
    if (event.target.value) {
      loadAndRenderDocument(event.target.value);
    }
  });

  elements.toggleNamesTool?.addEventListener('click', () => {
    const hasMentions = Boolean(state.highlightedEntities.some((entity) => entity.kind === 'name'));
    if (hasMentions) {
      toggleEntityKind('name');
      return;
    }
    runDocumentNerForKind('name');
  });

  elements.toggleKinshipTool?.addEventListener('click', () => {
    const hasMentions = Boolean(state.highlightedEntities.some((entity) => entity.kind === 'kinship'));
    if (hasMentions) {
      toggleEntityKind('kinship');
      return;
    }
    runDocumentNerForKind('kinship');
  });

  elements.documentList?.addEventListener('click', (event) => {
    const uploadButton = event.target.closest('[data-document-upload]');
    if (uploadButton) {
      elements.documentUploadInput?.click();
      return;
    }

    const deleteButton = event.target.closest('[data-document-delete]');
    if (deleteButton) {
      deleteDocument(deleteButton.dataset.documentDelete).catch((error) => {
        showReaderError(error instanceof Error ? error.message : String(error));
      });
      return;
    }

    const button = event.target.closest('[data-document-id]');
    if (button) {
      loadAndRenderDocument(button.dataset.documentId);
    }
  });

  elements.documentUploadInput?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const extension = String(file.name.split('.').pop() || '').toLowerCase();
    if (!SUPPORTED_UPLOAD_EXTENSIONS.has(extension)) {
      showReaderError('Поддерживаются только документы .md, .markdown, .docx, .pdf и .txt.');
      event.target.value = '';
      return;
    }

    try {
      resetDocumentViewState();
      elements.documentTitle.textContent = file.name;
      elements.documentMeta.textContent = 'Импорт документа';
      elements.documentSourceLink.classList.add('hidden');
      elements.documentReader.innerHTML = '<div class="documents-empty-state">Загружаю документ в базу...</div>';
      elements.documentOutline.innerHTML = '<div class="documents-empty-state documents-empty-state-compact">Оглавление появится после импорта.</div>';
      elements.outlineCountBadge.textContent = '0';
      showLoading('Импорт документа...');

      const source = getRequestedDataSource();
      if (source !== 'yandex') {
        throw new Error('Импорт документов сейчас подключен только для Yandex DB.');
      }

      const importedDocument = await importYandexDocumentFile(file);
      if (!importedDocument?.id) {
        throw new Error('Импорт завершился без id документа.');
      }

      clearDocumentManifestCache('yandex');
      state.documents = await loadDocumentManifest();
      renderDocumentList();
      await loadAndRenderDocument(importedDocument.id);
    } catch (error) {
      showReaderError(error instanceof Error ? error.message : String(error));
    } finally {
      hideLoading();
      event.target.value = '';
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
