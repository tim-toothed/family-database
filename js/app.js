import { FIELD_LABELS, SECTION_ORDER } from './config.js';
import { collectDocumentSnippetTokens } from './document-links.js';
import {
  addDraftArrayItem,
  addOtherInfoEntry,
  buildPersonOptionEntries,
  createDraftFromSchema,
  hydrateDraftForEditor,
  loadEditorDescriptions,
  loadEditorSchema,
  removeDraftArrayItem,
  removeOtherInfoEntry,
  renderEditablePersonDetails,
  renderEditablePersonSection,
  setAliveState,
  setDivorcedState,
  syncNameChangeDateField,
  updateDraftValue,
  validateEditorPersonDraft,
} from './editor/person-editor.js';
import { loadEditablePerson, saveEditablePerson } from './editor/supabase-editor-store.js';
import { personHasField } from './person/model.js';
import { loadDataset } from './render/data-loader.js';
import { getDatasetPersonName } from './render/person-name.js';
import { bindPersonLinks, buildPersonDetailsView } from './render/renderers.js';
import { renderPeopleTable, setPeopleTableSelection, TABLE_SORTS } from './visualization/table-view.js';
import { buildGraph, createNetwork, GRAPH_VISUALIZATIONS, getGraphVisualizationLabel } from './visualization/graph.js';

const loadingState = document.getElementById('loadingState');
const graphContainer = document.getElementById('graph');
const graphView = document.getElementById('graphView');
const tableView = document.getElementById('tableView');
const peopleTable = document.getElementById('peopleTable');
const graphTabButton = document.getElementById('graphTabButton');
const tableTabButton = document.getElementById('tableTabButton');
const detailsEmpty = document.getElementById('detailsEmpty');
const detailsContent = document.getElementById('detailsContent');
const personTitle = document.getElementById('personTitle');
const personSubtitle = document.getElementById('personSubtitle');
const personBody = document.getElementById('personBody');
const rootPersonSelect = document.getElementById('rootPersonSelect');
const buildTreeButton = document.getElementById('buildTreeButton');
const modeHint = document.getElementById('modeHint');
const graphLayoutMenu = document.getElementById('graphLayoutMenu');
const graphLayoutTrigger = document.getElementById('graphLayoutTrigger');
const graphLayoutList = document.getElementById('graphLayoutList');

