import { requireAuth } from './auth.js';
import { loadEditorDescriptions, loadEditorSchema } from './editor/person-editor.js';
import { createInlinePersonEditorController } from './editor/inline-person-editor.js';
import { deleteEditablePerson } from './db/editor-store.js';
import { getRemoteDataSourceLabel } from './db/source.js';
import { getDatasetPersonName } from './person/model.js';
import { ensureDatasetTableData, loadDataset } from './render/data-loader.js';
import { bindPersonLinks, buildPersonDetailsView } from './render/renderers.js';
import { escapeHtml } from './utils/normalize.js';
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

function getDbLabel() {
  return getRemoteDataSourceLabel();
}
const personBody = document.getElementById('personBody');
const modeHint = document.getElementById('modeHint');
const graphLayoutMenu = document.getElementById('graphLayoutMenu');
const graphLayoutTrigger = document.getElementById('graphLayoutTrigger');
const graphLayoutList = document.getElementById('graphLayoutList');
const personSearchInput = document.getElementById('personSearchInput');
const personSearchSuggestions = document.getElementById('personSearchSuggestions');
const mainPersonOptions = document.getElementById('mainPersonOptions');
const rootPersonDialog = document.getElementById('rootPersonDialog');
const rootPersonInput = document.getElementById('rootPersonInput');
const rootPersonMessage = document.getElementById('rootPersonMessage');
const rootPersonApplyButton = document.getElementById('rootPersonApplyButton');
const newRelationPersonDialog = document.getElementById('newRelationPersonDialog');
const newRelationPersonSurnameInput = document.getElementById('newRelationPersonSurnameInput');
const newRelationPersonFirstNameInput = document.getElementById('newRelationPersonFirstNameInput');
const newRelationPersonPatronymicInput = document.getElementById('newRelationPersonPatronymicInput');
const newRelationPersonMessage = document.getElementById('newRelationPersonMessage');
const newRelationPersonCreateButton = document.getElementById('newRelationPersonCreateButton');

let dataset;
let schema;
let descriptions = {};
let personOptionEntries = [];
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

function resolvePersonLookupTarget(rawValue) {
  return inlineEditor.resolvePersonLookupTarget(rawValue);
}

function formatPersonLookupValue(personId) {
  return inlineEditor.formatPersonLookupValue(personId);
}

function getFilteredPersonOptions(rawValue, limit = 10) {
  return inlineEditor.getFilteredPersonOptions(rawValue, limit);
}

function isVirtualNode(personId) {
  return !personId || personId.startsWith('junction:') || personId.startsWith('unknown:');
}

const inlineEditor = createInlinePersonEditorController({
  elements: {
    personBody,
    personTitle,
    personSubtitle,
    newRelationPersonDialog,
    newRelationPersonSurnameInput,
    newRelationPersonFirstNameInput,
    newRelationPersonPatronymicInput,
    newRelationPersonMessage,
    newRelationPersonCreateButton,
  },
  getDataset: () => dataset,
  getSchema: () => schema,
  getDescriptions: () => descriptions,
  getSelectedPersonId: () => selectedPersonId,
  setSelectedPersonId: (personId) => {
    selectedPersonId = personId;
  },
  getDbLabel,
  buildPersonDetailsView,
  bindPersonLinks,
  isVirtualNode,
  onLinkedPersonSelected(linkedId) {
    const didShow = showPerson(linkedId);
    if (didShow && currentView === 'graph') {
      selectAndFocus(linkedId, 1.1);
    }
  },
  onLookupsChanged(entries) {
    personOptionEntries = entries;
    populatePersonLookupOptions();
  },
  onReloadDatasetAfterSave: reloadDatasetAfterSave,
  onDeletePersonRequested: deleteCurrentPerson,
});

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
  modeHint.title = 'Изменить человека, от которого строится дерево';
  modeHint.setAttribute('aria-label', `Изменить корень дерева. Сейчас: ${visualizationLabel} от ${name}`);
}

function refreshInlineEditorLookups() {
  inlineEditor.refreshLookups();
}

