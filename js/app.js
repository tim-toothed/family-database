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
const searchInput = document.getElementById('searchInput');
const fitButton = document.getElementById('fitButton');

let dataset;
let network;

function showPerson(personId) {
  const result = renderPersonDetails(personId, dataset);
  if (!result) return;

  detailsEmpty.classList.add('hidden');
  detailsContent.classList.remove('hidden');
  personTitle.textContent = result.title;
  personSubtitle.textContent = result.subtitle;
  personBody.innerHTML = result.html;
  bindPersonLinks(personBody, (linkedId) => {
    showPerson(linkedId);
    network.selectNodes([linkedId]);
    network.focus(linkedId, { scale: 1.1, animation: true });
  });
}

function showError(message) {
  loadingState.innerHTML = `<div class="error-box">${message}</div>`;
}

function setupSearch() {
  searchInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;

    const query = searchInput.value.trim().toLowerCase();
    if (!query) return;

    const match = Array.from(dataset.indexById.entries()).find(([id, name]) => {
      return id.toLowerCase() === query || name.toLowerCase().includes(query);
    });

    if (match) {
      const [personId] = match;
      network.selectNodes([personId]);
      network.focus(personId, { scale: 1.15, animation: true });
      if (dataset.availableIds.has(personId)) {
        showPerson(personId);
      }
    }
  });
}

async function init() {
  try {
    dataset = await loadDataset();
    const graphData = buildGraph(dataset);
    network = createNetwork(graphContainer, graphData, (personId) => {
      if (dataset.availableIds.has(personId)) {
        showPerson(personId);
      }
    });

    network.once('stabilizationIterationsDone', () => {
      loadingState.style.display = 'none';
      network.fit({ animation: true });
    });

    fitButton.addEventListener('click', () => network.fit({ animation: true }));
    setupSearch();
  } catch (error) {
    console.error(error);
    showError(`Не удалось собрать сайт из YAML. Проверьте пути к people_index.yaml и папке data/people.\n\n${error.message}`);
  }
}

init();
