import { loadDataset } from './render/data-loader.js';
import { buildGraph, createNetwork, GRAPH_VISUALIZATIONS, getGraphVisualizationLabel } from './visualization/graph.js';
import { renderPeopleTable, setPeopleTableSelection, TABLE_SORTS } from './visualization/table-view.js';
import { renderPersonDetails, bindPersonLinks } from './render/renderers.js';
import { getDatasetPersonName } from './render/person-name.js';

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
const toggleEditButton = document.getElementById('toggleEditButton');
const rootPersonSelect = document.getElementById('rootPersonSelect');
const buildTreeButton = document.getElementById('buildTreeButton');
const modeHint = document.getElementById('modeHint');
const graphLayoutMenu = document.getElementById('graphLayoutMenu');
const graphLayoutTrigger = document.getElementById('graphLayoutTrigger');
const graphLayoutList = document.getElementById('graphLayoutList');

let dataset;
let network;
let selectedPersonId = null;
let currentRootId = null;
let currentView = 'graph';
let currentGraphVisualization = 'tree';
let needsGraphRender = false;
let currentTableSort = TABLE_SORTS.ALPHABET_ASC;
let currentTableGroupByFamily = true;
let graphLayoutHintDismissed = false;

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

function updateEditButton(personId) {
  if (!toggleEditButton) return;

  const enabled = Boolean(personId && !isVirtualNode(personId));
  toggleEditButton.hidden = !enabled;
  toggleEditButton.disabled = !enabled;
  toggleEditButton.classList.remove('is-active');
  toggleEditButton.setAttribute('aria-pressed', 'false');
  toggleEditButton.title = 'Редактировать карточку';
}

function openEditorPage(personId) {
  if (!personId || isVirtualNode(personId)) return;

  const url = new URL('./edit.html', window.location.href);
  url.searchParams.set('id', personId);
  window.open(url.toString(), '_blank', 'noopener');
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

function showPerson(personId) {
  if (!personId || isVirtualNode(personId)) return;

  const result = renderPersonDetails(personId, dataset);
  if (!result) return;

  selectedPersonId = personId;
  detailsEmpty.classList.add('hidden');
  detailsContent.classList.remove('hidden');
  personTitle.textContent = result.title;
  personSubtitle.textContent = result.subtitle;
  personBody.innerHTML = result.html;
  updateEditButton(personId);

  bindPersonLinks(personBody, (linkedId) => {
    if (currentView === 'graph') {
      selectAndFocus(linkedId, 1.1);
    }
    showPerson(linkedId);
  });

  syncTableSelection();
}

function selectAndFocus(personId, scale = 1.05) {
  if (!isVisibleInGraph(personId)) return;

  network.selectNodes([personId]);
  network.focus(personId, { scale, animation: true });
  selectedPersonId = personId;
  syncTableSelection();
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

        showPerson(personId);
        syncTableSelection();
      },
    });

    hideLoading();
    requestAnimationFrame(() => {
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
  currentRootId = rootId;
  if (rootPersonSelect) rootPersonSelect.value = '';
  updateBuildTreeButtonState();
  scheduleGraphRender();
  showPerson(rootId);
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
    dataset = await loadDataset();
    currentRootId = dataset.people.has('P049')
      ? 'P049'
      : dataset.people.keys().next().value;

    populateRootSuggestions();
    setupRootSelector();
    setupTabs();
    renderGraphLayoutMenu();

    toggleEditButton?.addEventListener('click', (event) => {
      event.preventDefault();
      openEditorPage(selectedPersonId);
    });

    applyTabState(currentView);
    renderGraph();
    showPerson(currentRootId);
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
      `Не удалось собрать сайт из YAML. Проверьте data/people/index.json и файлы в data/people.\n\n${error.message}`
    );
  }
}

init();