const LINK_MASK_URL_RE = /(https?:\/\/[^\s<>"']+|doc:\/\/[^\s<>"']+)/giu;

let dataset;
let schema;
let descriptions = {};
let personOptionEntries = [];
let optionValueToId = new Map();
let network;
let selectedPersonId = null;
let currentRootId = null;
let currentView = 'graph';
let currentGraphVisualization = 'tree';
let needsGraphRender = false;
let currentTableSort = TABLE_SORTS.ALPHABET_ASC;
let currentTableGroupByFamily = true;
let graphLayoutHintDismissed = false;
let pendingGraphFocusRequest = null;

let inlineDraft = null;
let activeInlineSectionKey = '';
let inlineOriginalSectionSnapshot = '';
let inlineStatusMessage = '';
let inlineStatusTone = 'info';
let inlineLoadingSectionKey = '';
let inlineSavingSectionKey = '';
let inlineEditRequestToken = 0;

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function isVirtualNode(personId) {
  return !personId || personId.startsWith('junction:') || personId.startsWith('unknown:');
}

function isVisibleInGraph(personId) {
  if (!network || isVirtualNode(personId)) return false;
  return Boolean(network.body?.data?.nodes?.get(personId));
}

function hideLoading() {
  loadingState.style.display = 'none';
}

function showError(message) {
  loadingState.style.display = 'grid';
  loadingState.innerHTML = `<div class="error-box">${message}</div>`;
}

function syncTableSelection() {
  setPeopleTableSelection(peopleTable, selectedPersonId);
}

function refreshNetworkLayout() {
  if (!network || currentView !== 'graph') return;

  network.redraw();
  network.fit({ animation: false });

  const targetId = isVisibleInGraph(selectedPersonId) ? selectedPersonId : currentRootId;
  if (isVisibleInGraph(targetId)) {
    network.selectNodes([targetId]);
  }
}

function updateModeHint() {
  if (currentView !== 'graph' || currentGraphVisualization === 'panorama') {
    modeHint.hidden = true;
    return;
  }

  modeHint.hidden = false;
  const name = getDatasetPersonName(dataset, currentRootId, currentRootId);
  const visualizationLabel = getGraphVisualizationLabel(currentGraphVisualization);
  modeHint.textContent = `${visualizationLabel} от ${name}`;
}

function refreshInlineEditorLookups() {
  const { entries, optionValueToId: lookup } = buildPersonOptionEntries(dataset);
  personOptionEntries = entries;
  optionValueToId = lookup;
}

function resetInlineEditorState(options = {}) {
  activeInlineSectionKey = '';
  inlineDraft = null;
  inlineOriginalSectionSnapshot = '';
  inlineLoadingSectionKey = '';
  inlineSavingSectionKey = '';
  inlineEditRequestToken += 1;

  if (options.clearStatus !== false) {
    inlineStatusMessage = '';
    inlineStatusTone = 'info';
  }
}

function serializeInlineSectionSnapshot(sectionKey, personDraft = inlineDraft) {
  const hasOwnSection = Boolean(
    sectionKey
    && personDraft
    && Object.prototype.hasOwnProperty.call(personDraft, sectionKey)
  );

  return JSON.stringify(
    hasOwnSection
      ? { hasSection: true, value: personDraft[sectionKey] }
      : { hasSection: false }
  );
}

function hasInlineSectionUnsavedChanges() {
  if (!activeInlineSectionKey || !inlineDraft) return false;
  return serializeInlineSectionSnapshot(activeInlineSectionKey) !== inlineOriginalSectionSnapshot;
}

function canDiscardInlineSectionChanges() {
  if (!hasInlineSectionUnsavedChanges()) return true;
  return window.confirm('Есть несохраненные изменения. Если продолжить, они будут потеряны.');
}

function refreshInlineHeaderPreview() {
  if (!selectedPersonId || !inlineDraft || !schema) return;

  const preview = renderEditablePersonDetails(selectedPersonId, inlineDraft, schema, descriptions, {
    personOptionEntries,
    enumListIdPrefix: 'inlineEditorEnum',
  });
  if (!preview) return;

  personTitle.textContent = preview.title;
  personSubtitle.textContent = preview.subtitle;
}

function collectLinkMaskTokens(value) {
  const source = String(value || '');
  const tokens = collectDocumentSnippetTokens(source).map((token) => ({
    text: token.raw,
    start: token.start,
    end: token.end,
  }));
  let match;

  LINK_MASK_URL_RE.lastIndex = 0;
  while ((match = LINK_MASK_URL_RE.exec(source))) {
    let url = match[0];
    let end = match.index + url.length;

    while (url && /[),.;!?]$/.test(url)) {
      url = url.slice(0, -1);
      end -= 1;
    }

    if (!url) continue;
    tokens.push({
      text: url,
      start: match.index,
      end,
    });
  }

  return tokens.sort((left, right) => left.start - right.start || left.end - right.end);
}

function buildMaskedLinkHtml(value) {
  const source = String(value || '');
  const tokens = collectLinkMaskTokens(source);
  if (!tokens.length) return '';

  let cursor = 0;
  let html = '';

  for (const token of tokens) {
    if (token.start > cursor) {
      html += escapeHtml(source.slice(cursor, token.start));
    }

    html += `<span class="editor-link-token" data-link-start="${token.start}" data-link-end="${token.end}">[link]</span>`;
    cursor = token.end;
  }

  if (cursor < source.length) {
    html += escapeHtml(source.slice(cursor));
  }

  return html
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, '<br>');
}

function updateLinkMaskedField(shell) {
  const input = shell.querySelector('.editor-link-mask-target');
  const overlay = shell.querySelector('[data-link-mask-overlay]');
  if (!input || !overlay) return;

  const maskedHtml = buildMaskedLinkHtml(input.value);
  const hasLinks = Boolean(maskedHtml);
  const isEditing = document.activeElement === input && !input.disabled;

  shell.classList.toggle('has-links', hasLinks);
  shell.classList.toggle('is-editing', isEditing);
  shell.classList.toggle('is-masked', hasLinks && !isEditing);
  overlay.classList.toggle('hidden', !hasLinks || isEditing);
  overlay.innerHTML = hasLinks ? maskedHtml : '';
}

function focusMaskedLinkTarget(input, token) {
  if (input.disabled) return;
  input.focus();

  if (!token) return;
  const start = Number(token.dataset.linkStart);
  const end = Number(token.dataset.linkEnd);
  if (Number.isFinite(start) && Number.isFinite(end) && typeof input.setSelectionRange === 'function') {
    input.setSelectionRange(start, end);
  }
}

