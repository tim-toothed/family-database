import { loadDataset } from './data-loader.js';
import { buildGraph, createNetwork } from './graph.js';
import { renderPeopleTable, setPeopleTableSelection, TABLE_SORTS } from './people-table.js';
import { renderPersonDetails, bindPersonLinks } from './renderers.js';
import { getDatasetPersonName } from './person-name.js';

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
const rootPersonInput = document.getElementById('rootPersonInput');
const rootPersonOptions = document.getElementById('rootPersonOptions');
const buildTreeButton = document.getElementById('buildTreeButton');
const modeHint = document.getElementById('modeHint');
const inspectButton = document.getElementById('inspectButton');

let dataset;
let network;
let selectedPersonId = null;
let currentRootId = null;
let currentFocusId = null;
let currentView = 'graph';
let needsGraphRender = false;
let currentTableSort = TABLE_SORTS.ALPHABET_ASC;
let currentTableGroupByFamily = true;

function isVirtualNode(personId) {
  return !personId || personId.startsWith('junction:') || personId.startsWith('unknown:');
}

function hideLoading() {
  loadingState.style.display = 'none';
}

function showError(message) {
  loadingState.innerHTML = `<div class="error-box">${message}</div>`;
}

function syncTableSelection() {
  setPeopleTableSelection(peopleTable, selectedPersonId);
}

function refreshNetworkLayout() {
  if (!network || currentView !== 'graph') return;

  network.redraw();
  network.fit({ animation: false });

  const targetId = currentFocusId || currentRootId;
  if (targetId && !isVirtualNode(targetId)) {
    network.selectNodes([targetId]);
  }

  updateInspectButton();
}

function updateModeHint() {
  if (currentView !== 'graph') {
    modeHint.hidden = true;
    return;
  }

  modeHint.hidden = false;
  if (currentFocusId) {
    const name = getDatasetPersonName(dataset, currentFocusId, currentFocusId);
    modeHint.textContent = `Основное дерево + Inspect: ${name}`;
    return;
  }

  const name = getDatasetPersonName(dataset, currentRootId, currentRootId);
  modeHint.textContent = `Основное дерево от ${name}`;
}

function updateInspectButton() {
  if (currentView !== 'graph' || !network || !selectedPersonId || isVirtualNode(selectedPersonId)) {
    inspectButton.hidden = true;
    return;
  }

  const position = network.getPositions([selectedPersonId])[selectedPersonId];
  if (!position) {
    inspectButton.hidden = true;
    return;
  }

  const box = network.getBoundingBox(selectedPersonId);
  const topRight = network.canvasToDOM({ x: box.right, y: box.top });

  inspectButton.hidden = false;
  inspectButton.style.left = `${topRight.x - 24}px`;
  inspectButton.style.top = `${topRight.y + 8}px`;
  inspectButton.title = selectedPersonId === currentFocusId
    ? 'Вернуться к основному дереву'
    : 'Показать связи этого человека';
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

  bindPersonLinks(personBody, (linkedId) => {
    if (currentView === 'graph') {
      selectAndFocus(linkedId, 1.1);
    }
    showPerson(linkedId);
  });

  syncTableSelection();
  updateInspectButton();
}

function findPersonId(query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return null;

  const exactId = Array.from(dataset.indexById.keys()).find(
    (id) => id.toLowerCase() === normalized
  );
  if (exactId) return exactId;

  const exactName = Array.from(dataset.indexById.entries()).find(
    ([, name]) => name.toLowerCase() === normalized
  );

  return exactName?.[0] || null;
}

function selectAndFocus(personId, scale = 1.05) {
  if (!personId || !network || isVirtualNode(personId)) return;
  network.selectNodes([personId]);
  network.focus(personId, { scale, animation: true });
  selectedPersonId = personId;
  syncTableSelection();
  updateInspectButton();
}

function populateRootSuggestions() {
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

  rootPersonOptions.innerHTML = [...sortedValid, ...sortedInvalid]
    .map(([id, name]) => `<option value="${name}" label="${id}"></option>`)
    .join('');
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

  const graphData = buildGraph(dataset, {
    mode: 'main',
    rootId: currentRootId,
    focusNodeId: currentFocusId,
  });

  if (network) {
    network.destroy();
  }

  network = createNetwork(graphContainer, graphData, {
    onSelect(personId) {
      if (isVirtualNode(personId)) {
        selectedPersonId = null;
        syncTableSelection();
        updateInspectButton();
        return;
      }

      showPerson(personId);
      selectedPersonId = personId;
      syncTableSelection();
      updateInspectButton();
    },
    onViewportChanged() {
      updateInspectButton();
    },
  });

  requestAnimationFrame(() => {
    network.fit({ animation: true });
    const targetId = currentFocusId || currentRootId;
    if (targetId && !isVirtualNode(targetId)) {
      selectedPersonId = targetId;
      network.selectNodes([targetId]);
      syncTableSelection();
      updateInspectButton();
    }
  });

  needsGraphRender = false;
  updateModeHint();
}

function scheduleGraphRender() {
  if (currentView === 'graph') {
    renderGraph();
    return;
  }

  needsGraphRender = true;
}

function setMainView(rootId) {
  currentRootId = rootId;
  currentFocusId = null;
  rootPersonInput.value = getDatasetPersonName(dataset, rootId, rootId);
  scheduleGraphRender();
  showPerson(rootId);
}

function setInspectView(personId) {
  if (isVirtualNode(personId)) return;
  currentFocusId = personId;
  scheduleGraphRender();
  showPerson(personId);
}

function toggleInspect() {
  const targetId = selectedPersonId || currentFocusId || currentRootId;
  if (!targetId || isVirtualNode(targetId)) return;

  if (targetId === currentFocusId) {
    setMainView(currentRootId);
    return;
  }

  setInspectView(targetId);
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
    updateInspectButton();
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
    const personId = findPersonId(rootPersonInput.value);
    if (!personId) return;
    setMainView(personId);
  };

  buildTreeButton.addEventListener('click', buildTree);
  rootPersonInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') buildTree();
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
    dataset = await loadDataset();
    currentRootId = dataset.people.has('P049')
      ? 'P049'
      : dataset.people.keys().next().value;

    populateRootSuggestions();
    setupRootSelector();
    setupTabs();

    inspectButton.addEventListener('click', (event) => {
      event.preventDefault();
      toggleInspect();
    });

    applyTabState(currentView);
    renderGraph();
    showPerson(currentRootId);
    rootPersonInput.value = getDatasetPersonName(dataset, currentRootId, currentRootId);
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
