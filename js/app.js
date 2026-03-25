import { loadDataset } from './data-loader.js';
import { buildGraph, createNetwork } from './graph.js';
import { renderPersonDetails, bindPersonLinks } from './renderers.js';

const loadingState = document.getElementById('loadingState');
const graphContainer = document.getElementById('graph');
const detailsEmpty = document.getElementById('detailsEmpty');
const detailsContent = document.getElementById('detailsContent');
const personTitle = document.getElementById('personTitle');
const personSubtitle = document.getElementById('personSubtitle');
const personBody = document.getElementById('personBody');
const rootPersonInput = document.getElementById('rootPersonInput');
const rootPersonOptions = document.getElementById('rootPersonOptions');
const buildTreeButton = document.getElementById('buildTreeButton');
const fitButton = document.getElementById('fitButton');
const modeHint = document.getElementById('modeHint');
const inspectButton = document.getElementById('inspectButton');

let dataset;
let network;
let selectedPersonId = null;
let currentRootId = null;
let currentMode = 'main';
let currentFocusId = null;

function refreshNetworkLayout() {
  if (!network) return;

  network.redraw();
  network.fit({ animation: false });

  const targetId = currentMode === 'focused' ? currentFocusId : currentRootId;
  if (targetId && !isVirtualNode(targetId)) {
    network.selectNodes([targetId]);
  }

  updateInspectButton();
}

function isVirtualNode(personId) {
  return !personId || personId.startsWith('junction:') || personId.startsWith('unknown:');
}

function hideLoading() {
  loadingState.style.display = 'none';
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
    selectAndFocus(linkedId, 1.1);
    showPerson(linkedId);
  });

  updateInspectButton();
}

function showError(message) {
  loadingState.innerHTML = `<div class="error-box">${message}</div>`;
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
  updateInspectButton();
}

function populateRootSuggestions() {
  const options = Array.from(dataset.indexById.entries())
    .sort((a, b) => a[1].localeCompare(b[1], 'ru'))
    .map(([id, name]) => `<option value="${id}">${name}</option><option value="${name}">${id}</option>`)
    .join('');

  rootPersonOptions.innerHTML = options;
}

function updateModeHint() {
  if (currentMode === 'focused') {
    const name = dataset.indexById.get(currentFocusId) || currentFocusId;
    modeHint.textContent = `Фокус: ${name}`;
    return;
  }

  const name = dataset.indexById.get(currentRootId) || currentRootId;
  modeHint.textContent = `Основное дерево от ${name}`;
}

function renderGraph() {
  const graphData = buildGraph(dataset, {
    mode: currentMode,
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
        updateInspectButton();
        return;
      }

      showPerson(personId);
      selectedPersonId = personId;
      updateInspectButton();
    },
    onViewportChanged() {
      updateInspectButton();
    },
  });

  requestAnimationFrame(() => {
    network.fit({ animation: true });
    const targetId = currentMode === 'focused' ? currentFocusId : currentRootId;
    if (targetId && !isVirtualNode(targetId)) {
      selectedPersonId = targetId;
      network.selectNodes([targetId]);
      updateInspectButton();
    }
  });

  updateModeHint();
}

function setMainView(rootId) {
  currentRootId = rootId;
  currentMode = 'main';
  currentFocusId = null;
  rootPersonInput.value = rootId;
  renderGraph();
  showPerson(rootId);
}

function setFocusedView(personId) {
  if (isVirtualNode(personId)) return;
  currentMode = 'focused';
  currentFocusId = personId;
  renderGraph();
  showPerson(personId);
}

function toggleInspect() {
  const targetId = selectedPersonId || currentFocusId || currentRootId;
  if (!targetId || isVirtualNode(targetId)) return;

  if (currentMode === 'focused' && targetId === currentFocusId) {
    setMainView(currentRootId);
    return;
  }

  setFocusedView(targetId);
}

function updateInspectButton() {
  if (!network || !selectedPersonId || isVirtualNode(selectedPersonId)) {
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
  inspectButton.title = currentMode === 'focused' && selectedPersonId === currentFocusId
    ? 'Вернуться к основному дереву'
    : 'Показать связи этого человека';
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

async function init() {
  try {
    dataset = await loadDataset();
    currentRootId = dataset.indexById.has('P049') ? 'P049' : dataset.indexById.keys().next().value;

    populateRootSuggestions();
    setupRootSelector();

    inspectButton.addEventListener('click', (event) => {
      event.preventDefault();
      toggleInspect();
    });

    renderGraph();
    showPerson(currentRootId);
    hideLoading();
    
    window.addEventListener('resize', refreshNetworkLayout);

    window.addEventListener('orientationchange', () => {
      setTimeout(refreshNetworkLayout, 150);
    });

    setTimeout(refreshNetworkLayout, 150);
  } catch (error) {
    console.error(error);
    showError(
      `Не удалось собрать сайт из YAML. Проверьте пути к people_index.yaml и папке data/people.\n\n${error.message}`
    );
  }
}

init();