function initializeLinkMaskedFields(root) {
  root.querySelectorAll('[data-link-mask-shell]').forEach((shell) => {
    const input = shell.querySelector('.editor-link-mask-target');
    const overlay = shell.querySelector('[data-link-mask-overlay]');
    if (!input || !overlay) return;

    const refresh = () => updateLinkMaskedField(shell);

    input.addEventListener('focus', refresh);
    input.addEventListener('blur', () => {
      window.requestAnimationFrame(refresh);
    });
    input.addEventListener('input', refresh);
    input.addEventListener('change', refresh);

    overlay.addEventListener('mousedown', (event) => {
      event.preventDefault();
    });

    overlay.addEventListener('click', (event) => {
      const token = event.target.closest('.editor-link-token');
      focusMaskedLinkTarget(input, token);
    });

    refresh();
  });
}

function renderInlineStatus() {
  if (!inlineStatusMessage) return '';
  return `
    <div class="details-inline-status is-${escapeHtml(inlineStatusTone)}">
      ${escapeHtml(inlineStatusMessage)}
    </div>
  `;
}

function renderReadOnlySection(section, options = {}) {
  const isBusy = options.disabled ? ' disabled' : '';
  const isLoading = options.isLoading;

  return `
    <section class="field-block person-card-section${isLoading ? ' is-loading' : ''}" data-section-key="${escapeHtml(section.key)}">
      <button
        type="button"
        class="card-section-edit-button"
        data-action="edit-section"
        data-section-key="${escapeHtml(section.key)}"
        aria-label="Редактировать секцию ${escapeHtml(section.label)}"
        title="Редактировать секцию"
        ${isBusy}
      >✎</button>
      <h3 class="field-title">${escapeHtml(section.label)}</h3>
      <div class="field-value">${section.html}</div>
      ${isLoading ? '<div class="card-section-loading">Загрузка редактора...</div>' : ''}
    </section>
  `;
}

function renderLoadingSection(sectionKey, options = {}) {
  return renderReadOnlySection({
    key: sectionKey,
    label: FIELD_LABELS[sectionKey] || sectionKey,
    html: '<div class="card-section-loading-copy">Подготавливаю форму редактирования…</div>',
  }, {
    disabled: options.disabled,
    isLoading: true,
  });
}

function renderEditableSectionCard(sectionKey) {
  if (!inlineDraft || !schema) return '';

  const section = renderEditablePersonSection(sectionKey, inlineDraft, schema, descriptions, {
    personOptionEntries,
    enumListIdPrefix: 'inlineEditorEnum',
  });
  if (!section) return '';

  const isSaving = inlineSavingSectionKey === sectionKey;
  const dirtyLabel = hasInlineSectionUnsavedChanges()
    ? 'Есть несохранённые изменения'
    : 'Без несохранённых изменений';

  return `
    <section
      class="field-block is-editing person-card-section person-card-section-editing${section.isDisabled ? ' is-disabled' : ''}${section.isCollapsed ? ' is-collapsed' : ''}"
      data-section-key="${escapeHtml(sectionKey)}"
    >
      <div class="editor-section-head">
        <h3 class="field-title">${escapeHtml(section.label)}</h3>
        ${section.headerControlHtml}
      </div>
      ${section.description ? `<p class="editor-section-note">${escapeHtml(section.description)}</p>` : ''}
      ${section.isCollapsed ? '' : `
        <div class="field-value">
          ${section.bodyHtml}
        </div>
      `}
      <div class="card-section-actions">
        <div class="card-section-action-row">
          <button type="button" class="card-section-action card-section-action-primary" data-action="save-inline-section" ${isSaving ? 'disabled' : ''}>${isSaving ? 'Сохранение...' : 'Сохранить'}</button>
          <button type="button" class="card-section-action" data-action="cancel-inline-section" ${isSaving ? 'disabled' : ''}>Отмена</button>
          <button type="button" class="card-section-action card-section-action-danger" data-action="delete-inline-section" ${isSaving ? 'disabled' : ''}>Удалить секцию</button>
        </div>
        <div class="card-section-dirty${hasInlineSectionUnsavedChanges() ? ' is-dirty' : ''}">
          ${escapeHtml(dirtyLabel)}
        </div>
      </div>
    </section>
  `;
}

function renderAddSectionControls(savedPerson) {
  const isBusy = Boolean(inlineLoadingSectionKey || inlineSavingSectionKey);
  const addableSectionKeys = SECTION_ORDER.filter((key) => (
    !personHasField(savedPerson, key)
    && key !== activeInlineSectionKey
    && key !== inlineLoadingSectionKey
  ));

  if (!addableSectionKeys.length) {
    return '';
  }

  if (isBusy) {
    return '<button type="button" class="card-add-section-trigger" disabled>Добавить секцию</button>';
  }

  return `
    <details class="card-add-section-menu">
      <summary class="card-add-section-trigger">Добавить секцию</summary>
      <div class="card-add-section-list">
        ${addableSectionKeys.map((key) => `
          <button type="button" class="card-add-section-option" data-action="add-section" data-section-key="${escapeHtml(key)}">
            ${escapeHtml(FIELD_LABELS[key] || key)}
          </button>
        `).join('')}
      </div>
    </details>
  `;
}

