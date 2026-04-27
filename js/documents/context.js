export const state = {
  documents: [],
  currentDocumentId: null,
  currentLoadToken: 0,
  currentDocumentHtml: '',
  currentDocumentEntityData: null,
  currentDocumentLoadSource: null,
  currentDocumentProgress: null,
  outline: [],
  highlightedEntities: [],
  shareSelection: null,
  requestedSelectionApplied: false,
};

export const elements = {
  documentSelect: document.getElementById('documentSelect'),
  documentCountBadge: document.getElementById('documentCountBadge'),
  outlineCountBadge: document.getElementById('outlineCountBadge'),
  documentList: document.getElementById('documentList'),
  documentUploadInput: document.getElementById('documentUploadInput'),
  documentOutline: document.getElementById('documentOutline'),
  documentLoadingState: document.getElementById('documentLoadingState'),
  documentMeta: document.getElementById('documentMeta'),
  documentTitle: document.getElementById('documentTitle'),
  documentSourceLink: document.getElementById('documentSourceLink'),
  documentReader: document.getElementById('documentReader'),
  documentReaderShell: document.querySelector('.document-reader-shell'),
  selectionLinkBubble: document.getElementById('selectionLinkBubble'),
};

export function getDocumentRoot() {
  return elements.documentReader?.querySelector('.document-prose') || null;
}

export function beginDocumentLoad(documentId) {
  state.currentDocumentId = documentId;
  state.currentDocumentEntityData = null;
  state.currentDocumentLoadSource = null;
  state.currentDocumentProgress = null;
  state.requestedSelectionApplied = false;
  state.currentLoadToken += 1;
  return state.currentLoadToken;
}

export function isActiveDocumentLoad(loadToken) {
  return loadToken === state.currentLoadToken;
}

export function applyDocumentPayload(payload) {
  state.currentDocumentHtml = payload.html;
  state.currentDocumentEntityData = payload.entityData;
  state.currentDocumentLoadSource = payload.loadSource;
  state.currentDocumentProgress = null;
}

export function resetDocumentViewState() {
  state.currentDocumentHtml = '';
  state.currentDocumentEntityData = null;
  state.currentDocumentLoadSource = null;
  state.currentDocumentProgress = null;
  state.highlightedEntities = [];
  state.requestedSelectionApplied = false;
}

export function initializeStreamingDocument(loadSource, documentId, generatedAt = '') {
  state.currentDocumentHtml = '';
  state.currentDocumentLoadSource = loadSource;
  state.currentDocumentEntityData = {
    documentId,
    extractor: null,
    generatedAt,
    blocks: [],
  };
  state.currentDocumentProgress = {
    isStreaming: true,
    loadedBlocks: 0,
    totalBlocks: 0,
  };
}

export function appendStreamingDocumentChunk(chunk) {
  state.currentDocumentHtml += chunk.html;
  state.currentDocumentEntityData?.blocks?.push(...chunk.entityBlocks);
  if (state.currentDocumentProgress) {
    state.currentDocumentProgress.loadedBlocks = chunk.loadedBlocks;
    state.currentDocumentProgress.totalBlocks = chunk.totalBlocks;
  }
}

export function finishStreamingDocument() {
  if (state.currentDocumentProgress) {
    state.currentDocumentProgress.isStreaming = false;
  }
}