function renderPersonCard(personId, view = null) {
  inlineEditor.renderCard(personId, view);
}

function showPerson(personId, options = {}) {
  if (!personId || isVirtualNode(personId)) return false;

  if (!options.force && personId !== selectedPersonId && !inlineEditor.canDiscardChanges()) {
    return false;
  }

  const result = buildPersonDetailsView(personId, dataset);
  if (!result) return false;

  if (personId !== selectedPersonId || options.force) {
    inlineEditor.reset({
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

async function deleteCurrentPerson() {
  if (!selectedPersonId || inlineEditor.isBusy()) return;

  const personId = selectedPersonId;
  const personName = getDatasetPersonName(dataset, personId, personId);
  const confirmed = window.confirm(`Удалить карточку "${personName}" (${personId})? Это действие нельзя отменить.`);
  if (!confirmed) return;

  try {
    inlineEditor.reset();
    const result = await deleteEditablePerson(personId);
    dataset = await loadDataset();
    refreshInlineEditorLookups();
    renderGraphLayoutMenu();

    currentRootId = dataset.people.has(currentRootId)
      ? currentRootId
      : dataset.people.keys().next().value;
    selectedPersonId = null;

    if (dataset.people.size) {
      scheduleGraphRender();
      renderTable();
      showPerson(currentRootId, { force: true, keepStatus: true });
      let statusMessage = `Карточка ${personId} удалена из ${getDbLabel()}.`;
      const synchronizedIds = Array.isArray(result?.synchronizedIds) ? result.synchronizedIds : [];
      if (synchronizedIds.length) {
        statusMessage += ` Синхронизированы карточки: ${synchronizedIds.join(', ')}.`;
      }
      inlineEditor.setStatus(statusMessage, 'valid');
      showPerson(currentRootId, { force: true, keepStatus: true });
    } else {
      if (network) {
        network.destroy();
        network = null;
      }
      currentRootId = null;
      detailsContent.classList.add('hidden');
      detailsEmpty.classList.remove('hidden');
      personBody.innerHTML = '';
      hideLoading();
    }
  } catch (error) {
    console.error(error);
    inlineEditor.setStatus(`Не удалось удалить карточку: ${error.message}`, 'error');
    renderPersonCard(personId);
  }
}

async function reloadDatasetAfterSave(personId) {
  dataset = await loadDataset();
  refreshInlineEditorLookups();
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

  if (personSearchInput) personSearchInput.value = '';
  if (rootPersonInput) rootPersonInput.value = formatPersonLookupValue(currentRootId);
}

function populatePersonLookupOptions() {
  if (!mainPersonOptions) return;

  mainPersonOptions.innerHTML = personOptionEntries
    .map((entry) => `<option value="${escapeHtml(entry.label)}"></option>`)
    .join('');
}

function renderTable() {
  ensureDatasetTableData(dataset);
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
  if (!inlineEditor.canDiscardChanges()) {
    return false;
  }

  currentRootId = rootId;
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

function showRootPersonMessage(message = '', tone = 'neutral') {
  if (!rootPersonMessage) return;
  rootPersonMessage.textContent = message;
  rootPersonMessage.dataset.tone = tone;
}

function openRootPersonDialog() {
  if (!rootPersonDialog || !rootPersonInput) return;
  rootPersonInput.value = formatPersonLookupValue(currentRootId);
  showRootPersonMessage('');

  if (typeof rootPersonDialog.showModal === 'function') {
    rootPersonDialog.showModal();
  } else {
    rootPersonDialog.setAttribute('open', '');
  }

  requestAnimationFrame(() => {
    rootPersonInput?.focus();
    rootPersonInput?.select();
  });
}

function closeRootPersonDialog() {
  if (!rootPersonDialog?.open) return;

  if (typeof rootPersonDialog.close === 'function') {
    rootPersonDialog.close();
  } else {
    rootPersonDialog.removeAttribute('open');
  }
}

function setupRootPersonDialog() {
  modeHint?.addEventListener('click', openRootPersonDialog);

  const applyRootPerson = () => {
    const rawValue = String(rootPersonInput?.value || '').trim();
    const targetId = resolvePersonLookupTarget(rawValue);

    if (targetId === '') {
      showRootPersonMessage('Введите имя или ID карточки.', 'error');
      return;
    }
    if (!targetId) {
      showRootPersonMessage('Выберите существующую карточку из списка или введите ID в формате P123.', 'error');
      return;
    }

    if (setMainView(targetId)) {
      closeRootPersonDialog();
    }
  };

  rootPersonApplyButton?.addEventListener('click', applyRootPerson);
  rootPersonInput?.addEventListener('input', () => showRootPersonMessage(''));
  rootPersonInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    applyRootPerson();
  });
  rootPersonDialog?.addEventListener('click', (event) => {
    if (event.target === rootPersonDialog) {
      closeRootPersonDialog();
    }
  });
}

function closePersonSearchSuggestions() {
  if (!personSearchSuggestions) return;
  personSearchSuggestions.hidden = true;
  personSearchInput?.setAttribute('aria-expanded', 'false');
}

function renderPersonSearchSuggestions() {
  if (!personSearchInput || !personSearchSuggestions) return;

  const matches = getFilteredPersonOptions(personSearchInput.value);
  if (!matches.length) {
    personSearchSuggestions.innerHTML = '<div class="person-search-empty">Ничего не найдено</div>';
  } else {
    personSearchSuggestions.innerHTML = matches
      .map((entry) => `
        <button
          class="person-search-option"
          type="button"
          role="option"
          data-person-id="${escapeHtml(entry.id)}"
        >
          ${escapeHtml(entry.label)}
        </button>
      `)
      .join('');
  }

  personSearchSuggestions.hidden = false;
  personSearchInput.setAttribute('aria-expanded', 'true');
}

function setupPersonSearch() {
  const openSearchedPerson = (forcedPersonId = null) => {
    const rawValue = String(personSearchInput?.value || '').trim();
    if (!forcedPersonId && !rawValue) return;

    const targetId = forcedPersonId
      || resolvePersonLookupTarget(rawValue)
      || getFilteredPersonOptions(rawValue, 1)[0]?.id
      || null;

    if (!targetId) {
      personSearchInput?.setCustomValidity('Выберите существующую карточку из списка или введите ID в формате P123.');
      personSearchInput?.reportValidity();
      return;
    }

    personSearchInput?.setCustomValidity('');
    const didShow = showPerson(targetId);
    if (!didShow) return;

    if (currentView === 'graph' && isVisibleInGraph(targetId)) {
      selectAndFocus(targetId);
    }
    syncTableSelection();
    if (personSearchInput) personSearchInput.value = '';
    closePersonSearchSuggestions();
  };

  personSearchInput?.addEventListener('input', () => {
    personSearchInput.setCustomValidity('');
    renderPersonSearchSuggestions();
  });
  personSearchInput?.addEventListener('focus', renderPersonSearchSuggestions);
  personSearchInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    openSearchedPerson();
  });
  personSearchSuggestions?.addEventListener('click', (event) => {
    const option = event.target.closest('[data-person-id]');
    if (!option) return;
    openSearchedPerson(option.dataset.personId);
  });
  document.addEventListener('click', (event) => {
    if (personSearchInput?.contains(event.target) || personSearchSuggestions?.contains(event.target)) return;
    closePersonSearchSuggestions();
  });
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
    await requireAuth();
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

    inlineEditor.setupDismissHandlers();
    setupPersonSearch();
    setupRootPersonDialog();
    inlineEditor.setupNewRelationPersonDialog();
    setupTabs();
    renderGraphLayoutMenu();

    applyTabState(currentView);
    renderGraph();
    showPerson(currentRootId, { force: true });
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
      `Не удалось загрузить данные сайта. Проверьте удаленную БД или локальный приватный каталог данных.\n\n${error.message}`
    );
  }
}

init();