function renderPersonCard(personId, view = null) {
  const person = dataset.people.get(personId);
  if (!person) return;

  const detailsView = view || buildPersonDetailsView(personId, dataset);
  if (!detailsView) return;

  const sectionByKey = new Map(detailsView.sections.map((section) => [section.key, section]));
  const sectionKeys = SECTION_ORDER.filter((key) => (
    sectionByKey.has(key)
    || key === activeInlineSectionKey
    || key === inlineLoadingSectionKey
  ));
  const disableSectionButtons = Boolean(inlineLoadingSectionKey || inlineSavingSectionKey);

  const sectionsHtml = sectionKeys.map((key) => {
    if (key === activeInlineSectionKey) {
      return renderEditableSectionCard(key);
    }
    if (key === inlineLoadingSectionKey) {
      return renderLoadingSection(key, { disabled: disableSectionButtons });
    }

    const section = sectionByKey.get(key);
    if (!section) return '';
    return renderReadOnlySection(section, { disabled: disableSectionButtons });
  }).join('');

  personBody.innerHTML = `
    <div class="person-card-sections">
      ${sectionsHtml}
    </div>
    ${renderInlineStatus()}
    ${renderAddSectionControls(person)}
  `;

  bindPersonLinks(personBody, (linkedId) => {
    const didShow = showPerson(linkedId);
    if (didShow && currentView === 'graph') {
      selectAndFocus(linkedId, 1.1);
    }
  });

  bindInlineCardEvents();
}

function showPerson(personId, options = {}) {
  if (!personId || isVirtualNode(personId)) return false;

  if (!options.force && personId !== selectedPersonId && !canDiscardInlineSectionChanges()) {
    return false;
  }

  const result = buildPersonDetailsView(personId, dataset);
  if (!result) return false;

  if (personId !== selectedPersonId || options.force) {
    resetInlineEditorState({
      clearStatus: options.keepStatus ? false : true,
    });
  }

  selectedPersonId = personId;
  detailsEmpty.classList.add('hidden');
  detailsContent.classList.remove('hidden');
  personTitle.textContent = result.title;
  personSubtitle.textContent = result.subtitle;
  renderPersonCard(personId, result);
  syncTableSelection();
  return true;
}

function selectAndFocus(personId, scale = 1.05) {
  if (!isVisibleInGraph(personId)) return;

  network.selectNodes([personId]);
  network.focus(personId, { scale, animation: true });
  selectedPersonId = personId;
  syncTableSelection();
}

function clearInlineErrorStatus() {
  if (inlineStatusTone !== 'error') return;
  inlineStatusMessage = '';
  inlineStatusTone = 'info';
}

function syncInlineDirtyIndicator() {
  const dirtyBadge = personBody.querySelector('.card-section-dirty');
  if (!dirtyBadge) return;

  const isDirty = hasInlineSectionUnsavedChanges();
  dirtyBadge.classList.toggle('is-dirty', isDirty);
  dirtyBadge.textContent = isDirty
    ? 'Есть несохранённые изменения'
    : 'Без несохранённых изменений';
}

function bindInlineCardEvents() {
  personBody.querySelectorAll('[data-action="edit-section"]').forEach((button) => {
    button.addEventListener('click', async () => {
      await startInlineSectionEdit(button.dataset.sectionKey);
    });
  });

  personBody.querySelectorAll('[data-action="add-section"]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.closest('.card-add-section-menu')?.removeAttribute('open');
      await startInlineSectionEdit(button.dataset.sectionKey, { addIfMissing: true });
    });
  });

  if (!activeInlineSectionKey || !inlineDraft) {
    return;
  }

  personBody.querySelectorAll('[data-path]').forEach((input) => {
    const syncDraftValue = () => {
      const pathString = String(input.dataset.path || '');

      if (pathString.endsWith('.reason') && pathString.includes('name_changes.')) {
        clearInlineErrorStatus();
        syncNameChangeDateField(inlineDraft, pathString, input.value);
        refreshInlineHeaderPreview();
        renderPersonCard(selectedPersonId);
        return;
      }

      updateDraftValue(inlineDraft, pathString, input.value);
      refreshInlineHeaderPreview();
      syncInlineDirtyIndicator();
    };

    input.addEventListener('input', syncDraftValue);
    input.addEventListener('change', syncDraftValue);
  });

  initializeLinkMaskedFields(personBody);

  personBody.querySelectorAll('[data-action="add-array-item"]').forEach((button) => {
    button.addEventListener('click', () => {
      clearInlineErrorStatus();
      addDraftArrayItem(inlineDraft, schema, button.dataset.arrayPath);
      refreshInlineHeaderPreview();
      renderPersonCard(selectedPersonId);
    });
  });

  personBody.querySelectorAll('[data-action="remove-array-item"]').forEach((button) => {
    button.addEventListener('click', () => {
      clearInlineErrorStatus();
      removeDraftArrayItem(inlineDraft, button.dataset.arrayPath, Number(button.dataset.index));
      refreshInlineHeaderPreview();
      renderPersonCard(selectedPersonId);
    });
  });

  personBody.querySelectorAll('[data-action="toggle-alive"]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      clearInlineErrorStatus();
      setAliveState(inlineDraft, checkbox.checked);
      refreshInlineHeaderPreview();
      renderPersonCard(selectedPersonId);
    });
  });

  personBody.querySelectorAll('[data-action="toggle-divorced"]').forEach((checkbox) => {
    checkbox.addEventListener('change', () => {
      clearInlineErrorStatus();
      setDivorcedState(inlineDraft, checkbox.dataset.divorcePath, checkbox.checked);
      refreshInlineHeaderPreview();
      renderPersonCard(selectedPersonId);
    });
  });

  personBody.querySelectorAll('[data-action="add-other-info-entry"]').forEach((button) => {
    button.addEventListener('click', () => {
      clearInlineErrorStatus();
      addOtherInfoEntry(inlineDraft, button.dataset.otherInfoPath);
      renderPersonCard(selectedPersonId);
    });
  });

  personBody.querySelectorAll('[data-action="remove-other-info-entry"]').forEach((button) => {
    button.addEventListener('click', () => {
      clearInlineErrorStatus();
      removeOtherInfoEntry(inlineDraft, button.dataset.otherInfoPath, button.dataset.otherInfoIndex);
      renderPersonCard(selectedPersonId);
    });
  });

  personBody.querySelector('[data-action="save-inline-section"]')?.addEventListener('click', async () => {
    await saveInlineSection();
  });

  personBody.querySelector('[data-action="cancel-inline-section"]')?.addEventListener('click', () => {
    cancelInlineSectionEdit();
  });

  personBody.querySelector('[data-action="delete-inline-section"]')?.addEventListener('click', async () => {
    await deleteInlineSection();
  });
}

async function startInlineSectionEdit(sectionKey, options = {}) {
  if (!selectedPersonId || !schema || !sectionKey) return false;
  if (activeInlineSectionKey === sectionKey && inlineDraft) return true;
  if (!canDiscardInlineSectionChanges()) return false;

  const targetPersonId = selectedPersonId;
  const requestToken = inlineEditRequestToken + 1;

  inlineStatusMessage = '';
  inlineStatusTone = 'info';
  inlineLoadingSectionKey = sectionKey;
  inlineSavingSectionKey = '';
  inlineEditRequestToken = requestToken;
  renderPersonCard(targetPersonId);

  let sourcePerson = dataset.people.get(targetPersonId);

  try {
    const freshPerson = await loadEditablePerson(targetPersonId);
    if (freshPerson) {
      sourcePerson = freshPerson;
    }
  } catch (error) {
    console.warn('Не удалось загрузить свежую версию карточки для inline-редактора.', error);
    inlineStatusMessage = 'Не удалось получить свежие данные из Supabase. Использую текущую версию карточки.';
    inlineStatusTone = 'info';
  }

  if (selectedPersonId !== targetPersonId || inlineEditRequestToken !== requestToken) {
    return false;
  }

  inlineDraft = hydrateDraftForEditor(sourcePerson, schema, dataset.indexById);

  if (options.addIfMissing && !Object.prototype.hasOwnProperty.call(inlineDraft, sectionKey)) {
    inlineDraft[sectionKey] = createDraftFromSchema({ [sectionKey]: schema[sectionKey] })[sectionKey];
  }

  activeInlineSectionKey = sectionKey;
  inlineOriginalSectionSnapshot = serializeInlineSectionSnapshot(sectionKey, inlineDraft);
  inlineLoadingSectionKey = '';
  refreshInlineHeaderPreview();
  renderPersonCard(targetPersonId);

  const firstInput = personBody.querySelector(`[data-section-key="${sectionKey}"] .editor-input`);
  firstInput?.focus();
  return true;
}

function cancelInlineSectionEdit() {
  if (!canDiscardInlineSectionChanges()) return false;

  resetInlineEditorState();
  showPerson(selectedPersonId, { force: true });
  return true;
}

async function deleteInlineSection() {
  if (!activeInlineSectionKey || !inlineDraft || inlineSavingSectionKey) return;

  const sectionLabel = FIELD_LABELS[activeInlineSectionKey] || activeInlineSectionKey;
  const shouldDelete = window.confirm(`Удалить секцию "${sectionLabel}" из карточки?`);
  if (!shouldDelete) return;

  delete inlineDraft[activeInlineSectionKey];
  refreshInlineHeaderPreview();
  await saveInlineSection();
}

async function reloadDatasetAfterSave(personId) {
  dataset = await loadDataset();
  refreshInlineEditorLookups();
  populateRootSuggestions();
  renderGraphLayoutMenu();

  if (!dataset.people.has(currentRootId)) {
    currentRootId = dataset.people.has(personId)
      ? personId
      : dataset.people.keys().next().value;
  }

  if (currentView === 'graph' && dataset.people.has(personId)) {
    pendingGraphFocusRequest = {
      personId,
      scale: 1.05,
    };
  }

  scheduleGraphRender();
  if (currentView === 'table') {
    renderTable();
  }

  showPerson(dataset.people.has(personId) ? personId : currentRootId, {
    force: true,
    keepStatus: true,
  });

  if (rootPersonSelect) rootPersonSelect.value = '';
  updateBuildTreeButtonState();
}

async function saveInlineSection() {
  if (!inlineDraft || !schema || !selectedPersonId || !activeInlineSectionKey || inlineSavingSectionKey) return;

  const validation = validateEditorPersonDraft(inlineDraft, schema, {
    peopleById: dataset.indexById,
    optionValueToId,
    requireNonIdContent: false,
  });

  if (!validation.valid) {
    inlineStatusMessage = validation.errors[0] || 'Не удалось проверить карточку.';
    inlineStatusTone = 'error';
    renderPersonCard(selectedPersonId);
    return;
  }

  const nextPersonId = String(validation.normalized.id || '').trim();
  if (!nextPersonId || nextPersonId !== selectedPersonId) {
    inlineStatusMessage = 'Изменение ID существующей карточки во встроенном редакторе пока не поддерживается.';
    inlineStatusTone = 'error';
    renderPersonCard(selectedPersonId);
    return;
  }

  inlineSavingSectionKey = activeInlineSectionKey;
  inlineStatusMessage = '';
  inlineStatusTone = 'info';
  renderPersonCard(selectedPersonId);

  try {
    const saveResult = await saveEditablePerson(selectedPersonId, validation.normalized);
    const synchronizedIds = Array.isArray(saveResult?.synchronizedIds) ? saveResult.synchronizedIds : [];
    const skippedIds = Array.isArray(saveResult?.skippedIds) ? saveResult.skippedIds : [];
    const syncMessage = synchronizedIds.length
      ? ` Синхронизированы карточки: ${synchronizedIds.join(', ')}.`
      : '';
    const skippedMessage = skippedIds.length
      ? ` Не удалось обновить карточки: ${skippedIds.join(', ')}.`
      : '';

    inlineStatusMessage = `Изменения сохранены в Supabase.${syncMessage}${skippedMessage}`;
    inlineStatusTone = 'valid';
    resetInlineEditorState({ clearStatus: false });
    await reloadDatasetAfterSave(selectedPersonId);
  } catch (error) {
    console.error(error);
    inlineSavingSectionKey = '';
    inlineStatusMessage = `Не удалось сохранить карточку: ${error.message}`;
    inlineStatusTone = 'error';
    renderPersonCard(selectedPersonId);
  }
}

function populateRootSuggestions() {
  if (!rootPersonSelect) return;

  const entries = Array.from(dataset.indexById.entries());
  const valid = [];
  const invalid = [];

  for (const [id, name] of entries) {
    if (!name || name.includes('???')) {
      invalid.push([id, name || '']);
    } else {
      valid.push([id, name]);
    }
  }

  const sortedValid = valid.sort((a, b) => a[1].localeCompare(b[1], 'ru'));
  const sortedInvalid = invalid.sort((a, b) => (a[1] || '').localeCompare(b[1] || '', 'ru'));

  rootPersonSelect.innerHTML = [
    '<option value="">От кого строить дерево...</option>',
    ...[...sortedValid, ...sortedInvalid].map(([id, name]) => `<option value="${id}">${name || id}</option>`),
  ].join('');
}

function updateBuildTreeButtonState() {
  if (!buildTreeButton) return;
  buildTreeButton.disabled = !rootPersonSelect?.value;
}

function renderTable() {
  renderPeopleTable(peopleTable, dataset, dataset.peopleTable, {
    groupByFamily: currentTableGroupByFamily,
    familyGroups: dataset.familyGroups,
    sortMode: currentTableSort,
    selectedPersonId,
    onGroupingChange(enabled) {
      currentTableGroupByFamily = Boolean(enabled);
      renderTable();
    },
    onSortChange(sortMode) {
      if (!sortMode || sortMode === currentTableSort) return;
      currentTableSort = sortMode;
      renderTable();
    },
    onSelect(personId) {
      showPerson(personId);
    },
  });
}

function renderGraph() {
  if (!dataset || currentView !== 'graph') {
    needsGraphRender = true;
    return;
  }

  try {
    const graphData = buildGraph(dataset, {
      rootId: currentRootId,
      visualization: currentGraphVisualization,
    });

    if (network) {
      network.destroy();
    }

    network = createNetwork(graphContainer, graphData, {
      onSelect(personId) {
        if (isVirtualNode(personId)) {
          selectedPersonId = null;
          syncTableSelection();
          return;
        }

        const previousPersonId = selectedPersonId;
        const didShow = showPerson(personId);
        if (!didShow && isVisibleInGraph(previousPersonId)) {
          network.selectNodes([previousPersonId]);
        }
        syncTableSelection();
      },
    });

    hideLoading();
    requestAnimationFrame(() => {
      const focusRequest = pendingGraphFocusRequest;
      pendingGraphFocusRequest = null;

      if (focusRequest?.personId && isVisibleInGraph(focusRequest.personId)) {
        selectedPersonId = focusRequest.personId;
        network.selectNodes([focusRequest.personId]);
        network.focus(focusRequest.personId, {
          scale: focusRequest.scale ?? 1.05,
          animation: false,
        });
        syncTableSelection();
        return;
      }

      network.fit({ animation: true });

      const targetId = isVisibleInGraph(selectedPersonId) ? selectedPersonId : currentRootId;
      if (isVisibleInGraph(targetId)) {
        selectedPersonId = targetId;
        network.selectNodes([targetId]);
        syncTableSelection();
      }
    });

    needsGraphRender = false;
    updateModeHint();
  } catch (error) {
    if (network) {
      network.destroy();
      network = null;
    }

    console.error(error);
    showError(`Graph error: ${error.message}`);
  }
}

function scheduleGraphRender() {
  if (currentView === 'graph') {
    renderGraph();
    return;
  }

  needsGraphRender = true;
}

function renderGraphLayoutMenu() {
  if (!graphLayoutList) return;

  graphLayoutList.innerHTML = GRAPH_VISUALIZATIONS
    .map((item) => `
      <button
        type="button"
        class="graph-layout-option${item.id === currentGraphVisualization ? ' is-active' : ''}"
        data-graph-layout="${item.id}"
      >
        ${item.label}
      </button>
    `)
    .join('');

  graphLayoutList.querySelectorAll('[data-graph-layout]').forEach((button) => {
    button.addEventListener('click', () => {
      const nextMode = button.dataset.graphLayout;
      if (!nextMode) return;

      currentGraphVisualization = nextMode;
      graphLayoutMenu?.removeAttribute('open');
      renderGraphLayoutTrigger();
      renderGraphLayoutMenu();
      scheduleGraphRender();
    });
  });
}

function updateGraphLayoutTriggerState() {
  if (!graphLayoutMenu || !graphLayoutTrigger) return;

  const shouldExpand = graphLayoutMenu.open || !graphLayoutHintDismissed;
  graphLayoutMenu.classList.toggle('is-expanded', shouldExpand);
  graphLayoutTrigger.setAttribute(
    'aria-label',
    shouldExpand ? 'Выбрать визуализацию' : 'Открыть меню визуализации'
  );
}

function dismissGraphLayoutHint() {
  if (graphLayoutHintDismissed) return;

  graphLayoutHintDismissed = true;
  updateGraphLayoutTriggerState();
}

function renderGraphLayoutTrigger() {
  if (!graphLayoutTrigger) return;

  const visualizationLabel = getGraphVisualizationLabel(currentGraphVisualization);
  graphLayoutTrigger.innerHTML = `
    <span class="graph-layout-trigger-icon" aria-hidden="true">
      <svg class="graph-layout-trigger-glyph" viewBox="0 0 24 24" focusable="false">
        <path class="graph-layout-trigger-link" d="M8.2 8.4h7.6M8.9 9.6l2.7 6M15.1 9.6l-2.7 6"></path>
        <circle cx="8" cy="8" r="2.1"></circle>
        <circle cx="16" cy="8" r="2.1"></circle>
        <circle cx="12" cy="16" r="2.1"></circle>
      </svg>
    </span>
    <span class="graph-layout-trigger-copy">
      <span class="graph-layout-trigger-label">Тип визуализации</span>
      <span class="graph-layout-trigger-value">${visualizationLabel}</span>
    </span>
  `;
}

function setupGraphLayoutTrigger() {
  if (!graphLayoutTrigger) return;

  graphLayoutTrigger.setAttribute('aria-label', 'Выбрать визуализацию');
  renderGraphLayoutTrigger();
  graphLayoutMenu?.addEventListener('toggle', updateGraphLayoutTriggerState);
  graphContainer?.addEventListener('pointerdown', dismissGraphLayoutHint, { passive: true });
  graphContainer?.addEventListener('wheel', dismissGraphLayoutHint, { passive: true });
  graphContainer?.addEventListener('touchstart', dismissGraphLayoutHint, { passive: true });

  updateGraphLayoutTriggerState();
}

function setMainView(rootId) {
  if (!canDiscardInlineSectionChanges()) {
    if (rootPersonSelect) rootPersonSelect.value = '';
    updateBuildTreeButtonState();
    return false;
  }

  currentRootId = rootId;
  if (rootPersonSelect) rootPersonSelect.value = '';
  updateBuildTreeButtonState();
  scheduleGraphRender();
  showPerson(rootId, { force: true });
  return true;
}

function applyTabState(activeView) {
  const isGraph = activeView === 'graph';
  graphView.classList.toggle('hidden', !isGraph);
  tableView.classList.toggle('hidden', isGraph);
  graphTabButton.classList.toggle('is-active', isGraph);
  tableTabButton.classList.toggle('is-active', !isGraph);
  graphTabButton.setAttribute('aria-selected', String(isGraph));
  tableTabButton.setAttribute('aria-selected', String(!isGraph));
}

function setActiveView(view) {
  currentView = view;
  applyTabState(view);

  if (view === 'table') {
    renderTable();
    updateModeHint();
    return;
  }

  if (needsGraphRender || !network) {
    renderGraph();
  } else {
    updateModeHint();
    requestAnimationFrame(refreshNetworkLayout);
  }
}

function setupRootSelector() {
  const buildTree = () => {
    const personId = rootPersonSelect?.value || null;
    if (!personId) return;
    setMainView(personId);
  };

  buildTreeButton.addEventListener('click', buildTree);
  rootPersonSelect?.addEventListener('change', updateBuildTreeButtonState);
  updateBuildTreeButtonState();
}

function setupTabs() {
  graphTabButton.addEventListener('click', () => {
    if (currentView !== 'graph') {
      setActiveView('graph');
    }
  });

  tableTabButton.addEventListener('click', () => {
    if (currentView !== 'table') {
      setActiveView('table');
    }
  });
}

async function init() {
  try {
    setupGraphLayoutTrigger();

    const [loadedDataset, loadedSchema, loadedDescriptions] = await Promise.all([
      loadDataset(),
      loadEditorSchema(),
      loadEditorDescriptions(),
    ]);

    dataset = loadedDataset;
    schema = loadedSchema;
    descriptions = loadedDescriptions;
    refreshInlineEditorLookups();

    currentRootId = dataset.people.has('P049')
      ? 'P049'
      : dataset.people.keys().next().value;

    populateRootSuggestions();
    setupRootSelector();
    setupTabs();
    renderGraphLayoutMenu();

    applyTabState(currentView);
    renderGraph();
    showPerson(currentRootId, { force: true });
    if (rootPersonSelect) rootPersonSelect.value = '';
    updateBuildTreeButtonState();
    hideLoading();

    if (dataset.peopleTable?.warnings?.length) {
      console.warn('People table warnings:', dataset.peopleTable.warnings);
    }

    window.addEventListener('resize', refreshNetworkLayout);
    window.addEventListener('orientationchange', () => {
      setTimeout(refreshNetworkLayout, 150);
    });

    setTimeout(refreshNetworkLayout, 150);
  } catch (error) {
    console.error(error);
    showError(
      `Не удалось загрузить данные сайта. Проверьте Supabase или локальный приватный каталог данных.\n\n${error.message}`
    );
  }
}

init();
